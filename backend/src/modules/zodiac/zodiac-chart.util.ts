/**
 * 本命星盘（Natal Chart）计算
 *
 * ## 这一层要回答的问题
 *
 * 星座运势那一层只用到**太阳星座**（出生日期决定的那个），是本模块最浅的一层。
 * 星盘是专业用户真正在意的东西：它把**出生的那一刻**还原成一张天图 ——
 * 十大行星各在什么星座什么度数、上升点（ASC）与天顶（MC）、十二宫、相互相位、
 * 元素与宫位类型的分布。同一个太阳星座的人，星盘可以完全不同，这才是"专业"的差别。
 *
 * ## 三条必须写死的产品判断（不是技术细节，是会直接影响用户信任的）
 *
 * ### ① 没有出生时间、或没有出生城市，就**不给**上升星座与宫位
 *
 * 上升星座约 **2 小时换一个**，一天之内十二个星座全都会轮到。市面上不少产品
 * 在用户没填时间时"默认中午 12:00"照样输出一个上升星座 —— 那个答案对
 * **大多数用户都是错的**，而且用户无从察觉。这里选择：宁可少给，不给错。
 *
 * 出生城市同理，而且更隐蔽：上升星座取决于**当地**星空（经度通过恒星时生效），
 * 中国横跨东经 73°–135°，东西两端地方时相差 4 个多小时。若默认按北京算，
 * 乌鲁木齐出生的用户上升点会错一个星座以上。
 *
 * （月亮也受时间影响：日行 11.8–15.4°，没有时间时它的位置标 `uncertain`。）
 *
 * ### ② 分宫制用**整宫制（Whole Sign）**，并在响应里明确标注
 *
 * 分宫制有多种流派（Placidus / Koch / 整宫制…），同一个上升点算出来的宫位
 * 会不一样。第一版选整宫制：规则简单、无需迭代、高纬度不会退化（Placidus
 * 在 |φ| > 66° 无解）。响应里带 `houseSystem: 'WHOLE_SIGN'`，
 * 避免懂行的用户拿 Placidus 的结果来质疑。
 *
 * ### ③ 精度必须**如实说明**，不宣称"专业星历级"
 *
 * 黄经误差约 0.01°–0.1° 量级（太阳/月亮用 Meeus 级数，行星用 JPL 轨道根数），
 * 对星座归属与相位判定绰绰有余，但**不等于**专业星历软件（不做章动、
 * 光行时、视差改正）。星盘四轴的误差对**出生时间**极其敏感（每 4 分钟约 1°），
 * 精确到"分"的度数只应作为参考 —— 这一点写进 `precisionNote` 直接告诉用户。
 */

import {
  ascendantLongitude as computeAscendant,
  findAspects,
  julianDay,
  localSiderealTime,
  midheavenLongitude as computeMidheaven,
  moonLongitude,
  normalizeDegrees,
  planetLongitude,
  resolveTimezoneOffset,
  sunLongitude,
  wholeSignCusps,
  type AspectHit,
} from './zodiac-astro.util';
import { ZODIAC_PROFILES } from './zodiac-content';
import { ZODIAC_ELEMENT_LABELS, ZODIAC_SIGNS, type ZodiacElement, type ZodiacSign } from './zodiac.types';

// ============================================================================
// 天体元数据
// ============================================================================

/** 天体的静态信息（顺序即前端展示顺序：由内到外） */
export const PLANET_META: ReadonlyArray<{ readonly key: string; readonly name: string; readonly symbol: string }> = [
  { key: 'SUN', name: '太阳', symbol: '☉' },
  { key: 'MOON', name: '月亮', symbol: '☽' },
  { key: 'MERCURY', name: '水星', symbol: '☿' },
  { key: 'VENUS', name: '金星', symbol: '♀' },
  { key: 'MARS', name: '火星', symbol: '♂' },
  { key: 'JUPITER', name: '木星', symbol: '♃' },
  { key: 'SATURN', name: '土星', symbol: '♄' },
  { key: 'URANUS', name: '天王星', symbol: '♅' },
  { key: 'NEPTUNE', name: '海王星', symbol: '♆' },
  { key: 'PLUTO', name: '冥王星', symbol: '♇' },
];

/** 只有行星会逆行（太阳与月亮在地心视角下永远顺行） */
const RETROGRADE_CANDIDATES = PLANET_META.slice(2).map((meta) => meta.key);

/** 星座 → 四元素（白羊=火，依次循环） */
export const ELEMENT_BY_SIGN: Readonly<Record<ZodiacSign, ZodiacElement>> = ZODIAC_SIGNS.reduce(
  (accumulator, sign, index) => {
    const elements: readonly ZodiacElement[] = ['FIRE', 'EARTH', 'AIR', 'WATER'];
    accumulator[sign] = elements[index % 4];

    return accumulator;
  },
  {} as Record<ZodiacSign, ZodiacElement>,
);

/** 三分类（宫位类型）：基本 / 固定 / 变动，同样按星座顺序循环 */
export type ZodiacMode = 'CARDINAL' | 'FIXED' | 'MUTABLE';

export const MODE_BY_SIGN: Readonly<Record<ZodiacSign, ZodiacMode>> = ZODIAC_SIGNS.reduce(
  (accumulator, sign, index) => {
    const modes: readonly ZodiacMode[] = ['CARDINAL', 'FIXED', 'MUTABLE'];
    accumulator[sign] = modes[index % 3];

    return accumulator;
  },
  {} as Record<ZodiacSign, ZodiacMode>,
);

export const ZODIAC_MODE_LABELS: Readonly<Record<ZodiacMode, { label: string; description: string }>> = {
  CARDINAL: { label: '基本宫', description: '习惯先动手开个头，事情往往由他们起头。' },
  FIXED: { label: '固定宫', description: '认准了就不太改，能扛住长期的事。' },
  MUTABLE: { label: '变动宫', description: '适应变化快，环境一变就先调整自己。' },
};

/** 四轴（上升/天顶）的展示名 */
export const ANGLE_META = {
  ASCENDANT: { key: 'ASCENDANT', name: '上升点', symbol: 'ASC' },
  MIDHEAVEN: { key: 'MIDHEAVEN', name: '天顶', symbol: 'MC' },
} as const;

// ============================================================================
// 输入与输出类型
// ============================================================================

/** 出生信息（**时间和出生城市都可缺**：缺任一项就不出上升点与宫位） */
export interface BirthInput {
  /** 出生日期 `YYYY-MM-DD` */
  readonly birthday: string;
  /** 出生时间 `HH:mm`，可为空 */
  readonly birthTime?: string | null;
  /** 出生地名称（仅用于回显） */
  readonly birthPlace?: string | null;
  readonly birthLatitude?: number | null;
  readonly birthLongitude?: number | null;
  /** 出生地时区偏移（小时）。为空时按中国标准时 +8 推断（含 1986–1991 夏令时） */
  readonly birthTimezoneOffset?: number | null;
}

/** 某个天体在盘上的位置 */
export interface ChartPosition {
  readonly key: string;
  readonly name: string;
  readonly symbol: string;
  /** 黄经（度，0–360） */
  readonly longitude: number;
  readonly sign: ZodiacSign;
  readonly signName: string;
  /** 星座内的整数度 */
  readonly degree: number;
  /** 星座内的分（0–59） */
  readonly minute: number;
  /** 展示串，例如 `狮子座 22°09′` */
  readonly position: string;
  /** 整宫制宫位（1–12）；无出生时间时为 null */
  readonly house: number | null;
  readonly retrograde: boolean;
  /** 位置是否不可靠（目前只有"缺出生时间时的月亮"） */
  readonly uncertain: boolean;
}

/** 十二宫中的一个宫 */
export interface ChartHouse {
  readonly index: number;
  readonly cusp: number;
  readonly sign: ZodiacSign;
  readonly signName: string;
  readonly position: string;
}

/** 一条相位（带天体中文名） */
export interface ChartAspect extends AspectHit {
  readonly fromName: string;
  readonly toName: string;
  readonly orbText: string;
}

/** 分布统计（元素 / 宫位类型共用） */
export interface DistributionEntry<T extends string> {
  readonly key: T;
  readonly label: string;
  readonly description: string;
  readonly count: number;
  readonly percent: number;
  readonly signs: readonly ZodiacSign[];
}

export interface NatalChart {
  /** 是否拿到了出生时间（**false 时 `angles`/`houses` 为 null**） */
  readonly hasBirthTime: boolean;
  /** 是否拿到了出生地经纬度（**false 时同样不出 `angles`/`houses`**） */
  readonly hasBirthPlace: boolean;
  readonly moment: {
    readonly localDateTime: string;
    readonly utcDateTime: string;
    readonly timezoneOffset: number;
    readonly place: string | null;
    readonly latitude: number | null;
    readonly longitude: number | null;
    /** 时区是否由系统按历史规则推断（而非用户显式给出） */
    readonly timezoneInferred: boolean;
  };
  readonly positions: readonly ChartPosition[];
  readonly angles: {
    readonly ascendant: ChartPosition | null;
    readonly midheaven: ChartPosition | null;
  };
  readonly houses: readonly ChartHouse[] | null;
  readonly aspects: readonly ChartAspect[];
  readonly elementDistribution: readonly DistributionEntry<ZodiacElement>[];
  readonly modeDistribution: readonly DistributionEntry<ZodiacMode>[];
  readonly dominantElement: DistributionEntry<ZodiacElement> | null;
  readonly dominantMode: DistributionEntry<ZodiacMode> | null;
  /** 一个都没有的元素 / 宫位类型（缺失比"最弱"更值得说） */
  readonly missingElements: readonly ZodiacElement[];
  readonly missingModes: readonly ZodiacMode[];
  /** 星群：同一星座聚集 3 个及以上行星 */
  readonly stelliums: ReadonlyArray<{
    readonly sign: ZodiacSign;
    readonly signName: string;
    readonly bodies: readonly string[];
  }>;
  /** 命主星（上升星座的守护星）与其在本盘中的落点 */
  readonly chartRuler: { readonly planetName: string; readonly position: string; readonly signName: string } | null;
  readonly houseSystem: 'WHOLE_SIGN';
  /** 精度说明（服务端下发，前端不得硬编码） */
  readonly precisionNote: string;
  /** 缺出生时间时的提示（有出生时间时为 null） */
  readonly noTimeNotice: string | null;
  /** 缺出生城市时的提示（有经纬度时为 null） */
  readonly noPlaceNotice: string | null;
}

// ============================================================================
// 给用户看的两段说明（合规：如实描述能力边界，不做任何"精准预测"承诺）
// ============================================================================

export const CHART_PRECISION_NOTE =
  '这份星盘由内置天文算法实时计算：太阳与月亮用 Meeus 级数，行星用 JPL 轨道根数（有效区间 1800–2050）。' +
  '行星黄经已用 15 个公开的行星换座／退回日期逐个校准，残差在 0.1°（约 6 角分）以内，足够决定星座归属与相位判定。' +
  '未做章动、光行时与地形视差改正，因此这是文化娱乐用途的参考盘，不作为任何专业天文或决策依据。' +
  '另外：宫位采用整宫制（与 Placidus 等分宫制结果不同属正常，不是算错）；' +
  '上升点对出生时间极敏感 —— 时间每差 10 分钟，上升点就差约 2.5°，恰好压在星座交界时可能整个换座，所以填时间时越准越好。';

export const CHART_NO_TIME_NOTICE =
  '你还没有填出生时间，所以这份星盘缺了上升星座和十二宫 —— 这不是我们算不出来，而是没有时间就没有答案：' +
  '上升星座约每 2 小时换一个，一天之内十二个星座会全部轮到，用"默认中午"推算出来的上升星座对大多数人是错的。' +
  '补上出生时间（精确到分钟最好）就能解锁上升星座、天顶、十二宫，以及月亮位置的精确度数。';

export const CHART_NO_PLACE_NOTICE =
  '还缺出生城市。上升星座取决于当地的星空，而中国横跨约 62 个经度（东经 73°–135°），' +
  '东西两端的地方时相差 4 个多小时 —— 如果按某个固定城市去猜，新疆出生的用户上升点会整整错一个星座。' +
  '所以这里同样是宁可不给、不给错：选好出生城市（精确到地级市即可）就会补上上升星座、天顶与十二宫。';

/**
 * 会员才能看到的星盘区块（逐条列清楚，而不是把内容糊掉）
 *
 * 与解锁文案一起放在这里的原因：它们是**用户直接读到的文案**，
 * 必须和 `CHART_*_NOTICE` 一样被 `zodiac-chart.util.spec.ts` 的合规断言覆盖
 * （不得出现 `**` 之类的标记、不得出现决策/医疗/承诺/占卜用词）。
 */
export const CHART_LOCKED_SECTIONS: readonly string[] = [
  '完整的十大行星位置（度数精确到分、逆行标记）',
  '上升星座与天顶的精确度数',
  '十二宫（整宫制）与每颗行星落在哪一宫',
  '行星之间的相位（合相 / 六合 / 刑相 / 拱相 / 冲相，含容许度）',
  '四元素与三分类（基本宫 / 固定宫 / 变动宫）分布、星群、命主星',
];

export const CHART_MEMBERSHIP_HINT =
  '完整星盘（十大行星的精确度数、上升星座与天顶、十二宫、相位、元素分布与命主星）属于会员功能。' +
  '免费可以先看太阳、月亮与上升的星座 —— 这三者已经是最常被问到的一部分了。';

// ============================================================================
// 工具函数
// ============================================================================

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * 星座中文名与守护星：**唯一来源是 `ZODIAC_PROFILES`**
 *
 * 这里刻意不另写一份映射表 —— 星座档案（`zodiac-content.ts`）已经包含了
 * 中文名与守护星，另写一份迟早会与档案不一致（用户在"星座档案"页看到的
 * 守护星和星盘里算出来的命主星对不上，这种矛盾最难解释）。
 */
const SIGN_NAMES: Readonly<Record<ZodiacSign, string>> = ZODIAC_SIGNS.reduce(
  (accumulator, sign) => {
    // 注意：档案里的 `name` **已经带"座"字**（'狮子座'），拼展示串时不要再加一次
    accumulator[sign] = ZODIAC_PROFILES[sign].name;

    return accumulator;
  },
  {} as Record<ZodiacSign, string>,
);

const SIGN_RULERS: Readonly<Record<ZodiacSign, string>> = ZODIAC_SIGNS.reduce(
  (accumulator, sign) => {
    accumulator[sign] = ZODIAC_PROFILES[sign].ruler;

    return accumulator;
  },
  {} as Record<ZodiacSign, string>,
);

/** 黄经 → 星座 + 星座内度分（含 60′ 进位处理） */
export const resolveSignPosition = (
  longitude: number,
): { sign: ZodiacSign; signName: string; degree: number; minute: number; position: string } => {
  const normalized = normalizeDegrees(longitude);
  const signIndex = Math.min(11, Math.floor(normalized / 30));
  const sign = ZODIAC_SIGNS[signIndex];
  const within = normalized - signIndex * 30;

  let degree = Math.floor(within);
  let minute = Math.round((within - degree) * 60);

  if (minute === 60) {
    degree += 1;
    minute = 0;
  }

  // 进位到 30° 时留在本星座（30°00′ 属于下一个星座，展示上会造成困惑）
  if (degree >= 30) {
    degree = 29;
    minute = 59;
  }

  return {
    sign,
    signName: SIGN_NAMES[sign],
    degree,
    minute,
    position: `${SIGN_NAMES[sign]} ${degree}°${pad2(minute)}′`,
  };
};

/**
 * 解析出生时刻 → 儒略日 + 世界时展示串
 *
 * @throws RangeError 出生日期格式不合法
 */
export const resolveBirthMoment = (
  input: BirthInput,
): {
  jd: number;
  hasBirthTime: boolean;
  localDateTime: string;
  utcDateTime: string;
  timezoneOffset: number;
  timezoneInferred: boolean;
} => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.birthday ?? '');
  if (match === null) throw new RangeError('出生日期格式应为 YYYY-MM-DD');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // 时间缺失时按 12:00 计算行星（对除月亮外的天体几乎无影响），但不输出四轴与宫位
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec((input.birthTime ?? '').trim());
  const hasBirthTime = timeMatch !== null;
  const hour = hasBirthTime ? Number(timeMatch[1]) : 12;
  const minute = hasBirthTime ? Number(timeMatch[2]) : 0;

  if (hour > 23 || minute > 59) throw new RangeError('出生时间格式应为 HH:mm');

  const explicitOffset = input.birthTimezoneOffset;
  const timezoneInferred = !(typeof explicitOffset === 'number' && Number.isFinite(explicitOffset));
  const timezoneOffset = resolveTimezoneOffset(year, month, day, explicitOffset);

  // 当地时间 → 世界时：直接用 JS 的 UTC 运算做跨日换算，避免手写进位
  const utcMilliseconds = Date.UTC(year, month - 1, day, hour, minute) - timezoneOffset * 3_600_000;
  const utcDate = new Date(utcMilliseconds);

  // 儒略日与上面的 UTC 时刻等价（julianDay 的 hourUtc 允许为负，跨日由线性公式自然处理）
  const jd = julianDay(year, month, day, hour + minute / 60 - timezoneOffset);

  return {
    jd,
    hasBirthTime,
    localDateTime: `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`,
    utcDateTime:
      `${utcDate.getUTCFullYear()}-${pad2(utcDate.getUTCMonth() + 1)}-${pad2(utcDate.getUTCDate())} ` +
      `${pad2(utcDate.getUTCHours())}:${pad2(utcDate.getUTCMinutes())}`,
    timezoneOffset,
    timezoneInferred,
  };
};

/** 判定是否逆行（用前后半天的黄经变化方向，跨 0° 由最短弧处理） */
const isRetrograde = (planet: string, jd: number): boolean => {
  const before = planetLongitude(planet, jd - 0.5);
  const after = planetLongitude(planet, jd + 0.5);
  const delta = normalizeDegrees(after - before);

  return delta > 180;
};

/** 把一个黄经包装成 ChartPosition */
const toPosition = (
  meta: { key: string; name: string; symbol: string },
  longitude: number,
  house: number | null,
  retrograde: boolean,
  uncertain: boolean,
): ChartPosition => {
  const resolved = resolveSignPosition(longitude);

  return {
    key: meta.key,
    name: meta.name,
    symbol: meta.symbol,
    longitude: Math.round(normalizeDegrees(longitude) * 1000) / 1000,
    sign: resolved.sign,
    signName: resolved.signName,
    degree: resolved.degree,
    minute: resolved.minute,
    position: resolved.position,
    house,
    retrograde,
    uncertain,
  };
};

/** 构建元素 / 宫位类型的分布统计 */
const buildDistribution = <T extends string>(
  signs: readonly ZodiacSign[],
  keys: readonly T[],
  resolveKey: (sign: ZodiacSign) => T,
  labels: Readonly<Record<T, { label: string; description: string }>>,
): DistributionEntry<T>[] => {
  const total = signs.length;

  return keys.map((key) => {
    const matched = signs.filter((sign) => resolveKey(sign) === key);

    return {
      key,
      label: labels[key].label,
      description: labels[key].description,
      count: matched.length,
      percent: total === 0 ? 0 : Math.round((matched.length / total) * 100),
      signs: matched,
    };
  });
};

// ============================================================================
// 主流程
// ============================================================================

/**
 * 计算本命星盘
 *
 * @param input 出生信息（缺时间时仍然可用，只是没有四轴与宫位）
 */
export const buildNatalChart = (input: BirthInput): NatalChart => {
  const moment = resolveBirthMoment(input);

  /**
   * 出生城市：**没有默认值**
   *
   * 经纬度缺失时不算四轴。中国横跨东经 73°–135°，相差 62° ≈ 4.1 小时地方时，
   * 若默认按北京（116.4°E）算，乌鲁木齐出生的用户上升点会错 30° 以上（整整一个星座），
   * 而用户完全看不出来 —— 这类"看起来正常但错了"的结果比"没给"糟糕得多。
   */
  const hasBirthPlace =
    typeof input.birthLatitude === 'number' &&
    Number.isFinite(input.birthLatitude) &&
    typeof input.birthLongitude === 'number' &&
    Number.isFinite(input.birthLongitude);
  const latitude = hasBirthPlace ? input.birthLatitude : null;
  const longitude = hasBirthPlace ? input.birthLongitude : null;

  const { jd, hasBirthTime } = moment;
  /** 四轴与宫位需要"时间 + 地点"同时具备 */
  const anglesAvailable = hasBirthTime && hasBirthPlace && latitude !== null && longitude !== null;

  // 恒星时 → 上升点 / 天顶
  const lst = anglesAvailable ? localSiderealTime(jd, longitude) : null;
  const ascendantDegree = anglesAvailable && lst !== null ? computeAscendant(lst, latitude, jd) : null;
  const midheavenDegree = anglesAvailable && lst !== null ? computeMidheaven(lst, jd) : null;
  const ascendantSignIndex = ascendantDegree === null ? null : Math.floor(normalizeDegrees(ascendantDegree) / 30);

  /** 整宫制宫位号：以上升点所在星座为第 1 宫 */
  const houseOf = (bodyLongitude: number): number | null => {
    if (ascendantSignIndex === null) return null;

    const signIndex = Math.floor(normalizeDegrees(bodyLongitude) / 30);

    return ((signIndex - ascendantSignIndex + 12) % 12) + 1;
  };

  const positions: ChartPosition[] = PLANET_META.map((meta) => {
    const bodyLongitude =
      meta.key === 'SUN' ? sunLongitude(jd) : meta.key === 'MOON' ? moonLongitude(jd) : planetLongitude(meta.key, jd);
    const retrograde = RETROGRADE_CANDIDATES.includes(meta.key) ? isRetrograde(meta.key, jd) : false;
    // 没有出生时间时，月亮日行 11.8–15.4°，按中午算可能偏出小半个星座 → 标为不可靠
    const uncertain = meta.key === 'MOON' && !hasBirthTime;

    return toPosition(meta, bodyLongitude, houseOf(bodyLongitude), retrograde, uncertain);
  });

  const ascendantPosition =
    ascendantDegree === null ? null : toPosition(ANGLE_META.ASCENDANT, ascendantDegree, 1, false, false);
  const midheavenPosition =
    midheavenDegree === null
      ? null
      : toPosition(ANGLE_META.MIDHEAVEN, midheavenDegree, houseOf(midheavenDegree), false, false);

  // 十二宫（整宫制：第 1 宫起点就是上升星座 0°）
  const houses: ChartHouse[] | null =
    ascendantDegree === null
      ? null
      : wholeSignCusps(ascendantDegree).map((cusp, index) => {
          const resolved = resolveSignPosition(cusp);

          return {
            index: index + 1,
            cusp: Math.round(cusp * 1000) / 1000,
            sign: resolved.sign,
            signName: resolved.signName,
            position: resolved.position,
          };
        });

  // 相位：十大行星 + 四轴（有出生时间时）全部两两配对
  const aspectInput: Record<string, number> = {};
  for (const position of positions) aspectInput[position.key] = position.longitude;
  if (ascendantPosition !== null) aspectInput.ASCENDANT = ascendantPosition.longitude;
  if (midheavenPosition !== null) aspectInput.MIDHEAVEN = midheavenPosition.longitude;

  const nameOf = (key: string): string => {
    if (key === 'ASCENDANT') return ANGLE_META.ASCENDANT.name;
    if (key === 'MIDHEAVEN') return ANGLE_META.MIDHEAVEN.name;

    return PLANET_META.find((meta) => meta.key === key)?.name ?? key;
  };

  const aspects: ChartAspect[] = findAspects(aspectInput).map((hit) => ({
    ...hit,
    fromName: nameOf(hit.from),
    toName: nameOf(hit.to),
    orbText: `${hit.name}（偏差 ${hit.orb.toFixed(2)}°）`,
  }));

  // 元素 / 宫位类型分布：按**十大行星**统计（不含四轴，避免上升点被重复计入）
  const planetSigns = positions.map((position) => position.sign);
  const elementKeys: readonly ZodiacElement[] = ['FIRE', 'EARTH', 'AIR', 'WATER'];
  const modeKeys: readonly ZodiacMode[] = ['CARDINAL', 'FIXED', 'MUTABLE'];

  const elementDistribution = buildDistribution(
    planetSigns,
    elementKeys,
    (sign) => ELEMENT_BY_SIGN[sign],
    ZODIAC_ELEMENT_LABELS,
  );
  const modeDistribution = buildDistribution(planetSigns, modeKeys, (sign) => MODE_BY_SIGN[sign], ZODIAC_MODE_LABELS);

  const topOf = <T extends string>(entries: readonly DistributionEntry<T>[]): DistributionEntry<T> | null => {
    if (entries.length === 0) return null;

    const sorted = [...entries].sort((left, right) => right.count - left.count);

    // 全为 0（理论上不会发生）时返回 null，避免给出误导性的"主导元素"
    return sorted[0].count === 0 ? null : sorted[0];
  };

  // 星群：同一星座 3 个及以上行星
  const stelliums = ZODIAC_SIGNS.map((sign) => ({
    sign,
    signName: SIGN_NAMES[sign],
    bodies: positions.filter((position) => position.sign === sign).map((position) => position.name),
  })).filter((entry) => entry.bodies.length >= 3);

  // 命主星：上升星座的守护星（缺出生时间时没有上升点 → 没有命主星）
  const ascendantSign = ascendantPosition?.sign ?? null;
  const rulerName = ascendantSign === null ? null : SIGN_RULERS[ascendantSign];
  const rulerPosition = rulerName === null ? null : (positions.find((position) => position.name === rulerName) ?? null);

  return {
    hasBirthTime,
    hasBirthPlace,
    moment: {
      localDateTime: moment.localDateTime,
      utcDateTime: moment.utcDateTime,
      timezoneOffset: moment.timezoneOffset,
      place: input.birthPlace ?? null,
      latitude,
      longitude,
      timezoneInferred: moment.timezoneInferred,
    },
    positions,
    angles: { ascendant: ascendantPosition, midheaven: midheavenPosition },
    houses,
    aspects,
    elementDistribution,
    modeDistribution,
    dominantElement: topOf(elementDistribution),
    dominantMode: topOf(modeDistribution),
    missingElements: elementDistribution.filter((entry) => entry.count === 0).map((entry) => entry.key),
    missingModes: modeDistribution.filter((entry) => entry.count === 0).map((entry) => entry.key),
    stelliums,
    chartRuler:
      rulerName === null || rulerPosition === null
        ? null
        : { planetName: rulerName, position: rulerPosition.position, signName: rulerPosition.signName },
    houseSystem: 'WHOLE_SIGN',
    precisionNote: CHART_PRECISION_NOTE,
    noTimeNotice: hasBirthTime ? null : CHART_NO_TIME_NOTICE,
    noPlaceNotice: hasBirthPlace ? null : CHART_NO_PLACE_NOTICE,
  };
};
