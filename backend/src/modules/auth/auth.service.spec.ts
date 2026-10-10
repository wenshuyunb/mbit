/**
 * 认证服务测试
 *
 * 聚焦契约中列出的「业务规则与边界条件」，尤其是**安全与合规**相关的分支：
 *   · 规则 1：session_key 必须加密落库，且绝不出现在响应中
 *   · 规则 3：注销冷静期账号不签发令牌
 *   · 规则 4：已注销账号（openid 已匿名化）再登录会创建全新用户
 *   · 规则 7：多设备互不影响，logout-all 才全量撤销
 *   · 规则 8：调用微信失败时**不写库**（避免僵尸账号）
 *   · 年龄声明 < 18 岁置 ageVerified=false（架构 §14.3 未成年人保护）
 *   · 登出幂等：对已失效 RT 调用仍返回成功
 */

import type { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AuthPrincipal } from '../../common/types/request.type';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { Code2SessionResult, WechatService } from '../../infra/wechat/wechat.service';
import { AuthService } from './auth.service';
import type { IssuedTokens, TokenService } from './token.service';

// ============================================================================
// 常量与夹具
// ============================================================================

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OPENID = 'oQ7Xk5aBcDeFgHiJkLmNoPqRsTu';
const SESSION_KEY = 'wx_session_key_plaintext_should_never_leak';

/** 微信 code2session 的固定返回值 */
const wxSession: Code2SessionResult = {
  openid: OPENID,
  unionid: 'uQ7Xk5unionidExample0000000000',
  sessionKey: SESSION_KEY,
  expiresInSeconds: 2_592_000,
};

const issuedTokens: IssuedTokens = {
  accessToken: 'header.payload.signature',
  refreshToken: `rt_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.secretsecretsecretsecretsecret`,
  expiresIn: 7200,
  refreshExpiresIn: 2_592_000,
  sessionId: '0195f3a2-6b3d-7a20-8f4c-1e2d3c4b5a90',
  jti: '0195f3a2-6b3d-7a20-8f4c-1e2d3c4b5a90',
  absoluteExpiresAt: new Date(Date.now() + 180 * 86_400_000),
};

/**
 * user.findUnique 的返回夹具
 *
 * 注意：必须包含 `deletedAt`（可空）与 `version`，否则生产代码里的
 * `user.deletedAt !== null` 会因 `undefined !== null` 为真而误判为「已删除用户」——
 * 夹具字段缺失会让测试以错误的方式失败（或更糟：以错误的方式通过）。
 */
const userRow = {
  id: USER_ID,
  nickname: '小满',
  avatarUrl: null,
  gender: 'UNKNOWN',
  birthday: null,
  phoneHash: null,
  status: 'ACTIVE',
  version: 3,
  ageVerified: true,
  deletedAt: null,
  createdAt: new Date('2026-02-14T10:00:00.000Z'),
};

const principal: AuthPrincipal = {
  userId: USER_ID,
  realm: 'user',
  roles: [],
  permissions: [],
  jti: issuedTokens.jti,
};

// ============================================================================
// 替身
// ============================================================================

interface PrismaStub {
  wechatAccount: { findUnique: jest.Mock; updateMany: jest.Mock; create: jest.Mock };
  user: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
  userDeletionRequest: { findFirst: jest.Mock };
  personalityProfile: { findFirst: jest.Mock };
  membership: { findFirst: jest.Mock };
  relationshipInvite: { findUnique: jest.Mock };
  userSession: { findUnique: jest.Mock };
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub: PrismaStub = {
    wechatAccount: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    userDeletionRequest: { findFirst: jest.fn().mockResolvedValue(null) },
    personalityProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: { findFirst: jest.fn().mockResolvedValue(null) },
    relationshipInvite: { findUnique: jest.fn().mockResolvedValue(null) },
    userSession: { findUnique: jest.fn().mockResolvedValue(null) },
    // 事务替身：直接把同一个 stub 作为 tx 传入，保证断言可以观察到事务内的写操作
    $transaction: jest.fn(async (callback: (tx: PrismaStub) => Promise<unknown>) => callback(stub)),
  };

  return stub;
};

const createTokenStub = (): {
  issueTokens: jest.Mock;
  rotateRefreshToken: jest.Mock;
  revokeAllSessions: jest.Mock;
  revokeSessionByJti: jest.Mock;
  revokeSessionByRefreshToken: jest.Mock;
  blacklistAccessToken: jest.Mock;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
} => ({
  issueTokens: jest.fn().mockResolvedValue(issuedTokens),
  rotateRefreshToken: jest.fn(),
  revokeAllSessions: jest.fn().mockResolvedValue(2),
  revokeSessionByJti: jest.fn().mockResolvedValue(true),
  revokeSessionByRefreshToken: jest.fn().mockResolvedValue(1),
  blacklistAccessToken: jest.fn().mockResolvedValue(undefined),
  accessTokenTtlSeconds: 7200,
  refreshTokenTtlSeconds: 2_592_000,
});

const configService = {
  get: (path: string) => {
    if (path === 'crypto.key') return TEST_KEY;
    if (path === 'crypto.ivSalt') return 'test_salt';
    if (path === 'wechat.appId') return 'wxTestAppId0001';
    return undefined;
  },
} as unknown as ConfigService<AppConfig, true>;

// ============================================================================
// 测试
// ============================================================================

describe('AuthService', () => {
  let prisma: PrismaStub;
  let tokens: ReturnType<typeof createTokenStub>;
  let wechat: { code2Session: jest.Mock; isConfigured: jest.Mock };
  let crypto: CryptoService;
  let service: AuthService;

  beforeEach(() => {
    prisma = createPrismaStub();
    tokens = createTokenStub();
    wechat = { code2Session: jest.fn().mockResolvedValue(wxSession), isConfigured: jest.fn().mockReturnValue(true) };
    crypto = new CryptoService(configService);

    prisma.user.findUnique.mockResolvedValue(userRow);
    prisma.wechatAccount.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue(userRow);
    prisma.user.create.mockResolvedValue({ id: USER_ID, status: 'ACTIVE', version: 0 });
    prisma.wechatAccount.create.mockResolvedValue({ id: 'wa-1' });

    service = new AuthService(
      prisma as unknown as PrismaService,
      wechat as unknown as WechatService,
      crypto,
      tokens as unknown as TokenService,
      configService,
    );
  });

  // ==========================================================================
  // 登录 — 新用户
  // ==========================================================================

  describe('wechatLogin — 新用户', () => {
    beforeEach(() => {
      // 无既有微信账号 → 走注册分支
      prisma.wechatAccount.findUnique.mockResolvedValue(null);
    });

    it('在事务中创建 User 与 WechatAccount', async () => {
      await service.wechatLogin({ code: 'code-123' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.wechatAccount.create).toHaveBeenCalledTimes(1);
    });

    it('【安全】session_key 加密落库，库中不出现明文', async () => {
      await service.wechatLogin({ code: 'code-123' });

      const createArgs = prisma.wechatAccount.create.mock.calls[0]?.[0] as {
        data: { sessionKeyEnc: string };
      };
      const stored = createArgs.data.sessionKeyEnc;

      expect(stored).not.toContain(SESSION_KEY);
      expect(stored.startsWith('v1.')).toBe(true);
      // 且必须能被服务端解回原文（否则后续解密手机号会失败）
      expect(crypto.decrypt(stored)).toBe(SESSION_KEY);
    });

    it('【安全】响应中绝不包含 session_key 与 openid', async () => {
      const result = await service.wechatLogin({ code: 'code-123' });
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain(SESSION_KEY);
      expect(serialized).not.toContain(OPENID);
    });

    it('isNewUser = true 且 hasProfile = false（不自动创建画像）', async () => {
      const result = await service.wechatLogin({ code: 'code-123' });

      expect(result.isNewUser).toBe(true);
      expect(result.user.hasProfile).toBe(false);
      expect(result.user.mbtiType).toBeNull();
    });

    it('返回契约要求的完整字段', async () => {
      const result = await service.wechatLogin({ code: 'code-123', deviceId: 'd9f1c3a7e5b24f60' });

      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(7200);
      expect(result.refreshExpiresIn).toBe(2_592_000);
      expect(result.session.sessionId).toBe(issuedTokens.sessionId);
      expect(result.session.deviceId).toBe('d9f1c3a7e5b24f60');
      expect(result.user.membership).toEqual({ isActive: false, planCode: null, expiresAt: null });
    });

    it('写入 unionid（微信返回时）', async () => {
      await service.wechatLogin({ code: 'code-123' });

      const createArgs = prisma.wechatAccount.create.mock.calls[0]?.[0] as { data: { unionid: string } };
      expect(createArgs.data.unionid).toBe(wxSession.unionid);
    });

    it('微信未返回 unionid 时写入 null', async () => {
      wechat.code2Session.mockResolvedValueOnce({ ...wxSession, unionid: null });

      await service.wechatLogin({ code: 'code-123' });

      const createArgs = prisma.wechatAccount.create.mock.calls[0]?.[0] as { data: { unionid: null } };
      expect(createArgs.data.unionid).toBeNull();
    });

    describe('年龄声明（未成年人保护）', () => {
      it('≥ 18 岁 → ageVerified = true', async () => {
        await service.wechatLogin({ code: 'code-123', ageDeclared: 26 });

        const createArgs = prisma.user.create.mock.calls[0]?.[0] as { data: { ageVerified: boolean } };
        expect(createArgs.data.ageVerified).toBe(true);
      });

      it('< 18 岁 → ageVerified = false（恋爱匹配将被禁用）', async () => {
        await service.wechatLogin({ code: 'code-123', ageDeclared: 16 });

        const createArgs = prisma.user.create.mock.calls[0]?.[0] as { data: { ageVerified: boolean } };
        expect(createArgs.data.ageVerified).toBe(false);
      });

      it('未提交年龄声明 → ageVerified = false（默认最小权限）', async () => {
        await service.wechatLogin({ code: 'code-123' });

        const createArgs = prisma.user.create.mock.calls[0]?.[0] as { data: { ageVerified: boolean } };
        expect(createArgs.data.ageVerified).toBe(false);
      });
    });

    describe('邀请码归因', () => {
      it('有效邀请码 → 写入 inviterUserId 与 INVITE 渠道', async () => {
        prisma.relationshipInvite.findUnique.mockResolvedValue({
          inviterId: 'inviter-user-id',
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        await service.wechatLogin({ code: 'code-123', inviterCode: 'K7M2XQ9V' });

        const createArgs = prisma.user.create.mock.calls[0]?.[0] as {
          data: { inviterUserId: string | null; registerChannel: string };
        };
        expect(createArgs.data.inviterUserId).toBe('inviter-user-id');
        expect(createArgs.data.registerChannel).toBe('INVITE');
      });

      it('邀请码不存在 → inviterUserId 为 null，但注册仍然成功（不影响登录成败）', async () => {
        prisma.relationshipInvite.findUnique.mockResolvedValue(null);

        const result = await service.wechatLogin({ code: 'code-123', inviterCode: 'NOTEXIST' });

        const createArgs = prisma.user.create.mock.calls[0]?.[0] as { data: { inviterUserId: string | null } };
        expect(createArgs.data.inviterUserId).toBeNull();
        expect(result.isNewUser).toBe(true);
      });

      it('邀请码已过期 → 不做归因但仍注册成功', async () => {
        prisma.relationshipInvite.findUnique.mockResolvedValue({
          inviterId: 'inviter-user-id',
          status: 'PENDING',
          expiresAt: new Date(Date.now() - 1000),
        });

        await service.wechatLogin({ code: 'code-123', inviterCode: 'K7M2XQ9V' });

        const createArgs = prisma.user.create.mock.calls[0]?.[0] as { data: { inviterUserId: string | null } };
        expect(createArgs.data.inviterUserId).toBeNull();
      });

      it('邀请码查询抛异常 → 不阻断注册（归因是可失败的非关键路径）', async () => {
        prisma.relationshipInvite.findUnique.mockRejectedValue(new Error('db down'));

        const result = await service.wechatLogin({ code: 'code-123', inviterCode: 'K7M2XQ9V' });

        expect(result.isNewUser).toBe(true);
      });
    });
  });

  // ==========================================================================
  // 登录 — 已存在用户
  // ==========================================================================

  describe('wechatLogin — 已存在用户', () => {
    beforeEach(() => {
      prisma.wechatAccount.findUnique.mockResolvedValue({
        id: 'wa-1',
        userId: USER_ID,
        deletedAt: null,
        user: { id: USER_ID, status: 'ACTIVE', version: 3, deletedAt: null },
      });
    });

    it('isNewUser = false，且不新建用户', async () => {
      const result = await service.wechatLogin({ code: 'code-123' });

      expect(result.isNewUser).toBe(false);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.wechatAccount.create).not.toHaveBeenCalled();
    });

    it('【安全】更新 session_key（每次登录都会变化）并加密存储', async () => {
      await service.wechatLogin({ code: 'code-123' });

      const updateArgs = prisma.wechatAccount.updateMany.mock.calls[0]?.[0] as {
        data: { sessionKeyEnc: string; sessionKeyExpireAt: Date };
      };

      expect(updateArgs.data.sessionKeyEnc).not.toContain(SESSION_KEY);
      expect(crypto.decrypt(updateArgs.data.sessionKeyEnc)).toBe(SESSION_KEY);
      expect(updateArgs.data.sessionKeyExpireAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('更新 lastLoginAt 与 lastLoginIp', async () => {
      await service.wechatLogin({ code: 'code-123' }, { ip: '203.0.113.10' });

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: USER_ID },
          data: expect.objectContaining({ lastLoginIp: '203.0.113.10' }),
        }),
      );
    });

    it('账号被限制（DISABLED）→ ACCOUNT_BANNED 并撤销全部会话', async () => {
      prisma.wechatAccount.findUnique.mockResolvedValue({
        id: 'wa-1',
        userId: USER_ID,
        deletedAt: null,
        user: { id: USER_ID, status: 'DISABLED', version: 3, deletedAt: null },
      });
      prisma.user.findUnique.mockResolvedValue({ ...userRow, status: 'DISABLED' });

      await expect(service.wechatLogin({ code: 'code-123' })).rejects.toMatchObject({
        code: ErrorCode.ACCOUNT_BANNED,
      });
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith(USER_ID, 'ACCOUNT_DISABLED');
    });

    it('【合规】账号处于注销冷静期 → 不签发令牌', async () => {
      prisma.userDeletionRequest.findFirst.mockResolvedValue({ id: 'del-1' });

      await expect(service.wechatLogin({ code: 'code-123' })).rejects.toMatchObject({
        code: ErrorCode.ACCOUNT_IN_DELETION_GRACE,
      });
      expect(tokens.issueTokens).not.toHaveBeenCalled();
    });

    it('【合规】已注销的微信账号（deletedAt 非空）→ 创建全新用户', async () => {
      prisma.wechatAccount.findUnique.mockResolvedValue({
        id: 'wa-old',
        userId: 'old-user-id',
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
        user: { id: 'old-user-id', status: 'DELETED', version: 1, deletedAt: new Date() },
      });

      const result = await service.wechatLogin({ code: 'code-123' });

      expect(result.isNewUser).toBe(true);
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
    });

    it('关联用户已被软删除 → 同样创建全新用户（不做找回）', async () => {
      prisma.wechatAccount.findUnique.mockResolvedValue({
        id: 'wa-1',
        userId: USER_ID,
        deletedAt: null,
        user: { id: USER_ID, status: 'ACTIVE', version: 3, deletedAt: new Date() },
      });

      const result = await service.wechatLogin({ code: 'code-123' });

      expect(result.isNewUser).toBe(true);
    });
  });

  // ==========================================================================
  // 登录 — 失败路径
  // ==========================================================================

  describe('wechatLogin — 调用微信失败', () => {
    it('【规则 8】微信调用失败时完全不写库（避免僵尸账号）', async () => {
      wechat.code2Session.mockRejectedValueOnce(BusinessException.badRequest(ErrorCode.WECHAT_CODE_INVALID));

      await expect(service.wechatLogin({ code: 'bad-code' })).rejects.toMatchObject({
        code: ErrorCode.WECHAT_CODE_INVALID,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.wechatAccount.create).not.toHaveBeenCalled();
      expect(prisma.wechatAccount.findUnique).not.toHaveBeenCalled();
      expect(tokens.issueTokens).not.toHaveBeenCalled();
    });

    it('微信侧不可用时同样不写库，且错误码可被前端识别为「稍后重试」', async () => {
      wechat.code2Session.mockRejectedValueOnce(BusinessException.unavailable(ErrorCode.WECHAT_API_ERROR));

      await expect(service.wechatLogin({ code: 'code-123' })).rejects.toMatchObject({
        code: ErrorCode.WECHAT_API_ERROR,
      });

      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 刷新
  // ==========================================================================

  describe('refresh', () => {
    it('委托 TokenService 完成旋转，并返回契约约定的字段', async () => {
      tokens.rotateRefreshToken.mockResolvedValue({
        issued: issuedTokens,
        userId: USER_ID,
        openid: OPENID,
        userVersion: 3,
        previousJti: 'old-jti',
      });

      const result = await service.refresh({ refreshToken: issuedTokens.refreshToken });

      expect(result.accessToken).toBe(issuedTokens.accessToken);
      expect(result.refreshToken).toBe(issuedTokens.refreshToken);
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(7200);
      expect(result.refreshExpiresIn).toBe(2_592_000);
      expect(typeof result.rotatedAt).toBe('string');
    });

    it('刷新响应中不含 openid / session_key', async () => {
      tokens.rotateRefreshToken.mockResolvedValue({
        issued: issuedTokens,
        userId: USER_ID,
        openid: OPENID,
        userVersion: 3,
        previousJti: 'old-jti',
      });

      const serialized = JSON.stringify(await service.refresh({ refreshToken: issuedTokens.refreshToken }));

      expect(serialized).not.toContain(OPENID);
      expect(serialized).not.toContain(SESSION_KEY);
    });

    it('复用检测命中时错误码原样透出（20005），供前端触发重新登录', async () => {
      tokens.rotateRefreshToken.mockRejectedValueOnce(BusinessException.unauthorized(ErrorCode.REFRESH_TOKEN_REUSED));

      await expect(service.refresh({ refreshToken: issuedTokens.refreshToken })).rejects.toMatchObject({
        code: ErrorCode.REFRESH_TOKEN_REUSED,
      });
    });
  });

  // ==========================================================================
  // 登出
  // ==========================================================================

  describe('logout', () => {
    it('未传 RT 时撤销当前 AccessToken 对应的会话', async () => {
      const result = await service.logout(principal, {});

      expect(tokens.revokeSessionByJti).toHaveBeenCalledWith(USER_ID, principal.jti, 'USER_LOGOUT');
      expect(result.revokedSessions).toBe(1);
      expect(result.accessTokenRevoked).toBe(true);
    });

    it('传了 RT 时按 RT 撤销', async () => {
      const result = await service.logout(principal, { refreshToken: issuedTokens.refreshToken });

      expect(tokens.revokeSessionByRefreshToken).toHaveBeenCalledWith(issuedTokens.refreshToken, 'USER_LOGOUT');
      expect(result.revokedSessions).toBe(1);
    });

    it('allDevices = true 时撤销全部会话', async () => {
      const result = await service.logout(principal, { allDevices: true });

      expect(tokens.revokeAllSessions).toHaveBeenCalledWith(USER_ID, 'USER_LOGOUT_ALL');
      expect(result.revokedSessions).toBe(2);
    });

    it('【幂等】撤销 0 个会话时仍返回成功（登出接口不成为错误源）', async () => {
      tokens.revokeSessionByJti.mockResolvedValueOnce(false);

      const result = await service.logout(principal, {});

      expect(result.revokedSessions).toBe(0);
      expect(result.accessTokenRevoked).toBe(true);
    });

    it('当前 AccessToken 被加入黑名单（立即失效，而非等自然过期）', async () => {
      await service.logout(principal, {});

      expect(tokens.blacklistAccessToken).toHaveBeenCalledWith(principal.jti, expect.any(Number));
      const expiresAt = tokens.blacklistAccessToken.mock.calls[0]?.[1] as number;
      expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('黑名单写入失败 → 返回失败而不是假成功（契约 §3.1.3）', async () => {
      tokens.blacklistAccessToken.mockRejectedValueOnce(new Error('redis down'));

      await expect(service.logout(principal, {})).rejects.toMatchObject({
        code: ErrorCode.CACHE_ERROR,
      });
    });
  });

  describe('logoutAll', () => {
    it('撤销全部会话并使当前 AT 失效', async () => {
      const result = await service.logoutAll(principal);

      expect(tokens.revokeAllSessions).toHaveBeenCalledWith(USER_ID, 'USER_LOGOUT_ALL');
      expect(tokens.blacklistAccessToken).toHaveBeenCalledWith(principal.jti, expect.any(Number));
      expect(result.accessTokenRevoked).toBe(true);
    });
  });

  // ==========================================================================
  // 会话查询
  // ==========================================================================

  describe('getSession', () => {
    it('返回当前会话信息', async () => {
      prisma.userSession.findUnique.mockResolvedValue({
        id: 'session-row-1',
        userId: USER_ID,
        deviceId: 'd9f1c3a7e5b24f60',
        platform: 'miniapp',
        issuedAt: new Date('2026-02-14T10:00:00.000Z'),
        expiresAt: new Date('2026-03-16T10:00:00.000Z'),
        revokedAt: null,
      });

      const result = await service.getSession(principal);

      expect(result.sessionId).toBe('session-row-1');
      expect(result.userId).toBe(USER_ID);
      expect(result.realm).toBe('user');
      expect(result.deviceId).toBe('d9f1c3a7e5b24f60');
      expect(result.absoluteLifecycleDays).toBe(180);
    });

    it('会话不存在 → 404', async () => {
      prisma.userSession.findUnique.mockResolvedValue(null);

      await expect(service.getSession(principal)).rejects.toMatchObject({
        code: ErrorCode.SESSION_NOT_FOUND,
      });
    });

    it('【越权防护】会话属于其他用户 → 404（不泄露他人会话存在性）', async () => {
      prisma.userSession.findUnique.mockResolvedValue({
        id: 'other-session',
        userId: 'another-user-id',
        deviceId: null,
        platform: 'miniapp',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
        revokedAt: null,
      });

      await expect(service.getSession(principal)).rejects.toMatchObject({
        code: ErrorCode.SESSION_NOT_FOUND,
      });
    });

    it('会话已撤销 → 401', async () => {
      prisma.userSession.findUnique.mockResolvedValue({
        id: 'session-row-1',
        userId: USER_ID,
        deviceId: null,
        platform: 'miniapp',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
        revokedAt: new Date(),
      });

      await expect(service.getSession(principal)).rejects.toMatchObject({
        code: ErrorCode.SESSION_REVOKED,
      });
    });
  });

  // ==========================================================================
  // 用户视图组装
  // ==========================================================================

  describe('用户视图（buildUserView）', () => {
    beforeEach(() => {
      prisma.wechatAccount.findUnique.mockResolvedValue({
        id: 'wa-1',
        userId: USER_ID,
        deletedAt: null,
        user: { id: USER_ID, status: 'ACTIVE', version: 3, deletedAt: null },
      });
    });

    it('phoneBound 由 phoneHash 推导，不返回手机号本身', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...userRow, phoneHash: 'a'.repeat(64) });

      const result = await service.wechatLogin({ code: 'code-123' });

      expect(result.user.phoneBound).toBe(true);
      expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
    });

    it('有当前画像时返回 hasProfile 与 mbtiType', async () => {
      prisma.personalityProfile.findFirst.mockResolvedValue({ mbtiType: 'INTJ' });

      const result = await service.wechatLogin({ code: 'code-123' });

      expect(result.user.hasProfile).toBe(true);
      expect(result.user.mbtiType).toBe('INTJ');
    });

    it('有效会员时返回会员信息', async () => {
      const expireAt = new Date(Date.now() + 30 * 86_400_000);
      prisma.membership.findFirst.mockResolvedValue({ expireAt, plan: { code: 'MEMBER_YEAR' } });

      const result = await service.wechatLogin({ code: 'code-123' });

      expect(result.user.membership.isActive).toBe(true);
      expect(result.user.membership.planCode).toBe('MEMBER_YEAR');
      expect(result.user.membership.expiresAt).toBe(expireAt.toISOString());
    });

    it('查询当前画像与会员时限定当前有效条件（避免取到历史数据）', async () => {
      await service.wechatLogin({ code: 'code-123' });

      expect(prisma.personalityProfile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_ID, isCurrent: true, deletedAt: null }),
        }),
      );
      expect(prisma.membership.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: USER_ID,
            status: 'ACTIVE',
            deletedAt: null,
          }),
        }),
      );
    });

    it('生日以 YYYY-MM-DD 返回（不泄露时区细节）', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...userRow,
        birthday: new Date('1998-06-15T00:00:00.000Z'),
      });

      const result = await service.wechatLogin({ code: 'code-123' });

      expect(result.user.birthday).toBe('1998-06-15');
    });
  });
});
