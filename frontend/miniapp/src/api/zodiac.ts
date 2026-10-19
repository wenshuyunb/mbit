/**
 * 星座运势接口
 *
 * ## 与后端契约的对应（权威来源 `backend/src/modules/zodiac/`）
 *
 * | 前端类型               | 后端来源                          |
 * | ---------------------- | --------------------------------- |
 * | `ZodiacSign`           | `zodiac.types.ts` 的 `ZODIAC_SIGNS` |
 * | `ZodiacProfile`        | `ZodiacService.ZodiacProfileView`  |
 * | `DailyFortune`         | `zodiac-fortune.util.ts` 的 `DailyFortuneView` |
 * | `WeeklyFortune` / `MonthlyFortune` | 同上                  |
 * | `ZodiacMatch`          | `ZodiacMatchView`                  |
 *
 * ## 三条使用约定
 *
 *   ① **星座与测评完全隔离**：这个模块只读一个字段（账号里的出生日期），
 *      不产生任何画像，也不要把它的结果混进测评页面的文案里；
 *   ② **内容由服务端确定性生成**：同一天同一星座永远是同一份，前端**不做任何本地随机**
 *      （自己随机一下就会变成"刷新一次换一份"，那是内容事故）；
 *   ③ `disclaimer` **必须原样展示**、不得省略或改写（合规文案由服务端下发）。
 */

import { http } from './request';

/** 十二星座编码（与后端 `ZODIAC_SIGNS` 逐字一致） */
export type ZodiacSign =
  | 'ARIES'
  | 'TAURUS'
  | 'GEMINI'
  | 'CANCER'
  | 'LEO'
  | 'VIRGO'
  | 'LIBRA'
  | 'SCORPIO'
  | 'SAGITTARIUS'
  | 'CAPRICORN'
  | 'AQUARIUS'
  | 'PISCES';

/** 星座档案（文化常识，不含预测） */
export interface ZodiacProfile {
  sign: ZodiacSign;
  name: string;
  englishName: string;
  /** 日期区间（`MM-DD ~ MM-DD`） */
  dateRange: string;
  element: 'FIRE' | 'EARTH' | 'AIR' | 'WATER';
  elementLabel: string;
  elementDescription: string;
  ruler: string;
  traits: string[];
  personality: string;
  love: string;
  career: string;
  friendship: string;
  strengths: string[];
  watchouts: string[];
}

/** 我的星座 */
export interface ZodiacMe {
  sign: ZodiacSign;
  signName: string;
  /** `YYYY-MM-DD` */
  birthday: string;
}

/** 五维之一 */
export interface FortuneDimension {
  key: 'OVERALL' | 'LOVE' | 'CAREER' | 'WEALTH' | 'HEALTH';
  label: string;
  /** 1–5 星 */
  stars: number;
  line: string;
}

/** 今日运势 */
export interface DailyFortune {
  sign: ZodiacSign;
  signName: string;
  date: string;
  tone: string;
  dimensions: FortuneDimension[];
  lucky: {
    color: { name: string; hex: string };
    number: number;
    direction: string;
    hour: string;
  };
  match: {
    best: { sign: ZodiacSign; name: string };
    watch: { sign: ZodiacSign; name: string };
  };
  good: string[];
  avoid: string[];
  quote: string;
  /** 生日来源（`MM-DD`，不回显年份） */
  birthdaySource: string;
  /** 合规声明（**必须展示**） */
  disclaimer: string;
}

/** 周运 / 月运的一条 */
export interface FortuneSection {
  key: string;
  label: string;
  stars: number;
  line: string;
}

/** 周运 */
export interface WeeklyFortune {
  sign: ZodiacSign;
  signName: string;
  startDate: string;
  endDate: string;
  tip: string;
  sections: FortuneSection[];
}

/** 月运 */
export interface MonthlyFortune {
  sign: ZodiacSign;
  signName: string;
  month: string;
  theme: string;
  stars: number;
  sections: FortuneSection[];
}

/** 星座配对 */
export interface ZodiacMatch {
  a: { sign: ZodiacSign; name: string; element: string };
  b: { sign: ZodiacSign; name: string; element: string };
  score: number;
  level: 'LOW' | 'MID' | 'HIGH';
  levelLabel: string;
  elementNote: string;
  dimensions: FortuneSection[];
  advice: string;
  disclaimer: string;
}

// ============================================================================
// 本命星盘（ADR-040）
// ============================================================================

/** 出生城市（`GET /zodiac/cities`） */
export interface BirthCity {
  name: string;
  /** 所属地区：地级市给省份、县级给"省份 + 地级市"、海外给国家/地区 */
  region: string;
  latitude: number;
  longitude: number;
  /** 该地的**标准**时区偏移（小时）。中国夏令时由服务端按出生日期叠加，前端不要自己算 */
  timezoneOffset: number;
  /** 行政区层级；港澳台与海外为 null */
  level: 'PREFECTURE' | 'COUNTY' | null;
  /**
   * 该地可能存在的**另一种惯用时间**（小时）
   *
   * 目前只有新疆的 UTC+6：新疆部分地区习惯用「新疆时间」，比北京时间晚 2 小时 ——
   * 而上升星座约 2 小时换一个，差 2 小时会让它**整整错一个星座**。
   * 因此选到这类城市时必须问清楚，不能默认。
   */
  altTimezoneOffset: number | null;
  /** 拼音/英文别名 */
  aliases?: string[];
}

/** 星盘上一个天体（完整盘才有） */
export interface ChartPosition {
  key: string;
  name: string;
  symbol: string;
  longitude: number;
  sign: ZodiacSign;
  signName: string;
  degree: number;
  minute: number;
  /** 展示串，例如 `狮子座 22°09′` */
  position: string;
  /** 整宫制宫位（1–12）；缺出生时间或城市时为 null */
  house: number | null;
  retrograde: boolean;
  /** 位置是否不可靠（缺出生时间时的月亮） */
  uncertain: boolean;
}

/** 十二宫之一 */
export interface ChartHouse {
  index: number;
  cusp: number;
  sign: ZodiacSign;
  signName: string;
  position: string;
}

/** 一条相位 */
export interface ChartAspect {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  key: string;
  name: string;
  symbol: string;
  nature: 'HARMONIOUS' | 'TENSE' | 'NEUTRAL';
  separation: number;
  orb: number;
  orbText: string;
}

/** 元素 / 宫位类型分布的一项 */
export interface ChartDistributionEntry {
  key: string;
  label: string;
  description: string;
  count: number;
  percent: number;
  signs: ZodiacSign[];
}

/** 完整星盘（**会员**才有） */
export interface NatalChart {
  hasBirthTime: boolean;
  hasBirthPlace: boolean;
  moment: {
    localDateTime: string;
    utcDateTime: string;
    timezoneOffset: number;
    place: string | null;
    latitude: number | null;
    longitude: number | null;
    timezoneInferred: boolean;
  };
  positions: ChartPosition[];
  angles: {
    ascendant: ChartPosition | null;
    midheaven: ChartPosition | null;
  };
  houses: ChartHouse[] | null;
  aspects: ChartAspect[];
  elementDistribution: ChartDistributionEntry[];
  modeDistribution: ChartDistributionEntry[];
  dominantElement: ChartDistributionEntry | null;
  dominantMode: ChartDistributionEntry | null;
  missingElements: string[];
  missingModes: string[];
  stelliums: { sign: ZodiacSign; signName: string; bodies: string[] }[];
  chartRuler: { planetName: string; position: string; signName: string } | null;
  houseSystem: 'WHOLE_SIGN';
  precisionNote: string;
  noTimeNotice: string | null;
  noPlaceNotice: string | null;
}

/** 非会员能看到的预览（只有星座名，没有度数） */
export interface ChartPreviewBody {
  sign: ZodiacSign;
  signName: string;
  elementLabel: string;
  uncertain: boolean;
}

export interface ChartPreview {
  sun: ChartPreviewBody;
  moon: ChartPreviewBody;
  ascendant: ChartPreviewBody | null;
  hasBirthTime: boolean;
  hasBirthPlace: boolean;
}

/** 星盘响应 */
export interface ZodiacChart {
  /** 非会员才有；会员为 null */
  preview: ChartPreview | null;
  /** 会员才有；非会员为 null（**不是打码，是不返回**） */
  chart: NatalChart | null;
  access: {
    isMember: boolean;
    chartUnlocked: boolean;
    lockedSections: string[];
    membershipHint: string;
    expireAt: string | null;
  };
  birthInfo: {
    birthday: string;
    birthTime: string | null;
    birthPlace: string | null;
    birthLatitude: number | null;
    birthLongitude: number | null;
    placeResolvedFrom: 'USER_INPUT' | 'CITY_TABLE' | 'MISSING';
  };
  disclaimer: string;
}

/** 出生城市搜索（**公开接口**；关键词为空时返回热门城市） */
export const searchBirthCities = (keyword?: string): Promise<BirthCity[]> =>
  http.get<BirthCity[]>('/zodiac/cities', keyword === undefined || keyword.length === 0 ? undefined : { keyword }, {
    needAuth: false,
    showError: false,
  });

// ----------------------------------------------------------------------------
// 三级联动（省 / 市 / 县）—— 给多列转盘用
// ----------------------------------------------------------------------------

/** 一个地级市节点 */
export interface RegionCity {
  name: string;
  /** 第三列的可选项；没有区县的地级市只有一个 `全市` */
  counties: string[];
}

/** 一个省级节点 */
export interface RegionProvince {
  name: string;
  cities: RegionCity[];
}

/** 「省 → 市 → 县」名称树（不含经纬度，选定后再换具体城市） */
export interface RegionTree {
  provinces: RegionProvince[];
}

/**
 * 无区县的地级市在第三列的占位值
 *
 * 东莞、中山、嘉峪关这类"直筒子市"本来就没有区县一级；转盘三列固定，
 * 第三列不能空 —— 用这个值占位，选中即用地级市坐标。
 */
export const WHOLE_CITY_OPTION = '全市';

/** 三级联动数据（**公开接口**；体积约 30 KB，页面拉一次缓存在内存里即可） */
export const getRegionTree = (): Promise<RegionTree> =>
  http.get<RegionTree>('/zodiac/regions', undefined, { needAuth: false, showError: false });

/**
 * 按「省 / 市 / 县」取具体城市（含经纬度与时区）
 *
 * ⚠ 路径不合法时后端返回 400（`10001`）且**不会回退到默认城市** ——
 * 前端据此提示"请重新选择"，绝不能拿一个别的地方去算盘。
 */
export const resolveRegion = (province: string, city: string, county: string): Promise<BirthCity> =>
  http.get<BirthCity>('/zodiac/regions/resolve', { province, city, county }, { needAuth: false, showError: false });

/**
 * 本命星盘
 *
 * ⚠ `showError: false`：没设生日时后端返回 `400 / 30019`，那是本模块的**正常流程**
 * （页面据此展示"先选出生日期"的引导），不能让用户先看到一个红色报错。
 */
export const getNatalChart = (): Promise<ZodiacChart> =>
  http.get<ZodiacChart>('/zodiac/chart', undefined, { showError: false });

/** 十二星座档案（**公开接口**：后端已标 `@Public()`，前端也不需要带令牌） */
export const listZodiacProfiles = (): Promise<ZodiacProfile[]> =>
  http.get<ZodiacProfile[]>('/zodiac/signs', undefined, { needAuth: false, showError: false });

/** 我的星座（未设置生日时后端返回 `30019`） */
export const getMyZodiac = (): Promise<ZodiacMe> => http.get<ZodiacMe>('/zodiac/me', undefined, { showError: false });

/**
 * 今日运势
 *
 * ⚠ `showError: false`：**没设生日**时后端返回 `400 / 30019`，而那是本模块的
 * **正常流程**（页面据此展示"先选出生日期"的卡片）。不关掉统一提示的话，
 * 用户一进页面就先看到一个红色报错，然后才看到引导卡 —— 顺序反了。
 */
export const getDailyFortune = (date: string, birthday?: string): Promise<DailyFortune> =>
  http.get<DailyFortune>('/zodiac/daily', birthday === undefined ? { date } : { date, birthday }, { showError: false });

/** 本周运势 */
export const getWeeklyFortune = (date: string): Promise<WeeklyFortune> =>
  http.get<WeeklyFortune>('/zodiac/weekly', { date }, { showError: false });

/** 本月运势 */
export const getMonthlyFortune = (date: string): Promise<MonthlyFortune> =>
  http.get<MonthlyFortune>('/zodiac/monthly', { date }, { showError: false });

/** 星座配对（**公开接口**，顺序无关） */
export const getZodiacMatch = (a: ZodiacSign, b: ZodiacSign): Promise<ZodiacMatch> =>
  http.get<ZodiacMatch>('/zodiac/match', { a, b }, { needAuth: false });
