/**
 * 匹配报告详情与进度测试（契约 §3.6.10 / §3.6.11）
 *
 * 三组最重要的主张：
 *   · **IDOR 防护**：`报告 → 关系 → 我是双方之一`，任一层不满足都返回 `60010`（404），
 *     而不是 403 —— 403 会告诉攻击者这个报告 ID 真实存在
 *   · **服务端裁剪**：未解锁时 `aiInsights` / `profileComparison` 必须为 `null`，
 *     并把被隐藏的板块列进 `freePreview.excludes`（绝不下发 AI 全文）
 *   · **失败不返回 5xx**：`ERROR` / `PARTIAL` 都以 200 返回并附重试建议
 */

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import type { Queue } from 'bullmq';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ErrorCode } from '../../common/errors/error-code';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { ReportService } from '../ai/report/report.service';
import type { EntitlementService } from '../membership/entitlement.service';
import { CompatibilityReportController } from './compatibility-report.controller';
import { CompatibilityService } from './compatibility.service';
import {
  AI_TARGET_ITEM_COUNT,
  attachmentRiskLevel,
  bigFiveGapLevel,
  buildProfileComparison,
  buildScoreBreakdownDimensions,
  buildStageTimeline,
  countGeneratedItems,
  resolveOverallStatus,
  resolveProgressPercent,
  resolveRetryAdvice,
  scoreRingColor,
} from './compatibility-report.util';

const ME = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';
const REPORT_ID = '0195f3a2-e57b-7db9-9e24-a0db7e8f9c78';
const RELATIONSHIP_ID = '0195f3a2-d46a-7ca8-8d13-9fca6d7e8b67';

// ============================================================================
// 纯逻辑：进度状态映射
// ============================================================================

describe('resolveOverallStatus（契约 §3.6.11 的阶段枚举）', () => {
  it('按两个状态机的组合映射', () => {
    expect(resolveOverallStatus({ reportStatus: 'QUEUED', aiStatus: null })).toBe('QUEUED');
    expect(resolveOverallStatus({ reportStatus: 'COMPUTING', aiStatus: null })).toBe('SCORING');
    expect(resolveOverallStatus({ reportStatus: 'GENERATING', aiStatus: 'GENERATING' })).toBe('GENERATING_AI_INSIGHTS');
    expect(resolveOverallStatus({ reportStatus: 'SUCCEEDED', aiStatus: 'SUCCEEDED' })).toBe('DONE');
    expect(resolveOverallStatus({ reportStatus: 'FAILED', aiStatus: null })).toBe('ERROR');
  });

  it('【关键】算分成功但解读失败 = PARTIAL（契约规则 1 的重要设计）', () => {
    expect(resolveOverallStatus({ reportStatus: 'SUCCEEDED', aiStatus: 'FAILED' })).toBe('PARTIAL');
    // 解读尚未开始也按 PARTIAL：对用户而言「有分数、没解读」是同一件事
    expect(resolveOverallStatus({ reportStatus: 'SUCCEEDED', aiStatus: null })).toBe('PARTIAL');
    // 生成中就已经失败时不必让前端一直轮询
    expect(resolveOverallStatus({ reportStatus: 'GENERATING', aiStatus: 'FAILED' })).toBe('PARTIAL');
  });
});

describe('resolveProgressPercent', () => {
  it('算分区间很小（契约规则 2：算分快、解读慢）', () => {
    expect(resolveProgressPercent({ status: 'QUEUED', aiProgress: null })).toBe(5);
    expect(resolveProgressPercent({ status: 'SCORING', aiProgress: null })).toBe(20);
  });

  it('AI 阶段无进度时给出契约示例值 55', () => {
    expect(resolveProgressPercent({ status: 'GENERATING_AI_INSIGHTS', aiProgress: null })).toBe(55);
  });

  it('AI 进度映射到 30–85，且被钳在 0–100', () => {
    expect(resolveProgressPercent({ status: 'GENERATING_AI_INSIGHTS', aiProgress: 0 })).toBe(30);
    expect(resolveProgressPercent({ status: 'GENERATING_AI_INSIGHTS', aiProgress: 100 })).toBe(85);
    expect(resolveProgressPercent({ status: 'GENERATING_AI_INSIGHTS', aiProgress: 999 })).toBe(85);
    expect(resolveProgressPercent({ status: 'GENERATING_AI_INSIGHTS', aiProgress: -10 })).toBe(30);
  });

  it('终态：DONE / ERROR 为 100，PARTIAL 为 88', () => {
    expect(resolveProgressPercent({ status: 'DONE', aiProgress: null })).toBe(100);
    expect(resolveProgressPercent({ status: 'ERROR', aiProgress: null })).toBe(100);
    expect(resolveProgressPercent({ status: 'PARTIAL', aiProgress: null })).toBe(88);
  });
});

describe('buildStageTimeline', () => {
  const base = {
    createdAt: new Date('2026-02-14T14:45:00.000Z'),
    computedAt: new Date('2026-02-14T14:45:01.000Z'),
    aiStartedAt: new Date('2026-02-14T14:45:01.000Z'),
    aiFinishedAt: null as Date | null,
  };

  it('五个阶段，标签与契约一致', () => {
    const stages = buildStageTimeline({
      ...base,
      status: 'GENERATING_AI_INSIGHTS',
      hasScoring: true,
      aiStatus: 'GENERATING',
    });

    expect(stages.map((stage) => stage.stage)).toEqual([
      'QUEUED',
      'SCORING',
      'GENERATING_AI_INSIGHTS',
      'SAFETY_CHECK',
      'PERSISTING',
    ]);
    expect(stages[0]?.label).toBe('任务排队中');
    expect(stages[2]?.label).toBe('正在生成关系解读');
  });

  it('算分完成 + 解读进行中：前三阶段状态正确', () => {
    const stages = buildStageTimeline({
      ...base,
      status: 'GENERATING_AI_INSIGHTS',
      hasScoring: true,
      aiStatus: 'GENERATING',
    });

    expect(stages[0]?.status).toBe('DONE');
    expect(stages[1]?.status).toBe('DONE');
    expect(stages[2]?.status).toBe('RUNNING');
    expect(stages[3]?.status).toBe('PENDING');
  });

  it('【关键】没有落库字段的阶段时间戳如实为 null（不编"刚刚"）', () => {
    const stages = buildStageTimeline({
      ...base,
      status: 'DONE',
      hasScoring: true,
      aiStatus: 'SUCCEEDED',
    });

    const safetyCheck = stages[3];
    const persisting = stages[4];

    expect(safetyCheck?.startedAt).toBeNull();
    expect(safetyCheck?.finishedAt).toBeNull();
    expect(persisting?.startedAt).toBeNull();
    expect(persisting?.finishedAt).toBeNull();
    // 有列的阶段正常下发
    expect(stages[0]?.startedAt).toBe('2026-02-14T14:45:00.000Z');
    expect(stages[1]?.finishedAt).toBe('2026-02-14T14:45:01.000Z');
    expect(stages[2]?.startedAt).toBe('2026-02-14T14:45:01.000Z');
  });

  it('解读失败时该阶段停在 PENDING（契约的阶段枚举里没有 FAILED）', () => {
    const stages = buildStageTimeline({
      ...base,
      status: 'PARTIAL',
      hasScoring: true,
      aiStatus: 'FAILED',
    });

    expect(stages[2]?.status).toBe('PENDING');
  });

  it('排队中：只有 QUEUED 在跑', () => {
    const stages = buildStageTimeline({
      ...base,
      status: 'QUEUED',
      hasScoring: false,
      aiStatus: null,
      computedAt: null,
    });

    expect(stages[0]?.status).toBe('RUNNING');
    expect(stages[1]?.status).toBe('PENDING');
  });
});

describe('resolveRetryAdvice（契约规则 4）', () => {
  it('PARTIAL 只重试解读（算分不花 token），ERROR 整体重试', () => {
    expect(resolveRetryAdvice('PARTIAL')).toEqual({ canRetry: true, retryScope: 'AI_ONLY' });
    expect(resolveRetryAdvice('ERROR')).toEqual({ canRetry: true, retryScope: 'FULL' });
  });

  it('进行中与成功都不可重试', () => {
    const statuses = ['QUEUED', 'SCORING', 'GENERATING_AI_INSIGHTS', 'SAFETY_CHECK', 'PERSISTING', 'DONE'] as const;

    for (const status of statuses) {
      expect(resolveRetryAdvice(status)).toEqual({ canRetry: false, retryScope: null });
    }
  });
});

describe('countGeneratedItems', () => {
  it('统计优势 + 冲突 + 建议（目标 13 条）', () => {
    expect(AI_TARGET_ITEM_COUNT).toBe(13);
    expect(
      countGeneratedItems({
        advantages: [1, 2, 3],
        conflicts: [1, 2, 3],
        suggestions: [1, 2, 3, 4],
      }),
    ).toBe(10);
  });

  it('非数组与 null 一律按 0 处理（脏数据不应让进度接口 500）', () => {
    expect(countGeneratedItems({ advantages: null, conflicts: 'x', suggestions: { a: 1 } })).toBe(0);
  });
});

// ============================================================================
// 纯逻辑：算分与画像
// ============================================================================

describe('buildScoreBreakdownDimensions', () => {
  it('四个维度按契约顺序，加权分用引擎归一化后的权重', () => {
    const dimensions = buildScoreBreakdownDimensions({
      scoreBreakdown: { appliedWeights: { mbti: 0.3, bigFive: 0.25, attachment: 0.25, communication: 0.2 } },
      scores: { mbti: 74, bigFive: 81, attachment: 68, communication: 85 },
    });

    expect(dimensions.map((item) => item.dimension)).toEqual([
      'MBTI_DIMENSIONS',
      'BIG_FIVE_SIMILARITY',
      'ATTACHMENT_COMPATIBILITY',
      'COMMUNICATION_FIT',
    ]);
    expect(dimensions[0]).toEqual({
      dimension: 'MBTI_DIMENSIONS',
      name: '四维互补性',
      score: 74,
      weight: 0.3,
      weightedScore: 22.2,
    });
  });

  it('权重或分数缺失时给 null（不给 0 —— 0 会被画成"这个维度不重要"）', () => {
    const dimensions = buildScoreBreakdownDimensions({
      scoreBreakdown: null,
      scores: { mbti: 74, bigFive: null, attachment: null, communication: null },
    });

    expect(dimensions[0]?.weight).toBeNull();
    expect(dimensions[0]?.weightedScore).toBeNull();
    expect(dimensions[1]?.score).toBeNull();
  });
});

describe('bigFiveGapLevel（阈值与契约示例一致）', () => {
  it('6.5 → SIMILAR、-13 → DIFFERENT、26 → VERY_DIFFERENT', () => {
    expect(bigFiveGapLevel(6.5)).toBe('SIMILAR');
    expect(bigFiveGapLevel(-13)).toBe('DIFFERENT');
    expect(bigFiveGapLevel(26)).toBe('VERY_DIFFERENT');
    expect(bigFiveGapLevel(15.5)).toBe('DIFFERENT');
  });
});

describe('attachmentRiskLevel（由依恋矩阵得出，契约规则 4）', () => {
  const matrix = {
    SECURE: { SECURE: 95, ANXIOUS: 75, AVOIDANT: 72, FEARFUL: 62 },
    ANXIOUS: { SECURE: 75, ANXIOUS: 55, AVOIDANT: 32, FEARFUL: 45 },
    AVOIDANT: { SECURE: 72, ANXIOUS: 32, AVOIDANT: 50, FEARFUL: 42 },
    FEARFUL: { SECURE: 62, ANXIOUS: 45, AVOIDANT: 42, FEARFUL: 40 },
  };

  it('【关键】焦虑 × 回避 = MEDIUM_HIGH（与契约示例一致）', () => {
    expect(attachmentRiskLevel(matrix, 'AVOIDANT', 'ANXIOUS')).toBe('MEDIUM_HIGH');
    expect(attachmentRiskLevel(matrix, 'ANXIOUS', 'AVOIDANT')).toBe('MEDIUM_HIGH');
  });

  it('安全 × 安全 = LOW；恐惧 × 恐惧 = MEDIUM_HIGH（40 分）', () => {
    expect(attachmentRiskLevel(matrix, 'SECURE', 'SECURE')).toBe('LOW');
    expect(attachmentRiskLevel(matrix, 'FEARFUL', 'FEARFUL')).toBe('MEDIUM_HIGH');
  });

  it('矩阵缺失或组合没配到时返回 null（不推断、不默认 LOW）', () => {
    expect(attachmentRiskLevel(null, 'SECURE', 'SECURE')).toBeNull();
    expect(attachmentRiskLevel(matrix, 'SECURE', 'UNKNOWN')).toBeNull();
    expect(attachmentRiskLevel('nope', 'SECURE', 'SECURE')).toBeNull();
  });
});

describe('buildProfileComparison', () => {
  const profile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    mbtiType: 'INFJ',
    version: 3,
    eiPercent: 34,
    snPercent: 72,
    tfPercent: 60,
    jpPercent: 66,
    openness: 82.5,
    conscientiousness: 71,
    extraversion: 34.5,
    agreeableness: 88,
    neuroticism: 56.5,
    attachmentStyle: 'ANXIOUS',
    loveLanguages: ['QUALITY_TIME', 'WORDS'],
    ...overrides,
  });

  it('MBTI 四维同/异极化按 50 分界', () => {
    const view = buildProfileComparison({
      profileA: profile() as never,
      // A = INFJ（I/N/F/J 侧？—— 逐维看百分数：SN 72→N、TF 60→T、JP 66→J、EI 34→I）
      // B 刻意在两维上与 A 分处 50 两侧：SN 30→S（A 是 N）、JP 44→P（A 是 J）
      profileB: profile({ mbtiType: 'INFP', eiPercent: 28, snPercent: 30, tfPercent: 84, jpPercent: 44 }) as never,
      attachmentMatrix: null,
    });

    expect(view.mbtiPair.a).toBe('INFJ');
    expect(view.mbtiPair.b).toBe('INFP');
    // EI（都 <50 → I）与 TF（都 ≥50 → T）同极；SN、JP 异极
    expect(view.mbtiPair.sameDimensions).toEqual(['EI', 'TF']);
    expect(view.mbtiPair.diffDimensions).toEqual(['SN', 'JP']);
  });

  it('大五差异含方向（a - b）与档位', () => {
    const view = buildProfileComparison({
      profileA: profile() as never,
      profileB: profile({ agreeableness: 62, conscientiousness: 84 }) as never,
      attachmentMatrix: null,
    });

    const agreeableness = view.bigFiveDiff.find((item) => item.dimension === 'agreeableness');
    expect(agreeableness).toEqual({
      dimension: 'agreeableness',
      a: 88,
      b: 62,
      gap: 26,
      level: 'VERY_DIFFERENT',
    });
  });

  it('爱的语言取交集，且顺序按 A（保证两端渲染一致）', () => {
    const view = buildProfileComparison({
      profileA: profile({ loveLanguages: ['QUALITY_TIME', 'WORDS'] }) as never,
      profileB: profile({ loveLanguages: ['WORDS', 'QUALITY_TIME'] }) as never,
      attachmentMatrix: null,
    });

    expect(view.loveLanguageOverlap).toEqual(['QUALITY_TIME', 'WORDS']);
  });
});

describe('scoreRingColor', () => {
  it('未算分时为 null，算分后给颜色', () => {
    expect(scoreRingColor(null)).toBeNull();
    expect(scoreRingColor('GOOD')).toBe('#00B894');
    expect(scoreRingColor('CHALLENGING')).toBe('#E17055');
  });
});

// ============================================================================
// 服务
// ============================================================================

const reportRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: REPORT_ID,
  relationshipId: RELATIONSHIP_ID,
  status: 'SUCCEEDED',
  totalScore: 78,
  mbtiScore: 74,
  bigFiveScore: 81,
  attachmentScore: 68,
  communicationScore: 85,
  scoreBreakdown: { appliedWeights: { mbti: 0.3, bigFive: 0.25, attachment: 0.25, communication: 0.2 } },
  advantages: [{ title: 'A' }],
  conflicts: [{ title: 'C' }],
  suggestions: [{ title: 'S' }],
  engineVersion: 'ce-v1.0.0',
  weightsVersion: 'cw-v1.0.0',
  aiReportId: null,
  provider: 'DEEPSEEK',
  model: 'deepseek-chat',
  totalTokens: 4820,
  retryCount: 0,
  computedAt: new Date('2026-02-14T14:45:01.000Z'),
  generatedAt: new Date('2026-02-14T14:45:03.000Z'),
  createdAt: new Date('2026-02-14T14:45:00.000Z'),
  updatedAt: new Date('2026-02-14T14:45:03.000Z'),
  relationship: {
    type: 'COUPLE',
    status: 'ACTIVE',
    userAId: ME,
    userBId: 'other',
    profileAId: 'profile-a',
    profileBId: 'profile-b',
    weights: { attachmentMatrix: null },
  },
  aiReport: null,
  ...overrides,
});

interface Harness {
  service: CompatibilityService;
  prisma: {
    compatibilityReport: { findFirst: jest.Mock };
    personalityProfile: { findMany: jest.Mock };
  };
  entitlements: { resolveReportUnlock: jest.Mock };
}

const createHarness = (row: unknown = reportRow()): Harness => {
  const prisma = {
    compatibilityReport: { findFirst: jest.fn().mockResolvedValue(row) },
    personalityProfile: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const entitlements = {
    resolveReportUnlock: jest.fn().mockResolvedValue({
      allUnlocked: false,
      unlockedSectionKeys: new Set<string>(),
      source: 'NONE',
    }),
  };

  const service = new CompatibilityService(
    prisma as unknown as PrismaService,
    { add: jest.fn() } as unknown as Queue,
    { createReport: jest.fn() } as unknown as ReportService,
    entitlements as unknown as EntitlementService,
  );

  return { service, prisma, entitlements };
};

const fullOptions = { includeScoreBreakdown: true, previewOnly: false };

describe('CompatibilityService.getReportById（契约 §3.6.10）', () => {
  it('【关键】IDOR：报告不属于我的关系时返回 60010（404），不是 403', async () => {
    const harness = createHarness();
    harness.prisma.compatibilityReport.findFirst.mockResolvedValue(null);

    await expect(harness.service.getReportById(ME, REPORT_ID, fullOptions)).rejects.toMatchObject({
      code: ErrorCode.COMPATIBILITY_REPORT_NOT_FOUND,
      status: 404,
    });
  });

  it('归属校验链压在同一个查询里（报告 + 关系双方）', async () => {
    const harness = createHarness();

    await harness.service.getReportById(ME, REPORT_ID, fullOptions);

    const where = (harness.prisma.compatibilityReport.findFirst.mock.calls[0]?.[0] as { where: unknown }).where;

    expect(JSON.stringify(where)).toContain(ME);
    expect(JSON.stringify(where)).toContain('deletedAt');
  });

  it('【关键】未解锁时裁剪：aiInsights 与 profileComparison 为 null，并列出被隐藏板块', async () => {
    const harness = createHarness();

    const view = await harness.service.getReportById(ME, REPORT_ID, fullOptions);

    expect(view.isUnlocked).toBe(false);
    expect(view.unlockType).toBeNull();
    expect(view.aiInsights).toBeNull();
    expect(view.profileComparison).toBeNull();
    expect(view.summary).toBeNull();
    expect(view.freePreview?.excludes).toContain('AI 优势解读');
    // 免费部分仍要有：总分与等级、四维拆解
    expect(view.overallScore).toBe(78);
    expect(view.scoreLevel).toBe('GOOD');
    expect(view.freePreview?.includes).toContain('总分与等级');
  });

  it('会员解锁时下发 AI 解读与画像对比', async () => {
    const harness = createHarness();
    harness.entitlements.resolveReportUnlock.mockResolvedValue({
      allUnlocked: true,
      unlockedSectionKeys: new Set<string>(),
      source: 'MEMBERSHIP',
    });

    const view = await harness.service.getReportById(ME, REPORT_ID, fullOptions);

    expect(view.isUnlocked).toBe(true);
    expect(view.unlockType).toBe('MEMBERSHIP_ACTIVE');
    expect(view.aiInsights).not.toBeNull();
    expect(view.freePreview).toBeNull();
  });

  it('previewOnly 强制裁剪（会员同样被裁剪）', async () => {
    const harness = createHarness();
    harness.entitlements.resolveReportUnlock.mockResolvedValue({
      allUnlocked: true,
      unlockedSectionKeys: new Set<string>(),
      source: 'MEMBERSHIP',
    });

    const view = await harness.service.getReportById(ME, REPORT_ID, {
      includeScoreBreakdown: true,
      previewOnly: true,
    });

    expect(view.isUnlocked).toBe(false);
    expect(view.aiInsights).toBeNull();
  });

  it('单份购买解锁：unlockType = REPORT_UNLOCK', async () => {
    const harness = createHarness();
    harness.entitlements.resolveReportUnlock.mockResolvedValue({
      allUnlocked: true,
      unlockedSectionKeys: new Set<string>(),
      source: 'REPORT_PURCHASE',
    });

    const view = await harness.service.getReportById(ME, REPORT_ID, fullOptions);

    expect(view.unlockType).toBe('REPORT_UNLOCK');
  });

  it('契约字段名与既有 §3.6.9 字段名同时存在（不破坏已联调的前端）', async () => {
    const harness = createHarness();

    const view = await harness.service.getReportById(ME, REPORT_ID, fullOptions);

    // §3.6.9 的字段名（既有实现）
    expect(view.reportId).toBe(REPORT_ID);
    expect(view.totalScore).toBe(78);
    expect(view.engineVersion).toBe('ce-v1.0.0');
    // §3.6.10 的字段名（本次新增的别名）
    expect(view.compatibilityReportId).toBe(REPORT_ID);
    expect(view.overallScore).toBe(78);
    expect(view.algorithmVersion).toBe('ce-v1.0.0');
  });

  it('includeScoreBreakdown = false 时不返回明细', async () => {
    const harness = createHarness();

    const view = await harness.service.getReportById(ME, REPORT_ID, {
      includeScoreBreakdown: false,
      previewOnly: false,
    });

    expect(view.scoreBreakdown).toBeNull();
    expect(view.scoreBreakdownDimensions).toEqual([]);
  });

  it('报告仍在生成中 → 409（前端应改轮询进度接口）', async () => {
    for (const status of ['QUEUED', 'COMPUTING', 'GENERATING']) {
      const harness = createHarness(reportRow({ status }));

      await expect(harness.service.getReportById(ME, REPORT_ID, fullOptions)).rejects.toMatchObject({
        code: ErrorCode.COMPATIBILITY_GENERATING,
        status: 409,
      });
    }
  });

  it('失败的报告只下发友好文案，不透出内部错误原文', async () => {
    const harness = createHarness(reportRow({ status: 'FAILED', errorMessage: 'Prisma P2003 foreign key violated' }));

    const view = await harness.service.getReportById(ME, REPORT_ID, fullOptions);

    expect(view.failureReason).toBeDefined();
    expect(JSON.stringify(view)).not.toContain('P2003');
  });
});

describe('CompatibilityService.getReportProgress（契约 §3.6.11）', () => {
  it('算分完成、解读进行中：进度与阶段正确', async () => {
    const harness = createHarness(
      reportRow({
        status: 'GENERATING',
        aiReport: {
          status: 'GENERATING',
          summary: null,
          provider: 'DEEPSEEK',
          model: 'deepseek-chat',
          progress: 45,
          retryCount: 0,
          generationStartedAt: new Date('2026-02-14T14:45:01.000Z'),
          generationFinishedAt: null,
        },
        aiReportId: 'ai-report-1',
      }),
    );

    const view = await harness.service.getReportProgress(ME, REPORT_ID);

    expect(view.status).toBe('GENERATING_AI_INSIGHTS');
    expect(view.progress).toBeGreaterThan(30);
    expect(view.progress).toBeLessThan(86);
    expect(view.scoring.isDone).toBe(true);
    expect(view.scoring.partialAvailable).toBe(true);
    expect(view.ai.isDone).toBe(false);
    expect(view.ai.attempt).toBe(1);
    expect(view.ai.maxAttempts).toBe(3);
    expect(view.pollingAdvice).toEqual({ intervalMs: 2000, maxPolls: 30 });
  });

  it('【关键】PARTIAL 以 200 返回并给出 retryScope = AI_ONLY', async () => {
    const harness = createHarness(
      reportRow({ status: 'SUCCEEDED', aiReport: { status: 'FAILED', retryCount: 1 }, aiReportId: 'ai-1' }),
    );

    const view = await harness.service.getReportProgress(ME, REPORT_ID);

    expect(view.status).toBe('PARTIAL');
    expect(view.canRetry).toBe(true);
    expect(view.retryScope).toBe('AI_ONLY');
    expect(view.failureReason).toBeDefined();
  });

  it('【关键】ERROR 同样以 200 返回，retryScope = FULL', async () => {
    const harness = createHarness(
      reportRow({ status: 'FAILED', computedAt: null, errorMessage: 'Prisma P2003 foreign key violated' }),
    );

    const view = await harness.service.getReportProgress(ME, REPORT_ID);

    expect(view.status).toBe('ERROR');
    expect(view.retryScope).toBe('FULL');
    // 内部错误原文（可能含 Prisma/引擎细节）绝不能出现在响应里
    expect(JSON.stringify(view)).not.toContain('P2003');
  });

  it('DONE 时不给剩余时间，收尾时间取生成时间', async () => {
    const harness = createHarness(reportRow({ aiReport: { status: 'SUCCEEDED', retryCount: 0 }, aiReportId: 'ai-1' }));

    const view = await harness.service.getReportProgress(ME, REPORT_ID);

    expect(view.status).toBe('DONE');
    expect(view.estimatedRemainingSeconds).toBeNull();
    expect(view.ai.estimatedRemainingSeconds).toBeNull();
    expect(view.finishedAt).toBe('2026-02-14T14:45:03.000Z');
    expect(view.canRetry).toBe(false);
  });

  it('【关键】scoring.durationMs 无列可查 → null（不拿"完成时间−创建时间"冒充）', async () => {
    const harness = createHarness();

    const view = await harness.service.getReportProgress(ME, REPORT_ID);

    expect(view.scoring.durationMs).toBeNull();
    expect(view.scoring.computedAt).toBe('2026-02-14T14:45:01.000Z');
  });

  it('剩余耗时按未完成条目数估算（契约示例：13−2 = 11 秒）', async () => {
    const harness = createHarness(
      reportRow({
        status: 'GENERATING',
        advantages: [{ title: 'A' }],
        conflicts: [{ title: 'C' }],
        suggestions: [],
        aiReport: { status: 'GENERATING', retryCount: 0, progress: 20 },
        aiReportId: 'ai-1',
      }),
    );

    const view = await harness.service.getReportProgress(ME, REPORT_ID);

    expect(view.ai.generatedItemCount).toBe(2);
    expect(view.ai.targetItemCount).toBe(13);
    expect(view.estimatedRemainingSeconds).toBe(11);
  });

  it('IDOR：非双方一律 60010', async () => {
    const harness = createHarness();
    harness.prisma.compatibilityReport.findFirst.mockResolvedValue(null);

    await expect(harness.service.getReportProgress(ME, REPORT_ID)).rejects.toMatchObject({
      code: ErrorCode.COMPATIBILITY_REPORT_NOT_FOUND,
      status: 404,
    });
  });

  it('未知状态兜底为排队中（谎报失败比"还在进行"危险）', async () => {
    const harness = createHarness(reportRow({ status: 'SOME_FUTURE_STATUS' }));

    const view = await harness.service.getReportProgress(ME, REPORT_ID);

    expect(view.status).toBe('QUEUED');
  });
});

// ============================================================================
// 路由契约
// ============================================================================

describe('CompatibilityReportController 路由契约（契约 §3.6.10 / §3.6.11）', () => {
  it('基础路径为 compatibility-reports', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CompatibilityReportController)).toBe('compatibility-reports');
  });

  it('详情：GET /compatibility-reports/:id', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CompatibilityReportController.prototype.getReportDetail)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, CompatibilityReportController.prototype.getReportDetail)).toBe(
      RequestMethod.GET,
    );
  });

  it('进度：GET /compatibility-reports/:id/progress', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CompatibilityReportController.prototype.getReportProgress)).toBe(
      ':id/progress',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, CompatibilityReportController.prototype.getReportProgress)).toBe(
      RequestMethod.GET,
    );
  });

  it('【关键】两个端点都必须鉴权', () => {
    for (const method of ['getReportDetail', 'getReportProgress'] as const) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, CompatibilityReportController.prototype[method])).toBeUndefined();
    }
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, CompatibilityReportController)).toBeUndefined();
  });

  it('限流：详情 120/60s、进度 240/60s（契约逐接口限流表）', () => {
    expect(
      Reflect.getMetadata(`${THROTTLER_LIMIT}global`, CompatibilityReportController.prototype.getReportDetail),
    ).toBe(120);
    expect(
      Reflect.getMetadata(`${THROTTLER_LIMIT}global`, CompatibilityReportController.prototype.getReportProgress),
    ).toBe(240);
  });

  it('查询参数缺省值由控制器补齐（契约默认 includeScoreBreakdown=true / previewOnly=false）', async () => {
    const getReportById = jest.fn().mockResolvedValue({});
    const controller = new CompatibilityReportController({ getReportById } as unknown as CompatibilityService);

    await controller.getReportDetail(ME, { id: REPORT_ID }, {});

    expect(getReportById).toHaveBeenCalledWith(ME, REPORT_ID, {
      includeScoreBreakdown: true,
      previewOnly: false,
    });
  });

  it('显式传入的查询参数被透传', async () => {
    const getReportById = jest.fn().mockResolvedValue({});
    const controller = new CompatibilityReportController({ getReportById } as unknown as CompatibilityService);

    await controller.getReportDetail(ME, { id: REPORT_ID }, { includeScoreBreakdown: false, previewOnly: true });

    expect(getReportById).toHaveBeenCalledWith(ME, REPORT_ID, {
      includeScoreBreakdown: false,
      previewOnly: true,
    });
  });
});

describe('REPORT_ID 常量', () => {
  it('与关系 ID 不同（避免把两者写混）', () => {
    expect(REPORT_ID).not.toBe(RELATIONSHIP_ID);
  });
});
