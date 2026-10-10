/**
 * 会话与令牌服务测试
 *
 * 这是本项目安全等级最高的一段逻辑（令牌泄露防护），因此测试聚焦「攻击场景」而非仅正常路径：
 *   · RT 旋转后旧令牌必须立即失效
 *   · 已旋转作废的 RT 被再次使用 → 判定泄露 → 撤销该用户**全部**会话
 *   · jti 猜到但 secret 不对 → 只按无效处理，**不**触发全量撤销（否则可被恶意构造 jti 打掉他人会话）
 *   · 会话绝对寿命（180 天）到期必须重新登录，杜绝「持续刷新永久有效」
 *   · AccessToken 黑名单使其登出后立即失效
 *   · 双 realm 隔离：管理员令牌不能用于用户端接口
 *
 * 依赖处理：CryptoService 与 JwtService 使用**真实实现**（它们无 I/O 且有独立单测），
 *          仅把 Redis 与 Prisma 替换为可控替身 —— 这样测的是真实密码学与真实 JWT 行为。
 */

import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import { TokenService, type AccessTokenPayload } from './token.service';
// ============================================================================
// 测试替身
// ============================================================================

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
const USER_SECRET = 'unit_test_user_secret_at_least_32_characters_long';

/** 内存版 Redis 替身：实现 TokenService 实际用到的方法，行为与真实语义一致 */
class FakeRedis {
  readonly store = new Map<string, string>();

  key(...parts: (string | number)[]): string {
    return ['sm', ...parts].join(':');
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ttlSeconds = 0): Promise<void> {
    void ttlSeconds;
    this.store.set(key, value);
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    void ttlSeconds;
    this.store.set(key, JSON.stringify(value));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      // 与真实 Redis 语义一致：DEL 不区分键类型，字符串键与集合键都会被删除。
      // （若这里只删字符串键，会掩盖 revokeAllSessions 清理索引集合的行为。）
      if (this.store.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
    }
    return deleted;
  }

  private readonly sets = new Map<string, Set<string>>();

  async sAdd(key: string, member: string, ttlSeconds = 0): Promise<number> {
    void ttlSeconds;
    const set = this.sets.get(key) ?? new Set<string>();
    const had = set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return had ? 0 : 1;
  }

  async sRem(key: string, member: string): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  /** 测试辅助：模拟某个会话键自然过期（TTL 到点） */
  expireKey(key: string): void {
    this.store.delete(key);
  }
}

interface PrismaStub {
  user: { findUnique: jest.Mock };
  userSession: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  user: { findUnique: jest.fn() },
  userSession: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
});

// ============================================================================
// 夹具
// ============================================================================

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OPENID = 'oQ7Xk5aBcDeFgHiJkLmNoPqRsTu';

describe('TokenService', () => {
  let redis: FakeRedis;
  let prisma: PrismaStub;
  let crypto: CryptoService;
  let service: TokenService;

  const configService = {
    get: (path: string) => {
      if (path === 'crypto.key') return TEST_KEY;
      if (path === 'crypto.ivSalt') return 'test_salt';
      if (path === 'jwt.userSecret') return USER_SECRET;
      if (path === 'jwt.userAccessTtl') return '2h';
      if (path === 'jwt.userRefreshTtl') return '30d';
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;

  /** 默认用户：正常状态 */
  const activeUser = {
    id: USER_ID,
    status: 'ACTIVE',
    version: 3,
    deletedAt: null,
    wechatAccounts: [{ openid: OPENID }],
  };

  beforeEach(() => {
    redis = new FakeRedis();
    prisma = createPrismaStub();
    crypto = new CryptoService(configService);

    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.userSession.create.mockResolvedValue({ id: '0195f3a2-6b3d-7a20-8f4c-1e2d3c4b5a90' });
    prisma.userSession.findUnique.mockResolvedValue(null);
    prisma.userSession.updateMany.mockResolvedValue({ count: 1 });

    service = new TokenService(
      new JwtService({}),
      redis as unknown as RedisService,
      crypto,
      prisma as unknown as PrismaService,
      configService,
    );
  });

  const issue = async (): Promise<Awaited<ReturnType<TokenService['issueTokens']>>> =>
    service.issueTokens({ userId: USER_ID, openid: OPENID, userVersion: 3, context: { deviceId: 'device-01' } });

  // ==========================================================================
  // 签发
  // ==========================================================================

  describe('issueTokens', () => {
    it('签发的 RefreshToken 形如 rt_<jti>.<secret>，jti 为 UUID', async () => {
      const issued = await issue();
      const [jti, secret] = issued.refreshToken.replace('rt_', '').split('.');

      expect(issued.refreshToken.startsWith('rt_')).toBe(true);
      expect(jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(secret?.length).toBeGreaterThanOrEqual(42);
      expect(issued.jti).toBe(jti);
    });

    it('Redis 中只保存 secret 的哈希，不保存 secret 本身', async () => {
      const issued = await issue();
      const secret = issued.refreshToken.replace('rt_', '').split('.')[1] ?? '';

      const raw = redis.store.get(redis.key('rt', 'session', issued.jti)) ?? '';

      expect(raw).not.toContain(secret);
      expect(raw).toContain(crypto.sha256(secret));
    });

    it('同时写入 user_sessions 审计表与用户会话索引', async () => {
      const issued = await issue();

      expect(prisma.userSession.create).toHaveBeenCalledTimes(1);
      expect(await redis.sMembers(redis.key('sess', 'user', USER_ID))).toContain(issued.jti);
    });

    it('AccessToken 载荷符合契约（sub / openid / realm / ver / jti）', async () => {
      const issued = await issue();
      const payload = new JwtService({}).decode<AccessTokenPayload>(issued.accessToken);

      expect(payload.sub).toBe(USER_ID);
      expect(payload.openid).toBe(OPENID);
      expect(payload.realm).toBe('user');
      expect(payload.ver).toBe(3);
      expect(payload.jti).toBe(issued.jti);
      // 契约固定 7200 秒
      expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(7200);
    });

    it('TTL 常量与契约一致（AT 2h / RT 30d）', () => {
      expect(service.accessTokenTtlSeconds).toBe(7200);
      expect(service.refreshTokenTtlSeconds).toBe(2_592_000);
    });

    it('会话绝对到期时间为 180 天后', async () => {
      const issued = await issue();
      const days = Math.round((issued.absoluteExpiresAt.getTime() - Date.now()) / 86_400_000);

      expect(days).toBe(180);
    });
  });

  // ==========================================================================
  // 旋转
  // ==========================================================================

  describe('rotateRefreshToken — 正常旋转', () => {
    it('返回新的 AT + 新的 RT，且新旧令牌不同', async () => {
      const first = await issue();
      const result = await service.rotateRefreshToken(first.refreshToken);

      expect(result.issued.accessToken).not.toBe(first.accessToken);
      expect(result.issued.refreshToken).not.toBe(first.refreshToken);
      expect(result.userId).toBe(USER_ID);
      expect(result.previousJti).toBe(first.jti);
    });

    it('旧 RT 立即失效（旧会话键被删除，且留下已使用标记）', async () => {
      const first = await issue();
      await service.rotateRefreshToken(first.refreshToken);

      expect(await redis.get(redis.key('rt', 'session', first.jti))).toBeNull();
      expect(await redis.get(redis.key('rt', 'used', first.jti))).toBe(USER_ID);
    });

    it('新 RT 可用且能继续旋转（链式）', async () => {
      const first = await issue();
      const second = await service.rotateRefreshToken(first.refreshToken);
      const third = await service.rotateRefreshToken(second.issued.refreshToken);

      expect(third.issued.refreshToken).not.toBe(second.issued.refreshToken);
      expect(third.previousJti).toBe(second.issued.jti);
    });

    it('旋转继承会话绝对寿命，不会因持续刷新而延长', async () => {
      const first = await issue();
      const second = await service.rotateRefreshToken(first.refreshToken);

      expect(second.issued.absoluteExpiresAt.getTime()).toBe(first.absoluteExpiresAt.getTime());
    });

    it('旋转时新会话记录关联被替换的会话（审计链路）', async () => {
      const first = await issue();
      prisma.userSession.findUnique.mockResolvedValueOnce({ id: 'session-row-of-first' });

      await service.rotateRefreshToken(first.refreshToken);

      expect(prisma.userSession.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ replacedById: 'session-row-of-first' }),
        }),
      );
    });

    it('登出后用户会话索引被清理', async () => {
      const first = await issue();
      const second = await service.rotateRefreshToken(first.refreshToken);

      const members = await redis.sMembers(redis.key('sess', 'user', USER_ID));

      expect(members).not.toContain(first.jti);
      expect(members).toContain(second.issued.jti);
    });
  });

  describe('rotateRefreshToken — 攻击与异常场景', () => {
    it('格式不合法的 RT → REFRESH_TOKEN_INVALID', async () => {
      await expect(service.rotateRefreshToken('not-a-token')).rejects.toMatchObject({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
      });
    });

    it.each([
      ['缺少前缀', `${uuidv4()}.secretsecretsecretsecret`],
      ['缺少 secret', `rt_${uuidv4()}.`],
      ['缺少 jti', 'rt_.secretsecretsecretsecret'],
      ['secret 过短', `rt_${uuidv4()}.short`],
      ['jti 非 UUID', 'rt_notauuidatall.secretsecretsecretsecret'],
    ])('非法格式「%s」被拒绝且不触发全量撤销', async (_label, token) => {
      await expect(service.rotateRefreshToken(token)).rejects.toMatchObject({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
      });

      expect(prisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('【核心安全】已旋转作废的 RT 再次使用 → 复用检测命中，撤销全部会话', async () => {
      const first = await issue();
      await service.rotateRefreshToken(first.refreshToken);

      prisma.userSession.updateMany.mockClear();

      // 攻击者拿着泄露的旧 RT 再次请求
      await expect(service.rotateRefreshToken(first.refreshToken)).rejects.toMatchObject({
        code: ErrorCode.REFRESH_TOKEN_REUSED,
      });

      // 必须触发全量撤销（该用户所有设备下线）
      expect(prisma.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, revokedAt: null },
          data: expect.objectContaining({ revokedReason: 'REFRESH_TOKEN_REUSED' }),
        }),
      );
    });

    it('【核心安全】jti 正确但 secret 错误 → 仅按无效处理，不触发全量撤销', async () => {
      const first = await issue();
      const jti = first.jti;

      prisma.userSession.updateMany.mockClear();

      // 攻击者猜到 jti 但不知道 secret（否则可恶意打掉任意用户的全部会话）
      await expect(service.rotateRefreshToken(`rt_${jti}.wrongsecretwrongsecretwrongsecret`)).rejects.toMatchObject({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
      });

      expect(prisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('会话键自然过期（超 30 天）→ REFRESH_TOKEN_INVALID，且不误判为复用', async () => {
      const first = await issue();

      // 模拟 Redis 键自然过期（未留下 used 标记）
      redis.expireKey(redis.key('rt', 'session', first.jti));

      await expect(service.rotateRefreshToken(first.refreshToken)).rejects.toMatchObject({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
      });
    });

    it('超过会话绝对寿命（180 天）→ 拒绝续期并撤销该会话', async () => {
      const issued = await service.issueTokens({
        userId: USER_ID,
        openid: OPENID,
        userVersion: 3,
        // 构造一个已经到期的绝对寿命
        absoluteExpiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.rotateRefreshToken(issued.refreshToken)).rejects.toMatchObject({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
      });

      expect(prisma.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revokedReason: 'ABSOLUTE_LIFETIME_EXCEEDED' }),
        }),
      );
    });

    it('用户已被限制（DISABLED）→ ACCOUNT_BANNED 并撤销全部会话', async () => {
      const first = await issue();
      prisma.user.findUnique.mockResolvedValueOnce({ ...activeUser, status: 'DISABLED' });

      await expect(service.rotateRefreshToken(first.refreshToken)).rejects.toMatchObject({
        code: ErrorCode.ACCOUNT_BANNED,
      });

      expect(prisma.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ revokedReason: 'ACCOUNT_DISABLED' }) }),
      );
    });

    it('用户已被删除 → REFRESH_TOKEN_INVALID（不泄露账号状态）', async () => {
      const first = await issue();
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(service.rotateRefreshToken(first.refreshToken)).rejects.toMatchObject({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
      });
    });

    it('用户缺少有效微信绑定 → 拒绝续期', async () => {
      const first = await issue();
      prisma.user.findUnique.mockResolvedValueOnce({ ...activeUser, wechatAccounts: [] });

      await expect(service.rotateRefreshToken(first.refreshToken)).rejects.toMatchObject({
        code: ErrorCode.WECHAT_SESSION_EXPIRED,
      });
    });
  });

  // ==========================================================================
  // 撤销与黑名单
  // ==========================================================================

  describe('撤销', () => {
    it('revokeSessionByJti 清除会话键并写审计', async () => {
      const issued = await issue();
      const revoked = await service.revokeSessionByJti(USER_ID, issued.jti, 'USER_LOGOUT');

      expect(revoked).toBe(true);
      expect(await redis.get(redis.key('rt', 'session', issued.jti))).toBeNull();
      expect(prisma.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, jti: issued.jti, revokedAt: null },
          data: expect.objectContaining({ revokedReason: 'USER_LOGOUT' }),
        }),
      );
    });

    it('revokeAllSessions 撤销该用户全部会话并清理索引', async () => {
      const first = await service.issueTokens({ userId: USER_ID, openid: OPENID, userVersion: 3 });
      const second = await service.issueTokens({ userId: USER_ID, openid: OPENID, userVersion: 3 });

      const count = await service.revokeAllSessions(USER_ID, 'USER_LOGOUT_ALL');

      expect(count).toBe(2);
      expect(await redis.get(redis.key('rt', 'session', first.jti))).toBeNull();
      expect(await redis.get(redis.key('rt', 'session', second.jti))).toBeNull();
      expect(await redis.sMembers(redis.key('sess', 'user', USER_ID))).toEqual([]);
    });

    it('revokeSessionByRefreshToken 对已失效令牌幂等返回 0', async () => {
      const count = await service.revokeSessionByRefreshToken(
        `rt_${uuidv4()}.nonexistentsecretnonexistentsecret`,
        'USER_LOGOUT',
      );

      expect(count).toBe(0);
    });

    it('revokeSessionByRefreshToken 对格式非法的输入返回 0（不抛异常，保证登出幂等）', async () => {
      expect(await service.revokeSessionByRefreshToken('garbage', 'USER_LOGOUT')).toBe(0);
    });
  });

  describe('AccessToken 黑名单', () => {
    it('加入黑名单后可被检出（登出后立即失效）', async () => {
      const jti = uuidv4();

      expect(await service.isAccessTokenBlacklisted(jti)).toBe(false);

      await service.blacklistAccessToken(jti, Math.floor(Date.now() / 1000) + 7200);

      expect(await service.isAccessTokenBlacklisted(jti)).toBe(true);
    });

    it('黑名单键的 TTL 不超过令牌剩余有效期（不会无限增长）', async () => {
      const jti = uuidv4();
      const expiresAt = Math.floor(Date.now() / 1000) + 100;

      const setSpy = jest.spyOn(redis, 'set');
      await service.blacklistAccessToken(jti, expiresAt);

      const ttl = setSpy.mock.calls[0]?.[2];
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(100);
    });

    it('已过期的令牌传入时 TTL 至少为 1（避免写入永久键）', async () => {
      const setSpy = jest.spyOn(redis, 'set');
      await service.blacklistAccessToken(uuidv4(), Math.floor(Date.now() / 1000) - 9999);

      expect(setSpy.mock.calls[0]?.[2]).toBe(1);
    });
  });

  // ==========================================================================
  // 令牌校验
  // ==========================================================================

  describe('verifyAccessToken / assertPayloadUsable', () => {
    it('合法令牌返回认证主体', async () => {
      const issued = await issue();
      const principal = await service.verifyAccessToken(issued.accessToken);

      expect(principal).toEqual({
        userId: USER_ID,
        realm: 'user',
        roles: [],
        permissions: [],
        jti: issued.jti,
      });
    });

    it('签名被篡改 → TOKEN_INVALID', async () => {
      const issued = await issue();
      const tampered = `${issued.accessToken.slice(0, -3)}xyz`;

      await expect(service.verifyAccessToken(tampered)).rejects.toMatchObject({
        code: ErrorCode.TOKEN_INVALID,
      });
    });

    it('已过期令牌 → TOKEN_EXPIRED', async () => {
      const expired = await new JwtService({}).signAsync(
        { sub: USER_ID, openid: OPENID, realm: 'user', ver: 1, jti: uuidv4() },
        { secret: USER_SECRET, expiresIn: '-1s' },
      );

      await expect(service.verifyAccessToken(expired)).rejects.toMatchObject({
        code: ErrorCode.TOKEN_EXPIRED,
      });
    });

    it('【双 realm 隔离】管理员令牌不能调用用户端接口', async () => {
      const adminToken = await new JwtService({}).signAsync(
        // 即便用用户端密钥签名，realm 不为 user 也必须拒绝
        { sub: 'admin-1', realm: 'admin', roles: ['SUPER_ADMIN'], jti: uuidv4() },
        { secret: USER_SECRET, expiresIn: '1h' },
      );

      await expect(service.verifyAccessToken(adminToken)).rejects.toMatchObject({
        code: ErrorCode.REALM_MISMATCH,
      });
    });

    it('已登出（黑名单命中）的令牌 → TOKEN_REVOKED', async () => {
      const issued = await issue();
      await service.blacklistAccessToken(issued.jti, Math.floor(Date.now() / 1000) + 7200);

      await expect(service.verifyAccessToken(issued.accessToken)).rejects.toMatchObject({
        code: ErrorCode.TOKEN_REVOKED,
      });
    });

    it('缺少 sub 或 jti 的令牌 → TOKEN_INVALID', async () => {
      const noJti = await new JwtService({}).signAsync(
        { sub: USER_ID, openid: OPENID, realm: 'user', ver: 1 },
        { secret: USER_SECRET, expiresIn: '1h' },
      );

      await expect(service.verifyAccessToken(noJti)).rejects.toMatchObject({
        code: ErrorCode.TOKEN_INVALID,
      });
    });

    it('verifyAccessToken 抛出的都是 BusinessException（可被全局过滤器正确转换）', async () => {
      await expect(service.verifyAccessToken('garbage')).rejects.toBeInstanceOf(BusinessException);
    });
  });
});
