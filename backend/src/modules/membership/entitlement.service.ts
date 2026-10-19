/**
 * 权益服务（契约 §2.4/§3.5；架构 §13）
 *
 * 全部判定逻辑都在 `entitlement.util.ts`（纯函数、已单测）；本服务只负责**取数**。
 * 这样拆分的原因：权益判定错一次就是"用户没付钱却看到了付费内容"或
 * "付了钱却被挡住"，两类都是必须能 100% 回归的问题，而它们不该依赖数据库替身。
 */

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  ENTITLEMENT_TYPES,
  buildStatusClause,
  buildStatusFilter,
  toEntitlementItem,
  type EntitlementRowLike,
  type EntitlementStatusValue,
  type EntitlementTypeValue,
} from './entitlement-view.util';
import {
  NO_UNLOCK,
  hasActiveMembership,
  isReportUnlocked,
  membershipExpireAt,
  resolveReportUnlock,
  type EntitlementLike,
  type ReportUnlockState,
} from './entitlement.util';

/** 会员状态视图（前端据此展示"会员有效期至 …"） */
export interface MembershipView {
  readonly isMember: boolean;
  readonly expireAt: string | null;
  /** 距离到期天数（未开通为 null；已到期为 0） */
  readonly remainingDays: number | null;
}

/** 报告解锁上下文的字段（`ReportService` 侧只需要这些） */
export interface ReportUnlockStateWithMembership extends ReportUnlockState {
  readonly membership: MembershipView;
}

/** 权益清单查询入参（契约 §3.8.3 的 Query） */
export interface ListEntitlementsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly type?: readonly EntitlementTypeValue[];
  readonly status?: readonly EntitlementStatusValue[];
  readonly resourceId?: string;
  readonly sortBy?: 'grantedAt' | 'expiresAt';
  readonly order?: 'asc' | 'desc';
}

/** 权益清单汇总（契约 §3.8.3 的 `summary`） */
export interface EntitlementSummaryView {
  readonly activeCount: number;
  readonly expiredCount: number;
  readonly consumedCount: number;
  /** 各类型条数；**所有类型都出现**（无记录为 0），键集合稳定便于前端渲染 */
  readonly byType: Readonly<Record<EntitlementTypeValue, number>>;
}

/** 权益清单响应（契约 §3.8.3） */
export interface EntitlementListView {
  readonly items: readonly Record<string, unknown>[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly summary: EntitlementSummaryView;
  /**
   * 会员状态（**额外**字段）
   *
   * 「我的权益」页必然同时展示"会员有效期至 …"，让它带在这里可省掉一次请求，
   * 也避免出现"权益列表已渲染、会员卡片还在转圈"的中间态。
   */
  readonly membership: MembershipView;
}

@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 读取用户的全部有效权益
   *
   * **一次查完再在内存里判定**，而不是按报告逐条查：报告列表一次最多 100 条，
   * 逐条查就是 100 次往返。单个用户的权益行数量很小（个位数到几十），
   * 全量取回的成本远低于 N+1。
   *
   * 过滤条件里只做粗筛（未删除、未撤销），精细的有效性判定留给纯函数 ——
   * 把"`expireAt` 是否过期"写进 SQL 会让同一条规则在 SQL 与 TS 里各有一份，
   * 而两处的边界（`<` 还是 `<=`）极易不一致。
   */
  async loadEntitlements(userId: string): Promise<readonly EntitlementLike[]> {
    const rows = await this.prisma.entitlement.findMany({
      where: { userId, deletedAt: null, status: { in: ['ACTIVE', 'CONSUMED'] } },
      select: {
        type: true,
        status: true,
        resourceKey: true,
        reportId: true,
        expireAt: true,
        remainingQuota: true,
      },
    });

    return rows;
  }

  /** 某份报告的解锁状态（详情接口用；同时带出会员状态供前端展示） */
  async resolveReportUnlock(userId: string, reportId: string): Promise<ReportUnlockStateWithMembership> {
    const entitlements = await this.loadEntitlements(userId);
    const now = new Date();

    return {
      ...resolveReportUnlock(entitlements, reportId, now),
      membership: this.toMembershipView(entitlements, now),
    };
  }

  /**
   * 报告列表的解锁上下文
   *
   * 列表只需要"逐条是否解锁"与汇总，不需要每条的 `source`，
   * 因此返回一个判定函数 + 会员状态，避免为 100 条报告各建一个对象。
   */
  async buildListUnlockContext(userId: string): Promise<{
    isUnlocked: (reportId: string) => boolean;
    countUnlocked: (reportIds: readonly string[]) => number;
    membership: MembershipView;
  }> {
    const entitlements = await this.loadEntitlements(userId);
    const now = new Date();
    const membership = this.toMembershipView(entitlements, now);

    return {
      isUnlocked: (reportId: string): boolean => membership.isMember || isReportUnlocked(entitlements, reportId, now),
      countUnlocked: (reportIds: readonly string[]): number =>
        membership.isMember
          ? reportIds.length
          : reportIds.filter((reportId) => isReportUnlocked(entitlements, reportId, now)).length,
      membership,
    };
  }

  /** 会员状态（`GET /membership` 用） */
  async getMembership(userId: string): Promise<MembershipView> {
    const entitlements = await this.loadEntitlements(userId);

    return this.toMembershipView(entitlements, new Date());
  }

  /**
   * 权益清单（契约 §3.8.3，「我的权益」页与客服排查）
   *
   * ## 为什么不直接用 `loadEntitlements`
   *
   * `loadEntitlements` 的 where 里写着 `status: { in: ['ACTIVE', 'CONSUMED'] }` ——
   * 它是为**判定可用性**服务的（只需要"现在能不能用"），而本接口的用途明确包含
   * 「含已过期/已消耗」的记录（契约 §3.8.3 用途栏原文）。直接复用它会让客服在
   * 排查「用户的会员为什么没了」时**看不到那条 EXPIRED 记录**，而这正是他要找的。
   *
   * 因此这里做全状态查询，但**判定逻辑一个都没有重写**：
   *   · `isUsable` → 复用 `entitlement.util.ts` 的 `isEntitlementActive`
   *   · 会员状态 → 复用 `loadEntitlements` + `toMembershipView`
   * 只有"取哪些行"不同，"怎么判"完全相同。
   *
   * 分页与统计的口径与其它模块一致：`total` 是筛选后的条数，
   * `summary` 的口径是**该用户全部权益**，不随筛选翻页变化。
   */
  async listEntitlements(userId: string, query: ListEntitlementsInput): Promise<EntitlementListView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const now = new Date();

    const baseWhere: Record<string, unknown> = { userId, deletedAt: null };

    const statusFilter = buildStatusFilter(query.status ?? [], now);
    const withStatus = statusFilter === null ? baseWhere : this.appendAnd(baseWhere, statusFilter);

    // 关联资源可能是报告，也可能是一段关系（`REPORT_UNLOCK` 两种写法历史上都存在）。
    // 先算好再组装 `where`，避免在三元表达式里夹注释（可读性差且容易被格式化工具改写）
    const resourceClause =
      query.resourceId === undefined
        ? null
        : { OR: [{ reportId: query.resourceId }, { relationshipId: query.resourceId }] };

    const where: Record<string, unknown> = {
      ...withStatus,
      ...(query.type !== undefined && query.type.length > 0 ? { type: { in: [...query.type] } } : {}),
      ...(resourceClause === null ? {} : resourceClause),
    };

    // `status` 为**第一排序键**：Prisma 枚举在 PG 里按声明顺序排序
    // （ACTIVE → CONSUMED → EXPIRED → REVOKED），因此 `asc` 天然把可用权益置顶
    // （契约 §3.8.3 规则 5）。仅按 `grantedAt` 排会让三个月前的有效会员
    // 沉到一堆过期记录后面
    const sortField = (query.sortBy ?? 'grantedAt') === 'expiresAt' ? 'expireAt' : 'startAt';

    const [rows, total, summary, membership] = await Promise.all([
      this.prisma.entitlement.findMany({
        where: where,
        orderBy: [{ status: 'asc' }, { [sortField]: query.order ?? 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // ⚠ **脱敏**：`grantedByAdminId` 只用于推导 `sourceType = 'ADMIN'`，
        // 不进入响应；`revokeReason` / `idempotencyKey` / `version` 等内部字段
        // **根本不进入查询**（见 entitlement-view.util.ts 的脱敏说明）
        select: {
          id: true,
          type: true,
          status: true,
          resourceKey: true,
          orderId: true,
          membershipId: true,
          reportId: true,
          relationshipId: true,
          totalQuota: true,
          usedQuota: true,
          remainingQuota: true,
          startAt: true,
          expireAt: true,
          consumedAt: true,
          revokedAt: true,
          grantedByAdminId: true,
          order: { select: { orderNo: true } },
          report: { select: { title: true } },
        },
      }),
      this.prisma.entitlement.count({ where: where }),
      this.buildEntitlementSummary(userId, now),
      this.getMembership(userId),
    ]);

    return {
      items: rows.map((row) =>
        toEntitlementItem(row as EntitlementRowLike, now, row.report?.title ?? null, row.order?.orderNo ?? null),
      ),
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary,
      membership,
    };
  }

  /** `summary` 的计数（口径 = 该用户全部权益，不受筛选影响） */
  private async buildEntitlementSummary(userId: string, now: Date): Promise<EntitlementSummaryView> {
    const baseWhere: Record<string, unknown> = { userId, deletedAt: null };
    const countOf = (status: EntitlementStatusValue): Promise<number> =>
      this.prisma.entitlement.count({
        where: this.appendAnd(baseWhere, buildStatusClause(status, now)),
      });

    const [activeCount, expiredCount, consumedCount, byTypeRows] = await Promise.all([
      countOf('ACTIVE'),
      countOf('EXPIRED'),
      countOf('CONSUMED'),
      this.prisma.entitlement.groupBy({
        by: ['type'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const byType: Record<EntitlementTypeValue, number> = {
      REPORT_UNLOCK: 0,
      MEMBERSHIP_ACTIVE: 0,
      AI_CREDITS: 0,
      PDF_EXPORT: 0,
      // 星盘解读解锁（ADR-041）：单次购买为永久、邀请解锁为当天有效
      ZODIAC_READING: 0,
    };

    for (const row of byTypeRows) {
      if ((ENTITLEMENT_TYPES as readonly string[]).includes(row.type)) {
        byType[row.type] = row._count._all;
      }
    }

    return { activeCount, expiredCount, consumedCount, byType };
  }

  /** 把条件追加到 `AND`（保留已有条件，避免覆盖 `OR`） */
  private appendAnd(
    where: Record<string, unknown>,
    ...clauses: readonly Record<string, unknown>[]
  ): Record<string, unknown> {
    const existing = Array.isArray(where.AND) ? (where.AND as Record<string, unknown>[]) : [];

    return { ...where, AND: [...existing, ...clauses] };
  }

  /** 解锁状态的兜底值（无法读到权益时使用，见下方说明） */
  static readonly fallbackUnlock: ReportUnlockState = NO_UNLOCK;

  private toMembershipView(entitlements: readonly EntitlementLike[], now: Date): MembershipView {
    if (!hasActiveMembership(entitlements, now)) {
      return { isMember: false, expireAt: null, remainingDays: null };
    }

    const expireAt = membershipExpireAt(entitlements, now);
    if (expireAt === null) {
      return { isMember: false, expireAt: null, remainingDays: null };
    }

    const remainingDays = Math.max(0, Math.ceil((expireAt.getTime() - now.getTime()) / 86_400_000));

    return { isMember: true, expireAt: expireAt.toISOString(), remainingDays };
  }
}
