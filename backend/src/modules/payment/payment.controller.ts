/**
 * 支付控制器（契约 §3.7）
 *
 * 回调端点用三个装饰器，每个都有明确理由：
 *   · `@Public()`     —— 微信服务器没有登录态
 *   · `@RawResponse()` —— 微信要求响应体是 `{code, message}` 形态，
 *                        而我们的统一包络是 `{code, message, data, requestId, timestamp}`；
 *                        多出的字段不影响微信判定，但保持契约干净更易排查
 *   · `@SkipThrottle({ global: true })` —— 微信出口 IP 高度集中，
 *                        套用按 IP 的限流会在支付高峰误伤回调
 *
 * **安全边界全在 `PaymentService`**：验签 → 校时间 → 解密 → 校商户号/金额。
 * 因此这个端点即使被公网任意调用也不会有副作用。
 */

import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

import { CurrentUser, IdempotencyKey, Public, RawResponse } from '../../common/decorators';
import { CreateOrderDto } from './payment.dto';
import type { RequestWithContext } from '../../common/types/request.type';
import { PaymentService, type OrderCreatedView } from './payment.service';

/** 微信支付回调的响应体（微信只关心 `code` 是否为 `SUCCESS`） */
interface WechatPayCallbackResponse {
  readonly code: 'SUCCESS' | 'FAIL';
  readonly message: string;
}

/** 从请求头取回调头的辅助（Node 会把头名转成小写） */
const headerOf = (request: RequestWithContext, name: string): string | undefined => {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value === undefined || value.trim() === '' ? undefined : value;
};

@ApiTags('支付')
@Controller('payment')
export class PaymentController {
  constructor(private readonly payment: PaymentService) {}

  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: '创建订单并获取支付参数',
    description: [
      '**金额一律从商品表读取，不接受客户端传值** —— 前端常把「元」当「分」传，',
      '而这类错误在小额测试订单上完全看不出来，上线后就是少收 100 倍。',
      '',
      '返回的 `payment` 可直接交给 `wx.requestPayment`。若为 `null`，说明**预支付失败**',
      '（订单已创建，可稍后重试拉起支付）—— 微信侧抖动不该让用户「什么都没发生」。',
      '',
      '订单 30 分钟未支付将关单。',
      '',
      '**幂等（契约 §2.9.2）**：必须携带 `X-Idempotency-Key`（8–64 位字母/数字/`_`/`-`），',
      '缺失返回 `10009`、格式非法返回 `10001`。同一用户 + 同一幂等键在 **30 分钟内**重放，',
      '会原样返回首次的下单响应（同一 `orderNo`、同一份支付参数），**不会产生第二张订单**；',
      '订单过期后重放则建新单 —— 否则用户会永远卡在一张付不了款的过期订单上。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '订单已创建，返回订单号、金额与支付参数' })
  @ApiResponse({ status: 400, description: '参数不合法（`10001`）；缺少幂等键（`10009`）' })
  @ApiResponse({ status: 404, description: '商品不存在（`70000`）' })
  @ApiResponse({ status: 409, description: '商品已下架（`70001`）' })
  async createOrder(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateOrderDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() request: RequestWithContext,
  ): Promise<OrderCreatedView> {
    return this.payment.createOrder({
      userId,
      productId: dto.productId,
      idempotencyKey,
      ...(dto.reportId !== undefined ? { reportId: dto.reportId } : {}),
      ...(dto.relationshipId !== undefined ? { relationshipId: dto.relationshipId } : {}),
      ...(request.ip !== undefined ? { clientIp: request.ip } : {}),
    });
  }
  @Post('notify/wechat')
  @Public()
  @RawResponse()
  @SkipThrottle({ global: true })
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: '微信支付结果回调（由微信服务器调用）',
    description: [
      '**必须先验签再解密**：顺序反过来，攻击者可以用自己生成的密钥构造"已支付"的密文体，',
      '服务端解密成功并发放权益。',
      '',
      '**重复通知返回成功**：微信对同一笔支付可能多次投递（网络重试、我们超时），',
      '重复时识别为"已处理"并回 `SUCCESS`，否则微信会持续重投。',
      '',
      '**校验失败的确定性拒绝也回成功**（订单不存在、金额不符）：重投一万次结果相同，',
      '只会浪费资源，真正需要的是人工介入。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '`{code: "SUCCESS"}` 表示已接收；`FAIL` 时微信会重投' })
  async wechatNotify(@Req() request: RequestWithContext): Promise<WechatPayCallbackResponse> {
    // ⚠ 必须用**原始请求体字符串**验签，不能用 `JSON.stringify(body)`：
    // 重新序列化会改变空白与键顺序，签名字节不一致 → 永远验签失败。
    // 因此 main.ts 开启了 `rawBody: true`（见 `NestFactory.create`）
    const rawBody = (request as RequestWithContext & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';

    const result = await this.payment.handleWechatCallback(rawBody, {
      timestamp: headerOf(request, 'wechatpay-timestamp'),
      nonce: headerOf(request, 'wechatpay-nonce'),
      signature: headerOf(request, 'wechatpay-signature'),
      serial: headerOf(request, 'wechatpay-serial'),
    });

    return result.acknowledged ? { code: 'SUCCESS', message: '成功' } : { code: 'FAIL', message: '处理失败，请重试' };
  }
}
