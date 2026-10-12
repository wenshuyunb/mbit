/**
 * 重新生成服务测试（契约 §3.5.7）
 *
 * 覆盖四类容易出错的边界：
 *   · **会员门槛**：非会员必须在创建任何数据之前被拒（否则白生成一份报告）；
 *   · **幂等**：重放不得重复扣配额、不得重复建报告；
 *   · **强制绕过缓存**：新报告的 `cacheKey` 必须与原报告不同（否则生成结果与原来一模一样）；
 *   · **失败补偿**：入队失败要归还次数并把报告标记为 FAILED。
 */

import type { Queue } from 'bullmq';

import { ErrorCode } from '../../../common/errors/error-code';
import type { CryptoService } from '../../../infra/crypto/crypto.service';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { EntitlementService } from '../../membership/entitlement.service';
import type { SystemConfigService } from '../../system/system-config.service';
import type { ReportGenerationOptionsService } from './report-generation-options.service';
import type { ReportQuotaService } from './report-quota.service';
import { ReportRegenerateService } from './report-regenerate.service';
import type { ReportStreamService } from './report-stream.service';

const USER_ID = 'user-1';
const REPORT_ID = 'report-1';
const NEW_REPORT_ID = 'report-2';

interface Harness {
  service: ReportRegenerateService;
  prisma: {
    aiReport: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    membership: { findFirst: jest.Mock };
    outboxEvent: { create: jest.Mock };
  };
  redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock; key: jest.Mock };
  queue: { add: jest.Mock };
  quota: { consumeWindowQuota: jest.Mock; readWindowQuota: jest.Mock; refundWindowQuota: jest.Mock };
  options: { save: jest.Mock };
  entitlements: { getMembership: jest.Mock };
}

const createHarness = (overrides: { isMember?: boolean } = {}): Harness => {
  const isMember = overrides.isMember ?? true;

  const prisma = {
    aiReport: {
      findFirst: jest.fn().mockResolvedValue({
        id: REPORT_ID,
        type: 'MBTI_REPORT',
        status: 'SUCCEEDED',
        profileId: 'profile-1',
        sessionId: 'session-1',
        relationshipId: null,
        promptTemplateKey: 'report.mbti',
        promptVersionId: 'version-1',
        cacheKey: 'original-cache-key',
        version: 0,
      }),
      create: jest.fn().mockResolvedValue({
        id: NEW_REPORT_ID,
        status: 'QUEUED',
        createdAt: new Date('2026-02-14T14:20:00.000Z'),
      }),
      update: jest.fn().mockResolvedValue({ id: REPORT_ID }),
    },
    membership: { findFirst: jest.fn().mockResolvedValue({ plan: { code: 'MEMBER_MONTHLY' } }) },
    outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'outbox-1' }) },
  };

  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    key: jest.fn((...parts: (string | number)[]) => parts.join(':')),
  };

  const queue = { add: jest.fn().mockResolvedValue({ id: NEW_REPORT_ID }) };

  const quota = {
    consumeWindowQuota: jest.fn().mockResolvedValue({
      used: 1,
      limit: 5,
      remaining: 4,
      resetAt: '2026-02-15T00:00:00.000Z',
    }),
    readWindowQuota: jest.fn().mockResolvedValue({
      used: 1,
      limit: 5,
      remaining: 4,
      resetAt: '2026-02-15T00:00:00.000Z',
    }),
    refundWindowQuota: jest.fn().mockResolvedValue(undefined),
  };

  const options = { save: jest.fn().mockResolvedValue(undefined) };

  const entitlements = {
    getMembership: jest.fn().mockResolvedValue({
      isMember,
      expireAt: isMember ? '2026-03-14T10:00:00.000Z' : null,
      remainingDays: isMember ? 28 : null,
    }),
  };

  const streams = { estimateSeconds: jest.fn().mockResolvedValue(35) };
  const systemConfigs = {
    getEntry: jest.fn().mockResolvedValue({ key: 'reportRegenerateDailyLimit', value: 5 }),
  };

  const service = new ReportRegenerateService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    { sha256: (value: string) => `hash(${value})` } as unknown as CryptoService,
    entitlements as unknown as EntitlementService,
    quota as unknown as ReportQuotaService,
    options as unknown as ReportGenerationOptionsService,
    streams as unknown as ReportStreamService,
    systemConfigs as unknown as SystemConfigService,
    queue as unknown as Queue,
  );

  return { service, prisma, redis, queue, quota, options, entitlements };
};

const request = (overrides: Record<string, unknown> = {}): Parameters<ReportRegenerateService['regenerate']>[0] => ({
  userId: USER_ID,
  reportId: REPORT_ID,
  idempotencyKey: 'idem-key-12345678',
  ...overrides,
});

const createdData = (harness: Harness): Record<string, unknown> =>
  (harness.prisma.aiReport.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;

describe('ReportRegenerateService.regenerate', () => {
  it('非会员被拒（70016 + HTTP 402），且不创建报告、不消耗配额', async () => {
    const harness = createHarness({ isMember: false });

    await expect(harness.service.regenerate(request())).rejects.toMatchObject({
      code: ErrorCode.ENTITLEMENT_REQUIRED,
      logContext: undefined,
    });

    expect(harness.prisma.aiReport.create).not.toHaveBeenCalled();
    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
  });

  it('原报告仍在生成中 → 409（50017）', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findFirst.mockResolvedValue({
      id: REPORT_ID,
      type: 'MBTI_REPORT',
      status: 'GENERATING',
      profileId: 'profile-1',
      sessionId: null,
      relationshipId: null,
      promptTemplateKey: 'report.mbti',
      promptVersionId: 'version-1',
      cacheKey: 'original-cache-key',
      version: 0,
    });

    await expect(harness.service.regenerate(request())).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_GENERATING,
    });
  });

  it('报告不存在或不属于当前用户 → 404（50016）', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findFirst.mockResolvedValue(null);

    await expect(harness.service.regenerate(request())).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_NOT_FOUND,
    });
  });

  it('【关键】成功路径：新报告强制绕过缓存、版本 +1、写入语气/侧重并复用 ai.report 队列', async () => {
    const harness = createHarness();

    const view = await harness.service.regenerate(
      request({ tone: 'DIRECT', focus: ['CAREER'], reason: 'UNSATISFIED', feedback: '希望建议更具体' }),
    );

    const data = createdData(harness);
    expect(data['status']).toBe('QUEUED');
    expect(data['version']).toBe(1);
    expect(data['profileId']).toBe('profile-1');
    // 【关键】与原报告不同的 cacheKey —— 否则会命中缓存、生成结果与原来一模一样
    expect(data['cacheKey']).not.toBe('original-cache-key');
    // 键源串里必须体现"这次改了什么"，便于日后按报告追溯重生成历史
    expect(String(data['cacheKey'])).toContain('v1');
    expect(String(data['cacheKey'])).toContain('DIRECT');

    // 语气/侧重经 Redis 选项通道带到 Worker（ai_reports 没有对应列）
    expect(harness.options.save).toHaveBeenCalledWith(NEW_REPORT_ID, {
      tone: '直接、具体，少铺垫，优先给可执行的结论',
      focus: '职业发展与工作中的行为模式',
    });

    // 复用既有队列与 job name（不另写一套生成）
    expect(harness.queue.add).toHaveBeenCalledWith('generate', { reportId: NEW_REPORT_ID }, { jobId: NEW_REPORT_ID });

    expect(view).toMatchObject({
      reportId: NEW_REPORT_ID,
      taskId: NEW_REPORT_ID,
      supersedesReportId: REPORT_ID,
      status: 'QUEUED',
      regenerationCount: 1,
      remainingCount: 4,
      dailyLimit: 5,
      tone: 'DIRECT',
      focus: ['CAREER'],
      cacheHit: false,
      estimatedSeconds: 35,
      pollUrl: `/api/v1/reports/${NEW_REPORT_ID}/progress`,
      streamUrl: `/api/v1/reports/${NEW_REPORT_ID}/stream`,
    });
    expect(view.entitlement).toEqual({
      type: 'MEMBERSHIP_ACTIVE',
      planCode: 'MEMBER_MONTHLY',
      expiresAt: '2026-03-14T10:00:00.000Z',
    });
  });

  it('keepOriginal=true（默认）时不动原报告；false 时软删除原报告', async () => {
    const keep = createHarness();
    await keep.service.regenerate(request());
    expect(keep.prisma.aiReport.update).not.toHaveBeenCalled();

    const overwrite = createHarness();
    await overwrite.service.regenerate(request({ keepOriginal: false }));
    expect(overwrite.prisma.aiReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: REPORT_ID },
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });

  it('反馈写入 outbox（reason/feedback 有留存，供后台质量抽检）且带唯一幂等键', async () => {
    const harness = createHarness();

    await harness.service.regenerate(request({ reason: 'QUALITY_ISSUE', feedback: '太空泛' }));

    expect(harness.prisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'report.regenerate.feedback',
        aggregateType: 'AiReport',
        aggregateId: NEW_REPORT_ID,
        idempotencyKey: `report.regenerate.feedback:${NEW_REPORT_ID}`,
        payload: expect.objectContaining({
          supersedesReportId: REPORT_ID,
          reason: 'QUALITY_ISSUE',
          feedback: '太空泛',
          tone: 'WARM',
        }) as unknown,
      }),
    });
  });

  it('【关键】幂等重放：命中已有 reportId 时不新建报告、不再扣配额', async () => {
    const harness = createHarness();
    harness.redis.get.mockResolvedValue(NEW_REPORT_ID);
    harness.prisma.aiReport.findFirst.mockImplementation((args: { where: { id: string } }): Promise<unknown> =>
      Promise.resolve(
        args.where.id === NEW_REPORT_ID
          ? {
              id: NEW_REPORT_ID,
              type: 'MBTI_REPORT',
              status: 'QUEUED',
              version: 1,
              createdAt: new Date('2026-02-14T14:20:00.000Z'),
            }
          : null,
      ),
    );

    const view = await harness.service.regenerate(request());

    expect(view.reportId).toBe(NEW_REPORT_ID);
    expect(harness.prisma.aiReport.create).not.toHaveBeenCalled();
    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
    expect(harness.queue.add).not.toHaveBeenCalled();
  });

  it('入队失败：报告标记 FAILED、归还次数、抛队列错误（契约 90005/503 语义）', async () => {
    const harness = createHarness();
    harness.queue.add.mockRejectedValue(new Error('redis gone'));

    await expect(harness.service.regenerate(request())).rejects.toMatchObject({ code: ErrorCode.QUEUE_ERROR });

    expect(harness.prisma.aiReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(harness.quota.refundWindowQuota).toHaveBeenCalledTimes(1);
  });

  it('focus 超过 2 个时抛 10001（且不消耗任何资源）', async () => {
    const harness = createHarness();

    await expect(
      harness.service.regenerate(request({ focus: ['CAREER', 'EMOTION', 'SELF_GROWTH'] })),
    ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });

    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
  });

  it('未传 tone/focus 时使用契约默认值（WARM + 无侧重）', async () => {
    const harness = createHarness();

    const view = await harness.service.regenerate(request());

    expect(view.tone).toBe('WARM');
    expect(view.focus).toEqual([]);
    expect(harness.options.save).toHaveBeenCalledWith(NEW_REPORT_ID, {
      tone: '温和、有温度，多给肯定与陪伴感',
      focus: '均衡覆盖六个板块',
    });
  });

  it('【关键】同参数连续重生成不会撞 cacheKey 唯一约束（键源含随机数）', async () => {
    const harness = createHarness();

    await harness.service.regenerate(request({ tone: 'WARM' }));
    await harness.service.regenerate(request({ tone: 'WARM' }));

    const first = (harness.prisma.aiReport.create.mock.calls[0][0] as { data: { cacheKey: string } }).data.cacheKey;
    const second = (harness.prisma.aiReport.create.mock.calls[1][0] as { data: { cacheKey: string } }).data.cacheKey;

    expect(first).not.toBe(second);
  });
});
