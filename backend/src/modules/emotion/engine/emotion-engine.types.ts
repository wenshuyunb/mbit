/**
 * 情感算法引擎 — 类型契约
 *
 * 设计约束与人格引擎**完全一致**（架构 ADR-005 / P4）：
 *   · 引擎是**纯函数**：不注入 Prisma / Redis / HTTP，所有输入由调用方准备
 *   · 相同输入必然得到相同输出（可复现、可单测、结果可解释）
 *   · 阈值等可调参数**由调用方传入**，引擎不读数据库、不读全局配置
 *
 * 「试卷 / 作答 / 质量指标」用的是 `common/engine/assessment.types.ts` 里的通用契约 ——
 * 情感测评的试卷形状与人格测评没有区别，没必要各写一份。
 *
 * ## 这套量表是什么（写给后来维护的人）
 *
 * 三个族各自对应一个**成熟的心理测量模型**，不是拍脑袋编的维度：
 *
 * | 族 | 模型 | 计分轴 | 结论怎么来 |
 * | --- | --- | --- | --- |
 * | 依恋 | ECR（亲密关系体验量表）的双轴模型 | 焦虑轴、回避轴 | 两轴**求交** → 四象限 → 四种依恋类型 |
 * | 爱的语言 | Gary Chapman 五种爱的语言 | 五项各自得分 | 按分数**排序**，取前两名 |
 * | 冲突风格 | Thomas–Kilmann（TKI）五种冲突处理方式 | 五项各自得分 | 取最高分者为**主导风格** |
 *
 * 之所以强调这一点：用户对情感分析的要求是「**专业、简单易懂**」——
 * "专业"落在"用的是公认模型、结论可追溯到具体分数"上，
 * "简单易懂"落在"报告里不出现量表术语、只说人话"上。两者都不靠玄学。
 */

import type { EngineAnswer, EngineQuestion, QualityMetrics, RawScores } from '../../../common/engine/assessment.types';

/** 引擎版本：随画像落库，算法升级时旧画像不重算而是产生新版本 */
export const EMOTION_ENGINE_VERSION = 'ee-v1.0.0';

/** 依恋的两条轴（ECR 双轴模型） */
export const ATTACHMENT_AXES = ['ATTACH_ANXIETY', 'ATTACH_AVOIDANCE'] as const;
export type AttachmentAxis = (typeof ATTACHMENT_AXES)[number];

/**
 * 爱的语言五项
 *
 * 顺序即**并列时的展示顺序**，故意固定下来：五项分数完全相同的情况真实存在
 * （尤其是认真作答但各项均衡的人），此时结果必须稳定可复现，
 * 不能因为 Map 遍历顺序或排序实现变化就换一个"主导爱的语言"。
 */
export const LOVE_LANGUAGE_DIMENSIONS = [
  'LOVE_WORDS',
  'LOVE_TIME',
  'LOVE_GIFTS',
  'LOVE_SERVICE',
  'LOVE_TOUCH',
] as const;
export type LoveLanguageDimension = (typeof LOVE_LANGUAGE_DIMENSIONS)[number];

/** 冲突风格五种（Thomas–Kilmann） */
export const CONFLICT_STYLE_DIMENSIONS = [
  'CONFLICT_COLLABORATING',
  'CONFLICT_COMPROMISING',
  'CONFLICT_ACCOMMODATING',
  'CONFLICT_AVOIDING',
  'CONFLICT_COMPETING',
] as const;
export type ConflictStyleDimension = (typeof CONFLICT_STYLE_DIMENSIONS)[number];

/** 情感引擎参与算分的维度白名单 */
export const EMOTION_SCORABLE_DIMENSIONS: readonly string[] = [
  ...ATTACHMENT_AXES,
  ...LOVE_LANGUAGE_DIMENSIONS,
  ...CONFLICT_STYLE_DIMENSIONS,
];

/** 依恋类型（与 Prisma `AttachmentStyle` 枚举取值逐字一致） */
export type EmotionAttachmentStyle = 'SECURE' | 'ANXIOUS' | 'AVOIDANT' | 'FEARFUL';

/** 引擎输入 */
export interface EmotionEngineInput {
  /** 试卷中的题目（必须与作答时一致，保证可复现） */
  questions: EngineQuestion[];
  /** 用户答案 */
  answers: EngineAnswer[];
  /**
   * 依恋两轴的判定阈值（0–100），**由调用方从系统配置读入**
   *
   * 为什么不做成代码常量：四象限的分界线是产品/临床口径问题而不是算法问题。
   * "焦虑轴多少分算高"会随版本调整，而调整**不应该发版**。
   * 默认 50 是 ECR 的中位切分惯例。
   */
  attachmentThreshold?: {
    anxiety: number;
    avoidance: number;
  };
  /** 主导爱的语言取几项（默认 2）；见下面 `deriveLoveLanguage` 的说明 */
  primaryLoveLanguageCount?: number;
}

/** 依恋结果 */
export interface EmotionAttachmentResult {
  /**
   * 四象限结论；**两个轴都有数据时才给结论**，否则为 null
   *
   * null 不是"还没算"，而是"算不出来" —— 只有一根轴时无法定位象限，
   * 硬套默认值会产出一个看起来正常、却没有任何数据支撑的类型。
   * 调用方必须把 null 当成错误处理，而不是回落到某个默认类型。
   */
  style: EmotionAttachmentStyle | null;
  /** 焦虑轴 0–100 */
  anxiety: number;
  /** 回避轴 0–100 */
  avoidance: number;
  /** 该轴是否具备有效数据（false 表示 50 只是占位，不代表测量结果） */
  anxietyUsable: boolean;
  avoidanceUsable: boolean;
  /** 本次判定实际使用的阈值（落库便于解释"当时为什么判成这个类型"） */
  thresholds: { anxiety: number; avoidance: number };
}

/** 爱的语言结果 */
export interface EmotionLoveLanguageResult {
  /** 五项得分（0–100） */
  scores: Record<LoveLanguageDimension, number>;
  /**
   * 主导项（按分数降序；并列时按 `LOVE_LANGUAGE_DIMENSIONS` 的固定顺序）
   *
   * 五项全无有效数据时是**空数组**，而不是"按固定顺序取前两名"——
   * 后者等于凭空指定了用户最在意的两种爱的语言。
   */
  primary: LoveLanguageDimension[];
  /** 是否有任何一项具备有效数据 */
  usable: boolean;
}

/** 冲突风格结果 */
export interface EmotionConflictResult {
  /** 五种得分（0–100） */
  scores: Record<ConflictStyleDimension, number>;
  /** 主导风格（最高分；并列时按 `CONFLICT_STYLE_DIMENSIONS` 的固定顺序）；无有效数据时为 null */
  style: ConflictStyleDimension | null;
  /** 是否有任何一项具备有效数据 */
  usable: boolean;
}

/** 引擎输出 */
export interface EmotionEngineOutput {
  engineVersion: string;
  attachment: EmotionAttachmentResult;
  loveLanguage: EmotionLoveLanguageResult;
  conflict: EmotionConflictResult;
  /**
   * 数据不足、**无法给出结论**的族名（如 `['依恋类型']`）
   *
   * 存在的意义是让调用方给出**说得清的错误**（"本次依恋相关的题目没有有效作答，
   * 结果不完整"），而不是让用户在报告里读到一段凭空的解读。
   */
  unresolved: string[];
  quality: QualityMetrics;
  /** 各维度的原始加权分与理论上下界，用于排障与结果解释 */
  rawScores: RawScores;
}
