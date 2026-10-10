/**
 * 关系（匹配）报告的上下文构建器
 *
 * 契约 §3.6.9；架构 §12.2 的「算分确定 + AI 只做解读」（ADR-005）。
 *
 * ## 为什么与单画像的 `buildReportContext` 分开
 *
 * 关系报告要喂给模型的是**两个人和他们之间的算分结果**，而单画像报告只有一个人的
 * 维度数据。硬塞进同一个函数会让"哪些变量该有值"变成一串条件分支，而
 * `unavailable` 的判定也会互相污染 —— 例如单画像报告里"爱的语言不可用"，
 * 在关系报告里却可能是"只有一方不可用"。
 *
 * 两者共享的是**标签映射与描述函数**（已从 `report-context.builder.ts` 导出），
 * 而不是组装逻辑。
 *
 * ## 变量命名约定
 *
 * 前缀 `my` / `partner` 表示视角。**必须区分视角**：报告是给当前用户看的，
 * 而算分输入是 A（邀请方）/ B（接受方）—— 若模板里写「你的类型」却填了 A 的类型，
 * 那么当 B 在阅读时，报告会把对方说成"你"。
 */

import {
  ATTACHMENT_LABELS,
  BIG_FIVE_LABELS,
  LOVE_LANGUAGE_LABELS,
  UNAVAILABLE_PLACEHOLDER,
  describeBigFiveLevel,
  describeDimension,
  findTypeProfile,
  formatScore,
} from './report-context.builder';

/** 报告里的一侧（视角已在外层确定） */
export interface RelationshipReportSide {
  readonly mbtiType: string | null;
  readonly eiPercent: number | null;
  readonly snPercent: number | null;
  readonly tfPercent: number | null;
  readonly jpPercent: number | null;
  readonly openness: number | null;
  readonly conscientiousness: number | null;
  readonly extraversion: number | null;
  readonly agreeableness: number | null;
  readonly neuroticism: number | null;
  readonly attachmentStyle: string | null;
  readonly loveLanguages: readonly string[];
  readonly conflictStyle: string | null;
}

/** 算分结果（来自 `CompatibilityEngine`，**不重新计算**） */
export interface RelationshipReportScores {
  readonly totalScore: number;
  readonly mbtiScore: number | null;
  readonly bigFiveScore: number | null;
  readonly attachmentScore: number | null;
  readonly communicationScore: number | null;
  /** 引擎给出的分项明细（直接序列化进 Prompt，供模型解释"为什么是这个分"） */
  readonly scoreBreakdown: Readonly<Record<string, unknown>>;
  /** 被跳过的维度（因缺数据未参与算分） */
  readonly skippedDimensions: readonly string[];
  readonly scoreLevelLabel: string;
}

export interface RelationshipReportContextInput {
  /** 关系类型（`COUPLE` / `FRIEND` / `FAMILY`）中文名 */
  readonly relationTypeName: string;
  /** 当前用户视角的一侧 */
  readonly me: RelationshipReportSide;
  readonly partner: RelationshipReportSide;
  readonly scores: RelationshipReportScores;
  readonly daysTogether: number | null;
  /** 关系类型对应的称呼（如「伴侣」），避免模板里写死"情侣" */
  readonly counterpartLabel: string;
}

export interface RelationshipReportContext {
  readonly variables: Readonly<Record<string, string>>;
  readonly unavailable: readonly string[];
}

/** 关系类型 → 对对方的称呼 */
const COUNTERPART_LABELS: Readonly<Record<string, string>> = {
  COUPLE: '伴侣',
  FRIEND: '朋友',
  FAMILY: '家人',
};

export const counterpartLabelOf = (relationType: string): string => COUNTERPART_LABELS[relationType] ?? '对方';

/** 把一侧的四个维度拼成一行 */
const describeDimensions = (side: RelationshipReportSide): string | null => {
  const parts = [
    describeDimension(side.eiPercent === null ? '?' : 'E', side.eiPercent),
    describeDimension(side.snPercent === null ? '?' : 'S', side.snPercent),
    describeDimension(side.tfPercent === null ? '?' : 'T', side.tfPercent),
    describeDimension(side.jpPercent === null ? '?' : 'J', side.jpPercent),
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? null : parts.join('；');
};

/** 把一侧的大五拼成一行 */
const describeBigFive = (side: RelationshipReportSide): string | null => {
  const entries: readonly (readonly [string, number | null])[] = [
    ['openness', side.openness],
    ['conscientiousness', side.conscientiousness],
    ['extraversion', side.extraversion],
    ['agreeableness', side.agreeableness],
    ['neuroticism', side.neuroticism],
  ];

  const parts = entries
    .filter((entry): entry is readonly [string, number] => entry[1] !== null && Number.isFinite(entry[1]))
    .map(([key, value]) => `${BIG_FIVE_LABELS[key]} ${formatScore(value)}（${describeBigFiveLevel(value)}）`);

  return parts.length === 0 ? null : parts.join('；');
};

/** 把爱的语言转成中文标签；空数组返回 null */
const describeLoveLanguages = (styles: readonly string[]): string | null => {
  if (styles.length === 0) return null;

  return styles.map((style) => LOVE_LANGUAGE_LABELS[style] ?? style).join('、');
};

/** 分项得分 → `MBTI 78 / 大五 65 / …`（null 的项直接跳过，不写"0 分"） */
const describeSubScores = (scores: RelationshipReportScores): string | null => {
  const entries: readonly (readonly [string, number | null])[] = [
    ['MBTI 互补度', scores.mbtiScore],
    ['大五契合度', scores.bigFiveScore],
    ['依恋匹配度', scores.attachmentScore],
    ['沟通契合度', scores.communicationScore],
  ];

  const parts = entries
    .filter((entry): entry is readonly [string, number] => entry[1] !== null)
    .map(([label, value]) => `${label} ${formatScore(value)}`);

  return parts.length === 0 ? null : parts.join('；');
};

/**
 * 组装关系报告上下文
 *
 * 与单画像构建器遵循同一条铁律：**所有变量无条件存在**，不可用时填占位文案。
 * 少一个变量就会在运行时变成 `50012 缺少必需变量`，而那时用户的一次生成请求
 * 已经消耗掉了。
 */
export const buildRelationshipReportContext = (input: RelationshipReportContextInput): RelationshipReportContext => {
  const unavailable: string[] = [];
  const variables: Record<string, string> = {};

  /** 登记一个变量；值为 null 时记入 unavailable 并填占位文案 */
  const put = (name: string, value: string | null): void => {
    if (value === null) {
      unavailable.push(name);
      variables[name] = UNAVAILABLE_PLACEHOLDER;
      return;
    }

    variables[name] = value;
  };

  const meProfile = findTypeProfile(input.me.mbtiType);
  const partnerProfile = findTypeProfile(input.partner.mbtiType);

  // ---------------------------------------------------------------- 关系基本信息
  variables.relationTypeName = input.relationTypeName;
  variables.counterpartLabel = input.counterpartLabel;
  // 未生效的关系没有"在一起天数"，但对关系报告而言它一定有值（只有 ACTIVE 才算分）
  put('daysTogether', input.daysTogether === null ? null : String(input.daysTogether));

  // ---------------------------------------------------------------- 算分结果
  // 分数是**既定事实**：系统提示词明确要求模型不得重新计算或质疑
  variables.totalScore = String(input.scores.totalScore);
  variables.scoreLevel = input.scores.scoreLevelLabel;
  put('subScores', describeSubScores(input.scores));
  put('scoreBreakdown', summarizeBreakdown(input.scores.scoreBreakdown));
  variables.skippedDimensions =
    input.scores.skippedDimensions.length === 0
      ? '无（本次全部维度均参与了算分）'
      : input.scores.skippedDimensions.join('、');

  // ---------------------------------------------------------------- 我方数据
  put('myMbtiType', input.me.mbtiType);
  put('myMbtiTypeName', meProfile?.typeName ?? null);
  put('myDimensions', describeDimensions(input.me));
  put('myBigFive', describeBigFive(input.me));
  put('myAttachmentStyle', labelOf(ATTACHMENT_LABELS, input.me.attachmentStyle));
  put('myLoveLanguages', describeLoveLanguages(input.me.loveLanguages));
  put('myConflictStyle', input.me.conflictStyle);

  // ---------------------------------------------------------------- 对方数据
  put('partnerMbtiType', input.partner.mbtiType);
  put('partnerMbtiTypeName', partnerProfile?.typeName ?? null);
  put('partnerDimensions', describeDimensions(input.partner));
  put('partnerBigFive', describeBigFive(input.partner));
  put('partnerAttachmentStyle', labelOf(ATTACHMENT_LABELS, input.partner.attachmentStyle));
  put('partnerLoveLanguages', describeLoveLanguages(input.partner.loveLanguages));
  put('partnerConflictStyle', input.partner.conflictStyle);

  // ---------------------------------------------------------------- 类型百科参考
  // 用 `summary.strengths` / `summary.watchouts`（摘要模板里的短句），
  // 与单画像报告保持同一份文案来源 —— 两处取不同字段会让同一个类型在
  // 两份报告里被描述成不同的样子
  put('myTypeStrengths', meProfile === null ? null : meProfile.summary.strengths.join('、'));
  put('myTypeWatchouts', meProfile === null ? null : meProfile.summary.watchouts.join('、'));
  put('partnerTypeStrengths', partnerProfile === null ? null : partnerProfile.summary.strengths.join('、'));
  put('partnerTypeWatchouts', partnerProfile === null ? null : partnerProfile.summary.watchouts.join('、'));

  return { variables, unavailable };
};

/** 取标签值；原值为 null 时返回 null，未知取值回落到原始值 */
const labelOf = (labels: Readonly<Record<string, string>>, value: string | null): string | null => {
  if (value === null) return null;

  return labels[value] ?? value;
};

/**
 * 分项明细 → 一行文本
 *
 * 明细里同时含数值与结构（如 `{mbti: {score, counted}, appliedWeights: {...}}`）。
 * 直接把整个 JSON 塞进 Prompt 会浪费大量 token 且噪声大，因此只提取
 * **有分数且参与了算分**的维度，并附上权重（模型需要权重才能解释"为什么这项影响大"）。
 */
const summarizeBreakdown = (breakdown: Readonly<Record<string, unknown>>): string | null => {
  const appliedWeights =
    typeof breakdown.appliedWeights === 'object' && breakdown.appliedWeights !== null
      ? (breakdown.appliedWeights as Record<string, unknown>)
      : {};

  const parts: string[] = [];

  for (const [key, value] of Object.entries(breakdown)) {
    if (key === 'appliedWeights' || key === 'skippedDimensions') continue;
    if (typeof value !== 'object' || value === null) continue;

    const entry = value as Record<string, unknown>;
    if (entry.counted !== true) continue;

    const score = typeof entry.score === 'number' ? formatScore(entry.score) : null;
    if (score === null) continue;

    // 先取到局部变量再判断，让 TS 的窄化生效（直接用下标访问时窄化不会保留到模板串里）
    const rawWeight = appliedWeights[key];
    const weight = typeof rawWeight === 'number' ? `（权重 ${formatScore(rawWeight)}%）` : '';
    parts.push(`${key} ${score}${weight}`);
  }

  return parts.length === 0 ? null : parts.join('；');
};
