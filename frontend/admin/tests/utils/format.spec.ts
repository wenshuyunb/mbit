/**
 * 展示层格式化单元测试
 *
 * 覆盖重点（真实业务风险点）：
 *   - 金额分 → 元的边界：0、最小单位、进位、大额（禁止浮点误差）、负数（退款）
 *   - 非法金额输入必须走占位符，不能展示错误数字
 *   - 手机号 / openid 脱敏：标准格式、带 +86 前缀、非标准格式、空值
 *   - 日期格式化的月末/年末/闰年边界与无效输入
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_PLACEHOLDER,
  formatAmount,
  formatAmountWithSymbol,
  formatDate,
  formatDateOnly,
  maskOpenid,
  maskPhone,
} from '@/utils/format';

describe('utils/format —— 金额（分 → 元）', () => {
  it('0 分与最小单位正确转换', () => {
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(1)).toBe('0.01');
    expect(formatAmount(5)).toBe('0.05');
  });

  it('进位边界正确（99 分 / 100 分 / 1990 分）', () => {
    expect(formatAmount(99)).toBe('0.99');
    expect(formatAmount(100)).toBe('1.00');
    expect(formatAmount(1990)).toBe('19.90');
    expect(formatAmount(10000)).toBe('100.00');
  });

  it('大额金额不出现浮点精度误差（字符串切分实现）', () => {
    expect(formatAmount(123456789012)).toBe('1234567890.12');
    expect(formatAmount(9007199254740)).toBe('90071992547.40');
  });

  it('负数金额保留符号（退款/对账场景）', () => {
    expect(formatAmount(-50)).toBe('-0.50');
    expect(formatAmount(-1990)).toBe('-19.90');
  });

  it('非法金额返回占位符，而不是错误数字或抛异常', () => {
    expect(formatAmount(null)).toBe(EMPTY_PLACEHOLDER);
    expect(formatAmount(undefined)).toBe(EMPTY_PLACEHOLDER);
    expect(formatAmount(Number.NaN)).toBe(EMPTY_PLACEHOLDER);
    expect(formatAmount(Number.POSITIVE_INFINITY)).toBe(EMPTY_PLACEHOLDER);
    // 小数分违反「金额必须是整数分」的契约（架构 §8.3 P8），按非法输入处理
    expect(formatAmount(19.9)).toBe(EMPTY_PLACEHOLDER);
  });

  it('带货币符号展示；占位符不加符号', () => {
    expect(formatAmountWithSymbol(1990)).toBe('¥19.90');
    expect(formatAmountWithSymbol(0)).toBe('¥0.00');
    expect(formatAmountWithSymbol(null)).toBe(EMPTY_PLACEHOLDER);
  });
});

describe('utils/format —— 手机号 / openid 脱敏', () => {
  it('标准 11 位手机号保留前 3 后 4，并容忍两端空白与 +86 前缀', () => {
    expect(maskPhone('13812345678')).toBe('138****5678');
    expect(maskPhone('  13812345678  ')).toBe('138****5678');
    expect(maskPhone('+8613812345678')).toBe('+86138****5678');
    expect(maskPhone('8613812345678')).toBe('86138****5678');
  });

  it('空值返回空字符串（不产生误导性的星号串）', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone('   ')).toBe('');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
  });

  it('非标准格式只保留末 4 位，避免泄露完整号码', () => {
    expect(maskPhone('123456')).toBe('**3456');
    expect(maskPhone('12345')).toBe('*2345');
    expect(maskPhone('123')).toBe('***');
  });

  it('openid 脱敏：长度 > 10 保留前 6 后 4，短标识整体覆盖', () => {
    expect(maskOpenid('oX9aBcDeFgHiJkLmNoPqRs')).toBe('oX9aBc****PqRs');
    expect(maskOpenid('oX9aBcDeFgH')).toBe('oX9aBc****eFgH');
    expect(maskOpenid('short')).toBe('*****');
    expect(maskOpenid('')).toBe('');
    expect(maskOpenid(null)).toBe('');
  });

  it('脱敏结果不包含标识中段（防止通过长度与片段推断）', () => {
    const openid = 'oX9aBcDeFgHiJkLmNoPqRs';
    const masked = maskOpenid(openid);
    expect(masked).not.toContain('DeFgHiJkLm');
    expect(masked.startsWith('oX9aBc')).toBe(true);
  });
});

describe('utils/format —— 日期', () => {
  it('默认格式为 YYYY-MM-DD HH:mm:ss（本地时区）', () => {
    expect(formatDate(new Date(2026, 1, 14, 10, 0, 0))).toBe('2026-02-14 10:00:00');
    expect(formatDate('2026-02-14 10:00:00')).toBe('2026-02-14 10:00:00');
  });

  it('月末 / 年末 / 闰年边界不越界', () => {
    expect(formatDate(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31 23:59:59');
    expect(formatDate(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01 00:00:00');
    expect(formatDate(new Date(2028, 1, 29, 12, 30, 0), 'YYYY-MM-DD')).toBe('2028-02-29');
  });

  it('支持自定义格式与仅日期展示', () => {
    expect(formatDateOnly(new Date(2026, 1, 14, 10, 0, 0))).toBe('2026-02-14');
    expect(formatDate(new Date(2026, 1, 14, 10, 0, 0), 'YYYY/MM/DD HH:mm')).toBe('2026/02/14 10:00');
  });

  it('无效输入返回空字符串（占位展示由页面决定）', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('not-a-date')).toBe('');
    expect(formatDate(Number.NaN)).toBe('');
    expect(formatDateOnly(null)).toBe('');
  });
});
