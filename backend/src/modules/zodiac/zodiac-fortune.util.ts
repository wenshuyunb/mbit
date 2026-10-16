/**
 * 星座运势的**确定性生成**（纯函数，无 I/O、无模型调用）
 *
 * ## 为什么不用 AI 生成
 *
 * 用户拍板"确定性生成"，理由在实现上也站得住：
 *   · **可复现**：同一天同一个星座，任何时候、任何用户、刷多少次都是同一份内容；
 *     换成模型生成，用户下拉刷新一次内容就变了 —— 那更像随机数，不像"运势"；
 *   · **成本**：十二星座 × 每天（再乘周运/月运）的常驻生成量，用模型是笔持续开销；
 *   · **合规**：模型写的"预测"没人能保证它不越界（不提投资、不提疾病、不做承诺），
 *     而文案池是**逐句过审**的，黑名单可以自动扫描。
 *
 * ## 生成方式
 *
 * 用 `(周期 + 日期 + 星座)` 拼成种子字符串 → 哈希 → 确定性伪随机源 → 从内容池里挑选。
 * 这样：
 *   · 换一天自动换一份（用户隔天来看有新鲜感）；
 *   · 同一天绝对不换（刷新不变）；
 *   · 不同星座同一天内容不同（种子含星座）。
 *
 * ⚠ **不改内容池就能改分布**：分数的加权表集中在 `STAR_WEIGHTS`，
 * 想让"五星"更少见只改那一个数组，不必动 12 个星座的任何文案。
 */

import {
  AVOID_ACTIVITIES,
  DAILY_TONES,
  DIMENSION_LINES,
  GOOD_ACTIVITIES,
  LUCKY_COLORS,
  LUCKY_DIRECTIONS,
  LUCKY_HOURS,
  MATCH_DIMENSION_LINES,
  MATCH_ELEMENT_NOTES,
  MONTHLY_PHASES,
  MONTHLY_THEMES,
  QUOTES,
  WEEKLY_LINES,
  WEEKLY_TIPS,
  ZODIAC_PROFILES,
} from './zodiac-content';
import {
  FORTUNE_DIMENSIONS,
  FORTUNE_DIMENSION_LABELS,
  ZODIAC_ELEMENT_LABELS,
  ZODIAC_SIGNS,
  type FortuneDimension,
  type ZodiacSign,
} from './zodiac.types';

// ============================================================================
// 确定性随机源
// ============================================================================

/**
 * 字符串 → 32 位种子（xmur3 的变体）
 *
 * 不用 `Math.random`（不可复现）、也不用 `crypto`（没必要，这不是安全场景）：
 * 这里要的是"同样的输入永远同样的输出"，且分布够均匀。
 */
const hashSeed = (text: string): number => {
  let hash = 1779033703 ^ text.length;

  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);

  return (hash ^ (hash >>> 16)) >>> 0;
};

/** 由种子字符串造一个 0–1 的确定性随机源（mulberry32） */
const createRandom = (seedText: string): (() => number) => {
  let state = hashSeed(seedText);

  return (): number => {
    state = (state + 0x6d2b79f5) | 0;

    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 从数组里确定性取一项 */
const pick = <T>(items: readonly T[], random: () => number): T => {
  const index = Math.floor(random() * items.length);

  return items[Math.min(index, items.length - 1)];
};

/**
 * 从数组里确定性取 `count` 个**不重复**的项
 *
 * 用"洗牌取前 n"而不是"随机取 n 次去重"：后者在池子接近 n 时会退化成死循环。
 */
const pickMany = <T>(items: readonly T[], count: number, random: () => number): T[] => {
  const pool = [...items];
  const taken: T[] = [];

  for (let index = 0; index < count && pool.length > 0; index += 1) {
    const at = Math.floor(random() * pool.length);
    taken.push(pool.splice(Math.min(at, pool.length - 1), 1)[0]);
  }

  return taken;
};

// ============================================================================
// 评级与档位
// ============================================================================

/**
 * 星级的加权分布（1–5 星）
 *
 * 刻意**不是均匀分布**：均匀随机时"五星"和"一星"一样常见，整页看起来
 * 不是天天爆棚就是天天糟糕。这里让三星占多数、两端少见 —— 与真实产品里
 * "大多数日子平平"的观感一致。权重表集中在这里，改分布不用碰任何文案。
 */
const STAR_WEIGHTS: ReadonlyArray<{ readonly stars: number; readonly weight: number }> = [
  { stars: 1, weight: 1 },
  { stars: 2, weight: 2 },
  { stars: 3, weight: 4 },
  { stars: 4, weight: 2 },
  { stars: 5, weight: 1 },
];

const drawStars = (random: () => number): number => {
  const total = STAR_WEIGHTS.reduce((sum, item) => sum + item.weight, 0);
  let threshold = random() * total;

  for (const item of STAR_WEIGHTS) {
    threshold -= item.weight;
    if (threshold <= 0) return item.stars;
  }

  return 3;
};

/** 星级 → 文案档位（1–2 低 / 3 中 / 4–5 高） */
const bandOf = (stars: number): 'LOW' | 'MID' | 'HIGH' => (stars <= 2 ? 'LOW' : stars === 3 ? 'MID' : 'HIGH');

/** 0–100 → 三档（配对用） */
const levelOf = (score: number): 'LOW' | 'MID' | 'HIGH' => (score < 50 ? 'LOW' : score < 75 ? 'MID' : 'HIGH');

// ============================================================================
// 视图类型
// ============================================================================

/** 一个维度的今日结果 */
export interface FortuneDimensionResult {
  readonly key: FortuneDimension;
  readonly label: string;
  /** 1–5 星 */
  readonly stars: number;
  /** 一句话解读 */
  readonly line: string;
}

/** 今日运势 */
export interface DailyFortuneView {
  readonly sign: ZodiacSign;
  readonly signName: string;
  /** 判定依据的日期（`YYYY-MM-DD`） */
  readonly date: string;
  /** 星座专属的今日基调 */
  readonly tone: string;
  readonly dimensions: readonly FortuneDimensionResult[];
  readonly lucky: {
    readonly color: { readonly name: string; readonly hex: string };
    readonly number: number;
    readonly direction: string;
    readonly hour: string;
  };
  /** 今日最合拍 / 需要多留意的星座 */
  readonly match: {
    readonly best: { readonly sign: ZodiacSign; readonly name: string };
    readonly watch: { readonly sign: ZodiacSign; readonly name: string };
  };
  /** 宜（只含日常小事） */
  readonly good: readonly string[];
  /** 忌（只含日常小事） */
  readonly avoid: readonly string[];
  readonly quote: string;
}

/** 周运 / 月运的一条 */
export interface FortunePeriodSection {
  readonly key: string;
  readonly label: string;
  /** 1–5 星（月运为整月趋势的星级） */
  readonly stars: number;
  readonly line: string;
}

/** 周运 */
export interface WeeklyFortuneView {
  readonly sign: ZodiacSign;
  readonly signName: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly tip: string;
  readonly sections: readonly FortunePeriodSection[];
}

/** 月运 */
export interface MonthlyFortuneView {
  readonly sign: ZodiacSign;
  readonly signName: string;
  /** `YYYY-MM` */
  readonly month: string;
  readonly theme: string;
  readonly stars: number;
  readonly sections: readonly FortunePeriodSection[];
}

/** 配对（两个星座的相处解读） */
export interface ZodiacMatchView {
  readonly a: { readonly sign: ZodiacSign; readonly name: string; readonly element: string };
  readonly b: { readonly sign: ZodiacSign; readonly name: string; readonly element: string };
  /** 0–100 的合拍指数 */
  readonly score: number;
  readonly level: 'LOW' | 'MID' | 'HIGH';
  readonly levelLabel: string;
  /** 元素组合的相处基调 */
  readonly elementNote: string;
  readonly dimensions: readonly FortunePeriodSection[];
  readonly advice: string;
}

// ============================================================================
// 日期工具（本地口径，只做"周/月"的边界计算，不涉及时区换算）
// ============================================================================

/** `YYYY-MM-DD` → `Date`（UTC 零点，避免本地时区把日期挪一天） */
const toDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

/** `Date` → `YYYY-MM-DD` */
const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** 该日期所在周的周一（ISO 口径：周一为一周开始） */
const startOfWeek = (isoDate: string): string => {
  const date = toDate(isoDate);
  const weekday = date.getUTCDay(); // 0 = 周日
  const offset = weekday === 0 ? -6 : 1 - weekday;

  date.setUTCDate(date.getUTCDate() + offset);

  return toIsoDate(date);
};

/** 周一 + 6 天 = 周日 */
const endOfWeek = (startIso: string): string => {
  const date = toDate(startIso);
  date.setUTCDate(date.getUTCDate() + 6);

  return toIsoDate(date);
};

/** `YYYY-MM-DD` → `YYYY-MM` */
const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

// ============================================================================
// 生成
// ============================================================================

/** 今日运势 */
export const buildDailyFortune = (sign: ZodiacSign, date: string): DailyFortuneView => {
  const random = createRandom(`daily:${sign}:${date}`);
  const profile = ZODIAC_PROFILES[sign];

  const dimensions: FortuneDimensionResult[] = FORTUNE_DIMENSIONS.map((dimension) => {
    const stars = drawStars(random);
    const line = pick(DIMENSION_LINES[dimension][bandOf(stars)], random);

    return { key: dimension, label: FORTUNE_DIMENSION_LABELS[dimension], stars, line };
  });

  // 速配 / 留意：从**除自己以外**的十一个星座里取两个，且两者不重复
  const others = ZODIAC_SIGNS.filter((item) => item !== sign);
  const [bestSign, watchSign] = pickMany(others, 2, random) as [ZodiacSign, ZodiacSign];

  return {
    sign,
    signName: profile.name,
    date,
    tone: pick(DAILY_TONES[sign], random),
    dimensions,
    lucky: {
      color: pick(LUCKY_COLORS, random),
      number: Math.floor(random() * 9) + 1,
      direction: pick(LUCKY_DIRECTIONS, random),
      hour: pick(LUCKY_HOURS, random),
    },
    match: {
      best: { sign: bestSign, name: ZODIAC_PROFILES[bestSign].name },
      watch: { sign: watchSign, name: ZODIAC_PROFILES[watchSign].name },
    },
    good: pickMany(GOOD_ACTIVITIES, 3, random),
    avoid: pickMany(AVOID_ACTIVITIES, 2, random),
    quote: pick(QUOTES, random),
  };
};

/** 周运（按**该周周一**做种子：同一周内任何一天看都是同一份） */
export const buildWeeklyFortune = (sign: ZodiacSign, date: string): WeeklyFortuneView => {
  const startDate = startOfWeek(date);
  const random = createRandom(`weekly:${sign}:${startDate}`);

  const sections: FortunePeriodSection[] = (
    [
      { key: 'CAREER', label: '事业与学业' },
      { key: 'LOVE', label: '感情与关系' },
      { key: 'SELF', label: '状态与节奏' },
    ] as const
  ).map((item) => {
    const stars = drawStars(random);

    return { key: item.key, label: item.label, stars, line: pick(WEEKLY_LINES[item.key][bandOf(stars)], random) };
  });

  return {
    sign,
    signName: ZODIAC_PROFILES[sign].name,
    startDate,
    endDate: endOfWeek(startDate),
    tip: pick(WEEKLY_TIPS, random),
    sections,
  };
};

/** 月运（按 `YYYY-MM` 做种子） */
export const buildMonthlyFortune = (sign: ZodiacSign, date: string): MonthlyFortuneView => {
  const month = monthOf(date);
  const random = createRandom(`monthly:${sign}:${month}`);

  const sections: FortunePeriodSection[] = (
    [
      { key: 'EARLY', label: '上旬' },
      { key: 'MIDDLE', label: '中旬' },
      { key: 'LATE', label: '下旬' },
    ] as const
  ).map((item) => {
    const stars = drawStars(random);

    return { key: item.key, label: item.label, stars, line: pick(MONTHLY_PHASES[item.key][bandOf(stars)], random) };
  });

  return {
    sign,
    signName: ZODIAC_PROFILES[sign].name,
    month,
    theme: pick(MONTHLY_THEMES, random),
    stars: drawStars(random),
    sections,
  };
};

/**
 * 配对
 *
 * ## 分数怎么来（可复现、与输入顺序无关）
 *
 * 基础分由**元素关系**决定（同元素最合、互补元素次之、对宫元素偏低），
 * 再加一个由 `(两个星座排序后)` 决定的 ±10 确定性扰动。
 * 排序后再拼种子，是为了保证 `match(a, b) === match(b, a)` ——
 * 否则"你和 TA"和"TA 和你"会得到两个分数，这是必错的。
 */
export const buildZodiacMatch = (a: ZodiacSign, b: ZodiacSign): ZodiacMatchView => {
  const profileA = ZODIAC_PROFILES[a];
  const profileB = ZODIAC_PROFILES[b];

  const baseByElement: Readonly<Record<string, number>> = {
    'FIRE-FIRE': 82,
    'EARTH-EARTH': 84,
    'AIR-AIR': 80,
    'WATER-WATER': 83,
    'FIRE-AIR': 86,
    'EARTH-WATER': 85,
    'FIRE-EARTH': 58,
    'FIRE-WATER': 54,
    'EARTH-AIR': 56,
    'AIR-WATER': 52,
  };

  const key = [profileA.element, profileB.element].sort().join('-');
  const base = baseByElement[key] ?? 60;

  // 顺序无关的确定性扰动（-8 ~ +8）
  const sortedPair = [a, b].sort().join(':');
  const random = createRandom(`match:${sortedPair}`);
  const jitter = Math.floor(random() * 17) - 8;
  const score = Math.max(30, Math.min(96, base + jitter));
  const level = levelOf(score);

  const dimensions: FortunePeriodSection[] = (
    [
      { key: 'COMMUNICATION', label: '沟通方式' },
      { key: 'SPARK', label: '相处氛围' },
      { key: 'LONGTERM', label: '长期节奏' },
    ] as const
  ).map((item) => {
    // 每个维度围绕总分浮动（±1 星），避免出现"总分很高但每个维度都低"的矛盾观感
    const offset = Math.floor(random() * 3) - 1;
    const stars = Math.max(1, Math.min(5, Math.round(score / 20) + offset));

    return {
      key: item.key,
      label: item.label,
      stars,
      line: pick(MATCH_DIMENSION_LINES[item.key][bandOf(stars)], random),
    };
  });

  const levelLabel = level === 'HIGH' ? '很合得来' : level === 'MID' ? '需要磨合' : '差异明显';

  return {
    a: { sign: a, name: profileA.name, element: ZODIAC_ELEMENT_LABELS[profileA.element].label },
    b: { sign: b, name: profileB.name, element: ZODIAC_ELEMENT_LABELS[profileB.element].label },
    score,
    level,
    levelLabel,
    elementNote: MATCH_ELEMENT_NOTES[key] ?? '你们的节奏不完全一样，需要把彼此的默认说清楚。',
    dimensions,
    advice:
      level === 'HIGH'
        ? '你们的基础不错，别把顺畅当成理所当然 —— 定期把想说的话说一次，比默契更耐用。'
        : level === 'MID'
          ? '你们需要把各自的节奏讲清楚：哪些事必须马上说、哪些可以放一放。谈清了差异就不磨人了。'
          : '你们的默认设置差别比较大，别靠猜也别靠忍 —— 把"我希望你这样做"讲成具体的话，会省掉很多误会。',
  };
};
