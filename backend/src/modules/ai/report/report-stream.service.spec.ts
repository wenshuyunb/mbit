/**
 * SSE 流服务测试（契约 §3.5.6）
 *
 * 覆盖：快照组装（实时通道优先、陈旧数据丢弃、终态以库为准）、并发连接名额、
 * 分段事件素材（**只可能含免费预览片段**）、历史耗时估算。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { EntitlementService } from '../../membership/entitlement.service';
import type { ReportLiveProgressService } from './report-live-progress.service';
import { ReportStreamService } from './report-stream.service';

const USER_ID = 'user-1';
const REPORT_ID = 'report-1';
const PAID_TEXT = '付费段落正文，绝不能出现在流事件里。';

interface Harness {
  service: ReportStreamService;
  prisma: {
    aiReport: { findFirst: jest.Mock; findMany: jest.Mock };
    reportSection: { findMany: jest.Mock };
  };
  redis: { key: jest.Mock; sAdd: jest.Mock; sCard: jest.Mock; sRem: jest.Mock; getJson: jest.Mock; setJson: jest.Mock };
  live: { read: jest.Mock };
}

const reportRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: REPORT_ID,
  type: 'MBTI_REPORT',
  status: 'GENERATING',
  progress: 10,
  sectionCount: 0,
  contentLength: 0,
  freePreviewLength: 0,
  provider: 'DEEPSEEK',
  model: 'deepseek-chat',
  retryCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costAmount: 0,
  generationStartedAt: new Date(Date.now() - 30_000),
  generationFinishedAt: null,
  errorCode: null,
  ...overrides,
});

const createHarness = (
  options: { row?: Record<string, unknown>; live?: unknown; unlocked?: boolean; slots?: number } = {},
): Harness => {
  const prisma = {
    aiReport: {
      findFirst: jest.fn().mockResolvedValue(options.row ?? reportRow()),
      findMany: jest.fn().mockResolvedValue([{ latencyMs: 30_000 }, { latencyMs: 50_000 }]),
    },
    reportSection: {
      findMany: jest.fn().mockResolvedValue([
        { sectionKey: 'CORE_PORTRAIT', title: '核心画像', content: '免费正文', order: 1, isFreePreview: true },
        { sectionKey: 'ACTION_PLAN', title: '行动清单', content: PAID_TEXT, order: 2, isFreePreview: false },
      ]),
    },
  };

  const redis = {
    key: jest.fn((...parts: (string | number)[]) => parts.join(':')),
    sAdd: jest.fn().mockResolvedValue(1),
    sCard: jest.fn().mockResolvedValue(options.slots ?? 1),
    sRem: jest.fn().mockResolvedValue(1),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
  };

  const live = { read: jest.fn().mockResolvedValue(options.live ?? null) };

  const entitlements = {
    resolveReportUnlock: jest.fn().mockResolvedValue({
      allUnlocked: options.unlocked ?? false,
      unlockedSectionKeys: new Set<string>(),
      source: 'NONE',
      membership: { isMember: options.unlocked ?? false, expireAt: null, remainingDays: null },
    }),
  };

  return {
    service: new ReportStreamService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      live as unknown as ReportLiveProgressService,
      entitlements as unknown as EntitlementService,
    ),
    prisma,
    redis,
    live,
  };
};

const liveState = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  reportId: REPORT_ID,
  userId: USER_ID,
  status: 'GENERATING',
  stage: 'CALLING_MODEL',
  progress: 18,
  generatedWordCount: 0,
  generatedSectionCount: 0,
  targetSectionCount: 6,
  targetWordCount: 0,
  currentSectionKey: null,
  provider: 'DEEPSEEK',
  model: 'deepseek-chat',
  attempt: 1,
  startedAt: new Date(Date.now() - 4_000).toISOString(),
  finishedAt: null,
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('ReportStreamService.openStream', () => {
  it('报告不存在或不属于当前用户 → 404（50016）', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findFirst.mockResolvedValue(null);

    await expect(harness.service.openStream(USER_ID, REPORT_ID)).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_NOT_FOUND,
    });
  });

  it('已完成的报告不报错（契约规则 1：改由业务规则优先于错误表）', async () => {
    const harness = createHarness({ row: reportRow({ status: 'SUCCEEDED', progress: 100 }) });

    const seed = await harness.service.openStream(USER_ID, REPORT_ID);

    expect(seed.isTerminal).toBe(true);
    expect(seed.status).toBe('SUCCEEDED');
  });
});

describe('ReportStreamService.readSnapshot', () => {
  it('没有实时进度时由 status + progress 兜底推导阶段', async () => {
    const harness = createHarness() as Harness & { prisma: { aiReport: { findFirst: jest.Mock } } };

    const snapshot = await harness.service.readSnapshot(USER_ID, REPORT_ID, 35);

    expect(snapshot.generation.stage).toBe('BUILDING_CONTEXT');
    expect(snapshot.generation.progress).toBe(10);
    expect(snapshot.estimatedSeconds).toBe(35);
    expect(snapshot.generation.usage).toBeNull();
  });

  it('实时进度新鲜时以它为准（阶段/进度/目标段数）', async () => {
    const harness = createHarness({
      live: liveState({ stage: 'GENERATING_SECTIONS', progress: 45, targetSectionCount: 6 }),
    });

    const snapshot = await harness.service.readSnapshot(USER_ID, REPORT_ID);

    expect(snapshot.generation.stage).toBe('GENERATING_SECTIONS');
    expect(snapshot.generation.progress).toBe(45);
    expect(snapshot.generation.targetSectionCount).toBe(6);
  });

  it('【关键】实时进度过旧（超过 5 分钟）时丢弃，回落到读库推导', async () => {
    const harness = createHarness({
      live: liveState({
        stage: 'GENERATING_SECTIONS',
        progress: 45,
        updatedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      }),
    });

    const snapshot = await harness.service.readSnapshot(USER_ID, REPORT_ID);

    expect(snapshot.generation.stage).toBe('BUILDING_CONTEXT');
    expect(snapshot.generation.progress).toBe(10);
  });

  it('【关键】报告已是终态时完全以数据库为准（实时通道的残留不会盖住真实状态）', async () => {
    const harness = createHarness({
      row: reportRow({ status: 'SUCCEEDED', progress: 100, contentLength: 3284, sectionCount: 6 }),
      live: liveState({ stage: 'CALLING_MODEL', progress: 18 }),
    });

    const snapshot = await harness.service.readSnapshot(USER_ID, REPORT_ID);

    expect(snapshot.generation.stage).toBe('DONE');
    expect(snapshot.generation.progress).toBe(100);
    expect(snapshot.generation.generatedWordCount).toBe(3284);
    expect(snapshot.generation.generatedSectionCount).toBe(6);
    expect(snapshot.generation.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostCents: 0,
    });
    // 终态不读实时通道
    expect(harness.live.read).not.toHaveBeenCalled();
  });

  it('失败的报告带出真实错误码与耗时', async () => {
    const harness = createHarness({
      row: reportRow({
        status: 'FAILED',
        progress: 100,
        errorCode: String(ErrorCode.AI_PROVIDER_TIMEOUT),
        generationFinishedAt: new Date(),
      }),
    });

    const snapshot = await harness.service.readSnapshot(USER_ID, REPORT_ID);

    expect(snapshot.generation.stage).toBe('ERROR');
    expect(snapshot.generation.failureCode).toBe(ErrorCode.AI_PROVIDER_TIMEOUT);
    expect(snapshot.generation.usage).toBeNull();
  });

  it('估算总耗时取该用户历史成功报告的均值', async () => {
    const harness = createHarness();

    expect(await harness.service.estimateSeconds(USER_ID, 'MBTI_REPORT')).toBe(40);
  });
});

describe('ReportStreamService.loadSectionInputs', () => {
  it('【关键】未解锁段落不带任何正文（previewText 为 null）', async () => {
    const harness = createHarness();

    const inputs = await harness.service.loadSectionInputs(REPORT_ID, {
      allUnlocked: false,
      unlockedSectionKeys: new Set<string>(),
    });

    expect(inputs[0]?.previewText).toBe('免费正文');
    expect(inputs[1]?.previewText).toBeNull();
    expect(JSON.stringify(inputs)).not.toContain(PAID_TEXT);
    // 元数据仍下发（体量不算内容泄露）
    expect(inputs[1]?.wordCount).toBe(PAID_TEXT.length);
  });

  it('解锁后同一段落的预览片段才出现', async () => {
    const harness = createHarness();

    const inputs = await harness.service.loadSectionInputs(REPORT_ID, {
      allUnlocked: true,
      unlockedSectionKeys: new Set<string>(),
    });

    expect(inputs[1]?.previewText).toBe(PAID_TEXT);
  });
});

describe('ReportStreamService 并发连接名额', () => {
  it('未超过 3 条时发放名额', async () => {
    const harness = createHarness({ slots: 3 });

    const token = await harness.service.acquireConnectionSlot(USER_ID);

    expect(token).toEqual(expect.any(String));
    expect(harness.redis.sAdd).toHaveBeenCalledWith(expect.stringContaining('report:stream:conn'), token, 660);
  });

  it('【关键】超过 3 条时抛 429 并移除自己刚占的名额', async () => {
    const harness = createHarness({ slots: 4 });

    await expect(harness.service.acquireConnectionSlot(USER_ID)).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
    });

    expect(harness.redis.sRem).toHaveBeenCalledTimes(1);
  });

  it('释放名额失败不抛错（最多 11 分钟后由 TTL 兜底）', async () => {
    const harness = createHarness();
    harness.redis.sRem.mockRejectedValue(new Error('redis down'));

    await expect(harness.service.releaseConnectionSlot(USER_ID, 'token')).resolves.toBeUndefined();
  });
});
