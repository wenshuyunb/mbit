/**
 * 会话与令牌服务
 *
 * 职责（架构文档 §9.2、API_DESIGN §3.1）：
 *   · 签发 AccessToken（JWT，2h）与 RefreshToken（不透明随机串，30d）
 *   · RefreshToken 旋转（rotation）与**复用检测**（检测到复用即撤销该用户全部会话）
 *   · AccessToken 黑名单（登出后立即失效，而非等自然过期）
 *   · 会话审计落库（`user_sessions`），支持按设备撤销与全量撤销
 *
 * RefreshToken 格式：`rt_<jti>.<secret>`
 *   · jti 为 UUIDv4（纯随机，不含用户信息），用于 O(1) 定位会话，避免全量扫描
 *   · secret 为 256bit 随机串，服务端只存其 SHA-256 哈希 —— 即使 Redis 泄漏，
 *     攻击者也无法直接使用其中的值换取令牌
 *
 * Redis 键设计（与架构 §9.2 的命名约定一致，前缀由 RedisService 统一添加）：
 *   · `rt:session:{jti}`   → JSON { u: userId, h: secretHash, abs: 会话绝对到期时间戳 }
 *   · `rt:used:{jti}`      → userId（旋转后留下的「已使用」标记，用于复用检测）
 *   · `sess:user:{userId}` → SET of jti（该用户全部有效会话，用于 logout-all）
 *   · `jwt:blacklist:{jti}`→ 已登出的 AccessToken（TTL = 其剩余有效期）
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AuthPrincipal } from '../../common/types/request.type';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

/** RefreshToken 前缀（便于在日志与抓包中识别令牌类型） */
const REFRESH_TOKEN_PREFIX = 'rt_';

/** RefreshToken 分隔符：`rt_<jti>.<secret>` */
const REFRESH_TOKEN_SEPARATOR = '.';

/**
 * 会话链路的绝对存活上限（180 天）
 *
 * 无论连续刷新多少次，超过该时限都要求重新 wx.login。
 * 目的：限制被盗令牌的可用窗口，避免「一次泄露、终身有效」。
 */
const ABSOLUTE_SESSION_LIFETIME_DAYS = 180;

/** AccessToken 载荷（与 API 契约 §3.1.1 一致） */
export interface AccessTokenPayload {
  /** 用户 ID */
  sub: string;
  /** 微信 openid（用于日志与风控，不含敏感信息） */
  openid: string;
  /** 认证域：用户端固定 'user' */
  realm: 'user';
  /** 用户数据版本号，用户资料重大变更时递增可使旧令牌失效 */
  ver: number;
  /** 会话标识（与 RefreshToken 的 jti 一致） */
  jti: string;
  iat?: number;
  exp?: number;
}

/** Redis 中保存的会话记录 */
interface StoredSession {
  /** 所属用户 ID */
  u: string;
  /** RefreshToken secret 的 SHA-256 哈希 */
  h: string;
  /** 会话绝对到期时间（epoch ms），继承自链路起点 */
  abs: number;
}

/** 签发结果 */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  jti: string;
  /** 会话绝对到期时间 */
  absoluteExpiresAt: Date;
}

/** 签发上下文（审计信息） */
export interface SessionContext {
  deviceId?: string;
  platform?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly userSecret: string;
  private readonly accessTtl: string;
  private readonly refreshTtl: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly prisma: PrismaService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.userSecret = configService.get('jwt.userSecret', { infer: true });
    this.accessTtl = configService.get('jwt.userAccessTtl', { infer: true });
    this.refreshTtl = configService.get('jwt.userRefreshTtl', { infer: true });
    this.accessTtlSeconds = this.crypto.getRefreshTokenTtlSeconds(this.accessTtl);
    this.refreshTtlSeconds = this.crypto.getRefreshTokenTtlSeconds(this.refreshTtl);
  }

  // ==========================================================================
  // 对外只读属性（供 AuthService 组装响应，避免重复解析 TTL）
  // ==========================================================================

  get accessTokenTtlSeconds(): number {
    return this.accessTtlSeconds;
  }

  get refreshTokenTtlSeconds(): number {
    return this.refreshTtlSeconds;
  }

  // ==========================================================================
  // 签发
  // ==========================================================================

  /**
   * 签发一组新的令牌并建立会话
   *
   * @param options.userId      用户 ID
   * @param options.openid      微信 openid（写入 JWT 载荷用于审计）
   * @param options.userVersion 用户数据版本号（user.version）
   * @param options.context     设备/IP/UA 审计信息
   * @param options.replacesSessionJti 旋转场景下被替换的会话 jti（用于链路审计与绝对寿命继承）
   * @param options.absoluteExpiresAt  会话绝对到期时间；旋转时继承，首次登录时为新算值
   * @param options.auditOnly   为 true 时只签发令牌、不写 `user_sessions`（不推荐，仅测试用）
   */
  async issueTokens(options: {
    userId: string;
    openid: string;
    userVersion: number;
    context?: SessionContext;
    replacesSessionJti?: string;
    absoluteExpiresAt?: Date;
    auditOnly?: boolean;
  }): Promise<IssuedTokens> {
    const jti = uuidv4();
    const secret = this.crypto.randomToken();
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${jti}${REFRESH_TOKEN_SEPARATOR}${secret}`;
    const secretHash = this.crypto.sha256(secret);

    const absoluteExpiresAt = options.absoluteExpiresAt ?? addDays(new Date(), ABSOLUTE_SESSION_LIFETIME_DAYS);

    // ------------------------------------------------------------------ Redis
    const sessionRecord: StoredSession = {
      u: options.userId,
      h: secretHash,
      abs: absoluteExpiresAt.getTime(),
    };

    await this.redis.setJson(this.sessionKey(jti), sessionRecord, this.refreshTtlSeconds);
    await this.redis.sAdd(this.userSessionsKey(options.userId), jti, this.refreshTtlSeconds);

    // --------------------------------------------------------------------- DB
    const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);
    let sessionId = jti;

    if (options.auditOnly !== true) {
      let replacesId: string | null = null;

      if (options.replacesSessionJti) {
        const replaced = await this.prisma.userSession.findUnique({
          where: { jti: options.replacesSessionJti },
          select: { id: true },
        });
        replacesId = replaced?.id ?? null;
      }

      const session = await this.prisma.userSession.create({
        data: {
          userId: options.userId,
          jti,
          refreshTokenHash: secretHash,
          platform: options.context?.platform ?? 'miniapp',
          deviceId: options.context?.deviceId ?? null,
          ip: options.context?.ip ?? null,
          userAgent: options.context?.userAgent ?? null,
          expiresAt,
          replacedById: replacesId,
        },
        select: { id: true },
      });

      sessionId = session.id;
    }

    // ------------------------------------------------------------- AccessToken
    const payload: AccessTokenPayload = {
      sub: options.userId,
      openid: options.openid,
      realm: 'user',
      ver: options.userVersion,
      jti,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.userSecret,
      expiresIn: this.accessTtl,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      refreshExpiresIn: this.refreshTtlSeconds,
      sessionId,
      jti,
      absoluteExpiresAt,
    };
  }

  // ==========================================================================
  // 旋转与复用检测
  // ==========================================================================

  /**
   * 用 RefreshToken 换取新令牌（旋转）
   *
   * 决策表（对应 API 契约 §3.1.2 的业务规则 1）：
   *   | 会话键 | 已使用标记 | 判定                     | 返回               |
   *   | 存在   | —          | 正常旋转                 | 新令牌             |
   *   | 不存在 | 存在       | **复用攻击**（令牌泄露） | 20005 + 撤销全部会话 |
   *   | 不存在 | 不存在     | 已过期或伪造             | 20004              |
   *
   * 安全要点：会话键存在但 secret 哈希不匹配时，视为伪造（jti 被猜到但 secret 不对），
   *           同样按无效处理且**不**触发全量撤销（避免被恶意构造 jti 引发误伤）。
   */
  async rotateRefreshToken(
    refreshToken: string,
    context?: SessionContext,
  ): Promise<{
    issued: IssuedTokens;
    userId: string;
    openid: string;
    userVersion: number;
    previousJti: string;
  }> {
    const parsed = this.parseRefreshToken(refreshToken);

    if (!parsed) {
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    const { jti, secret } = parsed;
    const stored = await this.redis.getJson<StoredSession>(this.sessionKey(jti));

    if (!stored) {
      const reusedBy = await this.redis.get(this.usedKey(jti));

      if (reusedBy) {
        // 复用检测命中：该令牌已被旋转作废，却再次被使用 —— 判定为令牌泄露
        this.logger.error(`检测到 RefreshToken 复用，已撤销该用户全部会话: userId=${reusedBy} jti=${jti}`);

        await this.revokeAllSessions(reusedBy, 'REFRESH_TOKEN_REUSED');

        throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_REUSED);
      }

      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    // secret 校验：使用恒定时间比较，避免通过响应时间差逐字节推断
    if (!this.crypto.safeEqual(stored.h, this.crypto.sha256(secret))) {
      this.logger.warn(`RefreshToken secret 校验失败（疑似伪造 jti）: jti=${jti}`);
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    // 绝对寿命上限：超过 180 天必须重新登录
    if (stored.abs <= Date.now()) {
      this.logger.warn(`会话超过绝对寿命上限，拒绝续期: userId=${stored.u}`);
      await this.revokeSessionByJti(stored.u, jti, 'ABSOLUTE_LIFETIME_EXCEEDED');
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    // ------------------------------------------------ 查询用户（校验状态与版本）
    const user = await this.prisma.user.findUnique({
      where: { id: stored.u },
      select: {
        id: true,
        status: true,
        version: true,
        deletedAt: true,
        wechatAccounts: {
          where: { deletedAt: null },
          select: { openid: true },
          take: 1,
        },
      },
    });

    if (!user || user.deletedAt !== null) {
      await this.revokeSessionByJti(stored.u, jti, 'USER_NOT_FOUND');
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    // UserStatus 枚举为 ACTIVE | DISABLED | DELETED；「封禁」在数据层对应 DISABLED
    if (user.status === 'DISABLED') {
      await this.revokeAllSessions(user.id, 'ACCOUNT_DISABLED');
      throw BusinessException.forbidden(ErrorCode.ACCOUNT_BANNED);
    }

    if (user.status !== 'ACTIVE') {
      await this.revokeAllSessions(user.id, `ACCOUNT_${user.status}`);
      throw BusinessException.forbidden(ErrorCode.ACCOUNT_BANNED);
    }

    const openid = user.wechatAccounts[0]?.openid;
    if (!openid) {
      this.logger.error(`用户缺少有效的微信账号绑定: userId=${user.id}`);
      throw BusinessException.unauthorized(ErrorCode.WECHAT_SESSION_EXPIRED);
    }

    // ------------------------------------------------------------------ 旋转
    // 先标记旧令牌为「已使用」再签发新令牌：
    // 若顺序颠倒，在极窄的并发窗口内可能出现两条链都有效的情况。
    await this.redis.set(this.usedKey(jti), stored.u, this.refreshTtlSeconds);
    await this.redis.del(this.sessionKey(jti));
    await this.redis.sRem(this.userSessionsKey(stored.u), jti);

    const issued = await this.issueTokens({
      userId: user.id,
      openid,
      userVersion: user.version,
      context,
      replacesSessionJti: jti,
      // 继承链路起点的绝对到期时间，避免「持续刷新永久有效」
      absoluteExpiresAt: new Date(stored.abs),
    });

    return { issued, userId: user.id, openid, userVersion: user.version, previousJti: jti };
  }

  // ==========================================================================
  // 撤销
  // ==========================================================================

  /**
   * 撤销单个会话（按 jti 精确撤销当前设备）
   *
   * 与 `revokeAllSessions` 同样要把 AT 加黑名单：登出的语义是「这个令牌立刻不能用」，
   * 只删会话键会让当前设备的 AccessToken 继续有效到过期。
   */
  async revokeSessionByJti(userId: string, jti: string, reason: string): Promise<boolean> {
    const deleted = await this.redis.del(this.sessionKey(jti));
    await this.redis.sRem(this.userSessionsKey(userId), jti);

    // 留下「已使用」标记，使后续使用该令牌能被识别为复用（而非「不存在」）
    await this.redis.set(this.usedKey(jti), userId, this.refreshTtlSeconds);
    await this.redis.set(this.blacklistKey(jti), '1', this.accessTtlSeconds);

    await this.prisma.userSession.updateMany({
      where: { userId, jti, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });

    return deleted > 0;
  }

  /**
   * 撤销某用户的全部会话（退出全部设备 / 检测到令牌复用 / 封禁）
   *
   * ⚠ 必须**同时把 AccessToken 加入黑名单**：用户端的 AT 与 RT 共用同一个 `jti`，
   * 只删会话键不足以让**已签发的 AT** 失效 —— 它会继续可用到自己的 `exp`
   * （默认 2 小时）。这对下列场景都是真实的安全缺口：
   *   · 退出全部设备：用户以为已经登出，令牌却还能用
   *   · 检测到 RefreshToken 复用：正处应急响应中，攻击者的 AT 仍然有效
   *   · 封禁账号：封禁的意义就是立刻切断访问
   * 黑名单 TTL 取 AT 的配置寿命（宁可多留一会儿，也不放过正在流通的令牌）。
   */
  async revokeAllSessions(userId: string, reason: string): Promise<number> {
    const sessionsKey = this.userSessionsKey(userId);
    const jtis = await this.redis.sMembers(sessionsKey);

    let revoked = 0;

    for (const jti of jtis) {
      const deleted = await this.redis.del(this.sessionKey(jti));
      if (deleted > 0) revoked += 1;
      // 同样留下复用标记，使被盗令牌被再次使用时能被识别
      await this.redis.set(this.usedKey(jti), userId, this.refreshTtlSeconds);
      await this.redis.set(this.blacklistKey(jti), '1', this.accessTtlSeconds);
    }

    await this.redis.del(sessionsKey);

    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });

    return revoked;
  }

  /** 撤销指定 RefreshToken 对应的会话（登出时前端传了 RT 的场景） */
  async revokeSessionByRefreshToken(refreshToken: string, reason: string): Promise<number> {
    const parsed = this.parseRefreshToken(refreshToken);
    if (!parsed) return 0;

    const stored = await this.redis.getJson<StoredSession>(this.sessionKey(parsed.jti));
    if (!stored) {
      // 幂等：已失效的令牌再次登出仍返回成功（revokedSessions: 0）
      return 0;
    }

    const revoked = await this.revokeSessionByJti(stored.u, parsed.jti, reason);
    return revoked ? 1 : 0;
  }

  // ==========================================================================
  // AccessToken 黑名单
  // ==========================================================================

  /**
   * 将 AccessToken 的 jti 加入黑名单
   *
   * AccessToken 是无状态 JWT，无法真正吊销；这里以「黑名单 + 剩余有效期」实现即时失效。
   * TTL 取其剩余有效期，过期后自动清理，不会无限增长。
   *
   * @param expiresAtToken AT 的自然过期时间（epoch 秒）
   */
  async blacklistAccessToken(jti: string, expiresAtToken: number): Promise<void> {
    const ttl = Math.max(1, expiresAtToken - Math.floor(Date.now() / 1000));
    await this.redis.set(this.blacklistKey(jti), '1', ttl);
  }

  /** 校验 AccessToken 是否已被吊销 */
  async isAccessTokenBlacklisted(jti: string): Promise<boolean> {
    return this.redis.exists(this.blacklistKey(jti));
  }

  // ==========================================================================
  // 校验
  // ==========================================================================

  /**
   * 校验 AccessToken 并返回认证主体
   *
   * 由需要「自行校验令牌字符串」的场景调用（如 WebSocket 握手、内部服务调用）。
   * HTTP 请求路径由 JwtStrategy 走 `assertPayloadUsable`，签名校验交给 passport-jwt，
   * 避免同一次请求做两遍签名验证。
   */
  async verifyAccessToken(token: string): Promise<AuthPrincipal> {
    let payload: AccessTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, { secret: this.userSecret });
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (message.includes('expired')) {
        throw BusinessException.unauthorized(ErrorCode.TOKEN_EXPIRED);
      }
      throw BusinessException.unauthorized(ErrorCode.TOKEN_INVALID);
    }

    return this.assertPayloadUsable(payload);
  }

  /**
   * 对**已完成签名校验**的载荷做业务层校验，返回认证主体
   *
   * 集中在此处是为了让「令牌是否可用」只有一份判断逻辑：
   * realm 隔离、必要字段、黑名单 —— 任何新增校验都只需改这一处。
   */
  async assertPayloadUsable(payload: AccessTokenPayload): Promise<AuthPrincipal> {
    if (payload.realm !== 'user') {
      // 管理员令牌（realm=admin）不得用于用户端接口（架构 §9.2 双 realm 隔离）
      throw BusinessException.forbidden(ErrorCode.REALM_MISMATCH);
    }

    if (!payload.sub || !payload.jti) {
      throw BusinessException.unauthorized(ErrorCode.TOKEN_INVALID);
    }

    if (await this.isAccessTokenBlacklisted(payload.jti)) {
      throw BusinessException.unauthorized(ErrorCode.TOKEN_REVOKED);
    }

    return {
      userId: payload.sub,
      realm: 'user',
      roles: [],
      permissions: [],
      jti: payload.jti,
    };
  }

  /**
   * 解析出 AccessToken 的过期时间（epoch 秒）；解析失败返回 0
   *
   * 同步方法：JWT 的 decode 只做 base64 解码，不涉及密码学运算与 I/O。
   */
  getTokenExpiry(token: string): number {
    try {
      const decoded = this.jwtService.decode<{ exp?: number }>(token);
      return decoded?.exp ?? 0;
    } catch {
      return 0;
    }
  }

  // ==========================================================================
  // 内部：键构造与解析
  // ==========================================================================

  private sessionKey(jti: string): string {
    return this.redis.key('rt', 'session', jti);
  }

  private usedKey(jti: string): string {
    return this.redis.key('rt', 'used', jti);
  }

  private userSessionsKey(userId: string): string {
    return this.redis.key('sess', 'user', userId);
  }

  private blacklistKey(jti: string): string {
    return this.redis.key('jwt', 'blacklist', jti);
  }

  /**
   * 解析 RefreshToken 为 jti + secret
   *
   * 严格校验格式，任何不符合 `rt_<uuid>.<secret>` 的输入都返回 null（不抛异常），
   * 由调用方统一映射为「令牌无效」，避免向攻击者暴露格式细节。
   */
  private parseRefreshToken(refreshToken: string): { jti: string; secret: string } | null {
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null;

    const body = refreshToken.slice(REFRESH_TOKEN_PREFIX.length);
    const separatorIndex = body.indexOf(REFRESH_TOKEN_SEPARATOR);

    if (separatorIndex <= 0 || separatorIndex === body.length - 1) return null;

    const jti = body.slice(0, separatorIndex);
    const secret = body.slice(separatorIndex + 1);

    // jti 为 UUID，长度固定 36；secret 至少 16 字符（实际为 43）
    if (jti.length !== 36 || secret.length < 16) return null;

    return { jti, secret };
  }
}

/** 日期加天数 */
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
