/**
 * 生日 → 星座（纯函数）
 *
 * ## 为什么单独成文件并且值得写一堆测试
 *
 * 这段逻辑只有十几行，但它是**整个模块的入口**：判错一天，用户看到的就是
 * 另一个星座的全部内容（而且他很可能不会发现，因为内容读起来都"挺像"）。
 * 边界日期（每月 19–23 号前后）是星座判定唯一容易出错的地方，且每年重复 12 次。
 *
 * ## 判定口径
 *
 * 采用**国际通用的固定日期区间**（不是天文黄道精确日期）：
 *   · 市面所有星座 App 都用这套固定区间，用户对"我是几号到几号"的认知与它一致；
 *   · 天文黄道日期每年会漂 ±1 天，用它反而会让用户觉得"算错了"。
 *
 * 区间口径（含首尾）：
 *   白羊 03-21 ~ 04-19   金牛 04-20 ~ 05-20   双子 05-21 ~ 06-21
 *   巨蟹 06-22 ~ 07-22   狮子 07-23 ~ 08-22   处女 08-23 ~ 09-22
 *   天秤 09-23 ~ 10-23   天蝎 10-24 ~ 11-22   射手 11-23 ~ 12-21
 *   摩羯 12-22 ~ 01-19   水瓶 01-20 ~ 02-18   双鱼 02-19 ~ 03-20
 */

import { ZODIAC_SIGNS, type ZodiacSign } from './zodiac.types';

/**
 * 每个星座的**起始日**（月, 日）
 *
 * ⚠ 用"起始日表 + 二分"而不是把 12 个 if 写死：区间是**跨年闭环**
 *（摩羯从 12-22 到次年 01-19），写成 if 链时最容易在 12 月底与 1 月初出错。
 * 起始日表按**日期序**排列后，判定就退化成"找最后一个不晚于今天的起始日"。
 */
const SIGN_STARTS: ReadonlyArray<{ readonly sign: ZodiacSign; readonly month: number; readonly day: number }> = [
  { sign: 'CAPRICORN', month: 1, day: 1 }, // 占位：01-01 ~ 01-19 属摩羯，故摩羯从元旦起算
  { sign: 'AQUARIUS', month: 1, day: 20 },
  { sign: 'PISCES', month: 2, day: 19 },
  { sign: 'ARIES', month: 3, day: 21 },
  { sign: 'TAURUS', month: 4, day: 20 },
  { sign: 'GEMINI', month: 5, day: 21 },
  { sign: 'CANCER', month: 6, day: 22 },
  { sign: 'LEO', month: 7, day: 23 },
  { sign: 'VIRGO', month: 8, day: 23 },
  { sign: 'LIBRA', month: 9, day: 23 },
  { sign: 'SCORPIO', month: 10, day: 24 },
  { sign: 'SAGITTARIUS', month: 11, day: 23 },
  { sign: 'CAPRICORN', month: 12, day: 22 },
];

/** 一年中的第几天（1–366） */
const dayOfYear = (month: number, day: number): number => {
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

  return (cumulative[month - 1] ?? 0) + day;
};

/**
 * 按**月日**判定星座
 *
 * @param month 1–12
 * @param day   1–31
 * @throws 月/日超出范围时抛错 —— 生日是用户输入，非法值必须在入口处挡住，
 *         而不是悄悄返回一个星座（那会让用户以为系统认错了他的生日）
 */
export const resolveZodiacSign = (month: number, day: number): ZodiacSign => {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`月份必须在 1–12 之间，收到 ${month}`);
  }

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new RangeError(`日期必须在 1–31 之间，收到 ${day}`);
  }

  const target = dayOfYear(month, day);
  let resolved: ZodiacSign = SIGN_STARTS[0].sign;

  for (const start of SIGN_STARTS) {
    if (dayOfYear(start.month, start.day) <= target) {
      resolved = start.sign;
    }
  }

  return resolved;
};

/**
 * 从 `YYYY-MM-DD` 解析星座
 *
 * 只取**月与日**：年份对太阳星座没有影响（这是用户最容易误解的一点，
 * 因此也在接口文档里写明）。格式非法返回 `null`，由调用方决定报什么错。
 */
export const resolveZodiacSignFromDate = (date: string): ZodiacSign | null => {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (matched === null) return null;

  const month = Number(matched[2]);
  const day = Number(matched[3]);

  try {
    return resolveZodiacSign(month, day);
  } catch {
    return null;
  }
};

/** 全部十二星座（顺序固定，用于展示与遍历） */
export const ALL_ZODIAC_SIGNS: readonly ZodiacSign[] = ZODIAC_SIGNS;

/** 判定星座时用的固定日期区间文案（与判定口径同源，避免两处不一致） */
export const SIGN_DATE_RANGES: Readonly<Record<ZodiacSign, string>> = {
  ARIES: '03-21 ~ 04-19',
  TAURUS: '04-20 ~ 05-20',
  GEMINI: '05-21 ~ 06-21',
  CANCER: '06-22 ~ 07-22',
  LEO: '07-23 ~ 08-22',
  VIRGO: '08-23 ~ 09-22',
  LIBRA: '09-23 ~ 10-23',
  SCORPIO: '10-24 ~ 11-22',
  SAGITTARIUS: '11-23 ~ 12-21',
  CAPRICORN: '12-22 ~ 01-19',
  AQUARIUS: '01-20 ~ 02-18',
  PISCES: '02-19 ~ 03-20',
};
