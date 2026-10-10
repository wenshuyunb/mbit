/**
 * 认证控制器
 *
 * 契约来源：docs/API_DESIGN.md §3.1
 * 分层约定（架构 §6.1 P2）：Controller 只做参数校验、调用 Service、返回 DTO，
 * 不出现任何业务判断、不直接访问 Prisma。
 */

import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Ip, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../common/decorators';
import type { AuthPrincipal } from '../../common/types/request.type';
import {
  AuthService,
  type LoginResult,
  type LogoutResult,
  type RefreshResult,
  type SessionResult,
} from './auth.service';
import { LogoutDto, RefreshTokenDto, WechatLoginDto } from './dto/auth.dto';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ==========================================================================
  // 登录
  // ==========================================================================

  @Post('wechat/login')
  @Public()
  @HttpCode(HttpStatus.OK)
  // 契约限流：IP 10 次/5min。这里的 Throttle 覆盖全局默认值
  @Throttle({ global: { limit: 10, ttl: 300_000 } })
  @ApiOperation({
    summary: '微信静默登录',
    description: [
      '用 `wx.login()` 的一次性 code 换取 openid，查/建用户并签发双令牌（零摩擦登录）。',
      '',
      '**安全说明**：微信 `session_key` 仅加密落库，绝不返回客户端。',
      '',
      '**失败不创建用户**：调用微信失败时不会写库，避免产生僵尸账号。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '登录成功，返回双令牌与用户信息' })
  @ApiResponse({ status: 400, description: '参数不合法 / 微信登录凭证无效（`10001` / `20006`）' })
  @ApiResponse({ status: 403, description: '账号被封禁或处于注销冷静期（`20010` / `20014`）' })
  @ApiResponse({ status: 429, description: '触发限流（`10007`）' })
  @ApiResponse({ status: 502, description: '微信服务不可用（`20007`）' })
  async wechatLogin(
    @Body() dto: WechatLoginDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<LoginResult> {
    return this.authService.wechatLogin(dto, {
      deviceId: dto.deviceId,
      platform: dto.platform ?? 'miniapp',
      ip,
      userAgent,
    });
  }

  // ==========================================================================
  // 刷新
  // ==========================================================================

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  // 契约限流：IP + userId 30 次/5min。此处按 IP 维度限制，userId 维度由 Redis 细粒度限流补齐（Phase 5）
  @Throttle({ global: { limit: 30, ttl: 300_000 } })
  @ApiOperation({
    summary: '刷新令牌（RT 旋转）',
    description: [
      '用 RefreshToken 换取新的 AccessToken **和新的 RefreshToken**（旋转）。',
      '',
      '**复用检测**：已旋转作废的 RT 再次使用会被判定为令牌泄露，该用户全部会话将被撤销。',
      '',
      '**并发刷新**：同一 RT 的并发刷新仅第一个成功，其余返回 `20004`，属正常竞争，前端应复用第一个结果。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '刷新成功' })
  @ApiResponse({ status: 401, description: 'RT 无效（`20004`）或检测到复用（`20005`）' })
  @ApiResponse({ status: 403, description: '账号被封禁或处于注销冷静期（`20010` / `20014`）' })
  @ApiResponse({ status: 503, description: 'Redis 不可用，拒绝假成功（`90003`）' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<RefreshResult> {
    return this.authService.refresh(dto, { deviceId: dto.deviceId, ip, userAgent });
  }

  // ==========================================================================
  // 登出
  // ==========================================================================

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 10, ttl: 600_000 } })
  @ApiOperation({
    summary: '退出当前设备',
    description: [
      '撤销当前设备的 RefreshToken，并把当前 AccessToken 加入黑名单使其**立即失效**。',
      '',
      '**幂等**：对已失效的 RT 调用仍返回 200（`revokedSessions: 0`）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '登出成功' })
  @ApiResponse({ status: 401, description: '未登录或令牌已过期（`20000` / `20001`）' })
  @ApiResponse({ status: 503, description: 'Redis 不可用，拒绝假成功（`90003`）' })
  async logout(@CurrentUser() principal: AuthPrincipal, @Body() dto: LogoutDto): Promise<LogoutResult> {
    return this.authService.logout(principal, dto);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 5, ttl: 600_000 } })
  @ApiOperation({
    summary: '退出全部设备',
    description: '撤销该用户全部有效会话（含其他设备），用于「怀疑账号被盗」场景。',
  })
  @ApiResponse({ status: 200, description: '已撤销全部会话' })
  @ApiResponse({ status: 401, description: '未登录或令牌已过期（`20000` / `20001`）' })
  async logoutAll(@CurrentUser() principal: AuthPrincipal): Promise<LogoutResult> {
    return this.authService.logoutAll(principal);
  }

  // ==========================================================================
  // 会话查询
  // ==========================================================================

  @Get('session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: '查询当前登录态',
    description: '返回当前 AccessToken 对应的会话信息，用于前端校验登录态是否仍然有效。',
  })
  @ApiResponse({ status: 200, description: '会话有效' })
  @ApiResponse({ status: 401, description: '未登录 / 令牌已过期 / 会话已撤销（`20000` / `20001` / `20016`）' })
  @ApiResponse({ status: 404, description: '会话不存在（`20015`）' })
  async getSession(@CurrentUser() principal: AuthPrincipal): Promise<SessionResult> {
    return this.authService.getSession(principal);
  }
}
