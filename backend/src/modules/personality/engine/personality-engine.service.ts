/**
 * 人格算法引擎（纯函数）
 *
 * 契约来源：docs/PROJECT_ARCHITECTURE.md §11.3
 *
 * 核心设计决策（ADR-005）：
 *   **算分必须是确定性的纯函数，AI 只负责解读、不参与算分。**
 *   原因：结果要可复现、可解释、可单测；交给 LLM 会产生分数漂移与不可解释性。
 *
 * 算分公式（四个步骤）：
 *   1. 有效原始分 effectiveRaw
 *        · 若选项 `scoreMap[维度]` 有数值 → 用它（支持迫选题中不同选项对不同维度的贡献差异）
 *        · 否则用选项的 `value`（适用李克特这类线性量表）
 *   2. 反向计分  effective = reverseScored ? (scaleMin + scaleMax - effectiveRaw) : effectiveRaw
 *        （等价于「取 max - value」，把反向题的语义翻转到同一极）
 *   3. 加权累加  weightedScore = Σ effective × weight
 *        同时累加理论上下界 weightedMin / weightedMax = Σ scaleMin/max × weight
 *   4. 归一化    percent = (weightedScore − weightedMin) / (weightedMax − weightedMin) × 100
 *        MBTI 维度为**双极**（0 = 完全负极字母，100 = 完全正极字母）
 *        大五维度为**单极**（0–100 即特质强度）
 *
 * 无 I/O 保证：本文件不 import Prisma / Redis / HTTP，关系风格规则由调用方传入。
 */

import { Injectable } from '@nestjs/common';

import {
  BIG_FIVE_DIMENSIONS,
  DEFAULT_SCALE,
  ENGINE_VERSION,
  MBTI_DIMENSIONS,
  type BigFiveDimension,
  type BigFiveResult,
  type EngineAnswer,
  type EngineQuestion,
  type MbtiDimension,
  type MbtiResult,
  type PersonalityEngineInput,
  type PersonalityEngineOutput,
  type QualityMetrics,
} from './personality-engine.types';
import { clamp, mean, normalizeToUnit, roundTo } from './engine-math.util';
import { resolveRelationshipStyle } from './relationship-style.evaluator';

/** MBTI 维度的正/负极字母（positive ≥ 50 时取正极） */
const MBTI_POLES: Record<MbtiDimension, { positive: string; negative: string }> = {
  EI: { positive: 'E', negative: 'I' },
  SN: { positive: 'S', negative: 'N' },
  TF: { positive: 'T', negative: 'F' },
  JP: { positive: 'J', negative: 'P' },
};

/** 大五维度名 → 输出字段名 */
const BIG_FIVE_FIELDS: Record<BigFiveDimension, keyof BigFiveResult> = {
  OPENNESS: 'openness',
  CONSCIENTIOUSNESS: 'conscientiousness',
  EXTRAVERSION: 'extraversion',
  AGREEABLENESS: 'agreeableness',
  NEUROTICISM: 'neuroticism',
};

/** 过快作答阈值（毫秒）：低于该值视为「未认真读题」 */
const RUSH_THRESHOLD_MS = 1200;

/** 参与算分的维度白名单（ATTACHMENT / LOVE_LANGUAGE / CONFLICT_STYLE 由规则推导，不直接算分） */
const SCORABLE_DIMENSIONS: readonly string[] = [...MBTI_DIMENSIONS, ...BIG_FIVE_DIMENSIONS];

/** 维度最终结果：百分比 + 是否具备有效数据 */
interface DimensionOutcome {
  /** 归一化百分比（0–100）；无有效数据时为中位 50 */
  percent: number;
  /** 是否有足够数据支撑该百分比（false 表示 50 只是占位，不代表测量结果） */
  usable: boolean;
}

/** 维度累加结果 */
interface DimensionAccumulator {
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

const createAccumulator = (): DimensionAccumulator => ({
  weightedScore: 0,
  weightedMin: 0,
  weightedMax: 0,
  answeredCount: 0,
  forwardValues: [],
  reverseValues: [],
  hasWeight: false,
});

@Injectable()
export class PersonalityEngine {
  /** 引擎版本（随画像落库，算法升级产生新版本） */
  readonly version = ENGINE_VERSION;

  /**
   * 计算完整人格画像
   *
   * @param input 试卷题目 + 用户答案 + 关系风格规则（规则可为空）
   * @returns 完整画像结果（纯数据，无副作用）
   */
  compute(input: PersonalityEngineInput): PersonalityEngineOutput {
    const { questions, answers, relationshipRules = [] } = input;

    const questionMap = new Map(questions.map((question) => [question.id, question]));
    const accumulators = new Map<string, DimensionAccumulator>();

    // 只有出现在试卷中的题目才计入总题数（防止把外部题目的作答算进完成率）
    const totalCount = questions.length;
    let validAnsweredCount = 0;
    let skippedCount = 0;
    let responseMsSum = 0;
    let responseMsCount = 0;
    let rushCount = 0;

    for (const answer of answers) {
      const question = questionMap.get(answer.questionId);

      // 题目不属于本试卷：忽略（防御性处理，正常流程不会出现）
      if (!question) continue;

      if (answer.isSkipped === true) {
        skippedCount += 1;
        continue;
      }

      const dimension = question.dimension?.toUpperCase();
      if (!dimension || !SCORABLE_DIMENSIONS.includes(dimension)) {
        // 非算分维度的题目（如 ATTACHMENT 自评）仍计入完成率，但不参与得分
        validAnsweredCount += 1;
        this.collectResponseMetrics(answer, (value) => {
          responseMsSum += value;
          responseMsCount += 1;
        });
        if (this.isRushed(answer)) rushCount += 1;
        continue;
      }

      const effective = this.computeEffectiveValue(question, answer);

      // 无法计算有效值（如选项分值缺失、排序题无有效权重）→ 视为未答
      if (effective === null) continue;

      const accumulator = accumulators.get(dimension) ?? createAccumulator();
      accumulators.set(dimension, accumulator);

      accumulator.weightedScore += effective.value * question.weight;
      accumulator.weightedMin += effective.scaleMin * question.weight;
      accumulator.weightedMax += effective.scaleMax * question.weight;
      accumulator.answeredCount += 1;
      accumulator.hasWeight = accumulator.hasWeight || question.weight > 0;

      const normalized = normalizeToUnit(effective.value, effective.scaleMin, effective.scaleMax);
      if (question.reverseScored) {
        accumulator.reverseValues.push(normalized);
      } else {
        accumulator.forwardValues.push(normalized);
      }

      validAnsweredCount += 1;
      this.collectResponseMetrics(answer, (value) => {
        responseMsSum += value;
        responseMsCount += 1;
      });
      if (this.isRushed(answer)) rushCount += 1;
    }

    // ------------------------------------------------------------------ 百分比
    // 用**单一 Map** 同时承载「归一化百分比」与「是否有效」，
    // 避免出现两个 Map 必须保持同步的隐式不变量（那种不变量一旦被破坏，
    // 就会出现「按 A 判断有数据、按 B 取值为 undefined」的静默错误）。
    const outcomes = new Map<string, DimensionOutcome>();
    const rawScores: PersonalityEngineOutput['rawScores']['dimensions'] = {};

    for (const [dimension, accumulator] of accumulators) {
      const range = accumulator.weightedMax - accumulator.weightedMin;
      const usable = accumulator.answeredCount > 0 && accumulator.hasWeight && range > 0;

      const percent = usable
        ? clamp(((accumulator.weightedScore - accumulator.weightedMin) / range) * 100, 0, 100)
        : 50;

      outcomes.set(dimension, { percent, usable });

      rawScores[dimension] = {
        weightedScore: roundTo(accumulator.weightedScore),
        weightedMin: roundTo(accumulator.weightedMin),
        weightedMax: roundTo(accumulator.weightedMax),
        answeredCount: accumulator.answeredCount,
      };
    }

    // ------------------------------------------------------------------- MBTI
    const mbti = this.deriveMbti(outcomes);

    // --------------------------------------------------------------- 大五人格
    const bigFive = this.deriveBigFive(outcomes);

    // --------------------------------------------------------------- 质量指标
    const quality = this.computeQuality({
      accumulators,
      validAnsweredCount,
      skippedCount,
      totalCount,
      responseMsSum,
      responseMsCount,
      rushCount,
    });

    // --------------------------------------------------------------- 关系风格
    const relationshipStyle = resolveRelationshipStyle(bigFive, relationshipRules);

    return {
      engineVersion: ENGINE_VERSION,
      mbti,
      bigFive,
      relationshipStyle,
      quality,
      rawScores: { dimensions: rawScores },
    };
  }

  // ==========================================================================
  // 单题有效值
  // ==========================================================================

  /**
   * 计算单题在某维度上的有效原始分与量表范围
   *
   * @returns null 表示该题无法为本维度贡献得分
   */
  private computeEffectiveValue(
    question: EngineQuestion,
    answer: EngineAnswer,
  ): { value: number; scaleMin: number; scaleMax: number } | null {
    if (question.type === 'RANK') {
      return this.computeRankEffectiveValue(question, answer, this.resolveScale(question));
    }

    const scale = this.resolveScale(question);

    const rawValue = Array.isArray(answer.value) ? answer.value[0] : answer.value;

    if (rawValue === undefined || !Number.isFinite(rawValue)) return null;

    // 优先使用「选项 → 维度分」映射（迫选题中同一题的不同选项贡献不同）
    const optionScore = this.findOptionDimensionScore(question, rawValue);
    const effectiveRaw = optionScore ?? rawValue;

    // 反向计分：把语义翻转到同一极（等价于 max − value）
    const value = question.reverseScored ? scale.min + scale.max - effectiveRaw : effectiveRaw;

    return { value: clamp(value, scale.min, scale.max), scaleMin: scale.min, scaleMax: scale.max };
  }

  /**
   * 排序题的有效值
   *
   * 语义：用户在「把以下选项按重要性排序」中给出的顺序。
   * 算法：对每个带维度权重的选项计算其位置分（越靠前越高），
   *       按维度权重做加权平均后映射到该题的 [scaleMin, scaleMax]。
   *
   * 这样「最看重 A、其次 B」的信息不会被丢弃成「只看第一名」。
   */
  private computeRankEffectiveValue(
    question: EngineQuestion,
    answer: EngineAnswer,
    scale: { min: number; max: number },
  ): { value: number; scaleMin: number; scaleMax: number } | null {
    const ordered = Array.isArray(answer.value) ? answer.value : [answer.value];
    if (ordered.length === 0) return null;

    const dimension = question.dimension.toUpperCase();
    const denominator = Math.max(1, ordered.length - 1);

    let weightedPosition = 0;
    let totalWeight = 0;

    ordered.forEach((optionValue, index) => {
      const option = question.options.find((item) => item.value === optionValue);
      const dimensionWeight = this.findScoreIgnoreCase(option?.scoreMap ?? null, dimension);
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
  }

  /** 查找选项的维度分（`scoreMap[维度]`），找不到返回 null */
  private findOptionDimensionScore(question: EngineQuestion, optionValue: number): number | null {
    const option = question.options.find((item) => item.value === optionValue);
    if (!option?.scoreMap) return null;

    const dimension = question.dimension.toUpperCase();

    // 维度键大小写不敏感，便于后台录入
    for (const [key, value] of Object.entries(option.scoreMap)) {
      if (key.toUpperCase() === dimension && Number.isFinite(value)) {
        return value;
      }
    }

    return null;
  }

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
  private resolveScale(question: EngineQuestion): { min: number; max: number } {
    const dimension = question.dimension.toUpperCase();
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
        const score = option.scoreMap?.[dimension] ?? this.findScoreIgnoreCase(option.scoreMap, dimension);

        if (score === undefined || !Number.isFinite(score)) {
          allCovered = false;
          break;
        }
        scores.push(score);
      }

      if (allCovered && scores.length >= 2) {
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        if (min < max) return { min, max };
      }
    }

    // 3) 题型默认值
    return fallback;
  }

  /** 在 scoreMap 中按维度名（大小写不敏感）查找分值 */
  private findScoreIgnoreCase(scoreMap: Record<string, number> | null, dimension: string): number | undefined {
    if (!scoreMap) return undefined;

    for (const [key, value] of Object.entries(scoreMap)) {
      if (key.toUpperCase() === dimension) return value;
    }

    return undefined;
  }

  // ==========================================================================
  // MBTI
  // ==========================================================================

  private deriveMbti(outcomes: Map<string, DimensionOutcome>): MbtiResult {
    const dimensions = {} as Record<MbtiDimension, number>;
    let letters = '';
    let typeAvailable = true;

    for (const dimension of MBTI_DIMENSIONS) {
      // 该维度完全没有作答时 outcomes 中不存在条目 → 走中位占位
      const outcome = outcomes.get(dimension);
      const percent = outcome?.percent ?? 50;

      dimensions[dimension] = roundTo(percent);

      if (outcome?.usable !== true) {
        // 某一维度无有效作答时无法给出可靠类型 —— 返回 null 而不是猜测
        typeAvailable = false;
        continue;
      }

      const pole = MBTI_POLES[dimension];
      letters += percent >= 50 ? pole.positive : pole.negative;
    }

    return {
      type: typeAvailable ? letters : null,
      dimensions,
      confidence: this.computeConfidence(outcomes),
    };
  }

  /**
   * 置信度：各维度偏离中位（50）的程度，映射到 0–100
   *
   * 越偏离 50 说明倾向越明确，结果越可信；恰好在 50 附近说明两极性相当，
   * 此时轻微作答波动就会翻转字母，因此置信度低。
   */
  private computeConfidence(outcomes: Map<string, DimensionOutcome>): number {
    const deviations: number[] = [];

    for (const dimension of MBTI_DIMENSIONS) {
      const outcome = outcomes.get(dimension);
      if (outcome?.usable !== true) continue;
      deviations.push(Math.abs(outcome.percent - 50) * 2);
    }

    if (deviations.length === 0) return 0;

    return roundTo(clamp(mean(deviations), 0, 100));
  }

  // ==========================================================================
  // 大五人格
  // ==========================================================================

  private deriveBigFive(outcomes: Map<string, DimensionOutcome>): BigFiveResult {
    const result = {} as BigFiveResult;

    for (const dimension of BIG_FIVE_DIMENSIONS) {
      const field = BIG_FIVE_FIELDS[dimension];
      const outcome = outcomes.get(dimension);

      // 无有效作答时取中位 50：对特质量表而言这是最中性的表达。
      // 调用方可通过 rawScores[维度].answeredCount === 0 识别「无数据」并据此降级展示。
      result[field] = outcome?.usable === true ? roundTo(outcome.percent) : 50;
    }

    return result;
  }

  // ==========================================================================
  // 质量指标
  // ==========================================================================

  private computeQuality(params: {
    accumulators: Map<string, DimensionAccumulator>;
    validAnsweredCount: number;
    skippedCount: number;
    totalCount: number;
    responseMsSum: number;
    responseMsCount: number;
    rushCount: number;
  }): QualityMetrics {
    const { accumulators, validAnsweredCount, skippedCount, totalCount } = params;

    const completionRate = totalCount === 0 ? 0 : roundTo(clamp((validAnsweredCount / totalCount) * 100, 0, 100));

    return {
      consistencyScore: this.computeConsistency(accumulators),
      completionRate,
      avgResponseMs: params.responseMsCount === 0 ? null : Math.round(params.responseMsSum / params.responseMsCount),
      answeredCount: validAnsweredCount,
      skippedCount,
      totalCount,
      rushRate: validAnsweredCount === 0 ? 0 : roundTo(clamp(params.rushCount / validAnsweredCount, 0, 1), 4),
    };
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
  private computeConsistency(accumulators: Map<string, DimensionAccumulator>): number {
    const deviations: number[] = [];

    for (const accumulator of accumulators.values()) {
      if (accumulator.forwardValues.length === 0 || accumulator.reverseValues.length === 0) continue;

      const forwardMean = mean(accumulator.forwardValues);
      const reverseMean = mean(accumulator.reverseValues);

      // 翻转后两者语义同向，理想情况完全相等
      deviations.push(Math.abs(forwardMean - reverseMean));
    }

    if (deviations.length === 0) return 100;

    const meanDeviation = mean(deviations);
    return roundTo(clamp((1 - meanDeviation) * 100, 0, 100));
  }

  // ==========================================================================
  // 工具
  // ==========================================================================

  /** 仅在答案带有耗时数据时回调（避免把 undefined 当成 0 拉低均值） */
  private collectResponseMetrics(answer: EngineAnswer, onValue: (value: number) => void): void {
    if (typeof answer.responseMs === 'number' && Number.isFinite(answer.responseMs) && answer.responseMs >= 0) {
      onValue(answer.responseMs);
    }
  }

  /** 是否属于「过快作答」 */
  private isRushed(answer: EngineAnswer): boolean {
    return typeof answer.responseMs === 'number' && answer.responseMs >= 0 && answer.responseMs < RUSH_THRESHOLD_MS;
  }
}
