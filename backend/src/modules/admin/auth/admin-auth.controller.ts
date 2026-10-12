/**
 * 管理端认证控制器
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.1（3 个接口：login / refresh / me）
 *
 * ## 关于第 4 个接口 `POST /admin/auth/password`
 *
 * 契约 §3.14.1 业务规则 6 明确要求「改密接口为 Admin 自身能力，前端强制跳改密页」，
 * 但附录 A.13 的接口索引**没有单列**该接口（索引里只有管理员侧的
 * `POST /admin/admins/{id}/reset-password`）。前端 `api/auth.ts` 已在调用
 * `POST /admin/auth/password`，缺了它 `mustChangePassword` 的管理员无法自助改密。
 * 因此按业务规则 6 实现，并在此标注这一文档缺口。
 *
 * ## 守卫组合（管理端控制器的固定写法）
 *
 * `@Public()` 跳过**用户端**全局守卫（否则管理员令牌会被判 realm 不匹配），
 * 再由 `AdminAuthGuard` + `RolesGuard` 承接管理端认证与 RBAC。
 * 登录/刷新用 `@AdminPublic()` 跳过管理端守卫 —— **不能**用 `@Public()`，
 * 那会让接口彻底公开。
 */

import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../../common/decorators';
import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { AdminPublic } from '../decorators/admin-public.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminAuthGuard } from './admin-auth.guard';
import {
  AdminAuthService,
  type AdminLoginResult,
  type AdminProfileView,
  type AdminRefreshResult,
} from './admin-auth.service';
import { AdminChangePasswordDto, AdminLoginDto, AdminRefreshDto, isWeakPassword } from './dto/admin-auth.dto';

@ApiTags('后台管理 - 认证')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly authService: AdminAuthService) {}

  @Post('login')
  @AdminPublic()
  /**
   * 契约 §3.14.1.1 要求成功响应为 **200**。
   * NestJS 的 `@Post()` 默认返回 201 Created，必须显式覆盖 ——
   * 否则按 200 判断的前端分支会走到非预期状态（实测确认过这一点）。
   */
  @HttpCode(HttpStatus.OK)
  // IP + 账号维度 10 次 / 5 分钟（契约 §3.14.1.1）；连续失败 5 次的锁定在 Service 内处理
  @Throttle({ global: { limit: 10, ttl: 300_000 } })
  @ApiHeader({ name: 'User-Agent', required: false, description: '写入登录审计' })
  @ApiOperation({
    summary: '管理员登录',
    description: [
      '账号密码登录，签发管理员 AccessToken（1h）与 RefreshToken（7d）。',
      '',
      '**不区分「账号不存在」与「密码错误」**（均返回 `20012`），防止管理员账号枚举；',
      '两条路径都会执行一次哈希校验，响应耗时接近，避免时序侧信道。',
      '',
      '**双维度锁定**：账号维度记 `failed_login_count` / `locked_until`，',
      'IP 维度用 Redis 计数；任一连续失败 5 次即锁定 15 分钟（`20011`，',
      '`details` 内含 `retryAfterSeconds`）。',
      '',
      '**先验密码再判状态**：若先判 `DISABLED`，响应差异会暴露「该用户名存在」。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '登录成功' })
  @ApiResponse({ status: 401, description: '账号或密码错误（`20012`）' })
  @ApiResponse({ status: 403, description: '账号被禁用（`20021`）或 IP 不在白名单（`20020`）' })
  @ApiResponse({ status: 429, description: '失败次数过多已锁定（`20011`）' })
  async login(
    @Body() dto: AdminLoginDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminLoginResult> {
    return this.authService.login({ username: dto.username, password: dto.password }, { ip, userAgent });
  }

  @Post('refresh')
  @AdminPublic()
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 30, ttl: 300_000 } })
  @ApiOperation({
    summary: '管理员令牌刷新',
    description: [
      '用 RefreshToken 换取新令牌（同样旋转 + 复用检测）。',
      '',
      '**复用检测**：已使用过的 RT 再次出现视为泄露信号，返回 `20005` 并**撤销该管理员全部会话**。',
      '',
      '**权限重取**：旋转时从数据库重新解析角色与权限，管理员被降权后旋转即生效。',
      '',
      '**被禁用即踢下线**：账号非 `ACTIVE` 时撤销全部会话并返回 `20021`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '刷新成功' })
  @ApiResponse({ status: 401, description: 'RT 无效（`20004`）或检测到复用（`20005`）' })
  @ApiResponse({ status: 403, description: '账号已被禁用（`20021`）' })
  async refresh(
    @Body() dto: AdminRefreshDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminRefreshResult> {
    return this.authService.refresh(dto.refreshToken, { ip, userAgent });
  }

  @Get('me')
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '当前管理员信息',
    description: [
      '返回当前管理员的资料、角色明细与**扁平化权限点**（前端据此做菜单与按钮级控制）。',
      '',
      '权限每次都从数据库解析，因此角色调整后刷新页面即可生效，无需重新登录。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '管理员不存在（`20022`）' })
  async me(@CurrentUser('userId') adminUserId: string): Promise<AdminProfileView> {
    return this.authService.getProfile(adminUserId);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '管理员登出',
    description: [
      '撤销**当前会话**（`jti`）。管理员常在多处登录，登出不应把其他设备一并踢下线。',
      '',
      '需要全部下线时走「修改密码」—— 那会撤销本人全部会话。',
      '',
      '⚠ 契约附录 A.13 的接口索引未单列本接口（索引里只有 login / refresh / me 三个），',
      '但前端 `api/auth.ts` 已在调用它，且「能登录不能登出」本身不成立，故一并实现。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '登出成功（幂等：会话已不存在同样返回成功）' })
  async logout(
    @CurrentUser('userId') adminUserId: string,
    @CurrentUser('jti') jti: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<{ success: boolean }> {
    return this.authService.logout(adminUserId, jti, { ip, userAgent });
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 10, ttl: 3600_000 } })
  @ApiOperation({
    summary: '修改本人密码',
    description: [
      '校验当前密码后设置新密码，并**撤销本人全部会话**（含当前会话）—— 改密的语义是',
      '「旧凭证全部作废」，若保留其他会话，攻击者已窃取的令牌仍然可用，改密就失去了意义。',
      '',
      '改密成功后 `mustChangePassword` 置为 `false`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '修改成功（需重新登录）' })
  @ApiResponse({ status: 401, description: '当前密码错误（`20012`）' })
  @ApiResponse({ status: 400, description: '新密码不符合强度要求或命中弱口令（`10001`）' })
  async changePassword(
    @CurrentUser('userId') adminUserId: string,
    @Body() dto: AdminChangePasswordDto,
  ): Promise<{ changed: boolean; revokedSessions: number; requireRelogin: true }> {
    if (isWeakPassword(dto.newPassword)) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '新密码过于简单，请更换更复杂的密码');
    }

    return this.authService.changePassword(adminUserId, dto.oldPassword, dto.newPassword);
  }
}
