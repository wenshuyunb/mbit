/**
 * AdminUserService 测试
 *
 * 聚焦「契约一致性 + 隐私底线 + 幂等/审计」这三类最容易出事故的分支：
 *   · listUsers   ：专属错误码（10001/10004/10005）、手机号只允许哈希精确、展示态映射、强审计
 *   · getUserDetail：include 白名单与默认值、未请求块不出现 key、AI 用量只有计量、手机号脱敏
 *   · banUser     ：状态落库（DISABLED）、会话撤销、通知、before/after 审计、幂等
 *   · unbanUser   ：previousBan 回填、补偿（会员延期 / 等值 AI 次数）、幂等、已注销拒绝
 *
 * 依赖处理：CryptoService 用真实实现（纯本地运算，能顺带验证 phoneHash 算法一致）；
 *          Prisma / Redis / AdminAuditService 用可控替身。
 */

import type { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { AppConfig } from '../../../config/config.type';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { TokenService } from '../../auth/token.service';
import type { AdminAuditService, AdminAuditEntry } from '../audit/admin-audit.service';
import { AdminUserService, type AdminOperatorContext } from './admin-user.service';

// ============================================================================
// 夹具
// ============================================================================

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const ADMIN_ID = '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a';
const OPENID = 'oQ7Xk5aBcDeFgHiJkLmNoPqRsTu';
const PLAIN_PHONE = '13812345678';

const configService = {
  get: (path: string): unknown => {
    switch (path) {
      case 'crypto.key':
        return TEST_KEY;
      case 'crypto.ivSalt':
        return 'test_salt';
      case 'jwt.userAccessTtl':
        return '2h';
      case 'jwt.userRefreshTtl':
        return '30d';
      default:
        return undefined;
    }
  },
} as unknown as ConfigService<AppConfig, true>;

const OPERATOR: AdminOperatorContext = {
  adminUserId: ADMIN_ID,
  jti: 'admin-jti-1',
  ip: '10.0.0.1',
  userAgent: 'jest',
  requestId: 'req_test_1',
};

interface PrismaStub {
  user: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock; update: jest.Mock };
  order: { groupBy: jest.Mock; count: jest.Mock; aggregate: jest.Mock; findMany: jest.Mock };
  aiReport: { groupBy: jest.Mock; count: jest.Mock; findMany: jest.Mock };
  relationship: { groupBy: jest.Mock; count: jest.Mock; findMany: jest.Mock };
  aiMessage: { groupBy: jest.Mock; count: jest.Mock; aggregate: jest.Mock; findFirst: jest.Mock };
  aiConversation: { count: jest.Mock };
  membership: { findMany: jest.Mock; findFirst: jest.Mock; count: jest.Mock; update: jest.Mock };
  userPhoneHistory: { findMany: jest.Mock; findFirst: jest.Mock };
  userDeletionRequest: { findMany: jest.Mock; findFirst: jest.Mock };
  userConsent: { findMany: jest.Mock };
  personalityProfile: { findFirst: jest.Mock };
  testSession: { findMany: jest.Mock; count: jest.Mock };
  entitlement: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  notification: { create: jest.Mock };
  userSession: { findMany: jest.Mock; updateMany: jest.Mock };
  adminUser: { findFirst: jest.Mock };
  adminAuditLog: { findMany: jest.Mock; findFirst: jest.Mock };
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub: Partial<PrismaStub> = {
    user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn(), update: jest.fn() },
    order: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { paidAmount: 0, refundedAmount: 0 } }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    aiReport: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    relationship: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    aiMessage: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { totalTokens: 0, costAmount: 0 } }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    aiConversation: { count: jest.fn().mockResolvedValue(0) },
    membership: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
    },
    userPhoneHistory: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    userDeletionRequest: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    userConsent: { findMany: jest.fn().mockResolvedValue([]) },
    personalityProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    testSession: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    entitlement: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    notification: { create: jest.fn().mockResolvedValue({ id: 'notification-1' }) },
    userSession: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    adminUser: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: ADMIN_ID, username: 'superadmin', nickname: '超级管理员', realName: null }),
    },
    adminAuditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
    },
  };

  // $transaction 直接把替身当作 tx 传回，测试即可断言事务内的调用
  stub.$transaction = jest
    .fn()
    .mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(stub));

  return stub as PrismaStub;
};

/** 列表行夹具（字段与 `LIST_USER_SELECT` 一一对应） */
const listUserRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: USER_ID,
  nickname: '小满',
  avatarUrl: null,
  gender: 'FEMALE',
  birthday: new Date('1996-08-21T00:00:00.000Z'),
  status: 'ACTIVE',
  phoneHash: null,
  createdAt: new Date('2026-02-01T03:12:44.000Z'),
  updatedAt: new Date('2026-02-14T09:40:11.000Z'),
  lastLoginAt: new Date('2026-02-14T16:25:04.000Z'),
  deletedAt: null,
  anonymizedAt: null,
  wechatAccounts: [{ openid: OPENID }],
  profiles: [{ mbtiType: 'INFJ', version: 3 }],
  ...overrides,
});

/** 详情行夹具（字段与 `getUserDetail` 的 select 一一对应） */
const detailUserRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: USER_ID,
  nickname: '小满',
  avatarUrl: null,
  gender: 'FEMALE',
  birthday: new Date('1996-08-21T00:00:00.000Z'),
  status: 'ACTIVE',
  ageVerified: true,
  phoneEnc: null,
  phoneHash: null,
  createdAt: new Date('2026-02-01T03:12:44.000Z'),
  updatedAt: new Date('2026-02-14T12:35:00.000Z'),
  lastLoginAt: new Date('2026-02-14T16:25:04.000Z'),
  deletedAt: null,
  anonymizedAt: null,
  wechatAccounts: [
    {
      openid: OPENID,
      unionid: null,
      createdAt: new Date('2026-02-01T03:12:44.000Z'),
      updatedAt: new Date('2026-02-14T10:00:00.000Z'),
    },
  ],
  ...overrides,
});

/** 封禁/解封使用的用户行夹具 */
const mutationUserRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: USER_ID,
  nickname: '小满',
  status: 'ACTIVE',
  deletedAt: null,
  anonymizedAt: null,
  deletionRequests: [],
  ...overrides,
});

/** 审计里封禁记录的 afterData（服务据此回填 bannedReason / previousBan） */
const banAuditAfterData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'BANNED',
  ban: true,
  reason: 'AI_ABUSE',
  reasonDetail: '疑似脚本刷量',
  banType: 'TEMPORARY',
  durationDays: 30,
  bannedAt: '2026-02-14T19:15:00.000Z',
  expiresAt: '2026-03-16T19:15:00.000Z',
  ...overrides,
});

/** 断言抛出的业务错误码与 HTTP 状态 */
const expectBusinessError = async (promise: Promise<unknown>, code: number, status: number): Promise<void> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(BusinessException);
  expect((error as BusinessException).code).toBe(code);
  expect((error as BusinessException).getStatus()).toBe(status);
};

// ============================================================================
// 测试
// ============================================================================

describe('AdminUserService', () => {
  let prisma: PrismaStub;
  /** 会话撤销改由 `TokenService` 承担（ADR-032），因此断言它的调用而不是 Redis 键 */
  let tokens: { revokeAllSessions: jest.Mock };
  let audit: { log: jest.Mock };
  let crypto: CryptoService;
  let service: AdminUserService;

  beforeEach(() => {
    prisma = createPrismaStub();

    tokens = { revokeAllSessions: jest.fn().mockResolvedValue(2) };
    audit = { log: jest.fn().mockResolvedValue(true) };
    crypto = new CryptoService(configService);

    service = new AdminUserService(
      prisma as unknown as PrismaService,
      crypto,
      tokens as unknown as TokenService,
      audit as unknown as AdminAuditService,
    );
  });

  // ==========================================================================
  // GET /admin/users
  // ==========================================================================

  describe('listUsers', () => {
    it('返回分页结构（items / total / page / pageSize / hasNext / summary）', async () => {
      prisma.user.findMany.mockResolvedValue([listUserRow()]);
      // 第 1 次 count 属于列表 total，其后 6 次属于 summary（调用顺序由 listUsers 的 Promise.all 决定）
      prisma.user.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(18420)
        .mockResolvedValueOnce(18390)
        .mockResolvedValueOnce(12)
        .mockResolvedValueOnce(1420)
        .mockResolvedValueOnce(18)
        .mockResolvedValueOnce(236);

      const result = await service.listUsers({}, OPERATOR);

      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.hasNext).toBe(false);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        userId: USER_ID,
        nickname: '小满',
        status: 'ACTIVE',
        mbtiType: 'INFJ',
        profileVersion: 3,
        isMember: false,
        orderCount: 0,
        totalPaidAmount: 0,
        isBanned: false,
        hasDeletionRequest: false,
        riskFlags: [],
      });
      expect(result.items[0]?.ageRange).toMatch(/^\d+-\d+$/);
      expect(result.summary).toEqual({
        totalUsers: 18420,
        activeUsers: 18390,
        bannedUsers: 12,
        memberUsers: 1420,
        pendingDeletionUsers: 18,
        newUsersToday: 236,
      });
    });

    it('【隐私】列表不返回 openid 原文与手机号明文，openid 只给哈希', async () => {
      prisma.user.findMany.mockResolvedValue([listUserRow({ phoneHash: crypto.sha256Salted(PLAIN_PHONE) })]);
      prisma.userPhoneHistory.findMany.mockResolvedValue([{ userId: USER_ID, phoneMasked: '138****5678' }]);

      const result = await service.listUsers({}, OPERATOR);
      const serialized = JSON.stringify(result);

      expect(result.items[0]?.phoneBound).toBe(true);
      expect(result.items[0]?.phoneMasked).toBe('138****5678');
      expect(result.items[0]?.openidHash).toBe(crypto.sha256(OPENID));
      expect(serialized).not.toContain(OPENID);
      expect(serialized).not.toContain(PLAIN_PHONE);
      expect(serialized).not.toContain('phoneEnc');
      expect(serialized).not.toContain('sessionKey');
    });

    it('【契约规则 1】手机号关键字走加盐哈希精确匹配，绝不模糊查询手机号', async () => {
      await service.listUsers({ keyword: PLAIN_PHONE }, OPERATOR);

      const firstCall = prisma.user.findMany.mock.calls[0]?.[0] as { where: { AND: Array<Record<string, unknown>> } };
      const orConditions = firstCall.where.AND.flatMap((item) =>
        Array.isArray(item['OR']) ? (item['OR'] as unknown[]) : [],
      );
      const phoneCondition = orConditions.find(
        (item): item is { phoneHash: string } => typeof item === 'object' && item !== null && 'phoneHash' in item,
      );

      expect(phoneCondition?.phoneHash).toBe(crypto.sha256Salted(PLAIN_PHONE));
      // 手机号分支只能是精确值（字符串），不能是 { contains: ... }
      expect(typeof phoneCondition?.phoneHash).toBe('string');
    });

    it('【契约规则 5】列表查询必须写审计（含查询条件）', async () => {
      await service.listUsers({ page: 2, pageSize: 50, status: 'ACTIVE' }, OPERATOR);

      expect(audit.log).toHaveBeenCalledTimes(1);
      const entry = audit.log.mock.calls[0]?.[0] as AdminAuditEntry;

      expect(entry.action).toBe('EXPORT');
      expect(entry.resourceType).toBe('user');
      expect(entry.diffSummary).toContain('user:user:read');
      expect(entry.diffSummary).toContain('page=2');
      expect(entry.diffSummary).toContain('status=ACTIVE');
      expect(entry.ip).toBe('10.0.0.1');
      expect(entry.requestId).toBe('req_test_1');
    });

    it('【契约错误码 10005】pageSize > 100 → 400', async () => {
      await expectBusinessError(service.listUsers({ pageSize: 101 }, OPERATOR), ErrorCode.PAYLOAD_TOO_LARGE, 400);
    });

    it('【契约错误码 10004】sortBy 不在白名单 → 400', async () => {
      await expectBusinessError(service.listUsers({ sortBy: 'nickname' }, OPERATOR), ErrorCode.METHOD_NOT_ALLOWED, 400);
    });

    it('【契约错误码 10001】status 含非法枚举 → 400', async () => {
      await expectBusinessError(
        service.listUsers({ status: 'ACTIVE,UNKNOWN_STATUS' }, OPERATOR),
        ErrorCode.PARAM_INVALID,
        400,
      );
    });

    it('【契约错误码 10001】mbtiType 非 16 型 → 400', async () => {
      await expectBusinessError(service.listUsers({ mbtiType: 'XXXX' }, OPERATOR), ErrorCode.PARAM_INVALID, 400);
    });

    it('mbtiType 大小写不敏感：小写入参归一化为大写后再查库', async () => {
      await service.listUsers({ mbtiType: 'infj' }, OPERATOR);

      const call = prisma.user.findMany.mock.calls[0]?.[0] as { where: unknown };
      expect(JSON.stringify(call.where)).toContain('INFJ');
      expect(JSON.stringify(call.where)).not.toContain('infj');
    });

    it('【展示态映射】DISABLED → BANNED、冷静期 → PENDING_DELETION、匿名化 → DELETED', async () => {
      prisma.user.findMany.mockResolvedValue([
        listUserRow({ id: 'user-banned', status: 'DISABLED' }),
        listUserRow({ id: 'user-deleting', status: 'ACTIVE' }),
        listUserRow({ id: 'user-deleted', status: 'DELETED' }),
      ]);
      prisma.userDeletionRequest.findMany.mockResolvedValue([{ userId: 'user-deleting' }]);
      prisma.adminAuditLog.findMany.mockResolvedValue([
        { targetUserId: 'user-banned', afterData: banAuditAfterData() },
      ]);

      const result = await service.listUsers({}, OPERATOR);
      const byId = new Map(result.items.map((item) => [item.userId, item]));

      expect(byId.get('user-banned')?.status).toBe('BANNED');
      expect(byId.get('user-banned')?.isBanned).toBe(true);
      expect(byId.get('user-banned')?.bannedReason).toBe('AI_ABUSE');
      expect(byId.get('user-deleting')?.status).toBe('PENDING_DELETION');
      expect(byId.get('user-deleting')?.hasDeletionRequest).toBe(true);
      expect(byId.get('user-deleted')?.status).toBe('DELETED');
    });

    it('按累计支付金额排序时用 groupBy 求和，且金额相同时按注册时间稳定排序', async () => {
      prisma.user.findMany
        .mockResolvedValueOnce([
          { id: 'user-a', createdAt: new Date('2026-02-01T00:00:00.000Z') },
          { id: 'user-b', createdAt: new Date('2026-02-02T00:00:00.000Z') },
        ])
        .mockResolvedValueOnce([listUserRow({ id: 'user-b' }), listUserRow({ id: 'user-a' })]);
      prisma.order.groupBy.mockResolvedValue([
        { userId: 'user-a', _sum: { paidAmount: 9900 }, _count: { _all: 1 } },
        { userId: 'user-b', _sum: { paidAmount: 3900 }, _count: { _all: 1 } },
      ]);

      const result = await service.listUsers({ sortBy: 'totalPaidAmount', order: 'desc' }, OPERATOR);

      expect(result.total).toBe(2);
      expect(result.items.map((item) => item.userId)).toEqual(['user-a', 'user-b']);
    });
  });

  // ==========================================================================
  // GET /admin/users/{id}
  // ==========================================================================

  describe('getUserDetail', () => {
    it('【契约默认 include】orders / membership / consents 返回，未请求的块不出现 key', async () => {
      prisma.user.findUnique.mockResolvedValue(detailUserRow());

      const result = await service.getUserDetail(USER_ID, undefined, OPERATOR);

      expect(result.user.userId).toBe(USER_ID);
      expect(result.user.status).toBe('ACTIVE');
      expect(result.serverTime).toBeDefined();
      expect(result.orders).toBeDefined();
      expect(result.membership).toBeDefined();
      expect(result.consents).toBeDefined();
      expect('reports' in result).toBe(false);
      expect('relationships' in result).toBe(false);
      expect('aiUsage' in result).toBe(false);
      expect('deletion' in result).toBe(false);
      expect('auditTrail' in result).toBe(false);
      expect('testSessions' in result).toBe(false);
    });

    it('【契约规则 3】查看详情写审计，记录操作人与查询范围', async () => {
      prisma.user.findUnique.mockResolvedValue(detailUserRow());

      await service.getUserDetail(USER_ID, 'orders,membership,reports', OPERATOR);

      const entry = audit.log.mock.calls[0]?.[0] as AdminAuditEntry;
      expect(entry.action).toBe('EXPORT');
      expect(entry.targetUserId).toBe(USER_ID);
      expect(entry.resourceId).toBe(USER_ID);
      expect(entry.diffSummary).toContain('user:user:read');
      expect(entry.diffSummary).toContain('include=orders,membership,reports');
    });

    it('【契约规则 1】aiUsage 只返回计量数据，响应中不含对话原文', async () => {
      prisma.user.findUnique.mockResolvedValue(detailUserRow());
      prisma.aiMessage.aggregate
        .mockResolvedValueOnce({ _count: { _all: 126 }, _sum: { totalTokens: 348620, costAmount: 742 } })
        .mockResolvedValueOnce({ _count: { _all: 3 }, _sum: { totalTokens: 9860 } });
      prisma.aiConversation.count.mockResolvedValue(3);
      prisma.aiMessage.count.mockResolvedValue(1);
      prisma.aiMessage.findFirst.mockResolvedValue({ createdAt: new Date('2026-02-14T16:25:04.000Z') });

      const result = await service.getUserDetail(USER_ID, 'aiUsage', OPERATOR);

      expect(result.aiUsage).toEqual({
        totalMessages: 126,
        totalTokens: 348620,
        totalCostCents: 742,
        todayMessages: 3,
        todayTokens: 9860,
        conversationCount: 3,
        safetyBlockedCount: 1,
        lastMessageAt: '2026-02-14T16:25:04.000Z',
      });
      // 不提供任何读取消息正文的能力：全程未查询 aiMessage 的内容字段
      expect(JSON.stringify(result)).not.toContain('content');
    });

    it('【契约规则 2】手机号只返回脱敏值', async () => {
      prisma.user.findUnique.mockResolvedValue(
        detailUserRow({ phoneHash: crypto.sha256Salted(PLAIN_PHONE), phoneEnc: crypto.encrypt(PLAIN_PHONE) }),
      );
      prisma.userPhoneHistory.findFirst.mockResolvedValue({ phoneMasked: '138****5678' });

      const result = await service.getUserDetail(USER_ID, undefined, OPERATOR);
      const serialized = JSON.stringify(result);

      expect(result.user.phoneBound).toBe(true);
      expect(result.user.phoneMasked).toBe('138****5678');
      expect(serialized).not.toContain(PLAIN_PHONE);
      expect(serialized).not.toContain(OPENID);
      expect(result.user.openidHash).toBe(crypto.sha256(OPENID));
    });

    it('consents 固定返回 5 类，未同意项为 agreed: false', async () => {
      prisma.user.findUnique.mockResolvedValue(detailUserRow());
      prisma.userConsent.findMany.mockResolvedValue([
        {
          type: 'PRIVACY_POLICY',
          policyVersion: '2.1.0',
          agreed: true,
          agreedAt: new Date('2026-02-01T03:12:50.000Z'),
          revokedAt: null,
          channel: 'MINIAPP',
        },
      ]);

      const result = await service.getUserDetail(USER_ID, 'consents', OPERATOR);

      expect(result.consents).toHaveLength(5);
      expect(result.consents?.[0]).toEqual({
        type: 'PRIVACY_POLICY',
        version: '2.1.0',
        agreed: true,
        agreedAt: '2026-02-01T03:12:50.000Z',
        channel: 'MINIAPP',
      });
      expect(result.consents?.[4]).toEqual({
        type: 'MARKETING',
        version: null,
        agreed: false,
        agreedAt: null,
        channel: null,
      });
    });

    it('【契约错误码 10001】include 含白名单外值 → 400', async () => {
      await expectBusinessError(service.getUserDetail(USER_ID, 'orders,nope', OPERATOR), ErrorCode.PARAM_INVALID, 400);
    });

    it('【契约错误码 30001】用户不存在 → 404（本项目用语义等同的 30000）', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expectBusinessError(service.getUserDetail(USER_ID, undefined, OPERATOR), ErrorCode.USER_NOT_FOUND, 404);
    });

    it('【契约错误码 30001】用户已完全匿名化 → 404', async () => {
      prisma.user.findUnique.mockResolvedValue(detailUserRow({ status: 'DELETED', anonymizedAt: new Date() }));

      await expectBusinessError(service.getUserDetail(USER_ID, undefined, OPERATOR), ErrorCode.USER_NOT_FOUND, 404);
    });

    it('【契约错误码 10003】id 非合法 UUID → 400（本项目用 10001）', async () => {
      await expectBusinessError(service.getUserDetail('not-a-uuid', undefined, OPERATOR), ErrorCode.PARAM_INVALID, 400);
    });
  });

  // ==========================================================================
  // POST /admin/users/{id}/ban
  // ==========================================================================

  describe('banUser', () => {
    const banDto = { reason: 'AI_ABUSE' as const, reasonDetail: '疑似脚本刷量', durationDays: 30 };

    it('封禁成功：状态置 DISABLED、撤销会话、通知用户、写 before/after 审计并返回审计 ID', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow());
      prisma.userSession.findMany.mockResolvedValue([{ jti: 'jti-1' }, { jti: 'jti-2' }]);
      prisma.userSession.updateMany.mockResolvedValue({ count: 2 });

      const before = Date.now();
      const result = await service.banUser(USER_ID, banDto, OPERATOR);

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update.mock.calls[0]?.[0]).toMatchObject({
        where: { id: USER_ID },
        data: { status: 'DISABLED' },
      });

      expect(result).toMatchObject({
        userId: USER_ID,
        nickname: '小满',
        previousStatus: 'ACTIVE',
        status: 'BANNED',
        banType: 'TEMPORARY',
        reason: 'AI_ABUSE',
        reasonDetail: '疑似脚本刷量',
        isPermanent: false,
        revokedSessions: 2,
        notifiedUser: true,
        auditLogId: 'audit-log-1',
      });
      expect(result.bannedBy).toEqual({ adminId: ADMIN_ID, displayName: '超级管理员' });
      expect(result.affectedResources.activeMembershipPreserved).toBe(true);

      const expiresAt = new Date(result.expiresAt as string);
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 86_400_000 - 5_000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 5_000);

      // 会话撤销：委托给 TokenService（它负责 RT 失效、AT 拉黑与复用标记）。
      // 这里只断言「以什么理由撤销了谁的会话」—— Redis 键布局属 auth 模块内部实现，
      // 在本模块断死它会形成跨模块耦合（ADR-032）。
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith(USER_ID, 'ADMIN_BANNED');

      // 通知（站内）
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);

      // 审计：契约规则 5 要求 before/after
      const entry = audit.log.mock.calls[0]?.[0] as AdminAuditEntry;
      expect(entry.action).toBe('UPDATE');
      expect(entry.beforeData).toEqual({ status: 'ACTIVE' });
      expect(entry.afterData).toMatchObject({
        status: 'BANNED',
        ban: true,
        reason: 'AI_ABUSE',
        reasonDetail: '疑似脚本刷量',
        banType: 'TEMPORARY',
        durationDays: 30,
        revokedSessions: 2,
      });
      expect(entry.reason).toBe('AI_ABUSE');
      expect(entry.diffSummary).toContain('user:user:write');
    });

    it('不传 durationDays → 永久封禁（banType PERMANENT、expiresAt null）', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow());

      const result = await service.banUser(USER_ID, { reason: 'FRAUD' }, OPERATOR);

      expect(result.banType).toBe('PERMANENT');
      expect(result.isPermanent).toBe(true);
      expect(result.expiresAt).toBeNull();
    });

    it('revokeSessions = false 时不撤销会话；notifyUser = false 时不发通知', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow());
      prisma.userSession.findMany.mockResolvedValue([{ jti: 'jti-1' }]);

      const result = await service.banUser(
        USER_ID,
        { reason: 'ABUSE', revokeSessions: false, notifyUser: false },
        OPERATOR,
      );

      expect(result.revokedSessions).toBe(0);
      expect(result.notifiedUser).toBe(false);
      expect(prisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('【幂等】已封禁再封禁：不改状态、不撤会话、不重复通知，返回当前封禁事实', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'DISABLED' }));
      prisma.adminAuditLog.findMany.mockResolvedValue([{ afterData: banAuditAfterData({ reason: 'FRAUD' }) }]);

      const result = await service.banUser(USER_ID, banDto, OPERATOR);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        previousStatus: 'BANNED',
        status: 'BANNED',
        // 回填的是**原始封禁参数**，而不是本次请求体（否则会误导为「封禁原因被改了」）
        reason: 'FRAUD',
        revokedSessions: 0,
        notifiedUser: false,
      });

      const entry = audit.log.mock.calls[0]?.[0] as AdminAuditEntry;
      expect(entry.afterData).toMatchObject({ status: 'BANNED', idempotent: true });
    });

    it('【契约错误码 10002】缺 reason → 400', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow());

      await expectBusinessError(service.banUser(USER_ID, {}, OPERATOR), ErrorCode.RESOURCE_NOT_FOUND, 400);
    });

    it('【契约错误码 10002】reason = OTHER 但缺 reasonDetail → 400', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow());

      await expectBusinessError(
        service.banUser(USER_ID, { reason: 'OTHER' }, OPERATOR),
        ErrorCode.RESOURCE_NOT_FOUND,
        400,
      );
    });

    it('【契约错误码 30001】用户不存在 → 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expectBusinessError(service.banUser(USER_ID, { reason: 'ABUSE' }, OPERATOR), ErrorCode.USER_NOT_FOUND, 404);
    });

    it('已注销用户不可封禁 → 30014（409）', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'DELETED', anonymizedAt: new Date() }));

      await expectBusinessError(
        service.banUser(USER_ID, { reason: 'ABUSE' }, OPERATOR),
        ErrorCode.DELETION_ALREADY_COMPLETED,
        409,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('【契约 §3.14.2.3】注销冷静期用户仍允许封禁（不返回 30012）', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ deletionRequests: [{ id: 'deletion-1' }] }));

      const result = await service.banUser(USER_ID, { reason: 'ABUSE' }, OPERATOR);

      expect(result.previousStatus).toBe('PENDING_DELETION');
      expect(result.status).toBe('BANNED');
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // POST /admin/users/{id}/unban
  // ==========================================================================

  describe('unbanUser', () => {
    it('解封成功（有生效会员）：会员延期 7 天 + 发放 MEMBERSHIP_ACTIVE 权益 + 回填 previousBan', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'DISABLED' }));
      prisma.adminAuditLog.findMany.mockResolvedValue([{ afterData: banAuditAfterData() }]);
      const expireAt = new Date('2026-03-14T10:00:00.000Z');
      prisma.membership.findFirst.mockResolvedValue({ id: 'membership-1', expireAt });
      prisma.entitlement.findFirst.mockResolvedValue({ id: 'entitlement-1' });
      prisma.entitlement.update.mockResolvedValue({ id: 'entitlement-1' });

      const result = await service.unbanUser(
        USER_ID,
        { reason: '申诉通过：误判', restoreCompensation: true },
        OPERATOR,
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      });

      const extended = new Date(expireAt.getTime() + 7 * 86_400_000);
      expect(prisma.membership.update).toHaveBeenCalledWith({
        where: { id: 'membership-1' },
        data: { expireAt: extended },
      });

      expect(result).toMatchObject({
        previousStatus: 'BANNED',
        status: 'ACTIVE',
        reason: '申诉通过：误判',
        notifiedUser: true,
        auditLogId: 'audit-log-1',
      });
      expect(result.previousBan).toEqual({
        reason: 'AI_ABUSE',
        bannedAt: '2026-02-14T19:15:00.000Z',
        expiresAt: '2026-03-16T19:15:00.000Z',
        // 30 天 = 2592000 秒（按 expiresAt - bannedAt 实算）
        durationSeconds: 2_592_000,
      });
      expect(result.compensation).toMatchObject({
        granted: true,
        entitlementId: 'entitlement-1',
        type: 'MEMBERSHIP_ACTIVE',
        durationDays: 7,
        expiresAt: extended.toISOString(),
      });

      // 补偿是资金相关操作：单独写一条 GRANT 审计
      const actions = audit.log.mock.calls.map((call) => (call[0] as AdminAuditEntry).action);
      expect(actions).toContain('MANUAL_FULFILL');

      // 解封审计记录 before/after
      const unbanEntry = audit.log.mock.calls
        .map((call) => call[0] as AdminAuditEntry)
        .find((entry) => entry.resourceType === 'user');
      expect(unbanEntry?.beforeData).toMatchObject({ status: 'BANNED' });
      expect(unbanEntry?.afterData).toMatchObject({ status: 'ACTIVE', compensationGranted: true });
    });

    it('解封成功（无生效会员）：改发等值 AI 次数权益', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'DISABLED' }));
      prisma.membership.findFirst.mockResolvedValue(null);
      prisma.entitlement.create.mockResolvedValue({ id: 'entitlement-ai' });

      const result = await service.unbanUser(USER_ID, { reason: '误判', restoreCompensation: true }, OPERATOR);

      expect(prisma.entitlement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'AI_CREDITS', status: 'ACTIVE', usedQuota: 0 }),
        }),
      );
      expect(result.compensation).toMatchObject({
        granted: true,
        entitlementId: 'entitlement-ai',
        type: 'AI_CREDITS',
      });
    });

    it('restoreCompensation = false 时不发放补偿', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'DISABLED' }));

      const result = await service.unbanUser(USER_ID, { reason: '误判' }, OPERATOR);

      expect(result.compensation).toEqual({
        granted: false,
        entitlementId: null,
        type: null,
        durationDays: 0,
        expiresAt: null,
        note: null,
      });
      expect(prisma.entitlement.create).not.toHaveBeenCalled();
      expect(prisma.membership.update).not.toHaveBeenCalled();
    });

    it('【幂等】未封禁时返回当前状态，不改状态、不发通知、不发补偿', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'ACTIVE' }));

      const result = await service.unbanUser(USER_ID, { reason: '误判', restoreCompensation: true }, OPERATOR);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(prisma.entitlement.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        previousStatus: 'ACTIVE',
        status: 'ACTIVE',
        notifiedUser: false,
      });
      expect(result.compensation.granted).toBe(false);

      const entry = audit.log.mock.calls[0]?.[0] as AdminAuditEntry;
      expect(entry.diffSummary).toContain('幂等命中');
    });

    it('【契约错误码 30014】已注销用户无法解封（409）', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'DELETED', anonymizedAt: new Date() }));

      await expectBusinessError(
        service.unbanUser(USER_ID, { reason: '误判' }, OPERATOR),
        ErrorCode.DELETION_ALREADY_COMPLETED,
        409,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('【契约错误码 10002】缺 reason → 400', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'DISABLED' }));

      await expectBusinessError(service.unbanUser(USER_ID, {}, OPERATOR), ErrorCode.RESOURCE_NOT_FOUND, 400);
    });

    it('【契约错误码 30001】用户不存在 → 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expectBusinessError(
        service.unbanUser(USER_ID, { reason: '误判' }, OPERATOR),
        ErrorCode.USER_NOT_FOUND,
        404,
      );
    });

    it('【契约规则 1】解封不恢复已撤销的会话（不触碰 user_sessions / 黑名单）', async () => {
      prisma.user.findUnique.mockResolvedValue(mutationUserRow({ status: 'DISABLED' }));

      await service.unbanUser(USER_ID, { reason: '误判' }, OPERATOR);

      expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
    });
  });
});
