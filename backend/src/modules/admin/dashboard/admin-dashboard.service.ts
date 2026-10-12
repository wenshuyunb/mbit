/**
 * 管理端北极星指标看板服务（契约 §3.14.9.9）
 *
 * ## 为什么整包缓存 60 秒
 *
 * 契约明确给出 `cachedAt` 与 `cacheTtlSeconds: 60`。看板是**值班监控页**：
 * 多人在同一分钟反复刷新时，重复执行二十余条跨表聚合是纯粹的浪费，而 60 秒的
 * 数据滞后对「看趋势」没有影响。缓存键包含全部影响结果的参数
 * （range / 起止时间 / 粒度 / 是否对比），因此不同筛选条件不会互相污染。
 *
 * ## 数据源缺口（**不是实现遗漏**，已列入交付简报）
 *
 * | 契约字段                        | 现状                                                        |
 * | ------------------------------- | ----------------------------------------------------------- |
 * | `funnel.stages[LAUNCH / LOGIN]` | 无全站访问日志表 → `count` / `rate` 为 `null` 并附 `note`    |
 * | `realtime.onlineUsersEstimate`  | 无在线计数源（需 Redis 计数或请求日志）→ `null`              |
 * | `DAU`                           | 用「当日有 AI 用量记录的去重用户数」作为代理口径             |
 *
 * ## 索引说明
 *
 * `orders.paid_at` 与 `users.created_at` 中只有后者有索引
 * （`[createdAt(sort: Desc)]`）；`paid_at` 的范围扫描走顺序扫描 ——
 * schema 本轮不可改，已在交付简报中列为待补索引项。
 *
 * ## 并行与口径一致
 *
 * 当前周期与前一周期调用**同一个采集函数**：两份口径若各写一遍，几乎必然在某次
 * 迭代后出现「当前算提交时间、上一期算创建时间」这类不对称错误，
 * 而它的表现是「同比数据不可信」，极难定位。
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QUEUE_AI_REPORT, QUEUE_COMPATIBILITY_CALC, QUEUE_EXPORT_DATA } from '../../../infra/queue/queue.module';
import { RedisService } from '../../../infra/redis/redis.service';
import type { AdminDashboardQueryDto } from './dto/admin-dashboard.dto';
import {
  DASHBOARD_CACHE_TTL_SECONDS,
  DashboardRangeError,
  buildFunnel,
  buildMetricView,
  formatCents,
  formatPercentagePointChange,
  metricDefinitionOf,
  previousPeriod,
  resolveDashboardRange,
  safeRatio,
  toSafeNumber,
  trendDirection,
  type DashboardGranularity,
  type DashboardRange,
  type FunnelView,
  type MetricView,
} from './admin-dashboard.util';

/** 计入营收的订单状态 */
const PAID_ORDER_STATUSES = ['PAID', 'FULFILLED', 'PARTIAL_REFUNDED'] as const;

/** 已完成测试的会话状态 */
const COMPLETED_SESSION_STATUSES = ['SUBMITTED', 'SCORED', 'REPORT_READY'] as const;

/** 粒度 → `date_trunc` 字段（白名单映射，运行时值不进入 SQL 文本） */
const TRUNC_UNIT: Readonly<Record<DashboardGranularity, Prisma.Sql>> = {
  DAY: Prisma.raw(`'day'`),
  WEEK: Prisma.raw(`'week'`),
  MONTH: Prisma.raw(`'month'`),
};

/** 趋势序列（契约 §3.14.9.9 的 `trends[]`） */
export interface DashboardTrend {
  key: string;
  name: string;
  unit: string;
  points: Array<{
    date: string;
    value: number;
    displayValue: string;
    numerator?: number;
    denominator?: number;
  }>;
  averageValue: number;
  totalValue?: number;
  target?: number;
  isOnTarget?: boolean;
}

/** 对比块 */
export interface DashboardChangeBlock {
  current: number;
  previous: number;
  change: number;
  changeDisplay: string;
  direction: 'UP' | 'DOWN' | 'FLAT';
}

/** 与前一等长周期的对比 */
export interface DashboardComparison {
  period: string;
  paidConversionRate: DashboardChangeBlock;
  testCompletionRate: DashboardChangeBlock;
  viralCoefficientK: DashboardChangeBlock;
  revenueCents: DashboardChangeBlock;
  newUserCount: DashboardChangeBlock;
  aiCostCents: DashboardChangeBlock;
}

/** 看板响应（契约 §3.14.9.9） */
export interface AdminDashboardView {
  range: DashboardRange;
  rangeStart: string;
  rangeEnd: string;
  granularity: DashboardGranularity;
  generatedAt: string;
  northStar: MetricView;
  keyMetrics: MetricView[];
  funnel: FunnelView;
  trends: DashboardTrend[];
  comparisonWithPrevious?: DashboardComparison;
  realtime: {
    onlineUsersEstimate: number | null;
    activeTestsInProgress: number;
    generatingReports: number;
    pendingOrders: number;
    queueBacklog: Record<string, number>;
    todayAiCostCents: number;
    todayAiCostDisplay: string;
  };
  alerts: Array<{ level: string; message: string; metricKey: string }>;
  cachedAt: string;
  cacheTtlSeconds: number;
}

/** 单周期采集结果（当前周期与前一周期共用同一形状，保证口径一致） */
interface PeriodMetrics {
  paidUsers: number;
  completedTestUsers: number;
  startedSessions: number;
  completedSessions: number;
  invitesSent: number;
  invitesAccepted: number;
  relationshipsActivated: number;
  reportTotal: number;
  reportSucceeded: number;
  reportUnlocked: number;
  memberPurchase: number;
  revenueCents: number;
  aiCostCents: number;
  aiCostPerReportCents: number;
  newUserCount: number;
  lastDayActiveUsers: number;
  expiringMemberships: number;
  renewedMemberships: number;
  safetyBlocked: number;
  safetyTotal: number;
}

interface CountRow {
  cnt: number;
}
interface ConversionTrendRow {
  date: string;
  numerator: number;
  denominator: number;
}
interface PointRow {
  date: string;
  cnt: number;
}
interface RevenuePointRow {
  date: string;
  amount: bigint;
}

@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @InjectQueue(QUEUE_AI_REPORT) private readonly aiReportQueue: Queue,
    @InjectQueue(QUEUE_COMPATIBILITY_CALC) private readonly compatibilityQueue: Queue,
    @InjectQueue(QUEUE_EXPORT_DATA) private readonly exportQueue: Queue,
  ) {}

  async getMetrics(query: AdminDashboardQueryDto): Promise<AdminDashboardView> {
    const granularity: DashboardGranularity = query.granularity ?? 'DAY';
    const compareWithPrevious = query.compareWithPrevious ?? true;

    let range;
    try {
      range = resolveDashboardRange(query.range ?? '7D', query.startTime, query.endTime, new Date());
    } catch (error) {
      // 纯逻辑层不依赖 Nest 与错误码表，参数错误在这里翻译成业务异常
      if (error instanceof DashboardRangeError) {
        throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, error.message);
      }
      throw error;
    }

    const cacheKey = this.redis.key(
      'admin',
      'dashboard',
      'metrics',
      range.key,
      String(range.rangeStart.getTime()),
      String(range.rangeEnd.getTime()),
      granularity,
      compareWithPrevious ? 'cmp' : 'nocmp',
    );

    const cached = await this.redis.getJson<AdminDashboardView>(cacheKey);
    if (cached !== null) return cached;

    const previous = previousPeriod(range);
    const now = new Date();

    const [current, previousMetrics, trends, realtime] = await Promise.all([
      this.collectPeriod(range.rangeStart, range.rangeEnd),
      compareWithPrevious ? this.collectPeriod(previous.start, previous.end) : Promise.resolve(null),
      this.collectTrends(range.rangeStart, range.rangeEnd, granularity),
      this.collectRealtime(),
    ]);

    const view = this.assembleView({
      range,
      granularity,
      now,
      current,
      previous: previousMetrics,
      previousRange: previous,
      trends,
      realtime,
      compareWithPrevious,
    });

    // 缓存写入失败不影响响应：缓存是旁路，不是数据源
    await this.redis.setJson(cacheKey, view, DASHBOARD_CACHE_TTL_SECONDS).catch((error: Error) => {
      this.logger.warn(`看板缓存写入失败 key=${cacheKey}: ${error.message}`);
    });

    return view;
  }

  // ==========================================================================
  // 组装
  // ==========================================================================

  private assembleView(input: {
    range: { key: DashboardRange; rangeStart: Date; rangeEnd: Date };
    granularity: DashboardGranularity;
    now: Date;
    current: PeriodMetrics;
    previous: PeriodMetrics | null;
    previousRange: { start: Date; end: Date };
    trends: DashboardTrend[];
    realtime: AdminDashboardView['realtime'];
    compareWithPrevious: boolean;
  }): AdminDashboardView {
    const { current, previous, range, now } = input;

    const paidConversionRate = safeRatio(current.paidUsers, current.completedTestUsers);
    const testCompletionRate = safeRatio(current.completedSessions, current.startedSessions);
    const viralCoefficient = safeRatio(current.invitesAccepted, current.completedTestUsers);
    const reportSuccessRate = safeRatio(current.reportSucceeded, current.reportTotal);
    const arpuCents = current.paidUsers === 0 ? 0 : Math.round(current.revenueCents / current.paidUsers);
    const memberRetention = safeRatio(current.renewedMemberships, current.expiringMemberships);
    const safetyBlockRate = safeRatio(current.safetyBlocked, current.safetyTotal);

    const northStar = buildMetricView({
      definition: metricDefinitionOf('PAID_CONVERSION_RATE'),
      value: paidConversionRate,
      previousValue: previous === null ? null : safeRatio(previous.paidUsers, previous.completedTestUsers),
      parts: {
        numerator: { label: '付费用户数', value: current.paidUsers },
        denominator: { label: '完成测试用户数', value: current.completedTestUsers },
      },
    });

    const keyMetrics: MetricView[] = [
      buildMetricView({
        definition: metricDefinitionOf('TEST_COMPLETION_RATE'),
        value: testCompletionRate,
        previousValue: previous === null ? null : safeRatio(previous.completedSessions, previous.startedSessions),
        parts: {
          numerator: { label: '完成提交会话数', value: current.completedSessions },
          denominator: { label: '开始测试会话数', value: current.startedSessions },
        },
      }),
      buildMetricView({
        definition: metricDefinitionOf('VIRAL_COEFFICIENT_K'),
        value: viralCoefficient,
        previousValue: previous === null ? null : safeRatio(previous.invitesAccepted, previous.completedTestUsers),
        parts: {
          numerator: { label: '有效邀请数（被接受）', value: current.invitesAccepted },
          denominator: { label: '完成测试用户数', value: current.completedTestUsers },
        },
      }),
      buildMetricView({
        definition: metricDefinitionOf('AI_REPORT_SUCCESS_RATE'),
        value: reportSuccessRate,
        previousValue: previous === null ? null : safeRatio(previous.reportSucceeded, previous.reportTotal),
        parts: {
          numerator: { label: '成功报告数', value: current.reportSucceeded },
          denominator: { label: '报告请求总数', value: current.reportTotal },
        },
      }),
      buildMetricView({
        definition: metricDefinitionOf('AI_COST_PER_REPORT_CENTS'),
        value: current.aiCostPerReportCents,
        previousValue: previous === null ? null : previous.aiCostPerReportCents,
      }),
      buildMetricView({
        definition: metricDefinitionOf('ARPU_CENTS'),
        value: arpuCents,
        previousValue:
          previous === null || previous.paidUsers === 0 ? null : Math.round(previous.revenueCents / previous.paidUsers),
        parts: { numerator: { label: '期内营收', value: current.revenueCents }, denominator: null },
      }),
      buildMetricView({
        definition: metricDefinitionOf('DAU'),
        value: current.lastDayActiveUsers,
        previousValue: previous === null ? null : previous.lastDayActiveUsers,
      }),
      buildMetricView({
        definition: metricDefinitionOf('MEMBER_RETENTION_RATE'),
        value: memberRetention,
        previousValue: previous === null ? null : safeRatio(previous.renewedMemberships, previous.expiringMemberships),
        parts: {
          numerator: { label: '续费会员数', value: current.renewedMemberships },
          denominator: { label: '期内到期会员数', value: current.expiringMemberships },
        },
      }),
      buildMetricView({
        definition: metricDefinitionOf('AI_SAFETY_BLOCK_RATE'),
        value: safetyBlockRate,
        previousValue: previous === null ? null : safeRatio(previous.safetyBlocked, previous.safetyTotal),
        parts: {
          numerator: { label: '命中拦截调用数', value: current.safetyBlocked },
          denominator: { label: 'AI 调用总数', value: current.safetyTotal },
        },
      }),
    ];

    const funnel = buildFunnel({
      // LAUNCH / LOGIN 没有数据源：显式置 null，由 buildFunnel 标注「无数据源」，
      // 🚫 不用 0 冒充「没人用」—— 那会让运营去排查一个并不存在的流失问题
      LAUNCH: null,
      LOGIN: null,
      TEST_START: current.startedSessions,
      TEST_COMPLETE: current.completedSessions,
      REPORT_GENERATE: current.reportTotal,
      REPORT_UNLOCK: current.reportUnlocked,
      INVITE_SENT: current.invitesSent,
      RELATIONSHIP_ACTIVE: current.relationshipsActivated,
      MEMBER_PURCHASE: current.memberPurchase,
    });

    const previousReportSuccessRate =
      previous === null ? null : safeRatio(previous.reportSucceeded, previous.reportTotal);

    return {
      range: range.key,
      rangeStart: range.rangeStart.toISOString(),
      rangeEnd: range.rangeEnd.toISOString(),
      granularity: input.granularity,
      generatedAt: now.toISOString(),
      northStar,
      keyMetrics,
      funnel,
      trends: input.trends,
      ...(input.compareWithPrevious && previous !== null
        ? {
            comparisonWithPrevious: this.buildComparison(
              current,
              previous,
              input.previousRange,
              paidConversionRate,
              testCompletionRate,
              viralCoefficient,
            ),
          }
        : {}),
      realtime: input.realtime,
      alerts: this.buildAlerts(funnel, reportSuccessRate, previousReportSuccessRate),
      cachedAt: now.toISOString(),
      cacheTtlSeconds: DASHBOARD_CACHE_TTL_SECONDS,
    };
  }

  private buildComparison(
    current: PeriodMetrics,
    previous: PeriodMetrics,
    previousRange: { start: Date; end: Date },
    paidConversionRate: number,
    testCompletionRate: number,
    viralCoefficient: number,
  ): DashboardComparison {
    return {
      period: `${previousRange.start.toISOString()} ~ ${previousRange.end.toISOString()}`,
      paidConversionRate: changeBlock(
        paidConversionRate,
        safeRatio(previous.paidUsers, previous.completedTestUsers),
        'percent',
      ),
      testCompletionRate: changeBlock(
        testCompletionRate,
        safeRatio(previous.completedSessions, previous.startedSessions),
        'percent',
      ),
      viralCoefficientK: changeBlock(
        viralCoefficient,
        safeRatio(previous.invitesAccepted, previous.completedTestUsers),
        'ratio',
      ),
      revenueCents: changeBlock(current.revenueCents, previous.revenueCents, 'cent'),
      newUserCount: changeBlock(current.newUserCount, previous.newUserCount, 'count'),
      aiCostCents: changeBlock(current.aiCostCents, previous.aiCostCents, 'cent'),
    };
  }

  /** 告警：最大流失点 + 报告成功率下滑（契约示例的两条 INFO/WARNING） */
  private buildAlerts(
    funnel: FunnelView,
    reportSuccessRate: number,
    previousReportSuccessRate: number | null,
  ): Array<{ level: string; message: string; metricKey: string }> {
    const alerts: Array<{ level: string; message: string; metricKey: string }> = [];

    if (funnel.biggestDropOff !== null) {
      alerts.push({
        level: 'INFO',
        message: `「${funnel.biggestDropOff.from} → ${funnel.biggestDropOff.to}」流失率 ${(
          funnel.biggestDropOff.dropOffRate * 100
        ).toFixed(1)}%，为漏斗最大流失点，建议优化该环节引导。`,
        metricKey: `${funnel.biggestDropOff.to}_DROPOFF`,
      });
    }

    const target = metricDefinitionOf('AI_REPORT_SUCCESS_RATE').target ?? 0.99;
    if (previousReportSuccessRate !== null && reportSuccessRate < previousReportSuccessRate) {
      const drop = (previousReportSuccessRate - reportSuccessRate) * 100;
      alerts.push({
        level: reportSuccessRate < target ? 'WARNING' : 'INFO',
        message: `AI 报告生成成功率 ${(reportSuccessRate * 100).toFixed(2)}%，较上周期下降 ${drop.toFixed(
          2,
        )}pp，建议关注 provider 稳定性。`,
        metricKey: 'AI_REPORT_SUCCESS_RATE',
      });
    }

    return alerts;
  }

  // ==========================================================================
  // 采集
  // ==========================================================================

  /** 采集单个周期的全部指标（当前周期与前一周期共用） */
  private async collectPeriod(start: Date, end: Date): Promise<PeriodMetrics> {
    const [
      paidUsers,
      completedTestUsers,
      startedSessions,
      completedSessions,
      invitesSent,
      invitesAccepted,
      relationshipsActivated,
      reportTotal,
      reportSucceeded,
      reportUnlocked,
      memberPurchase,
      revenueAggregate,
      aiCostAggregate,
      reportCostAverage,
      newUserCount,
      lastDayActiveUsers,
      expiringMemberships,
      renewedMemberships,
      safetyBlocked,
      safetyTotal,
    ] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT count(DISTINCT user_id)::int AS cnt
        FROM orders
        WHERE deleted_at IS NULL AND paid_at >= ${start} AND paid_at <= ${end}
          AND status::text IN (${Prisma.join([...PAID_ORDER_STATUSES])})
      `),
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT count(DISTINCT user_id)::int AS cnt
        FROM test_sessions
        WHERE deleted_at IS NULL AND submitted_at >= ${start} AND submitted_at <= ${end}
          AND status::text IN (${Prisma.join([...COMPLETED_SESSION_STATUSES])})
      `),
      this.prisma.testSession.count({ where: { deletedAt: null, createdAt: { gte: start, lte: end } } }),
      this.prisma.testSession.count({
        where: {
          deletedAt: null,
          submittedAt: { gte: start, lte: end },
          status: { in: [...COMPLETED_SESSION_STATUSES] },
        },
      }),
      this.prisma.relationshipInvite.count({ where: { deletedAt: null, createdAt: { gte: start, lte: end } } }),
      this.prisma.relationshipInvite.count({
        where: { deletedAt: null, status: 'ACCEPTED', acceptedAt: { gte: start, lte: end } },
      }),
      this.prisma.relationship.count({
        where: { deletedAt: null, status: 'ACTIVE', confirmedAt: { gte: start, lte: end } },
      }),
      this.prisma.aiReport.count({ where: { deletedAt: null, createdAt: { gte: start, lte: end } } }),
      this.prisma.aiReport.count({
        where: { deletedAt: null, createdAt: { gte: start, lte: end }, status: 'SUCCEEDED' },
      }),
      this.prisma.entitlement.count({ where: { deletedAt: null, createdAt: { gte: start, lte: end } } }),
      this.prisma.order.count({
        where: {
          deletedAt: null,
          productType: 'MEMBERSHIP',
          status: { in: [...PAID_ORDER_STATUSES] },
          paidAt: { gte: start, lte: end },
        },
      }),
      this.prisma.order.aggregate({
        where: { deletedAt: null, status: { in: [...PAID_ORDER_STATUSES] }, paidAt: { gte: start, lte: end } },
        _sum: { paidAmount: true },
      }),
      this.prisma.aiUsageLog.aggregate({
        where: { usageDate: { gte: startOfDayUtc(start), lte: startOfDayUtc(end) } },
        _sum: { costAmount: true },
      }),
      this.prisma.aiReport.aggregate({
        where: { deletedAt: null, createdAt: { gte: start, lte: end }, status: 'SUCCEEDED' },
        _avg: { costAmount: true },
      }),
      this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: start, lte: end } } }),
      this.countActiveUsersOnDay(end),
      this.prisma.membership.count({ where: { deletedAt: null, expireAt: { gte: start, lte: end } } }),
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT count(DISTINCT m.user_id)::int AS cnt
        FROM memberships m
        WHERE m.deleted_at IS NULL AND m.expire_at >= ${start} AND m.expire_at <= ${end}
          AND EXISTS (
            SELECT 1 FROM memberships m2
            WHERE m2.user_id = m.user_id AND m2.deleted_at IS NULL AND m2.created_at > m.expire_at
          )
      `),
      this.prisma.aiCallAudit.count({ where: { createdAt: { gte: start, lte: end }, status: 'BLOCKED' } }),
      this.prisma.aiCallAudit.count({ where: { createdAt: { gte: start, lte: end } } }),
    ]);

    return {
      paidUsers: paidUsers[0]?.cnt ?? 0,
      completedTestUsers: completedTestUsers[0]?.cnt ?? 0,
      startedSessions,
      completedSessions,
      invitesSent,
      invitesAccepted,
      relationshipsActivated,
      reportTotal,
      reportSucceeded,
      reportUnlocked,
      memberPurchase,
      revenueCents: revenueAggregate._sum.paidAmount ?? 0,
      aiCostCents: aiCostAggregate._sum.costAmount ?? 0,
      aiCostPerReportCents: reportCostAverage._avg.costAmount ?? 0,
      newUserCount,
      lastDayActiveUsers,
      expiringMemberships,
      renewedMemberships: renewedMemberships[0]?.cnt ?? 0,
      safetyBlocked,
      safetyTotal,
    };
  }

  /**
   * 「当日活跃用户」代理口径
   *
   * 全站请求日志表不存在，因此用「该日有 AI 用量记录的去重用户数」近似 DAU。
   * 它**只覆盖使用过 AI 的用户**，会系统性低估真实 DAU —— 这一偏差必须显式写在
   * 指标 `definition` 与 `note` 里（见 `METRIC_DEFINITIONS.DAU`），
   * 否则运营会拿它和第三方统计对不上账。
   */
  private async countActiveUsersOnDay(day: Date): Promise<number> {
    const dateKey = startOfDayUtc(day);

    const rows = await this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(DISTINCT user_id)::int AS cnt
      FROM ai_usage_logs
      WHERE usage_date = ${dateKey}::date AND user_id IS NOT NULL
    `);

    return rows[0]?.cnt ?? 0;
  }

  /**
   * 趋势序列
   *
   * 三条 SQL 各自按 `date_trunc` 切桶；**UTC 口径**：先 `AT TIME ZONE 'UTC'` 再截断，
   * 否则聚合会跟随会话时区，与 `rangeStart` 的 UTC 零点边界不一致
   * （表现为「趋势首点比范围起点早 8 小时」这类难查的偏差）。
   */
  private async collectTrends(start: Date, end: Date, granularity: DashboardGranularity): Promise<DashboardTrend[]> {
    const unit = TRUNC_UNIT[granularity];
    const paidStatuses = Prisma.join([...PAID_ORDER_STATUSES]);
    const completedStatuses = Prisma.join([...COMPLETED_SESSION_STATUSES]);

    const [conversionRows, newUserRows, revenueRows] = await Promise.all([
      this.prisma.$queryRaw<ConversionTrendRow[]>(Prisma.sql`
        WITH paid AS (
          SELECT date_trunc(${unit}, paid_at AT TIME ZONE 'UTC') AS bucket, count(DISTINCT user_id)::int AS cnt
          FROM orders
          WHERE deleted_at IS NULL AND paid_at >= ${start} AND paid_at <= ${end}
            AND status::text IN (${paidStatuses})
          GROUP BY 1
        ), tested AS (
          SELECT date_trunc(${unit}, submitted_at AT TIME ZONE 'UTC') AS bucket, count(DISTINCT user_id)::int AS cnt
          FROM test_sessions
          WHERE deleted_at IS NULL AND submitted_at >= ${start} AND submitted_at <= ${end}
            AND status::text IN (${completedStatuses})
          GROUP BY 1
        )
        SELECT
          to_char(t.bucket, 'YYYY-MM-DD') AS date,
          coalesce(p.cnt, 0)::int AS numerator,
          t.cnt::int AS denominator
        FROM tested t
        LEFT JOIN paid p ON p.bucket = t.bucket
        ORDER BY 1 ASC
      `),
      this.prisma.$queryRaw<PointRow[]>(Prisma.sql`
        SELECT
          to_char(date_trunc(${unit}, created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
          count(*)::int AS cnt
        FROM users
        WHERE deleted_at IS NULL AND created_at >= ${start} AND created_at <= ${end}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.prisma.$queryRaw<RevenuePointRow[]>(Prisma.sql`
        SELECT
          to_char(date_trunc(${unit}, paid_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
          coalesce(sum(paid_amount), 0)::bigint AS amount
        FROM orders
        WHERE deleted_at IS NULL AND paid_at >= ${start} AND paid_at <= ${end}
          AND status::text IN (${paidStatuses})
        GROUP BY 1
        ORDER BY 1 ASC
      `),
    ]);

    const conversionPoints = conversionRows.map((row) => {
      const value = safeRatio(row.numerator, row.denominator);
      return {
        date: row.date,
        value,
        displayValue: `${(value * 100).toFixed(2)}%`,
        numerator: row.numerator,
        denominator: row.denominator,
      };
    });

    const newUserPoints = newUserRows.map((row) => ({
      date: row.date,
      value: row.cnt,
      displayValue: String(row.cnt),
    }));

    // 聚合值是 `bigint`（Prisma 映射为 JS BigInt），必须显式转 number：
    // BigInt 一旦进入响应体，`JSON.stringify` 会直接抛错（整个接口 500，而非某字段异常）
    const revenuePoints = revenueRows.map((row) => {
      const amount = toSafeNumber(row.amount);
      return { date: row.date, value: amount, displayValue: formatCents(amount) };
    });

    const conversionAverage = averageOf(conversionPoints.map((point) => point.value));
    const conversionTarget = metricDefinitionOf('PAID_CONVERSION_RATE').target ?? 0.05;

    return [
      {
        key: 'PAID_CONVERSION_RATE',
        name: '付费转化率',
        unit: 'PERCENT',
        points: conversionPoints,
        averageValue: conversionAverage,
        target: conversionTarget,
        isOnTarget: conversionAverage >= conversionTarget,
      },
      {
        key: 'NEW_USER_COUNT',
        name: '新增用户',
        unit: 'COUNT',
        points: newUserPoints,
        averageValue: Math.round(averageOf(newUserPoints.map((point) => point.value))),
        totalValue: newUserPoints.reduce((sum, point) => sum + point.value, 0),
      },
      {
        key: 'REVENUE_CENTS',
        name: '营收',
        unit: 'CENT',
        points: revenuePoints,
        averageValue: Math.round(averageOf(revenuePoints.map((point) => point.value))),
        totalValue: revenuePoints.reduce((sum, point) => sum + point.value, 0),
      },
    ];
  }

  /**
   * 实时块
   *
   * `onlineUsersEstimate` 缺少数据源（无全站访问日志、无在线计数 Redis 键），
   * 返回 `null` 而不是编造数字 —— 值班同事据此判断是否需要扩容，
   * 一个假的在线数比没有更危险。
   */
  private async collectRealtime(): Promise<AdminDashboardView['realtime']> {
    const today = startOfDayUtc(new Date());

    const [activeTestsInProgress, generatingReports, pendingOrders, todayCost, backlog] = await Promise.all([
      this.prisma.testSession.count({ where: { deletedAt: null, status: 'IN_PROGRESS' } }),
      this.prisma.aiReport.count({ where: { deletedAt: null, status: 'GENERATING' } }),
      this.prisma.order.count({ where: { deletedAt: null, status: { in: ['CREATED', 'PENDING_PAY'] } } }),
      this.prisma.aiUsageLog.aggregate({ where: { usageDate: today }, _sum: { costAmount: true } }),
      this.loadQueueBacklog(),
    ]);

    const todayAiCostCents = todayCost._sum.costAmount ?? 0;

    return {
      onlineUsersEstimate: null,
      activeTestsInProgress,
      generatingReports,
      pendingOrders,
      queueBacklog: backlog,
      todayAiCostCents,
      todayAiCostDisplay: formatCents(todayAiCostCents),
    };
  }

  /** 队列待处理任务数（契约示例列出三个已注册队列） */
  private async loadQueueBacklog(): Promise<Record<string, number>> {
    const queues = [this.aiReportQueue, this.compatibilityQueue, this.exportQueue];

    const entries = await Promise.all(
      queues.map(async (queue): Promise<[string, number]> => {
        const counts = await queue.getJobCounts('waiting');
        return [queue.name, counts['waiting'] ?? 0];
      }),
    );

    return Object.fromEntries(entries);
  }
}

/** UTC 当天零点（`@db.Date` 列的比较基准） */
const startOfDayUtc = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** 均值（空集合返回 0，避免 NaN 被序列化成 null） */
const averageOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** 变化块（单位不同，展示形式不同：pp / 绝对金额 / 计数 / 比率） */
const changeBlock = (
  current: number,
  previous: number,
  unit: 'percent' | 'ratio' | 'cent' | 'count',
): DashboardChangeBlock => {
  const change = Number((current - previous).toFixed(4));

  return {
    current,
    previous,
    change,
    changeDisplay: changeDisplayOf(unit, change),
    direction: trendDirection(change),
  };
};

const changeDisplayOf = (unit: 'percent' | 'ratio' | 'cent' | 'count', change: number): string => {
  if (unit === 'percent') return formatPercentagePointChange(change);
  if (unit === 'cent') return `${change >= 0 ? '+' : '-'}${formatCents(Math.abs(change))}`;
  if (unit === 'count') return `${change >= 0 ? '+' : ''}${toSafeNumber(change)}`;
  return `${change >= 0 ? '+' : ''}${Number(change.toFixed(2))}`;
};
