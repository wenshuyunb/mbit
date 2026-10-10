/**
 * Prompt 版本选择（纯函数，可 100% 单测）
 *
 * ADR-014 要求 Prompt「支持不重启热更与 AB 测试」，本模块承担 AB 的那一半：
 * 同一个模板可同时存在多个 `ACTIVE` 版本，按 `trafficWeight` 分配流量。
 *
 * 为什么把随机源做成参数（`random: () => number`）：加权随机会让测试变成
 * 「跑很多次看比例」这类不稳定断言。注入随机源后可以用 `() => 0`、`() => 0.99`
 * 精确锁定边界，这一点与算分引擎的选项乱序（ADR-021 相关实现）同一做法。
 */

/** 参与加权选择的最小版本信息 */
export interface WeightedVersion {
  readonly id: string;
  readonly version: number;
  readonly trafficWeight: number;
}

/**
 * 按权重选出一个版本
 *
 * 两个必须处理的退化情形：
 *   · 空列表 → `null`（由调用方转成「模板无可用版本」错误）
 *   · 权重全为 0 → **退化为等权**，而不是永远选不出。
 *     管理员把权重都清零通常是编辑中的中间状态，此时「一个都不返回」
 *     会让线上报告生成整体失败；等权至少保持可用。
 */
export const selectWeightedVersion = <T extends WeightedVersion>(
  versions: readonly T[],
  random: () => number,
): T | null => {
  if (versions.length === 0) return null;

  const weights = versions.map((item) => Math.max(0, item.trafficWeight));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  if (total <= 0) {
    const index = Math.min(versions.length - 1, Math.floor(random() * versions.length));
    return versions[index];
  }

  // 注意：`random()` 可能返回 1（部分实现闭区间），此时 threshold === total，
  // 循环内不会命中 —— 因此最后必须兜底返回末位版本，而不是 undefined
  let threshold = random() * total;

  for (let index = 0; index < versions.length; index += 1) {
    threshold -= weights[index];
    if (threshold < 0) return versions[index];
  }

  return versions[versions.length - 1];
};

/**
 * 按版本号降序排序（供加权选择使用）
 *
 * 排序的意义：让权重相同时的选择结果**稳定**（否则顺序取决于数据库返回顺序，
 * AB 实验的分流比例会随查询计划变化而漂移）。降序取新版本优先。
 */
export const sortVersionsNewestFirst = <T extends WeightedVersion>(versions: readonly T[]): T[] =>
  [...versions].sort((a, b) => b.version - a.version);
