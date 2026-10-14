/**
 * 人格算法引擎 — 类型契约
 *
 * 设计约束（架构 ADR-005 / P4）：
 *   · 引擎是**纯函数**：不注入 Prisma / Redis / HTTP，所有输入由调用方准备
 *   · 相同输入必然得到相同输出（可复现、可单测、结果可解释）
 *   · 关系风格规则由调用方从 `relationship_style_rules` 表读入后传入，
 *     引擎本身不访问数据库 —— 这样算法可 100% 单测，且规则可在后台调整而不改代码
 *
 * ⚠ 「试卷 / 作答 / 质量指标」这些**跨模块通用**的契约已迁到
 * `common/engine/assessment.types.ts`（ADR-038 阶段 3），本文件**再导出**它们，
 * 因此既有 import 路径不变。留在这里的只有真正属于人格的东西：
 * MBTI 四维、大五五维、关系风格与引擎输出。
 */

import type { EngineAnswer, EngineQuestion, QualityMetrics, RawScores } from '../../../common/engine/assessment.types';

export {
  DEFAULT_SCALE,
  type DimensionRawScore,
  type EngineAnswer,
  type EngineQuestion,
  type EngineQuestionOption,
  type EngineQuestionType,
  type QualityMetrics,
  type RawScores,
} from '../../../common/engine/assessment.types';

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

/** 引擎输出 */
export interface PersonalityEngineOutput {
  engineVersion: string;
  mbti: MbtiResult;
  bigFive: BigFiveResult;
  relationshipStyle: RelationshipStyleResult;
  quality: QualityMetrics;
  /** 各维度的原始加权分与理论上下界，用于排障与结果解释 */
  rawScores: RawScores;
}
