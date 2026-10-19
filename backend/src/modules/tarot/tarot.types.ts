/**
 * 塔罗牌的类型定义（**纯类型 + 常量，无副作用**）
 *
 * ## 定位与合规红线（与星座模块同一套）
 *
 * 塔罗是**娱乐性文化内容**，不是测评、不做预测、不进任何画像。
 * 红线与 `zodiac.types.ts` 完全一致，这里再写一遍是因为改代码的人可能只读这一个文件：
 *
 *   ① **不做决策引导**：不出现"该不该辞职/投资/就医"这类会左右真实决策的表述；
 *   ② **不做健康与心理暗示**：不提疾病、症状、诊断；
 *   ③ **不做承诺式预测**：不写"必定""一定会""准确率"，只说"这张牌提示的倾向是"；
 *   ④ **必须标注娱乐性质**：免责声明由服务端下发，前端不得硬编码。
 *
 * ## 为什么小阿卡纳用「花色 × 数字」组合而不是逐张写文案
 *
 * 22 张大阿卡纳是**具象的意象**（愚者、塔、星星），值得逐张写；
 * 而 56 张小阿卡纳本身就是**组合语法**：花色给出领域、数字给出阶段，
 * 传统解读也是这么读的（"权杖三"= 行动领域 + 初步成形）。
 *
 * 因此这里给小阿卡纳逐张写的是**关键词**，正文由组合规则生成 ——
 * 既覆盖了全部 78 张，又不会出现"为了凑数把同一句话复制 56 遍"。
 */

/** 牌的分类 */
export const TAROT_ARCANA = ['MAJOR', 'MINOR'] as const;
export type TarotArcana = (typeof TAROT_ARCANA)[number];

/** 小阿卡纳的四种花色（对应四个生活领域） */
export const TAROT_SUITS = ['WANDS', 'CUPS', 'SWORDS', 'PENTACLES'] as const;
export type TarotSuit = (typeof TAROT_SUITS)[number];

/** 花色中文名与领域说明（纯文化常识） */
export const TAROT_SUIT_LABELS: Readonly<Record<TarotSuit, { name: string; domain: string; symbol: string }>> = {
  WANDS: { name: '权杖', domain: '行动与热情', symbol: '🜂' },
  CUPS: { name: '圣杯', domain: '情感与关系', symbol: '🜄' },
  SWORDS: { name: '宝剑', domain: '想法与冲突', symbol: '🜁' },
  PENTACLES: { name: '星币', domain: '现实与积累', symbol: '🜃' },
};

/** 小阿卡纳的位阶（Ace–10 之后是四个宫廷牌） */
export const TAROT_RANKS = [
  'ACE',
  'TWO',
  'THREE',
  'FOUR',
  'FIVE',
  'SIX',
  'SEVEN',
  'EIGHT',
  'NINE',
  'TEN',
  'PAGE',
  'KNIGHT',
  'QUEEN',
  'KING',
] as const;
export type TarotRank = (typeof TAROT_RANKS)[number];

/** 位阶中文名与阶段含义 */
export const TAROT_RANK_LABELS: Readonly<Record<TarotRank, { name: string; stage: string }>> = {
  ACE: { name: 'Ace', stage: '一个开始' },
  TWO: { name: '二', stage: '两者之间的关系' },
  THREE: { name: '三', stage: '初步成形' },
  FOUR: { name: '四', stage: '稳定与停滞' },
  FIVE: { name: '五', stage: '摩擦与失衡' },
  SIX: { name: '六', stage: '回到平衡' },
  SEVEN: { name: '七', stage: '评估与选择' },
  EIGHT: { name: '八', stage: '推进与加速' },
  NINE: { name: '九', stage: '接近完成' },
  TEN: { name: '十', stage: '一个周期的收尾' },
  PAGE: { name: '侍从', stage: '学习与试探' },
  KNIGHT: { name: '骑士', stage: '推进与行动' },
  QUEEN: { name: '王后', stage: '内在的成熟' },
  KING: { name: '国王', stage: '外在的掌控' },
};

/**
 * 牌的朝向
 *
 * ⚠ 逆位不等于"坏牌"：它表示这张牌的能量**受阻、内化或过量**。
 * 因此逆位文案必须避免"凶""不吉"这类措辞（合规红线 ③）。
 */
export const TAROT_ORIENTATIONS = ['UPRIGHT', 'REVERSED'] as const;
export type TarotOrientation = (typeof TAROT_ORIENTATIONS)[number];

export const TAROT_ORIENTATION_LABELS: Readonly<Record<TarotOrientation, string>> = {
  UPRIGHT: '正位',
  REVERSED: '逆位',
};

/** 一张牌（大阿卡纳逐张提供，小阿卡纳提供关键词） */
export interface TarotCard {
  /** 稳定编码，如 `MAJOR-00`、`WANDS-THREE` */
  readonly id: string;
  readonly arcana: TarotArcana;
  /** 大阿卡纳的罗马数字；小阿卡纳为 null */
  readonly numeral: string | null;
  readonly suit: TarotSuit | null;
  readonly rank: TarotRank | null;
  /** 中文牌名（如「愚者」「权杖三」） */
  readonly name: string;
  /** 牌面符号（小程序不依赖图片资源，用字符组合出视觉） */
  readonly symbol: string;
  /** 关键词（正位） */
  readonly keywords: readonly string[];
  /** 正位解读 */
  readonly upright: string;
  /** 逆位解读 */
  readonly reversed: string;
}

/** 抽到的牌（含朝向与当日提示） */
export interface TarotDraw {
  readonly card: TarotCard;
  readonly orientation: TarotOrientation;
  readonly orientationLabel: string;
  /** 当日抽卡日期 `YYYY-MM-DD` */
  readonly date: string;
  /** 当日提示（把牌义落到"今天可以怎么用"，仍然不做决策引导） */
  readonly advice: string;
}
