/**
 * 星座运势模块的类型与枚举（**纯类型 + 常量，无副作用**）
 *
 * ## 这个模块的定位（先说清楚，后面每个文件都受它约束）
 *
 * 它是**娱乐/文化内容模块**，不是测评：
 *   · 不进测评框架（没有题目、没有作答、不落画像、不参与任何测评结论）；
 *   · 与人格 / 情感 / 心理状态三个模块**完全隔离**（ADR-038）——
 *     用户拍板"完全隔离"，因此星座说法**不得**出现在任何测评报告或结论里；
 *   · 内容由**确定性规则**生成（同一份日期 + 星座永远同一份），不调模型。
 *
 * ## 合规红线（写进类型注释，改代码前先读这里）
 *
 * 《互联网信息服务管理办法》第十五条禁止宣扬封建迷信；微信小程序平台对
 * 「占卜 / 算命 / 运势预测」另有拒绝情形。因此本模块的内容规则是：
 *
 *   ① **不得作为决策依据**：不出现"宜签约/宜投资/宜就医/宜辞职"这类会左右真实决策的表述；
 *   ② **不做健康与心理暗示**：健康维度只说作息、运动、饮水这类日常状态，
 *      🚫 不提疾病、症状、诊断，也不与心理状态模块的结论互相引用；
 *   ③ **不做承诺式预测**：不写"必定""一定会""准确率"，只说"今天更容易…"；
 *   ④ **必须标注娱乐性质**：免责声明由服务端下发，前端不得硬编码。
 */

/** 十二星座编码（与市面通用的英文名一致，便于与第三方内容对照） */
export const ZODIAC_SIGNS = [
  'ARIES',
  'TAURUS',
  'GEMINI',
  'CANCER',
  'LEO',
  'VIRGO',
  'LIBRA',
  'SCORPIO',
  'SAGITTARIUS',
  'CAPRICORN',
  'AQUARIUS',
  'PISCES',
] as const;

export type ZodiacSign = (typeof ZODIAC_SIGNS)[number];

/** 四大元素（星座的经典分类，纯文化知识，不含预测） */
export type ZodiacElement = 'FIRE' | 'EARTH' | 'AIR' | 'WATER';

/**
 * 今日运势的维度
 *
 * 顺序即详情页的展示顺序：综合在最上，其后是用户明确要求的五项
 * （爱情 / 财富 / 事业 / 学习 / 人际）。「状态」放在最后，
 * 它是本模块既有的第五维（只谈作息、运动、饮水、用眼，不做任何医疗暗示）。
 */
export const FORTUNE_DIMENSIONS = ['OVERALL', 'LOVE', 'WEALTH', 'CAREER', 'STUDY', 'SOCIAL', 'HEALTH'] as const;

export type FortuneDimension = (typeof FORTUNE_DIMENSIONS)[number];

/** 维度中文名 */
export const FORTUNE_DIMENSION_LABELS: Readonly<Record<FortuneDimension, string>> = {
  OVERALL: '综合',
  LOVE: '爱情',
  WEALTH: '财富',
  CAREER: '事业',
  STUDY: '学习',
  SOCIAL: '人际',
  HEALTH: '状态',
};

/** 星座周期（日运 / 周运 / 月运 / 年运） */
export const FORTUNE_PERIODS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;

export type FortunePeriod = (typeof FORTUNE_PERIODS)[number];

/** 元素的展示名与说明（星座科普用） */
export const ZODIAC_ELEMENT_LABELS: Readonly<Record<ZodiacElement, { label: string; description: string }>> = {
  FIRE: { label: '火象', description: '行动快、爱直接表达，靠热情推进事情。' },
  EARTH: { label: '土象', description: '重实际与稳定，习惯先把基础打牢。' },
  AIR: { label: '风象', description: '靠想法与交流运转，喜欢把事情聊清楚。' },
  WATER: { label: '水象', description: '感受细腻，靠情绪与直觉理解关系。' },
};

/** 一个星座的静态档案（**纯文化常识**，不含任何预测） */
export interface ZodiacProfile {
  readonly sign: ZodiacSign;
  /** 中文名 */
  readonly name: string;
  /** 英文名（大写） */
  readonly englishName: string;
  /** 日期区间（用于展示，判定逻辑在 `zodiac-sign.util.ts`） */
  readonly dateRange: string;
  readonly element: ZodiacElement;
  /** 守护星 */
  readonly ruler: string;
  /** 三个关键词 */
  readonly traits: readonly [string, string, string];
  /** 性格概述（2–3 句） */
  readonly personality: string;
  /** 爱情倾向 */
  readonly love: string;
  /** 事业倾向 */
  readonly career: string;
  /** 友情倾向 */
  readonly friendship: string;
  /** 优势（3 条） */
  readonly strengths: readonly [string, string, string];
  /** 需要留意的地方（3 条）——措辞克制，不是"缺点"，也不做人格否定 */
  readonly watchouts: readonly [string, string, string];
}
