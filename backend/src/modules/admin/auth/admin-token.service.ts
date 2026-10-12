/**
 * 管理端令牌服务（realm = admin）
 *
 * 与用户端 `TokenService` **刻意分开**，而不是加一个参数复用，原因有三：
 *
 *   1. **密钥与 audience 不同**（ADR-012 双 realm 隔离）：用户端用 `JWT_SECRET`，
 *      管理端用 `ADMIN_JWT_SECRET`。混在一个类里，任何一次「顺手传错 secret」
 *      都会让管理员令牌能用在小程序接口上，风险与收益完全不成比例。
 *   2. **载荷不同**：管理端令牌要带 `roles` 与 `permissions`（契约 §3.14.1.1 的
 *      示例载荷即为 `{sub, realm, roles, iat, exp}`），用户端没有这两个字段。
 *   3. **失效语义更严**：管理员被禁用或改权限后必须**立刻**失效。
 *      用户端 access token 只看黑名单（旋转后旧 access 仍可用到过期，属正常 JWT 行为），
 *      管理端则额外要求**会话仍然存在** —— 代价是每请求一次 Redis GET，
 *      对管理端这点开销换「禁用即时生效」是值得的。
 *
 * 会话状态存 Redis（不建表）：契约未要求管理端会话落库，且 `admin_audit_logs`
 * 已完整记录登录与操作审计；会话是短生命周期状态，符合 ADR-024。
 * ⚠ 代价是 **Redis 被清空会导致全部管理员被登出**，这是可接受的运维权衡。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { AuthPrincipal } from '../../../common/types/request.type';
import type { AppConfig } from '../../../config/config.type';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { RedisService } from '../../../infra/redis/redis.service';

/** RefreshToken 前缀（契约 §3.14.1.1 的示例即为 `art_` 开头） */
const REFRESH_TOKEN_PREFIX = 'art_';
const REFRESH_TOKEN_SEPARATOR = '.';

/**
 * 管理端会话绝对寿命
 *
 * 比用户端的 180 天短得多：管理端是高权限入口，会话不应无限续期。
 * 到期后必须重新输入账号密码（也顺带保证密码轮换真正生效）。
 */
const ABSOLUTE_SESSION_LIFETIME_DAYS = 30;

/** 管理端访问令牌载荷 */
export interface AdminAccessTokenPayload {
  /** 管理员 ID */
  sub: string;
  realm: 'admin';
  roles: string[];
  permissions: string[];
  /** 会话标识：同时是 Redis 会话键与吊销单位 */
  jti: string;
  iat?: number;
  exp?: number;
}

/** Redis 中的会话记录（字段名压缩以节省内存，含义见注释） */
interface StoredAdminSession {
  /** adminUserId */
  a: string;
  /** refresh secret 的哈希 */
  h: string;
  /** 绝对到期时间（毫秒时间戳） */
  abs: number;
}

/** 会话上下文（审计用） */
export interface AdminSessionContext {
  ip?: string;
  userAgent?: string;
}

/** 签发结果 */
export interface IssuedAdminTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  jti: string;
  absoluteExpiresAt: Date;
}

@Injectable()
export class AdminTokenService {
  private readonly logger = new Logger(AdminTokenService.name);
  private readonly adminSecret: string;
  private readonly accessTtl: string;
  private readonly refreshTtl: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    configService: ConfigService<AppConfig, true>,
  ) {
    // 管理端密钥与用户端密钥由配置层强校验为**不同值**（validation.schema.ts）
    this.adminSecret = configService.get('jwt.adminSecret', { infer: true });
    this.accessTtl = configService.get('jwt.adminAccessTtl', { infer: true });
    this.refreshTtl = configService.get('jwt.adminRefreshTtl', { infer: true });
    this.accessTtlSeconds = this.crypto.getRefreshTokenTtlSeconds(this.accessTtl);
    this.refreshTtlSeconds = this.crypto.getRefreshTokenTtlSeconds(this.refreshTtl);
  }

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
   * 签发一组管理员令牌并建立会话
   *
   * @param options.replacesSessionJti 旋转场景下被替换的会话（旧会话在此期间仍有效，
   *                                   直到 `rotateRefreshToken` 删除它，避免旋转失败时把用户踢下线）
   */
  async issueTokens(options: {
    adminUserId: string;
    roles: string[];
    permissions: string[];
    context?: AdminSessionContext;
    replacesSessionJti?: string;
    absoluteExpiresAt?: Date;
  }): Promise<IssuedAdminTokens> {
    const jti = uuidv4();
    const secret = this.crypto.randomToken();
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${jti}${REFRESH_TOKEN_SEPARATOR}${secret}`;
    const secretHash = this.crypto.sha256(secret);

    const absoluteExpiresAt = options.absoluteExpiresAt ?? addDays(new Date(), ABSOLUTE_SESSION_LIFETIME_DAYS);

    const record: StoredAdminSession = {
      a: options.adminUserId,
      h: secretHash,
      abs: absoluteExpiresAt.getTime(),
    };

    await this.redis.setJson(this.sessionKey(jti), record, this.refreshTtlSeconds);
    await this.redis.sAdd(this.adminSessionsKey(options.adminUserId), jti, this.refreshTtlSeconds);

    const payload: AdminAccessTokenPayload = {
      sub: options.adminUserId,
      realm: 'admin',
      roles: options.roles,
      permissions: options.permissions,
      jti,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.adminSecret,
      expiresIn: this.accessTtl,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      refreshExpiresIn: this.refreshTtlSeconds,
      sessionId: jti,
      jti,
      absoluteExpiresAt,
    };
  }

  // ==========================================================================
  // 旋转与复用检测
  // ==========================================================================

  /**
   * 用管理员 RefreshToken 换取新令牌（旋转 + 复用检测）
   *
   * 决策表与用户端一致（契约 §3.1.2 业务规则 1，管理端 §3.14.1.2 复用同一机制）：
   *   | 会话键 | 已使用标记 | 判定                     | 返回                  |
   *   | 存在   | —          | 正常旋转                 | 新令牌                |
   *   | 不存在 | 存在       | **复用攻击**（令牌泄露） | 20005 + 撤销该管理员全部会话 |
   *   | 不存在 | 不存在     | 已过期或伪造             | 20004                 |
   *
   * 会话存在但 secret 哈希不匹配 → 视为伪造，**不**触发全量撤销
   * （否则猜到 jti 就能把管理员踢下线）。
   *
   * @param resolved 由调用方**重新查询**的角色与权限：旋转是刷新权限的天然时机，
   *                 若沿用旧令牌里的权限，管理员被降权后在会话有效期内仍持旧权限。
   *                 本服务不查库，保持「只负责令牌」的单一职责。
   */
  async rotateRefreshToken(
    refreshToken: string,
    resolved: { roles: string[]; permissions: string[] },
    context?: AdminSessionContext,
  ): Promise<{ issued: IssuedAdminTokens; adminUserId: string; previousJti: string }> {
    const parsed = this.parseRefreshToken(refreshToken);

    if (!parsed) {
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    const stored = await this.redis.getJson<StoredAdminSession>(this.sessionKey(parsed.jti));

    if (!stored) {
      const reusedBy = await this.redis.get(this.usedKey(parsed.jti));

      if (reusedBy) {
        // 令牌已被使用过又出现 —— 典型的泄露信号，撤销该管理员全部会话
        const revoked = await this.revokeAllSessions(reusedBy, 'refresh_token_reused');
        this.logger.warn(
          `管理端 RefreshToken 复用检测命中 adminUserId=${reusedBy} revokedSessions=${revoked} ip=${context?.ip ?? '-'}`,
        );
        throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_REUSED);
      }

      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    if (!this.crypto.safeEqual(stored.h, this.crypto.sha256(parsed.secret))) {
      this.logger.warn(`管理端 RefreshToken secret 校验失败（疑似伪造）jti=${parsed.jti}`);
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    const absoluteExpiresAt = new Date(stored.abs);

    if (absoluteExpiresAt.getTime() <= Date.now()) {
      // 绝对寿命到期：即使 refresh 未过期也必须重新登录
      await this.redis.del(this.sessionKey(parsed.jti));
      await this.redis.sRem(this.adminSessionsKey(stored.a), parsed.jti);
      throw BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID);
    }

    // 标记旧会话已使用并删除（旋转完成，旧 RT 立即失效）
    await this.redis.set(this.usedKey(parsed.jti), stored.a, this.refreshTtlSeconds);
    await this.redis.del(this.sessionKey(parsed.jti));
    await this.redis.sRem(this.adminSessionsKey(stored.a), parsed.jti);

    /**
     * 权限在**旋转时重取**（由调用方传入）：管理员改权限后，最长 1 小时（access TTL）
     * 内旧令牌仍带旧权限，但旋转会立刻带上新权限；若要即时生效，改权限时调用
     * `revokeAllSessions` 把现有会话全部撤销。
     */
    const issued = await this.issueTokens({
      adminUserId: stored.a,
      roles: resolved.roles,
      permissions: resolved.permissions,
      context,
      replacesSessionJti: parsed.jti,
      absoluteExpiresAt,
    });

    return { issued, adminUserId: stored.a, previousJti: parsed.jti };
  }

  // ==========================================================================
  // 校验
  // ==========================================================================

  /**
   * 校验管理员访问令牌并返回认证主体
   *
   * 除签名（由 AdminJwtStrategy 完成）外还检查：
   *   · realm 必须为 `admin`
   *   · 必须不在黑名单
   *   · **会话必须仍然存在**（禁用管理员 / 改权限时会主动撤销会话，实现即时生效）
   */
  async assertPayloadUsable(payload: AdminAccessTokenPayload): Promise<AuthPrincipal> {
    if (payload.realm !== 'admin') {
      // 用户令牌不得用于管理端接口（架构 §9.2 双 realm 隔离）
      throw BusinessException.forbidden(ErrorCode.REALM_MISMATCH, '登录凭证与当前端不匹配');
    }

    if (!payload.sub || !payload.jti) {
      throw BusinessException.unauthorized(ErrorCode.TOKEN_INVALID);
    }

    if (await this.isAccessTokenBlacklisted(payload.jti)) {
      throw BusinessException.unauthorized(ErrorCode.TOKEN_REVOKED);
    }

    const session = await this.redis.getJson<StoredAdminSession>(this.sessionKey(payload.jti));

    if (!session) {
      // 会话被撤销（登出 / 禁用 / 权限变更 / Redis 被清空）
      throw BusinessException.unauthorized(ErrorCode.TOKEN_REVOKED);
    }

    return {
      userId: payload.sub,
      realm: 'admin',
      roles: payload.roles ?? [],
      permissions: payload.permissions ?? [],
      jti: payload.jti,
    };
  }

  /** 验证并解析访问令牌（供需要直接读 token 的场景使用，如 `GET /admin/auth/me` 前的兜底） */
  async verifyAccessToken(token: string): Promise<AuthPrincipal> {
    let payload: AdminAccessTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<AdminAccessTokenPayload>(token, { secret: this.adminSecret });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TokenExpiredError') {
        throw BusinessException.unauthorized(ErrorCode.TOKEN_EXPIRED);
      }
      throw BusinessException.unauthorized(ErrorCode.TOKEN_INVALID);
    }

    return this.assertPayloadUsable(payload);
  }

  // ==========================================================================
  // 撤销
  // ==========================================================================

  /** 撤销指定会话（登出当前设备） */
  async revokeSessionByJti(adminUserId: string, jti: string, reason: string): Promise<boolean> {
    const deleted = await this.redis.del(this.sessionKey(jti));
    await this.redis.sRem(this.adminSessionsKey(adminUserId), jti);
    await this.redis.set(this.usedKey(jti), adminUserId, this.refreshTtlSeconds);

    if (deleted > 0) {
      this.logger.log(`管理端会话已撤销 adminUserId=${adminUserId} jti=${jti} reason=${reason}`);
      return true;
    }

    return false;
  }

  /**
   * 撤销某管理员的全部会话
   *
   * 用于：登出全部设备、账号被禁用、角色/权限变更、RefreshToken 复用检测命中。
   * 因为校验时会话必须存在，所以这里删掉会话就等于**立刻**让该管理员的所有 access token 失效。
   */
  async revokeAllSessions(adminUserId: string, reason: string): Promise<number> {
    const sessionsKey = this.adminSessionsKey(adminUserId);
    const jtis = await this.redis.sMembers(sessionsKey);

    let revoked = 0;
    for (const jti of jtis) {
      const deleted = await this.redis.del(this.sessionKey(jti));
      if (deleted > 0) revoked += 1;
      await this.redis.set(this.usedKey(jti), adminUserId, this.refreshTtlSeconds);
    }

    await this.redis.del(sessionsKey);

    if (revoked > 0) {
      this.logger.log(`管理端全部会话已撤销 adminUserId=${adminUserId} count=${revoked} reason=${reason}`);
    }

    return revoked;
  }

  /** 按 RefreshToken 反查并撤销会话（用于「登出」传 RT 的场景） */
  async revokeSessionByRefreshToken(refreshToken: string, reason: string): Promise<number> {
    const parsed = this.parseRefreshToken(refreshToken);
    if (!parsed) return 0;

    const stored = await this.redis.getJson<StoredAdminSession>(this.sessionKey(parsed.jti));
    if (!stored) return 0;

    const revoked = await this.revokeSessionByJti(stored.a, parsed.jti, reason);
    return revoked ? 1 : 0;
  }

  /**
   * 把 access token 加入黑名单（登出时立即失效，不必等 TTL 到期）
   *
   * TTL 取 access token 的**配置寿命**而非解析出的 `exp`：
   * 解析 JWT 需要 `decode`（返回 `any`，会绕过类型检查）或多做一次签名校验，
   * 而黑名单键多存活一会儿没有任何安全代价 —— 它只是防止**未过期**令牌继续使用。
   */
  async blacklistAccessToken(jti: string): Promise<void> {
    await this.redis.set(this.blacklistKey(jti), '1', this.accessTtlSeconds);
  }

  async isAccessTokenBlacklisted(jti: string): Promise<boolean> {
    return this.redis.exists(this.blacklistKey(jti));
  }

  /** 解析 RefreshToken（格式 `art_{jti}.{secret}`） */
  parseRefreshToken(refreshToken: string): { jti: string; secret: string } | null {
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null;

    const body = refreshToken.slice(REFRESH_TOKEN_PREFIX.length);
    const separatorIndex = body.indexOf(REFRESH_TOKEN_SEPARATOR);

    if (separatorIndex <= 0) return null;

    return {
      jti: body.slice(0, separatorIndex),
      secret: body.slice(separatorIndex + 1),
    };
  }

  // ==========================================================================
  // Redis 键
  // ==========================================================================

  private sessionKey(jti: string): string {
    return this.redis.key('admin', 'session', jti);
  }

  private usedKey(jti: string): string {
    return this.redis.key('admin', 'used', jti);
  }

  private adminSessionsKey(adminUserId: string): string {
    return this.redis.key('admin', 'sessions', adminUserId);
  }

  private blacklistKey(jti: string): string {
    return this.redis.key('admin', 'blacklist', jti);
  }
}

/** 本地日期工具：与用户端 TokenService 保持同样做法，不为此引入日期库依赖 */
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
