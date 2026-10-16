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
