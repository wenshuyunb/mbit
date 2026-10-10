/**
 * 用户服务测试
 *
 * 聚焦**合规与隐私**相关的分支（架构 §9.4 / §14.2），这些是产品能否上线的关键：
 *   · getMe        ：只返回脱敏手机号与年龄段；include 未请求的块不出现 key
 *   · updateProfile：注销冷静期禁止修改、昵称违规不入库、生日变更影响 ageVerified、乐观锁
 *   · listConsents ：固定 5 类合并视图；必同意项未按当前版本同意 → requiresReconsent
 *   · requestDeletion：三重确认、退款在途拒绝、待支付订单静默关单、幂等复用
 *   · cancelDeletion ：无申请 / 已过冷静期 / 正常撤销 三条分支
 *
 * 依赖处理：CryptoService 用真实实现（无 I/O）；Prisma / Wechat / Redis 用可控替身。
 */

import type { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { WechatService } from '../../infra/wechat/wechat.service';
import type { StorageService } from '../storage/storage.service';
import type { RequestDeletionDto } from './dto/user.dto';
import { UserService } from './user.service';

// ============================================================================
// 夹具
// ============================================================================

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const PLAIN_PHONE = '13812345678';
const GRACE_DAYS = 7;

const configService = {
  get: (path: string): unknown => {
    switch (path) {
      case 'crypto.key':
        return TEST_KEY;
      case 'crypto.ivSalt':
        return 'test_salt';
      case 'quota.accountDeletionGraceDays':
        return GRACE_DAYS;
      case 'quota.freeAiMessages':
        return 5;
      case 'quota.memberDailyAiMessages':
        return 100;
      case 'app.legalBaseUrl':
        return '';
      default:
        return undefined;
    }
  },
} as unknown as ConfigService<AppConfig, true>;

interface PrismaStub {
  user: { findUnique: jest.Mock; updateMany: jest.Mock };
  wechatAccount: { findFirst: jest.Mock };
  userConsent: { findMany: jest.Mock; upsert: jest.Mock };
  userDeletionRequest: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  systemConfig: { findMany: jest.Mock };
  personalityProfile: { findFirst: jest.Mock };
  membership: { findFirst: jest.Mock };
  entitlement: { aggregate: jest.Mock };
  testSession: { count: jest.Mock };
  aiReport: { count: jest.Mock };
  relationship: { count: jest.Mock };
  aiMessage: { count: jest.Mock };
  refund: { count: jest.Mock };
  order: { count: jest.Mock; updateMany: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  user: { findUnique: jest.fn(), updateMany: jest.fn() },
  wechatAccount: { findFirst: jest.fn() },
  userConsent: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
  userDeletionRequest: {
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
  },
  systemConfig: { findMany: jest.fn().mockResolvedValue([]) },
  personalityProfile: { findFirst: jest.fn().mockResolvedValue(null) },
  membership: { findFirst: jest.fn().mockResolvedValue(null) },
  entitlement: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingQuota: 0 } }) },
  testSession: { count: jest.fn().mockResolvedValue(0) },
  aiReport: { count: jest.fn().mockResolvedValue(0) },
  relationship: { count: jest.fn().mockResolvedValue(0) },
  aiMessage: { count: jest.fn().mockResolvedValue(0) },
  refund: { count: jest.fn().mockResolvedValue(0) },
  order: { count: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
});

/** 内存版 Redis 替身 */
const createRedisStub = (): RedisService & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    key: (...parts: (string | number)[]) => ['sm', ...parts].join(':'),
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as RedisService & { store: Map<string, string> };
};

/** 用户行夹具（含全部被 select 的字段，避免 `!== null` 判断因字段缺失而误判） */
const userRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: USER_ID,
  nickname: '小满',
  avatarUrl: null,
  gender: 'FEMALE',
  birthday: new Date('1996-08-21T00:00:00.000Z'),
  phoneEnc: null,
  phoneHash: null,
  status: 'ACTIVE',
  ageVerified: true,
  version: 12,
  createdAt: new Date('2026-02-01T03:12:44.000Z'),
  updatedAt: new Date('2026-02-14T09:40:11.000Z'),
  deletedAt: null,
  anonymizedAt: null,
  ...overrides,
});

/**
 * 注销申请行夹具
 *
 * 同样必须字段齐全：`getDeletionStatus` 会对 `requestedAt` / `scheduledAt` 调用
 * `toISOString()`，字段缺失会以 TypeError 的形式失败，掩盖真正的断言目标。
 */
const deletionRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'deletion-1',
  status: 'PENDING',
  reason: 'PRIVACY_CONCERN',
  requestedAt: new Date('2026-02-14T13:10:00.000Z'),
  scheduledAt: new Date(Date.now() + 7 * 86_400_000),
  processedAt: null,
  cancelledAt: null,
  ...overrides,
});

// ============================================================================
// 测试
// ============================================================================

describe('UserService', () => {
  let prisma: PrismaStub;
  let redis: ReturnType<typeof createRedisStub>;
  let wechat: { msgSecCheck: jest.Mock };
  let crypto: CryptoService;
  let service: UserService;

  beforeEach(() => {
    prisma = createPrismaStub();
    redis = createRedisStub();
    wechat = { msgSecCheck: jest.fn().mockResolvedValue({ pass: true, suggest: 'pass', label: null, checked: true }) };
    crypto = new CryptoService(configService);

    prisma.user.findUnique.mockResolvedValue(userRow());
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.wechatAccount.findFirst.mockResolvedValue({ openid: 'oQ7Xk5aBcDeFgHiJkLmNoPqRsTu' });

    service = new UserService(
      prisma as unknown as PrismaService,
      crypto,
      wechat as unknown as WechatService,
      redis,
      // 头像相关能力由 storage 模块测试覆盖（user.service.avatar.spec.ts），此处仅需占位
      { registerUploadedObject: jest.fn(), scheduleObjectCleanup: jest.fn() } as unknown as StorageService,
      configService,
    );
  });

  // ==========================================================================
  // GET /users/me
  // ==========================================================================

  describe('getMe', () => {
    it('返回基础资料与年龄段（不返回精确年龄）', async () => {
      const result = await service.getMe(USER_ID);

      expect(result.id).toBe(USER_ID);
      expect(result.nickname).toBe('小满');
      expect(result.birthday).toBe('1996-08-21');
      expect(result.ageRange).toMatch(/^\d+-\d+$/);
      expect(result.version).toBe(12);
    });

    it('【隐私】手机号只返回脱敏值，响应中不含明文', async () => {
      prisma.user.findUnique.mockResolvedValue(
        userRow({ phoneEnc: crypto.encrypt(PLAIN_PHONE), phoneHash: 'a'.repeat(64) }),
      );

      const result = await service.getMe(USER_ID);

      expect(result.phoneBound).toBe(true);
      expect(result.phoneMasked).toBe('138****5678');
      expect(JSON.stringify(result)).not.toContain(PLAIN_PHONE);
    });

    it('未绑定手机号时 phoneMasked 为 null', async () => {
      const result = await service.getMe(USER_ID);

      expect(result.phoneBound).toBe(false);
      expect(result.phoneMasked).toBeNull();
    });

    it('【隐私】响应中不含 openid / session_key 等敏感字段', async () => {
      const serialized = JSON.stringify(await service.getMe(USER_ID, ['profile', 'membership', 'stats']));

      expect(serialized).not.toContain('openid');
      expect(serialized).not.toContain('sessionKey');
      expect(serialized).not.toContain('unionid');
      expect(serialized).not.toContain('phoneEnc');
    });

    it('【契约规则 3】未请求的 include 块不出现 key（而非返回 null）', async () => {
      const result = await service.getMe(USER_ID);

      expect('profile' in result).toBe(false);
      expect('membership' in result).toBe(false);
      expect('aiQuota' in result).toBe(false);
      expect('stats' in result).toBe(false);
      expect('consents' in result).toBe(false);
    });

    it('请求的 include 块才返回', async () => {
      prisma.personalityProfile.findFirst.mockResolvedValue({
        id: 'profile-1',
        mbtiType: 'INFJ',
        engineVersion: 'pe-v1.0.0',
        version: 3,
        mbtiConfidence: 78.4,
        openness: 82.5,
        conscientiousness: 71,
        extraversion: 34.5,
        agreeableness: 88,
        neuroticism: 56.5,
        attachmentStyle: 'ANXIOUS',
        loveLanguages: ['QUALITY_TIME'],
        conflictStyle: 'ACCOMMODATING',
        computedAt: new Date('2026-02-10T08:21:03.000Z'),
      });

      const result = await service.getMe(USER_ID, ['profile']);

      expect(result.profile?.mbtiType).toBe('INFJ');
      expect(result.profile?.bigFive.openness).toBe(82.5);
      expect('membership' in result).toBe(false);
    });

    it('无画像时 include=profile 不返回该块', async () => {
      const result = await service.getMe(USER_ID, ['profile']);

      expect('profile' in result).toBe(false);
    });

    it('include=stats 返回四类计数', async () => {
      prisma.testSession.count.mockResolvedValue(4);
      prisma.aiReport.count.mockResolvedValue(3);
      prisma.relationship.count.mockResolvedValue(1);
      prisma.aiMessage.count.mockResolvedValue(126);

      const result = await service.getMe(USER_ID, ['stats']);

      expect(result.stats).toEqual({
        testSessionCount: 4,
        reportCount: 3,
        relationshipCount: 1,
        aiMessageCount: 126,
      });
    });

    it('include=aiQuota 免费用户返回总配额，会员返回每日配额', async () => {
      const free = await service.getMe(USER_ID, ['aiQuota']);

      expect(free.aiQuota?.dailyLimit).toBe(0);
      expect(free.aiQuota?.remaining).toBe(5);

      prisma.membership.findFirst.mockResolvedValue({ dailyAiUsed: 2, dailyAiUsedDate: new Date() });
      const member = await service.getMe(USER_ID, ['aiQuota']);

      expect(member.aiQuota?.dailyLimit).toBe(100);
      expect(member.aiQuota?.usedToday).toBe(2);
      expect(member.aiQuota?.remaining).toBe(98);
    });

    it('会员计数日期不是今天时视为已重置', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        dailyAiUsed: 50,
        dailyAiUsedDate: new Date('2026-01-01T00:00:00.000Z'),
      });

      const result = await service.getMe(USER_ID, ['aiQuota']);

      expect(result.aiQuota?.usedToday).toBe(0);
      expect(result.aiQuota?.remaining).toBe(100);
    });

    it.each([
      ['用户已被软删除', { deletedAt: new Date() }],
      ['用户已匿名化', { anonymizedAt: new Date() }],
    ])('%s → 404（不泄露账号是否曾存在）', async (_label, overrides) => {
      prisma.user.findUnique.mockResolvedValue(userRow(overrides));

      await expect(service.getMe(USER_ID)).rejects.toMatchObject({ code: ErrorCode.USER_NOT_FOUND });
    });

    it('用户记录不存在 → 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getMe(USER_ID)).rejects.toMatchObject({ code: ErrorCode.USER_NOT_FOUND });
    });
  });

  // ==========================================================================
  // PATCH /users/me
  // ==========================================================================

  describe('updateProfile', () => {
    it('【冷静期限制】注销冷静期内禁止修改资料', async () => {
      prisma.userDeletionRequest.findFirst.mockResolvedValue({ id: 'del-1' });

      await expect(service.updateProfile(USER_ID, { nickname: '新昵称' })).rejects.toMatchObject({
        code: ErrorCode.PROFILE_EDIT_LOCKED,
      });

      // 关键：必须在写库之前拦截
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('【内容安全】昵称未通过检测 → 不入库、不覆盖旧值', async () => {
      wechat.msgSecCheck.mockResolvedValue({ pass: false, suggest: 'risky', label: '20001', checked: true });

      await expect(service.updateProfile(USER_ID, { nickname: '违规昵称' })).rejects.toMatchObject({
        code: ErrorCode.CONTENT_BLOCKED,
      });

      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('内容安全检测未执行（fail-open）时放行', async () => {
      wechat.msgSecCheck.mockResolvedValue({ pass: true, suggest: 'unknown', label: null, checked: false });
      prisma.user.findUnique
        .mockResolvedValueOnce(userRow({ deletedAt: null, anonymizedAt: null }))
        .mockResolvedValueOnce({
          id: USER_ID,
          nickname: '新昵称',
          avatarUrl: null,
          gender: 'FEMALE',
          birthday: null,
          version: 13,
          updatedAt: new Date(),
        });

      await expect(service.updateProfile(USER_ID, { nickname: '新昵称' })).resolves.toBeDefined();
      expect(prisma.user.updateMany).toHaveBeenCalled();
    });

    it('空白昵称被拒绝（trim 后不得为空）', async () => {
      // DTO 层会先 trim；此处直接传空白串模拟内部调用
      await expect(service.updateProfile(USER_ID, { nickname: '   ' })).rejects.toMatchObject({
        code: ErrorCode.NICKNAME_INVALID,
      });

      expect(wechat.msgSecCheck).not.toHaveBeenCalled();
    });

    it('【未成年人保护】生日显示 < 18 岁 → ageVerified 置 false', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(userRow()).mockResolvedValueOnce({
        id: USER_ID,
        nickname: null,
        avatarUrl: null,
        gender: 'FEMALE',
        birthday: new Date('2012-01-01T00:00:00.000Z'),
        version: 13,
        updatedAt: new Date(),
      });

      await service.updateProfile(USER_ID, { birthday: '2012-01-01' });

      const updateArgs = prisma.user.updateMany.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };

      expect(updateArgs.data['ageVerified']).toBe(false);
    });

    it('成年人提交生日不会把 ageVerified 置 false', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(userRow()).mockResolvedValueOnce({
        id: USER_ID,
        nickname: null,
        avatarUrl: null,
        gender: 'FEMALE',
        birthday: new Date('1996-08-21T00:00:00.000Z'),
        version: 13,
        updatedAt: new Date(),
      });

      await service.updateProfile(USER_ID, { birthday: '1996-08-21' });

      const updateArgs = prisma.user.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect('ageVerified' in updateArgs.data).toBe(false);
    });

    it('生日超出范围（1900 之前 / 未来）→ 拒绝', async () => {
      await expect(service.updateProfile(USER_ID, { birthday: '1899-12-31' })).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });

      await expect(service.updateProfile(USER_ID, { birthday: '2099-01-01' })).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('gender = null 归一为 UNKNOWN', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(userRow()).mockResolvedValueOnce({
        id: USER_ID,
        nickname: null,
        avatarUrl: null,
        gender: 'UNKNOWN',
        birthday: null,
        version: 13,
        updatedAt: new Date(),
      });

      await service.updateProfile(USER_ID, { gender: null });

      const updateArgs = prisma.user.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(updateArgs.data['gender']).toBe('UNKNOWN');
    });

    it('【乐观锁】传 expectedVersion 且不匹配 → 版本冲突', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      // 第二次 findUnique 用于区分「冲突」与「用户不存在」
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID });

      await expect(service.updateProfile(USER_ID, { nickname: '新昵称', expectedVersion: 99 })).rejects.toMatchObject({
        code: ErrorCode.VERSION_OUTDATED,
      });
    });

    it('乐观锁冲突时先确认用户是否存在（避免把「用户不存在」误报为冲突）', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.updateProfile(USER_ID, { nickname: '新昵称', expectedVersion: 99 })).rejects.toMatchObject({
        code: ErrorCode.USER_NOT_FOUND,
      });
    });

    it('不传 expectedVersion 时最后写入者胜（where 不含 version）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(userRow()).mockResolvedValueOnce({
        id: USER_ID,
        nickname: '新昵称',
        avatarUrl: null,
        gender: 'FEMALE',
        birthday: null,
        version: 13,
        updatedAt: new Date(),
      });

      await service.updateProfile(USER_ID, { nickname: '新昵称' });

      const updateArgs = prisma.user.updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
      expect(updateArgs.where).toEqual({ id: USER_ID });
    });

    it('每次更新都递增 version（乐观锁可被前端感知）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(userRow()).mockResolvedValueOnce({
        id: USER_ID,
        nickname: null,
        avatarUrl: null,
        gender: 'FEMALE',
        birthday: null,
        version: 13,
        updatedAt: new Date(),
      });

      await service.updateProfile(USER_ID, { nickname: 'x' });

      const updateArgs = prisma.user.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(updateArgs.data['version']).toEqual({ increment: 1 });
    });

    it('昵称内容安全检测时传入 openid（微信 v2 接口要求）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(userRow()).mockResolvedValueOnce({
        id: USER_ID,
        nickname: 'x',
        avatarUrl: null,
        gender: 'FEMALE',
        birthday: null,
        version: 13,
        updatedAt: new Date(),
      });

      await service.updateProfile(USER_ID, { nickname: 'x' });

      expect(wechat.msgSecCheck).toHaveBeenCalledWith('x', 'oQ7Xk5aBcDeFgHiJkLmNoPqRsTu');
    });
  });

  // ==========================================================================
  // 同意记录
  // ==========================================================================

  describe('listConsents', () => {
    it('【契约规则 1】无任何记录时仍返回固定 5 类', async () => {
      const result = await service.listConsents(USER_ID);

      expect(result.consents).toHaveLength(5);
      expect(result.consents.map((item) => item.type)).toEqual([
        'PRIVACY_POLICY',
        'TERMS_OF_SERVICE',
        'AGE_DECLARATION',
        'AI_CONTENT_NOTICE',
        'MARKETING',
      ]);
      expect(result.consents.every((item) => item.agreed === false)).toBe(true);
    });

    it('必同意项未同意 → requiresReconsent 为 true 且 pendingTypes 含对应类型', async () => {
      const result = await service.listConsents(USER_ID);

      expect(result.requiresReconsent).toBe(true);
      expect(result.pendingTypes).toEqual(['PRIVACY_POLICY', 'TERMS_OF_SERVICE', 'AGE_DECLARATION']);
    });

    it('必同意项均已按当前版本同意 → requiresReconsent 为 false', async () => {
      prisma.userConsent.findMany.mockResolvedValue([
        { type: 'PRIVACY_POLICY', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
        { type: 'TERMS_OF_SERVICE', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
        { type: 'AGE_DECLARATION', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
      ]);

      const result = await service.listConsents(USER_ID);

      expect(result.requiresReconsent).toBe(false);
      expect(result.pendingTypes).toEqual([]);

      // 已记录的三项应标记为「已按当前版本同意」；未记录的两项为 false（无记录）
      const requiredTypes = ['PRIVACY_POLICY', 'TERMS_OF_SERVICE', 'AGE_DECLARATION'];
      for (const type of requiredTypes) {
        const entry = result.consents.find((item) => item.type === type);
        expect(entry?.agreed).toBe(true);
        expect(entry?.isLatest).toBe(true);
      }
    });

    it('【合规】营销授权未同意不触发重新同意（必须是可选项）', async () => {
      prisma.userConsent.findMany.mockResolvedValue([
        { type: 'PRIVACY_POLICY', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
        { type: 'TERMS_OF_SERVICE', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
        { type: 'AGE_DECLARATION', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
        { type: 'MARKETING', policyVersion: '2026-02-14', agreed: false, agreedAt: new Date(), revokedAt: null },
      ]);

      const result = await service.listConsents(USER_ID);

      expect(result.requiresReconsent).toBe(false);
      expect(result.pendingTypes).not.toContain('MARKETING');
    });

    it('已同意的版本落后于当前版本 → 需要重新同意', async () => {
      prisma.userConsent.findMany.mockResolvedValue([
        { type: 'PRIVACY_POLICY', policyVersion: '2025-01-01', agreed: true, agreedAt: new Date(), revokedAt: null },
        { type: 'TERMS_OF_SERVICE', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
        { type: 'AGE_DECLARATION', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
      ]);

      const result = await service.listConsents(USER_ID);

      expect(result.pendingTypes).toContain('PRIVACY_POLICY');
      expect(result.consents.find((item) => item.type === 'PRIVACY_POLICY')?.isLatest).toBe(false);
    });

    it('每类取最新一条记录（历史版本不覆盖当前状态）', async () => {
      prisma.userConsent.findMany.mockResolvedValue([
        // 已按时间倒序返回
        { type: 'PRIVACY_POLICY', policyVersion: '2026-02-14', agreed: true, agreedAt: new Date(), revokedAt: null },
        { type: 'PRIVACY_POLICY', policyVersion: '2025-01-01', agreed: true, agreedAt: new Date(0), revokedAt: null },
      ]);

      const result = await service.listConsents(USER_ID);
      const privacy = result.consents.find((item) => item.type === 'PRIVACY_POLICY');

      expect(privacy?.version).toBe('2026-02-14');
      expect(privacy?.isLatest).toBe(true);
    });

    it('已撤回的同意视为未同意', async () => {
      prisma.userConsent.findMany.mockResolvedValue([
        {
          type: 'PRIVACY_POLICY',
          policyVersion: '2026-02-14',
          agreed: true,
          agreedAt: new Date(),
          revokedAt: new Date(),
        },
      ]);

      const result = await service.listConsents(USER_ID);
      const privacy = result.consents.find((item) => item.type === 'PRIVACY_POLICY');

      expect(privacy?.agreed).toBe(false);
      expect(result.pendingTypes).toContain('PRIVACY_POLICY');
    });

    it('协议 url 未配置 LEGAL_BASE_URL 时为 null（不返回猜测的死链）', async () => {
      const result = await service.listConsents(USER_ID);

      expect(result.consents.every((item) => item.url === null)).toBe(true);
    });

    it('system_configs 中配置的版本优先于兜底值', async () => {
      prisma.systemConfig.findMany.mockResolvedValue([{ key: 'policy.version.PRIVACY_POLICY', value: '2027-01-01' }]);

      const result = await service.listConsents(USER_ID);
      const privacy = result.consents.find((item) => item.type === 'PRIVACY_POLICY');

      expect(privacy?.currentVersion).toBe('2027-01-01');
    });

    it('协议版本配置读取失败时回退兜底值（不阻断同意流程）', async () => {
      prisma.systemConfig.findMany.mockRejectedValue(new Error('db down'));

      const result = await service.listConsents(USER_ID);

      expect(result.consents).toHaveLength(5);
      expect(result.consents[0]?.currentVersion).toBe('2026-02-14');
    });
  });

  describe('submitConsent', () => {
    const upsertResult = {
      type: 'PRIVACY_POLICY',
      policyVersion: '2026-02-14',
      agreed: true,
      agreedAt: new Date('2026-02-14T10:00:00.000Z'),
      revokedAt: null,
    };

    it('提交当前版本 → 成功', async () => {
      prisma.userConsent.upsert.mockResolvedValue(upsertResult);

      const result = await service.submitConsent(USER_ID, {
        type: 'PRIVACY_POLICY',
        policyVersion: '2026-02-14',
        agreed: true,
      });

      expect(result.agreed).toBe(true);
      expect(result.isLatest).toBe(true);
    });

    it('提交过期版本 → 要求重新阅读（30017）', async () => {
      await expect(
        service.submitConsent(USER_ID, {
          type: 'PRIVACY_POLICY',
          policyVersion: '2025-01-01',
          agreed: true,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CONSENT_VERSION_STALE });

      expect(prisma.userConsent.upsert).not.toHaveBeenCalled();
    });

    it('【合规】撤回同意不校验版本（用户有权随时撤回）', async () => {
      prisma.userConsent.upsert.mockResolvedValue({
        ...upsertResult,
        agreed: false,
        revokedAt: new Date(),
      });

      await expect(
        service.submitConsent(USER_ID, {
          type: 'PRIVACY_POLICY',
          policyVersion: '2020-01-01',
          agreed: false,
        }),
      ).resolves.toBeDefined();
    });

    it('记录来源渠道、IP 与 UA（合规审计需要）', async () => {
      prisma.userConsent.upsert.mockResolvedValue(upsertResult);

      await service.submitConsent(
        USER_ID,
        { type: 'PRIVACY_POLICY', policyVersion: '2026-02-14', agreed: true },
        { ip: '203.0.113.10', userAgent: 'MicroMessenger/8.0', channel: 'miniapp' },
      );

      const args = prisma.userConsent.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
      };

      expect(args.create['ip']).toBe('203.0.113.10');
      expect(args.create['userAgent']).toBe('MicroMessenger/8.0');
    });
  });

  // ==========================================================================
  // 注销申请
  // ==========================================================================

  describe('requestDeletion', () => {
    /**
     * 显式标注为 RequestDeletionDto 而非字面量推断
     *
     * DTO 中 `acknowledge*` 的类型是 `boolean`（运行期由 `@IsIn([true])` 强制为 true），
     * 因此这里可以构造出「绕过 DTO 的内部调用」来验证服务层自身的断言。
     */
    const validDto: RequestDeletionDto = {
      reason: 'PRIVACY_CONCERN',
      confirmText: '确认注销',
      acknowledgeRetention: true,
      acknowledgeIrreversible: true,
    };

    beforeEach(() => {
      prisma.userDeletionRequest.create.mockResolvedValue({
        id: 'deletion-1',
        status: 'PENDING',
        reason: 'PRIVACY_CONCERN',
        requestedAt: new Date(),
        scheduledAt: new Date(Date.now() + GRACE_DAYS * 86_400_000),
      });
      // getDeletionStatus 会再查一次
      prisma.userDeletionRequest.findFirst
        .mockResolvedValueOnce(null) // 首次：确认无 PENDING 申请
        .mockResolvedValue({
          id: 'deletion-1',
          status: 'PENDING',
          reason: 'PRIVACY_CONCERN',
          requestedAt: new Date(),
          scheduledAt: new Date(Date.now() + GRACE_DAYS * 86_400_000),
          processedAt: null,
          cancelledAt: null,
        });
    });

    it('创建申请并返回删除/保留数据清单', async () => {
      const result = await service.requestDeletion(USER_ID, validDto);

      expect(result.status).toBe('PENDING');
      expect(result.willBeDeleted.length).toBeGreaterThan(0);
      expect(result.willBeRetained.some((item) => item.includes('法定留存'))).toBe(true);
      expect(result.retainedDataNotice).toContain('3 年');
    });

    it('冷静期按配置的 7 天计算', async () => {
      await service.requestDeletion(USER_ID, validDto);

      const args = prisma.userDeletionRequest.create.mock.calls[0]?.[0] as {
        data: { scheduledAt: Date; requestedAt: Date };
      };

      const days = Math.round((args.data.scheduledAt.getTime() - args.data.requestedAt.getTime()) / 86_400_000);
      expect(days).toBe(GRACE_DAYS);
    });

    it('【三重确认】确认文本不匹配 → 拒绝且不写库', async () => {
      await expect(service.requestDeletion(USER_ID, { ...validDto, confirmText: '确认' })).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });

      expect(prisma.userDeletionRequest.create).not.toHaveBeenCalled();
    });

    it('【三重确认】缺少数据保留确认 → 拒绝', async () => {
      await expect(
        // 模拟绕过 DTO 的内部调用
        service.requestDeletion(USER_ID, { ...validDto, acknowledgeRetention: false }),
      ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });

      expect(prisma.userDeletionRequest.create).not.toHaveBeenCalled();
    });

    it('【前置校验】存在处理中退款 → 拒绝（钱款无处可退）', async () => {
      prisma.refund.count.mockResolvedValue(1);

      await expect(service.requestDeletion(USER_ID, validDto)).rejects.toMatchObject({
        code: ErrorCode.ORDER_IN_PROGRESS,
      });

      expect(prisma.userDeletionRequest.create).not.toHaveBeenCalled();
    });

    it('【前置校验】存在待支付订单 → 静默关单后继续（不阻断用户）', async () => {
      prisma.order.count.mockResolvedValueOnce(1);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      await service.requestDeletion(USER_ID, validDto);

      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, status: 'PENDING_PAY' },
          data: expect.objectContaining({ status: 'CLOSED', cancelReason: 'ACCOUNT_DELETION' }),
        }),
      );
      expect(prisma.userDeletionRequest.create).toHaveBeenCalled();
    });

    it('已有 PENDING 申请 → 幂等返回既有申请，不重复建单', async () => {
      prisma.userDeletionRequest.findFirst.mockReset();
      prisma.userDeletionRequest.findFirst.mockResolvedValue({
        id: 'existing-1',
        status: 'PENDING',
        reason: 'PRIVACY_CONCERN',
        requestedAt: new Date(),
        scheduledAt: new Date(Date.now() + 86_400_000),
        processedAt: null,
        cancelledAt: null,
      });

      const result = await service.requestDeletion(USER_ID, validDto);

      expect(result.requestId).toBe('existing-1');
      expect(prisma.userDeletionRequest.create).not.toHaveBeenCalled();
    });

    it('【幂等键】相同幂等键重复提交返回首次结果', async () => {
      const first = await service.requestDeletion(USER_ID, validDto, { idempotencyKey: 'idem-key-123456' });

      expect(first.requestId).toBe('deletion-1');
      expect(redis.store.size).toBe(1);

      // 第二次：无 PENDING 申请（模拟申请已被撤销后又提交），但幂等键命中
      prisma.userDeletionRequest.findFirst.mockResolvedValue(null);
      prisma.userDeletionRequest.findUnique.mockResolvedValue({ id: 'deletion-1', status: 'CANCELLED' });

      const second = await service.requestDeletion(USER_ID, validDto, {
        idempotencyKey: 'idem-key-123456',
      });

      expect(second.requestId).toBe('deletion-1');
      // 关键：没有创建第二条申请
      expect(prisma.userDeletionRequest.create).toHaveBeenCalledTimes(1);
    });

    it('不同幂等键互不影响（各自独立建单）', async () => {
      await service.requestDeletion(USER_ID, validDto, { idempotencyKey: 'idem-key-aaaaaaaa' });

      prisma.userDeletionRequest.findFirst.mockReset();
      prisma.userDeletionRequest.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
        id: 'deletion-2',
        status: 'PENDING',
        reason: 'PRIVACY_CONCERN',
        requestedAt: new Date(),
        scheduledAt: new Date(Date.now() + 86_400_000),
        processedAt: null,
        cancelledAt: null,
      });
      prisma.userDeletionRequest.create.mockResolvedValue({
        id: 'deletion-2',
        status: 'PENDING',
        reason: 'PRIVACY_CONCERN',
        requestedAt: new Date(),
        scheduledAt: new Date(Date.now() + GRACE_DAYS * 86_400_000),
      });

      await service.requestDeletion(USER_ID, validDto, { idempotencyKey: 'idem-key-bbbbbbbb' });

      expect(prisma.userDeletionRequest.create).toHaveBeenCalledTimes(2);
      expect(redis.store.size).toBe(2);
    });

    it('账号已匿名化 → 拒绝再次申请', async () => {
      prisma.user.findUnique.mockResolvedValue(userRow({ anonymizedAt: new Date() }));

      await expect(service.requestDeletion(USER_ID, validDto)).rejects.toMatchObject({
        code: ErrorCode.DELETION_ALREADY_COMPLETED,
      });
    });

    it('reasonDetail 以 `CODE|detail` 形式拼接存储', async () => {
      await service.requestDeletion(USER_ID, { ...validDto, reasonDetail: '希望减少留存' });

      const args = prisma.userDeletionRequest.create.mock.calls[0]?.[0] as { data: { reason: string } };
      expect(args.data.reason).toBe('PRIVACY_CONCERN|希望减少留存');
    });

    it('无 reasonDetail 时只存枚举值', async () => {
      await service.requestDeletion(USER_ID, validDto);

      const args = prisma.userDeletionRequest.create.mock.calls[0]?.[0] as { data: { reason: string } };
      expect(args.data.reason).toBe('PRIVACY_CONCERN');
    });
  });

  // ==========================================================================
  // 注销状态与撤销
  // ==========================================================================

  describe('getDeletionStatus', () => {
    it('无申请时返回全 null 结构（字段保持存在，便于前端类型稳定）', async () => {
      const result = await service.getDeletionStatus(USER_ID);

      expect(result.hasRequest).toBe(false);
      expect(result.requestId).toBeNull();
      expect(result.status).toBeNull();
      expect(result.remainingDays).toBeNull();
      expect(result.canCancel).toBe(false);
      // 说明文案始终存在
      expect(result.retainedDataNotice).toContain('3 年');
    });

    it('冷静期中：remainingDays 向上取整', async () => {
      // 剩余 1.5 天 → 显示 2 天
      prisma.userDeletionRequest.findFirst.mockResolvedValue(
        deletionRow({
          reason: 'PRIVACY_CONCERN|补充说明',
          scheduledAt: new Date(Date.now() + 1.5 * 86_400_000),
        }),
      );

      const result = await service.getDeletionStatus(USER_ID);

      expect(result.hasRequest).toBe(true);
      expect(result.remainingDays).toBe(2);
      expect(result.canCancel).toBe(true);
      // reason 只返回枚举部分，不返回拼接的补充说明
      expect(result.reason).toBe('PRIVACY_CONCERN');
    });

    it('已完成的申请 hasRequest 为 false（前端不再展示冷静期引导）', async () => {
      prisma.userDeletionRequest.findFirst.mockResolvedValue(
        deletionRow({
          status: 'COMPLETED',
          scheduledAt: new Date(Date.now() - 86_400_000),
          processedAt: new Date(),
        }),
      );

      const result = await service.getDeletionStatus(USER_ID);

      expect(result.hasRequest).toBe(false);
      expect(result.status).toBe('COMPLETED');
      expect(result.completedAt).not.toBeNull();
    });
  });

  describe('cancelDeletion', () => {
    it('无任何申请 → DELETION_NOT_REQUESTED', async () => {
      prisma.userDeletionRequest.findFirst.mockResolvedValue(null);

      await expect(service.cancelDeletion(USER_ID, {})).rejects.toMatchObject({
        code: ErrorCode.DELETION_NOT_REQUESTED,
      });
    });

    it('申请已处理（匿名化中/完成）→ DELETION_NOT_CANCELLABLE', async () => {
      prisma.userDeletionRequest.findFirst
        .mockResolvedValueOnce(null) // 无 PENDING
        .mockResolvedValueOnce({ id: 'del-1' }); // 但存在已处理记录

      await expect(service.cancelDeletion(USER_ID, {})).rejects.toMatchObject({
        code: ErrorCode.DELETION_NOT_CANCELLABLE,
      });
    });

    it('已过冷静期 → DELETION_NOT_CANCELLABLE', async () => {
      prisma.userDeletionRequest.findFirst.mockResolvedValue(deletionRow({ scheduledAt: new Date(Date.now() - 1000) }));

      await expect(service.cancelDeletion(USER_ID, {})).rejects.toMatchObject({
        code: ErrorCode.DELETION_NOT_CANCELLABLE,
      });

      expect(prisma.userDeletionRequest.update).not.toHaveBeenCalled();
    });

    it('正常撤销：状态置 CANCELLED 并记录时间', async () => {
      // 第一次：查找 PENDING 申请；第二次（getDeletionStatus）：撤销后已无 PENDING
      prisma.userDeletionRequest.findFirst
        .mockResolvedValueOnce(deletionRow({ scheduledAt: new Date(Date.now() + 86_400_000) }))
        .mockResolvedValueOnce(null);
      prisma.userDeletionRequest.update.mockResolvedValue({ id: 'deletion-1' });

      const result = await service.cancelDeletion(USER_ID, { reason: '还想再用一段时间' });

      const args = prisma.userDeletionRequest.update.mock.calls[0]?.[0] as {
        where: { id: string };
        data: Record<string, unknown>;
      };

      expect(args.where.id).toBe('deletion-1');
      expect(args.data['status']).toBe('CANCELLED');
      expect(args.data['cancelledAt']).toBeInstanceOf(Date);
      expect(result.hasRequest).toBe(false);
    });

    it('撤销原因超过 512 字符时被截断（不因超长写入失败）', async () => {
      prisma.userDeletionRequest.findFirst
        .mockResolvedValueOnce(deletionRow({ scheduledAt: new Date(Date.now() + 86_400_000) }))
        .mockResolvedValue(null);
      prisma.userDeletionRequest.update.mockResolvedValue({ id: 'deletion-1' });

      await service.cancelDeletion(USER_ID, { reason: 'x'.repeat(600) });

      const args = prisma.userDeletionRequest.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(String(args.data['failureReason']).length).toBe(512);
    });
  });

  it('所有业务错误都是 BusinessException（可被全局过滤器正确转换）', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.getMe(USER_ID)).rejects.toBeInstanceOf(BusinessException);
  });
});
