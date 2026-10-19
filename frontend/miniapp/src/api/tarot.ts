/**
 * 塔罗牌接口
 *
 * ## 使用约定
 *
 *   ① **今日牌是确定性的**：同一天同一用户永远同一张，因此前端**不要**做任何
 *      "再抽一次"的本地逻辑 —— 那会变成"刷新就换一张"，与"今日之牌"的语义矛盾；
 *   ② `disclaimer` 必须原样展示（合规文案由服务端下发）；
 *   ③ 逆位不等于坏牌（受阻 / 内化 / 过量），前端**不要**用红色等"警示色"渲染逆位。
 */

import { http } from './request';

/** 牌的朝向 */
export type TarotOrientation = 'UPRIGHT' | 'REVERSED';

/** 一张塔罗牌 */
export interface TarotCard {
  id: string;
  arcana: 'MAJOR' | 'MINOR';
  /** 大阿卡纳的罗马数字；小阿卡纳为 null */
  numeral: string | null;
  suit: 'WANDS' | 'CUPS' | 'SWORDS' | 'PENTACLES' | null;
  rank: string | null;
  name: string;
  /** 牌面符号（字符，前端直接渲染） */
  symbol: string;
  keywords: string[];
  upright: string;
  reversed: string;
}

/** 今日抽卡结果 */
export interface TarotDailyDraw {
  card: TarotCard;
  orientation: TarotOrientation;
  orientationLabel: string;
  date: string;
  /** 当日提示 */
  advice: string;
  /** 合规声明（**必须展示**） */
  disclaimer: string;
}

/** 今日抽卡（`showError: false`：失败时页面自己处理，不弹统一错误） */
export const getDailyTarot = (date: string): Promise<TarotDailyDraw> =>
  http.get<TarotDailyDraw>('/tarot/daily', { date }, { showError: false });

/** 78 张牌（公开接口，牌义速查） */
export const listTarotDeck = (): Promise<TarotCard[]> =>
  http.get<TarotCard[]>('/tarot/deck', undefined, { needAuth: false, showError: false });
