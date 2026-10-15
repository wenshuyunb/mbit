/**
 * 单题有效值计算 —— 各测评模块**共用的唯一实现**
 *
 * ## 为什么必须共用
 *
 * 这段逻辑里有好几个"看着显然、写错就静默出错"的细节：
 *   · 反向计分是 `scaleMin + scaleMax − value`，而不是 `maxValue − value`（量程不一定是 0 起）；
 *   · `resolveScale` 的三级优先级（显式声明 → 由选项分值推导 → 题型默认），
 *     其中第二级要求**全部选项都带该维度分值**，部分覆盖时会推出误导性的跨度；
 *   · 排序题的位置分分母：只有一个选项时取 1，否则会因分母退化为 0 而恒判最低分；
 *   · 排序题**不支持叠加反向计分**（它本身已表达方向，叠加会造成语义混乱）。
 *
 * 这些都不是"每个模块各自实现一遍"能保证一致的。情感引擎如果自己写一份，
 * 结果就是同一份作答在人格与情感两个模块里被以不同口径评分，而且没有任何报错。
 */

import { clamp, normalizeToUnit, roundTo } from './engine-math.util';
import { DEFAULT_SCALE, type EngineAnswer, type EngineQuestion } from './assessment.types';

/** 在 `scoreMap` 中按维度名（大小写不敏感）查找分值 */
export const findScoreIgnoreCase = (scoreMap: Record<string, number> | null, dimension: string): number | undefined => {
  if (!scoreMap) return undefined;

  for (const [key, value] of Object.entries(scoreMap)) {
    if (key.toUpperCase() === dimension) return value;
  }

  return undefined;
};

/**
 * 查找选项的维度分（`scoreMap[维度]`），找不到返回 null
 *
 * @param dimension 目标维度；默认取题目自己声明的那个。
 *                  **显式传入**是为沉浸式场景题准备的（ADR-039）：一道场景题的选项
 *                  会同时给出多个维度的分值，因此同一份作答需要对多个维度各算一次。
 */
export const findOptionDimensionScore = (
  question: EngineQuestion,
  optionValue: number,
  dimension: string = question.dimension,
): number | null => {
  const option = question.options.find((item) => item.value === optionValue);
  if (!option?.scoreMap) return null;

  const target = dimension.toUpperCase();

  // 维度键大小写不敏感，便于后台录入
  for (const [key, value] of Object.entries(option.scoreMap)) {
    if (key.toUpperCase() === target && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
};

/**
 * 用户所选选项**覆盖了哪些维度**（大写；无 `scoreMap` 时为空数组）
 *
 * 沉浸式场景题的算分入口：一个"你会怎么做"的选择会同时透露依恋、冲突风格与
 * 爱的语言，因此要按选项里实际出现的维度逐个累加，而不是只算题目自己声明的那一个。
 *
 * ⚠ 量表题（选项 `scoreMap` 为空）返回空数组，调用方据此回退到"只算题目声明的维度"，
 * 从而保证既有量表题的算分口径**一字不变**（ADR-005 的回归要求）。
 *
 * 排序题返回空数组：它的作答是"一串选项"，语义由 `computeRankEffectiveValue` 处理，
 * 不适用"某个选项带哪些维度"。
 */
export const optionScoreMapDimensions = (question: EngineQuestion, answer: EngineAnswer): string[] => {
  if (question.type === 'RANK') return [];

  const rawValue = Array.isArray(answer.value) ? answer.value[0] : answer.value;
  if (rawValue === undefined || !Number.isFinite(rawValue)) return [];

  const option = question.options.find((item) => item.value === rawValue);
  if (!option?.scoreMap) return [];

  return Object.entries(option.scoreMap)
    .filter(([, value]) => Number.isFinite(value))
    .map(([key]) => key.toUpperCase());
};

/**
 * 解析题目的量表范围
 *
 * 优先级（自上而下，先满足先用）：
 *   1. 题目**显式声明**的 minValue/maxValue（且必须 min < max，否则视为配置错误而跳过）
 *   2. 由**全部选项**的维度分值推导出的跨度
 *      —— 迫选题的 `scoreMap` 可以给出任意值域（如 1 与 5、0 与 3），
 *         若仍套用题型默认的 0–1 会把分值截断到边界，导致结果失真。
 *         要求「全部选项都带该维度分值」是为了避免部分覆盖时推出误导性的跨度。
 *   3. 题型默认量表（见 `DEFAULT_SCALE`）
 */
export const resolveScale = (
  question: EngineQuestion,
  dimension: string = question.dimension,
): { min: number; max: number } => {
  const target = dimension.toUpperCase();
  // DEFAULT_SCALE 对全部题型都是穷尽的（Record<EngineQuestionType, ...>），
  // 因此这里无需兜底 —— 新增题型时 TypeScript 会直接报错，比运行时兜底更早暴露问题
  const fallback = DEFAULT_SCALE[question.type];

  // 1) 显式声明
  const declaredMin = question.minValue;
  const declaredMax = question.maxValue;

  if (
    declaredMin !== null &&
    declaredMin !== undefined &&
    declaredMax !== null &&
    declaredMax !== undefined &&
    Number.isFinite(declaredMin) &&
    Number.isFinite(declaredMax) &&
    declaredMin < declaredMax
  ) {
    return { min: declaredMin, max: declaredMax };
  }

  // 2) 由选项分值推导
  if (question.options.length > 0) {
    const scores: number[] = [];
    let allCovered = true;

    for (const option of question.options) {
      const score = findScoreIgnoreCase(option.scoreMap, target);

      if (score === undefined || !Number.isFinite(score)) {
        allCovered = false;
        break;
      }
      scores.push(score);
    }

    if (allCovered && scores.length >= 2) {
      const min = Math.min(...scores);
      const max = Math.max(...scores);

      /**
       * ⚠ 这里**不**要求 `min < max`（ADR-039）
       *
       * 全部选项都给同一个分值 = 这道题对该维度**不携带任何信息**。
       * 旧写法在这种情况下会退回题型默认量程（如 0–1），而选项分值可能是 3，
       * 于是 `clamp(3, 0, 1) = 1` —— **所有人这一维度都是满分**，
       * 而且没有任何报错：一个写错的选项分值会变成整份画像上的固定偏移。
       *
       * 返回退化的 `{ min: min, max: max }`（min === max）则会把"零信息"如实传下去：
       * `normalizeToUnit` 对退化量程返回 0，累加器的 `weightedMax - weightedMin` 也是 0，
       * 最终 `finalizeDimension.usable = false` —— 该维度不出结论（中位 50 仅作占位），
       * 正是"没有数据就不该有结论"应有的表现。
       *
       * 对既有量表题无影响：它们的选项没有 `scoreMap`，`allCovered` 恒为 false。
       */
      if (min <= max) return { min, max };
    }
  }

  // 3) 题型默认值
  return fallback;
};

/**
 * 排序题的有效值
 *
 * 语义：用户在「把以下选项按重要性排序」中给出的顺序。
 * 算法：对每个带维度权重的选项计算其位置分（越靠前越高），
 *       按维度权重做加权平均后映射到该题的 [scaleMin, scaleMax]。
 *
 * 这样「最看重 A、其次 B」的信息不会被丢弃成「只看第一名」。
 */
const computeRankEffectiveValue = (
  question: EngineQuestion,
  answer: EngineAnswer,
  scale: { min: number; max: number },
): { value: number; scaleMin: number; scaleMax: number } | null => {
  const ordered = Array.isArray(answer.value) ? answer.value : [answer.value];
  if (ordered.length === 0) return null;

  const dimension = question.dimension.toUpperCase();
  const denominator = Math.max(1, ordered.length - 1);

  let weightedPosition = 0;
  let totalWeight = 0;

  ordered.forEach((optionValue, index) => {
    const option = question.options.find((item) => item.value === optionValue);
    const dimensionWeight = findScoreIgnoreCase(option?.scoreMap ?? null, dimension);
    if (dimensionWeight === undefined || !Number.isFinite(dimensionWeight) || dimensionWeight <= 0) return;

    // 位置分：第 0 位 = 1（最偏好），最后一位 = 0。
    // 只有一个选项时它既是第一位也是最后一位，取 1（「你唯一排出的就是你的首选」），
    // 否则会因分母退化而恒为 0，把该题错误地算成最低分。
    const positionScore = ordered.length === 1 ? 1 : (ordered.length - 1 - index) / denominator;
    weightedPosition += positionScore * dimensionWeight;
    totalWeight += dimensionWeight;
  });

  if (totalWeight <= 0) return null;

  const ratio = clamp(weightedPosition / totalWeight, 0, 1);
  const value = scale.min + ratio * (scale.max - scale.min);

  // 排序题本身已表达「偏好方向」，再叠加反向计分会造成语义混乱 —— 因此不支持叠加
  return { value, scaleMin: scale.min, scaleMax: scale.max };
};

/**
 * 计算单题在某维度上的有效原始分与量表范围
 *
 * @param dimension 目标维度；默认取题目自己声明的那个。**显式传入**时（ADR-039）
 *                  用于沉浸式场景题：一道题的选项同时给出多个维度的分值，
 *                  于是同一份作答要对每个维度各算一次有效值与量程。
 * @returns null 表示该题无法为**该维度**贡献得分
 */
export const computeEffectiveValue = (
  question: EngineQuestion,
  answer: EngineAnswer,
  dimension: string = question.dimension,
): { value: number; scaleMin: number; scaleMax: number } | null => {
  if (question.type === 'RANK') {
    return computeRankEffectiveValue(question, answer, resolveScale(question, dimension));
  }

  const scale = resolveScale(question, dimension);

  const rawValue = Array.isArray(answer.value) ? answer.value[0] : answer.value;

  if (rawValue === undefined || !Number.isFinite(rawValue)) return null;

  // 优先使用「选项 → 维度分」映射（迫选题中同一题的不同选项贡献不同）
  const optionScore = findOptionDimensionScore(question, rawValue, dimension);
  const effectiveRaw = optionScore ?? rawValue;

  // 反向计分：把语义翻转到同一极（等价于 max − value）
  const value = question.reverseScored ? scale.min + scale.max - effectiveRaw : effectiveRaw;

  return { value: clamp(value, scale.min, scale.max), scaleMin: scale.min, scaleMax: scale.max };
};

/** 单维度的累加器（加权累加 + 正/反向值分离，供一致性分析） */
export interface DimensionAccumulator {
  weightedScore: number;
  weightedMin: number;
  weightedMax: number;
  answeredCount: number;
  /** 正向题的归一化值（0–1，**已应用反向修正**，与反向题同向可比） */
  forwardValues: number[];
  /** 反向题的归一化值（0–1，**已应用反向修正**，用于一致性分析） */
  reverseValues: number[];
  /** 是否至少有一道题真正贡献了权重（用于区分「没作答」与「作答了但权重为 0」） */
  hasWeight: boolean;
}

export const createDimensionAccumulator = (): DimensionAccumulator => ({
  weightedScore: 0,
  weightedMin: 0,
  weightedMax: 0,
  answeredCount: 0,
  forwardValues: [],
  reverseValues: [],
  hasWeight: false,
});

/**
 * 把一道题的有效值累加进某维度的累加器
 *
 * @param normalized 该题归一化到 0–1 的值（已应用反向修正）
 */
export const accumulateDimension = (
  accumulator: DimensionAccumulator,
  params: {
    effective: { value: number; scaleMin: number; scaleMax: number };
    weight: number;
    reverseScored: boolean;
  },
): void => {
  const { effective, weight, reverseScored } = params;

  accumulator.weightedScore += effective.value * weight;
  accumulator.weightedMin += effective.scaleMin * weight;
  accumulator.weightedMax += effective.scaleMax * weight;
  accumulator.answeredCount += 1;
  accumulator.hasWeight = accumulator.hasWeight || weight > 0;

  // 必须走 `normalizeToUnit`：它对 `scaleMax <= scaleMin` 这种退化量程返回 0
  // （表示"该题不携带信息"），而不是除零得到 NaN 污染后续一致性计算
  const normalized = normalizeToUnit(effective.value, effective.scaleMin, effective.scaleMax);
  if (reverseScored) {
    accumulator.reverseValues.push(normalized);
  } else {
    accumulator.forwardValues.push(normalized);
  }
};

/**
 * 把累加器收敛成「归一化百分比 + 是否具备有效数据」
 *
 * `usable = false` 时返回中位 50 作为**占位**，调用方必须把 `usable` 一起带着走 ——
 * 否则"没有数据"会被当成"正好 50 分"读进报告里，变成一句凭空捏造的结论。
 *
 * raw 分做 `roundTo` 与落库口径一致（避免浮点长尾如 71.00000000000001 落库后比对困难）。
 */
export const finalizeDimension = (accumulator: DimensionAccumulator): FinalizedDimension => {
  const range = accumulator.weightedMax - accumulator.weightedMin;
  const usable = accumulator.answeredCount > 0 && accumulator.hasWeight && range > 0;

  const percent = usable ? clamp(((accumulator.weightedScore - accumulator.weightedMin) / range) * 100, 0, 100) : 50;

  return {
    percent,
    usable,
    raw: {
      weightedScore: roundTo(accumulator.weightedScore),
      weightedMin: roundTo(accumulator.weightedMin),
      weightedMax: roundTo(accumulator.weightedMax),
      answeredCount: accumulator.answeredCount,
    },
  };
};

/** `finalizeDimension` 的结果 */
export interface FinalizedDimension {
  /** 归一化百分比（0–100）；无有效数据时为中位 50（仅占位） */
  percent: number;
  /** 是否有足够数据支撑该百分比（false 表示 50 只是占位，不代表测量结果） */
  usable: boolean;
  raw: { weightedScore: number; weightedMin: number; weightedMax: number; answeredCount: number };
}
