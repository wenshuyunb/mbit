/**
 * 心理健康算法引擎（纯函数）
 *
 * ## 唯一的职责：把六个维度的分数翻译成一段**只描述、不建议**的结论
 *
 * 用户对该模块的定位：「多维度得分 + 文字结论……不涉及专业建议以及心理干预，只做结论」。
 * 这个文件就是那句话的落点，因此有三条硬约束写进代码而不是靠自觉：
 *
 *   ① **结论文本由确定性规则生成**，不由模型现编。
 *      心理健康主题上，"每次请求现编一段话"是不可接受的：同样一份作答今天说"整体平稳"、
 *      明天说"值得留意"，用户无法判断该信哪个。且规则生成的文案**可被逐字审查** ——
 *      而模型生成的不能（这也是 ADR-005 在本模块的体现）。
 *   ② **结论文本里不出现建议**。写文案时最容易顺手加上"可以试试……"，
 *      而那正是用户明确排除的。由测试逐档位扫描禁用词兜住。
 *   ③ **不做诊断分级**。最强档位的措辞也只是"比较突出"，
 *      没有"严重""异常""需要干预"这类判定性表述。
 *
 * ## 六个维度方向一致（分数越高越值得留意）
 *
 * 见类型契约处的说明：混进一个"越高越好"的维度会让整体聚合静默反向。
 * 本文件用 `MENTAL_HEALTH_HIGHER_IS_WORSE` 把这个前提写进注释与测试，
 * 让"加维度时想清楚方向"成为必须面对的一步。
 *
 * 无 I/O 保证：不 import Prisma / Redis / HTTP。
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
  type DimensionAccumulator,
} from '../../../common/engine/assessment-scoring.util';
import { roundTo } from '../../../common/engine/engine-math.util';
import {
  DEFAULT_LEVEL_THRESHOLDS,
  MENTAL_HEALTH_BAND_LABELS,
  MENTAL_HEALTH_DIMENSION_LABELS,
  MENTAL_HEALTH_DIMENSIONS,
  MENTAL_HEALTH_ENGINE_VERSION,
  MENTAL_HEALTH_OVERALL_LABELS,
  type MentalHealthBand,
  type MentalHealthDimension,
  type MentalHealthDimensionResult,
  type MentalHealthEngineInput,
  type MentalHealthEngineOutput,
  type MentalHealthOverallLevel,
} from './mental-health-engine.types';

/** 主导维度默认高亮几项 */
const DEFAULT_HIGHLIGHT_COUNT = 2;

/**
 * 结论里**绝不出现**的说法
 *
 * 放在代码里而不是只写在文档里：文案是最容易被后来者"顺手润色"的地方，
 * 而一旦加了建议就违反了这个模块的产品定位。测试会逐档位扫描这张表。
 */
export const FORBIDDEN_CONCLUSION_PHRASES: readonly string[] = [
  '建议',
  '你可以试试',
  '不妨',
  '应该',
  '需要治疗',
  '需要干预',
  '就医',
  '就诊',
  '诊断',
  '症状',
  '障碍',
  '异常',
  '严重',
  '抑郁',
  '焦虑症',
  '用药',
  '药物',
];

@Injectable()
export class MentalHealthEngine {
  /** 引擎版本（随画像落库，算法升级产生新版本） */
  readonly version = MENTAL_HEALTH_ENGINE_VERSION;

  /**
   * 计算心理健康结果
   *
   * @param input 试卷题目 + 用户答案 + 阈值（阈值由调用方从系统配置读入）
   */
  compute(input: MentalHealthEngineInput): MentalHealthEngineOutput {
    const { questions, answers } = input;

    const thresholds = input.levelThresholds ?? DEFAULT_LEVEL_THRESHOLDS;
    const highlightCount = Math.max(1, input.highlightCount ?? DEFAULT_HIGHLIGHT_COUNT);

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

      const dimension = question.dimension?.toUpperCase();

      if (!dimension || !(MENTAL_HEALTH_DIMENSIONS as readonly string[]).includes(dimension)) {
        // 非本模块维度（别的模块的题混进来了）：计入完成率，但不参与得分。
        // 三个模块的引擎都这么做，互为镜像 —— 谁都不会把别人的题算进自己的分
        validAnsweredCount += 1;
        collectResponseMetrics(answer, (value) => {
          responseMsSum += value;
          responseMsCount += 1;
        });
        if (isRushedAnswer(answer)) rushCount += 1;
        continue;
      }

      const effective = computeEffectiveValue(question, answer);

      // 无法计算有效值（选项分值缺失等）→ 视为未答
      if (effective === null) continue;

      const accumulator = accumulators.get(dimension) ?? createDimensionAccumulator();
      accumulators.set(dimension, accumulator);

      accumulateDimension(accumulator, {
        effective,
        weight: question.weight,
        reverseScored: question.reverseScored,
      });

      validAnsweredCount += 1;
      collectResponseMetrics(answer, (value) => {
        responseMsSum += value;
        responseMsCount += 1;
      });
      if (isRushedAnswer(answer)) rushCount += 1;
    }

    // ------------------------------------------------------------- 六维收敛
    const dimensions = {} as Record<MentalHealthDimension, MentalHealthDimensionResult>;
    const rawScores: MentalHealthEngineOutput['rawScores']['dimensions'] = {};
    const unresolved: string[] = [];

    for (const dimension of MENTAL_HEALTH_DIMENSIONS) {
      const accumulator = accumulators.get(dimension);

      if (accumulator === undefined) {
        // 这个维度一题都没有：给占位并**记入缺项**，由调用方决定是否拒绝落库
        dimensions[dimension] = { score: 50, band: 'MILD', usable: false };
        unresolved.push(MENTAL_HEALTH_DIMENSION_LABELS[dimension]);
        continue;
      }

      const finalized = finalizeDimension(accumulator);

      dimensions[dimension] = {
        score: roundTo(finalized.percent, 2),
        band: MentalHealthEngine.resolveBand(finalized.percent, thresholds.band),
        usable: finalized.usable,
      };
      rawScores[dimension] = finalized.raw;

      if (!finalized.usable) {
        unresolved.push(MENTAL_HEALTH_DIMENSION_LABELS[dimension]);
      }
    }

    // ------------------------------------------------------------- 聚合与结论
    // 只用**有数据**的维度算均值：把占位 50 一起算进去会稀释真实分数，
    // 让一个六维里只答了一维的人看起来"整体中等"
    const usableDimensions = MENTAL_HEALTH_DIMENSIONS.filter((dimension) => dimensions[dimension].usable);
    const overallScore =
      usableDimensions.length === 0
        ? 50
        : roundTo(
            usableDimensions.reduce((sum, dimension) => sum + dimensions[dimension].score, 0) / usableDimensions.length,
            2,
          );

    const overallLevel = MentalHealthEngine.resolveOverallLevel(overallScore, thresholds.overall);
    const highlightedDimensions = MentalHealthEngine.pickHighlighted(dimensions, usableDimensions, highlightCount);

    const conclusion =
      usableDimensions.length === 0
        ? ''
        : MentalHealthEngine.buildConclusion({ dimensions, overallLevel, highlightedDimensions });

    return {
      engineVersion: MENTAL_HEALTH_ENGINE_VERSION,
      dimensions,
      overallScore,
      overallLevel,
      highlightedDimensions,
      conclusion,
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
  // 档位判定
  // ==========================================================================

  /**
   * 单维档位
   *
   * 抽成静态方法便于**独立单测**：档位边界是这类量表最容易被写偏的地方
   * （`>` 与 `>=` 混淆会让"恰好 30 分"落到哪一档变得取决于实现细节），
   * 藏在实例方法里只能靠构造完整输入间接覆盖。
   */
  static resolveBand(score: number, thresholds: readonly [number, number, number]): MentalHealthBand {
    const [calmMax, slightMax, mildMax] = thresholds;

    if (score < calmMax) return 'CALM';
    if (score < slightMax) return 'SLIGHT';
    if (score < mildMax) return 'MILD';

    return 'NOTABLE';
  }

  /** 整体档位（三档，描述性） */
  static resolveOverallLevel(overallScore: number, thresholds: readonly [number, number]): MentalHealthOverallLevel {
    const [goodMax, mildMax] = thresholds;

    if (overallScore < goodMax) return 'GOOD';
    if (overallScore < mildMax) return 'MILD';

    return 'NOTABLE';
  }

  /**
   * 选出最值得留意的几项
   *
   * 并列时按 `MENTAL_HEALTH_DIMENSIONS` 的**固定顺序**决定先后，
   * 与情感引擎的 `rankByScore` 同一取舍：结果要落库、要能离线复算，
   * 不能把正确性寄托在 `Array.prototype.sort` 的稳定性上（那是 ES2019 才写进规范的）。
   *
   * 只从**有数据**的维度里选：拿占位 50 项去当"最值得留意"是凭空捏造。
   */
  static pickHighlighted(
    dimensions: Record<MentalHealthDimension, MentalHealthDimensionResult>,
    usableDimensions: readonly MentalHealthDimension[],
    count: number,
  ): MentalHealthDimension[] {
    return [...usableDimensions]
      .sort((a, b) => {
        const diff = dimensions[b].score - dimensions[a].score;
        if (diff !== 0) return diff;

        return MENTAL_HEALTH_DIMENSIONS.indexOf(a) - MENTAL_HEALTH_DIMENSIONS.indexOf(b);
      })
      .slice(0, count);
  }

  // ==========================================================================
  // 结论文本
  // ==========================================================================

  /**
   * 生成文字结论
   *
   * 结构固定为三段，便于用户扫读，也便于逐字审查：
   *   ① 整体一句（档位 + 六维均值）
   *   ② 逐项描述最值得留意的 1–2 个维度（**只描述体验，不给建议**）
   *   ③ 一句"哪些维度比较平稳"（避免整段只讲问题，那会放大焦虑）
   *
   * ⚠ 每句话都以「本次作答显示……」这类**限定语**开头：测验结果描述的是
   * "这次答题反映出的状态"，不是对用户下的判断。这不是客套，是产品定位 ——
   * 本模块只做结论，而结论必须与数据严格对应。
   */
  static buildConclusion(params: {
    dimensions: Record<MentalHealthDimension, MentalHealthDimensionResult>;
    overallLevel: MentalHealthOverallLevel;
    highlightedDimensions: readonly MentalHealthDimension[];
  }): string {
    const { dimensions, overallLevel, highlightedDimensions } = params;

    const sentences: string[] = [];

    // ① 整体
    sentences.push(`从本次作答看，你近期的状态${MENTAL_HEALTH_OVERALL_LABELS[overallLevel]}。`);

    // ② 最值得留意的几项（只描述，不建议）
    //
    // 合并成**一句**而不是每项一句：两项各写一句会连续出现两个"其中「X」……"，
    // 读起来像模板在复读。合成一句后是「其中 A 比较突出、B 也比较明显」，
    // 既保留了逐项描述，又像人说的话。
    if (highlightedDimensions.length > 0) {
      const parts = highlightedDimensions.map((dimension, index) => {
        const label = MENTAL_HEALTH_DIMENSION_LABELS[dimension];
        const band = MENTAL_HEALTH_BAND_LABELS[dimensions[dimension].band];

        // 第一项直述，后续项加"也"—— 与口语习惯一致
        return index === 0 ? `「${label}」${band}` : `「${label}」也${band}`;
      });

      sentences.push(`其中${parts.join('、')}。`);
    }

    // ③ 平稳的项（只提"有哪几项"，不逐条夸）
    //
    // ⚠ 单复数量词必须分开写：只有一项时写"这几项"是语病
    //（探针实测输出过「相对而言，紧张不安这几项比较平稳」）。
    // 这类错误不会抛异常、也不会被任何类型检查发现，只能靠读真实输出发现。
    const calmDimensions = MENTAL_HEALTH_DIMENSIONS.filter(
      (dimension) => dimensions[dimension].usable && dimensions[dimension].band === 'CALM',
    );

    if (calmDimensions.length === 1) {
      sentences.push(`「${MENTAL_HEALTH_DIMENSION_LABELS[calmDimensions[0]]}」相对平稳。`);
    } else if (calmDimensions.length > 1) {
      const labels = calmDimensions.map((dimension) => MENTAL_HEALTH_DIMENSION_LABELS[dimension]).join('、');
      sentences.push(`相对而言，${labels}这几项比较平稳。`);
    }

    // ④ 收束：再次点明这是本次作答的反映，且不是判定
    sentences.push('这些是目前这份作答反映出的情况，会随你近期的状态变化。');

    return sentences.join('');
  }
}
