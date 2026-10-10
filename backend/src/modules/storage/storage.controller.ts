/**
 * 存储控制器
 *
 * 契约来源：docs/API_DESIGN.md §3.10
 * 分层约定（架构 §6.1 P2）：Controller 只做参数校验、调用 Service、返回 DTO。
 *
 * `POST /storage/callback` 是本控制器中唯一的**公开**路由（OSS 服务器调用），
 * 其安全边界完全由 Service 内的验签 + 魔数校验承担，详见 §3.10.3。
 */

import { Body, Controller, Headers, HttpCode, HttpStatus, Post, type RawBodyRequest, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUser, Public, RawResponse } from '../../common/decorators';
import { SIGN_URL_MAX_BATCH, SignUrlDto, StorageCallbackDto, UploadTicketDto } from './dto/storage.dto';
import { StorageService } from './storage.service';
import type { SignedUrlsView, StorageCallbackResult, UploadTicket } from './storage.types';

/**
 * 还原 OSS 侧计算签名时使用的回调 URL
 *
 * 签名覆盖「完整 URL（含 query）\n 原始请求体」，其中 URL 必须是 OSS 实际请求的那个。
 * 服务部署在 Nginx 之后，故用 `req.protocol`（已开启 trust proxy，会读
 * `X-Forwarded-Proto`）拼接，而不是写死 http/https。
 */
const buildCallbackUrl = (request: Request): string =>
  `${request.protocol}://${request.get('host') ?? ''}${request.originalUrl}`;

@ApiTags('存储')
@ApiBearerAuth('user-token')
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('upload-ticket')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { limit: 30, ttl: 3_600_000 } })
  @ApiOperation({
    summary: '申请 OSS 直传凭证（STS）',
    description: [
      '签发阿里云 STS 临时凭证与规范化 `objectKey`，供小程序 / Admin **直传 OSS**。',
      '',
      '**后端不中转文件流**：凭证仅允许 `PutObject` 到本次返回的单个 `objectKey`，',
      '有效期 900 秒，不含读取与删除权限。',
      '',
      '**对象名由服务端生成**：`{scene 前缀}/{userId}/{yyyyMMdd}_{uuid}.{ext}`，',
      '扩展名由 `mimeType` 推导而非取自用户文件名 —— 杜绝「声明图片、实传 HTML」。',
      '',
      '上传完成后需调用对应业务接口（如 `POST /users/me/avatar`）登记，否则文件不生效。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '签发成功' })
  @ApiResponse({ status: 400, description: '场景未开放 / 类型不允许 / 超大小上限（`80007` / `80001` / `80000`）' })
  @ApiResponse({ status: 401, description: '未登录 / 令牌失效（`20000` / `20001`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 30 次（`10007`）' })
  @ApiResponse({ status: 502, description: 'STS 凭证签发失败（`80012`）' })
  @ApiResponse({ status: 500, description: 'OSS 未配置（`80003`）' })
  async uploadTicket(@CurrentUser('userId') userId: string, @Body() dto: UploadTicketDto): Promise<UploadTicket> {
    return this.storageService.issueUploadTicket(userId, dto);
  }

  @Post('sign-url')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '生成签名访问 URL',
    description: [
      `为私有 Bucket 中的对象生成临时签名 URL，支持批量（最多 ${SIGN_URL_MAX_BATCH} 个）。`,
      '',
      '**归属强校验**：只能为**本人目录**下的对象签名，`objectKey` 前缀必须是 `{scene}/{userId}/`；',
      '整批中任一项越权即**整批拒绝**（`80009`），避免借签名接口读取他人文件。',
      '',
      '**有效期上限 1 小时**（默认 900 秒）。对象不存在时该项 `signedUrl` 为 `null` 且仍返回 200，',
      '便于前端统一处理「尚在上传中」的状态。',
      '',
      '**公开静态资源例外**：`public/` 前缀无需签名，直接返回 CDN 地址。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '签名成功（含逐项 `exists`）' })
  @ApiResponse({ status: 400, description: '参数非法 / 有效期越界 / 对象键格式错误（`10001` / `80008`）' })
  @ApiResponse({ status: 403, description: '对象不属于当前用户（`80009`）' })
  @ApiResponse({ status: 429, description: '60 秒内超过 120 次（`10007`）' })
  @ApiResponse({ status: 502, description: '签名生成失败（`80011`）' })
  async signUrl(@CurrentUser('userId') userId: string, @Body() dto: SignUrlDto): Promise<SignedUrlsView> {
    return this.storageService.createSignedUrls(userId, dto);
  }

  @Post('callback')
  @Public()
  @RawResponse()
  // ⚠ 必须显式写出限流器名字。`@SkipThrottle()` 无参时写入的是 `THROTTLER:SKIPdefault`，
  // 而 ThrottlerGuard 读取的是 `THROTTLER:SKIP${throttler.name}` —— 本项目唯一的限流器
  // 在 `ThrottlerModule.forRootAsync` 里被命名为 `global`，因此无参写法**匹配不上任何
  // 限流器，限流根本没被跳过**。OSS 出口 IP 高度集中，套用全局 IP 限流会在正常上传
  // 高峰误伤回调，导致上传登记丢失（用户上传成功但服务端不知道）。
  @SkipThrottle({ global: true })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'OSS 上传回调（由 OSS 服务器调用）',
    description: [
      '接收 OSS 上传成功回调：**验签 → 魔数校验 → 登记文件元数据 → 投递内容安全检测**。',
      '',
      '**必须验签**：公钥来源限定为阿里云官方分发点或**本桶自己的域名** ——',
      '既防 SSRF，也防「攻击者用自己的 OSS 账号托管公钥、用自己的私钥签名」绕过验签。',
      '',
      '**魔数校验**：读取对象真实文件头与声明类型比对，不符则**删除对象**并拒绝回调。',
      '',
      '**响应体不是统一包络**：OSS 回调模板要求 `{ Status: "OK", ... }`，故用 `@RawResponse()` 放行。',
      '',
      '**限流例外**：OSS 出口 IP 可能集中，套用全局 IP 限流会误伤正常上传；',
      '安全边界为验签 + 魔数校验 + 场景约束。',
    ].join('\n'),
  })
  @ApiHeader({
    name: 'x-oss-pub-key-url',
    required: true,
    description: 'Base64 编码的 OSS 公钥地址（用于验签）',
  })
  @ApiHeader({ name: 'Authorization', required: true, description: 'OSS 回调签名' })
  @ApiResponse({ status: 200, description: '登记成功，返回 `{ Status: "OK", ... }`（非统一包络）' })
  @ApiResponse({ status: 400, description: '对象键非法 / 类型不符 / 魔数不符（`80008` / `80001` / `80014`）' })
  @ApiResponse({ status: 401, description: '回调验签失败（`80013`）' })
  @ApiResponse({ status: 404, description: '对象不存在（`80010`）' })
  @ApiResponse({ status: 413, description: '文件超出场景上限（`80000`）' })
  @ApiResponse({ status: 503, description: 'OSS 未配置（`80003`）' })
  async ossCallback(
    @Req() request: RawBodyRequest<Request>,
    @Body() dto: StorageCallbackDto,
    @Headers('x-oss-pub-key-url') publicKeyUrl?: string,
    @Headers('authorization') authorization?: string,
  ): Promise<StorageCallbackResult> {
    // 用**原始字节**验签：JSON.parse 后再序列化会因键序/空白差异导致签名不匹配
    const rawBody = request.rawBody?.toString('utf8') ?? '';

    return this.storageService.handleCallback(
      { publicKeyUrl, authorization, requestUrl: buildCallbackUrl(request) },
      rawBody,
      dto,
    );
  }
}
