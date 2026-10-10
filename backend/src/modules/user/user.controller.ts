/**
 * 用户控制器
 *
 * 契约来源：docs/API_DESIGN.md §3.2
 * 分层约定（架构 §6.1 P2）：Controller 只做参数校验、调用 Service、返回 DTO。
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, IdempotencyKey } from '../../common/decorators';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { ExportRequestedView, ExportTaskView } from './data-export.service';
import { DataExportService } from './data-export.service';
import {
  BindPhoneDto,
  CancelDeletionDto,
  ExportTaskParamDto,
  GetMeQueryDto,
  RequestDeletionDto,
  RequestExportDto,
  SubmitConsentDto,
  UpdateAvatarDto,
  UpdateProfileDto,
} from './dto/user.dto';
import {
  UserService,
  type AvatarUpdatedView,
  type ConsentEntry,
  type ConsentsView,
  type DeletionRequestView,
  type DeletionStatusView,
  type MeView,
  type PhoneBoundView,
  type ProfileUpdatedView,
} from './user.service';

/** 注销冷静期说明：冷静期内唯一允许调用的受保护接口（契约 §3.2.9 注） */
@ApiTags('用户')
@ApiBearerAuth('user-token')
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly dataExportService: DataExportService,
  ) {}

  // ==========================================================================
  // 资料
  // ==========================================================================

  @Get('me')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '获取当前用户完整资料',
    description: [
      '返回「我的」页面所需的聚合资料。',
      '',
      '**按需加载**：通过 `include` 请求画像、会员、配额、统计、同意记录等扩展块；',
      '未指定的块**不会出现在响应中**（而非返回 null），前端需按可选字段处理。',
      '',
      '**隐私**：只返回脱敏手机号与年龄段，绝不返回 openid / session_key / 手机号明文。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: 'include 含白名单外值（`30015`）' })
  @ApiResponse({ status: 401, description: '未登录 / 令牌失效（`20000` / `20001`）' })
  @ApiResponse({ status: 404, description: '用户不存在（`30000`）' })
  async getMe(@CurrentUser('userId') userId: string, @Query() query: GetMeQueryDto): Promise<MeView> {
    return this.userService.getMe(userId, query.include ?? []);
  }

  @Patch('me')
  @Throttle({ global: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: '更新用户资料',
    description: [
      '修改昵称、性别、生日（PATCH 语义：只改传入字段）。',
      '',
      '**内容安全**：昵称保存前会调用微信 `msgSecCheck`，命中违规不入库、不覆盖旧值。',
      '**乐观锁**：传入 `expectedVersion` 则强校验，不传则最后写入者胜。',
      '**冷静期**：注销冷静期内禁止修改资料（`30012`）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 400, description: '参数不合法 / 昵称违规（`10001` / `30010` / `30011`）' })
  @ApiResponse({ status: 403, description: '注销冷静期内禁止修改（`30012`）' })
  @ApiResponse({ status: 409, description: '乐观锁版本冲突（`10011`）' })
  async updateProfile(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileUpdatedView> {
    return this.userService.updateProfile(userId, dto);
  }

  // ==========================================================================
  // 头像
  // ==========================================================================

  @Post('me/avatar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 20, ttl: 3_600_000 } })
  @ApiOperation({
    summary: '上传头像（登记已直传至 OSS 的对象）',
    description: [
      '本接口**不接收文件二进制**。真实流程：',
      '',
      '```',
      '① 小程序 chooseAvatar 取得临时文件',
      '② POST /storage/upload-ticket { scene: "AVATAR" } → 取得 STS 凭证与 objectKey',
      '③ 客户端直传 OSS（不经后端）',
      '④ POST /users/me/avatar { objectKey } → 服务端校验归属 + 内容 + 大小后登记',
      '```',
      '',
      '**归属强校验**：`objectKey` 必须是 `avatar/{当前用户}/` 下的对象，',
      '否则返回 `80009` —— 防止用户把他人上传的文件登记为自己的头像。',
      '',
      '**内容校验**：服务端读取对象真实文件头（魔数）确认是图片，与声明不符则',
      '**删除该对象**并返回 `80014`。此校验不依赖 OSS 回调，因此回调未到达时依然有效。',
      '',
      '**大小以服务端为准**：请求体中的 `size` 仅用于提前拒绝。',
      '',
      '**旧头像**：登记成功后安排 7 天后删除，给 CDN 缓存留出窗口。',
      '',
      '`isDefault: true` 时改用系统默认头像，不触碰 OSS。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '登记成功，返回 CDN 地址与缩略图地址' })
  @ApiResponse({
    status: 400,
    description: '缺少 objectKey/isDefault、内容非图片、大小越界（`10001` / `80014` / `80000`）',
  })
  @ApiResponse({ status: 403, description: '越权登记他人文件或冷静期内（`80009` / `30012`）' })
  @ApiResponse({ status: 404, description: '对象不存在（`80010`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 20 次（`10007`）' })
  @ApiResponse({ status: 503, description: 'OSS 未配置（`80003`）' })
  async updateAvatar(@CurrentUser('userId') userId: string, @Body() dto: UpdateAvatarDto): Promise<AvatarUpdatedView> {
    return this.userService.updateAvatar(userId, dto);
  }

  // ==========================================================================
  // 手机号
  // ==========================================================================

  @Post('me/phone')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({
    summary: '绑定或换绑手机号',
    description: [
      '接收小程序 `getPhoneNumber` 的返回结果并绑定到当前账号。',
      '',
      '**两条路径**：`code`（推荐，服务端调微信换取号码）或 `encryptedData` + `iv`（旧版，',
      '需用加密存储的 `session_key` 解密）。至少提供一个，同时提供时以 `code` 为准。',
      '',
      '**明文零落库**：号码加密存 `phoneEnc`、加盐摘要存 `phoneHash`；',
      '响应只返回脱敏值，任何人（含管理员）都无法查看明文。',
      '',
      '**换绑限制**：7 天内最多换绑 3 次；同一号码重复绑定幂等且不消耗额度。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '绑定成功（`isReplaced` 标识本次是否为换绑）' })
  @ApiResponse({
    status: 400,
    description: '缺少 code/encryptedData 或 iv、解密失败（`10001` / `30008`）',
  })
  @ApiResponse({ status: 401, description: '登录授权已失效，请重新授权（`20008`）' })
  @ApiResponse({ status: 403, description: '注销冷静期内禁止绑定（`30012`）' })
  @ApiResponse({ status: 409, description: '该手机号已绑定其他账号（`30018`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 5 次，或 7 天内换绑超过 3 次（`10007`）' })
  @ApiResponse({ status: 502, description: '微信接口调用失败（`20007`）' })
  async bindPhone(@CurrentUser('userId') userId: string, @Body() dto: BindPhoneDto): Promise<PhoneBoundView> {
    return this.userService.bindPhone(userId, dto);
  }

  // ==========================================================================
  // 数据导出（任务状态存 Redis，见 ADR-024）
  // ==========================================================================

  @Post('me/export')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { limit: 20, ttl: 60_000 } })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: '幂等键（8–64 位）；同一键重放返回首次的 202 响应体（含同一 taskId）',
  })
  @ApiOperation({
    summary: '申请数据导出（异步）',
    description: [
      '提交导出申请，返回 `202` 与 `taskId`，由 `export.data` 队列异步生成。',
      '',
      '**异步必选**：涉及多表聚合与文件上传，无法在请求内完成，**禁止同步实现**。',
      '',
      '**单任务约束**：同一用户同时只允许一个未完成任务。重复申请返回 `30009`，',
      '并在 `details` 中带上已有 `taskId`（前端可直接跳转进度页）。',
      '',
      '**限流说明**：本接口的「1 次/24h」由**业务规则**（单任务约束）承担而非 IP 限流，',
      '因为契约要求第二次申请返回可用的 `30009` + 已有 taskId，而不是 429。',
      '',
      '**有效期**：生成的源文件在 OSS 保留 7 天，签名下载 URL 24h 有效；',
      '过期后任务状态转为 `EXPIRED`，可重新申请。',
      '',
      '**不计入任何配额**，也不扣减 AI 次数。',
    ].join('\n'),
  })
  @ApiResponse({ status: 202, description: '申请已受理，返回 taskId 与轮询地址' })
  @ApiResponse({ status: 400, description: '缺少幂等键或 scope 非法（`10009` / `10001`）' })
  @ApiResponse({ status: 403, description: '注销冷静期内禁止导出（`30012`）' })
  @ApiResponse({
    status: 409,
    description: '已有未完成的导出任务（`30009`，`details[0].issue` 为已有 taskId）',
  })
  @ApiResponse({ status: 503, description: '队列不可用（`90004`，可直接重试）' })
  async requestExport(
    @CurrentUser('userId') userId: string,
    @Body() dto: RequestExportDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<ExportRequestedView> {
    // 缺少幂等键属前端缺陷：契约要求必带，否则重复点击会产生多个导出任务
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw BusinessException.badRequest(ErrorCode.IDEMPOTENCY_KEY_MISSING, '缺少 X-Idempotency-Key 请求头');
    }

    return this.dataExportService.requestExport(userId, dto, idempotencyKey);
  }

  @Get('me/export/:taskId')
  @Throttle({ global: { limit: 240, ttl: 60_000 } })
  @ApiOperation({
    summary: '查询导出任务状态',
    description: [
      '轮询导出进度；完成后返回 OSS 签名下载地址（24h 有效）。',
      '',
      '**归属校验**：「任务不存在」与「不属于当前用户」返回**同一错误码**（`80005`）——',
      '区分两者等于向攻击者确认该 taskId 是否存在。',
      '',
      '**限流 240 次/60s**：允许前端每秒轮询一次。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（含 status / progress / stage / files）' })
  @ApiResponse({ status: 400, description: 'taskId 非合法 UUID（`10001`）' })
  @ApiResponse({ status: 404, description: '任务不存在或不属于当前用户（`80005`）' })
  async getExportTask(
    @CurrentUser('userId') userId: string,
    @Param() params: ExportTaskParamDto,
  ): Promise<ExportTaskView> {
    return this.dataExportService.getTask(userId, params.taskId);
  }

  // ==========================================================================
  // 同意记录
  // ==========================================================================

  @Get('me/consents')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '查询同意记录',
    description: [
      '返回固定 5 类同意项（隐私政策 / 用户协议 / 年龄声明 / AI 内容提示 / 营销授权）的当前状态。',
      '',
      '`requiresReconsent` 为 true 时，前端必须在进入关键页面前弹出重新同意弹窗。',
      '同意记录**不可删除**（合规审计要求），只能追加新版本记录。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  async getConsents(@CurrentUser('userId') userId: string): Promise<ConsentsView> {
    return this.userService.listConsents(userId);
  }

  @Post('me/consents')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: '提交或撤回同意',
    description: [
      '提交某类协议的同意状态。',
      '',
      '**版本校验**：提交的 `policyVersion` 必须是服务端当前版本（由 `GET /system/config` 下发），',
      '否则返回 `30017`，提示用户重新阅读。',
      '**撤回例外**：`agreed = false` 时不校验版本 —— 用户有权随时撤回同意。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '提交成功' })
  @ApiResponse({ status: 409, description: '协议版本已更新（`30017`）' })
  async submitConsent(
    @CurrentUser('userId') userId: string,
    @Body() dto: SubmitConsentDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<ConsentEntry> {
    return this.userService.submitConsent(userId, dto, { ip, userAgent, channel: 'miniapp' });
  }

  // ==========================================================================
  // 账号注销
  // ==========================================================================

  @Get('me/deletion')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '查询注销状态',
    description: [
      '查询当前是否存在注销申请、冷静期剩余时间与是否可撤销。',
      '',
      '**冷静期内仍可访问**：本接口是冷静期内允许调用的受保护接口之一，',
      '以便用户自行撤销注销申请。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（无申请时字段为 null）' })
  async getDeletionStatus(@CurrentUser('userId') userId: string): Promise<DeletionStatusView> {
    return this.userService.getDeletionStatus(userId);
  }

  @Post('me/deletion')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { limit: 3, ttl: 86_400_000 } })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: '幂等键（8–64 位）；同一键重复提交返回同一申请，不会产生重复注销单',
  })
  @ApiOperation({
    summary: '提交账号注销申请',
    description: [
      '提交注销申请并进入 7 天冷静期；到期由定时任务执行匿名化。',
      '',
      '**三重二次确认**：`confirmText` 必须精确等于「确认注销」，且两项 `acknowledge*` 必须为 true。',
      '**前置校验**：存在进行中的退款 → 拒绝（`70019`）；存在待支付订单 → 静默关单后继续。',
      '**幂等**：重复提交返回既有申请，不产生第二条记录。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '申请已受理，返回删除/保留数据清单与冷静期信息' })
  @ApiResponse({ status: 400, description: '确认信息不完整 / 缺少幂等键（`10001` / `10009`）' })
  @ApiResponse({ status: 409, description: '存在处理中退款（`70019`）或账号已注销（`30014`）' })
  async requestDeletion(
    @CurrentUser('userId') userId: string,
    @Body() dto: RequestDeletionDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Ip() ip: string,
  ): Promise<DeletionRequestView> {
    return this.userService.requestDeletion(userId, dto, { idempotencyKey, ip });
  }

  @Delete('me/deletion')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 5, ttl: 86_400_000 } })
  @ApiOperation({
    summary: '撤销注销申请',
    description: '在 7 天冷静期内撤销注销申请，账号恢复正常使用。',
  })
  @ApiResponse({ status: 200, description: '撤销成功' })
  @ApiResponse({ status: 409, description: '无待撤销申请（`30006`）或冷静期已结束（`30013`）' })
  async cancelDeletion(
    @CurrentUser('userId') userId: string,
    @Body() dto: CancelDeletionDto,
  ): Promise<DeletionStatusView> {
    return this.userService.cancelDeletion(userId, dto);
  }
}
