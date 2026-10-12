/**
 * 人格画像 → Prompt 变量（纯函数，无 I/O、**不调用 AI**，可 100% 单测）
 *
 * 架构依据：ADR-005「算分确定、AI 只做解读」、架构 §10.4 上下文装配。
 *
 * ## 为什么不复用 `context/report-context.builder.ts`
 *
 * 那个 builder 面向**报告**：变量是 `mbtiType` / `dimensionEI` / `bigFiveSummary` …，
 * 供 3000 字的深度报告模板逐项展开。对话场景要的是**一段紧凑的人设描述**
 * （≤ 400 token，见契约 §3.7.1 规则 2），变量是 `myPersona` / `partnerPersona`。
 * 两者共用同一个数据源但**消费形态完全不同**：
 *   · 报告需要"所有维度都在场"（缺项用占位文案，模板永远能渲染）；
 *   · 对话需要"短且可读"（缺项直接省略，因为提示词预算要留给最近对话）。
 * 强行合并会让对话侧的 Prompt 变量里出现二十个用不上的占位符，
 * 而占位符一多，运营改模板时就无法判断哪些是必需的。
 *
 * 因此这里**从画像行直接产出一段文本**，并且刻意做成确定性纯函数：
 * 同一份画像永远生成同一段人设，方便排查"为什么 AI 是这么回我的"。
 */

import type { ConversationTone } from './chat.types';
import { estimateTokens } from './chat-context.util';

/** 画像行（只声明用到的字段，便于上层按需投影） */
export interface PersonaProfileRow {
  readonly mbtiType: string;
  readonly mbtiConfidence: number;
  readonly eiPercent: number;
  readonly snPercent: number;
  readonly tfPercent: number;
  readonly jpPercent: number;
  readonly openness: number;
  readonly conscientiousness: number;
  readonly extraversion: number;
  readonly agreeableness: number;
  readonly neuroticism: number;
  readonly attachmentStyle: string;
  readonly loveLanguages: readonly string[];
  readonly conflictStyle: string | null;
}

/** 依恋风格中文（未知编码原样输出，不猜） */
const ATTACHMENT_LABELS: Readonly<Record<string, string>> = {
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

/** 爱的语言中文（与 `report-context.builder.ts` 同一张表，避免两处文案不一致） */
const LOVE_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  WORDS_OF_AFFIRMATION: '肯定的言辞',
  QUALITY_TIME: '精心的时刻',
  RECEIVING_GIFTS: '接受礼物',
  ACTS_OF_SERVICE: '服务的行动',
  PHYSICAL_TOUCH: '身体的接触',
};

/** 维度字母 → 中文极性 */
const POLE_LABELS: Readonly<Record<string, string>> = {
  E: '外向',
  I: '内向',
  S: '实感',
  N: '直觉',
  T: '思考',
  F: '情感',
  J: '判断',
  P: '知觉',
};

/** 大五特质（固定顺序，保证同一画像产出同一段文本） */
const BIG_FIVE_ITEMS: ReadonlyArray<{ key: keyof BigFiveScores; label: string }> = [
  { key: 'openness', label: '开放性' },
  { key: 'conscientiousness', label: '尽责性' },
  { key: 'extraversion', label: '外向性' },
  { key: 'agreeableness', label: '宜人性' },
  { key: 'neuroticism', label: '情绪稳定性' },
];

/** 大五分数键 */
interface BigFiveScores {
  readonly openness: number;
  readonly conscientiousness: number;
  readonly extraversion: number;
  readonly agreeableness: number;
  readonly neuroticism: number;
}

/** 四维倾向（字母 + 百分比） */
interface Dimension {
  readonly letter: string;
  readonly percent: number;
}

/** 定点整数（0 位小数，避免同一数值出现 `78` 与 `78.00000001` 两种写法） */
const score = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0);

/** 大五档位（与报告 builder 同一套阈值：65/45/30，保证两处对同一分数的描述一致） */
const bigFiveLevel = (value: number): string => {
  if (value >= 80) return '高';
  if (value >= 65) return '偏高';
  if (value >= 45) return '中等';
  if (value >= 30) return '偏低';
  return '低';
};

/**
 * 组装单侧人设描述
 *
 * @param label       主语标签（`我` / `对方`）—— 让模型明确"这段说的是谁"，
 *                    而不是靠位置猜。带关系时对方是"我的伴侣"，无关系时是"对方"。
 * @param nickname    对方昵称（无昵称为 null 时不输出昵称行）
 * @param maxItems    大五最多列几项（默认 3）—— 列全 5 项在 400 token 预算里太奢侈，
 *                    优先列"与关系冲突最相关"的三项（情绪稳定性/宜人性/外向性）
 */
export const buildPersonaText = (
  label: string,
  profile: PersonaProfileRow,
  nickname: string | null = null,
  maxItems = 3,
): string => {
  const lines: string[] = [];
  const nameText = nickname !== null && nickname.length > 0 ? `${label}（${nickname}）` : label;

  const dimensions: readonly Dimension[] = [
    { letter: profile.mbtiType.charAt(0), percent: profile.eiPercent },
    { letter: profile.mbtiType.charAt(1), percent: profile.snPercent },
    { letter: profile.mbtiType.charAt(2), percent: profile.tfPercent },
    { letter: profile.mbtiType.charAt(3), percent: profile.jpPercent },
  ];

  const dimensionText = dimensions
    .filter((item) => POLE_LABELS[item.letter] !== undefined)
    .map((item) => `${POLE_LABELS[item.letter]} ${score(item.percent)}%`)
    .join('、');

  lines.push(`${nameText}：MBTI ${profile.mbtiType}${dimensionText.length > 0 ? `（${dimensionText}）` : ''}`);

  /**
   * 大五的选取顺序刻意不是 schema 的列顺序：`neuroticism`（情绪稳定性）与
   * `agreeableness` 直接决定"冲突时会不会炸/会不会退让"，是关系对话里最有用的一项；
   * `openness` 排最后，它对"沟通方式"的解释力最弱。
   */
  const bigFiveOrder = ['neuroticism', 'agreeableness', 'extraversion', 'conscientiousness', 'openness'] as const;

  const bigFiveText = bigFiveOrder
    .slice(0, Math.max(0, maxItems))
    .map((key) => {
      const label2 = BIG_FIVE_ITEMS.find((item) => item.key === key)?.label ?? key;
      const value = profile[key];

      return `${label2} ${score(value)}（${bigFiveLevel(value)}）`;
    })
    .join('、');

  if (bigFiveText.length > 0) lines.push(`特质：${bigFiveText}`);

  const attachment = ATTACHMENT_LABELS[profile.attachmentStyle] ?? profile.attachmentStyle;
  lines.push(`依恋风格：${attachment}`);

  if (profile.loveLanguages.length > 0) {
    lines.push(`爱的语言：${profile.loveLanguages.map((code) => LOVE_LANGUAGE_LABELS[code] ?? code).join('、')}`);
  }

  if (profile.conflictStyle !== null && profile.conflictStyle.trim().length > 0) {
    lines.push(`冲突中的表现：${profile.conflictStyle}`);
  }

  return lines.join('\n');
};

/** 语气指令（`tone` 影响 System Prompt，契约 §3.7.1 `tone`） */
export const buildToneInstruction = (tone: ConversationTone): string => {
  switch (tone) {
    case 'WARM':
      return '语气要求：温暖、共情优先。先接住对方的情绪，再讨论事情本身。';
    case 'NEUTRAL':
      return '语气要求：中立、克制。不刻意煽情，也不做价值判断，如实反映你观察到的模式。';
    case 'DIRECT':
      return '语气要求：直接、简洁。敢于指出不一致之处，给出明确的判断和可执行的建议，不绕弯子。';
  }
};

/** 会话模式附加指令（`PRACTICE` 的"沟通练习"就是靠这段指令实现，契约 §3.7.1 规则 4） */
export const buildModeInstruction = (mode: string): string => {
  switch (mode) {
    case 'PRACTICE':
      return [
        '当前是**沟通练习**模式。',
        '请在回复中包含：① 一句可以直接照着说出口的话术；② 说明它为什么有效（对方会听到什么）；③ 若对方给出某种常见回应，可以怎么接。',
        '话术必须具体到可以逐字念出来，不要给"要真诚沟通"这类空泛建议。',
      ].join('\n');
    case 'ANALYSIS':
      return [
        '当前是**关系分析**模式。',
        '请优先从双方人格差异出发解释现象（例如"他先处理事、你先处理感受"这类顺序差异），而不是只做情绪安抚。',
        '分析要指向可改变的具体行为，避免给人格贴标签（不要写"他就是个冷漠的人"）。',
      ].join('\n');
    case 'COMPANION':
    default:
      return '';
  }
};

/** 人设可见性说明（`includePersona = false` 时的替代指令，契约 §3.7.1） */
export const PERSONA_DISABLED_INSTRUCTION =
  '当前会话**未启用**人格画像。请不要假设或引用任何测评结论，只做中立的倾听与提问。';

/** 画像装配结果（同时给出 token 估算，供会话创建接口回填 `personaInjected`） */
export interface PersonaAssembly {
  readonly myPersona: string | null;
  readonly partnerPersona: string | null;
  readonly myEstimatedTokens: number;
  readonly partnerEstimatedTokens: number;
}

/** 画像装配输入 */
export interface PersonaAssemblyInput {
  readonly includePersona: boolean;
  readonly myProfile: PersonaProfileRow | null;
  readonly partnerProfile: PersonaProfileRow | null;
  readonly partnerNickname: string | null;
  /** 关系中文类型名（如"情侣"）；无关系时传 null */
  readonly relationTypeName?: string | null;
}

/**
 * 组装双方画像
 *
 * `includePersona = false` 时**两侧都返回 null**：契约把该开关定义为"是否注入人格画像
 * （false 时更中立的倾听者）"，只关掉对方那一侧不符合语义。
 */
export const assemblePersona = (input: PersonaAssemblyInput): PersonaAssembly => {
  if (!input.includePersona) {
    return { myPersona: null, partnerPersona: null, myEstimatedTokens: 0, partnerEstimatedTokens: 0 };
  }

  const myPersona = input.myProfile === null ? null : buildPersonaText('我', input.myProfile, null);
  const partnerPersona =
    input.partnerProfile === null
      ? null
      : buildPersonaText(
          input.relationTypeName === null || input.relationTypeName === undefined
            ? '对方'
            : `我的${input.relationTypeName}`,
          input.partnerProfile,
          input.partnerNickname,
          // 对方只列 2 项：双方画像共用 800 token 预算，给对方的篇幅略少，
          // 因为对话的主体是"我"的感受
          2,
        );

  return {
    myPersona,
    partnerPersona,
    myEstimatedTokens: myPersona === null ? 0 : estimateTokens(myPersona),
    partnerEstimatedTokens: partnerPersona === null ? 0 : estimateTokens(partnerPersona),
  };
};
