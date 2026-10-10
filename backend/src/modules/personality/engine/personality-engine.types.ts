/**
 * 人格算法引擎 — 类型契约
 *
 * 设计约束（架构 ADR-005 / P4）：
 *   · 引擎是**纯函数**：不注入 Prisma / Redis / HTTP，所有输入由调用方准备
 *   · 相同输入必然得到相同输出（可复现、可单测、结果可解释）
 *   · 关系风格规则由调用方从 `relationship_style_rules` 表读入后传入，
 *     引擎本身不访问数据库 —— 这样算法可 100% 单测，且规则可在后台调整而不改代码
 */

/** 算法版本：随画像一同落库，算法升级时旧画像不重算而是产生新版本 */
export const ENGINE_VERSION = 'pe-v1.0.0';

/** MBTI 四个维度（双极） */
export const MBTI_DIMENSIONS = ['EI', 'SN', 'TF', 'JP'] as const;
export type MbtiDimension = (typeof MBTI_DIMENSIONS)[number];

/** 大五人格五个维度（单极 0–100） */
export const BIG_FIVE_DIMENSIONS = [
  'OPENNESS',
  'CONSCIENTIOUSNESS',
  'EXTRAVERSION',
  'AGREEABLENESS',
  'NEUROTICISM',
] as const;
export type BigFiveDimension = (typeof BIG_FIVE_DIMENSIONS)[number];

/** 引擎支持的公平维度集合 */
export type ScorableDimension = MbtiDimension | BigFiveDimension;

/** 题型（与 Prisma QuestionType 对齐） */
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

/** 关系风格推导规则（来自 `relationship_style_rules` 表） */
export interface RelationshipStyleRule {
  code: string;
  name: string;
  /** 优先级，数值越小越先匹配 */
  priority: number;
  conditions: RelationshipRuleConditions;
  resultAttachment: 'SECURE' | 'ANXIOUS' | 'AVOIDANT' | 'FEARFUL';
  resultLoveLanguages: string[];
  resultConflictStyle: string | null;
}

/** 规则条件：`all` 全部满足 且（若存在 `any`）任一满足 */
export interface RelationshipRuleConditions {
  all?: ConditionPredicate[];
  any?: ConditionPredicate[];
}

/** 单条条件断言 */
export interface ConditionPredicate {
  /** 被判断的维度（大五维度名，大小写不敏感） */
  field: string;
  op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'between';
  /** 单值操作数 */
  value?: number;
  /** between 的区间 [下界, 上界] */
  range?: [number, number];
}

/** 引擎输入 */
export interface PersonalityEngineInput {
  /** 试卷中的题目（必须与作答时一致，保证可复现） */
  questions: EngineQuestion[];
  /** 用户答案 */
  answers: EngineAnswer[];
  /** 关系风格规则（调用方从数据库读入）；为空时返回默认风格 */
  relationshipRules?: RelationshipStyleRule[];
}

/** MBTI 结果 */
export interface MbtiResult {
  /** 四字母类型，如 `INTJ`；题目不足无法判定时为 null */
  type: string | null;
  /** 四维度百分比（0 = 完全负极字母，100 = 完全正极字母） */
  dimensions: Record<MbtiDimension, number>;
  /** 置信度 0–100：各维度偏离 50 的程度（越偏离越确定） */
  confidence: number;
}

/** 大五人格结果（0–100） */
export interface BigFiveResult {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

/** 关系风格结果 */
export interface RelationshipStyleResult {
  attachment: 'SECURE' | 'ANXIOUS' | 'AVOIDANT' | 'FEARFUL';
  loveLanguage: string[];
  conflictStyle: string | null;
  /** 命中的规则 code；为 null 表示使用默认值 */
  matchedRuleCode: string | null;
}

/** 答题质量指标 */
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

/** 引擎输出 */
export interface PersonalityEngineOutput {
  engineVersion: string;
  mbti: MbtiResult;
  bigFive: BigFiveResult;
  relationshipStyle: RelationshipStyleResult;
  quality: QualityMetrics;
  /** 各维度的原始加权分与理论上下界，用于排障与结果解释 */
  rawScores: {
    dimensions: Record<
      string,
      { weightedScore: number; weightedMin: number; weightedMax: number; answeredCount: number }
    >;
  };
}
