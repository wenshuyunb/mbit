/**
 * 生日 → 星座的判定测试
 *
 * ## 为什么这批用例要穷举一整年
 *
 * 判定逻辑只有十几行，但它是整个模块的入口：**判错一天，用户看到的就是另一个星座的
 * 全部内容**，而且内容读起来都"挺像"，用户很可能不会发现。
 *
 * 12 个区间的边界日每年重复出现（3-20/3-21、4-19/4-20…），最容易写错的就是它们，
 * 因此这里穷举 1–12 月 × 1–31 日的**全部 366 个合法组合**并与一张独立写出的期望表比对 ——
 * 期望表是"手写的区间清单"，与实现里的"起始日二分"是两套写法，
 * 两者一致才算真的对。
 */

import { resolveZodiacSign, resolveZodiacSignFromDate } from './zodiac-sign.util';
import { ZODIAC_SIGNS, type ZodiacSign } from './zodiac.types';

/** 独立写出的区间表（与实现用不同的写法，互为校验） */
const EXPECTED_RANGES: ReadonlyArray<{ sign: ZodiacSign; from: [number, number]; to: [number, number] }> = [
  { sign: 'CAPRICORN', from: [12, 22], to: [12, 31] },
  { sign: 'CAPRICORN', from: [1, 1], to: [1, 19] },
  { sign: 'AQUARIUS', from: [1, 20], to: [2, 18] },
  { sign: 'PISCES', from: [2, 19], to: [3, 20] },
  { sign: 'ARIES', from: [3, 21], to: [4, 19] },
  { sign: 'TAURUS', from: [4, 20], to: [5, 20] },
  { sign: 'GEMINI', from: [5, 21], to: [6, 21] },
  { sign: 'CANCER', from: [6, 22], to: [7, 22] },
  { sign: 'LEO', from: [7, 23], to: [8, 22] },
  { sign: 'VIRGO', from: [8, 23], to: [9, 22] },
  { sign: 'LIBRA', from: [9, 23], to: [10, 23] },
  { sign: 'SCORPIO', from: [10, 24], to: [11, 22] },
  { sign: 'SAGITTARIUS', from: [11, 23], to: [12, 21] },
];

/** 该月有多少天（星座判定只关心 1–31 的合法性，2 月按 29 天算） */
const daysInMonth = (month: number): number => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;

const expectedSignOf = (month: number, day: number): ZodiacSign => {
  for (const range of EXPECTED_RANGES) {
    const [fm, fd] = range.from;
    const [tm, td] = range.to;

    const afterFrom = month > fm || (month === fm && day >= fd);
    const beforeTo = month < tm || (month === tm && day <= td);

    if (afterFrom && beforeTo) return range.sign;
  }

  throw new Error(`期望表没覆盖 ${month}-${day}`);
};

describe('resolveZodiacSign（生日 → 星座）', () => {
  it('【关键】一年里的每一天都能判定，且与独立期望表逐日一致', () => {
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= daysInMonth(month); day += 1) {
        expect(resolveZodiacSign(month, day)).toBe(expectedSignOf(month, day));
      }
    }
  });

  it('十二个星座都会被取到（没有写漏的区间）', () => {
    const seen = new Set<ZodiacSign>();

    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= daysInMonth(month); day += 1) {
        seen.add(resolveZodiacSign(month, day));
      }
    }

    expect([...seen].sort()).toEqual([...ZODIAC_SIGNS].sort());
  });

  it.each<[string, number, number, ZodiacSign]>([
    ['摩羯/水瓶 交界', 1, 19, 'CAPRICORN'],
    ['摩羯/水瓶 交界', 1, 20, 'AQUARIUS'],
    ['双鱼/白羊 交界', 3, 20, 'PISCES'],
    ['双鱼/白羊 交界', 3, 21, 'ARIES'],
    ['金牛/双子 交界', 5, 20, 'TAURUS'],
    ['金牛/双子 交界', 5, 21, 'GEMINI'],
    ['狮子/处女 交界', 8, 22, 'LEO'],
    ['狮子/处女 交界', 8, 23, 'VIRGO'],
    ['射手/摩羯 交界（跨年）', 12, 21, 'SAGITTARIUS'],
    ['射手/摩羯 交界（跨年）', 12, 22, 'CAPRICORN'],
  ])('%s：%i-%i → %s', (_label, month, day, expected) => {
    expect(resolveZodiacSign(month, day)).toBe(expected);
  });

  it.each<[string, number, number]>([
    ['月份为 0', 0, 15],
    ['月份为 13', 13, 15],
    ['日期为 0', 5, 0],
    ['日期为 32', 5, 32],
    ['月份非整数', 1.5, 15],
  ])('非法输入抛错（%s）—— 宁可在入口失败，也不悄悄返回一个星座', (_label, month, day) => {
    expect(() => resolveZodiacSign(month, day)).toThrow(RangeError);
  });
});

describe('resolveZodiacSignFromDate（解析 YYYY-MM-DD）', () => {
  it('正常日期按**月日**判定，年份不影响结果', () => {
    expect(resolveZodiacSignFromDate('1996-03-08')).toBe('PISCES');
    expect(resolveZodiacSignFromDate('2010-03-08')).toBe('PISCES');
    expect(resolveZodiacSignFromDate('2026-03-08')).toBe('PISCES');
  });

  it.each<[string, string]>([
    ['缺位', '1996-3-8'],
    ['多余字符', '1996-03-08T00:00:00Z'],
    ['中文', '一九九六年三月八日'],
    ['空串', ''],
    ['月份越界', '1996-13-01'],
    ['日期越界', '1996-01-32'],
  ])('非法格式返回 null（%s）', (_label, value) => {
    expect(resolveZodiacSignFromDate(value)).toBeNull();
  });

  it('首尾空格被容忍（前端拼接时常见）', () => {
    expect(resolveZodiacSignFromDate('  1996-03-08  ')).toBe('PISCES');
  });
});
