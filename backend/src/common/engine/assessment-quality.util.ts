/**
 * 答题质量指标 —— 各测评模块**共用的唯一实现**
 *
 * ## 为什么必须共用（而不是每个引擎抄一份）
 *
 * 这里有一段用血的教训换来的判据：`computeConsistency` 比较的必须是
 * **反向修正之后**的归一化值，不能是原始值 —— 两者数学上等价，
 * 但**一旦混用**（例如正向用原始、反向用修正），
 * 「一条线全选满分」这种最典型的乱答会被算成**高一致性**。
 * 这个 bug 真实发生过（见 `personality-engine.service.spec.ts` 的相关用例）。
 *
 * 逻辑抄一份到情感引擎，就意味着这个教训要在两处分别保持正确 ——
 * 而第二处没有任何测试会提醒你写错了。因此抽到这里，
 * 由人格引擎与情感引擎共同调用，行为由一份测试锁定。
 */

import { clamp, mean, roundTo } from './engine-math.util';
import type { EngineAnswer, QualityMetrics } from './assessment.types';

/** 过快作答阈值（毫秒）：低于该值视为「未认真读题」 */
export const RUSH_THRESHOLD_MS = 1200;

/**
 * 一致性计算的输入：每个维度的正/反向归一化值
 *
 * ⚠ 传入的数值必须是**已应用反向修正**的（即反向题的 `scaleMin + scaleMax − raw`），
 * 这样正反向题才同向可比。调用方在累加阶段就该完成修正。
 */
export interface DimensionPairValues {
  readonly forward: readonly number[];
  readonly reverse: readonly number[];
}

export interface QualityInput {
  /** 各维度的正/反向归一化值（顺序不影响结果：内部取平均偏差） */
  readonly dimensionPairValues: readonly DimensionPairValues[];
  readonly validAnsweredCount: number;
  readonly skippedCount: number;
  readonly totalCount: number;
  readonly responseMsSum: number;
  readonly responseMsCount: number;
  readonly rushCount: number;
}

/**
 * 作答一致性：正/反向题是否互相印证
 *
 * 原理：引擎在算分时已把反向题的语义**翻转**到与正向题同一极
 *       （`effective = scaleMin + scaleMax − raw`）。
 *       因此翻转之后，同一维度的正向题与反向题应当给出**相近**的归一化值：
 *         · 一致作答者：正向题 5、反向题 1 → 翻转后两者都是「高」→ 差值 ≈ 0
 *         · 乱答/一条线选满分者：正向题 5、反向题 5 → 翻转后前高后低 → 差值大
 *
 * ⚠ 注意：这里比较的是**翻转后**的值，因此判据是 `|forward − reverse|`；
 *    若改为比较翻转前的原始值，判据才应是 `|forward + reverse − 1|`。
 *    两者等价，但不可混用（曾因混用导致「一条线全选满分」被误判为高一致性）。
 *
 * 无正/反向题配对的维度无法评估，**不计入平均**（避免因题库结构惩罚用户）。
 * 所有维度都无法评估时返回 100（不做无依据的扣分）。
 */
export const computeConsistencyScore = (dimensionPairValues: readonly DimensionPairValues[]): number => {
  const deviations: number[] = [];

  for (const values of dimensionPairValues) {
    if (values.forward.length === 0 || values.reverse.length === 0) continue;

    const forwardMean = mean(values.forward);
    const reverseMean = mean(values.reverse);

    // 翻转后两者语义同向，理想情况完全相等
    deviations.push(Math.abs(forwardMean - reverseMean));
  }

  if (deviations.length === 0) return 100;

  const meanDeviation = mean(deviations);
  return roundTo(clamp((1 - meanDeviation) * 100, 0, 100));
};

/** 组装质量指标 */
export const computeQualityMetrics = (input: QualityInput): QualityMetrics => {
  const completionRate =
    input.totalCount === 0 ? 0 : roundTo(clamp((input.validAnsweredCount / input.totalCount) * 100, 0, 100));

  return {
    consistencyScore: computeConsistencyScore(input.dimensionPairValues),
    completionRate,
    avgResponseMs: input.responseMsCount === 0 ? null : Math.round(input.responseMsSum / input.responseMsCount),
    answeredCount: input.validAnsweredCount,
    skippedCount: input.skippedCount,
    totalCount: input.totalCount,
    rushRate: input.validAnsweredCount === 0 ? 0 : roundTo(clamp(input.rushCount / input.validAnsweredCount, 0, 1), 4),
  };
};

/** 仅在答案带有耗时数据时回调（避免把 undefined 当成 0 拉低均值） */
export const collectResponseMetrics = (answer: EngineAnswer, onValue: (value: number) => void): void => {
  if (typeof answer.responseMs === 'number' && Number.isFinite(answer.responseMs) && answer.responseMs >= 0) {
    onValue(answer.responseMs);
  }
};

/** 是否属于「过快作答」 */
export const isRushedAnswer = (answer: EngineAnswer): boolean =>
  typeof answer.responseMs === 'number' && answer.responseMs >= 0 && answer.responseMs < RUSH_THRESHOLD_MS;
