/**
 * CompatibilityEngine — 匹配算分（纯函数，无 I/O、无 AI、可 100% 单测）
 *
 * 架构依据：§12.2、ADR-005（算分确定、AI 只做解读）、ADR-027（纯数学辅助独立可测）。
 *
 * 三条不可动摇的约束：
 *   ① **确定性**：同一对画像 + 同一版权重永远得到同一个分数。不含随机数、不含当前时间。
 *   ② **可解释**：总分必须能拆到四个子项与每个子项的逐条明细（`scoreBreakdown`），
 *      前端据此画拆解图，客服据此回答"为什么是 72 分"。
 *   ③ **缺数据不编造**：某项缺失（如未测关系风格）时**剔除该维度并重新归一权重**，
 *      而不是按 0 分计算 —— 后者会把"没测"表达成"关系很差"，是错误结论。
 *
 * 分数结构（写入 `compatibility_reports`）：
 *   totalScore = Σ(子项分 × 归一后权重)
 *   子项：mbtiScore / bigFiveScore / attachmentScore / communicationScore
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { clamp, mean, roundTo } from '../../personality/engine/engine-math.util';

/** 引擎版本（写入 `compatibility_reports.engineVersion`，参与报告幂等键） */
export const COMPATIBILITY_ENGINE_VERSION = '1.0.0';

/** 单个维度缺失偏好时的中性分（"信号不足"而非"不匹配"） */
const NEUTRAL_SCORE = 65;

/** MBTI 维度顺序（与 `personality_profiles` 的四个百分比字段对应） */
const MBTI_DIMENSIONS = ['EI', 'SN', 'TF', 'JP'] as const;
export type MbtiDimension = (typeof MBTI_DIMENSIONS)[number];

/** 每个 MBTI 维度的正极字母（与算分引擎一致：percent ≥ 50 取正极） */
const POSITIVE_POLES: Readonly<Record<MbtiDimension, string>> = {
  EI: 'E',
  SN: 'S',
  TF: 'T',
  JP: 'J',
};

/** 参与匹配的画像（只声明引擎用到的字段） */
export interface CompatibilityProfile {
  readonly id: string;
  readonly version: number;
  /** MBTI 四维百分比（≥ 50 为正极），缺失为 null */
  readonly eiPercent: number | null;
  readonly snPercent: number | null;
  readonly tfPercent: number | null;
  readonly jpPercent: number | null;
  readonly openness: number | null;
  readonly conscientiousness: number | null;
  readonly extraversion: number | null;
  readonly agreeableness: number | null;
  readonly neuroticism: number | null;
  /** 依恋风格（Prisma 枚举或关系风格规则编码），缺失为 null */
  readonly attachmentStyle: string | null;
  readonly loveLanguages: readonly string[];
  readonly conflictStyle: string | null;
}

/** MBTI 维度权重配置：同极 / 异极各自的基准分 */
export interface MbtiDimensionWeight {
  readonly same: number;
  readonly different: number;
}

/** 大五单特质配置 */
export interface BigFiveTraitConfig {
  /**
   * 匹配模式
   *   · `SIMILAR` —— 越接近越好（如尽责性：差异大意味着家务与deadline 预期冲突）
   *   · `COMPLEMENTARY` —— 差异接近 `idealGap` 时最好（如外向性：差 20 分左右互补，差 60 分则生活节奏难同步）
   */
  readonly mode: 'SIMILAR' | 'COMPLEMENTARY';
  /** `COMPLEMENTARY` 模式下的理想差值（0–100） */
  readonly idealGap?: number;
  /** 子项内部权重 */
  readonly weight: number;
}

/** 匹配权重配置（对应 `compatibility_weights` 一行） */
export interface CompatibilityWeights {
  readonly version: string;
  readonly mbtiMatrix: Readonly<Record<MbtiDimension, MbtiDimensionWeight>>;
  readonly bigFiveConfig: Readonly<Record<string, BigFiveTraitConfig>>;
  /** 依恋组合矩阵：`attachmentMatrix[A][B]`（应对称，不要求调用方保证） */
  readonly attachmentMatrix: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** 四个子项的全局权重（引擎会归一化，允许不恰好等于 100） */
  readonly dimensionWeights: {
    readonly mbti: number;
    readonly bigFive: number;
    readonly attachment: number;
    readonly communication: number;
  };
  /** 爱的语言每命中一项的加分，以及基准分 */
  readonly communicationConfig?: {
    readonly loveLanguageBase: number;
    readonly loveLanguagePerMatch: number;
    readonly conflictStyleSame: number;
    readonly conflictStyleDifferent: number;
  };
}

/** 单个子项得分 */
export interface SubScore {
  readonly score: number;
  /** 该子项是否参与了总分（数据缺失时不计入，权重会被重新归一） */
  readonly counted: boolean;
  /** 逐条明细（可解释性的载体） */
  readonly breakdown: Readonly<Record<string, unknown>>;
}

/** 引擎输出（直接对应 `compatibility_reports` 的字段） */
export interface CompatibilityResult {
  readonly totalScore: number;
  readonly mbtiScore: number | null;
  readonly bigFiveScore: number | null;
  readonly attachmentScore: number | null;
  readonly communicationScore: number | null;
  readonly scoreBreakdown: Readonly<Record<string, unknown>>;
  readonly engineVersion: string;
  /** 被剔除的维度（数据缺失），供报告如实说明"哪些维度无法评估" */
  readonly skippedDimensions: readonly string[];
}

/** 默认沟通配置 */
const DEFAULT_COMMUNICATION = {
  loveLanguageBase: 50,
  loveLanguagePerMatch: 25,
  conflictStyleSame: 100,
  conflictStyleDifferent: 60,
} as const;

// ============================================================================
// 子项算法
// ============================================================================

/**
 * MBTI 维度互补性
 *
 * 用**插值**处理偏好强度，而不是简单的同/异二元判断：
 * 两个人的偏好都接近 50 时，这一维度本身信号很弱 ——
 * 此时无论"同极"还是"异极"都不该给出极端分数。
 *
 * 公式：`score = NEUTRAL + (anchor - NEUTRAL) × 平均强度`
 *   · 双方偏好都很强（强度→1）→ 完全采用 anchor（同极/异极基准分）
 *   · 双方都在 50 附近（强度→0）→ 收敛到中性分（"信号不足"）
 */
const scoreMbtiDimension = (
  dimension: MbtiDimension,
  percentA: number | null,
  percentB: number | null,
  weight: MbtiDimensionWeight,
): { score: number; detail: Record<string, unknown> } | null => {
  if (percentA === null || percentB === null) return null;

  const poleA = percentA >= 50 ? POSITIVE_POLES[dimension] : oppositeOf(dimension);
  const poleB = percentB >= 50 ? POSITIVE_POLES[dimension] : oppositeOf(dimension);
  const isSame = poleA === poleB;

  const strengthA = Math.abs(percentA - 50) / 50;
  const strengthB = Math.abs(percentB - 50) / 50;
  const avgStrength = (strengthA + strengthB) / 2;

  const anchor = isSame ? weight.same : weight.different;
  const score = NEUTRAL_SCORE + (anchor - NEUTRAL_SCORE) * avgStrength;

  return {
    score: clamp(score, 0, 100),
    detail: {
      dimension,
      poleA,
      poleB,
      isSame,
      anchor,
      avgStrength: roundTo(avgStrength, 2),
    },
  };
};

/** 维度负极字母 */
const oppositeOf = (dimension: MbtiDimension): string => ({ EI: 'I', SN: 'N', TF: 'F', JP: 'P' })[dimension];

/** 大五单特质得分 */
const scoreBigFiveTrait = (
  trait: string,
  valueA: number | null,
  valueB: number | null,
  config: BigFiveTraitConfig,
): { score: number; weight: number; detail: Record<string, unknown> } | null => {
  if (valueA === null || valueB === null) return null;

  const gap = Math.abs(valueA - valueB);

  let score: number;
  if (config.mode === 'SIMILAR') {
    // 差 0 → 100 分；差 100 → 0 分
    score = 100 - gap;
  } else {
    // 差 0 → 0 分；差 100 → 0 分
    score = 100 - Math.abs((config.idealGap ?? 20) - gap) * 2;
  }

  return {
    score: clamp(score, 0, 100),
    weight: config.weight,
    detail: { trait, mode: config.mode, gap: roundTo(gap, 1), valueA, valueB },
  };
};

/** 依恋风格组合得分（矩阵可能只写了一个方向，因此双向查找） */
const scoreAttachment = (
  styleA: string | null,
  styleB: string | null,
  matrix: CompatibilityWeights['attachmentMatrix'],
): { score: number; detail: Record<string, unknown> } | null => {
  if (styleA === null || styleB === null) return null;

  const direct = matrix[styleA]?.[styleB];
  const reverse = matrix[styleB]?.[styleA];
  const score = direct ?? reverse;

  // 矩阵未覆盖该组合：不猜分数，按缺失处理（由调用方剔除该维度）
  if (score === undefined) return null;

  return { score: clamp(score, 0, 100), detail: { styleA, styleB } };
};

/** 沟通偏好一致性 */
const scoreCommunication = (
  profileA: CompatibilityProfile,
  profileB: CompatibilityProfile,
  config: NonNullable<CompatibilityWeights['communicationConfig']>,
): { score: number; detail: Record<string, unknown> } => {
  const setA = new Set(profileA.loveLanguages);
  const shared = profileB.loveLanguages.filter((code) => setA.has(code));

  // 爱的语言：基准分 + 每命中一项加分（上限 100）
  const languageScore = clamp(config.loveLanguageBase + shared.length * config.loveLanguagePerMatch, 0, 100);

  // 冲突风格：相同给满分，不同给基准分（不同不等于不好，只是需要更多沟通成本）
  const bothHaveConflictStyle = profileA.conflictStyle !== null && profileB.conflictStyle !== null;
  const conflictScore = bothHaveConflictStyle
    ? profileA.conflictStyle === profileB.conflictStyle
      ? config.conflictStyleSame
      : config.conflictStyleDifferent
    : null;

  // 只有一项可用时以该项为准；两项都有时取均值
  const parts = [languageScore, ...(conflictScore === null ? [] : [conflictScore])];

  return {
    score: mean(parts),
    detail: {
      sharedLoveLanguages: shared,
      loveLanguageScore: roundTo(languageScore, 1),
      conflictStyleA: profileA.conflictStyle,
      conflictStyleB: profileB.conflictStyle,
      conflictScore: conflictScore === null ? null : roundTo(conflictScore, 1),
    },
  };
};

// ============================================================================
// 主入口
// ============================================================================

/**
 * 计算匹配度
 *
 * 缺数据维度的处理是**重新归一权重**：某维度被剔除后，其余维度的权重按比例放大，
 * 总分仍落在 0–100。若一个维度都没有数据，则直接失败 ——
 * 没有依据的"匹配度 65 分"比明确报错更有害。
 *
 * @throws AI_OUTPUT_INVALID 当四个维度全部无法评估时
 */
export const computeCompatibility = (
  profileA: CompatibilityProfile,
  profileB: CompatibilityProfile,
  weights: CompatibilityWeights,
): CompatibilityResult => {
  const skipped: string[] = [];

  // ---- ① MBTI ----
  const mbtiDetails: Record<string, unknown> = {};
  const mbtiScores: number[] = [];

  for (const dimension of MBTI_DIMENSIONS) {
    const percents = {
      EI: [profileA.eiPercent, profileB.eiPercent],
      SN: [profileA.snPercent, profileB.snPercent],
      TF: [profileA.tfPercent, profileB.tfPercent],
      JP: [profileA.jpPercent, profileB.jpPercent],
    }[dimension];

    const result = scoreMbtiDimension(dimension, percents[0], percents[1], weights.mbtiMatrix[dimension]);

    if (result === null) continue;
    mbtiScores.push(result.score);
    mbtiDetails[dimension] = result.detail;
  }

  const mbti: SubScore =
    mbtiScores.length === 0
      ? { score: 0, counted: false, breakdown: {} }
      : { score: mean(mbtiScores), counted: true, breakdown: mbtiDetails };
  if (!mbti.counted) skipped.push('mbti');

  // ---- ② 大五 ----
  const bigFiveDetails: Record<string, unknown> = {};
  const bigFiveValues: Array<{ score: number; weight: number }> = [];

  for (const [trait, config] of Object.entries(weights.bigFiveConfig)) {
    const valueA = profileA[trait as keyof CompatibilityProfile] as number | null;
    const valueB = profileB[trait as keyof CompatibilityProfile] as number | null;

    const result = scoreBigFiveTrait(trait, valueA, valueB, config);
    if (result === null) continue;

    bigFiveValues.push({ score: result.score, weight: result.weight });
    bigFiveDetails[trait] = result.detail;
  }

  const bigFive: SubScore =
    bigFiveValues.length === 0
      ? { score: 0, counted: false, breakdown: {} }
      : {
          // 按特质权重加权平均（不再是简单平均），保证"哪个特质更重要"可配置
          score: weightedMean(bigFiveValues),
          counted: true,
          breakdown: bigFiveDetails,
        };
  if (!bigFive.counted) skipped.push('bigFive');

  // ---- ③ 依恋风格 ----
  const attachmentRaw = scoreAttachment(profileA.attachmentStyle, profileB.attachmentStyle, weights.attachmentMatrix);
  const attachment: SubScore =
    attachmentRaw === null
      ? { score: 0, counted: false, breakdown: {} }
      : { score: attachmentRaw.score, counted: true, breakdown: attachmentRaw.detail };
  if (!attachment.counted) skipped.push('attachment');

  // ---- ④ 沟通偏好 ----
  const communicationRaw = scoreCommunication(profileA, profileB, weights.communicationConfig ?? DEFAULT_COMMUNICATION);
  const communication: SubScore = {
    score: communicationRaw.score,
    counted: true,
    breakdown: communicationRaw.detail,
  };

  // ---- 总分：剔除缺失维度后重新归一权重 ----
  const configured = weights.dimensionWeights;
  const countedWeights = [
    { name: 'mbti', sub: mbti, weight: configured.mbti },
    { name: 'bigFive', sub: bigFive, weight: configured.bigFive },
    { name: 'attachment', sub: attachment, weight: configured.attachment },
    { name: 'communication', sub: communication, weight: configured.communication },
  ].filter((item) => item.sub.counted);

  const totalWeight = countedWeights.reduce((sum, item) => sum + Math.max(0, item.weight), 0);

  if (totalWeight <= 0) {
    throw new BusinessException(ErrorCode.AI_OUTPUT_INVALID, '双方数据不足，无法计算匹配度');
  }

  const totalScore = clamp(
    countedWeights.reduce((sum, item) => sum + item.sub.score * Math.max(0, item.weight), 0) / totalWeight,
    0,
    100,
  );

  return {
    totalScore: roundTo(totalScore, 1),
    mbtiScore: mbti.counted ? roundTo(mbti.score, 1) : null,
    bigFiveScore: bigFive.counted ? roundTo(bigFive.score, 1) : null,
    attachmentScore: attachment.counted ? roundTo(attachment.score, 1) : null,
    communicationScore: roundTo(communication.score, 1),
    scoreBreakdown: {
      weightsVersion: weights.version,
      engineVersion: COMPATIBILITY_ENGINE_VERSION,
      appliedWeights: Object.fromEntries(
        countedWeights.map((item) => [item.name, roundTo(Math.max(0, item.weight) / totalWeight, 4)]),
      ),
      skippedDimensions: skipped,
      mbti: mbti.breakdown,
      bigFive: bigFive.breakdown,
      attachment: attachment.breakdown,
      communication: communication.breakdown,
    },
    engineVersion: COMPATIBILITY_ENGINE_VERSION,
    skippedDimensions: skipped,
  };
};

/** 按权重求平均（权重全为 0 时退化为算术平均） */
const weightedMean = (items: readonly { score: number; weight: number }[]): number => {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return mean(items.map((item) => item.score));

  return items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
};
