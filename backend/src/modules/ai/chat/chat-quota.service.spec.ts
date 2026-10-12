/**
 * 配额服务单测（契约 §3.7.5 规则 4、§3.7.8 规则 1/3）
 *
 * 核心主张（这几条错一次就是真金白银的错）：
 *   · **原子预占**：判定与自增都在 Redis 脚本内完成 —— 超限时**不写入**，
 *     因此不需要"回补"，也就没有"回补前被 kill 导致永久多占额度"的窗口
 *   · **回补不越界**：重复回补只会把计数钳在 0，不会让计数变负（用户白得额度）
 *   · **回补跨日无效**：昨天的额度不能加回今天
 *   · **会员判定走 EntitlementService**（ADR-015），本服务不自己写判定
 *   · **次数包用条件更新**（`WHERE remainingQuota > 0`）挡住并发超扣
 *   · **Redis 故障时降级而非放行**（配额不能 fail-open）
 */

import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { EntitlementService } from '../../membership/entitlement.service';
import type { SystemConfigService } from '../../system/system-config.service';
import { ChatQuotaService, chargeSourceOf } from './chat-quota.service';
import { resolveQuota } from './chat-quota.util';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const NOW = new Date('2026-02-14T10:00:00.000Z');

interface Harness {
  service: ChatQuotaService;
  prisma: {
    entitlement: { findMany: jest.Mock; updateMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    aiUsageLog: { count: jest.Mock };
    membership: { findFirst: jest.Mock };
  };
  redis: {
    key: jest.Mock;
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    setIfAbsent: jest.Mock;
    setJson: jest.Mock;
    getJson: jest.Mock;
    incrWithTtl: jest.Mock;
    raw: { eval: jest.Mock; decr: jest.Mock };
  };
  entitlements: { loadEntitlements: jest.Mock };
  systemConfigs: { getEntry: jest.Mock };
}

const createHarness = (): Harness => {
  const prisma = {
    entitlement: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    aiUsageLog: { count: jest.fn().mockResolvedValue(0) },
    membership: { findFirst: jest.fn().mockResolvedValue(null) },
  };

  const redis = {
    key: jest.fn((...parts: (string | number)[]) => ['sm', ...parts].join(':')),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    setIfAbsent: jest.fn().mockResolvedValue(true),
    setJson: jest.fn().mockResolvedValue(undefined),
    getJson: jest.fn().mockResolvedValue(null),
    incrWithTtl: jest.fn().mockResolvedValue(1),
    raw: {
      eval: jest.fn().mockResolvedValue([1, 1]),
      decr: jest.fn().mockResolvedValue(0),
    },
  };

  const entitlements = { loadEntitlements: jest.fn().mockResolvedValue([]) };

  const systemConfigs = {
    getEntry: jest.fn().mockImplementation((key: string) => {
      if (key === 'freeAiQuotaTotal') return Promise.resolve({ value: 10, rawValue: '10' });
      if (key === 'memberAiDailyLimit') return Promise.resolve({ value: 50, rawValue: '50' });
      if (key === 'aiMessageMaxLength') return Promise.resolve({ value: 2000, rawValue: '2000' });
      if (key === 'ai.maxConcurrentStreams') return Promise.resolve({ value: 3, rawValue: '3' });

      return Promise.resolve(undefined);
    }),
  };

  const service = new ChatQuotaService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    systemConfigs as unknown as SystemConfigService,
    entitlements as unknown as EntitlementService,
  );

  return { service, prisma, redis, entitlements, systemConfigs };
};

describe('ChatQuotaService.resolveAvailability — 会员判定走 EntitlementService', () => {
  it('非会员 + 免费额度：limitedBy = FREE_QUOTA', async () => {
    const h = createHarness();
    h.entitlements.loadEntitlements.mockResolvedValue([]);
    h.prisma.aiUsageLog.count.mockResolvedValue(2);

    const result = await h.service.resolveAvailability(USER_ID, NOW);

    expect(h.entitlements.loadEntitlements).toHaveBeenCalledWith(USER_ID);
    expect(result.isMember).toBe(false);
    expect(result.view.limitedBy).toBe('FREE_QUOTA');
    expect(result.view.remainingToday).toBe(8);
    expect(result.chargeSource).toBe('NONE');
  });

  it('会员（时间段权益）→ 走日额度，chargeSource = DAILY_LIMIT', async () => {
    const h = createHarness();
    h.entitlements.loadEntitlements.mockResolvedValue([
      {
        type: 'MEMBERSHIP_ACTIVE',
        status: 'ACTIVE',
        resourceKey: null,
        reportId: null,
        expireAt: new Date('2026-03-14T10:00:00.000Z'),
        remainingQuota: null,
      },
    ]);
    h.prisma.membership.findFirst.mockResolvedValue({
      expireAt: new Date('2026-03-14T10:00:00.000Z'),
      plan: { code: 'MEMBER_MONTHLY', name: '月度会员', dailyAiQuota: 50 },
    });
    // Redis 计数器：今日已用 3
    h.redis.get.mockResolvedValue(JSON.stringify({ d: '20260214', c: 3 }));

    const result = await h.service.resolveAvailability(USER_ID, NOW);

    expect(result.isMember).toBe(true);
    expect(result.planCode).toBe('MEMBER_MONTHLY');
    expect(result.planName).toBe('月度会员');
    expect(result.view.limitedBy).toBe('DAILY_LIMIT');
    expect(result.view.remainingToday).toBe(47);
    expect(result.chargeSource).toBe('DAILY_LIMIT');
  });

  it('过期会员权益不生效（判定必须带时间窗）', async () => {
    const h = createHarness();
    h.entitlements.loadEntitlements.mockResolvedValue([
      {
        type: 'MEMBERSHIP_ACTIVE',
        status: 'ACTIVE',
        resourceKey: null,
        reportId: null,
        expireAt: new Date('2026-01-01T00:00:00.000Z'),
        remainingQuota: null,
      },
    ]);

    const result = await h.service.resolveAvailability(USER_ID, NOW);

    expect(result.isMember).toBe(false);
    expect(result.expiresAt).toBeNull();
  });
});

describe('ChatQuotaService.reserve — 原子预占', () => {
  it('脚本返回 granted 时给出扣除后的剩余额度', async () => {
    const h = createHarness();
    h.redis.raw.eval.mockResolvedValue([1, 4]); // 授予，本次是第 4 次

    const reservation = await h.service.reserve(USER_ID, 'DAILY_LIMIT', NOW);

    expect(reservation.granted).toBe(true);
    expect(reservation.source).toBe('DAILY_LIMIT');
    expect(reservation.usedToday).toBe(4);
    expect(reservation.remainingToday).toBe(46);
    expect(reservation.reason).toBeNull();
  });

  it('脚本返回 -1（超限）时不授予，且**不产生写入**（因此无需回补）', async () => {
    const h = createHarness();
    h.redis.raw.eval.mockResolvedValue([-1, 50]);

    const reservation = await h.service.reserve(USER_ID, 'DAILY_LIMIT', NOW);

    expect(reservation.granted).toBe(false);
    expect(reservation.source).toBeNull();
    expect(reservation.reason).toBe('DAILY_LIMIT_REACHED');
    expect(reservation.remainingToday).toBe(0);
  });

  it('键里带 UTC+8 日期（跨日自动从 0 开始，不依赖 TTL 准时过期）', async () => {
    const h = createHarness();
    h.redis.raw.eval.mockResolvedValue([1, 1]);

    await h.service.reserve(USER_ID, 'DAILY_LIMIT', NOW);

    const keyArg = h.redis.raw.eval.mock.calls[0]?.[2] as string;
    const dateArg = h.redis.raw.eval.mock.calls[0]?.[3] as string;

    expect(keyArg).toBe(`sm:ai:quota:${USER_ID}:20260214`);
    expect(dateArg).toBe('20260214');
  });

  it('Redis 故障时**降级到 DB 口径**而不是放行（配额不能 fail-open）', async () => {
    const h = createHarness();
    h.redis.raw.eval.mockRejectedValue(new Error('redis down'));
    // DB 口径：今日已用 2（< 50）
    h.prisma.aiUsageLog.count.mockResolvedValue(2);

    const reservation = await h.service.reserve(USER_ID, 'DAILY_LIMIT', NOW);

    expect(reservation.granted).toBe(true);
    expect(reservation.usedToday).toBe(3);
    expect(h.prisma.aiUsageLog.count).toHaveBeenCalled();
  });

  it('Redis 故障且 DB 口径显示已超额 → 拒绝', async () => {
    const h = createHarness();
    h.redis.raw.eval.mockRejectedValue(new Error('redis down'));
    h.prisma.aiUsageLog.count.mockResolvedValue(50);

    const reservation = await h.service.reserve(USER_ID, 'DAILY_LIMIT', NOW);

    expect(reservation.granted).toBe(false);
    expect(reservation.reason).toBe('DAILY_LIMIT_REACHED');
  });
});

describe('ChatQuotaService.reserve — 次数包（条件更新挡并发）', () => {
  it('条件更新影响 1 行时视为扣减成功', async () => {
    const h = createHarness();
    h.prisma.entitlement.findMany
      // 第一次：候选列表
      .mockResolvedValueOnce([
        {
          id: 'ent-1',
          type: 'AI_CREDITS',
          status: 'ACTIVE',
          resourceKey: null,
          reportId: null,
          expireAt: new Date('2026-06-01T00:00:00.000Z'),
          remainingQuota: 3,
        },
      ])
      // 第二次：扣减后重新读余额
      .mockResolvedValueOnce([
        {
          id: 'ent-1',
          type: 'AI_CREDITS',
          status: 'ACTIVE',
          resourceKey: null,
          reportId: null,
          expireAt: new Date('2026-06-01T00:00:00.000Z'),
          remainingQuota: 2,
        },
      ]);
    h.prisma.entitlement.updateMany.mockResolvedValue({ count: 1 });

    const reservation = await h.service.reserve(USER_ID, 'CREDITS', NOW);

    expect(reservation.granted).toBe(true);
    expect(reservation.source).toBe('CREDITS');
    expect(reservation.creditBalance).toBe(2);
    // 条件更新必须带 `remainingQuota > 0`，否则并发下会扣成负数
    expect(h.prisma.entitlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ent-1', remainingQuota: { gt: 0 } },
        data: { remainingQuota: { decrement: 1 }, usedQuota: { increment: 1 } },
      }),
    );
  });

  it('并发导致条件更新影响 0 行时逐个重试下一张次数包', async () => {
    const h = createHarness();
    const rows = ['ent-1', 'ent-2'].map((id) => ({
      id,
      type: 'AI_CREDITS',
      status: 'ACTIVE',
      resourceKey: null,
      reportId: null,
      expireAt: new Date('2026-06-01T00:00:00.000Z'),
      remainingQuota: 1,
    }));

    h.prisma.entitlement.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ ...rows[1], remainingQuota: 0 }]);
    // 第一次被并发抢走，第二次成功
    h.prisma.entitlement.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const reservation = await h.service.reserve(USER_ID, 'CREDITS', NOW);

    expect(reservation.granted).toBe(true);
    expect(h.prisma.entitlement.updateMany).toHaveBeenCalledTimes(2);
  });

  it('过期 / 余额为 0 的次数包不参与扣减', async () => {
    const h = createHarness();
    h.prisma.entitlement.findMany.mockResolvedValue([
      {
        id: 'ent-expired',
        type: 'AI_CREDITS',
        status: 'ACTIVE',
        resourceKey: null,
        reportId: null,
        expireAt: new Date('2026-01-01T00:00:00.000Z'),
        remainingQuota: 5,
      },
      {
        id: 'ent-empty',
        type: 'AI_CREDITS',
        status: 'ACTIVE',
        resourceKey: null,
        reportId: null,
        expireAt: new Date('2026-06-01T00:00:00.000Z'),
        remainingQuota: 0,
      },
    ]);

    const reservation = await h.service.reserve(USER_ID, 'CREDITS', NOW);

    expect(reservation.granted).toBe(false);
    expect(reservation.reason).toBe('CREDITS_EXHAUSTED');
    expect(h.prisma.entitlement.updateMany).not.toHaveBeenCalled();
  });
});

describe('ChatQuotaService.refund — 回补', () => {
  it('脚本按日期校验后递减（跨日不回补）', async () => {
    const h = createHarness();
    h.redis.raw.eval.mockResolvedValue(3);

    await h.service.refund(USER_ID, 'DAILY_LIMIT', NOW);

    const [, , key, day] = h.redis.raw.eval.mock.calls[0] as [string, number, string, string];
    expect(key).toBe(`sm:ai:quota:${USER_ID}:20260214`);
    expect(day).toBe('20260214');
  });

  it('Redis 异常不抛错（回补失败必须留痕，但不能打断用户的重试）', async () => {
    const h = createHarness();
    h.redis.raw.eval.mockRejectedValue(new Error('redis down'));

    await expect(h.service.refund(USER_ID, 'DAILY_LIMIT', NOW)).resolves.toBeUndefined();
  });

  it('次数包回补受 totalQuota 上限保护（重复回补不能刷高额度）', async () => {
    const h = createHarness();
    h.prisma.entitlement.findFirst.mockResolvedValue({
      id: 'ent-1',
      totalQuota: 5,
      usedQuota: 1,
      remainingQuota: 5, // 已经是满额（异常数据）
    });

    await h.service.refund(USER_ID, 'CREDITS', NOW);

    expect(h.prisma.entitlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ent-1' },
        data: { remainingQuota: 5, usedQuota: 0 },
      }),
    );
  });
});

describe('ChatQuotaService — 并发 SSE 名额', () => {
  it('未超限时授予名额', async () => {
    const h = createHarness();
    h.redis.incrWithTtl.mockResolvedValue(2);

    await expect(h.service.acquireStreamSlot(USER_ID, 3)).resolves.toEqual({ acquired: true, active: 2 });
  });

  it('超过上限时立即回退计数并拒绝（不能让判定把自己算进去）', async () => {
    const h = createHarness();
    h.redis.incrWithTtl.mockResolvedValue(4);

    const result = await h.service.acquireStreamSlot(USER_ID, 3);

    expect(result).toEqual({ acquired: false, active: 3 });
    expect(h.redis.raw.decr).toHaveBeenCalled();
  });

  it('Redis 故障时放行（并发上限是防刷，不是合规红线）', async () => {
    const h = createHarness();
    h.redis.incrWithTtl.mockRejectedValue(new Error('redis down'));

    await expect(h.service.acquireStreamSlot(USER_ID, 3)).resolves.toEqual({ acquired: true, active: -1 });
  });

  it('释放名额用 Lua 保证不会降到 0 以下', async () => {
    const h = createHarness();
    h.redis.raw.eval.mockResolvedValue(0);

    await h.service.releaseStreamSlot(USER_ID);

    const script = h.redis.raw.eval.mock.calls[0]?.[0] as string;
    expect(script).toContain('DEL');
    expect(script).toContain('DECR');
  });
});

describe('ChatQuotaService — 幂等', () => {
  it('首次占位成功返回 true；重复占位返回 false 并可读出结果', async () => {
    const h = createHarness();
    h.redis.setIfAbsent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    h.redis.get.mockResolvedValue(JSON.stringify({ state: 'DONE', result: { conversationId: 'c1' } }));

    expect(await h.service.claimIdempotency('message', USER_ID, 'idem-key-12345678')).toBe(true);
    expect(await h.service.claimIdempotency('message', USER_ID, 'idem-key-12345678')).toBe(false);
    await expect(h.service.readIdempotentResult('message', USER_ID, 'idem-key-12345678')).resolves.toEqual({
      conversationId: 'c1',
    });
  });

  it('只有 DONE 状态的结果可被重放（PENDING 视为"仍在处理中"）', async () => {
    const h = createHarness();
    h.redis.get.mockResolvedValue(JSON.stringify({ state: 'PENDING' }));

    await expect(h.service.readIdempotentResult('message', USER_ID, 'idem-key-12345678')).resolves.toBeNull();
  });

  it('脏值按"没有结果"处理（宁可让用户重发，也不返回解析不出的东西）', async () => {
    const h = createHarness();
    h.redis.get.mockResolvedValue('not-json');

    await expect(h.service.readIdempotentResult('message', USER_ID, 'idem-key-12345678')).resolves.toBeNull();
  });

  it('占位失败时**继续抛出**（放行等于幂等失效 = 可能重复扣额度）', async () => {
    const h = createHarness();
    h.redis.setIfAbsent.mockRejectedValue(new Error('redis down'));

    await expect(h.service.claimIdempotency('message', USER_ID, 'idem-key-12345678')).rejects.toThrow('redis down');
  });
});

describe('ChatQuotaService.enforceRateLimit — userId 维度限流', () => {
  it('未超限时通过', async () => {
    const h = createHarness();
    h.redis.incrWithTtl.mockResolvedValue(3);

    await expect(h.service.enforceRateLimit(USER_ID, 'message', 10, 60)).resolves.toBeUndefined();
  });

  it('超限时抛 RATE_LIMITED（429）', async () => {
    const h = createHarness();
    h.redis.incrWithTtl.mockResolvedValue(11);

    await expect(h.service.enforceRateLimit(USER_ID, 'message', 10, 60)).rejects.toMatchObject({
      code: 10007,
      status: 429,
    });
  });

  it('Redis 故障时放行（限流是防滥用，不是正确性）', async () => {
    const h = createHarness();
    h.redis.incrWithTtl.mockRejectedValue(new Error('redis down'));

    await expect(h.service.enforceRateLimit(USER_ID, 'message', 10, 60)).resolves.toBeUndefined();
  });
});

describe('chargeSourceOf — 计费来源映射', () => {
  it('耗尽时为 null（调用方据此抛 402）', () => {
    const view = resolveQuota({
      isMember: false,
      memberDailyLimit: 50,
      usedToday: 0,
      creditBalance: 0,
      freeQuotaTotal: 10,
      freeQuotaUsed: 10,
      fallbackDailyLimit: 0,
      now: NOW,
    });

    expect(chargeSourceOf(view, false)).toBeNull();
  });

  it('会员日额度用尽但有次数包 → 扣次数包', () => {
    const view = resolveQuota({
      isMember: true,
      memberDailyLimit: 50,
      usedToday: 50,
      creditBalance: 4,
      freeQuotaTotal: 10,
      freeQuotaUsed: 0,
      fallbackDailyLimit: 0,
      now: NOW,
    });

    expect(chargeSourceOf(view, true)).toBe('CREDITS');
  });

  it('免费额度来源不需要预占（没有可递减的行）', () => {
    const view = resolveQuota({
      isMember: false,
      memberDailyLimit: 50,
      usedToday: 0,
      creditBalance: 0,
      freeQuotaTotal: 10,
      freeQuotaUsed: 1,
      fallbackDailyLimit: 0,
      now: NOW,
    });

    expect(chargeSourceOf(view, false)).toBe('NONE');
  });
});
