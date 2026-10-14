/**
 * 测评引擎的**通用契约**（试卷 / 作答 / 质量指标）
 *
 * ## 为什么放在 `common/` 而不是某个模块里
 *
 * 这三个概念**不属于任何一个测评模块**：人格测评、情感测评、心理健康测评都用
 * 「一份试卷 + 一组作答 → 一组维度分数 + 一份质量指标」这同一套形状。
 *
 * ADR-038 要求三个模块互不干扰，但那说的是**业务结论**互不干扰（人格报告不掺情感结论），
 * 不是"连试卷形状都要各写一遍"。反过来，把通用契约塞进 `personality/engine/`
 * 会让情感模块为了拿一个 `EngineQuestion` 而依赖人格模块 —— 那才是真正的越界。
 *
 * ## 与 `personality/engine/personality-engine.types.ts` 的关系
 *
 * 那边的类型是**从这里再导出**的（保持既有 import 路径不变），
 * 因此这次抽取对调用方是零改动；只有真正属于人格的（MBTI / 大五 / 关系风格）
 * 定义留在那边。
 */

/** 题型（与 Prisma `QuestionType` 对齐） */
export type EngineQuestionType = 'LIKERT5' | 'BINARY' | 'FORCED_CHOICE' | 'RANK';

/** 各题型的默认量表范围（题目未显式声明 minValue/maxValue 时使用） */
export const DEFAULT_SCALE: Record<EngineQuestionType, { min: number; max: number }> = {
  // 1 = 非常不同意 … 5 = 非常同意
  LIKERT5: { min: 1, max: 5 },
  // 0 / 1 二选一：选择即代表倾向正极
  BINARY: { min: 0, max: 1 },
  FORCED_CHOICE: { min: 0, max: 1 },
  // 排序题的相对位置映射为 0（最后）… n-1（最前），由引擎归一化后使用
  RANK: { min: 0, max: 1 },
};

/** 引擎所需的题目选项 */
export interface EngineQuestionOption {
  value: number;
  /**
   * 选项对应的维度得分映射，形如 `{ "EI": 4 }`。
   *
   * 用途：迫选/排序题中不同选项对同一维度的贡献不同，无法用「选项分值」统一表达。
   * 约定：若存在以**该题维度**为键的数值项，则优先使用它作为有效原始分；
   *       否则回退到 `value`（适用于李克特量表这类线性题型）。
   */
  scoreMap: Record<string, number> | null;
}

/** 引擎所需的题目定义 */
export interface EngineQuestion {
  id: string;
  type: EngineQuestionType;
  dimension: string;
  /** 题目权重（默认 1），用于调节某题对维度得分的贡献 */
  weight: number;
  /** 是否反向计分（例如「我喜欢独处」对 EI 维度是反向题） */
  reverseScored: boolean;
  /** 显式量表下界（可选，未提供时按题型默认值） */
  minValue?: number | null;
  /** 显式量表上界（可选） */
  maxValue?: number | null;
  options: EngineQuestionOption[];
}

/** 用户答案 */
export interface EngineAnswer {
  questionId: string;
  /** 单选题为数字；排序题为数字数组（按用户排序后的选项值序列） */
  value: number | number[];
  /** 作答耗时（毫秒），用于质量分析 */
  responseMs?: number | null;
  /** 是否跳过（跳过的题目不计入得分，但计入完成率分母） */
  isSkipped?: boolean;
}

/**
 * 答题质量指标
 *
 * 各模块**共用同一份定义与同一份算法**（`assessment-quality.util.ts`）。
 * 这一点是有意为之：质量指标回答的是"这份作答有多可信"，
 * 与测的是人格还是情感无关；各写一份的话，`computeConsistency` 里那条
 * 「必须比较翻转后的值」的教训就得在两处分别记住（见该函数的注释）。
 */
export interface QualityMetrics {
  /** 正/反向题一致性 0–100（越低说明作答越随意或越矛盾） */
  consistencyScore: number;
  /** 完成率 0–100 */
  completionRate: number;
  /** 平均作答耗时（毫秒）；无数据时为 null */
  avgResponseMs: number | null;
  /** 有效作答题数 */
  answeredCount: number;
  /** 用户显式跳过的题数（未跳过但未作答的不计入此值） */
  skippedCount: number;
  /** 试卷总题数 */
  totalCount: number;
  /** 过快作答比例 0–1（低于阈值的题目占比，用于识别乱答） */
  rushRate: number;
}

/** 单个维度的原始加权分与理论上下界（排障与结果解释用） */
export interface DimensionRawScore {
  weightedScore: number;
  weightedMin: number;
  weightedMax: number;
  answeredCount: number;
}

/** 全部维度的原始分 */
export interface RawScores {
  dimensions: Record<string, DimensionRawScore>;
}
