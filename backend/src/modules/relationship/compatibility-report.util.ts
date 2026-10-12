/**
 * 匹配报告详情与进度纯逻辑（契约 §3.6.10 / §3.6.11，无 I/O、可 100% 单测）
 *
 * ## 为什么单独成一个文件而不是塞进 `compatibility.service.ts`
 *
 * 进度是一个**状态映射**问题：`compatibility_reports.status`（5 个值）+
 * `ai_reports.status`（5 个值）→ 契约的 8 个阶段 + 百分比 + 阶段时间线。
 * 两处状态机的组合有 25 种，其中真正会出现的约 8 种 —— 这种"映射表"必须能被
 * 穷举单测，而不是埋在 Service 的分支里靠联调碰运气。
 *
 * ## 契约与数据模型的差距（推导而非补齐）
 *
 * | 契约字段                     | 数据来源                                             |
 * | ---------------------------- | ---------------------------------------------------- |
 * | `status` / `stage` / `progress` | 由两个 status 映射（见 `resolveOverallStatus`）   |
 * | 阶段时间戳                   | 只有 `QUEUED`（`createdAt`）、`SCORING`（`computedAt`）、|
 * |                              | `GENERATING_AI_INSIGHTS`（`ai_reports.generation*At`）|
 * |                              | 有列；`SAFETY_CHECK` / `PERSISTING` **如实返回 `null`** |
 * | `scoring.durationMs`         | **无列可查** → `null`（不用 `computedAt - createdAt` |
 * |                              | 冒充：那里面还包含排队等待时间）                     |
 * | `ai.targetItemCount`         | 契约规则 3：优势 3 + 冲突 3 + 建议 5 + 话术 2 = 13    |
 * | `profileComparison`          | 由双方画像实时计算（需关系 ACTIVE 且报告已解锁）      |
 */

import type { CompatibilityScoreLevel } from './relationship-view.util';

/** 契约 §3.6.11 的阶段枚举（顺序即执行顺序） */
export const COMPATIBILITY_STAGES = [
  'QUEUED',
  'SCORING',
  'GENERATING_AI_INSIGHTS',
  'SAFETY_CHECK',
  'PERSISTING',
] as const;

export type CompatibilityStage = (typeof COMPATIBILITY_STAGES)[number];

/** 阶段中文标签（契约 §3.6.11 的阶段枚举表） */
const STAGE_LABELS: Readonly<Record<CompatibilityStage, string>> = {
  QUEUED: '任务排队中',
  SCORING: '正在计算契合度',
  GENERATING_AI_INSIGHTS: '正在生成关系解读',
  SAFETY_CHECK: '正在进行内容安全检测',
  PERSISTING: '正在保存报告',
};

export const compatibilityStageLabel = (stage: CompatibilityStage): string => STAGE_LABELS[stage];

/** 整体状态（契约 §3.6.11 的 8 个取值，其中 `DONE` / `PARTIAL` / `ERROR` 是终态） */
export type CompatibilityProgressStatus = CompatibilityStage | 'DONE' | 'PARTIAL' | 'ERROR';

export const PROGRESS_STATUS_LABELS: Readonly<Record<CompatibilityProgressStatus, string>> = {
  QUEUED: '任务排队中',
  SCORING: '正在计算契合度',
  GENERATING_AI_INSIGHTS: '正在生成关系解读',
  SAFETY_CHECK: '正在进行内容安全检测',
  PERSISTING: '正在保存报告',
  DONE: '报告已生成',
  PARTIAL: '算分完成，解读生成失败',
  ERROR: '生成失败',
};

/** 阶段状态（契约只有这三个值，**没有** `FAILED`） */
export type CompatibilityStageStatus = 'DONE' | 'RUNNING' | 'PENDING';

export interface CompatibilityStageView {
  readonly stage: CompatibilityStage;
  readonly label: string;
  readonly status: CompatibilityStageStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** AI 解读的产出条数目标（契约 §3.6.11 规则 3） */
export const AI_TARGET_ITEM_COUNT = 13;

/** AI 解读最大尝试次数（与 `compatibility.calc` 队列的 `attempts: 3` 对齐） */
export const AI_MAX_ATTEMPTS = 3;

/** 轮询建议（契约 §3.6.11 的 `pollingAdvice`） */
export const POLLING_ADVICE = { intervalMs: 2000, maxPolls: 30 } as const;

/** 进度百分比的分段（算分很快，因此它占的区间很小 —— 契约规则 2 的直观体现） */
const PROGRESS_QUEUED = 5;
const PROGRESS_SCORING = 20;
const PROGRESS_AI_BASE = 30;
/** AI 阶段自身进度（0–100）映射到 30–85 的区间 */
const PROGRESS_AI_SPAN = 55;
const PROGRESS_PARTIAL = 88;
const PROGRESS_DONE = 100;
/** AI 进度未知时的中间值（契约示例即 55） */
const PROGRESS_AI_UNKNOWN = 55;

/**
 * 整体进度状态
 *
 * `PARTIAL`（契约规则 1 的**重要设计**）由「算分成功但 AI 解读失败」得出：
 * 算分是确定性的、必然成功；解读要调外部 LLM，可能失败。
 * 两者解耦后，用户至少能先看到分数与拆解。
 */
export const resolveOverallStatus = (params: {
  readonly reportStatus: string;
  readonly aiStatus: string | null;
}): CompatibilityProgressStatus => {
  switch (params.reportStatus) {
    case 'QUEUED':
      return 'QUEUED';
    case 'COMPUTING':
      return 'SCORING';
    case 'GENERATING':
      // 解读已经失败时不必让前端一直轮询：直接给 PARTIAL，前端展示「重试解读」
      return params.aiStatus === 'FAILED' || params.aiStatus === 'CANCELLED' ? 'PARTIAL' : 'GENERATING_AI_INSIGHTS';
    case 'SUCCEEDED':
      // 算分成功 + 解读失败 = PARTIAL；解读尚未开始（`aiStatus === null`）也算 PARTIAL，
      // 因为对用户而言「有分数、没有解读」是同一件事
      return params.aiStatus === 'SUCCEEDED' ? 'DONE' : 'PARTIAL';
    case 'FAILED':
      return 'ERROR';
    default:
      // 未知状态当作排队中：返回一个"还在进行"的语义比谎报失败安全
      return 'QUEUED';
  }
};

/** 进度百分比 */
export const resolveProgressPercent = (params: {
  readonly status: CompatibilityProgressStatus;
  readonly aiProgress: number | null;
}): number => {
  switch (params.status) {
    case 'QUEUED':
      return PROGRESS_QUEUED;
    case 'SCORING':
      return PROGRESS_SCORING;
    case 'GENERATING_AI_INSIGHTS':
    case 'SAFETY_CHECK':
    case 'PERSISTING': {
      if (params.aiProgress === null) return PROGRESS_AI_UNKNOWN;

      const clamped = Math.min(100, Math.max(0, params.aiProgress));

      return Math.round(PROGRESS_AI_BASE + (clamped / 100) * PROGRESS_AI_SPAN);
    }
    case 'PARTIAL':
      return PROGRESS_PARTIAL;
    case 'DONE':
    case 'ERROR':
      return PROGRESS_DONE;
    default:
      return PROGRESS_QUEUED;
  }
};

/** 阶段推进的输入 */
export interface StageTimelineInput {
  readonly status: CompatibilityProgressStatus;
  /** 算分是否已完成（`computedAt` 有值） */
  readonly hasScoring: boolean;
  readonly aiStatus: string | null;
  readonly createdAt: Date;
  readonly computedAt: Date | null;
  readonly aiStartedAt: Date | null;
  readonly aiFinishedAt: Date | null;
}

/**
 * 组装阶段时间线
 *
 * 时间戳只在**有列可查**时下发（见文件头表格）。契约示例里 5 个阶段都有时间戳，
 * 但 `SAFETY_CHECK` / `PERSISTING` 在本项目里没有落库字段 —— 编一个"刚刚"的时间
 * 会让前端画出真实感很强、却完全虚构的进度条。
 */
export const buildStageTimeline = (input: StageTimelineInput): readonly CompatibilityStageView[] => {
  const isTerminal = input.status === 'DONE' || input.status === 'PARTIAL' || input.status === 'ERROR';
  const scoringDone = input.hasScoring || isTerminal;
  const aiRunning = input.aiStatus === 'QUEUED' || input.aiStatus === 'GENERATING';
  const aiDone = input.aiStatus === 'SUCCEEDED';

  const statusOf = (stage: CompatibilityStage): CompatibilityStageStatus => {
    switch (stage) {
      case 'QUEUED':
        return input.status === 'QUEUED' ? 'RUNNING' : 'DONE';
      case 'SCORING':
        if (input.status === 'QUEUED') return 'PENDING';
        if (scoringDone) return 'DONE';

        return 'RUNNING';
      case 'GENERATING_AI_INSIGHTS':
        if (!scoringDone) return 'PENDING';
        if (aiDone || input.status === 'DONE') return 'DONE';
        if (aiRunning || input.status === 'GENERATING_AI_INSIGHTS') return 'RUNNING';

        // 解读失败：该阶段停在未完成状态（契约的阶段枚举里没有 `FAILED`，
        // 失败由整体 `status = PARTIAL / ERROR` 表达）
        return 'PENDING';
      case 'SAFETY_CHECK':
        if (input.status === 'DONE') return 'DONE';
        if (aiDone) return 'RUNNING';

        return 'PENDING';
      case 'PERSISTING':
        if (input.status === 'DONE') return 'DONE';
        if (aiDone) return 'RUNNING';

        return 'PENDING';
      default:
        return 'PENDING';
    }
  };

  const timestampsOf = (stage: CompatibilityStage): { startedAt: Date | null; finishedAt: Date | null } => {
    switch (stage) {
      case 'QUEUED':
        return { startedAt: input.createdAt, finishedAt: null };
      case 'SCORING':
        return { startedAt: null, finishedAt: input.computedAt };
      case 'GENERATING_AI_INSIGHTS':
        return { startedAt: input.aiStartedAt, finishedAt: input.aiFinishedAt };
      default:
        // `SAFETY_CHECK` / `PERSISTING` 没有落库字段：如实为 null
        return { startedAt: null, finishedAt: null };
    }
  };

  return COMPATIBILITY_STAGES.map((stage) => {
    const { startedAt, finishedAt } = timestampsOf(stage);

    return {
      stage,
      label: STAGE_LABELS[stage],
      status: statusOf(stage),
      startedAt: startedAt?.toISOString() ?? null,
      finishedAt: finishedAt?.toISOString() ?? null,
    };
  });
};

/**
 * 失败后的重试范围（契约规则 4）
 *
 * `AI_ONLY` 与 `FULL` 的区别是**钱**：算分不花 token，重跑整条链路会重新调用 LLM。
 * 因此算分已完成时必须只重试解读。
 */
export const resolveRetryAdvice = (
  status: CompatibilityProgressStatus,
): { canRetry: boolean; retryScope: 'AI_ONLY' | 'FULL' | null } => {
  if (status === 'ERROR') return { canRetry: true, retryScope: 'FULL' };
  if (status === 'PARTIAL') return { canRetry: true, retryScope: 'AI_ONLY' };

  return { canRetry: false, retryScope: null };
};

/** 已完成条目数（优势 + 冲突 + 建议；话术在契约的 13 条之外单独核算的话会超出目标值） */
export const countGeneratedItems = (report: {
  readonly advantages: unknown;
  readonly conflicts: unknown;
  readonly suggestions: unknown;
}): number => {
  const lengthOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

  return lengthOf(report.advantages) + lengthOf(report.conflicts) + lengthOf(report.suggestions);
};

// ============================================================================
// AI 解读（契约 §3.6.10 的 aiInsights）
// ============================================================================

/** AI 解读视图 */
export interface CompatibilityAiInsightsView {
  readonly isAiGenerated: true;
  readonly provider: string | null;
  readonly model: string | null;
  readonly generatedAt: string | null;
  readonly advantages: readonly unknown[];
  readonly conflicts: readonly unknown[];
  readonly suggestions: readonly unknown[];
  readonly communicationScripts: readonly unknown[];
}

/**
 * 组装 AI 解读
 *
 * 来源是 `compatibility_reports` 的 `advantages` / `conflicts` / `suggestions`
 * 三个 JSONB 列（由 AI 解读阶段写入）。**只有解锁后才下发**（契约规则 2：
 * 未解锁时 `aiInsights` 置 `null` 并列出被隐藏的板块）。
 *
 * 三个列都为空时返回 `null` 而不是空数组：空数组会让前端渲染出"优势（0）"
 * 这样的空板块，看起来像内容丢了。
 */
export const buildAiInsights = (params: {
  readonly advantages: unknown;
  readonly conflicts: unknown;
  readonly suggestions: unknown;
  readonly communicationScripts: unknown;
  readonly provider: string | null;
  readonly model: string | null;
  readonly generatedAt: Date | null;
}): CompatibilityAiInsightsView | null => {
  const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

  const advantages = asArray(params.advantages);
  const conflicts = asArray(params.conflicts);
  const suggestions = asArray(params.suggestions);
  const scripts = asArray(params.communicationScripts);

  if (advantages.length + conflicts.length + suggestions.length + scripts.length === 0) return null;

  return {
    isAiGenerated: true,
    provider: params.provider,
    model: params.model,
    generatedAt: params.generatedAt?.toISOString() ?? null,
    advantages,
    conflicts,
    suggestions,
    communicationScripts: scripts,
  };
};

/** 未解锁时被隐藏的板块（契约 §3.6.9 的 `freePreview.excludes` / §3.6.10 规则 2） */
export const LOCKED_SECTIONS = ['AI 优势解读', '潜在冲突分析', '可执行建议', '沟通话术示例', '性格对比明细'] as const;

/** 免费可见的板块 */
export const FREE_SECTIONS = ['总分与等级', '四维拆解明细'] as const;

/** 免费预览说明（未解锁时下发） */
export const buildFreePreview = (): { ratio: number; includes: readonly string[]; excludes: readonly string[] } => ({
  // 契约 §3.6.9 的示例值为 0.2；本项目未配置该比例（`reportFreePreviewRatio`
  // 是**个人报告**的免费比例），因此这里如实返回 0 并在报告中标明
  ratio: 0,
  includes: FREE_SECTIONS,
  excludes: LOCKED_SECTIONS,
});

// ============================================================================
// 算分明细（契约 §3.6.10 的 scoreBreakdown 数组形态）
// ============================================================================

/** 四个维度的展示名（契约 §3.6.10） */
const DIMENSION_META: readonly { readonly key: string; readonly dimension: string; readonly name: string }[] = [
  { key: 'mbti', dimension: 'MBTI_DIMENSIONS', name: '四维互补性' },
  { key: 'bigFive', dimension: 'BIG_FIVE_SIMILARITY', name: '五维相似度' },
  { key: 'attachment', dimension: 'ATTACHMENT_COMPATIBILITY', name: '依恋类型兼容' },
  { key: 'communication', dimension: 'COMMUNICATION_FIT', name: '沟通偏好一致' },
];

/** 单个维度 */
export interface ScoreBreakdownDimensionView {
  readonly dimension: string;
  readonly name: string;
  readonly score: number | null;
  readonly weight: number | null;
  readonly weightedScore: number | null;
}

/**
 * 组装算分明细（数组形态）
 *
 * ⚠ **不是**契约 §3.6.9 / §3.6.10 的 `scoreBreakdown` 字段本身：
 * 既有实现（`CompatibilityReportView.scoreBreakdown`）直接透传引擎写入的 JSONB，
 * 契约 §3.6.9 也在业务规则 3 里明确要求透传它（"前端可据此画堆叠柱状图"）。
 * 因此这里额外给出**数组形态** `scoreBreakdownDimensions`（含维度名与加权分），
 * 两处并存、互不覆盖 —— 改掉既有的透传字段会破坏已联调的前端。
 *
 * `appliedWeights` 来自引擎（各维度归一化后的实际权重）；缺项时为 `null`
 * 而不是 0 —— 0 会被前端画成"这个维度不重要"。
 */
export const buildScoreBreakdownDimensions = (params: {
  readonly scoreBreakdown: unknown;
  readonly scores: Readonly<Record<string, number | null>>;
}): readonly ScoreBreakdownDimensionView[] => {
  const breakdown =
    params.scoreBreakdown !== null && typeof params.scoreBreakdown === 'object' && !Array.isArray(params.scoreBreakdown)
      ? (params.scoreBreakdown as Record<string, unknown>)
      : {};

  const appliedWeights =
    breakdown.appliedWeights !== null &&
    typeof breakdown.appliedWeights === 'object' &&
    !Array.isArray(breakdown.appliedWeights)
      ? (breakdown.appliedWeights as Record<string, unknown>)
      : {};

  return DIMENSION_META.map(({ key, dimension, name }) => {
    const score = params.scores[key] ?? null;
    const rawWeight = appliedWeights[key];
    const weight = typeof rawWeight === 'number' ? rawWeight : null;

    return {
      dimension,
      name,
      score,
      weight,
      weightedScore: score === null || weight === null ? null : Math.round(score * weight * 10) / 10,
    };
  });
};

// ============================================================================
// 双方画像对比（契约 §3.6.10 的 profileComparison）
// ============================================================================

/** 参与对比的画像字段（`PersonalityProfile` 的子集） */
export interface ComparisonProfileLike {
  readonly mbtiType: string;
  readonly version: number;
  readonly eiPercent: number;
  readonly snPercent: number;
  readonly tfPercent: number;
  readonly jpPercent: number;
  readonly openness: number;
  readonly conscientiousness: number;
  readonly extraversion: number;
  readonly agreeableness: number;
  readonly neuroticism: number;
  readonly attachmentStyle: string;
  readonly loveLanguages: readonly string[];
}

/** 大五差异档位 */
export type BigFiveGapLevel = 'SIMILAR' | 'DIFFERENT' | 'VERY_DIFFERENT';

/** 依恋组合风险等级 */
export type AttachmentRiskLevel = 'LOW' | 'MEDIUM' | 'MEDIUM_HIGH' | 'HIGH';

const RISK_LABELS: Readonly<Record<AttachmentRiskLevel, string>> = {
  LOW: '稳定的组合',
  MEDIUM: '整体稳定，个别情境需要留意',
  MEDIUM_HIGH: '需要留意的组合',
  HIGH: '需要双方刻意经营的组合',
};

/** 双方画像对比视图 */
export interface ProfileComparisonView {
  readonly mbtiPair: {
    readonly a: string;
    readonly b: string;
    readonly sameDimensions: readonly string[];
    readonly diffDimensions: readonly string[];
  };
  readonly bigFiveDiff: readonly {
    readonly dimension: string;
    readonly a: number;
    readonly b: number;
    readonly gap: number;
    readonly level: BigFiveGapLevel;
  }[];
  readonly attachmentPair: {
    readonly a: string;
    readonly b: string;
    readonly riskLevel: AttachmentRiskLevel | null;
    readonly riskLabel: string | null;
  };
  readonly loveLanguageOverlap: readonly string[];
}

/** MBTI 四维的正负极（`percent >= 50` 取正极字母） */
interface MbtiDimensionPole {
  readonly dimension: string;
  readonly positive: string;
  readonly negative: string;
}

const MBTI_DIMENSION_POLES: readonly MbtiDimensionPole[] = [
  { dimension: 'EI', positive: 'E', negative: 'I' },
  { dimension: 'SN', positive: 'S', negative: 'N' },
  { dimension: 'TF', positive: 'T', negative: 'F' },
  { dimension: 'JP', positive: 'J', negative: 'P' },
];

/** 大五差异档位（阈值与契约示例一致：6.5→SIMILAR，-13→DIFFERENT，26→VERY_DIFFERENT） */
export const bigFiveGapLevel = (gap: number): BigFiveGapLevel => {
  const absolute = Math.abs(gap);
  if (absolute < 10) return 'SIMILAR';
  if (absolute < 20) return 'DIFFERENT';

  return 'VERY_DIFFERENT';
};

/**
 * 依恋组合风险等级
 *
 * 分数来自 `compatibility_weights.attachmentMatrix`（0–100，越高越契合），
 * 契约 §3.6.10 规则 4 明确要求「由依恋矩阵得出」而不是写死。
 * 阈值是**对同一份矩阵的解读**：矩阵分数下界（焦虑×回避 = 32）落在
 * `MEDIUM_HIGH`，与契约示例「`AVOIDANT × ANXIOUS → MEDIUM_HIGH`」一致。
 *
 * 矩阵缺失（键没有配到）时返回 `null` —— 不推断，也不默认成 LOW。
 */
export const attachmentRiskLevel = (matrix: unknown, styleA: string, styleB: string): AttachmentRiskLevel | null => {
  if (matrix === null || typeof matrix !== 'object' || Array.isArray(matrix)) return null;

  const row = (matrix as Record<string, unknown>)[styleA];
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;

  const score = (row as Record<string, unknown>)[styleB];
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;

  if (score >= 80) return 'LOW';
  if (score >= 55) return 'MEDIUM';
  if (score >= 30) return 'MEDIUM_HIGH';

  return 'HIGH';
};

export const attachmentRiskLabel = (level: AttachmentRiskLevel | null): string | null =>
  level === null ? null : RISK_LABELS[level];

/** 大五五维的展示顺序（契约示例顺序） */
const BIG_FIVE_DIMENSIONS: readonly { readonly key: keyof ComparisonProfileLike; readonly name: string }[] = [
  { key: 'openness', name: 'openness' },
  { key: 'conscientiousness', name: 'conscientiousness' },
  { key: 'extraversion', name: 'extraversion' },
  { key: 'agreeableness', name: 'agreeableness' },
  { key: 'neuroticism', name: 'neuroticism' },
];

/**
 * 双方画像对比
 *
 * 契约规则 6 要求**双端看到完全相同的内容**（包括双方的分数），这是产品选择
 * （透明优于保护）。因此这里按报告里固定的 A/B 顺序输出，不按阅读者视角翻转 ——
 * 翻转会造成"同一份报告在不同手机上 A 和 B 的分数互换"。
 *
 * ⚠ 调用方必须**先确认报告已解锁**再调用：大五明细属付费内容（契约 §3.6.5 的
 * 隐私约束）。本函数不做权限判断（纯函数不接触权限），但它的输出只应出现在
 * 已解锁的响应里。
 */
export const buildProfileComparison = (params: {
  readonly profileA: ComparisonProfileLike;
  readonly profileB: ComparisonProfileLike;
  readonly attachmentMatrix: unknown;
}): ProfileComparisonView => {
  const { profileA, profileB } = params;

  const sameDimensions: string[] = [];
  const diffDimensions: string[] = [];

  for (const { dimension, positive, negative } of MBTI_DIMENSION_POLES) {
    const percentKey = `${dimension.toLowerCase()}Percent` as keyof ComparisonProfileLike;
    const poleA = (profileA[percentKey] as number) >= 50 ? positive : negative;
    const poleB = (profileB[percentKey] as number) >= 50 ? positive : negative;

    (poleA === poleB ? sameDimensions : diffDimensions).push(dimension);
  }

  const bigFiveDiff = BIG_FIVE_DIMENSIONS.map(({ key, name }) => {
    const a = profileA[key] as number;
    const b = profileB[key] as number;
    // 保留一位小数：`gap` 是差值而不是分数，浮点误差会让 6.5 变成 6.499999
    const gap = Math.round((a - b) * 10) / 10;

    return { dimension: name, a, b, gap, level: bigFiveGapLevel(gap) };
  });

  const riskLevel = attachmentRiskLevel(params.attachmentMatrix, profileA.attachmentStyle, profileB.attachmentStyle);

  const languagesB = new Set(profileB.loveLanguages);

  return {
    mbtiPair: { a: profileA.mbtiType, b: profileB.mbtiType, sameDimensions, diffDimensions },
    bigFiveDiff,
    attachmentPair: {
      a: profileA.attachmentStyle,
      b: profileB.attachmentStyle,
      riskLevel,
      riskLabel: attachmentRiskLabel(riskLevel),
    },
    // 交集按 A 的顺序输出，保证同一份报告两端顺序一致
    loveLanguageOverlap: profileA.loveLanguages.filter((language) => languagesB.has(language)),
  };
};

/** 报告详情的 `relatedActions`（契约 §3.6.10） */
export const buildRelatedActions = (
  relationshipId: string,
  params: { readonly isUnlocked: boolean; readonly isActiveRelationship: boolean },
): {
  canStartChat: boolean;
  chatUrl: string | null;
  canExportPdf: boolean;
  canShare: boolean;
} => ({
  canStartChat: params.isActiveRelationship,
  chatUrl: params.isActiveRelationship ? `/api/v1/ai/conversations?relationshipId=${relationshipId}` : null,
  // PDF 导出依赖 storage 的导出任务链路，尚未接入 → 明确 false，
  // 而不是给一个点了没反应的 true
  canExportPdf: false,
  canShare: params.isUnlocked,
});

/** 分数等级 → 契约的 `scoreRingColor`（前端画环用） */
export const scoreRingColor = (level: CompatibilityScoreLevel | null): string | null => {
  if (level === null) return null;

  return { EXCELLENT: '#00B894', GOOD: '#00B894', FAIR: '#F39C12', CHALLENGING: '#E17055' }[level];
};
