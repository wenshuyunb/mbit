/**
 * 认证服务 — 微信登录、令牌刷新、登出
 *
 * 契约来源：docs/API_DESIGN.md §3.1
 *
 * 关键安全与业务规则（逐条对应契约中的「业务规则与边界条件」）：
 *   1. `session_key` 立即用 AES-256-GCM 加密落库，**绝不**出现在任何响应中；日志只记 openid 哈希
 *   2. 按 `UNIQUE(openid)` 查/建用户；`unionid` 存在时同步写入
 *   3. 注销冷静期内的账号返回 `ACCOUNT_IN_DELETION_GRACE`，**不签发新令牌**
 *   4. 已注销账号的 openid 已被匿名化，微信侧返回同一 openid 时会创建**全新用户**（合规要求）
 *   5. RefreshToken 哈希写 Redis 白名单 + `user_sessions` 审计表
 *   6. 新用户不自动建画像，`hasProfile=false` 引导完成首次测试
 *   7. 多设备可同时登录，互不影响；`logout-all` 才全量撤销
 *   8. 调用微信失败时**不写库**，避免产生无 session_key 的僵尸账号
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AuthPrincipal } from '../../common/types/request.type';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { WechatService } from '../../infra/wechat/wechat.service';
import type { LogoutDto, RefreshTokenDto, WechatLoginDto } from './dto/auth.dto';
import { TokenService, type SessionContext } from './token.service';

/** 登录响应中的用户信息（与契约 §3.1.1 的 data.user 一致） */
export interface AuthUserView {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
  gender: string;
  birthday: string | null;
  phoneBound: boolean;
  status: string;
  ageVerified: boolean;
  hasProfile: boolean;
  mbtiType: string | null;
  membership: {
    isActive: boolean;
    planCode: string | null;
    expiresAt: string | null;
  };
  createdAt: string;
}

/** 登录响应 */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
  isNewUser: boolean;
  user: AuthUserView;
  session: {
    sessionId: string;
    issuedAt: string;
    expiresAt: string;
    deviceId: string | null;
  };
}

/** 刷新响应（契约 §3.1.2 只返回令牌，不重复返回用户信息） */
export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
  rotatedAt: string;
}

/** 登出响应 */
export interface LogoutResult {
  revokedSessions: number;
  accessTokenRevoked: boolean;
  revokedAt: string;
}

/** 当前会话信息 */
export interface SessionResult {
  sessionId: string;
  userId: string;
  realm: string;
  deviceId: string | null;
  platform: string | null;
  issuedAt: string;
  expiresAt: string;
  absoluteLifecycleDays: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** 写入 `wechat_accounts.appid`；未配置时用占位符，避免 NOT NULL 约束失败 */
  private readonly appId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wechat: WechatService,
    private readonly crypto: CryptoService,
    private readonly tokens: TokenService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.appId = configService.get('wechat.appId', { infer: true }).trim() || 'unconfigured';
  }

  // ==========================================================================
  // 登录
  // ==========================================================================

  /**
   * 微信静默登录：用一次性 code 换取 openid，查/建用户并签发双令牌
   */
  async wechatLogin(dto: WechatLoginDto, context: SessionContext = {}): Promise<LoginResult> {
    // 规则 8：先调微信。失败直接抛出，绝不写库
    const session = await this.wechat.code2Session(dto.code);

    // openid 属于个人标识，日志中只记录哈希（架构 §14.2 日志脱敏）
    const openidHash = this.crypto.sha256(session.openid).slice(0, 16);
    this.logger.log(`收到登录请求 openidHash=${openidHash} platform=${dto.platform ?? 'miniapp'}`);

    const existing = await this.prisma.wechatAccount.findUnique({
      where: { openid: session.openid },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        user: { select: { id: true, status: true, version: true, deletedAt: true } },
      },
    });

    // 规则 4：已注销账号（deletedAt 非空）不做找回，走新建流程
    const useExisting = existing !== null && existing.deletedAt === null && existing.user.deletedAt === null;

    if (useExisting && existing) {
      return this.loginExistingUser(existing.user.id, session, dto, context);
    }

    return this.registerNewUser(session, dto, context);
  }

  // ==========================================================================
  // 刷新
  // ==========================================================================

  /**
   * 刷新令牌（RT 旋转 + 复用检测）
   *
   * 契约 §3.1.2 规则 2：并发刷新时仅第一个成功，其余返回令牌无效 —— 这是**正常竞争**，
   * 前端应复用第一个结果而不提示用户（前端已实现 single-flight）。
   */
  async refresh(dto: RefreshTokenDto, context: SessionContext = {}): Promise<RefreshResult> {
    const { issued } = await this.tokens.rotateRefreshToken(dto.refreshToken, {
      ...context,
      deviceId: dto.deviceId ?? context.deviceId,
    });

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
  // 登出
  // ==========================================================================

  /**
   * 退出当前设备（或指定 RefreshToken 对应的会话）
   *
   * 契约 §3.1.3 规则 4：幂等 —— 对已失效的 RT 调用仍返回 200（revokedSessions: 0），
   * 避免登出接口本身成为错误源。
   */
  async logout(principal: AuthPrincipal, dto: LogoutDto): Promise<LogoutResult> {
    const reason = dto.allDevices === true ? 'USER_LOGOUT_ALL' : 'USER_LOGOUT';

    let revokedSessions: number;

    if (dto.allDevices === true) {
      revokedSessions = await this.tokens.revokeAllSessions(principal.userId, reason);
    } else if (dto.refreshToken) {
      revokedSessions = await this.tokens.revokeSessionByRefreshToken(dto.refreshToken, reason);
    } else {
      // 未传 RT：撤销当前 AccessToken 对应的会话（按 jti 关联）
      const revoked = await this.tokens.revokeSessionByJti(principal.userId, principal.jti, reason);
      revokedSessions = revoked ? 1 : 0;
    }

    // 让当前 AccessToken 立即失效，而不是等其自然过期（契约规则 1）
    const accessTokenRevoked = await this.revokeCurrentAccessToken(principal.jti);

    return {
      revokedSessions,
      accessTokenRevoked,
      revokedAt: new Date().toISOString(),
    };
  }

  /** 退出全部设备 */
  async logoutAll(principal: AuthPrincipal): Promise<LogoutResult> {
    const revokedSessions = await this.tokens.revokeAllSessions(principal.userId, 'USER_LOGOUT_ALL');
    const accessTokenRevoked = await this.revokeCurrentAccessToken(principal.jti);

    return {
      revokedSessions,
      accessTokenRevoked,
      revokedAt: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // 会话查询
  // ==========================================================================

  async getSession(principal: AuthPrincipal): Promise<SessionResult> {
    const session = await this.prisma.userSession.findUnique({
      where: { jti: principal.jti },
      select: {
        id: true,
        userId: true,
        deviceId: true,
        platform: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!session || session.userId !== principal.userId) {
      throw BusinessException.notFound(ErrorCode.SESSION_NOT_FOUND);
    }

    if (session.revokedAt !== null) {
      throw BusinessException.unauthorized(ErrorCode.SESSION_REVOKED);
    }

    return {
      sessionId: session.id,
      userId: session.userId,
      realm: principal.realm,
      deviceId: session.deviceId,
      platform: session.platform,
      issuedAt: session.issuedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      absoluteLifecycleDays: 180,
    };
  }

  // ==========================================================================
  // 内部：已存在用户登录
  // ==========================================================================

  private async loginExistingUser(
    userId: string,
    session: Awaited<ReturnType<WechatService['code2Session']>>,
    dto: WechatLoginDto,
    context: SessionContext,
  ): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, version: true, deletedAt: true },
    });

    if (!user || user.deletedAt !== null) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    // 规则：被限制的账号直接拒绝，且撤销其全部会话
    // 注意：UserStatus 枚举为 ACTIVE | DISABLED | DELETED（无 BANNED），
    //      「封禁」在数据层对应 DISABLED，对外统一返回 ACCOUNT_BANNED。
    if (user.status === 'DISABLED') {
      await this.tokens.revokeAllSessions(user.id, 'ACCOUNT_DISABLED');
      throw BusinessException.forbidden(ErrorCode.ACCOUNT_BANNED);
    }

    if (user.status !== 'ACTIVE') {
      // 其余非正常状态（如 DELETED 未匿名化完成）一律拒绝登录
      await this.tokens.revokeAllSessions(user.id, `ACCOUNT_${user.status}`);
      throw BusinessException.forbidden(ErrorCode.ACCOUNT_BANNED);
    }

    // 规则 3：注销冷静期内的账号不签发新令牌，前端展示「撤销注销」入口
    const pendingDeletion = await this.prisma.userDeletionRequest.findFirst({
      where: { userId: user.id, status: 'PENDING' },
      select: { id: true },
    });

    if (pendingDeletion) {
      throw BusinessException.forbidden(ErrorCode.ACCOUNT_IN_DELETION_GRACE);
    }

    // ------------------------------------------------------------------ 写库
    // session_key 每次登录都会变化，必须覆盖更新（规则 1）
    await this.prisma.wechatAccount.updateMany({
      where: { openid: session.openid, deletedAt: null },
      data: {
        sessionKeyEnc: this.crypto.encrypt(session.sessionKey),
        sessionKeyExpireAt: new Date(Date.now() + session.expiresInSeconds * 1000),
        ...(session.unionid ? { unionid: session.unionid } : {}),
        lastAuthAt: new Date(),
      },
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(context.ip ? { lastLoginIp: context.ip } : {}),
      },
    });

    // ------------------------------------------------------------------ 令牌
    const issued = await this.tokens.issueTokens({
      userId: user.id,
      openid: session.openid,
      userVersion: user.version,
      context,
    });

    const view = await this.buildUserView(user.id);

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: 'Bearer',
      expiresIn: issued.expiresIn,
      refreshExpiresIn: issued.refreshExpiresIn,
      isNewUser: false,
      user: view,
      session: {
        sessionId: issued.sessionId,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + issued.expiresIn * 1000).toISOString(),
        deviceId: dto.deviceId ?? null,
      },
    };
  }

  // ==========================================================================
  // 内部：新用户注册
  // ==========================================================================

  private async registerNewUser(
    session: Awaited<ReturnType<WechatService['code2Session']>>,
    dto: WechatLoginDto,
    context: SessionContext,
  ): Promise<LoginResult> {
    const sessionKeyEnc = this.crypto.encrypt(session.sessionKey);
    const sessionKeyExpireAt = new Date(Date.now() + session.expiresInSeconds * 1000);

    // 邀请码归因：解析失败不影响注册（契约明确「不影响登录成败」）
    const inviterUserId = await this.resolveInviter(dto.inviterCode);

    // 年龄声明：< 18 岁置 ageVerified=false，由业务层禁用恋爱匹配（架构 §14.3）
    const ageVerified = typeof dto.ageDeclared === 'number' ? dto.ageDeclared >= 18 : false;

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          status: 'ACTIVE',
          ageVerified,
          inviterUserId,
          registerChannel: dto.inviterCode ? 'INVITE' : (context.platform ?? 'miniapp'),
          lastLoginAt: new Date(),
          ...(context.ip ? { lastLoginIp: context.ip } : {}),
        },
        select: { id: true, status: true, version: true, createdAt: true },
      });

      await tx.wechatAccount.create({
        data: {
          userId: user.id,
          appid: this.appId,
          platform: 'MINIAPP',
          openid: session.openid,
          unionid: session.unionid,
          sessionKeyEnc,
          sessionKeyExpireAt,
          lastAuthAt: new Date(),
        },
      });

      return user;
    });

    this.logger.log(`新用户注册成功 userId=${created.id} channel=${dto.inviterCode ? 'INVITE' : 'DIRECT'}`);

    const issued = await this.tokens.issueTokens({
      userId: created.id,
      openid: session.openid,
      userVersion: created.version,
      context,
    });

    const view = await this.buildUserView(created.id);

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: 'Bearer',
      expiresIn: issued.expiresIn,
      refreshExpiresIn: issued.refreshExpiresIn,
      isNewUser: true,
      user: view,
      session: {
        sessionId: issued.sessionId,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + issued.expiresIn * 1000).toISOString(),
        deviceId: dto.deviceId ?? null,
      },
    };
  }

  // ==========================================================================
  // 内部：辅助
  // ==========================================================================

  /** 撤销当前 AccessToken（加入黑名单至其自然过期） */
  private async revokeCurrentAccessToken(jti: string): Promise<boolean> {
    try {
      // 这里无法从 principal 拿到 exp，因此按 AccessToken 的最大 TTL 设置黑名单 TTL；
      // 键会在 TTL 到点后自动清理，不会无限增长。
      await this.tokens.blacklistAccessToken(jti, Math.floor(Date.now() / 1000) + this.tokens.accessTokenTtlSeconds);
      return true;
    } catch (error) {
      // 契约 §3.1.3：Redis 不可用时应返回失败而不是假成功
      this.logger.error(`AccessToken 加入黑名单失败 jti=${jti}: ${(error as Error).message}`);
      throw BusinessException.unavailable(ErrorCode.CACHE_ERROR, '退出登录失败，请稍后重试');
    }
  }

  /** 解析邀请码 → 邀请人 ID；任何异常都返回 null（不阻断注册） */
  private async resolveInviter(inviterCode?: string): Promise<string | null> {
    if (!inviterCode) return null;

    try {
      const invite = await this.prisma.relationshipInvite.findUnique({
        where: { code: inviterCode },
        select: { inviterId: true, status: true, expiresAt: true },
      });

      if (!invite) return null;

      // 已过期/已撤销的邀请码不做归因（但仍不阻断注册）
      if (invite.status === 'EXPIRED' || invite.status === 'REVOKED') return null;
      if (invite.expiresAt.getTime() <= Date.now()) return null;

      return invite.inviterId;
    } catch (error) {
      this.logger.warn(`邀请码解析失败（不影响注册）code=${inviterCode}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * 组装用户视图
   *
   * 注意：**绝不**返回 openid、session_key、phoneEnc 等敏感字段（契约 §3.1.1 响应字段说明）。
   */
  private async buildUserView(userId: string): Promise<AuthUserView> {
    const [user, profile, membership] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          nickname: true,
          avatarUrl: true,
          gender: true,
          birthday: true,
          phoneHash: true,
          status: true,
          ageVerified: true,
          createdAt: true,
        },
      }),
      this.prisma.personalityProfile.findFirst({
        where: { userId, isCurrent: true, deletedAt: null },
        select: { mbtiType: true },
      }),
      this.prisma.membership.findFirst({
        where: { userId, status: 'ACTIVE', expireAt: { gt: new Date() }, deletedAt: null },
        select: { expireAt: true, plan: { select: { code: true } } },
        orderBy: { expireAt: 'desc' },
      }),
    ]);

    if (!user) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    return {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      gender: user.gender,
      birthday: user.birthday ? user.birthday.toISOString().slice(0, 10) : null,
      // 只暴露「是否已绑定」，不暴露手机号本身
      phoneBound: user.phoneHash !== null,
      status: user.status,
      ageVerified: user.ageVerified,
      hasProfile: profile !== null,
      mbtiType: profile?.mbtiType ?? null,
      membership: {
        isActive: membership !== null,
        planCode: membership?.plan.code ?? null,
        expiresAt: membership?.expireAt.toISOString() ?? null,
      },
      createdAt: user.createdAt.toISOString(),
    };
  }
}
