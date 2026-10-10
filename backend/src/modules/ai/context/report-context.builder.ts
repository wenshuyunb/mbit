/**
 * 报告上下文组装（纯函数，无 I/O、**不调用 AI**、可 100% 单测）
 *
 * 架构依据：ADR-005「算分确定、AI 只做解读」。
 *
 * 本模块是那条 ADR 的**落地点**：人格数据 → Prompt 变量的转换必须完全确定 ——
 * 同一份画像永远生成同一组变量，因此「同一次测评的报告输入」可复现、可对比、
 * 可在出问题时逐字回溯到当次到底喂给了模型什么。
 *
 * 三条硬性约束：
 *   ① **不引入当前时间 / 随机数**（需要时间戳时由调用方注入）
 *   ② **迭代顺序固定**（数组按输入顺序、映射按固定定义顺序）
 *   ③ **可选数据缺失时不抛错**：用显式占位文案代替，模板因此永远能渲染成功，
 *      模型也能明确知道「这项数据本次没有」而不是被喂一份残缺上下文
 */

import { MBTI_TYPE_PROFILES } from '../../personality/data/mbti-types';
import type { MbtiTypeProfile } from '../../personality/data/mbti-types.types';

/** 缺失数据的统一占位文案（模型据此知道该项本次不可用） */
export const UNAVAILABLE_PLACEHOLDER = '（本次测评未包含此项）';

/** 维度极性中文标签 */
export const POLE_LABELS: Readonly<Record<string, string>> = {
  E: '外向',
  I: '内向',
  S: '实感',
  N: '直觉',
  T: '思考',
  F: '情感',
  J: '判断',
  P: '知觉',
};

/** 依恋风格标签（含关系风格规则里的编码与 Prisma 枚举两套写法） */
export const ATTACHMENT_LABELS: Readonly<Record<string, string>> = {
  SECURE: '安全型依恋',
  ANXIOUS: '焦虑型依恋',
  AVOIDANT: '回避型依恋',
  FEARFUL: '恐惧型依恋',
  ATTACH_SECURE: '安全型依恋',
  ATTACH_ANXIOUS: '焦虑型依恋',
  ATTACH_AVOIDANT: '回避型依恋',
  ATTACH_FEARFUL: '恐惧型依恋',
  ATTACH_EXPLORING: '探索型关系风格',
  ATTACH_BALANCED: '均衡型关系风格',
};

/** 爱的语言标签（未知编码原样输出，不猜） */
export const LOVE_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  WORDS_OF_AFFIRMATION: '肯定的言辞',
  QUALITY_TIME: '精心的时刻',
  RECEIVING_GIFTS: '接受礼物',
  ACTS_OF_SERVICE: '服务的行动',
  PHYSICAL_TOUCH: '身体的接触',
};

/** 大五特质中文名 */
export const BIG_FIVE_LABELS: Readonly<Record<string, string>> = {
  openness: '开放性',
  conscientiousness: '尽责性',
  extraversion: '外向性',
  agreeableness: '宜人性',
  neuroticism: '情绪稳定性',
};

/** 上下文输入（只声明用到的字段，便于上层按需投影） */
export interface ReportContextInput {
  readonly profile: {
    readonly mbtiType: string | null;
    readonly mbtiConfidence: number | null;
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
    readonly consistencyScore: number | null;
    readonly completionRate: number | null;
    readonly avgResponseMs: number | null;
    readonly engineVersion: string | null;
  };
  /** 测评定义编码（如 `MBTI_LITE`），用于让模型知道数据来自哪份量表 */
  readonly testDefinitionCode: string | null;
  readonly answeredCount: number | null;
  readonly questionCount: number | null;
}

/** 组装结果 */
export interface ReportContext {
  /** 模板变量（键名即 Prompt 中可用的占位符） */
  readonly variables: Readonly<Record<string, string>>;
  /** 本次不可用的数据项（用于日志与后台提示，不进 Prompt） */
  readonly unavailable: readonly string[];
}

/** 数值 → 定点字符串（固定 0 位小数，保证同一数值永远同一种写法） */
export const formatScore = (value: number | null): string | null =>
  value === null || !Number.isFinite(value) ? null : String(Math.round(value));

/** 大五分数 → 档位描述 */
export const describeBigFiveLevel = (value: number): string => {
  if (value >= 80) return '高';
  if (value >= 65) return '偏高';
  if (value >= 45) return '中等';
  if (value >= 30) return '偏低';
  return '低';
};

/** 维度行：`内向 78%（偏向明显）` */
export const describeDimension = (letter: string, percent: number | null): string | null => {
  const score = formatScore(percent);
  if (score === null) return null;
  return `${POLE_LABELS[letter] ?? letter} ${score}%`;
};

/** 用 MBTI 类型码取百科条目（拿不到时返回 null，不抛错） */
export const findTypeProfile = (mbtiType: string | null): MbtiTypeProfile | null => {
  if (mbtiType === null) return null;
  return MBTI_TYPE_PROFILES.find((item) => item.type === mbtiType.toUpperCase()) ?? null;
};

/**
 * 组装报告上下文
 *
 * 变量名是**模板与本模块之间的契约**：模板里写 `{{mbtiType}}`，这里就必须产出
 * `mbtiType`。因此所有变量**无条件存在**（不可用时为占位文案），
 * 这样模板不需要知道「哪些数据是必有的」，也不会因缺一项而整份渲染失败。
 */
export const buildReportContext = (input: ReportContextInput): ReportContext => {
  const { profile } = input;
  const unavailable: string[] = [];

  /**
   * 取值：缺失时记录并返回占位文案
   *
   * 所有变量都经由此函数产出（或经由 `orText` 的派生展示串），
   * 因此「哪些变量本次不可用」这个清单是**完整且可预测的** ——
   * 若只在部分分支记录，后台看到的缺项提示就会漏报，运维会以为数据齐全。
   */
  const resolve = (name: string, text: string | null): string => {
    if (text === null || text.length === 0) {
      unavailable.push(name);
      return UNAVAILABLE_PLACEHOLDER;
    }
    return text;
  };

  // ---- MBTI ----
  const mbtiType = profile.mbtiType === null ? null : profile.mbtiType.toUpperCase();
  const typeProfile = findTypeProfile(mbtiType);

  const letters = mbtiType === null ? null : mbtiType.split('');
  const dimensionOf = (index: number): string | null => {
    if (letters === null) return null;
    const percent = [profile.eiPercent, profile.snPercent, profile.tfPercent, profile.jpPercent][index];
    return describeDimension(letters[index], percent ?? null);
  };

  // ---- 大五 ----
  const bigFiveEntries: Array<[string, number | null]> = [
    ['openness', profile.openness],
    ['conscientiousness', profile.conscientiousness],
    ['extraversion', profile.extraversion],
    ['agreeableness', profile.agreeableness],
    ['neuroticism', profile.neuroticism],
  ];

  const bigFiveLines: string[] = [];
  for (const [key, value] of bigFiveEntries) {
    const score = formatScore(value);
    if (score === null) continue;
    bigFiveLines.push(`${BIG_FIVE_LABELS[key]} ${score}（${describeBigFiveLevel(Number(score))}）`);
  }

  // ---- 关系风格 ----
  const loveLanguages = profile.loveLanguages.map((code) => LOVE_LANGUAGE_LABELS[code] ?? code).join('、');

  const variables: Record<string, string> = {
    // 类型与百科
    mbtiType: resolve('mbtiType', mbtiType),
    mbtiTypeName: resolve('mbtiTypeName', typeProfile?.typeName ?? null),
    mbtiGroup: resolve('mbtiGroup', typeProfile?.groupName ?? null),
    mbtiTagline: resolve('mbtiTagline', typeProfile?.tagline ?? null),
    mbtiHeadline: resolve('mbtiHeadline', typeProfile?.summary.headline ?? null),
    mbtiStrengths: resolve('mbtiStrengths', typeProfile === null ? null : typeProfile.summary.strengths.join('、')),
    mbtiWatchouts: resolve('mbtiWatchouts', typeProfile === null ? null : typeProfile.summary.watchouts.join('、')),

    // 四维倾向
    dimensionEI: resolve('dimensionEI', dimensionOf(0)),
    dimensionSN: resolve('dimensionSN', dimensionOf(1)),
    dimensionTF: resolve('dimensionTF', dimensionOf(2)),
    dimensionJP: resolve('dimensionJP', dimensionOf(3)),

    // 大五
    bigFiveSummary: resolve('bigFiveSummary', bigFiveLines.length > 0 ? bigFiveLines.join('；') : null),

    // 关系与依恋
    attachmentStyle: resolve(
      'attachmentStyle',
      profile.attachmentStyle === null ? null : (ATTACHMENT_LABELS[profile.attachmentStyle] ?? profile.attachmentStyle),
    ),
    loveLanguages: resolve('loveLanguages', loveLanguages.length > 0 ? loveLanguages : null),
    conflictStyle: resolve('conflictStyle', profile.conflictStyle),

    // 质量与元信息
    mbtiConfidence: resolve('mbtiConfidence', formatScore(profile.mbtiConfidence)),
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
