/**
 * AdminAuthService — 管理员认证
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.1
 *
 * ## 安全设计要点
 *
 * 1. **不区分「账号不存在」与「密码错误」**（契约 §3.14.1.1 错误码表）：两者都返回
 *    `ADMIN_CREDENTIALS_INVALID`，否则给出一个免费的管理员账号枚举接口。
 * 2. **先验密码、再判状态**：若先判 `status = DISABLED` 就直接拒绝，
 *    攻击者能凭响应差异确认「这个用户名存在」。因此顺序必须是
 *    查账号 → 验密码 → 判状态。
 * 3. **双维度锁定**（架构 §14.3）：账号维度用 `failed_login_count` / `locked_until`，
 *    IP 维度用 Redis 计数 —— 只锁账号会让攻击者拿一个字典轮询大量账号，
 *    只锁 IP 会让攻击者换代理继续打同一个账号。
 * 4. **登录成功/失败都写审计**（契约 §3.14.1.1 业务规则 5）。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminUser } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { AppConfig } from '../../../config/config.type';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminRbacService, type AdminGrant, type AdminRoleBrief } from '../rbac/admin-rbac.service';
import { AdminTokenService } from './admin-token.service';
import { PasswordService } from './password.service';

/** 连续失败多少次锁定（契约 §3.14.1.1 业务规则 3） */
const MAX_FAILED_ATTEMPTS = 5;
/** 锁定时长（分钟） */
const LOCK_MINUTES = 15;
/** IP 维度失败计数的窗口（秒），与锁定时长一致 */
const IP_FAILURE_WINDOW_SECONDS = LOCK_MINUTES * 60;

/** 登录/刷新时的上下文（审计用） */
export interface AdminAuthContext {
  ip?: string;
  userAgent?: string;
}

/** 管理员信息（登录响应的 `admin`） */
export interface AdminProfileView {
  adminId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  roles: AdminRoleBrief[];
  permissions: string[];
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  passwordExpiresAt: string | null;
  mustChangePassword: boolean;
}

/** 会话信息（登录响应的 `session`） */
export interface AdminSessionView {
  sessionId: string;
  issuedAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

/** 登录结果（契约 §3.14.1.1 成功响应） */
export interface AdminLoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
  admin: AdminProfileView;
  session: AdminSessionView;
  /** 是否必须先改密码（首次登录 / 被重置后） */
  requirePasswordChange: boolean;
  /** 是否要求二次验证（本期未启用 MFA，恒为 false） */
  require2FA: boolean;
}

/** 刷新结果（契约 §3.14.1.2） */
export interface AdminRefreshResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
  rotatedAt: string;
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly ipWhitelist: readonly string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly passwords: PasswordService,
    private readonly tokens: AdminTokenService,
    private readonly rbac: AdminRbacService,
    private readonly audit: AdminAuditService,
    configService: ConfigService<AppConfig, true>,
  ) {
    // 白名单为空表示不启用 IP 限制（契约 §3.14.1.1：「配置 ADMIN_IP_WHITELIST 时生效」）
    this.ipWhitelist = this.parseIpWhitelist(configService.get('app.adminIpWhitelist', { infer: true }));
  }

  // ==========================================================================
  // 登录
  // ==========================================================================

  async login(
    input: { username: string; password: string },
    context: AdminAuthContext = {},
  ): Promise<AdminLoginResult> {
    const startedAt = Date.now();
    const username = input.username.trim();

    this.assertIpAllowed(context.ip);

    const admin = await this.prisma.adminUser.findFirst({
      where: { username, deletedAt: null },
    });

    // ------------------------------------------------------------------ 锁定检查
    if (admin?.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      throw this.buildLockedError(admin.lockedUntil);
    }

    const ipFailureCount = context.ip ? await this.getIpFailureCount(context.ip) : 0;
    if (ipFailureCount >= MAX_FAILED_ATTEMPTS) {
      await this.auditFailure(username, admin?.id ?? null, context, ErrorCode.LOGIN_TOO_MANY_ATTEMPTS, startedAt);
      throw this.buildLockedError(new Date(Date.now() + IP_FAILURE_WINDOW_SECONDS * 1000), '该 IP 尝试次数过多');
    }

    // ------------------------------------------------------------------ 账号不存在
    if (!admin) {
      // 与密码错误**完全同构**：同样的错误码、同样的耗时路径（都要走一次哈希）
      await this.passwords.verify(DUMMY_HASH, input.password);
      await this.registerFailure(null, username, context);
      await this.auditFailure(username, null, context, ErrorCode.ADMIN_CREDENTIALS_INVALID, startedAt);
      throw BusinessException.unauthorized(ErrorCode.ADMIN_CREDENTIALS_INVALID, '账号或密码错误');
    }

    // ------------------------------------------------------------------ 验密码
    const passwordOk = await this.passwords.verify(admin.passwordHash, input.password);

    if (!passwordOk) {
      const lockedUntil = await this.registerFailure(admin, username, context);
      await this.auditFailure(username, admin.id, context, ErrorCode.ADMIN_CREDENTIALS_INVALID, startedAt);

      if (lockedUntil) {
        throw this.buildLockedError(lockedUntil);
      }

      throw BusinessException.unauthorized(ErrorCode.ADMIN_CREDENTIALS_INVALID, '账号或密码错误');
    }

    // ------------------------------------------------------------------ 判状态
    // 放在密码校验**之后**：否则可以凭响应差异确认用户名是否存在
    if (admin.status === 'DISABLED') {
      await this.auditFailure(username, admin.id, context, ErrorCode.ADMIN_ACCOUNT_DISABLED, startedAt);
      throw BusinessException.forbidden(ErrorCode.ADMIN_ACCOUNT_DISABLED, '管理员账号已被禁用');
    }

    if (admin.status === 'LOCKED') {
      await this.auditFailure(username, admin.id, context, ErrorCode.LOGIN_TOO_MANY_ATTEMPTS, startedAt);
      throw this.buildLockedError(admin.lockedUntil ?? new Date(Date.now() + LOCK_MINUTES * 60 * 1000));
    }

    // ------------------------------------------------------------------ 登录成功
    const grant = await this.rbac.resolve(admin.id, admin.isSuperAdmin);

    // 参数升级后自动用新参数重算哈希（无需强制所有人改密码）
    const passwordHash = this.passwords.needsRehash(admin.passwordHash)
      ? await this.passwords.hash(input.password)
      : admin.passwordHash;

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: context.ip ?? null,
        ...(passwordHash === admin.passwordHash ? {} : { passwordHash, passwordUpdatedAt: new Date() }),
      },
    });

    if (context.ip) {
      await this.redis.del(this.ipFailureKey(context.ip));
    }

    const issued = await this.tokens.issueTokens({
      adminUserId: admin.id,
      roles: grant.roles,
      permissions: grant.permissions,
      context,
    });

    await this.audit.log({
      adminUserId: admin.id,
      adminUsername: admin.username,
      action: 'LOGIN',
      resourceType: 'admin_user',
      resourceId: admin.id,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      latencyMs: Date.now() - startedAt,
      success: true,
    });

    return this.buildLoginResult(admin, grant, issued);
  }

  // ==========================================================================
  // 刷新
  // ==========================================================================

  async refresh(refreshToken: string, context: AdminAuthContext = {}): Promise<AdminRefreshResult> {
    /**
     * 先从 RT 反查管理员，**再**重取权限：
     * `AdminTokenService.rotateRefreshToken` 需要一个已解析好的权限集合，
     * 而该集合必须来自数据库（旋转是刷新权限的天然时机）。
     */
    const parsed = this.tokens.parseRefreshToken(refreshToken);

    if (!parsed) {
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    const adminUserId = await this.findAdminIdBySession(parsed.jti);

    if (!adminUserId) {
      // 会话不存在：交给 token service 统一判定「复用攻击」还是「已过期」
      await this.tokens.rotateRefreshToken(refreshToken, { roles: [], permissions: [] }, context);
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
    });

    if (!admin) {
      await this.tokens.revokeAllSessions(adminUserId, 'admin_not_found');
      throw BusinessException.unauthorized(ErrorCode.ADMIN_CREDENTIALS_INVALID);
    }

    // 被禁用 / 锁定的管理员不允许续期，并立刻踢掉其全部会话
    if (admin.status !== 'ACTIVE') {
      await this.tokens.revokeAllSessions(admin.id, `admin_status_${admin.status}`);
      await this.auditFailure(admin.username, admin.id, context, ErrorCode.ADMIN_ACCOUNT_DISABLED, Date.now());
      throw BusinessException.forbidden(ErrorCode.ADMIN_ACCOUNT_DISABLED, '管理员账号已被禁用');
    }

    const grant = await this.rbac.resolve(admin.id, admin.isSuperAdmin);
    const { issued } = await this.tokens.rotateRefreshToken(refreshToken, grant, context);

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: 'Bearer',
      expiresIn: issued.expiresIn,
      refreshExpiresIn: issued.refreshExpiresIn,
      rotatedAt: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // 当前管理员
  // ==========================================================================

  async getProfile(adminUserId: string): Promise<AdminProfileView> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
    });

    if (!admin) {
      throw BusinessException.notFound(ErrorCode.ADMIN_NOT_FOUND, '管理员不存在');
    }

    const grant = await this.rbac.resolve(admin.id, admin.isSuperAdmin);

    return this.buildProfile(admin, grant);
  }

  // ==========================================================================
  // 登出
  // ==========================================================================

  /**
   * 登出当前设备
   *
   * 只撤销**当前会话**：管理员常在多处登录（办公室 + 家里），登出不应把别处踢下线；
   * 需要全部下线时走「修改密码」（会撤销全部会话）。
   *
   * 撤销会话即让 access token 立即失效 —— `assertPayloadUsable` 要求会话必须存在，
   * 因此不需要额外维护黑名单（会话删除本身已覆盖）。
   */
  async logout(adminUserId: string, jti: string, context: AdminAuthContext = {}): Promise<{ success: true }> {
    await this.tokens.revokeSessionByJti(adminUserId, jti, 'admin_logout');

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { username: true },
    });

    await this.audit.log({
      adminUserId,
      adminUsername: admin?.username ?? '(unknown)',
      action: 'LOGOUT',
      resourceType: 'admin_user',
      resourceId: adminUserId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      success: true,
    });

    return { success: true };
  }

  // ==========================================================================
  // 修改本人密码
  // ==========================================================================

  /**
   * 修改本人密码
   *
   * 改密成功后**撤销本人全部会话**（含当前会话）：改密的语义是「旧凭证全部作废」，
   * 若保留其他会话，攻击者此前窃取的令牌仍然可用，改密就失去了意义。
   * 代价是用户要重新登录一次，这是正确且必要的取舍。
   */
  async changePassword(
    adminUserId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ changed: boolean; revokedSessions: number; requireRelogin: true }> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
    });

    if (!admin) {
      throw BusinessException.notFound(ErrorCode.ADMIN_NOT_FOUND, '管理员不存在');
    }

    const passwordOk = await this.passwords.verify(admin.passwordHash, oldPassword);

    if (!passwordOk) {
      await this.auditFailure(admin.username, admin.id, {}, ErrorCode.ADMIN_CREDENTIALS_INVALID, Date.now());
      throw BusinessException.unauthorized(ErrorCode.ADMIN_CREDENTIALS_INVALID, '当前密码错误');
    }

    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        // 改密后不再强制改密，并清空失败计数（避免残留的锁定状态影响下次登录）
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        status: admin.status === 'LOCKED' ? 'ACTIVE' : admin.status,
      },
    });

    const revokedSessions = await this.tokens.revokeAllSessions(admin.id, 'password_changed');

    await this.audit.log({
      adminUserId: admin.id,
      adminUsername: admin.username,
      action: 'UPDATE',
      resourceType: 'admin_user',
      resourceId: admin.id,
      diffSummary: `修改本人密码（撤销 ${revokedSessions} 个会话）`,
      success: true,
    });

    this.logger.log(`管理员修改密码 adminUserId=${admin.id} revokedSessions=${revokedSessions}`);

    return { changed: true, revokedSessions, requireRelogin: true };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private assertIpAllowed(ip: string | undefined): void {
    if (this.ipWhitelist.length === 0) return;

    const normalized = this.normalizeIp(ip);

    if (normalized === null || !this.ipWhitelist.includes(normalized)) {
      throw BusinessException.forbidden(ErrorCode.ADMIN_IP_NOT_ALLOWED, '当前 IP 不在允许范围内');
    }
  }

  /**
   * 记录一次失败
   *
   * @returns 触发锁定时返回解锁时间；未触发返回 null
   */
  private async registerFailure(
    admin: AdminUser | null,
    username: string,
    context: AdminAuthContext,
  ): Promise<Date | null> {
    if (context.ip) {
      const key = this.ipFailureKey(context.ip);
      const count = await this.redis.incrWithTtl(key, IP_FAILURE_WINDOW_SECONDS);

      if (count >= MAX_FAILED_ATTEMPTS) {
        this.logger.warn(`管理端登录 IP 维度锁定 ip=${context.ip} failures=${count}`);
      }
    }

    if (!admin) return null;

    const failedLoginCount = admin.failedLoginCount + 1;
    const reachedLimit = failedLoginCount >= MAX_FAILED_ATTEMPTS;
    const lockedUntil = reachedLimit ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : null;

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        failedLoginCount,
        lockedUntil,
        // 达上限时把状态标为 LOCKED，便于后台列表直接看出「被锁定」
        status: reachedLimit ? 'LOCKED' : admin.status,
      },
    });

    if (reachedLimit) {
      this.logger.warn(`管理端登录账号维度锁定 username=${username} until=${lockedUntil?.toISOString() ?? '-'}`);
    }

    return lockedUntil;
  }

  /** 组装锁定错误；`details` 里带机器可读的重试秒数 */
  private buildLockedError(lockedUntil: Date, message = '登录失败次数过多，账号已被临时锁定'): BusinessException {
    const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));

    return BusinessException.tooManyRequests(
      ErrorCode.LOGIN_TOO_MANY_ATTEMPTS,
      `${message}，请 ${Math.ceil(retryAfterSeconds / 60)} 分钟后再试`,
      // 契约要求返回 Retry-After；本项目未改造全局异常过滤器，故以 details 提供
      // 等价的机器可读字段，前端据此展示倒计时
      [{ field: 'retryAfterSeconds', issue: String(retryAfterSeconds) }],
    );
  }

  private async getIpFailureCount(ip: string): Promise<number> {
    const raw = await this.redis.get(this.ipFailureKey(ip));
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private ipFailureKey(ip: string): string {
    return this.redis.key('admin', 'login', 'fail', ip);
  }

  /** 从会话 jti 反查管理员 ID（不做校验，校验在 token service 内完成） */
  private async findAdminIdBySession(jti: string): Promise<string | null> {
    const session = await this.redis.getJson<{ a: string }>(this.redis.key('admin', 'session', jti));
    return session?.a ?? null;
  }

  private async auditFailure(
    username: string,
    adminUserId: string | null,
    context: AdminAuthContext,
    errorCode: number,
    startedAt: number,
  ): Promise<void> {
    await this.audit.log({
      adminUserId,
      adminUsername: username,
      action: 'LOGIN_FAILED',
      resourceType: 'admin_user',
      resourceId: adminUserId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      success: false,
      errorCode: String(errorCode),
      latencyMs: Date.now() - startedAt,
    });
  }

  private buildLoginResult(
    admin: AdminUser,
    grant: AdminGrant,
    issued: {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      refreshExpiresIn: number;
      sessionId: string;
    },
  ): AdminLoginResult {
    const now = new Date();

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: 'Bearer',
      expiresIn: issued.expiresIn,
      refreshExpiresIn: issued.refreshExpiresIn,
      admin: this.buildProfile(admin, grant),
      session: {
        sessionId: issued.sessionId,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + issued.expiresIn * 1000).toISOString(),
        ip: admin.lastLoginIp ?? null,
        userAgent: null,
      },
      requirePasswordChange: admin.mustChangePassword,
      // MFA 未启用（契约 §3.14.1.1 返回该字段，本期恒为 false）
      require2FA: admin.mfaSecretEnc !== null,
    };
  }

  private buildProfile(admin: AdminUser, grant: AdminGrant): AdminProfileView {
    return {
      adminId: admin.id,
      username: admin.username,
      displayName: admin.nickname ?? admin.realName ?? admin.username,
      avatarUrl: null,
      status: admin.status,
      // 角色明细来自 RBAC 解析（含真实权限数），不再由本服务自行拼装
      roles: grant.roleBriefs,
      permissions: grant.permissions,
      lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
      lastLoginIp: admin.lastLoginIp,
      // 密码有效期策略本期未启用（契约字段保留）
      passwordExpiresAt: null,
      mustChangePassword: admin.mustChangePassword,
    };
  }

  /** 解析逗号分隔的 IP 白名单 */
  private parseIpWhitelist(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  private normalizeIp(ip: string | undefined): string | null {
    if (!ip) return null;
    // Express 在 IPv6 环境下会把 IPv4 表示为 ::ffff:1.2.3.4，白名单里通常写 1.2.3.4
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }
}

/**
 * 账号不存在时用于「陪跑」一次哈希校验的占位哈希
 *
 * 目的：让「账号不存在」与「密码错误」两条路径的**耗时接近**，
 * 避免通过响应时间差异做账号枚举。值为固定字符串，永远不可能匹配任何真实密码。
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c291bG1hcC1kdW1teS1zYWx0$0000000000000000000000000000000000000000000';
