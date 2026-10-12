/**
 * 配额扣减测试（契约 §3.5.7 / §3.5.8 / §3.5.9）
 *
 * 两组主张：
 *   · 时间窗配额：**超限时把本次自增退回去**（否则用户被拒一次就永久少一次机会）；
 *   · 权益配额：扣减是**条件更新**（并发下不会超扣），失败补偿能精确归还。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import { ReportQuotaService, resolveQuotaWindow } from './report-quota.service';

const USER_ID = 'user-1';
const NOW = new Date('2026-02-14T14:00:00.000Z');

interface Harness {
  service: ReportQuotaService;
  redis: {
    incrWithTtl: jest.Mock;
    getCount: jest.Mock;
    key: jest.Mock;
    del: jest.Mock;
    raw: { decr: jest.Mock };
  };
  entitlement: { findFirst: jest.Mock; updateMany: jest.Mock };
}

const createHarness = (): Harness => {
  const redis = {
    incrWithTtl: jest.fn().mockResolvedValue(1),
    getCount: jest.fn().mockResolvedValue(0),
    key: jest.fn((...parts: (string | number)[]) => parts.join(':')),
    del: jest.fn().mockResolvedValue(1),
    raw: { decr: jest.fn().mockResolvedValue(0) },
  };

  const entitlement = {
    findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };

  const prisma = { entitlement } as unknown as PrismaService;

  return {
    service: new ReportQuotaService(prisma, redis as unknown as RedisService),
    redis,
    entitlement,
  };
};

describe('resolveQuotaWindow', () => {
  it('utc-day 窗口在次日 UTC 零点重置，TTL 不超过一天', () => {
    const window = resolveQuotaWindow({ kind: 'utc-day' }, NOW);

    expect(window.bucket).toBe('2026-02-14');
    expect(window.resetAt.toISOString()).toBe('2026-02-15T00:00:00.000Z');
    expect(window.ttlSeconds).toBe(10 * 60 * 60);
  });

  it('【关键】临近午夜时 TTL 至少为 1 秒（0 在 Redis 里表示永不过期）', () => {
    const justBeforeMidnight = new Date('2026-02-14T23:59:59.900Z');
    const window = resolveQuotaWindow({ kind: 'utc-day' }, justBeforeMidnight);

    expect(window.ttlSeconds).toBeGreaterThanOrEqual(1);
  });

  it('seconds 窗口按滚动时长计算', () => {
    const window = resolveQuotaWindow({ kind: 'seconds', seconds: 3600 }, NOW);

    expect(window.ttlSeconds).toBe(3600);
    expect(window.resetAt.toISOString()).toBe('2026-02-14T15:00:00.000Z');
  });
});

describe('ReportQuotaService.consumeWindowQuota', () => {
  it('未超限时返回用量与剩余次数', async () => {
    const harness = createHarness();
    harness.redis.incrWithTtl.mockResolvedValue(2);

    const state = await harness.service.consumeWindowQuota({
      scope: 'report-regenerate',
      userId: USER_ID,
      subject: 'report-1',
      limit: 5,
      window: { kind: 'utc-day' },
      now: NOW,
    });

    expect(state).toEqual({
      used: 2,
      limit: 5,
      remaining: 3,
      resetAt: '2026-02-15T00:00:00.000Z',
    });
  });

  it('【关键】超限时抛 429 并把本次自增退回（不能"每被拒一次就少一次机会"）', async () => {
    const harness = createHarness();
    harness.redis.incrWithTtl.mockResolvedValue(6);

    await expect(
      harness.service.consumeWindowQuota({
        scope: 'report-regenerate',
        userId: USER_ID,
        subject: 'report-1',
        limit: 5,
        window: { kind: 'utc-day' },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, getStatus: expect.any(Function) });

    expect(harness.redis.raw.decr).toHaveBeenCalledTimes(1);
    expect(harness.redis.raw.decr).toHaveBeenCalledWith(harness.redis.incrWithTtl.mock.calls[0][0] as string);
  });

  it('不同对象（reportId）使用不同的计数键（同一用户的另一份报告不受影响）', async () => {
    const harness = createHarness();

    await harness.service.consumeWindowQuota({
      scope: 'report-regenerate',
      userId: USER_ID,
      subject: 'report-A',
      limit: 5,
      window: { kind: 'utc-day' },
      now: NOW,
    });
    await harness.service.consumeWindowQuota({
      scope: 'report-regenerate',
      userId: USER_ID,
      subject: 'report-B',
      limit: 5,
      window: { kind: 'utc-day' },
      now: NOW,
    });

    const keys = harness.redis.incrWithTtl.mock.calls.map((call) => call[0] as string);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('report-A');
  });
});

describe('ReportQuotaService.readWindowQuota / refundWindowQuota', () => {
  it('读取不产生副作用', async () => {
    const harness = createHarness();
    harness.redis.getCount.mockResolvedValue(3);

    const state = await harness.service.readWindowQuota({
      scope: 'report-regenerate',
      userId: USER_ID,
      limit: 5,
      window: { kind: 'utc-day' },
      now: NOW,
    });

    expect(state.remaining).toBe(2);
    expect(harness.redis.incrWithTtl).not.toHaveBeenCalled();
  });

  it('归还一次配额（用于失败补偿）', async () => {
    const harness = createHarness();

    await harness.service.refundWindowQuota({
      scope: 'share-card',
      userId: USER_ID,
      subject: 'report-1',
      window: { kind: 'seconds', seconds: 3600 },
      now: NOW,
    });

    expect(harness.redis.raw.decr).toHaveBeenCalledTimes(1);
  });
});

describe('ReportQuotaService.consumePdfExportEntitlement', () => {
  it('【关键】用条件更新原子扣减（判断与扣减在同一条 SQL）', async () => {
    const harness = createHarness();

    const id = await harness.service.consumePdfExportEntitlement(USER_ID, NOW);

    expect(id).toBe('entitlement-1');
    expect(harness.entitlement.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'entitlement-1',
        // `remainingQuota` 为 NULL 表示"不限次"，同样必须允许通过
        OR: [{ remainingQuota: null }, { remainingQuota: { gt: 0 } }],
      },
      data: { remainingQuota: { decrement: 1 }, usedQuota: { increment: 1 } },
    });
  });

  it('没有可用权益时返回 null（由调用方决定拉起付费墙）', async () => {
    const harness = createHarness();
    harness.entitlement.findFirst.mockResolvedValue(null);

    expect(await harness.service.consumePdfExportEntitlement(USER_ID, NOW)).toBeNull();
    expect(harness.entitlement.updateMany).not.toHaveBeenCalled();
  });

  it('并发下被吃光（更新影响 0 行）时返回 null，不抛错', async () => {
    const harness = createHarness();
    harness.entitlement.updateMany.mockResolvedValue({ count: 0 });

    expect(await harness.service.consumePdfExportEntitlement(USER_ID, NOW)).toBeNull();
  });

  it('归还一次权益额度（失败补偿）', async () => {
    const harness = createHarness();

    await harness.service.refundPdfExportEntitlement('entitlement-1');

    expect(harness.entitlement.updateMany).toHaveBeenCalledWith({
      where: { id: 'entitlement-1' },
      data: { remainingQuota: { increment: 1 }, usedQuota: { decrement: 1 } },
    });
  });

  it('归还失败只记日志，不把错误抛给用户（否则会覆盖"导出失败"这个事实）', async () => {
    const harness = createHarness();
    harness.entitlement.updateMany.mockRejectedValue(new Error('db down'));

    await expect(harness.service.refundPdfExportEntitlement('entitlement-1')).resolves.toBeUndefined();
  });
});
