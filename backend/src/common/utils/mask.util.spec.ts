/**
 * 脱敏与年龄区间工具测试
 *
 * 这些函数是「隐私最小化」的最后一道闸门（架构 §1.2 / §14.2），
 * 因此测试重点在于「异常输入不会导致明文泄露」以及年龄计算的边界正确性。
 */

import { calculateAge, maskMiddle, maskPhone, toAgeRange } from './mask.util';

describe('maskPhone', () => {
  it('标准 11 位手机号保留前 3 后 4', () => {
    expect(maskPhone('13812345678')).toBe('138****5678');
  });

  it('剥离中国区号前缀，与不带区号的结果一致', () => {
    expect(maskPhone('+86 138 1234 5678')).toBe('138****5678');
    expect(maskPhone('8613812345678')).toBe('138****5678');
    expect(maskPhone('008613812345678')).toBe('138****5678');
  });

  it('非 11 位输入退化为「首 2 后 2」，不原样返回', () => {
    const masked = maskPhone('1234567890123');

    expect(masked).not.toBe('1234567890123');
    expect(masked).toContain('*');
    expect(masked?.startsWith('12')).toBe(true);
    // 末两位是原串的最后两位（该串以 …23 结尾）
    expect(masked?.endsWith('23')).toBe(true);
  });

  it('极短输入整体打码', () => {
    expect(maskPhone('12')).toBe('**');
    expect(maskPhone('1234')).toBe('****');
  });

  it.each([null, undefined, ''])('空值返回 null：%s', (input) => {
    expect(maskPhone(input)).toBeNull();
  });

  it('纯非数字输入不抛出异常且不返回原文', () => {
    const masked = maskPhone('abcdefgh');

    expect(masked).not.toBeNull();
    expect(masked).not.toContain('abcdefgh');
  });
});

describe('maskMiddle', () => {
  it('保留首尾指定长度，中间全部打码', () => {
    expect(maskMiddle('oABCDEFGHIJKLMNOP')).toBe('oABC*********MNOP');
  });

  it('长度不足时整体打码（不泄露任何字符）', () => {
    expect(maskMiddle('abcde')).toBe('*****');
    expect(maskMiddle('abc', 4, 4)).toBe('***');
  });

  it('可自定义首尾保留长度', () => {
    // 18 字符：保留前 6 后 4，中间 8 位打码
    expect(maskMiddle('SM20260214A7K3M9Q1', 6, 4)).toBe('SM2026********M9Q1');
  });

  it('去除分隔符后仍按 11 位规则脱敏', () => {
    expect(maskPhone('138-1234-5678')).toBe('138****5678');
    expect(maskPhone('138 1234 5678')).toBe('138****5678');
  });

  it.each([null, undefined, ''])('空值返回 null：%s', (input) => {
    expect(maskMiddle(input)).toBeNull();
  });
});

describe('calculateAge', () => {
  const now = new Date('2026-02-14T12:00:00.000Z');

  it('生日已过 → 完整周岁', () => {
    // 1996-08-21 → 2026-02-14 时 2025-08-21 已过，故 29 岁
    expect(calculateAge(new Date('1996-08-21T00:00:00.000Z'), now)).toBe(29);
  });

  it('今年生日未到 → 年龄减 1', () => {
    // 生日 08-21，当前 02-14，今年生日未到 → 29 岁（而非 30）
    expect(calculateAge(new Date('1997-08-21T00:00:00.000Z'), now)).toBe(28);
  });

  it('生日当天算作已过生日（不少算一岁）', () => {
    expect(calculateAge(new Date('1996-02-14T00:00:00.000Z'), now)).toBe(30);
  });

  it('闰年 2 月 29 日出生：非闰年 2 月 28 日尚未过生日', () => {
    // 2000-02-29 出生，2026-02-14 时生日（2/29）未到 → 25 岁
    expect(calculateAge(new Date('2000-02-29T00:00:00.000Z'), now)).toBe(25);
  });

  it('闰年 2 月 29 日出生：闰年 2 月 29 日算作已过生日', () => {
    const leapDay = new Date('2028-02-29T12:00:00.000Z');
    expect(calculateAge(new Date('2000-02-29T00:00:00.000Z'), leapDay)).toBe(28);
  });

  it('非法日期返回 null', () => {
    expect(calculateAge(new Date('invalid'))).toBeNull();
  });
});

describe('toAgeRange', () => {
  const now = new Date('2026-02-14T12:00:00.000Z');

  it('按 5 岁一档返回区间（不返回精确年龄）', () => {
    // 29 岁 → 25-29
    expect(toAgeRange(new Date('1996-08-21T00:00:00.000Z'), now)).toBe('25-29');
  });

  it('区间边界正确：整 5 岁落在区间下界', () => {
    // 恰好 30 岁 → 30-34
    expect(toAgeRange(new Date('1996-02-14T00:00:00.000Z'), now)).toBe('30-34');
  });

  it('结果不含精确年龄（防止再识别）', () => {
    const range = toAgeRange(new Date('1996-08-21T00:00:00.000Z'), now);

    expect(range).toMatch(/^\d+-\d+$/);
    expect(range).not.toBe('29');
  });

  it('接受 ISO 日期字符串', () => {
    expect(toAgeRange('1996-08-21T00:00:00.000Z', now)).toBe('25-29');
  });

  it.each([null, undefined, ''])('空值返回 null：%s', (input) => {
    expect(toAgeRange(input, now)).toBeNull();
  });

  it('非法日期返回 null', () => {
    expect(toAgeRange('not-a-date', now)).toBeNull();
  });

  it('未来出生日期（数据异常）返回 null 而非负数区间', () => {
    expect(toAgeRange(new Date('2030-01-01T00:00:00.000Z'), now)).toBeNull();
  });

  it('超过 120 岁（数据异常）返回 null', () => {
    expect(toAgeRange(new Date('1850-01-01T00:00:00.000Z'), now)).toBeNull();
  });
});
