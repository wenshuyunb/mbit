/**
 * 管理端 AI 成本统计服务（契约 §3.14.7.3）
 *
 * ## 口径
 *
 * `costCents` 一律来自 `ai_usage_logs.cost_amount`（写入端按 provider 价目表换算，
 * 架构 §10.2），全流程整数分，无浮点。
 *
 * 时区口径与总览一致：**UTC 自然日**（见 `admin-ai-stats.util.ts` 文件头）。
 *
 * ## 索引
 *
 * | 查询          | 数据源                | 命中索引                             |
 * | ------------- | --------------------- | ------------------------------------ |
 * | 分维度成本    | `ai_usage_logs`       | `[usageDate, taskType]` / `[provider, usageDate]` |
 * | 日成本曲线    | `ai_usage_logs`       | `[usageDate, taskType]`              |
 * | 单报告成本    | `ai_reports`          | `[status, createdAt]`                |
 * | 期内营收      | `orders`              | `paidAt` **无索引**（见下方说明）    |
 *
 * ⚠ `orders` 表**没有 `paid_at` 索引**（schema 不可改），因此毛利估算里的期内营收
 * 是一次无索引范围扫描。它被限制在统计接口的默认频次（300 次/60s）下，
 * 且只取 `SUM`；上线前建议补 `@@index([paidAt])` 或改用 `createdAt` 近似 ——
 * 已在交付简报中列为待办。
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import type { AppConfig } from '../../../config/config.type';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  aiTaskName,
  formatCents,
  maskNickname,
  resolveRequiredRange,
  roundTo,
  safeRatio,
  toDateKey,
  toProviderName,
  toSafeNumber,
  type ResolvedRange,
} from './admin-ai-stats.util';
import { AdminAiStatsService } from './admin-ai-stats.service';
import type { AiCostsQueryDto, CostsGroupBy } from './dto/admin-ai-stats.dto';

/** 期内营收：与 AI 成本同期对比（契约 §3.14.7.3 的 `grossMarginEstimate`） */
const PAID_ORDER_STATUSES = ['PAID', 'FULFILLED', 'PARTIAL_REFUNDED'] as const;

/** 月预算折算天数（与总览保持一致：日预算 × 30） */
const DAYS_PER_MONTH = 30;

/** 单报告成本目标（分）：契约示例给出 MBTI 15 / 关系 20 / 成长 25 */
const REPORT_COST_TARGETS: Readonly<Record<string, number>> = {
  MBTI_REPORT: 15,
  RELATIONSHIP_REPORT: 20,
  GROWTH_REPORT: 25,
  GROWTH_SUMMARY: 25,
};

/** 对话单条成本目标（分）：契约示例 2.0 */
const CHAT_MESSAGE_COST_TARGET_CENTS = 2;

/** 成本异常阈值 */
const COST_SPIKE_RATIO = 1.2;
const UNIT_COST_DEVIATION_RATIO = 1.15;
/** 单用户异常消费判定：高于平均用户的该倍数（契约 R10「被恶意刷 AI 接口」对策） */
const TOP_USER_ANOMALY_MULTIPLIER = 5;

// ============================================================================
// 视图类型
// ============================================================================

/** `rows[]` 项 */
export interface AiCostRow {
  date?: string;
  provider?: string;
  model?: string;
  task?: string;
  taskName?: string;
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
  costDisplay: string;
  costPerCallCents: number;
  costPer1kTokensCents: number;
}

/** `budget` 块 */
export interface AiCostBudget {
  dailyBudgetCents: number;
  dailyCosts: Array<{ date: string; costCents: number; usageRatio: number }>;
  averageDailyCostCents: number;
  projectedMonthlyCostCents: number;
  monthlyBudgetCents: number;
  monthlyUsageRatio: number;
  daysUntilMonthlyBudgetExhausted: number | null;
}

/** 单位经济模型 */
export interface AiUnitEconomics {
  costPerReportCents: Record<string, { value: number; target: number; status: string; note: string }>;
  costPerChatMessageCents: { value: number; target: number; status: string; note: string };
  costPerActiveUserCents: { value: number; period: string; note: string };
  grossMarginEstimate: { periodRevenue: number; periodAiCost: number; aiCostRatio: number; note: string };
}

/** 成本异常项 */
export interface AiCostAnomaly {
  date: string;
  type: string;
  severity: string;
  detail: string;
  affectedProvider?: string;
  affectedPromptKey?: string;
  affectedPromptVersion?: number;
  suggestion: string;
}

/** 高消费用户项 */
export interface AiTopCostUser {
  userId: string;
  nicknameMasked: string | null;
  callCount: number;
  totalTokens: number;
  costCents: number;
  costDisplay: string;
  isAnomaly: boolean;
  anomalyReason?: string;
  plan: string;
}

/** 成本响应（契约 §3.14.7.3） */
export interface AiCostsView {
  startTime: string;
  endTime: string;
  groupBy: CostsGroupBy[];
  rows: AiCostRow[];
  rowCount: number;
  totals: {
    callCount: number;
    totalTokens: number;
    costCents: number;
    costDisplay: string;
    costPerCallCents: number;
    costPer1kTokensCents: number;
  };
  budget: AiCostBudget;
  unitEconomics?: AiUnitEconomics;
  anomalies?: AiCostAnomaly[];
  topCostUsers: AiTopCostUser[];
  notes: string[];
}

// ============================================================================
// raw 行类型
// ============================================================================

interface CostGroupRow {
  d1: string | null;
  d2: string | null;
  d3: string | null;
  d4: string | null;
  call_count: number;
  prompt_tokens: bigint;
  completion_tokens: bigint;
  total_tokens: bigint;
  cost_cents: bigint;
}

interface DailyCostRow {
  date: string;
  cost_cents: bigint;
}

interface ReportTypeCostRow {
  type: string;
  total_cost: bigint;
  report_count: number;
}

interface TopUserRow {
  user_id: string | null;
  call_count: number;
  total_tokens: bigint;
  cost_cents: bigint;
}

@Injectable()
export class AdminAiCostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly stats: AdminAiStatsService,
  ) {}

  async getCosts(query: AiCostsQueryDto): Promise<AiCostsView> {
    const range = resolveRequiredRange(query.startTime, query.endTime);
    const groupBy: CostsGroupBy[] = query.groupBy !== undefined && query.groupBy.length > 0 ? query.groupBy : ['DATE'];
    const dimensions = this.orderDimensions(groupBy);
    const includeUnitEconomics = query.includeUnitEconomics ?? true;
    const includeAnomalies = query.includeAnomalies ?? true;

    const dailyBudgetCents = this.configService.get('ai.dailyCostBudgetCents', { infer: true });
    const monthlyBudgetCents = dailyBudgetCents * DAYS_PER_MONTH;

    const [rows, totalsRow, dailyCosts, unitEconomics, topCostUsers] = await Promise.all([
      this.loadCostGroups(range, dimensions),
      this.stats.loadUsageTotals(range, undefined),
      this.loadDailyCosts(range, dailyBudgetCents),
      includeUnitEconomics ? this.loadUnitEconomics(range) : Promise.resolve(undefined),
      this.loadTopCostUsers(range),
    ]);

    const totalCostCents = toSafeNumber(totalsRow.cost_cents);
    const totalTokens = toSafeNumber(totalsRow.total_tokens);
    const callCount = totalsRow.call_count;

    const averageDailyCostCents =
      dailyCosts.length === 0
        ? 0
        : Math.round(dailyCosts.reduce((sum, item) => sum + item.costCents, 0) / dailyCosts.length);

    const projectedMonthlyCostCents = averageDailyCostCents * DAYS_PER_MONTH;
    const remainingMonthlyBudget = monthlyBudgetCents - projectedMonthlyCostCents;

    return {
      startTime: range.rangeStart.toISOString(),
      endTime: range.rangeEnd.toISOString(),
      groupBy: dimensions,
      rows: rows.map((row) => this.toCostRow(row, dimensions)),
      rowCount: rows.length,
      totals: {
        callCount,
        totalTokens,
        costCents: totalCostCents,
        costDisplay: formatCents(totalCostCents),
        costPerCallCents: safeRatio(totalCostCents, callCount, 2),
        costPer1kTokensCents: safeRatio(totalCostCents, totalTokens / 1_000, 2),
      },
      budget: {
        dailyBudgetCents,
        dailyCosts,
        averageDailyCostCents,
        projectedMonthlyCostCents,
        monthlyBudgetCents,
        monthlyUsageRatio: safeRatio(projectedMonthlyCostCents, monthlyBudgetCents),
        // 只有在「按当前日均会超预算」时才给天数，否则业务上无意义（不是「永不为空」）
        daysUntilMonthlyBudgetExhausted:
          averageDailyCostCents > 0 && remainingMonthlyBudget > 0
            ? Math.floor(remainingMonthlyBudget / averageDailyCostCents)
            : null,
      },
      ...(unitEconomics !== undefined ? { unitEconomics } : {}),
      ...(includeAnomalies ? { anomalies: this.detectAnomalies(range, dailyCosts, rows, dimensions) } : {}),
      topCostUsers,
      notes: [
        '成本数据来自 ai_usage_logs.cost_amount（整数分），按 provider 价目表换算，与账单可能存在时区与汇率差异。',
        '按日聚合使用 ai_usage_logs.usage_date（UTC 日历日，写入时截断），非北京时间自然日。',
        'PROMPT_TEST 任务的成本计入运营成本，不计入用户成本统计。',
        '月预算无独立配置项，按日预算 × 30 折算（已在交付简报中标注）。',
      ],
    };
  }

  // ==========================================================================
  // 聚合查询
  // ==========================================================================

  /** 分维度成本（维度白名单：DATE / PROVIDER / MODEL / TASK） */
  private async loadCostGroups(range: ResolvedRange, dimensions: readonly CostsGroupBy[]): Promise<CostGroupRow[]> {
    const selectDims = dimensions.map(
      (dimension, index) =>
        Prisma.sql`${Prisma.raw(this.dimensionExpression(dimension))} AS ${Prisma.raw(`d${index + 1}`)}`,
    );

    const groupOrdinals = dimensions.map((_, index) => Prisma.raw(String(index + 1)));

    return this.prisma.$queryRaw<CostGroupRow[]>(Prisma.sql`
      SELECT
        ${Prisma.join(selectDims, ', ')},
        count(*)::int AS call_count,
        coalesce(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
        coalesce(sum(completion_tokens), 0)::bigint AS completion_tokens,
        coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(cost_amount), 0)::bigint AS cost_cents
      FROM ai_usage_logs
      WHERE usage_date >= ${toDateKey(range.rangeStart)}::date
        AND usage_date <= ${toDateKey(range.rangeEnd)}::date
      GROUP BY ${Prisma.join(groupOrdinals, ', ')}
      ORDER BY 1 ASC
    `);
  }

  /** 日成本曲线 + 预算占比 */
  private async loadDailyCosts(
    range: ResolvedRange,
    dailyBudgetCents: number,
  ): Promise<Array<{ date: string; costCents: number; usageRatio: number }>> {
    const rows = await this.prisma.$queryRaw<DailyCostRow[]>(Prisma.sql`
      SELECT
        to_char(usage_date, 'YYYY-MM-DD') AS date,
        coalesce(sum(cost_amount), 0)::bigint AS cost_cents
      FROM ai_usage_logs
      WHERE usage_date >= ${toDateKey(range.rangeStart)}::date
        AND usage_date <= ${toDateKey(range.rangeEnd)}::date
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    return rows.map((row) => {
      const costCents = toSafeNumber(row.cost_cents);
      return { date: row.date, costCents, usageRatio: safeRatio(costCents, dailyBudgetCents) };
    });
  }

  /**
   * 单位经济模型
   *
   * 单报告成本 = 期内「已成功报告」的 AI 成本均值（按报告类型分组），
   * 而不是「报告任务的成本 / 报告数」—— 后者会把失败重试的成本摊进成功报告，
   * 掩盖「重试率上升导致单位成本恶化」这一最需要被看到的信号。
   * （当前 schema 的成本记在报告行上，本实现即为此口径；已在此显式说明。）
   */
  private async loadUnitEconomics(range: ResolvedRange): Promise<AiUnitEconomics> {
    const [reportRows, chatRow, overallRow, grossRevenue] = await Promise.all([
      this.prisma.$queryRaw<ReportTypeCostRow[]>(Prisma.sql`
        SELECT
          type::text AS type,
          coalesce(sum(cost_amount), 0)::bigint AS total_cost,
          count(*)::int AS report_count
        FROM ai_reports
        WHERE created_at >= ${range.rangeStart} AND created_at <= ${range.rangeEnd}
          AND deleted_at IS NULL
          AND status = 'SUCCEEDED'
        GROUP BY type
      `),
      this.stats.loadUsageTotals(range, ['AI_COMPANION']),
      this.stats.loadUsageTotals(range, undefined),
      this.loadPeriodRevenue(range),
    ]);

    const costPerReportCents: AiUnitEconomics['costPerReportCents'] = {};

    for (const row of reportRows) {
      const target = REPORT_COST_TARGETS[row.type] ?? 15;
      const value = safeRatio(toSafeNumber(row.total_cost), row.report_count, 2);
      const status = reportCostStatus(value, target);

      costPerReportCents[row.type] = {
        value,
        target,
        status,
        note:
          status === 'WITHIN_TARGET'
            ? `优于目标（架构 1.4：AI 单报告成本 ≤ ¥${(target / 100).toFixed(2)}）`
            : `超出目标 ¥${(target / 100).toFixed(2)}，建议检查 Prompt 长度与重试率`,
      };
    }

    const chatValue = safeRatio(toSafeNumber(chatRow.cost_cents), chatRow.call_count, 2);
    const periodAiCost = toSafeNumber(overallRow.cost_cents);
    const periodDays = Math.max(1, Math.round((range.rangeEnd.getTime() - range.rangeStart.getTime()) / 86_400_000));

    return {
      costPerReportCents,
      costPerChatMessageCents: {
        value: chatValue,
        target: CHAT_MESSAGE_COST_TARGET_CENTS,
        status: chatValue <= CHAT_MESSAGE_COST_TARGET_CENTS ? 'WITHIN_TARGET' : 'OVER_TARGET',
        note: '对话场景上下文装配优化后成本下降',
      },
      costPerActiveUserCents: {
        value: safeRatio(periodAiCost, overallRow.unique_users, 2),
        period: `${periodDays}D`,
        note: '按期内活跃用户摊薄',
      },
      grossMarginEstimate: {
        periodRevenue: grossRevenue,
        periodAiCost,
        aiCostRatio: safeRatio(periodAiCost, grossRevenue),
        note: `AI 成本占期内营收 ${roundTo(safeRatio(periodAiCost, grossRevenue) * 100, 2)}%（目标 < 10%，不含其他成本）`,
      },
    };
  }

  /** 期内营收（仅统计已支付订单的实付金额） */
  private async loadPeriodRevenue(range: ResolvedRange): Promise<number> {
    const result = await this.prisma.order.aggregate({
      where: {
        deletedAt: null,
        // 展开成新数组满足 Prisma 的可变数组要求；状态白名单本身只此一处
        status: { in: [...PAID_ORDER_STATUSES] },
        paidAt: { gte: range.rangeStart, lte: range.rangeEnd },
      },
      _sum: { paidAmount: true },
    });

    return result._sum.paidAmount ?? 0;
  }

  /**
   * 高消费用户 Top N
   *
   * 分页 + 排序都在 SQL 内完成（`ORDER BY cost DESC LIMIT 10`），
   * 再把 `userId` 批量补齐昵称与会员状态，避免逐行查询用户。
   */
  private async loadTopCostUsers(range: ResolvedRange): Promise<AiTopCostUser[]> {
    const rows = await this.prisma.$queryRaw<TopUserRow[]>(Prisma.sql`
      SELECT
        user_id,
        count(*)::int AS call_count,
        coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(cost_amount), 0)::bigint AS cost_cents
      FROM ai_usage_logs
      WHERE usage_date >= ${toDateKey(range.rangeStart)}::date
        AND usage_date <= ${toDateKey(range.rangeEnd)}::date
        AND user_id IS NOT NULL
      GROUP BY user_id
      ORDER BY cost_cents DESC
      LIMIT 10
    `);

    const userIds = rows.map((row) => row.user_id).filter((id): id is string => id !== null);
    if (userIds.length === 0) return [];

    const [users, activeMemberships] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, nickname: true },
      }),
      this.prisma.membership.findMany({
        where: { userId: { in: userIds }, status: 'ACTIVE' },
        select: { userId: true },
      }),
    ]);

    const nicknameById = new Map(users.map((user) => [user.id, user.nickname]));
    const memberIds = new Set(activeMemberships.map((membership) => membership.userId));

    const costs = rows.map((row) => toSafeNumber(row.cost_cents));
    const averageCost = costs.length === 0 ? 0 : costs.reduce((sum, cost) => sum + cost, 0) / costs.length;

    return rows.map((row, index) => {
      const userId = row.user_id ?? '';
      const costCents = costs[index] ?? 0;
      const isAnomaly = averageCost > 0 && costCents > averageCost * TOP_USER_ANOMALY_MULTIPLIER;

      return {
        userId,
        nicknameMasked: maskNickname(nicknameById.get(userId) ?? null),
        callCount: row.call_count,
        totalTokens: toSafeNumber(row.total_tokens),
        costCents,
        costDisplay: formatCents(costCents),
        isAnomaly,
        ...(isAnomaly
          ? {
              anomalyReason: `AI_USAGE_ABOVE_AVERAGE：消费额为平均用户的 ${roundTo(costCents / averageCost, 1)} 倍，已标记风控`,
            }
          : {}),
        plan: memberIds.has(userId) ? 'MEMBERSHIP_ACTIVE' : 'FREE',
      };
    });
  }

  // ==========================================================================
  // 异常检测
  // ==========================================================================

  /**
   * 成本异常检测（契约 §3.14.7.3 规则 2）
   *
   * 两条规则，与契约示例一致：
   *   · `COST_SPIKE`：某日成本高于本区间日均 `COST_SPIKE_RATIO` 倍
   *   · `UNIT_COST_DEVIATION`：某任务单次调用成本高于整体 `UNIT_COST_DEVIATION_RATIO` 倍
   * 规则都基于**本区间自身**的分布 —— 跨区间比较需要历史基线（当前无基线表），
   * 因此不编造「近 7 日均值」这类无法持续获取的口径。
   */
  private detectAnomalies(
    range: ResolvedRange,
    dailyCosts: readonly { date: string; costCents: number }[],
    groupRows: readonly CostGroupRow[],
    dimensions: readonly CostsGroupBy[],
  ): AiCostAnomaly[] {
    const anomalies: AiCostAnomaly[] = [];

    if (dailyCosts.length > 1) {
      const values = dailyCosts.map((item) => item.costCents);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

      if (mean > 0) {
        for (const item of dailyCosts) {
          if (item.costCents <= mean * COST_SPIKE_RATIO) continue;

          anomalies.push({
            date: item.date,
            type: 'COST_SPIKE',
            severity: item.costCents > mean * 1.5 ? 'MEDIUM' : 'LOW',
            detail: `当日成本 ${item.costCents} 分，高于区间日均 ${Math.round(mean)} 分 ${roundTo((item.costCents / mean - 1) * 100, 1)}%`,
            suggestion: '检查当日是否有批量任务或 provider 降级切换；如持续走高，建议调整 ai_task_routing 的降级链',
          });
        }
      }
    }

    // 单位成本偏离：只在按 TASK 分组时才能逐任务比较，否则用整体行集
    if (dimensions.includes('TASK')) {
      const overall = groupRows.reduce((sum, row) => sum + toSafeNumber(row.cost_cents), 0);
      const calls = groupRows.reduce((sum, row) => sum + row.call_count, 0);
      const overallPerCall = safeRatio(overall, calls, 2);

      // 维度顺序已由 orderDimensions 归一（DATE → PROVIDER → MODEL → TASK），
      // 因此 TASK 的值不在固定的 d1 上，必须按它在 dimensions 中的位置取列
      const taskIndex = dimensions.indexOf('TASK');

      if (overallPerCall > 0) {
        for (const row of groupRows) {
          const perCall = safeRatio(toSafeNumber(row.cost_cents), row.call_count, 2);
          if (perCall <= overallPerCall * UNIT_COST_DEVIATION_RATIO) continue;

          const taskName = dimensionValue(row, taskIndex);

          anomalies.push({
            date: toDateKey(range.rangeEnd),
            type: 'UNIT_COST_DEVIATION',
            severity: 'LOW',
            detail: `${taskName} 单次调用成本 ${perCall} 分，高于整体 ${overallPerCall} 分`,
            suggestion: '检查该任务的上下文长度与重试率，必要时切换更经济的模型',
          });
        }
      }
    }

    return anomalies;
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private orderDimensions(requested: readonly CostsGroupBy[]): CostsGroupBy[] {
    const order: CostsGroupBy[] = ['DATE', 'PROVIDER', 'MODEL', 'TASK'];
    const set = new Set(requested);
    return order.filter((dimension) => set.has(dimension));
  }

  private dimensionExpression(dimension: CostsGroupBy): string {
    switch (dimension) {
      case 'DATE':
        return `to_char(usage_date, 'YYYY-MM-DD')`;
      case 'PROVIDER':
        return 'provider::text';
      case 'MODEL':
        return 'model';
      case 'TASK':
        return 'task_type::text';
    }
  }

  private toCostRow(row: CostGroupRow, dimensions: readonly CostsGroupBy[]): AiCostRow {
    const costCents = toSafeNumber(row.cost_cents);
    const totalTokens = toSafeNumber(row.total_tokens);

    const result: AiCostRow = {
      callCount: row.call_count,
      promptTokens: toSafeNumber(row.prompt_tokens),
      completionTokens: toSafeNumber(row.completion_tokens),
      totalTokens,
      costCents,
      costDisplay: formatCents(costCents),
      costPerCallCents: safeRatio(costCents, row.call_count, 2),
      costPer1kTokensCents: safeRatio(costCents, totalTokens / 1_000, 2),
    };

    const values: Array<string | null> = [row.d1, row.d2, row.d3, row.d4];

    dimensions.forEach((dimension, index) => {
      const value = values[index] ?? null;
      if (value === null) return;

      switch (dimension) {
        case 'DATE':
          result.date = value;
          break;
        case 'PROVIDER':
          result.provider = toProviderName(value);
          break;
        case 'MODEL':
          result.model = value;
          break;
        case 'TASK':
          result.task = value;
          result.taskName = aiTaskName(value);
          break;
      }
    });

    return result;
  }
}

/**
 * 单报告成本达标判定
 *
 * 三档而非布尔：`SLIGHTLY_OVER`（超出 20% 以内）与 `OVER_TARGET` 对应的运营动作不同
 * —— 前者先观察，后者要立刻查 Prompt 长度与重试率。
 */
const reportCostStatus = (value: number, target: number): 'WITHIN_TARGET' | 'SLIGHTLY_OVER' | 'OVER_TARGET' => {
  if (value <= target) return 'WITHIN_TARGET';
  if (value <= target * 1.2) return 'SLIGHTLY_OVER';
  return 'OVER_TARGET';
};

/** 按维度序号取 `d1..d4` 中的列值（维度顺序由 `orderDimensions` 归一，固定位置不安全） */
const dimensionValue = (row: CostGroupRow, index: number): string => {
  switch (index) {
    case 0:
      return row.d1 ?? '未知';
    case 1:
      return row.d2 ?? '未知';
    case 2:
      return row.d3 ?? '未知';
    case 3:
      return row.d4 ?? '未知';
    default:
      return '未知';
  }
};
