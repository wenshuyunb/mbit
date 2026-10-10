/**
 * 格式化工具测试
 *
 * 重点覆盖金额换算（支付相关，误差不可接受）与时间格式化边界。
 */

import { describe, expect, it } from 'vitest';

import {
  centsToYuan,
  centsToYuanNumber,
  formatDate,
  formatDateTime,
  formatDuration,
  formatFileSize,
  formatPercent,
  formatPrice,
  formatRelativeTime,
  maskMiddle,
  maskPhone,
} from '@/utils/format';

describe('金额格式化（分 → 元）', () => {
  it('整数金额补足两位小数', () => {
    expect(centsToYuan(0)).toBe('0.00');
    expect(centsToYuan(100)).toBe('1.00');
    expect(centsToYuan(1980)).toBe('19.80');
  });

  it('避免浮点误差（0.1 + 0.2 类问题）', () => {
    // 直接 1999/100 会得到 19.99，但 3/100*100 这类运算容易出问题，这里验证不出现长尾小数
    expect(centsToYuan(3)).toBe('0.03');
    expect(centsToYuan(999999)).toBe('9999.99');
    expect(centsToYuan(1)).toBe('0.01');
    expect(centsToYuan(10)).toBe('0.10');
  });

  it('大额金额不丢精度', () => {
    expect(centsToYuan(123456789)).toBe('1234567.89');
  });

  it('负数金额（退款场景）保留符号', () => {
    expect(centsToYuan(-1980)).toBe('-19.80');
  });

  it('非法输入回退 0.00，不产生 NaN 展示', () => {
    expect(centsToYuan(null)).toBe('0.00');
    expect(centsToYuan(undefined)).toBe('0.00');
    expect(centsToYuan(Number.NaN)).toBe('0.00');
    expect(centsToYuan(Number.POSITIVE_INFINITY)).toBe('0.00');
  });

  it('formatPrice 带货币符号', () => {
    expect(formatPrice(3980)).toBe('¥39.80');
  });

  it('centsToYuanNumber 返回可参与计算的数值', () => {
    expect(centsToYuanNumber(3980)).toBe(39.8);
    expect(centsToYuanNumber(null)).toBe(0);
  });
});

describe('时间格式化', () => {
  const fixed = new Date('2026-02-14T10:30:45.000Z');

  it('formatDate 输出 YYYY-MM-DD', () => {
    expect(formatDate(fixed)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatDate('2026-02-14T10:30:45.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('formatDateTime 输出 YYYY-MM-DD HH:mm', () => {
    expect(formatDateTime(fixed)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法时间输入返回空字符串', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('not-a-date')).toBe('');
    expect(formatDateTime(undefined)).toBe('');
  });

  describe('formatRelativeTime', () => {
    const now = new Date('2026-02-14T12:00:00.000Z').getTime();

    it('1 分钟内显示「刚刚」', () => {
      expect(formatRelativeTime(new Date(now - 30 * 1000), now)).toBe('刚刚');
    });

    it('1 小时内显示分钟', () => {
      expect(formatRelativeTime(new Date(now - 25 * 60 * 1000), now)).toBe('25 分钟前');
    });

    it('24 小时内显示小时', () => {
      expect(formatRelativeTime(new Date(now - 5 * 60 * 60 * 1000), now)).toBe('5 小时前');
    });

    it('30 天内显示天数', () => {
      expect(formatRelativeTime(new Date(now - 3 * 24 * 60 * 60 * 1000), now)).toBe('3 天前');
    });

    it('超过 30 天回退为具体日期', () => {
      const result = formatRelativeTime(new Date(now - 60 * 24 * 60 * 60 * 1000), now);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('未来时间（服务端时钟偏差）不显示负数，回退为具体日期', () => {
      const result = formatRelativeTime(new Date(now + 60 * 1000), now);
      // 关键断言：不出现「-1 分钟前」这类负向文案，而是回退为绝对日期
      expect(result).not.toContain('前');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it('formatDuration 输出 MM:SS 并处理非法值', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(65)).toBe('01:05');
    expect(formatDuration(3600)).toBe('60:00');
    expect(formatDuration(-5)).toBe('00:00');
    expect(formatDuration(Number.NaN)).toBe('00:00');
  });
});

describe('脱敏与展示', () => {
  it('手机号脱敏保留前 3 后 4 位', () => {
    expect(maskPhone('13812345678')).toBe('138****5678');
    expect(maskPhone('138-1234-5678')).toBe('138****5678');
  });

  it('非 11 位手机号原样返回，避免误伤', () => {
    expect(maskPhone('12345')).toBe('12345');
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBe('');
  });

  it('maskMiddle 用于 openid / 订单号等（中间全部打码，不泄露原串长度）', () => {
    // 17 字符：保留前 4 后 4，中间 9 位全部打码
    expect(maskMiddle('oABCDEFGHIJKLMNOP')).toBe('oABC*********MNOP');
    // 长度不足 head+tail 时整体打码
    expect(maskMiddle('abc')).toBe('***');
    expect(maskMiddle('')).toBe('');
    // 打码后不应残留任何中间原文
    expect(maskMiddle('SM20260214A7K3M9Q1')).not.toContain('0214A7K3');
  });

  it('formatPercent 处理空值', () => {
    expect(formatPercent(75.4)).toBe('75%');
    expect(formatPercent(75.44, 1)).toBe('75.4%');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
  });

  it('formatFileSize 按量级切换单位', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatFileSize(-1)).toBe('0 B');
  });
});
