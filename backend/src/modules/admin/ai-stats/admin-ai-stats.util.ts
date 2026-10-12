/**
 * 管理端 AI 统计模块纯逻辑（无 I/O、可单测）
 *
 * ## ⏱ 时区口径（**关键设计决策**）
 *
 * 项目 `TZ = Asia/Shanghai`，而库里所有时间列是 `timestamptz`（UTC 存储）。
 * 按日聚合的口径**不是**北京时间自然日，而是 **UTC 自然日**，理由有三：
 *
 * 1. `ai_usage_logs.usage_date` 是 `@db.Date` 列，写入端（`report-generation.service.ts`）
 *    传的是 `new Date()` —— Prisma 对 `@db.Date` 按 **UTC** 截断日期，
 *    因此该列本身就是 UTC 日历日。按北京时间再切一次会与写入端不一致。
 * 2. 契约示例的时间边界全部是 UTC 零点（`rangeStart: "2026-02-08T00:00:00.000Z"`），
 *    例如 `7D` 的范围是 `2026-02-08T00:00Z ~ 2026-02-14T21:20Z`。
 * 3. `ai_usage_logs` 上可用的索引是 `[usageDate, taskType]` 与 `[provider, usageDate]`，
 *    只有直接用该列做范围/分组才能命中索引；若按 `created_at AT TIME ZONE 'Asia/Shanghai'`
 *    分组，索引立即失效（表达式不匹配索引列）。
 *
 * 因此：**范围边界与按日聚合统一使用 UTC 自然日**；`rangeStart` 为
 * 「UTC 当天零点回退 N−1 天」，与契约示例逐字一致。
 * 副作用（已在交付简报标注）：北京时间 00:00–08:00 产生的调用会被计入**前一天**。
 */

import { ErrorCode, messageOf } from '../../../common/errors/error-code';
import { BusinessException } from '../../../common/errors/business.exception';

/** 契约 §3.14.7.1 的任务类型枚举 */
export const CONTRACT_AI_TASKS = [
  'MBTI_REPORT',
  'RELATIONSHIP_REPORT',
  'AI_COMPANION',
  'EMOTION_ANALYSIS',
  'GROWTH_REPORT',
  'PROMPT_TEST',
] as const;

/**
 * 允许筛选的任务类型 = 契约枚举 ∪ `AiTaskType` 数据模型枚举
 *
 * 为什么取并集：`AiTaskType` 还包含 `MEMORY_SUMMARY` / `STRUCTURED_EXTRACT` /
 * `SAFETY_CHECK` 三个契约未列出的值，且 `ai_usage_logs` 里确实会有这些行。
 * 若严格按契约枚举拒绝，这些数据的用量将**无法被筛选、也无法被排除**，
 * 表现为「各任务成本之和 ≠ 总成本」这种查不出原因的差异。
 * 契约枚举仍是**返回值**的合法集合（输出侧不会出现并集独有值以外的新值）。
 */
export const AI_TASK_FILTERS = [...CONTRACT_AI_TASKS, 'MEMORY_SUMMARY', 'STRUCTURED_EXTRACT', 'SAFETY_CHECK'] as const;
export type AiTaskFilter = (typeof AI_TASK_FILTERS)[number];

/** 任务类型中文名（契约 §3.14.7.1 的 `taskName`） */
const TASK_NAMES: Readonly<Record<string, string>> = {
  MBTI_REPORT: 'MBTI 深度报告',
  RELATIONSHIP_REPORT: '关系匹配报告',
  AI_COMPANION: 'AI 情感助手',
  EMOTION_ANALYSIS: '情绪分析',
  GROWTH_REPORT: '成长回顾报告',
  PROMPT_TEST: 'Prompt 预览实测',
  MEMORY_SUMMARY: '记忆摘要',
  STRUCTURED_EXTRACT: '结构化抽取',
  SAFETY_CHECK: '内容安全检查',
};

/** 任务中文名；未知任务回落原值（便于发现新增任务未登记） */
export const aiTaskName = (task: string): string => TASK_NAMES[task] ?? task;

/** provider 枚举（契约 §3.14.7.4 的小写字面量；库里是大写枚举） */
export const AI_PROVIDERS = ['deepseek', 'openai', 'qwen'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/** 库内 `AiProvider` 枚举 → 契约小写名 */
export const toProviderName = (provider: string): string => provider.toLowerCase();

/** 契约小写名 → 库内枚举 */
export const toProviderEnum = (provider: AiProviderName): string => provider.toUpperCase();

/** 环形缓冲区状态（契约 §3.14.7.1 的 `circuitState`） */
export const CIRCUIT_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

// ============================================================================
// 时间范围
// ============================================================================

/** overview 的时间范围枚举（契约 §3.14.7.1） */
export const OVERVIEW_RANGES = ['TODAY', '7D', '30D', 'CUSTOM'] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];

/**
 * 时间范围的**最小形状**：只有起止边界
 *
 * 所有聚合 loader 实际只用到这两个边界（`toDateKey(range.rangeStart)` / `rangeEnd`），
 * 不关心范围是怎么来的。抽出这个最小形状后，「前一等长周期」（见 `previousPeriod`）
 * 这种没有 `key` 的推导范围也能直接喂给 loader，不必伪造一个假 key。
 */
export interface RangeBounds {
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
}

/** 时间范围解析结果 */
export interface ResolvedRange extends RangeBounds {
  readonly key: string;
}

/** 自定义范围上限（契约 §3.14.7.1 的 `10016`：> 366 天） */
export const STATS_MAX_RANGE_DAYS = 366;

/** UTC 当天零点 */
export const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** UTC 当月起点的日期（用于月预算统计） */
export const startOfUtcMonth = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

/** Date → `yyyy-MM-dd`（UTC 口径；`@db.Date` 列与 raw 查询的日期参数都用它） */
export const toDateKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

/** 日期区间天数（含首尾按「时间跨度」计算，不做 +1） */
export const rangeDays = (start: Date, end: Date): number => (end.getTime() - start.getTime()) / 86_400_000;

/**
 * 解析 `range`（TODAY / 7D / 30D / CUSTOM）
 *
 * 语义：`ND` 表示「含今天在内的 N 个 UTC 自然日」，因此起点是
 * `UTC 今天零点 − (N−1) 天`。校验过契约示例：2026-02-14 取 `7D`
 * → 起点 2026-02-08T00:00:00.000Z ✓。
 */
export const resolveOverviewRange = (
  range: OverviewRange,
  startTime: string | undefined,
  endTime: string | undefined,
  now: Date = new Date(),
): ResolvedRange => {
  if (range === 'CUSTOM') {
    if (startTime === undefined || endTime === undefined) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'range = CUSTOM 时必须提供 startTime 与 endTime');
    }

    const rangeStart = new Date(startTime);
    const rangeEnd = new Date(endTime);

    if (rangeStart.getTime() > rangeEnd.getTime()) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'startTime 不能晚于 endTime');
    }

    if (rangeDays(rangeStart, rangeEnd) > STATS_MAX_RANGE_DAYS) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `自定义时间范围不能超过 ${STATS_MAX_RANGE_DAYS} 天`);
    }

    return { key: 'CUSTOM', rangeStart, rangeEnd };
  }

  const todayStart = startOfUtcDay(now);
  const days = range === 'TODAY' ? 1 : range === '7D' ? 7 : 30;
  const rangeStart = new Date(todayStart.getTime() - (days - 1) * 86_400_000);

  return { key: range, rangeStart, rangeEnd: now };
};

/** 解析 usage / costs 的必填时间范围（契约 §3.14.7.2 / §3.14.7.3） */
export const resolveRequiredRange = (startTime: string | undefined, endTime: string | undefined): ResolvedRange => {
  if (startTime === undefined || endTime === undefined) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '必须提供 startTime 与 endTime');
  }

  const rangeStart = new Date(startTime);
  const rangeEnd = new Date(endTime);

  if (rangeStart.getTime() > rangeEnd.getTime()) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'startTime 不能晚于 endTime');
  }

  if (rangeDays(rangeStart, rangeEnd) > STATS_MAX_RANGE_DAYS) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `时间范围不能超过 ${STATS_MAX_RANGE_DAYS} 天`);
  }

  return { key: 'CUSTOM', rangeStart, rangeEnd };
};

/** 调用日志的时间范围上限（契约 §3.14.7.4：≤ 31 天） */
export const CALL_LOG_MAX_RANGE_DAYS = 31;

/** 解析调用日志时间范围（必填且 ≤ 31 天） */
export const resolveCallLogRange = (startTime: string | undefined, endTime: string | undefined): ResolvedRange => {
  if (startTime === undefined || endTime === undefined) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '必须提供 startTime 与 endTime');
  }

  const rangeStart = new Date(startTime);
  const rangeEnd = new Date(endTime);

  if (rangeStart.getTime() > rangeEnd.getTime()) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'startTime 不能晚于 endTime');
  }

  if (rangeDays(rangeStart, rangeEnd) > CALL_LOG_MAX_RANGE_DAYS) {
    throw BusinessException.badRequest(
      ErrorCode.PARAM_INVALID,
      `审计日志量大，查询范围不能超过 ${CALL_LOG_MAX_RANGE_DAYS} 天`,
    );
  }

  return { key: 'CUSTOM', rangeStart, rangeEnd };
};

/** HOUR 粒度的范围上限（契约 §3.14.7.2 规则 3：≤ 7 天，防数据量爆炸） */
export const HOUR_GRANULARITY_MAX_DAYS = 7;

/**
 * 前一等长周期（用于趋势对比）
 *
 * 返回类型是 `RangeBounds` 而非 `ResolvedRange`：对比周期是**推导**出来的，
 * 它没有自己的 `range` 枚举值，硬塞一个编造的 key 会污染响应里的 `range` 字段口径。
 * 属性名与 `ResolvedRange` 保持一致（`rangeStart` / `rangeEnd`），因此可以直接
 * 传给任何只依赖边界的 loader。
 */
export const previousPeriod = (range: RangeBounds): RangeBounds => {
  const length = range.rangeEnd.getTime() - range.rangeStart.getTime();
  return { rangeStart: new Date(range.rangeStart.getTime() - length), rangeEnd: range.rangeStart };
};

// ============================================================================
// 数值与格式化
// ============================================================================

/**
 * int8 → number
 *
 * PostgreSQL `sum(int)` 返回 `bigint`，Prisma 会映射为 **JS BigInt**。
 * BigInt 一旦进入响应体，`JSON.stringify` 会直接抛
 * `TypeError: Do not know how to serialize a BigInt` —— 表现为整个接口 500，
 * 而不是某个字段异常，排查成本很高。因此所有聚合值必须显式过这里。
 */
export const toSafeNumber = (value: bigint | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
};

/** 比率：分母为 0 时返回 0（而不是 NaN —— NaN 会被序列化成 null，前端拿到的不是数字） */
export const safeRatio = (numerator: number, denominator: number, digits = 4): number => {
  if (denominator <= 0) return 0;
  return roundTo(numerator / denominator, digits);
};

/** 四舍五入到指定小数位 */
export const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 整数分 → `¥x,xxx.xx`（契约 `costDisplay` / `dailyBudgetDisplay`） */
export const formatCents = (cents: number): string => {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}¥${grouped}.${fraction}`;
};

/** 比率 → `12.34%` */
export const formatPercent = (ratio: number): string => `${roundTo(ratio * 100, 2).toFixed(2)}%`;

/** 千分位整数（契约 `displayValue: "1,860"`） */
export const formatCount = (value: number): string => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 百分点变化展示（`+1.24pp` / `-0.13pp`） */
export const formatPercentagePointChange = (change: number): string =>
  `${change >= 0 ? '+' : ''}${roundTo(change * 100, 2).toFixed(2)}pp`;

/** 均值（空集合返回 0，避免 NaN） */
export const averageOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** 变化方向语义（契约 §3.14.9.9 规则 3：🚫 前端不得假设「增长即正向」） */
export const trendDirection = (change: number): 'UP' | 'DOWN' | 'FLAT' => {
  if (change > 0) return 'UP';
  if (change < 0) return 'DOWN';
  return 'FLAT';
};

// ============================================================================
// 隐私
// ============================================================================

/**
 * 昵称掩码：**统一由公共脱敏工具提供**（`common/utils/mask.util.ts`），此处仅再导出
 *
 * 该实现原先在本模块、`order`、`report` 各存一份（口径还不一致）。
 * 脱敏是有合规含义的规则，复制多份必然漂移，故收敛到单一实现。
 */
export { maskNickname } from '../../../common/utils/mask.util';

// ============================================================================
// 长度分桶（契约 §3.14.7.4 的 `inputLengthBucket` / `outputLengthBucket`）
// ============================================================================

/** 长度桶（不泄露内容，仅用于分析） */
export const LENGTH_BUCKETS = [
  'ZERO',
  'TOKEN_0_1K',
  'TOKEN_1K_4K',
  'TOKEN_4K_8K',
  'TOKEN_8K_16K',
  'TOKEN_16K_PLUS',
] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

/** 长度 → 桶（校验过契约示例：4280 → TOKEN_4K_8K、2480 → TOKEN_1K_4K、0 → ZERO） */
export const toLengthBucket = (length: number | null | undefined): LengthBucket => {
  if (length === null || length === undefined || length <= 0) return 'ZERO';
  if (length <= 1_024) return 'TOKEN_0_1K';
  if (length <= 4_096) return 'TOKEN_1K_4K';
  if (length <= 8_192) return 'TOKEN_4K_8K';
  if (length <= 16_384) return 'TOKEN_8K_16K';
  return 'TOKEN_16K_PLUS';
};

// ============================================================================
// 错误码文案
// ============================================================================

/**
 * 库内 `error_code`（VarChar，存的是本项目错误码字符串）→ 中文文案
 *
 * ⚠ 契约 §3.14.7.1 的 `errorBreakdown` 示例用的是**契约自己的**码值体系
 * （如 50009 =「AI 服务暂时不可用」），与本项目 `error-code.ts` 的码值不同
 * （本项目 50000 = AI_PROVIDER_UNAVAILABLE、50009 = AI_CONVERSATION_NOT_OWNED）。
 * 这里**以本项目错误码表为准**翻译，因为库里存的就是本项目码值 ——
 * 强行按契约示例的映射会出现「码值与文案对不上」的错误归因。
 */
export const describeErrorCode = (code: number): string => messageOf(code);

/** 生成契约要求的错误响应（枚举/白名单类错误统一 `10001`） */
export const invalidParam = (message: string): BusinessException =>
  BusinessException.badRequest(ErrorCode.PARAM_INVALID, message);
