/**
 * 情感报告上下文组装（纯函数，无 I/O、**不调用 AI**、可 100% 单测）
 *
 * 与 `report-context.builder.ts`（人格报告）是**两条平行的组装路径**，互不调用。
 * 这是 ADR-038 的直接要求：情感报告不该拿到人格数据，人格报告也不该拿到情感数据 ——
 * 若合成一个函数，两个模块的数据就会在同一个变量表里相遇，
 * 而"哪一项属于哪个模块"只能靠读代码判断，漏一处就静默串味。
 *
 * ## 为什么情感报告的变量"看起来更多"
 *
 * 用户对情感分析的要求是「专业、简单易懂」。
 * "专业"在这一层的落点是：**把分布完整交给模型，而不是只给结论标签** ——
 *
 *   · 依恋不只给 `焦虑型`，还给两条轴的分数。四种依恋类型是焦虑轴与回避轴
 *     **求交**得出的象限结果，只给标签的话，模型无法解释"为什么是焦虑型"，
 *     更无法说清"你离分界线有多近"；
 *   · 爱的语言不只给前两名，还给五项完整分数。五项分差常常很小，
 *     只给第一名会把"其实你最在意被肯定，其次是被陪伴"压成一句很绝对的话；
 *   · 冲突风格同理，五种分数一起给。
 *
 * "简单易懂"则由**模板**负责（不许出现 ECR / TKI / 象限这类术语），
 * 不在这里处理 —— 组装器只管把数据如实翻译成中文串。
 *
 * 三条硬性约束与人格报告一致：
 *   ① 不引入当前时间 / 随机数（需要时间戳时由调用方注入）
 *   ② 迭代顺序固定（数组按固定定义顺序，映射按固定定义顺序）
 *   ③ 可选数据缺失时不抛错：用显式占位文案代替（模板因此永远渲染得成功）
 */

import {
  CONFLICT_STYLE_DIMENSIONS,
  LOVE_LANGUAGE_DIMENSIONS,
  type ConflictStyleDimension,
  type LoveLanguageDimension,
} from '../../emotion/engine/emotion-engine.types';
import { UNAVAILABLE_PLACEHOLDER, formatScore } from './report-context.builder';

/**
 * 依恋类型中文名
 *
 * ⚠ 与 `report-context.builder.ts` 里的 `ATTACHMENT_LABELS` 是**两张不同的表**，
 * 不要合并：那一张还包含 `relationship_style_rules` 规则表用的旧编码
 * （`ATTACH_SECURE` / `ATTACH_EXPLORING` 等），而情感测评直接测出来的只有
 * 四个普适类型。混用会让"规则推导出来的探索型"与"测出来的安全型"看起来是同一类东西。
 */
export const EMOTION_ATTACHMENT_LABELS: Readonly<Record<string, string>> = {
  SECURE: '安全型',
  ANXIOUS: '焦虑型',
  AVOIDANT: '回避型',
  FEARFUL: '恐惧型（紊乱型）',
};

/**
 * 爱的语言中文名（**情感模块自己的编码**）
 *
 * ⚠ 编码与旧规则表不同：规则表用 `WORDS_OF_AFFIRMATION` / `QUALITY_TIME` /
 * `RECEIVING_GIFTS` / `ACTS_OF_SERVICE` / `PHYSICAL_TOUCH`，
 * 情感测评的计分维度用 `LOVE_WORDS` / `LOVE_TIME` / `LOVE_GIFTS` /
 * `LOVE_SERVICE` / `LOVE_TOUCH`。两套编码**不要互相翻译** ——
 * 前者是运营配置的产物，后者是测量维度；混用会让"测出来的爱的语言"与
 * "规则推导出来的爱的语言"在报告里被当成同一件事。
 */
export const EMOTION_LOVE_LANGUAGE_LABELS: Readonly<Record<LoveLanguageDimension, string>> = {
  LOVE_WORDS: '肯定的言辞',
  LOVE_TIME: '精心的时刻',
  LOVE_GIFTS: '接受礼物',
  LOVE_SERVICE: '服务的行动',
  LOVE_TOUCH: '身体的接触',
};

/** 冲突风格中文名（TKI 五种） */
export const EMOTION_CONFLICT_LABELS: Readonly<Record<ConflictStyleDimension, string>> = {
  CONFLICT_COLLABORATING: '协作型',
  CONFLICT_COMPROMISING: '妥协型',
  CONFLICT_ACCOMMODATING: '迁就型',
  CONFLICT_AVOIDING: '回避型',
  CONFLICT_COMPETING: '竞争型',
};

/** 组装输入 */
export interface EmotionReportContextInput {
  readonly profile: {
    readonly attachmentStyle: string;
    readonly attachmentAnxiety: number;
    readonly attachmentAvoidance: number;
    /** 五项得分（缺项按缺失处理，不补 0 —— 补 0 会被模型读成"完全不在意"） */
    readonly loveLanguageScores: Readonly<Record<string, number>> | null;
    readonly primaryLoveLanguages: readonly string[];
    readonly conflictStyle: string;
    readonly conflictScores: Readonly<Record<string, number>> | null;
    readonly consistencyScore: number | null;
    readonly completionRate: number | null;
    readonly avgResponseMs: number | null;
    readonly engineVersion: string | null;
  };
  /** 测评定义编码（如 `EMOTION_LITE`），让模型知道数据来自哪份量表 */
  readonly testDefinitionCode: string | null;
  readonly answeredCount: number | null;
  readonly questionCount: number | null;
}

/** 组装结果（与人格报告同形状，便于共用同一套渲染与校验） */
export interface EmotionReportContext {
  readonly variables: Readonly<Record<string, string>>;
  readonly unavailable: readonly string[];
}

/** 分数 → 档位描述（情感维度一律是 0–100 的单极强度，越高越典型） */
export const describeEmotionLevel = (value: number): string => {
  if (value >= 80) return '很高';
  if (value >= 65) return '偏高';
  if (value >= 45) return '中等';
  if (value >= 30) return '偏低';
  return '很低';
};

/**
 * 把「五项/五种得分」渲染成一行分布
 *
 * 形如 `肯定的言辞 86（很高）、精心的时刻 80（很高）、…`
 *
 * ⚠ 顺序**按调用方给的维度定义顺序**，不按分数排序：分数排序会让两次生成
 * （或两份报告）的行内顺序随分数微动而变，而这两行是要被逐字对比的。
 * 排序信息由 `primary*` 那两个变量单独承担。
 */
const describeScoreDistribution = <T extends string>(
  scores: Readonly<Record<string, number>> | null,
  dimensions: readonly T[],
  labels: Readonly<Record<T, string>>,
): string | null => {
  if (scores === null) return null;

  const parts: string[] = [];

  for (const dimension of dimensions) {
    const raw = scores[dimension];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;

    const score = formatScore(raw);
    if (score === null) continue;

    parts.push(`${labels[dimension]} ${score}（${describeEmotionLevel(Number(score))}）`);
  }

  return parts.length > 0 ? parts.join('、') : null;
};

/** 维度编码 → 中文名（未知编码原样输出，不猜） */
const labelOf = (labels: Readonly<Record<string, string>>, code: string): string => labels[code] ?? code;

/** 组装情感报告上下文 */
export const buildEmotionReportContext = (input: EmotionReportContextInput): EmotionReportContext => {
  const { profile } = input;
  const unavailable: string[] = [];

  /** 取值：缺失时记录并返回占位文案（与人格报告同一套口径） */
  const resolve = (name: string, text: string | null): string => {
    if (text === null || text.length === 0) {
      unavailable.push(name);
      return UNAVAILABLE_PLACEHOLDER;
    }
    return text;
  };

  // ---- 依恋：类型 + 两条轴 ----
  const attachmentLabel = labelOf(EMOTION_ATTACHMENT_LABELS, profile.attachmentStyle);
  const anxiety = formatScore(profile.attachmentAnxiety);
  const avoidance = formatScore(profile.attachmentAvoidance);

  // 两条轴必须与类型一起给：类型是两条轴**求交**的结果，
  // 只给类型的话模型无法解释"为什么是焦虑型"，也看不出"离分界线多远"
  const attachmentAxes =
    anxiety === null || avoidance === null
      ? null
      : `焦虑轴 ${anxiety}（${describeEmotionLevel(Number(anxiety))}）、回避轴 ${avoidance}（${describeEmotionLevel(Number(avoidance))}）`;

  // ---- 爱的语言：完整分布 + 主导两项 ----
  const loveDistribution = describeScoreDistribution(
    profile.loveLanguageScores,
    LOVE_LANGUAGE_DIMENSIONS,
    EMOTION_LOVE_LANGUAGE_LABELS,
  );

  const lovePrimary =
    profile.primaryLoveLanguages.length === 0
      ? null
      : profile.primaryLoveLanguages.map((code) => labelOf(EMOTION_LOVE_LANGUAGE_LABELS, code)).join('、');

  // ---- 冲突风格：完整分布 + 主导 ----
  const conflictDistribution = describeScoreDistribution(
    profile.conflictScores,
    CONFLICT_STYLE_DIMENSIONS,
    EMOTION_CONFLICT_LABELS,
  );

  const conflictLabel = labelOf(EMOTION_CONFLICT_LABELS, profile.conflictStyle);

  const variables: Record<string, string> = {
    // 依恋
    attachmentStyle: resolve('attachmentStyle', attachmentLabel),
    attachmentAxes: resolve('attachmentAxes', attachmentAxes),

    // 爱的语言
    loveLanguageSummary: resolve('loveLanguageSummary', loveDistribution),
    primaryLoveLanguages: resolve('primaryLoveLanguages', lovePrimary),

    // 冲突风格
    conflictStyle: resolve('conflictStyle', conflictLabel),
    conflictStyleSummary: resolve('conflictStyleSummary', conflictDistribution),

    // 质量与元信息（口径与人格报告一致，便于用户横向比较两份结果的可信度）
    consistencyScore: resolve('consistencyScore', formatScore(profile.consistencyScore)),
    completionRate: resolve('completionRate', formatScore(profile.completionRate)),
    avgResponseSeconds: resolve(
      'avgResponseSeconds',
      profile.avgResponseMs === null ? null : String(Math.round(profile.avgResponseMs / 1000)),
    ),
    engineVersion: resolve('engineVersion', profile.engineVersion),
    testDefinitionCode: resolve('testDefinitionCode', input.testDefinitionCode),
    answeredRatio: resolve(
      'answeredRatio',
      input.answeredCount === null || input.questionCount === null || input.questionCount === 0
        ? null
        : `${input.answeredCount}/${input.questionCount}`,
    ),
  };

  return { variables, unavailable };
};
