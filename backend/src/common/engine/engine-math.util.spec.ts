/**
 * 引擎数学辅助函数测试
 *
 * 这些函数是算法正确性的地基，边界行为必须逐一锁定 —— 尤其是「退化输入不能产生 NaN」，
 * 因为 NaN 一旦进入画像分数会静默污染落库数据与前端展示。
 */

import { clamp, mean, normalizeToUnit, roundTo } from './engine-math.util';

describe('clamp', () => {
  it('区间内的值原样返回', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('越界时截断到边界', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
    expect(clamp(200, 0, 100)).toBe(100);
  });

  it('恰好等于边界时保持不变（闭区间语义）', () => {
    expect(clamp(0, 0, 100)).toBe(0);
    expect(clamp(100, 0, 100)).toBe(100);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '非有限数 %s → 返回下界（保守，不制造最高分）',
    (value) => {
      expect(clamp(value, 10, 100)).toBe(10);
    },
  );
});

describe('normalizeToUnit', () => {
  it('线性映射到 0–1', () => {
    expect(normalizeToUnit(1, 1, 5)).toBe(0);
    expect(normalizeToUnit(3, 1, 5)).toBe(0.5);
    expect(normalizeToUnit(5, 1, 5)).toBe(1);
  });

  it('超出范围的值被截断到 0–1（不产生越界归一化）', () => {
    expect(normalizeToUnit(99, 1, 5)).toBe(1);
    expect(normalizeToUnit(-99, 1, 5)).toBe(0);
  });

  it('【关键】范围为 0（min === max）时返回 0，而不是除零得到 NaN', () => {
    const result = normalizeToUnit(5, 5, 5);

    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('【关键】范围为负（max < min）时返回 0', () => {
    expect(normalizeToUnit(5, 10, 1)).toBe(0);
  });
});

describe('mean', () => {
  it('计算算术平均', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([0.5, 1])).toBe(0.75);
  });

  it('单个元素返回其自身', () => {
    expect(mean([42])).toBe(42);
  });

  it('【关键】空数组返回 0，而不是 NaN', () => {
    const result = mean([]);

    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('接受只读数组（便于传入冻结的数据）', () => {
    const frozen = Object.freeze([2, 4, 6]);
    expect(mean(frozen)).toBe(4);
  });
});

describe('roundTo', () => {
  it('默认保留 2 位小数', () => {
    expect(roundTo(83.333333333)).toBe(83.33);
    expect(roundTo(66.666666666)).toBe(66.67);
  });

  it('【已知限制】十进制中点值受二进制浮点表示影响', () => {
    // 1.005 在 IEEE 754 下实际存储为 1.00499999…，因此 ×100 后是 100.4999… → 进位到 100。
    // 这不是本函数的缺陷，而是二进制浮点的固有行为（`(1.005).toFixed(2)` 同样得到 "1.00"）。
    // 引擎的分数来自「比率 × 100」，不会产生这类恰好落在中点的十进制值，
    // 因此采用 Math.round 的简单实现即可；若未来需要十进制精确舍入，应改用 Decimal 库。
    expect(roundTo(1.005)).toBe(1);
    expect(roundTo(1.015)).toBe(1.01);
  });

  it('二进制可精确表示的中点值按「四舍五入」向上进位', () => {
    // 0.125 在二进制下精确可表示 → ×100 = 12.5 → Math.round 进位到 13
    expect(roundTo(0.125, 2)).toBe(0.13);
    expect(roundTo(2.5, 0)).toBe(3);
  });

  it('可指定小数位', () => {
    expect(roundTo(1.23456, 0)).toBe(1);
    expect(roundTo(1.23456, 4)).toBe(1.2346);
  });

  it('整数与负数的处理', () => {
    expect(roundTo(100)).toBe(100);
    expect(roundTo(-1.235, 2)).toBe(-1.24);
  });

  it('消除浮点长尾（落库前统一格式）', () => {
    // 0.1 + 0.2 = 0.30000000000000004
    expect(roundTo(0.1 + 0.2)).toBe(0.3);
  });
});
