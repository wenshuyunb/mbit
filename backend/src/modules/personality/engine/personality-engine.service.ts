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
  collectResponseMetrics as collectResponseMetricsShared,
  computeQualityMetrics,
  isRushedAnswer,
} from '../../../common/engine/assessment-quality.util';
import {
  accumulateDimension,
  computeEffectiveValue,
  createDimensionAccumulator,
  finalizeDimension,
  type DimensionAccumulator,
} from '../../../common/engine/assessment-scoring.util';
import {
  BIG_FIVE_DIMENSIONS,
  ENGINE_VERSION,
  MBTI_DIMENSIONS,
  type BigFiveDimension,
  type BigFiveResult,
  type EngineAnswer,
  type MbtiDimension,
  type MbtiResult,
  type PersonalityEngineInput,
  type PersonalityEngineOutput,
  type QualityMetrics,
} from './personality-engine.types';
import { clamp, mean, roundTo } from './engine-math.util';
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

/**
 * 参与算分的维度白名单
 *
 * ⚠ 这里**只列人格模块的维度**。情感模块的 12 个维度（`ATTACH_*` / `LOVE_*` /
 * `CONFLICT_*`）故意不在其中：它们由情感引擎单独算分，人格引擎见到它们时
 * 按"非算分维度"处理（计入完成率、不参与得分）。
 *
 * 这正是"三个模块互不干扰"的机制之一 —— 情感题混进人格试卷时**不会**污染人格分数；
 * 而 `submit()` 侧还有一道模块分派与落库护栏把关（ADR-038 阶段 1）。
 */
const SCORABLE_DIMENSIONS: readonly string[] = [...MBTI_DIMENSIONS, ...BIG_FIVE_DIMENSIONS];

/** 维度最终结果：百分比 + 是否具备有效数据 */
interface DimensionOutcome {
  /** 归一化百分比（0–100）；无有效数据时为中位 50 */
  percent: number;
  /** 是否有足够数据支撑该百分比（false 表示 50 只是占位，不代表测量结果） */
  usable: boolean;
}

// 维度累加器与单题有效值的实现已抽到 `common/engine/assessment-scoring.util.ts`
// （ADR-038 阶段 3）：这些边界语义**必须两个模块完全一致** ——
// 反向计分用 `scaleMin + scaleMax − value`、`resolveScale` 的三级优先级、
// 排序题位置分的退化处理。情感引擎若自己写一份，同一份作答会被人格与情感
// 两个模块以不同口径评分，而且没有任何报错。

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

      const effective = computeEffectiveValue(question, answer);

      // 无法计算有效值（如选项分值缺失、排序题无有效权重）→ 视为未答
      if (effective === null) continue;

      const accumulator = accumulators.get(dimension) ?? createDimensionAccumulator();
      accumulators.set(dimension, accumulator);

      // 累加与归一化走共用实现：情感引擎用同一套口径
      accumulateDimension(accumulator, {
        effective,
        weight: question.weight,
        reverseScored: question.reverseScored,
      });

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
      const finalized = finalizeDimension(accumulator);

      outcomes.set(dimension, { percent: finalized.percent, usable: finalized.usable });
      rawScores[dimension] = finalized.raw;
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
  // 单题有效值 / 量表解析
  // ==========================================================================

  // 实现已抽到 `common/engine/assessment-scoring.util.ts`（ADR-038 阶段 3）。
  // 抽走的原因不是"代码整洁"：这些边界语义必须两个模块完全一致 ——
  // 反向计分用 `scaleMin + scaleMax − value`（量程不一定 0 起）、
  // `resolveScale` 的三级优先级、排序题位置分在单选题上的退化处理。
  // 情感引擎若自己写一份，同一份作答会被人格与情感两个模块以不同口径评分，
  // 而且不会有任何报错。

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

    // 质量指标的算法**不在此处实现**：它与测的是人格还是情感无关，
    // 抽到 `common/engine/assessment-quality.util.ts` 由三个模块共用，
    // 这样「一致性必须比较翻转后的值」这条教训只需要在一处保持正确（ADR-038 阶段 3）
    return computeQualityMetrics({
      dimensionPairValues: [...accumulators.values()].map((accumulator) => ({
        forward: accumulator.forwardValues,
        reverse: accumulator.reverseValues,
      })),
      validAnsweredCount,
      skippedCount,
      totalCount,
      responseMsSum: params.responseMsSum,
      responseMsCount: params.responseMsCount,
      rushCount: params.rushCount,
    });
  }

  // ==========================================================================
  // 工具
  // ==========================================================================

  /**
   * 仅在答案带有耗时数据时回调（避免把 undefined 当成 0 拉低均值）
   *
   * 实现已抽到 `common/engine/assessment-quality.util.ts`：情感引擎需要完全相同的
   * 耗时采集口径，否则同一份作答在两个模块里的「平均耗时」会不一样。
   */
  private collectResponseMetrics(answer: EngineAnswer, onValue: (value: number) => void): void {
    collectResponseMetricsShared(answer, onValue);
  }

  /** 是否属于「过快作答」（阈值与情感引擎共用同一个常量） */
  private isRushed(answer: EngineAnswer): boolean {
    return isRushedAnswer(answer);
  }
}
