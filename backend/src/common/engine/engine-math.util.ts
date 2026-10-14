/**
 * 引擎数学辅助函数
 *
 * 抽为独立模块的原因（而不作为 PersonalityEngine 的私有方法）：
 *   1. **可独立单测**：这些函数的边界行为（空数组、非法范围、非有限数）是算法正确性的地基，
 *      隐藏在私有方法里只能靠「构造出触发它的业务数据」间接覆盖，往往覆盖不全
 *   2. **可复用**：Phase 4 的 CompatibilityEngine（匹配算分）是同类纯函数，将直接复用这些工具
 *   3. **契约清晰**：每个函数都显式声明前置条件与退化行为，避免调用方误用
 */

/**
 * 把数值限制在 [min, max] 区间内
 *
 * 退化行为：`value` 非有限数（NaN / Infinity）时返回 `min`。
 * 选择 `min` 而非 `max` 的理由：算法中「非有限」几乎总是来自数据缺失或配置错误，
 * 返回下界比返回上界更保守（不会把一个坏数据变成最高分）。
 */
export const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

/**
 * 归一化到 0–1
 *
 * 退化行为：范围为 0 或负数（`max <= min`）时返回 0 —— 此时该区间不携带任何信息，
 * 返回 0 表示「无区分度」，而不是除零得到 NaN/Infinity 污染后续计算。
 */
export const normalizeToUnit = (value: number, min: number, max: number): number => {
  const range = max - min;
  if (range <= 0) return 0;
  return clamp((value - min) / range, 0, 1);
};

/**
 * 算术平均
 *
 * 退化行为：空数组返回 0（`Array.prototype.reduce` 在空数组上无初值会抛错，
 * 带初值则返回 0，直接除以 0 会得到 NaN，因此必须显式处理）。
 */
export const mean = (values: readonly number[]): number => {
  if (values.length === 0) return 0;

  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
};

/**
 * 四舍五入到指定小数位
 *
 * 用途：避免浮点长尾（如 71.00000000000001）落库后造成比对困难与展示异常。
 */
export const roundTo = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
