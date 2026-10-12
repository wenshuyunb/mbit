/**
 * 管理端 AI 统计服务：总览（§3.14.7.1）与用量（§3.14.7.2）
 *
 * ## 聚合口径与索引（**关键设计决策**）
 *
 * 时区口径见 `admin-ai-stats.util.ts` 文件头：**UTC 自然日**，与契约示例一致。
 *
 * 所有统计都走 **聚合 SQL / `groupBy`**，没有任何「先查出来再在 JS 里遍历」的写法：
 *
 * | 查询             | 数据源           | 命中索引                                        |
 * | ---------------- | ---------------- | ----------------------------------------------- |
 * | 用量总量/分任务  | `ai_usage_logs`  | `[usageDate, taskType]`（范围 + 分组列）        |
 * | 分 provider      | `ai_usage_logs`  | `[provider, usageDate]`                         |
 * | 延迟分位         | `ai_usage_logs`  | 同上（范围收窄后排序）                          |
 * | 错误分布/熔断    | `ai_call_audits` | `[createdAt(sort: Desc)]`、`[provider, createdAt]` |
 * | 报告质量         | `ai_reports`     | `[status, createdAt]`                           |
 *
 * ## 并行度
 *
 * 每个接口内部的独立查询用 `Promise.all` 并行发出：它们是**同一请求内的独立聚合**，
 * 串行执行只会把延迟相加（契约限流 300 次/60s，说明这是高频看板接口）。
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';

import type { AppConfig } from '../../../config/config.type';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QUEUE_AI_REPORT, QUEUE_COMPATIBILITY_CALC, QUEUE_EXPORT_DATA } from '../../../infra/queue/queue.module';
import {
  HOUR_GRANULARITY_MAX_DAYS,
  aiTaskName,
  describeErrorCode,
  formatCents,
  invalidParam,
  previousPeriod,
  rangeDays,
  resolveOverviewRange,
  resolveRequiredRange,
  roundTo,
  safeRatio,
  startOfUtcMonth,
  toDateKey,
  toProviderEnum,
  toProviderName,
  toSafeNumber,
  trendDirection,
  type RangeBounds,
  type ResolvedRange,
} from './admin-ai-stats.util';
import type { AiOverviewQueryDto, AiUsageQueryDto, UsageGranularity, UsageGroupBy } from './dto/admin-ai-stats.dto';

/** 队列积压告警阈值（契约 §3.14.7.1 规则 3：`ai.report` waiting > 100 → 架构 §15.4 告警） */
const QUEUE_BACKLOG_THRESHOLD = 100;

/** 预算告警阈值（契约 §3.14.7.1 规则 1） */
const BUDGET_WARNING_RATIO = 0.8;
const BUDGET_CRITICAL_RATIO = 1.0;

/** 月预算：`AI_DAILY_COST_BUDGET_CENTS` 之外没有月度配置，按 30 天折算（见交付简报） */
const DAYS_PER_MONTH = 30;

/** 各队列的消费者并发（取自实际 Processor 常量；契约示例值与实现不同，以实现为准） */
const QUEUE_CONCURRENCY: Readonly<Record<string, number>> = {
  [QUEUE_AI_REPORT]: 3,
  [QUEUE_COMPATIBILITY_CALC]: 2,
  [QUEUE_EXPORT_DATA]: 2,
};

// ============================================================================
// 视图类型
// ============================================================================

/** `totals` 块（契约 §3.14.7.1） */
export interface AiOverviewTotals {
  callCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  cacheHitCount: number;
  cacheHitRate: number;
  retryCount: number;
  retryRate: number;
  abortedCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
  costDisplay: string;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

/** `budget` 块 */
export interface AiOverviewBudget {
  dailyBudgetCents: number;
  dailyBudgetDisplay: string;
  todayCostCents: number;
  todayCostDisplay: string;
  todayUsageRatio: number;
  monthlyBudgetCents: number;
  monthlyCostCents: number;
  monthlyUsageRatio: number;
  isBudgetWarning: boolean;
  isBudgetExhausted: boolean;
  alertThresholds: { warningRatio: number; criticalRatio: number };
}

/** `byTask[]` 项 */
export interface AiOverviewTaskStat {
  task: string;
  taskName: string;
  callCount: number;
  successRate: number;
  totalTokens: number;
  costCents: number;
  avgLatencyMs: number;
  costRatio: number;
}

/** `byProvider[]` 项 */
export interface AiOverviewProviderStat {
  provider: string;
  model: string;
  callCount: number;
  successRate: number;
  costCents: number;
  avgLatencyMs: number;
  isPrimary: boolean;
  circuitState: string;
  circuitDetail: string;
}

/** `errorBreakdown[]` 项 */
export interface AiOverviewErrorStat {
  errorCode: number | null;
  message: string;
  count: number;
  ratio: number;
}

/** `queueStatus[]` 项 */
export interface AiQueueStatus {
  queue: string;
  waiting: number;
  active: number;
  completed7d: number;
  failed7d: number;
  concurrency: number;
  isBacklogWarning: boolean;
}

/** `alerts[]` 项 */
export interface AiAlert {
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  code: string;
  message: string;
  triggeredAt: string;
}

/** 总览响应（契约 §3.14.7.1） */
export interface AiOverviewView {
  range: string;
  rangeStart: string;
  rangeEnd: string;
  generatedAt: string;
  totals: AiOverviewTotals;
  budget: AiOverviewBudget;
  byTask: AiOverviewTaskStat[];
  byProvider: AiOverviewProviderStat[];
  errorBreakdown: AiOverviewErrorStat[];
  safety: {
    inputBlockedCount: number;
    inputBlockedRate: number;
    outputBlockedCount: number;
    outputBlockedRate: number;
    byCategory: Array<{ category: string; count: number }>;
  };
  quality: {
    reportRegenerateRate: number;
    reportAverageWordCount: number;
    schemaValidationFailureRate: number;
    userFeedbackNegativeRate: number;
    promptVersionsInUse: Array<{ key: string; version: number; trafficWeight: number }>;
  };
  queueStatus: AiQueueStatus[];
  alerts: AiAlert[];
}

/** `rows[]` 项（契约 §3.14.7.2；维度字段按 `groupBy` 出现） */
export interface AiUsageRow {
  date?: string;
  task?: string;
  provider?: string;
  model?: string;
  promptKey?: string;
  promptVersion?: number;
  userId?: string;
  callCount: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  uniqueUsers: number;
  cacheHitRate: number;
}

/** 用量响应（契约 §3.14.7.2） */
export interface AiUsageView {
  startTime: string;
  endTime: string;
  granularity: UsageGranularity;
  groupBy: UsageGroupBy[];
  rows: AiUsageRow[];
  rowCount: number;
  isTruncated: boolean;
  totals: {
    callCount: number;
    totalTokens: number;
    costCents: number;
    uniqueUsers: number;
    averageCostPerCallCents: number;
    averageTokensPerCall: number;
  };
  trend: {
    callCountChangeVsPreviousPeriod: number;
    costChangeVsPreviousPeriod: number;
    tokensPerCallChangeVsPreviousPeriod: number;
    direction: 'UP' | 'DOWN' | 'FLAT';
    note: string;
  };
}

// ============================================================================
// raw 查询行类型
// ============================================================================

interface UsageTotalsRow {
  call_count: number;
  success_count: number;
  failure_count: number;
  cache_hit_count: number;
  retry_count: number;
  prompt_tokens: bigint;
  completion_tokens: bigint;
  total_tokens: bigint;
  cost_cents: bigint;
  avg_latency_ms: number;
}

interface PercentileRow {
  p95: number;
  p99: number;
}

interface CountRow {
  cnt: number;
}

interface TaskStatRow {
  task_type: string;
  call_count: number;
  success_count: number;
  total_tokens: bigint;
  cost_cents: bigint;
  avg_latency_ms: number;
}

interface ProviderStatRow {
  provider: string;
  model: string;
  call_count: number;
  success_count: number;
  cost_cents: bigint;
  avg_latency_ms: number;
}

interface ErrorStatRow {
  error_code: string;
  cnt: number;
}

interface BudgetRow {
  today_cost: bigint;
  month_cost: bigint;
}

interface CircuitRow {
  provider: string;
  model: string;
  recent_count: number;
  failed_count: number;
  last_failed_at: Date | null;
}

interface QualityRow {
  total: number;
  regenerated: number;
  avg_words: number;
  schema_failed: number;
}

interface PromptVersionRow {
  prompt_key: string;
  prompt_version: number;
  cnt: number;
}

interface UsageGroupRow {
  d1: string | null;
  d2: string | null;
  d3: string | null;
  d4: string | null;
  call_count: number;
  success_count: number;
  prompt_tokens: bigint;
  completion_tokens: bigint;
  total_tokens: bigint;
  cost_cents: bigint;
  avg_latency_ms: number;
  p95_latency_ms: number;
  unique_users: number;
  cache_hit_count: number;
}

/** 任务筛选 → SQL 片段（`ai_usage_logs.task_type`） */
const usageTaskFilter = (tasks: readonly string[] | undefined): Prisma.Sql =>
  tasks === undefined || tasks.length === 0 ? Prisma.empty : Prisma.sql`AND task_type::text IN (${Prisma.join(tasks)})`;

/** 任务筛选 → SQL 片段（`ai_call_audits.task_type`） */
const auditTaskFilter = (tasks: readonly string[] | undefined): Prisma.Sql =>
  tasks === undefined || tasks.length === 0 ? Prisma.empty : Prisma.sql`AND task_type::text IN (${Prisma.join(tasks)})`;

@Injectable()
export class AdminAiStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig, true>,
    @InjectQueue(QUEUE_AI_REPORT) private readonly aiReportQueue: Queue,
    @InjectQueue(QUEUE_COMPATIBILITY_CALC) private readonly compatibilityQueue: Queue,
    @InjectQueue(QUEUE_EXPORT_DATA) private readonly exportQueue: Queue,
  ) {}

  // ==========================================================================
  // GET /admin/ai/stats/overview
  // ==========================================================================

  async getOverview(query: AiOverviewQueryDto): Promise<AiOverviewView> {
    const now = new Date();
    const range = resolveOverviewRange(query.range ?? 'TODAY', query.startTime, query.endTime, now);
    // 注意：这里不再预计算 range 的 startKey/endKey —— 每个 loader 内部按需
    // `toDateKey(range.rangeStart/rangeEnd)`（它拿到的正是同一个 range），
    // 在外面再算一份只会产生两个「看起来有人用、其实没人读」的死变量。
    const todayKey = toDateKey(now);
    const monthStartKey = toDateKey(startOfUtcMonth(now));
    const tasks = query.task;

    const [
      totalsRow,
      percentileRow,
      abortedRow,
      blockedRow,
      byTaskRows,
      byProviderRows,
      errorRows,
      budgetRow,
      circuitRows,
      qualityRow,
      promptVersionRows,
      queueStatus,
    ] = await Promise.all([
      this.loadUsageTotals(range, tasks),
      this.loadLatencyPercentiles(range, tasks),
      this.loadAbortedCount(range, tasks),
      this.loadBlockedCount(range, tasks),
      this.loadByTask(range, tasks),
      this.loadByProvider(range, tasks),
      this.loadErrorBreakdown(range, tasks),
      this.loadBudget(todayKey, monthStartKey),
      this.loadCircuitStates(),
      this.loadReportQuality(range),
      this.loadPromptVersionsInUse(range),
      this.loadQueueStatus(),
    ]);

    const callCount = totalsRow.call_count;
    const costCents = toSafeNumber(totalsRow.cost_cents);
    const totalTokens = toSafeNumber(totalsRow.total_tokens);

    // 预算：日预算来自配置；月预算无配置项，按 30 天折算（见交付简报名单）
    const dailyBudgetCents = this.configService.get('ai.dailyCostBudgetCents', { infer: true });
    const monthlyBudgetCents = dailyBudgetCents * DAYS_PER_MONTH;
    const todayCostCents = toSafeNumber(budgetRow.today_cost);
    const monthlyCostCents = toSafeNumber(budgetRow.month_cost);
    const todayUsageRatio = safeRatio(todayCostCents, dailyBudgetCents);

    const circuitByKey = new Map(circuitRows.map((row) => [`${row.provider}:${row.model}`.toLowerCase(), row]));
    const defaultProvider = this.configService.get('ai.defaultProvider', { infer: true });
    const defaultModel = this.defaultModelOf(defaultProvider);

    return {
      range: range.key,
      rangeStart: range.rangeStart.toISOString(),
      rangeEnd: range.rangeEnd.toISOString(),
      generatedAt: now.toISOString(),
      totals: {
        callCount,
        successCount: totalsRow.success_count,
        failureCount: totalsRow.failure_count,
        successRate: safeRatio(totalsRow.success_count, callCount),
        cacheHitCount: totalsRow.cache_hit_count,
        cacheHitRate: safeRatio(totalsRow.cache_hit_count, callCount),
        retryCount: totalsRow.retry_count,
        retryRate: safeRatio(totalsRow.retry_count, callCount),
        abortedCount: abortedRow.cnt,
        promptTokens: toSafeNumber(totalsRow.prompt_tokens),
        completionTokens: toSafeNumber(totalsRow.completion_tokens),
        totalTokens,
        costCents,
        costDisplay: formatCents(costCents),
        avgLatencyMs: Math.round(totalsRow.avg_latency_ms),
        p95LatencyMs: Math.round(percentileRow.p95),
        p99LatencyMs: Math.round(percentileRow.p99),
      },
      budget: {
        dailyBudgetCents,
        dailyBudgetDisplay: formatCents(dailyBudgetCents),
        todayCostCents,
        todayCostDisplay: formatCents(todayCostCents),
        todayUsageRatio,
        monthlyBudgetCents,
        monthlyCostCents,
        monthlyUsageRatio: safeRatio(monthlyCostCents, monthlyBudgetCents),
        isBudgetWarning: todayUsageRatio >= BUDGET_WARNING_RATIO && todayUsageRatio < BUDGET_CRITICAL_RATIO,
        isBudgetExhausted: todayUsageRatio >= BUDGET_CRITICAL_RATIO,
        alertThresholds: { warningRatio: BUDGET_WARNING_RATIO, criticalRatio: BUDGET_CRITICAL_RATIO },
      },
      byTask: byTaskRows.map((row) => ({
        task: row.task_type,
        taskName: aiTaskName(row.task_type),
        callCount: row.call_count,
        successRate: safeRatio(row.success_count, row.call_count),
        totalTokens: toSafeNumber(row.total_tokens),
        costCents: toSafeNumber(row.cost_cents),
        avgLatencyMs: Math.round(row.avg_latency_ms),
        costRatio: safeRatio(toSafeNumber(row.cost_cents), costCents),
      })),
      byProvider: byProviderRows.map((row) => {
        const circuit = circuitByKey.get(`${row.provider}:${row.model}`.toLowerCase());
        return {
          provider: toProviderName(row.provider),
          model: row.model,
          callCount: row.call_count,
          successRate: safeRatio(row.success_count, row.call_count),
          costCents: toSafeNumber(row.cost_cents),
          avgLatencyMs: Math.round(row.avg_latency_ms),
          isPrimary: row.provider.toLowerCase() === defaultProvider && row.model === defaultModel,
          ...this.describeCircuit(circuit, now),
        };
      }),
      errorBreakdown: errorRows.map((row) => {
        const code = Number.parseInt(row.error_code, 10);
        return {
          errorCode: Number.isNaN(code) ? null : code,
          message: Number.isNaN(code) ? '未登记的错误码' : describeErrorCode(code),
          count: row.cnt,
          ratio: safeRatio(row.cnt, totalsRow.failure_count),
        };
      }),
      safety: {
        inputBlockedCount: blockedRow.cnt,
        inputBlockedRate: safeRatio(blockedRow.cnt, callCount),
        // 输出侧拦截没有独立可聚合的列：这里取 `50005 AI_CONTENT_BLOCKED`
        // （生成内容未通过安全审核）的审计条数作为代理口径，见交付简报
        outputBlockedCount: this.countErrorCode(errorRows, 50005),
        outputBlockedRate: safeRatio(this.countErrorCode(errorRows, 50005), callCount),
        // 分类维度只存在于 `ai_messages.safety_labels`（String[]），
        // 该表没有支持时间范围扫描的索引，全表扫描不可接受，故返回空数组并在此说明
        byCategory: [],
      },
      quality: {
        reportRegenerateRate: safeRatio(qualityRow.regenerated, qualityRow.total),
        reportAverageWordCount: Math.round(qualityRow.avg_words),
        schemaValidationFailureRate: safeRatio(qualityRow.schema_failed, qualityRow.total),
        // 用户反馈没有落库（契约的 userFeedback 来自 regenerate 的 reason/feedback，
        // 当前 schema 无对应表/列），因此恒为 0
        userFeedbackNegativeRate: 0,
        promptVersionsInUse: promptVersionRows.map((row) => ({
          key: row.prompt_key,
          version: row.prompt_version,
          trafficWeight: Math.round(safeRatio(row.cnt, qualityRow.total, 4) * 100),
        })),
      },
      queueStatus,
      alerts: this.buildAlerts(todayUsageRatio, todayCostCents, dailyBudgetCents, byProviderRows, circuitByKey, now),
    };
  }

  // ==========================================================================
  // GET /admin/ai/stats/usage
  // ==========================================================================

  async getUsage(query: AiUsageQueryDto): Promise<AiUsageView> {
    const range = resolveRequiredRange(query.startTime, query.endTime);
    const granularity: UsageGranularity = query.granularity ?? 'DAY';
    const groupBy: UsageGroupBy[] = query.groupBy !== undefined && query.groupBy.length > 0 ? query.groupBy : ['DATE'];
    const limit = query.limit ?? 100;

    if (granularity === 'HOUR') {
      // 契约规则 3：HOUR 仅允许 ≤ 7 天（防数据量爆炸）
      if (rangeDays(range.rangeStart, range.rangeEnd) > HOUR_GRANULARITY_MAX_DAYS) {
        throw invalidParam(`granularity = HOUR 时时间范围不能超过 ${HOUR_GRANULARITY_MAX_DAYS} 天`);
      }
    }

    const dimensions = this.orderDimensions(groupBy);
    const [rows, totals, previousTotals] = await Promise.all([
      this.loadUsageGroups(range, granularity, dimensions, limit, query),
      this.loadUsageTotals(range, query.task),
      this.loadUsageTotals(previousPeriod(range), query.task),
    ]);

    const isTruncated = rows.length > limit;
    const visibleRows = isTruncated ? rows.slice(0, limit) : rows;

    const totalCallCount = totals.call_count;
    const totalTokens = toSafeNumber(totals.total_tokens);
    const totalCostCents = toSafeNumber(totals.cost_cents);
    const previousCallCount = previousTotals.call_count;
    const previousCostCents = toSafeNumber(previousTotals.cost_cents);
    const previousTokens = toSafeNumber(previousTotals.total_tokens);

    const currentTokensPerCall = safeRatio(totalTokens, totalCallCount, 2);
    const previousTokensPerCall = safeRatio(previousTokens, previousCallCount, 2);

    const callChange = this.relativeChange(totalCallCount, previousCallCount);
    const costChange = this.relativeChange(totalCostCents, previousCostCents);
    const tokensPerCallChange = this.relativeChange(currentTokensPerCall, previousTokensPerCall);

    return {
      startTime: range.rangeStart.toISOString(),
      endTime: range.rangeEnd.toISOString(),
      granularity,
      groupBy: dimensions,
      rows: visibleRows.map((row) => this.toUsageRow(row, dimensions)),
      rowCount: visibleRows.length,
      isTruncated,
      totals: {
        callCount: totalCallCount,
        totalTokens,
        costCents: totalCostCents,
        uniqueUsers: totals.unique_users,
        averageCostPerCallCents: safeRatio(totalCostCents, totalCallCount, 2),
        averageTokensPerCall: Math.round(safeRatio(totalTokens, totalCallCount, 2)),
      },
      trend: {
        callCountChangeVsPreviousPeriod: callChange,
        costChangeVsPreviousPeriod: costChange,
        tokensPerCallChangeVsPreviousPeriod: tokensPerCallChange,
        direction: trendDirection(callChange),
        note: this.describeTrend(callChange, costChange),
      },
    };
  }

  // ==========================================================================
  // 聚合查询
  // ==========================================================================

  /**
   * 用量总量（供 overview 的 totals 与 usage 的 totals/trend 复用）
   *
   * 形参取 `RangeBounds`（只有起止边界）而非 `ResolvedRange`：本方法只用边界拼 SQL，
   * 不读 `range.key`。因此「前一等长周期」这种推导范围（没有 key）可以直接传入。
   */
  async loadUsageTotals(
    range: RangeBounds,
    tasks: readonly string[] | undefined,
  ): Promise<UsageTotalsRow & { unique_users: number }> {
    const rows = await this.prisma.$queryRaw<Array<UsageTotalsRow & { unique_users: number }>>(Prisma.sql`
      SELECT
        count(*)::int AS call_count,
        count(*) FILTER (WHERE success)::int AS success_count,
        count(*) FILTER (WHERE NOT success)::int AS failure_count,
        count(*) FILTER (WHERE cache_hit)::int AS cache_hit_count,
        count(*) FILTER (WHERE retry_index > 0)::int AS retry_count,
        coalesce(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
        coalesce(sum(completion_tokens), 0)::bigint AS completion_tokens,
        coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(cost_amount), 0)::bigint AS cost_cents,
        coalesce(avg(latency_ms), 0)::float8 AS avg_latency_ms,
        count(DISTINCT user_id)::int AS unique_users
      FROM ai_usage_logs
      WHERE usage_date >= ${toDateKey(range.rangeStart)}::date
        AND usage_date <= ${toDateKey(range.rangeEnd)}::date
        ${usageTaskFilter(tasks)}
    `);

    // `count(*)` 在空集下仍返回一行全景 0，因此 rows[0] 只在数据库异常时缺失
    return (
      rows[0] ?? {
        call_count: 0,
        success_count: 0,
        failure_count: 0,
        cache_hit_count: 0,
        retry_count: 0,
        prompt_tokens: 0n,
        completion_tokens: 0n,
        total_tokens: 0n,
        cost_cents: 0n,
        avg_latency_ms: 0,
        unique_users: 0,
      }
    );
  }

  /** 延迟分位（P95 / P99） */
  private async loadLatencyPercentiles(
    range: ResolvedRange,
    tasks: readonly string[] | undefined,
  ): Promise<PercentileRow> {
    const rows = await this.prisma.$queryRaw<PercentileRow[]>(Prisma.sql`
      SELECT
        coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p95,
        coalesce(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p99
      FROM ai_usage_logs
      WHERE usage_date >= ${toDateKey(range.rangeStart)}::date
        AND usage_date <= ${toDateKey(range.rangeEnd)}::date
        AND latency_ms IS NOT NULL
        ${usageTaskFilter(tasks)}
    `);

    return rows[0] ?? { p95: 0, p99: 0 };
  }

  /** 中断调用数（`status = TIMEOUT`，契约 `abortedCount`） */
  private async loadAbortedCount(range: ResolvedRange, tasks: readonly string[] | undefined): Promise<CountRow> {
    const rows = await this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(*)::int AS cnt
      FROM ai_call_audits
      WHERE created_at >= ${range.rangeStart} AND created_at <= ${range.rangeEnd}
        AND status = 'TIMEOUT'
        ${auditTaskFilter(tasks)}
    `);

    return rows[0] ?? { cnt: 0 };
  }

  /** 危险内容拦截数（`status = BLOCKED` 即「命中预筛、未调用模型」） */
  private async loadBlockedCount(range: ResolvedRange, tasks: readonly string[] | undefined): Promise<CountRow> {
    const rows = await this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(*)::int AS cnt
      FROM ai_call_audits
      WHERE created_at >= ${range.rangeStart} AND created_at <= ${range.rangeEnd}
        AND status = 'BLOCKED'
        ${auditTaskFilter(tasks)}
    `);

    return rows[0] ?? { cnt: 0 };
  }

  /** 按任务聚合 */
  private async loadByTask(range: ResolvedRange, tasks: readonly string[] | undefined): Promise<TaskStatRow[]> {
    return this.prisma.$queryRaw<TaskStatRow[]>(Prisma.sql`
      SELECT
        task_type,
        count(*)::int AS call_count,
        count(*) FILTER (WHERE success)::int AS success_count,
        coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(cost_amount), 0)::bigint AS cost_cents,
        coalesce(avg(latency_ms), 0)::float8 AS avg_latency_ms
      FROM ai_usage_logs
      WHERE usage_date >= ${toDateKey(range.rangeStart)}::date
        AND usage_date <= ${toDateKey(range.rangeEnd)}::date
        ${usageTaskFilter(tasks)}
      GROUP BY task_type
      ORDER BY cost_cents DESC
    `);
  }

  /** 按 provider + model 聚合 */
  private async loadByProvider(range: ResolvedRange, tasks: readonly string[] | undefined): Promise<ProviderStatRow[]> {
    return this.prisma.$queryRaw<ProviderStatRow[]>(Prisma.sql`
      SELECT
        provider,
        model,
        count(*)::int AS call_count,
        count(*) FILTER (WHERE success)::int AS success_count,
        coalesce(sum(cost_amount), 0)::bigint AS cost_cents,
        coalesce(avg(latency_ms), 0)::float8 AS avg_latency_ms
      FROM ai_usage_logs
      WHERE usage_date >= ${toDateKey(range.rangeStart)}::date
        AND usage_date <= ${toDateKey(range.rangeEnd)}::date
        ${usageTaskFilter(tasks)}
      GROUP BY provider, model
      ORDER BY cost_cents DESC
    `);
  }

  /** 错误分布（按错误码聚合，取前 10） */
  private async loadErrorBreakdown(
    range: ResolvedRange,
    tasks: readonly string[] | undefined,
  ): Promise<ErrorStatRow[]> {
    return this.prisma.$queryRaw<ErrorStatRow[]>(Prisma.sql`
      SELECT error_code, count(*)::int AS cnt
      FROM ai_call_audits
      WHERE created_at >= ${range.rangeStart} AND created_at <= ${range.rangeEnd}
        AND error_code IS NOT NULL
        AND status <> 'SUCCESS'
        ${auditTaskFilter(tasks)}
      GROUP BY error_code
      ORDER BY cnt DESC
      LIMIT 10
    `);
  }

  /** 预算消耗（当日与当月**全量** AI 成本，不受 task 筛选影响 —— 预算本身是全局配置） */
  private async loadBudget(todayKey: string, monthStartKey: string): Promise<BudgetRow> {
    const rows = await this.prisma.$queryRaw<BudgetRow[]>(Prisma.sql`
      SELECT
        coalesce(sum(cost_amount) FILTER (WHERE usage_date = ${todayKey}::date), 0)::bigint AS today_cost,
        coalesce(sum(cost_amount) FILTER (WHERE usage_date >= ${monthStartKey}::date), 0)::bigint AS month_cost
      FROM ai_usage_logs
      WHERE usage_date >= ${monthStartKey}::date AND usage_date <= ${todayKey}::date
    `);

    return rows[0] ?? { today_cost: 0n, month_cost: 0n };
  }

  /**
   * 熔断状态（观察式推导）
   *
   * 契约要求返回 `CLOSED / OPEN / HALF_OPEN` 与剩余恢复秒数，但**项目尚无熔断器
   * 实现**（`AI_CIRCUIT_BREAKER_THRESHOLD` / `AI_CIRCUIT_BREAKER_COOLDOWN_MS`
   * 只有配置项，没有运行时状态）。因此这里按「最近 `threshold` 次调用是否全部失败、
   * 且最后一次失败仍在冷却窗口内」**推导** OPEN。HALF_OPEN 永不返回 ——
   * 半开态是熔断器的内部状态，从调用记录里无法判定。
   */
  private async loadCircuitStates(): Promise<CircuitRow[]> {
    const threshold = this.configService.get('ai.circuitBreakerThreshold', { infer: true });
    const cooldownMs = this.configService.get('ai.circuitBreakerCooldownMs', { infer: true });
    const windowStart = new Date(Date.now() - cooldownMs);

    return this.prisma.$queryRaw<CircuitRow[]>(Prisma.sql`
      SELECT
        provider,
        model,
        count(*)::int AS recent_count,
        count(*) FILTER (WHERE status <> 'SUCCESS')::int AS failed_count,
        max(created_at) FILTER (WHERE status <> 'SUCCESS') AS last_failed_at
      FROM (
        SELECT
          provider,
          model,
          status,
          created_at,
          row_number() OVER (PARTITION BY provider, model ORDER BY created_at DESC) AS rn
        FROM ai_call_audits
        WHERE created_at >= ${windowStart}
      ) t
      WHERE rn <= ${threshold}::int
      GROUP BY provider, model
    `);
  }

  /** 报告质量指标（重新生成率 / 平均字数 / 输出格式校验失败率） */
  private async loadReportQuality(range: ResolvedRange): Promise<QualityRow> {
    const rows = await this.prisma.$queryRaw<QualityRow[]>(Prisma.sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE retry_count > 0)::int AS regenerated,
        coalesce(avg(content_length), 0)::float8 AS avg_words,
        count(*) FILTER (WHERE error_code = '50004')::int AS schema_failed
      FROM ai_reports
      WHERE created_at >= ${range.rangeStart} AND created_at <= ${range.rangeEnd}
        AND deleted_at IS NULL
    `);

    return rows[0] ?? { total: 0, regenerated: 0, avg_words: 0, schema_failed: 0 };
  }

  /** Prompt 版本流量分布 */
  private async loadPromptVersionsInUse(range: ResolvedRange): Promise<PromptVersionRow[]> {
    return this.prisma.$queryRaw<PromptVersionRow[]>(Prisma.sql`
      SELECT
        r.prompt_template_key AS prompt_key,
        coalesce(pv.version, 0)::int AS prompt_version,
        count(*)::int AS cnt
      FROM ai_reports r
      LEFT JOIN prompt_versions pv ON pv.id = r.prompt_version_id
      WHERE r.created_at >= ${range.rangeStart} AND r.created_at <= ${range.rangeEnd}
        AND r.deleted_at IS NULL
      GROUP BY 1, 2
      ORDER BY cnt DESC
      LIMIT 10
    `);
  }

  /**
   * 队列状态
   *
   * `completed7d` / `failed7d` 直接取 BullMQ 的累计计数：`QueueModule` 的
   * `removeOnComplete` 保留 1 天、`removeOnFail` 保留 7 天，因此实际语义是
   * 「约 24h 内完成数」与「7 天内失败数」—— 契约字段名与之一致（不额外查历史）。
   *
   * 契约示例含 `ai.embedding`，但 `QueueModule` **未注册**该队列（无对应处理器），
   * 因此不返回该行（返回一个永远为 0 的队列会掩盖「队列尚未实现」这一事实）。
   */
  async loadQueueStatus(): Promise<AiQueueStatus[]> {
    const queues: Array<{ name: string; queue: Queue }> = [
      { name: QUEUE_AI_REPORT, queue: this.aiReportQueue },
      { name: QUEUE_COMPATIBILITY_CALC, queue: this.compatibilityQueue },
      { name: QUEUE_EXPORT_DATA, queue: this.exportQueue },
    ];

    return Promise.all(
      queues.map(async ({ name, queue }) => {
        const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
        const waiting = counts['waiting'] ?? 0;

        return {
          queue: name,
          waiting,
          active: counts['active'] ?? 0,
          completed7d: counts['completed'] ?? 0,
          failed7d: counts['failed'] ?? 0,
          concurrency: QUEUE_CONCURRENCY[name] ?? 0,
          isBacklogWarning: waiting > QUEUE_BACKLOG_THRESHOLD,
        };
      }),
    );
  }

  /**
   * 多维度交叉聚合（动态 group by）
   *
   * 维度表达式**只来自白名单映射**（`Prisma.raw` 的入参永远是固定字面量），
   * 因此不存在 SQL 注入面；`GROUP BY 1,2,...` 用序号引用，避免重复长表达式。
   *
   * `HOUR` 粒度必须用 `created_at`（`usage_date` 是日期列，没有小时），
   * 但仍保留 `usage_date` 范围条件，好让 `[usageDate, ...]` 索引先把扫描范围收窄。
   */
  private async loadUsageGroups(
    range: ResolvedRange,
    granularity: UsageGranularity,
    dimensions: readonly UsageGroupBy[],
    limit: number,
    query: AiUsageQueryDto,
  ): Promise<UsageGroupRow[]> {
    // 只要用到 promptKey 筛选（或按 prompt 版本分组）就必须连表，
    // 否则过滤条件会落在一个不存在的别名上
    const needsReportJoin = dimensions.includes('PROMPT_VERSION') || query.promptKey !== undefined;

    const joins = needsReportJoin
      ? Prisma.sql`
        LEFT JOIN ai_reports r ON r.id = u.report_id
        LEFT JOIN prompt_versions pv ON pv.id = r.prompt_version_id
      `
      : Prisma.empty;

    const selectDims = dimensions.map(
      (dimension, index) =>
        Prisma.sql`${Prisma.raw(this.dimensionExpression(dimension, granularity))} AS ${Prisma.raw(`d${index + 1}`)}`,
    );

    const groupOrdinals = dimensions.map((_, index) => Prisma.raw(String(index + 1)));

    const providerFilter =
      query.provider === undefined || query.provider.length === 0
        ? Prisma.empty
        : Prisma.sql`AND u.provider::text IN (${Prisma.join(query.provider.map(toProviderEnum))})`;

    const promptKeyFilter =
      query.promptKey === undefined ? Prisma.empty : Prisma.sql`AND r.prompt_template_key = ${query.promptKey}`;

    return this.prisma.$queryRaw<UsageGroupRow[]>(Prisma.sql`
      SELECT
        ${Prisma.join(selectDims, ', ')},
        count(*)::int AS call_count,
        count(*) FILTER (WHERE u.success)::int AS success_count,
        coalesce(sum(u.prompt_tokens), 0)::bigint AS prompt_tokens,
        coalesce(sum(u.completion_tokens), 0)::bigint AS completion_tokens,
        coalesce(sum(u.total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(u.cost_amount), 0)::bigint AS cost_cents,
        coalesce(avg(u.latency_ms), 0)::float8 AS avg_latency_ms,
        coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY u.latency_ms), 0)::float8 AS p95_latency_ms,
        count(DISTINCT u.user_id)::int AS unique_users,
        count(*) FILTER (WHERE u.cache_hit)::int AS cache_hit_count
      FROM ai_usage_logs u
      ${joins}
      WHERE u.usage_date >= ${toDateKey(range.rangeStart)}::date
        AND u.usage_date <= ${toDateKey(range.rangeEnd)}::date
        ${promptKeyFilter}
        ${providerFilter}
        ${usageTaskFilter(query.task)}
      GROUP BY ${Prisma.join(groupOrdinals, ', ')}
      ORDER BY 1 ASC, call_count DESC
      LIMIT ${limit + 1}::int
    `);
  }

  /** 维度 → SQL 表达式（白名单；无用户输入进入 raw 片段） */
  private dimensionExpression(dimension: UsageGroupBy, granularity: UsageGranularity): string {
    switch (dimension) {
      case 'DATE':
        return this.dateGroupExpression(granularity);
      case 'TASK':
        return 'u.task_type::text';
      case 'PROVIDER':
        return 'u.provider::text';
      case 'MODEL':
        return 'u.model';
      case 'PROMPT_VERSION':
        return `coalesce(r.prompt_template_key, '') || '@v' || coalesce(pv.version, 0)::text`;
      case 'USER':
        return 'u.user_id::text';
    }
  }

  /** 日期维度表达式（统一返回字符串，避免 `date` 与 `timestamptz` 两种 JS 类型混用） */
  private dateGroupExpression(granularity: UsageGranularity): string {
    switch (granularity) {
      case 'HOUR':
        return `to_char(date_trunc('hour', u.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
      case 'WEEK':
        return `to_char(date_trunc('week', u.usage_date), 'YYYY-MM-DD')`;
      case 'MONTH':
        return `to_char(date_trunc('month', u.usage_date), 'YYYY-MM-DD')`;
      case 'DAY':
        return `to_char(u.usage_date, 'YYYY-MM-DD')`;
    }
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  /** 维度顺序固定为契约枚举顺序，保证 `groupBy=DATE,TASK` 与 `TASK,DATE` 返回同样的列 */
  private orderDimensions(requested: readonly UsageGroupBy[]): UsageGroupBy[] {
    const order: UsageGroupBy[] = ['DATE', 'TASK', 'PROVIDER', 'MODEL', 'PROMPT_VERSION', 'USER'];
    const set = new Set(requested);
    return order.filter((dimension) => set.has(dimension));
  }

  private toUsageRow(row: UsageGroupRow, dimensions: readonly UsageGroupBy[]): AiUsageRow {
    const result: AiUsageRow = {
      callCount: row.call_count,
      successRate: safeRatio(row.success_count, row.call_count),
      promptTokens: toSafeNumber(row.prompt_tokens),
      completionTokens: toSafeNumber(row.completion_tokens),
      totalTokens: toSafeNumber(row.total_tokens),
      costCents: toSafeNumber(row.cost_cents),
      avgLatencyMs: Math.round(row.avg_latency_ms),
      p95LatencyMs: Math.round(row.p95_latency_ms),
      uniqueUsers: row.unique_users,
      cacheHitRate: safeRatio(row.cache_hit_count, row.call_count),
    };

    const values: Array<string | null> = [row.d1, row.d2, row.d3, row.d4];

    dimensions.forEach((dimension, index) => {
      const value = values[index] ?? null;
      if (value === null) return;

      switch (dimension) {
        case 'DATE':
          result.date = value;
          break;
        case 'TASK':
          result.task = value;
          break;
        case 'PROVIDER':
          result.provider = value.toLowerCase();
          break;
        case 'MODEL':
          result.model = value;
          break;
        case 'PROMPT_VERSION': {
          // 形如 `MBTI_REPORT@v7`
          const [key, version] = value.split('@v');
          result.promptKey = key ?? value;
          result.promptVersion = Number.parseInt(version ?? '0', 10);
          break;
        }
        case 'USER':
          result.userId = value;
          break;
      }
    });

    return result;
  }

  /** 相对变化率；上期为 0 且本期也为 0 时返回 0（无变化），否则无法定义时返回 0 并靠 note 说明 */
  private relativeChange(current: number, previous: number): number {
    if (previous === 0) return 0;
    return roundTo((current - previous) / previous, 4);
  }

  private describeTrend(callChange: number, costChange: number): string {
    if (callChange === 0 && costChange === 0) {
      return '调用量与成本与上周期基本持平。';
    }

    const callPart = `调用量较上周期${callChange >= 0 ? '增长' : '下降'} ${Math.abs(roundTo(callChange * 100, 2))}%`;
    const costPart = `成本${costChange >= 0 ? '增长' : '下降'} ${Math.abs(roundTo(costChange * 100, 2))}%`;
    const hint = costChange < callChange ? '（成本增幅低于调用量，说明平均 token 成本下降）' : '';

    return `${callPart}，${costPart}${hint}。`;
  }

  /** 把熔断推导结果翻译为契约的 `circuitState` / `circuitDetail` */
  private describeCircuit(circuit: CircuitRow | undefined, now: Date): { circuitState: string; circuitDetail: string } {
    const threshold = this.configService.get('ai.circuitBreakerThreshold', { infer: true });
    const cooldownMs = this.configService.get('ai.circuitBreakerCooldownMs', { infer: true });

    if (circuit === undefined || circuit.recent_count < threshold || circuit.failed_count < circuit.recent_count) {
      return { circuitState: 'CLOSED', circuitDetail: '正常' };
    }

    const lastFailedAt = circuit.last_failed_at;
    if (lastFailedAt === null) {
      return { circuitState: 'CLOSED', circuitDetail: '正常' };
    }

    const remainingMs = cooldownMs - (now.getTime() - lastFailedAt.getTime());
    if (remainingMs <= 0) {
      return { circuitState: 'CLOSED', circuitDetail: '冷却期已结束，等待下一批调用' };
    }

    return {
      circuitState: 'OPEN',
      circuitDetail: `熔断中（剩余 ${Math.ceil(remainingMs / 1000)} 秒），已自动切换备用 provider`,
    };
  }

  private countErrorCode(rows: readonly ErrorStatRow[], code: number): number {
    return rows.find((row) => row.error_code === String(code))?.cnt ?? 0;
  }

  /**
   * 主 provider 的默认模型
   *
   * 用 switch 而不是拼接键路径：`ConfigService.get()` 的 `infer` 依赖**字面量**键，
   * 动态拼接出来的字符串会绕过类型检查（编译期看不出问题，运行期拿到 undefined）。
   */
  private defaultModelOf(defaultProvider: AppConfig['ai']['defaultProvider']): string {
    switch (defaultProvider) {
      case 'openai':
        return this.configService.get('ai.openai.defaultModel', { infer: true });
      case 'qwen':
        return this.configService.get('ai.qwen.defaultModel', { infer: true });
      case 'deepseek':
      default:
        return this.configService.get('ai.deepseek.defaultModel', { infer: true });
    }
  }

  /** 告警：预算 + 熔断（契约 §3.14.7.1 规则 1/2 与企业微信告警联动） */
  private buildAlerts(
    todayUsageRatio: number,
    todayCostCents: number,
    dailyBudgetCents: number,
    providerRows: readonly ProviderStatRow[],
    circuitByKey: ReadonlyMap<string, CircuitRow>,
    now: Date,
  ): AiAlert[] {
    const alerts: AiAlert[] = [];

    if (todayUsageRatio >= BUDGET_CRITICAL_RATIO) {
      alerts.push({
        level: 'CRITICAL',
        code: 'AI_BUDGET_EXHAUSTED',
        message: `当日 AI 成本 ${formatCents(todayCostCents)} 已达预算 ${formatCents(dailyBudgetCents)}，AI 调用将返回 50007`,
        triggeredAt: now.toISOString(),
      });
    } else if (todayUsageRatio >= BUDGET_WARNING_RATIO) {
      alerts.push({
        level: 'WARNING',
        code: 'AI_BUDGET_WARNING',
        message: `当日 AI 成本已达预算的 ${Math.round(todayUsageRatio * 100)}%，请关注`,
        triggeredAt: now.toISOString(),
      });
    }

    for (const row of providerRows) {
      const circuit = circuitByKey.get(`${row.provider}:${row.model}`.toLowerCase());
      const described = this.describeCircuit(circuit, now);

      if (described.circuitState === 'OPEN') {
        alerts.push({
          level: 'WARNING',
          code: 'PROVIDER_CIRCUIT_OPEN',
          message: `${row.provider.toLowerCase()}/${row.model} ${described.circuitDetail}`,
          triggeredAt: (circuit?.last_failed_at ?? now).toISOString(),
        });
      }
    }

    return alerts;
  }
}
