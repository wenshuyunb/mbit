/**
 * 选项分值的**读取收窄**（数据库 JSONB → `Record<string, number>`）
 *
 * ## 为什么需要它
 *
 * `question_options.score_map` 是 JSONB 列，数据库层面**不保证**里面是什么：
 * 后台能写进任何 JSON（字符串、数组、嵌套对象、`null` 值……）。
 * 而它是沉浸式场景题的**算分依据**，直接 `as Record<string, number>` 有两个后果：
 *
 *   · 字符串值会被当成数字参与累加 → `"3" * 1 === 3` 这种"碰巧能跑"，
 *     而 `"高" * 1 === NaN` 会顺着加权和污染整个维度的百分比，
 *     `NaN` 一路传到落库才被发现（Prisma 会抛，但那时已经算了一半）；
 *   · 数组 / 嵌套对象会让 `Object.entries` 产出意料之外的键。
 *
 * 因此统一在这里收窄：**只保留有限数字**，其余键直接丢弃。
 * 丢掉一个键的后果是"该维度少一分"，比"整维度变 NaN"轻得多，
 * 而且 `resolveScale` 会因为"并非全部选项都带该维度分值"而退回题型默认量程，
 * 使问题表现成一个可解释的偏差，而不是一个神秘的 500。
 *
 * ## 单一事实源
 *
 * 管理后台在写这条路（`admin-question.service.ts`）与答题算分在读这条路
 * （`test.service.ts`）必须用**同一份**判定，否则会出现"后台显示存进去了、
 * 算分时却被丢掉"这种两边都觉得自己没错的故障。
 */

/** JSONB → `Record<string, number>`；非有限数字的值一律丢弃 */
export const parseScoreMap = (value: unknown): Record<string, number> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};

  const scoreMap: Record<string, number> = {};

  for (const [key, score] of Object.entries(value as Record<string, unknown>)) {
    if (typeof score === 'number' && Number.isFinite(score)) {
      scoreMap[key] = score;
    }
  }

  return scoreMap;
};
