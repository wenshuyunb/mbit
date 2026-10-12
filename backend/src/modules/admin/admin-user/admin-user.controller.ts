/**
 * 管理端「管理员账号」控制器
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.9.4（列表）/ §3.14.9.5（新建）/ §3.14.9.6（重置密码）
 *
 * ## 守卫组合（管理端控制器的固定写法）
 *
 * `@Public()` 跳过的是**用户端**全局 `JwtAuthGuard`（管理员令牌 `realm = admin`
 * 在它手里会被判 `REALM_MISMATCH`），管理端认证由
 * `AdminAuthGuard` + `RolesGuard` + `ConfirmPasswordGuard` 承担。
 * 🚫 绝不能用 `@AdminPublic()` —— 那是匿名标记，会让「能创建管理员」的接口彻底公开。
 *
 * `ConfirmPasswordGuard` 常驻在守卫链上，只在标了 `@SensitiveOperation()` 的接口上生效：
 * 创建管理员与重置密码都是**能改变他人凭证**的操作，必须要求操作者当场输入本人密码，
 * 否则「会话被盗」直接等价于「可接管任意低权限账号」。
 *
 * ## HTTP 状态码
 *
 * 契约对两个写接口的要求不同：新建是 **201**，重置密码是 **200**
 * （NestJS 的 `@Post()` 默认 201）。两者都显式写出，避免后续有人「顺手」统一它们
 * 而破坏契约 —— 前端按状态码分支时，这种静默偏差极难定位。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../../common/decorators';
import type { RequestWithContext } from '../../../common/types/request.type';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { SensitiveOperation } from '../decorators/sensitive-operation.decorator';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminUserService, type AdminOperatorContext } from './admin-user.service';
import {
  AdminCreateResultDto,
  AdminPasswordResetResultDto,
  AdminUserListDto,
  AdminUserListQueryDto,
  CreateAdminUserDto,
  ResetAdminPasswordDto,
} from './dto/admin-user.dto';

@ApiTags('后台管理 - 管理员账号')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/admins')
export class AdminUserController {
  constructor(private readonly adminUsers: AdminUserService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.ADMIN_READ)
  // 契约限流：adminId 300 次/60s
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '管理员列表',
    description: [
      '查询管理员账号（角色、状态、最近登录、近 7 天操作统计）。',
      '',
      '**`summary`** 基于当前筛选条件且不受分页影响，因此 `totalAdmins` 与 `items.length` 不必相等；',
      '`byRole` 覆盖全部内置角色码，缺失项补 0（前端筛选器需要稳定的键集合）。',
      '',
      '**`permissionCount`** 是权限并集的规模，持通配符 `*` 的账号折算为系统全部权限点数 ——',
      '它是「这个账号有多大权力」的直接读数，用于复核最小权限原则。',
      '',
      '**统计口径**：`loginCount30d` 取审计表近 30 天 `LOGIN`+成功记录；',
      '`operationStats7d.readActions` 由「总数 − 写类 − 登录类」反推。',
      '`AdminAuditAction` 枚举**没有 `READ`**，读接口无法入账，因此该值只是近似值（不编造读操作数字）。',
      '',
      '🚫 任何情况下都不返回 `passwordHash`（查询字段为白名单）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功', type: AdminUserListDto })
  @ApiResponse({
    status: 400,
    description:
      '`status` / `roleCode` 含非法值（`10001`）；`pageSize > 100` 等参数不合法（`10001`，由全局 ValidationPipe 统一返回）',
  })
  @ApiResponse({ status: 401, description: '未登录或管理员令牌失效（`20001` / `20002` / `20003`）' })
  @ApiResponse({ status: 403, description: '缺少 `system:admin:read`（`20009`）' })
  async list(@Query() query: AdminUserListQueryDto): Promise<AdminUserListDto> {
    return this.adminUsers.listAdmins(query);
  }

  @Post()
  /**
   * 契约 §3.14.9.5 要求成功响应为 **201 Created**（`@Post()` 默认即 201，显式写出以防被改）。
   */
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(ADMIN_PERMISSIONS.ADMIN_WRITE)
  // 敏感操作：由 ConfirmPasswordGuard 校验 `X-Confirm-Password`（本控制器不自行读取该头）
  @SensitiveOperation()
  // 契约限流：adminId 10 次/60min
  @Throttle({ global: { limit: 10, ttl: 3_600_000 } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人登录密码（二次确认，缺失 `20017` / 错误 `20018`）',
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description: '建议携带（契约 §3.14.9.5「建议」而非强制）；重复提交由 `username` 唯一约束兜底，返回 `10003`',
  })
  @ApiOperation({
    summary: '新建管理员',
    description: [
      '创建管理员账号并分配角色。⚡ **CRITICAL 级操作**，需要 `X-Confirm-Password` 二次确认。',
      '',
      '**初始密码**：`initialPassword` 不传则由服务端生成一次性强密码（16 位，四类字符齐全，',
      '排除易混淆字符）；传了则必须满足 12–64 位 + 大小写字母/数字/符号。',
      '明文**仅在本响应出现一次**，服务端只存 Argon2id 哈希。',
      '',
      '⚠️ `expiresInHours: 24`（契约要求「24 小时内未登录则密码失效」）目前**未强制执行**：',
      '`admin_users` 没有密码过期时间列，登录链路也不读取该语义。',
      '',
      '**默认强制首登改密**（`mustChangePassword` 默认 `true`）：初始密码要经过转交环节，不可长期有效。',
      '',
      '⛔ **不允许通过本接口授予 `SUPER_ADMIN`**（返回 `10008`）——',
      '否则一个拥有 `system:admin:write` 的账号可以一步拿到全权，授权模型就此失效。',
      '超管只能在初始化种子或人工介入的部署流程中设置。',
      '',
      '⚠️ `ipWhitelist`：数据模型无该列，实际落在 `system_configs`（`admin.ipWhitelist.{adminId}`）留痕，',
      '**登录时尚未强制校验**（登录校验用的是全局 `ADMIN_IP_WHITELIST` 环境变量）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '创建成功（返回一次性初始密码）', type: AdminCreateResultDto })
  @ApiResponse({
    status: 400,
    description:
      '参数不合法（`10001`：`username` 非邮箱格式 / `roleCodes` 为空或含不存在的角色码 / `initialPassword` 不满足强度 / `ipWhitelist` 超过 10 个或格式非法）',
  })
  @ApiResponse({
    status: 401,
    description: '未登录（`20001`/`20002`）或缺少 / 错误的二次确认密码（`20017` / `20018`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `system:admin:write`（`20009`）或试图授予 `SUPER_ADMIN`（`10008`）' })
  @ApiResponse({ status: 409, description: '`username` 已存在（`10003`，契约原文为 `10012`）' })
  async create(
    @Body() dto: CreateAdminUserDto,
    @CurrentUser('userId') operatorAdminId: string,
    @CurrentUser('jti') jti: string,
    @Req() request: RequestWithContext,
  ): Promise<AdminCreateResultDto> {
    return this.adminUsers.createAdmin(dto, this.buildOperatorContext(operatorAdminId, jti, request));
  }

  @Post(':id/reset-password')
  /**
   * 契约 §3.14.9.6 要求成功响应为 **200**，而 `@Post()` 默认 201。
   * 必须显式覆盖 —— 否则按 200 判断的前端分支会走到非预期状态。
   */
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.ADMIN_WRITE)
  @SensitiveOperation()
  @Throttle({ global: { limit: 10, ttl: 3_600_000 } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人登录密码（二次确认，缺失 `20017` / 错误 `20018`）',
  })
  @ApiOperation({
    summary: '重置管理员密码',
    description: [
      '重置指定管理员的密码（服务端生成一次性强密码），并可选撤销其全部登录会话。',
      '⚡ **CRITICAL 级操作**，需要 `X-Confirm-Password` 二次确认。',
      '',
      '**同时解锁**（契约规则 1）：`status: LOCKED → ACTIVE`、`failedLoginCount = 0`、`lockedUntil = null`，',
      '与改密在**同一事务**内完成 —— 否则会出现「密码已换新但账号仍被锁定，新密码也登不进去」的中间态。',
      '',
      '**会话撤销**（`revokeSessions` 默认 `true`）：撤销全部 RT 并让其会话失效（架构 §9.2）。',
      '撤销在事务提交**之后**执行：会话状态在 Redis，与 Postgres 不具原子性，放进事务会产生',
      '「DB 回滚但会话已删」的不一致。',
      '',
      '⛔ **不允许重置其他 `SUPER_ADMIN` 的密码**（返回 `20009`），防横向接管；',
      '重置**自己**允许 —— 代价是本人全部会话被撤销（属预期）。',
      '超管忘记密码需走部署侧应急流程。',
      '',
      '⚠️ `expiresInHours: 24` 的「24 小时内未登录即失效」目前**未强制执行**（无密码过期列）。',
      '审计 `before/after` 只记录 `passwordUpdatedAt` / `failedLoginCount` / `mustChangePassword` / `revokedSessions`，',
      '🚫 **不记录任何密码或哈希**。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '重置成功（返回一次性新密码）', type: AdminPasswordResetResultDto })
  @ApiResponse({ status: 400, description: '`id` 非合法 UUID 或 `reason` 缺失/超长（`10001`，契约原文为 `10003`）' })
  @ApiResponse({
    status: 401,
    description: '未登录（`20001`/`20002`）或缺少 / 错误的二次确认密码（`20017` / `20018`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `system:admin:write`（`20009`）或试图重置其他超管密码（`20009`）' })
  @ApiResponse({ status: 404, description: '管理员不存在（`20022`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 10 次（`10007`，由全局限流器返回）' })
  async resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetAdminPasswordDto,
    @CurrentUser('userId') operatorAdminId: string,
    @CurrentUser('jti') jti: string,
    @Req() request: RequestWithContext,
  ): Promise<AdminPasswordResetResultDto> {
    return this.adminUsers.resetAdminPassword(id, dto, this.buildOperatorContext(operatorAdminId, jti, request));
  }

  /**
   * 组装审计上下文
   *
   * `requestId` 由 `RequestIdMiddleware` 注入（贯穿全链路日志），可能缺失
   * （单测直接调 Service、或中间件未覆盖的路径）时给 `undefined`，
   * 由 Service 统一落成 SQL `NULL`，而不是编造一个假 ID。
   */
  private buildOperatorContext(adminUserId: string, jti: string, request: RequestWithContext): AdminOperatorContext {
    return {
      adminUserId,
      jti,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      requestId: request.requestId,
    };
  }
}
