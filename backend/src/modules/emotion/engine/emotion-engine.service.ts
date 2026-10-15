/**
 * 情感算法引擎（纯函数）
 *
 * ## 与人格引擎的关系
 *
 * 两个引擎**互不调用**，只在两层共用东西：
 *   · `common/engine/assessment.types.ts` —— 试卷 / 作答 / 质量指标的形状；
 *   · `common/engine/assessment-scoring.util.ts` —— 单题有效值、量表解析、维度累加与归一化。
 *
 * 共用的是"怎么把一张卷子算成维度分数"，**不是"这些分数意味着什么"** ——
 * 后者才是模块各自的业务结论，也是 ADR-038 要求互不干扰的部分。
 *
 * ## 三个族各自的判定（都是公认模型，不是拍脑袋）
 *
 * ### 依恋：ECR 双轴 → 四象限
 *
 * 焦虑轴与回避轴各自 0–100，两条轴按阈值二分，得到四个象限：
 *
 * ```
 *                     回避轴低        回避轴高
 *   焦虑轴低          SECURE          AVOIDANT
 *   焦虑轴高          ANXIOUS         FEARFUL
 * ```
 *
 * ⚠ **象限结论依赖阈值**，而阈值是产品/临床口径问题，因此由调用方传入
 * （默认 50，即 ECR 惯例的中位切分）。轴本身是测量值、与阈值无关，
 * 因此调整阈值**不会**让历史画像的轴分数失真，只会改变类型判定 ——
 * 这也是为什么画像要把两个轴一起落库，而不是只存一个类型标签。
 *
 * ### 爱的语言：五项排序
 *
 * 五项各自 0–100，按分数降序取前 N（默认 2）。
 * 并列时按 `LOVE_LANGUAGE_DIMENSIONS` 的**固定顺序**决定先后 ——
 * 五项全 50 这种"均衡型"真实存在，结果必须稳定可复现，
 * 不能因为排序实现或遍历顺序变化就换一个"主导爱的语言"。
 *
 * ### 冲突风格：取最高分（TKI 五种）
 *
 * 同理，并列时按 `CONFLICT_STYLE_DIMENSIONS` 的固定顺序。
 *
 * ## 数据不足时的行为
 *
 * **不编造结论**。某个族没有任何有效数据时：
 *   · 依恋的两个轴都无效 → `style = null`
 *   · 爱的语言五项都无效 → `primary = []`
 *   · 冲突风格五项都无效 → `style = null`
 *
 * 并把族名收进 `unresolved`，由调用方（`test.service.ts`）**显式报错**而不是
 * 落一份"看起来正常"的画像 —— 后者会顶掉用户真实的情感画像且不报错，
 * 这正是 ADR-038 阶段 1 那道护栏要防的事。
 *
 * 无 I/O 保证：本文件不 import Prisma / Redis / HTTP。
 */

import { Injectable } from '@nestjs/common';

import {
  collectResponseMetrics,
  computeQualityMetrics,
  isRushedAnswer,
} from '../../../common/engine/assessment-quality.util';
import {
  accumulateDimension,
  computeEffectiveValue,
  createDimensionAccumulator,
  finalizeDimension,
  optionScoreMapDimensions,
  type DimensionAccumulator,
} from '../../../common/engine/assessment-scoring.util';
import { roundTo } from '../../../common/engine/engine-math.util';
import {
  ATTACHMENT_AXES,
  CONFLICT_STYLE_DIMENSIONS,
  EMOTION_ENGINE_VERSION,
  EMOTION_SCORABLE_DIMENSIONS,
  LOVE_LANGUAGE_DIMENSIONS,
  type ConflictStyleDimension,
  type EmotionAttachmentResult,
  type EmotionAttachmentStyle,
  type EmotionConflictResult,
  type EmotionEngineInput,
  type EmotionEngineOutput,
  type EmotionLoveLanguageResult,
  type LoveLanguageDimension,
} from './emotion-engine.types';

/** 依恋两轴的默认判定阈值（ECR 惯例的中位切分） */
const DEFAULT_ATTACHMENT_THRESHOLD = 50;

/** 主导爱的语言默认取几项 */
const DEFAULT_PRIMARY_LOVE_LANGUAGE_COUNT = 2;

/** 单个维度的收敛结果 */
interface DimensionOutcome {
  percent: number;
  usable: boolean;
}

@Injectable()
export class EmotionEngine {
  /** 引擎版本（随画像落库，算法升级产生新版本） */
  readonly version = EMOTION_ENGINE_VERSION;

  /**
   * 计算情感画像
   *
   * @param input 试卷题目 + 用户答案 + 阈值（阈值由调用方从系统配置读入）
   */
  compute(input: EmotionEngineInput): EmotionEngineOutput {
    const { questions, answers } = input;

    const threshold = input.attachmentThreshold ?? {
      anxiety: DEFAULT_ATTACHMENT_THRESHOLD,
      avoidance: DEFAULT_ATTACHMENT_THRESHOLD,
    };
    const primaryCount = Math.max(1, input.primaryLoveLanguageCount ?? DEFAULT_PRIMARY_LOVE_LANGUAGE_COUNT);

    const questionMap = new Map(questions.map((question) => [question.id, question]));
    const accumulators = new Map<string, DimensionAccumulator>();

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

      /**
       * 这道题该往**哪些维度**累加（ADR-039）
       *
       * 沉浸式场景题的选项本身带维度分值，且一个"你会怎么做"的选择会同时透露
       * 依恋、冲突风格与爱的语言 —— 因此按选项里**实际出现的维度**逐个累加，
       * 而不是只算题目声明的那一个。
       *
       * ⚠ 量表题的选项没有 `scoreMap`，这里会回退到"只算题目声明的维度"，
       * 既有题库的算分口径**一字不变**（ADR-005 的回归要求，由回归快照锁住）。
       */
      const declaredDimension = question.dimension?.toUpperCase() ?? '';
      const covered = optionScoreMapDimensions(question, answer).filter((dimension) =>
        EMOTION_SCORABLE_DIMENSIONS.includes(dimension),
      );
      const dimensions =
        covered.length > 0
          ? covered
          : EMOTION_SCORABLE_DIMENSIONS.includes(declaredDimension)
            ? [declaredDimension]
            : [];

      if (dimensions.length === 0) {
        // 非情感维度（如人格题混进了情感卷）：计入完成率，但不参与情感得分。
        // 与人格引擎对称 —— 两个模块互相看到对方的题时都不会算错分
        validAnsweredCount += 1;
        collectResponseMetrics(answer, (value) => {
          responseMsSum += value;
          responseMsCount += 1;
        });
        if (isRushedAnswer(answer)) rushCount += 1;
        continue;
      }

      let accumulated = false;

      for (const dimension of dimensions) {
        const effective = computeEffectiveValue(question, answer, dimension);

        // 无法计算有效值（选项分值缺失等）→ 该维度不计
        if (effective === null) continue;

        const accumulator = accumulators.get(dimension) ?? createDimensionAccumulator();
        accumulators.set(dimension, accumulator);

        accumulateDimension(accumulator, {
          effective,
          weight: question.weight,
          reverseScored: question.reverseScored,
        });

        accumulated = true;
      }

      // 一个维度都算不出来 → 与旧行为一致：视为未答（不计入 validAnsweredCount）
      if (!accumulated) continue;

      validAnsweredCount += 1;
      collectResponseMetrics(answer, (value) => {
        responseMsSum += value;
        responseMsCount += 1;
      });
      if (isRushedAnswer(answer)) rushCount += 1;
    }

    // --------------------------------------------------------------- 收敛维度
    const outcomes = new Map<string, DimensionOutcome>();
    const rawScores: EmotionEngineOutput['rawScores']['dimensions'] = {};

    for (const [dimension, accumulator] of accumulators) {
      const finalized = finalizeDimension(accumulator);

      outcomes.set(dimension, { percent: finalized.percent, usable: finalized.usable });
      rawScores[dimension] = finalized.raw;
    }

    const read = (dimension: string): DimensionOutcome => outcomes.get(dimension) ?? { percent: 50, usable: false };

    // ------------------------------------------------------- 三个族的业务结论
    const attachment = this.deriveAttachment(read, threshold);
    const loveLanguage = this.deriveLoveLanguage(read, primaryCount);
    const conflict = this.deriveConflict(read);

    const unresolved: string[] = [];
    if (attachment.style === null) unresolved.push('依恋类型');
    if (!loveLanguage.usable) unresolved.push('爱的语言');
    if (conflict.style === null) unresolved.push('冲突风格');

    return {
      engineVersion: EMOTION_ENGINE_VERSION,
      attachment,
      loveLanguage,
      conflict,
      unresolved,
      quality: computeQualityMetrics({
        dimensionPairValues: [...accumulators.values()].map((accumulator) => ({
          forward: accumulator.forwardValues,
          reverse: accumulator.reverseValues,
        })),
        validAnsweredCount,
        skippedCount,
        totalCount,
        responseMsSum,
        responseMsCount,
        rushCount,
      }),
      rawScores: { dimensions: rawScores },
    };
  }

  // ==========================================================================
  // 依恋：双轴 → 四象限
  // ==========================================================================

  private deriveAttachment(
    read: (dimension: string) => DimensionOutcome,
    threshold: { anxiety: number; avoidance: number },
  ): EmotionAttachmentResult {
    const anxiety = read(ATTACHMENT_AXES[0]);
    const avoidance = read(ATTACHMENT_AXES[1]);

    // 两个轴都要有数据才能定位象限。只有一根轴时**不给结论** ——
    // 硬套默认值会产出一个"看起来正常"的类型，而它没有任何数据支撑
    const style: EmotionAttachmentStyle | null =
      anxiety.usable && avoidance.usable
        ? EmotionEngine.resolveAttachmentQuadrant(
            anxiety.percent,
            avoidance.percent,
            threshold.anxiety,
            threshold.avoidance,
          )
        : null;

    return {
      style,
      anxiety: roundTo(anxiety.percent, 2),
      avoidance: roundTo(avoidance.percent, 2),
      anxietyUsable: anxiety.usable,
      avoidanceUsable: avoidance.usable,
      thresholds: { anxiety: threshold.anxiety, avoidance: threshold.avoidance },
    };
  }

  /**
   * 两轴 → 四象限（ECR 模型）
   *
   * 抽成静态方法是为了**可独立单测**：象限映射是这套模型里最容易被写反的地方
   * （焦虑高 + 回避高 = 恐惧型，而不是"安全型"），
   * 藏在实例方法里只能靠构造完整输入间接覆盖。
   */
  static resolveAttachmentQuadrant(
    anxiety: number,
    avoidance: number,
    anxietyThreshold: number,
    avoidanceThreshold: number,
  ): EmotionAttachmentStyle {
    const anxietyHigh = anxiety >= anxietyThreshold;
    const avoidanceHigh = avoidance >= avoidanceThreshold;

    if (anxietyHigh && avoidanceHigh) return 'FEARFUL';
    if (anxietyHigh) return 'ANXIOUS';
    if (avoidanceHigh) return 'AVOIDANT';

    return 'SECURE';
  }

  // ==========================================================================
  // 爱的语言：五项排序
  // ==========================================================================

  private deriveLoveLanguage(
    read: (dimension: string) => DimensionOutcome,
    primaryCount: number,
  ): EmotionLoveLanguageResult {
    const scores = {} as Record<LoveLanguageDimension, number>;
    let anyUsable = false;

    for (const dimension of LOVE_LANGUAGE_DIMENSIONS) {
      const outcome = read(dimension);
      scores[dimension] = roundTo(outcome.percent, 2);
      anyUsable = anyUsable || outcome.usable;
    }

    // 五项全无数据时**不给主导项**：否则会退化成"按固定顺序取前两名"，
    // 等于凭空指定了两种用户最在意的爱的语言
    const primary = anyUsable ? EmotionEngine.rankByScore(LOVE_LANGUAGE_DIMENSIONS, scores).slice(0, primaryCount) : [];

    return { scores, primary, usable: anyUsable };
  }

  /**
   * 按分数降序排序，**并列时保持 `order` 的原始顺序**
   *
   * 用 `order.indexOf` 做二级键而不是依赖 `Array.prototype.sort` 的稳定性：
   * 稳定性是 ES2019 才写进规范的行为保证，而这里的结果要落库、
   * 要能被离线复算，不能把正确性寄托在运行时实现细节上。
   */
  static rankByScore<T extends string>(order: readonly T[], scores: Record<T, number>): T[] {
    return [...order].sort((a, b) => {
      const diff = (scores[b] ?? 0) - (scores[a] ?? 0);
      if (diff !== 0) return diff;
      return order.indexOf(a) - order.indexOf(b);
    });
  }

  // ==========================================================================
  // 冲突风格：取最高分
  // ==========================================================================

  private deriveConflict(read: (dimension: string) => DimensionOutcome): EmotionConflictResult {
    const scores = {} as Record<ConflictStyleDimension, number>;
    let anyUsable = false;

    for (const dimension of CONFLICT_STYLE_DIMENSIONS) {
      const outcome = read(dimension);
      scores[dimension] = roundTo(outcome.percent, 2);
      anyUsable = anyUsable || outcome.usable;
    }

    const ranked = anyUsable ? EmotionEngine.rankByScore(CONFLICT_STYLE_DIMENSIONS, scores) : [];

    return { scores, style: ranked[0] ?? null, usable: anyUsable };
  }
}
