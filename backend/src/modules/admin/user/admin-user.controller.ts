/**
 * 管理端用户控制器
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.2（4 个接口：列表 / 详情 / 封禁 / 解封）
 *
 * ## 守卫组合（管理端控制器的固定写法）
 *
 * `@Public()` 跳过的是**用户端**全局守卫（`app.module.ts` 注册的 `JwtAuthGuard`），
 * 否则管理员令牌（`realm = 'admin'`）会被判为 realm 不匹配（`20013`）。
 * 管理端认证与 RBAC 由 `@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)` 承接：
 *   · `AdminAuthGuard` → 管理员令牌校验（只认 `@AdminPublic()`，本类**没有**该标记，因此必须登录）
 *   · `RolesGuard`      → 逐方法的 `@RequirePermission(...)` 权限点校验
 *   · `ConfirmPasswordGuard` → 只在标了 `@SensitiveOperation()` 的方法上要求 `X-Confirm-Password`
 *
 * ## 错误码口径
 *
 * 契约 §3.14.2 的几个错误码在本项目的 `common/errors/error-code.ts` 里已被占用且含义不同
 * （`10003` / `30001` / `10010`），无法新增码也不能改共享文件，
 * 因此实际返回的是语义正确的既有码，具体对应关系写在各方法的 `@ApiResponse` 描述与
 * `admin-user.service.ts` 文件头说明 4 中 —— 前端按码分支时以此为准。
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../../common/decorators';
import type { RequestWithContext } from '../../../common/types/request.type';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { SensitiveOperation } from '../decorators/sensitive-operation.decorator';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import {
  AdminUserService,
  type AdminOperatorContext,
  type AdminUserDetailView,
  type AdminUserListView,
  type BanUserView,
  type UnbanUserView,
} from './admin-user.service';
import { AdminUserDetailQueryDto, AdminUserListQueryDto, BanUserDto, UnbanUserDto } from './dto/admin-user.dto';

@ApiTags('后台管理 - 用户')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/users')
export class AdminUserController {
  constructor(private readonly userService: AdminUserService) {}

  // ==========================================================================
  // GET /admin/users
  // ==========================================================================

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.USER_READ)
  // 契约 §3.14.2.1：adminId 300 次/60s。
  // ⚠ 全局 ThrottlerGuard 以 IP 为跟踪维度，做不到「按 adminId 计数」；
  //   要精确到 adminId 需自定义 ThrottlerGuard tracker（跨模块改造，不在本任务范围）。
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '用户列表',
    description: [
      '分页查询用户（支持多维筛选），用于客服与运营排查。',
      '',
      '**手机号只允许哈希精确查询**：`keyword` 若为手机号形态，服务端计算',
      '`SHA-256(phone + CRYPTO_IV_SALT)` 后精确匹配 `users.phone_hash`；',
      '🚫 绝不支持手机号模糊搜索（防批量拖库）。`keyword` 同时支持昵称模糊与用户 ID 精确。',
      '',
      '**openid 只返回哈希**：响应里的 `openidHash` 是 `sha256(openid)`，原始 openid 不出库。',
      '',
      '**强审计**：每次列表查询都会写 `admin_audit_logs`（含查询条件），',
      '防止内部人员无痕翻查用户数据。',
      '',
      '**`lastActiveAt`**：数据模型无该列，取最近一次登录时间（`last_login_at`）作为活跃近似值。',
      '**`riskFlags`**：风控任务尚未接入，恒为空数组（不伪造数据）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（含全局统计 `summary`）' })
  @ApiResponse({
    status: 400,
    description:
      '`status` 含非法枚举或 `mbtiType` 非 16 型（`10001`）；`sortBy` 不在白名单（`10004`）；`pageSize > 100`（`10005`）',
  })
  @ApiResponse({ status: 401, description: '未携带管理员令牌（`20000`）或令牌失效（`20001` / `20002`）' })
  @ApiResponse({ status: 403, description: '缺少 `user:user:read` 权限点（`20009`）' })
  @ApiResponse({ status: 429, description: '超出限流（本项目限流错误码为 `10007`）' })
  async list(
    @Query() query: AdminUserListQueryDto,
    @CurrentUser('userId') adminUserId: string,
    @CurrentUser('jti') jti: string,
    @Ip() ip: string,
    @Req() request: RequestWithContext,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminUserListView> {
    return this.userService.listUsers(query, this.operatorContext(adminUserId, jti, ip, request, userAgent));
  }

  // ==========================================================================
  // GET /admin/users/{id}
  // ==========================================================================

  @Get(':id')
  @RequirePermission(ADMIN_PERMISSIONS.USER_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '用户 ID（UUID）', example: '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70' })
  @ApiOperation({
    summary: '用户详情（360 视图）',
    description: [
      '返回资料、画像、订单、会员、关系、AI 用量、同意记录、注销申请与后台操作轨迹。',
      '',
      '**按需加载**：`include` 白名单 `orders,membership,reports,relationships,aiUsage,consents,deletion,audit,testSessions`，',
      '默认 `orders,membership,consents`；未请求的块**不会出现在响应中**（而非返回 null）。',
      '`user`、`profile`、`serverTime` 恒定返回。',
      '',
      '**AI 对话原文不可见**：`aiUsage` 只给计量数字（消息数 / Token / 成本 / 安全拦截数），',
      '🚫 不提供任何查看用户对话原文的能力（隐私底线）。',
      '',
      '**手机号脱敏**：只返回 `phoneMasked`，任何人（含超级管理员）都看不到明文。',
      '',
      '**审计**：查看详情属于敏感数据访问，会记录操作人与查询范围。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  @ApiResponse({
    status: 400,
    description:
      '`include` 含白名单外值（`10001`）；`id` 非合法 UUID（契约写 `10003`，本项目 `10003` 已被冲突类错误占用，实际返回 `10001`）',
  })
  @ApiResponse({ status: 401, description: '未携带管理员令牌（`20000`）或令牌失效（`20001` / `20002`）' })
  @ApiResponse({ status: 403, description: '缺少 `user:user:read`（`20009`）' })
  @ApiResponse({
    status: 404,
    description: '用户不存在或已完全匿名化（契约写 `30001`，本项目 `30001` 是「资料未完善」，实际返回 `30000`）',
  })
  async detail(
    @Param('id') id: string,
    @Query() query: AdminUserDetailQueryDto,
    @CurrentUser('userId') adminUserId: string,
    @CurrentUser('jti') jti: string,
    @Ip() ip: string,
    @Req() request: RequestWithContext,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminUserDetailView> {
    return this.userService.getUserDetail(
      id,
      query.include,
      this.operatorContext(adminUserId, jti, ip, request, userAgent),
    );
  }

  // ==========================================================================
  // POST /admin/users/{id}/ban
  // ==========================================================================

  @Post(':id/ban')
  /**
   * 契约 §3.14.2.3 要求成功响应为 **200**；NestJS 的 `@Post()` 默认返回 201，
   * 必须显式覆盖，否则前端按 200 判断的分支会走到非预期状态（本项目已实际踩过）。
   */
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.USER_WRITE)
  @SensitiveOperation()
  @Throttle({ global: { limit: 20, ttl: 3_600_000 } })
  @ApiParam({ name: 'id', description: '用户 ID（UUID）', example: '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70' })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人密码（Argon2id 校验）；缺失 `20017`，错误 `20018`',
  })
  @ApiOperation({
    summary: '封禁用户（敏感操作）',
    description: [
      '封禁用户（禁止登录与使用服务），支持临时封禁（`durationDays`）与永久封禁（不传 `durationDays`）。',
      '',
      '**二次确认强制**：必须带 `X-Confirm-Password`（操作者本人密码），缺失 `20017`、错误 `20018`。',
      '',
      '**会话立即撤销**：`revokeSessions = true`（默认）时撤销全部 RefreshToken，',
      '并把活跃 AccessToken 的 `jti` 加入黑名单（AT 与 RT 共用同一 `jti`）。',
      '',
      '**权益不没收**：封禁期间无法使用服务，但已购权益与订单保留，封禁期满自动恢复；',
      '永久封禁不退费（遵循商品条款）。',
      '',
      '**幂等**：已封禁再封禁返回当前封禁状态，不报错、不重复撤销会话与通知。',
      '',
      '**审计必写**：`before { status } / after { status: BANNED, reason, expiresAt, ... }`。',
      '',
      '⚠ 契约错误码 `10010`（限流）在本项目已被 `IDEMPOTENCY_CONFLICT` 占用，',
      '限流实际返回 `10007`；`30012`（注销冷静期）按契约说明**不阻断封禁**，',
      '因此不会出现在响应中（`PENDING_DELETION` 与 `BANNED` 可共存）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '封禁成功（含封禁类型、到期时间、撤销会话数与审计 ID）' })
  @ApiResponse({
    status: 400,
    description:
      '`reason` 非枚举 / `reasonDetail` 超长 / `durationDays` 越界（`10001`）；缺 `reason` 或 `reason = OTHER` 缺 `reasonDetail`（`10002`）；`id` 非合法 UUID（契约 `10003` → 实际 `10001`）',
  })
  @ApiResponse({
    status: 401,
    description: '未携带管理员令牌（`20000`）；缺二次确认密码（`20017`）；二次确认密码错误（`20018`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `user:user:write`（`20009`）' })
  @ApiResponse({ status: 404, description: '用户不存在（契约 `30001` → 实际 `30000`）' })
  @ApiResponse({ status: 409, description: '用户已注销完成（`30014`，契约未覆盖该分支的封禁场景）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 20 次（本项目限流错误码为 `10007`）' })
  async ban(
    @Param('id') id: string,
    @Body() dto: BanUserDto,
    @CurrentUser('userId') adminUserId: string,
    @CurrentUser('jti') jti: string,
    @Ip() ip: string,
    @Req() request: RequestWithContext,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BanUserView> {
    return this.userService.banUser(id, dto, this.operatorContext(adminUserId, jti, ip, request, userAgent));
  }

  // ==========================================================================
  // POST /admin/users/{id}/unban
  // ==========================================================================

  @Post(':id/unban')
  /** 契约 §3.14.2.4 要求 200（同上，必须显式覆盖 NestJS 默认的 201） */
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.USER_WRITE)
  @SensitiveOperation()
  @Throttle({ global: { limit: 20, ttl: 3_600_000 } })
  @ApiParam({ name: 'id', description: '用户 ID（UUID）', example: '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70' })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人密码（Argon2id 校验）；缺失 `20017`，错误 `20018`',
  })
  @ApiOperation({
    summary: '解封用户（敏感操作）',
    description: [
      '解除封禁，恢复 `ACTIVE` 状态。',
      '',
      '**二次确认强制**：必须带 `X-Confirm-Password`（操作者本人密码）。',
      '',
      '**不恢复会话**：解封后用户需重新登录（被撤销的会话与黑名单不会回滚）。',
      '',
      '**可选补偿**：`restoreCompensation = true` 时发放 7 天会员延期（优先）；',
      '账号当前无生效会员时改发等值 AI 次数权益；补偿属于资金相关操作，会单独写审计。',
      '',
      '**幂等**：用户当前未被封禁时返回当前状态，不报错、不发通知、不发补偿。',
      '',
      '**审计**：记录 `previousBan`（原因 / 封禁时刻 / 到期时间 / 实际时长），便于申诉复盘。',
      '',
      '⚠ 契约错误码 `10010`（限流）在本项目已被 `IDEMPOTENCY_CONFLICT` 占用，限流实际返回 `10007`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '解封成功（含上一次封禁信息与补偿结果）' })
  @ApiResponse({
    status: 400,
    description: '`reason` 缺失（`10002`）或超长（`10001`）；`id` 非合法 UUID（契约 `10003` → 实际 `10001`）',
  })
  @ApiResponse({
    status: 401,
    description: '未携带管理员令牌（`20000`）；缺二次确认密码（`20017`）；二次确认密码错误（`20018`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `user:user:write`（`20009`）' })
  @ApiResponse({ status: 404, description: '用户不存在（契约 `30001` → 实际 `30000`）' })
  @ApiResponse({ status: 409, description: '用户已注销（`DELETED`），无法解封（`30014`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 20 次（本项目限流错误码为 `10007`）' })
  async unban(
    @Param('id') id: string,
    @Body() dto: UnbanUserDto,
    @CurrentUser('userId') adminUserId: string,
    @CurrentUser('jti') jti: string,
    @Ip() ip: string,
    @Req() request: RequestWithContext,
    @Headers('user-agent') userAgent?: string,
  ): Promise<UnbanUserView> {
    return this.userService.unbanUser(id, dto, this.operatorContext(adminUserId, jti, ip, request, userAgent));
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /**
   * 组装审计上下文
   *
   * `jti` 也一并带上：审计里记录会话标识，才能在同一管理员多设备登录时
   * 定位到「是哪一次登录干的」（`AdminAuditLog` 本身没有该列，故写入 afterData）。
   */
  private operatorContext(
    adminUserId: string,
    jti: string,
    ip: string,
    request: RequestWithContext,
    userAgent?: string,
  ): AdminOperatorContext {
    return {
      adminUserId,
      jti,
      ip,
      userAgent,
      requestId: request.requestId,
    };
  }
}
