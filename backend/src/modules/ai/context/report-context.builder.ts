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
import { buildGenderContext } from './gender-context.util';

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

/**
 * 大五特质中文名（**提示词里唯一的中文名来源**）
 *
 * ⚠ `neuroticism` 必须叫「神经质」，**不能**叫「情绪稳定性」：
 * 引擎存的是**神经质原始分**（分数越高 = 情绪越容易波动），
 * `personality-engine.service.spec.ts` 写得很直白 ——
 * 「反向题选 5 → 情绪稳定性高 → **神经质得分为 0**」，
 * 关系风格规则也用 `neuroticism >= 90` 判**焦虑型**依恋。
 * 若把它标成「情绪稳定性」，`神经质 90（高）` 这行数据在提示词里就变成
 * 「情绪稳定性 90（高）」，模型会把**最容易焦虑的用户解读成最稳的人** ——
 * 结论正好说反，而且报告读起来毫无破绽（这正是它危险的地方）。
 *
 * 与产品术语一致：小程序 `config/constants.ts` 用的是
 * 「神经质｜情绪波动的敏感程度（分数越低越稳定）」，
 * 后端若另叫一个名字，AI 解读与用户看到的雷达图就会各说各话。
 *
 * **不要**改用「反转过数值」来迁就旧标签：关系风格规则、匹配权重矩阵都按
 * 原始分做阈值比较（`gte/lte`），反转数值会让这些规则静默失效。
 */
export const BIG_FIVE_LABELS: Readonly<Record<string, string>> = {
  openness: '开放性',
  conscientiousness: '尽责性',
  extraversion: '外向性',
  agreeableness: '宜人性',
  neuroticism: '神经质',
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
    /**
     * ⚠ 这里**刻意不再有** `attachmentStyle` / `loveLanguages` / `conflictStyle`（ADR-038）
     *
     * 这三项是**情感模块**的结论，此前是"从大五分数经规则表推导"出来的 ——
     * 等于人格模块在产情感结论，并从人格报告里解读出去，正是"模块互相干扰"的典型。
     * 情感结论将来由情感模块自己的组装器产出（阶段 3）。
     */
    readonly consistencyScore: number | null;
    readonly completionRate: number | null;
    readonly avgResponseMs: number | null;
    readonly engineVersion: string | null;
  };
  /** 测评定义编码（如 `MBTI_LITE`），用于让模型知道数据来自哪份量表 */
  readonly testDefinitionCode: string | null;
  readonly answeredCount: number | null;
  readonly questionCount: number | null;
  /**
   * 用户的性别（ADR-039），用于生成报告的**性别语境**
   *
   * ⚠ 它只影响举例与称呼，**不影响任何结论**（见 `gender-context.util.ts`）。
   * 传 `null` 表示未提供或选择不说 → 报告使用中性措辞。
   */
  readonly gender?: string | null;
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

  // ---- 质量与元信息 ----
  // ⚠ 关系风格（依恋 / 爱的语言 / 冲突处理）自 ADR-038 起**不在此组装**：
  // 那是情感模块的结论，不再进入人格报告（见上面类型定义处的说明）
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

    /**
     * 性别语境（ADR-039）
     *
     * ⚠ 用直接赋值而不是 `resolve(...)`：它**永远可用** ——
     * 未提供性别时给出的是一句明确指令（"一律使用中性措辞"），
     * 而不是"（本次测评未包含此项）"那种占位。后者会让模型自己脑补一个性别，
     * 而这份报告是要给用户看的。
     */
    genderContext: buildGenderContext(input.gender ?? null),
  };

  return { variables, unavailable };
};
