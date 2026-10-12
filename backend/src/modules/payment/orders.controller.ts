/**
 * 用户端订单控制器（契约 §3.9.3 ~ §3.9.7、§3.9.10 用户侧）
 *
 * ## 鉴权
 *
 * 全局 `JwtAuthGuard` 默认拒绝，本控制器**刻意不标 `@Public()`** —— 这七个接口
 * 在契约里都是 🔑。归属校验在 Service 层（每条查询都带 `userId` 强过滤）。
 *
 * ## 为什么 `POST` 要显式写 `@HttpCode`
 *
 * NestJS 对 `@Post` 的**默认状态码是 201**，而契约里 cancel/close/query 都要求 200。
 * 这一条已经在本项目里踩过坑（见 `admin-config.controller` 的同名注释），
 * 因此每个 POST 都显式声明。
 *
 * 唯一例外是退款申请：契约给了**两个**成功状态码 ——
 * 进入人工审核 201 / 规则内自动退款成功 200。这只能运行时决定，
 * 因此用 `@Res({ passthrough: true })` 动态设置（`passthrough` 保证
 * 统一响应包络的拦截器仍然生效）。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { CurrentUser, IdempotencyKey } from '../../common/decorators';
import {
  CancelOrderBodyDto,
  CloseOrderBodyDto,
  GetOrderParamDto,
  GetOrderQueryDto,
  ListOrdersQueryDto,
  QueryOrderBodyDto,
} from './order-query.dto';
import { OrderQueryService } from './order-query.service';
import type {
  CancelOrderResultView,
  CloseOrderResultView,
  QueryOrderResultView,
  UserOrderDetailView,
  UserOrderListView,
} from './order-query.service';
import { ApplyRefundBodyDto } from './refund.dto';
import { RefundService } from './refund.service';
import type { UserRefundApplyView } from './refund.service';

@ApiTags('订单')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrderQueryService,
    private readonly refunds: RefundService,
  ) {}

  // ==========================================================================
  // 列表
  // ==========================================================================

  @Get()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '订单列表',
    description: [
      '分页返回**当前用户**的订单（强归属过滤 `WHERE userId = currentUser.id`）。',
      '',
      '**金额口径**：全部为整数分（ADR-009）；`amount` 是应付额、`payAmount` 是实付额、',
      '`refundedAmount` 是已退额。',
      '',
      '**`summary` 统计的是「筛选条件下的全部订单」而非当前页** —— 否则翻页时金额合计会跳动。',
      '',
      '**`canRefund` / `canQuery` 由服务端判定**，前端只据此渲染按钮。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（items + summary）' })
  @ApiResponse({ status: 400, description: '枚举/白名单非法、pageSize > 100（均 `10001`）' })
  @ApiResponse({ status: 429, description: '60s 内超过 120 次（`10007`）' })
  async listOrders(
    @CurrentUser('userId') userId: string,
    @Query() query: ListOrdersQueryDto,
  ): Promise<UserOrderListView> {
    return this.orders.listOrders(userId, query);
  }

  // ==========================================================================
  // 详情
  // ==========================================================================

  @Get(':id')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '订单 UUID；`byNo=true` 时为订单号（形如 SM20260214A7K3M9Q1）' })
  @ApiOperation({
    summary: '订单详情',
    description: [
      '本接口是前端「支付成功页」的**轮询目标**（建议 1s 间隔、最多 10 次）。',
      '',
      '**不返回任何微信敏感配置**：只有 `wechatPayEnv` 标识当前环境。',
      '🚫 商户号、私钥、APIv3 密钥一律不出现在响应中。',
      '',
      '**`payment.payerOpenid` 恒为 `null`**：`payments` 表没有 openid 列，',
      '契约要求的是"脱敏后的支付者标识"，凭空用一个别的字段顶替会把对账排查引向错误方向。',
      '',
      '**IDOR 防护**：订单不属于当前用户时返回 `70003` 并记录安全探测日志。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  @ApiResponse({ status: 400, description: 'id 非合法 UUID / orderNo 格式非法（`10001`）' })
  @ApiResponse({ status: 403, description: '订单属于其他用户（`70003`）' })
  @ApiResponse({ status: 404, description: '订单不存在（`70002`）' })
  async getOrderDetail(
    @CurrentUser('userId') userId: string,
    @Param() params: GetOrderParamDto,
    @Query() query: GetOrderQueryDto,
  ): Promise<UserOrderDetailView> {
    return this.orders.getOrderDetail(userId, params.id, query.byNo === true, query.includeRefunds !== false);
  }

  // ==========================================================================
  // 主动查单（补偿）
  // ==========================================================================

  @Post(':id/query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '主动查单（支付回调丢失时的补偿）',
    description: [
      '主动调微信查单；若微信明确返回 `SUCCESS` 而本地仍是未支付状态，',
      '则**同事务补发权益**并把订单推进到 `FULFILLED`（幂等，绝不重复发放）。',
      '',
      '**绝不假设支付成功**：只有微信明确返回 `SUCCESS` 才发货。',
      '微信返回金额与本地订单不一致时返回 `70011`（风控事件）且**不发货**。',
      '',
      '**节流**：30s 内同订单重复查询直接返回上次结果（`force: true` 可跳过）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查单完成（`note` 说明本次结论）' })
  @ApiResponse({ status: 400, description: 'id 非合法 UUID（`10001`）' })
  @ApiResponse({ status: 403, description: '订单属于其他用户（`70003`）' })
  @ApiResponse({ status: 404, description: '订单不存在（`70002`）' })
  @ApiResponse({ status: 409, description: '微信金额与订单不一致（`70011`，风控）' })
  @ApiResponse({ status: 429, description: '10 分钟内查单超过 10 次（`10007`）' })
  @ApiResponse({ status: 502, description: '微信查单接口调用失败（`70007`）' })
  async queryOrder(
    @CurrentUser('userId') userId: string,
    @Param('id') orderId: string,
    @Body() dto: QueryOrderBodyDto,
  ): Promise<QueryOrderResultView> {
    return this.orders.queryOrder(userId, orderId, dto.force === true);
  }

  // ==========================================================================
  // 用户取消
  // ==========================================================================

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '用户取消订单',
    description: [
      '仅 `CREATED` / `PENDING_PAY` 可取消；`PAID` 之后只能走退款（`70004`）。',
      '',
      '**同时调微信关单**：否则用户仍可能完成支付，产生「已取消但已支付」的脏状态。',
      '微信关单失败**不阻断**本地取消（本地状态优先），失败的重试由发件箱承接。',
      '',
      '**幂等**：已取消时返回 200 与当前状态。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '取消成功（或已处于取消状态）' })
  @ApiResponse({ status: 400, description: 'reason 非枚举 / id 非合法 UUID（`10001`）' })
  @ApiResponse({ status: 403, description: '订单属于其他用户（`70003`）' })
  @ApiResponse({ status: 404, description: '订单不存在（`70002`）' })
  @ApiResponse({ status: 409, description: '`PAID` 之后不可取消，需走退款（`70004`）' })
  @ApiResponse({ status: 410, description: '订单已关闭（`70005`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 20 次（`10007`）' })
  async cancelOrder(
    @CurrentUser('userId') userId: string,
    @Param('id') orderId: string,
    @Body() dto: CancelOrderBodyDto,
  ): Promise<CancelOrderResultView> {
    return this.orders.cancelOrder(userId, orderId, dto.reason ?? 'CHANGED_MIND');
  }

  // ==========================================================================
  // 关单
  // ==========================================================================

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '关单',
    description: [
      '关闭未支付订单（`CREATED` / `PENDING_PAY` → `CLOSED`）。',
      '',
      '**与取消的区别在业务语义**：`CANCELLED` 计入「用户主动流失」，',
      '`CLOSED` 计入「超时未支付」。因此用户调用时 `closeReason` 会被**强制为**',
      '`USER_REQUEST` —— `TIMEOUT` 只允许超时关单任务使用，否则流失分析会失真。',
      '',
      '关单后可立即重新下单，不受任何惩罚限制。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '关单成功（或已是关闭状态）' })
  @ApiResponse({ status: 400, description: 'closeReason 非枚举 / id 非合法 UUID（`10001`）' })
  @ApiResponse({ status: 403, description: '订单属于其他用户（`70003`）' })
  @ApiResponse({ status: 404, description: '订单不存在（`70002`）' })
  @ApiResponse({ status: 409, description: '已支付/已退款订单不可关单（`70004`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 20 次（`10007`）' })
  async closeOrder(
    @CurrentUser('userId') userId: string,
    @Param('id') orderId: string,
    @Body() dto: CloseOrderBodyDto,
  ): Promise<CloseOrderResultView> {
    return this.orders.closeOrder(userId, orderId, dto.closeReason);
  }

  // ==========================================================================
  // 申请退款
  // ==========================================================================

  @Post(':id/refund')
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: '**必填**（8–64 位）。同一键重放返回首次退款记录，避免重复退款',
  })
  @ApiOperation({
    summary: '申请退款（用户侧）',
    description: [
      '**用户侧仅允许全额退款**（部分退款是管理员权限）。',
      '',
      '**退款策略**（契约 §3.9.10 规则 1）：',
      '  · 24 小时内 + 原因 `DUPLICATE_PURCHASE`/`ACCIDENTAL` + 权益未消费 → **规则内自动退款**（返回 200）',
      '  · 7 天内 + 权益未消费 → 进入人工审核（返回 201）',
      '  · 权益已消费 / 超过 7 天 → `70012`',
      '',
      '**状态码有两个**（契约明确）：进入审核为 `201`，规则内自动退款成功为 `200`。',
      '',
      '**先落库再调微信**：退款单先以 `PENDING` 落库并预留额度，再调微信退款 API。',
      '结果为「未知」（网络超时/5xx）时保持 `PENDING` 并交由对账任务查询真实结果 ——',
      '这是为了避免「钱退了但本地记录失败」。',
      '',
      '**幂等**：`refunds.idempotency_key` 唯一约束兜底，并发重放只会产生一笔退款。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '规则内自动退款已结算（`status: SUCCESS` / `FAILED`）' })
  @ApiResponse({ status: 201, description: '已受理，等待人工审核（`status: PENDING`）' })
  @ApiResponse({ status: 400, description: '缺少幂等键（`10009`）；reason 缺失/非法、金额超可退（`10001`/`70011`）' })
  @ApiResponse({ status: 403, description: '订单属于其他用户（`70003`）' })
  @ApiResponse({ status: 404, description: '订单不存在（`70002`）' })
  @ApiResponse({
    status: 409,
    description: '状态不支持 / 已全额退款 / 策略限制 / 存在处理中的退款（`70004`/`70012`/`70019`）',
  })
  @ApiResponse({ status: 429, description: '24 小时内申请超过 5 次（`10007`）' })
  @ApiResponse({ status: 503, description: '支付通道未配置（`70018`）' })
  async applyRefund(
    @CurrentUser('userId') userId: string,
    @Param('id') orderId: string,
    @Body() dto: ApplyRefundBodyDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserRefundApplyView> {
    // 契约同时给了 201 与 200 两个成功码，只能运行时决定：
    // 进入人工审核 → 201；规则内直通并已结算 → 200
    const result = await this.refunds.applyUserRefund({
      userId,
      orderId,
      dto,
      idempotencyKey: idempotencyKey ?? '',
    });

    response.status(result.status === 'PENDING' ? HttpStatus.CREATED : HttpStatus.OK);

    return result;
  }
}
