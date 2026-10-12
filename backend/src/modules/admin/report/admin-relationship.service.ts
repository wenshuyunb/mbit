/**
 * 管理端关系数据服务（契约 §3.14.8.1）
 *
 * ## 为什么 `sortBy = overallScore` 走原生 SQL
 *
 * 综合分在 `compatibility_reports.total_score` 上，而 `Relationship` 到
 * `CompatibilityReport` 是**一对多**关系 —— Prisma 只支持按 to-one 关联字段排序，
 * 按 to-many 关联排序会报错。可选方案只有两个：
 *   ① 先全量取出再在内存里排序（分页会彻底失真，直接否决）
 *   ② 用 `LATERAL` 子查询取「最近一份匹配报告的分数」并按其排序（本实现）
 * 因此该排序路径用一条原生 SQL 取**分页后的 id 列表 + 总数**，
 * 再由 Prisma 按 id 补齐关联数据（2 条查询，无 N+1）。
 *
 * ## 性能
 *
 * 单页固定 7 条查询（主查询 + count + 5 个批量关联查询）+ 摘要的固定 6 条聚合，
 * 与页大小无关。索引命中：`[status, createdAt]`、`[userAId, status]`、
 * `[userBId, status]`、`[pairKey]`。
 *
 * ## 隐私
 *
 * 双方昵称一律掩码；🚫 不返回手机号、openid；关系详情中的 AI 对话内容不可见
 * （本接口不含任何对话正文）。
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  ADMIN_REPORT_DEFAULT_PAGE_SIZE,
  type AdminRelationshipsQueryDto,
  type RelationshipSortField,
  type SortOrder,
} from './dto/admin-report.dto';
import {
  COMPLETED_SESSION_STATUSES,
  UNLOCKED_ENTITLEMENT_STATUSES,
  ABNORMAL_REASONS,
  VIRAL_COEFFICIENT_TARGET,
  daysTogetherOf,
  deriveAbnormalReasons,
  maskNickname,
  relationshipRoleOf,
  roundTo,
  safeRatio,
  scoreLevelOf,
  viralCoefficientOf,
} from './admin-report.util';

/** 关系列表项（契约 §3.14.8.1） */
export interface AdminRelationshipItem {
  relationshipId: string;
  relationType: string;
  status: string;
  userA: {
    userId: string;
    nicknameMasked: string | null;
    mbtiType: string | null;
    profileVersion: number | null;
    role: 'INVITER' | 'INVITEE';
  };
  userB: {
    userId: string;
    nicknameMasked: string | null;
    mbtiType: string | null;
    profileVersion: number | null;
    role: 'INVITER' | 'INVITEE';
  };
  sourceInviteCode: string | null;
  compatibility: {
    hasReport: boolean;
    reportId: string | null;
    overallScore: number | null;
    scoreLevel: string | null;
    algorithmVersion: string | null;
    weightsVersion: string | null;
    reportStatus: string | null;
    isUnlocked: boolean;
    reportCount: number;
  };
  invitedAt: string | null;
  acceptedAt: string | null;
  activatedAt: string | null;
  removedAt: string | null;
  daysTogether: number;
  aiConversationCount: number;
  isAbnormal: boolean;
  abnormalReason: string | null;
}

/** 关系列表响应（契约 §3.14.8.1） */
export interface AdminRelationshipListView {
  items: AdminRelationshipItem[];
  total: number;
  totalCount: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: {
    totalRelationships: number;
    activeCount: number;
    pendingCount: number;
    expiredCount: number;
    removedCount: number;
    byRelationType: Record<string, number>;
    inviteFunnel: {
      invitesCreated: number;
      invitesAccepted: number;
      acceptRate: number;
      relationshipsActivated: number;
      activationRate: number;
      inviteToActiveRate: number;
      viralCoefficientK: number;
      kTarget: number;
      isKOnTarget: boolean;
    };
    compatibilityReportStats: {
      totalReports: number;
      generatedCount: number;
      failedCount: number;
      partialCount: number;
      averageScore: number;
      unlockRate: number;
    };
  };
}

/** 关系主查询的 include 形状 */
const RELATIONSHIP_INCLUDE = {
  userA: { select: { id: true, nickname: true } },
  userB: { select: { id: true, nickname: true } },
  _count: { select: { compatibilityReports: true, aiConversations: true } },
} as const satisfies Prisma.RelationshipInclude;

type RelationshipRow = Prisma.RelationshipGetPayload<{ include: typeof RELATIONSHIP_INCLUDE }>;

@Injectable()
export class AdminRelationshipService {
  constructor(private readonly prisma: PrismaService) {}

  async listRelationships(query: AdminRelationshipsQueryDto): Promise<AdminRelationshipListView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ADMIN_REPORT_DEFAULT_PAGE_SIZE;
    const sortBy: RelationshipSortField = query.sortBy ?? 'createdAt';
    const order: SortOrder = query.order ?? 'desc';

    if (query.minScore !== undefined && query.maxScore !== undefined && query.minScore > query.maxScore) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'minScore 不能大于 maxScore');
    }

    const where = this.buildWhere(query);

    const paged =
      sortBy === 'overallScore'
        ? await this.pageByOverallScore(query, page, pageSize, order)
        : await this.pageByPrismaWhere(where, page, pageSize, sortBy, order);

    const [rows, summary] = await Promise.all([this.loadRows(paged.ids), this.loadSummary()]);

    const items = await this.toItems(rows);

    return {
      items,
      total: paged.total,
      // 契约同时给出 total 与 totalCount：前者是命中筛选条件的数量，
      // 后者在示例中与之相同（保留双字段以兼容前端既有绑定）
      totalCount: paged.total,
      page,
      pageSize,
      hasNext: page * pageSize < paged.total,
      summary,
    };
  }

  // ==========================================================================
  // 分页
  // ==========================================================================

  private async pageByPrismaWhere(
    where: Prisma.RelationshipWhereInput,
    page: number,
    pageSize: number,
    sortBy: RelationshipSortField,
    order: SortOrder,
  ): Promise<{ ids: string[]; total: number }> {
    const orderBy = this.buildOrderBy(sortBy, order);

    const [rows, total] = await Promise.all([
      this.prisma.relationship.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true },
      }),
      this.prisma.relationship.count({ where }),
    ]);

    return { ids: rows.map((row) => row.id), total };
  }

  /**
   * 按综合分排序的分页（原生 SQL，见文件头说明）
   *
   * `count(*) OVER ()` 在同一条 SQL 里带回命中总数，避免再加一次 count；
   * 只有当前页为空时才补一次 count（此时窗口函数无行可依附）。
   */
  private async pageByOverallScore(
    query: AdminRelationshipsQueryDto,
    page: number,
    pageSize: number,
    order: SortOrder,
  ): Promise<{ ids: string[]; total: number }> {
    const direction = order === 'asc' ? Prisma.raw('ASC') : Prisma.raw('DESC');
    const filters = this.buildSqlFilters(query);

    const rows = await this.prisma.$queryRaw<Array<{ id: string; total_count: number }>>(Prisma.sql`
      SELECT r.id, count(*) OVER ()::int AS total_count
      FROM relationships r
      LEFT JOIN LATERAL (
        SELECT c.total_score
        FROM compatibility_reports c
        WHERE c.relationship_id = r.id AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC
        LIMIT 1
      ) c ON TRUE
      WHERE ${filters}
      ORDER BY c.total_score ${direction} NULLS LAST, r.id DESC
      LIMIT ${pageSize}::int OFFSET ${(page - 1) * pageSize}::int
    `);

    if (rows.length > 0) {
      return { ids: rows.map((row) => row.id), total: rows[0]?.total_count ?? 0 };
    }

    const total = await this.prisma.relationship.count({ where: this.buildWhere(query) });
    return { ids: [], total };
  }

  /** 按 id 补齐完整行（保持传入顺序：排序结果来自 SQL，不能被 Prisma 打乱） */
  private async loadRows(ids: readonly string[]): Promise<RelationshipRow[]> {
    if (ids.length === 0) return [];

    const rows = await this.prisma.relationship.findMany({
      where: { id: { in: [...ids] } },
      include: RELATIONSHIP_INCLUDE,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return ids.map((id) => byId.get(id)).filter((row): row is RelationshipRow => row !== undefined);
  }

  // ==========================================================================
  // 条目组装
  // ==========================================================================

  private async toItems(rows: readonly RelationshipRow[]): Promise<AdminRelationshipItem[]> {
    if (rows.length === 0) return [];

    const relationshipIds = rows.map((row) => row.id);
    const userIds = [...new Set(rows.flatMap((row) => [row.userAId, row.userBId]))];
    const pairKeys = [...new Set(rows.map((row) => row.pairKey))];

    const [profiles, compatReports, invites, unlocked, conversations, pairCounts] = await Promise.all([
      this.prisma.personalityProfile.findMany({
        where: { userId: { in: userIds }, deletedAt: null, isCurrent: true },
        select: { userId: true, mbtiType: true, version: true },
      }),
      // 每个关系取最近一份匹配报告：`orderBy createdAt desc` 后首次出现即为最近一份
      this.prisma.compatibilityReport.findMany({
        where: { relationshipId: { in: relationshipIds }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          relationshipId: true,
          totalScore: true,
          status: true,
          engineVersion: true,
          weightsVersion: true,
          computedAt: true,
          generatedAt: true,
        },
      }),
      this.prisma.relationshipInvite.findMany({
        where: { relationshipId: { in: relationshipIds }, deletedAt: null },
        select: { relationshipId: true, code: true, inviterId: true, createdAt: true, acceptedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.entitlement.findMany({
        where: {
          relationshipId: { in: relationshipIds },
          deletedAt: null,
          status: { in: [...UNLOCKED_ENTITLEMENT_STATUSES] },
        },
        select: { relationshipId: true },
      }),
      // 会话计数交给 groupBy（一次查询），不逐关系查询
      this.prisma.aiConversation.groupBy({
        by: ['relationshipId'],
        where: { relationshipId: { in: relationshipIds }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.relationship.groupBy({
        by: ['pairKey'],
        where: { pairKey: { in: pairKeys } },
        _count: { _all: true },
      }),
    ]);

    const profileByUser = new Map(profiles.map((profile) => [profile.userId, profile]));
    const latestCompat = new Map<string, (typeof compatReports)[number]>();
    for (const report of compatReports) {
      if (!latestCompat.has(report.relationshipId)) latestCompat.set(report.relationshipId, report);
    }
    const inviteByRelationship = new Map<string, (typeof invites)[number]>();
    for (const invite of invites) {
      if (invite.relationshipId !== null && !inviteByRelationship.has(invite.relationshipId)) {
        inviteByRelationship.set(invite.relationshipId, invite);
      }
    }
    const unlockedSet = new Set(unlocked.map((item) => item.relationshipId ?? ''));
    const conversationByRelationship = new Map(
      conversations.map((bucket) => [bucket.relationshipId ?? '', bucket._count._all]),
    );
    const pairCountByKey = new Map(pairCounts.map((bucket) => [bucket.pairKey, bucket._count._all]));

    const now = new Date();

    return rows.map((row) => {
      const invite = inviteByRelationship.get(row.id);
      const roles = relationshipRoleOf(row.userAId, invite?.inviterId ?? null);
      const profileA = profileByUser.get(row.userAId);
      const profileB = profileByUser.get(row.userBId);
      const compat = latestCompat.get(row.id);
      const overallScore = compat?.totalScore ?? null;

      const abnormalReasons = deriveAbnormalReasons({
        pairBuildCount: pairCountByKey.get(row.pairKey) ?? 1,
        hasReport: compat !== undefined,
        overallScore,
      });

      return {
        relationshipId: row.id,
        relationType: row.type,
        status: row.status,
        userA: {
          userId: row.userAId,
          nicknameMasked: maskNickname(row.userA.nickname),
          mbtiType: profileA?.mbtiType ?? null,
          profileVersion: profileA?.version ?? null,
          role: roles.userA,
        },
        userB: {
          userId: row.userBId,
          nicknameMasked: maskNickname(row.userB.nickname),
          mbtiType: profileB?.mbtiType ?? null,
          profileVersion: profileB?.version ?? null,
          role: roles.userB,
        },
        sourceInviteCode: invite?.code ?? null,
        compatibility: {
          hasReport: compat !== undefined,
          reportId: compat?.id ?? null,
          overallScore,
          scoreLevel: scoreLevelOf(overallScore),
          algorithmVersion: compat?.engineVersion ?? null,
          weightsVersion: compat?.weightsVersion ?? null,
          reportStatus: compat?.status ?? null,
          isUnlocked: unlockedSet.has(row.id),
          reportCount: row._count.compatibilityReports,
        },
        invitedAt: invite?.createdAt.toISOString() ?? null,
        acceptedAt: invite?.acceptedAt?.toISOString() ?? null,
        activatedAt: row.confirmedAt?.toISOString() ?? null,
        removedAt: row.unboundAt?.toISOString() ?? null,
        daysTogether: daysTogetherOf(row.confirmedAt, row.status, now),
        aiConversationCount: conversationByRelationship.get(row.id) ?? 0,
        isAbnormal: abnormalReasons.length > 0,
        abnormalReason:
          abnormalReasons.length === 0 ? null : abnormalReasons.map((reason) => ABNORMAL_REASONS[reason]).join('；'),
      };
    });
  }

  // ==========================================================================
  // 摘要（全站口径，不受列表筛选影响 —— 契约示例的 total 与 totalRelationships 不同）
  // ==========================================================================

  private async loadSummary(): Promise<AdminRelationshipListView['summary']> {
    const [
      statusBuckets,
      typeBuckets,
      invitesCreated,
      invitesAccepted,
      activatedCount,
      completedTestUsers,
      compatStatusBuckets,
      compatAvg,
      unlockedRelationships,
    ] = await Promise.all([
      this.prisma.relationship.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.relationship.groupBy({ by: ['type'], _count: { _all: true } }),
      this.prisma.relationshipInvite.count({ where: { deletedAt: null } }),
      this.prisma.relationshipInvite.count({ where: { deletedAt: null, status: 'ACCEPTED' } }),
      this.prisma.relationship.count({ where: { status: 'ACTIVE' } }),
      this.prisma.$queryRaw<Array<{ cnt: number }>>(Prisma.sql`
        SELECT count(DISTINCT user_id)::int AS cnt
        FROM test_sessions
        WHERE deleted_at IS NULL
          AND status::text IN (${Prisma.join([...COMPLETED_SESSION_STATUSES])})
      `),
      this.prisma.compatibilityReport.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.compatibilityReport.aggregate({
        where: { deletedAt: null },
        _avg: { totalScore: true },
        _count: { _all: true },
      }),
      this.prisma.entitlement.groupBy({
        by: ['relationshipId'],
        where: {
          relationshipId: { not: null },
          deletedAt: null,
          status: { in: [...UNLOCKED_ENTITLEMENT_STATUSES] },
        },
        _count: { _all: true },
      }),
    ]);

    const countOf = (buckets: Array<{ status: string; _count: { _all: number } }>, status: string): number =>
      buckets.find((bucket) => bucket.status === status)?._count._all ?? 0;

    const totalRelationships = statusBuckets.reduce((sum, bucket) => sum + bucket._count._all, 0);
    const totalCompatReports = compatStatusBuckets.reduce((sum, bucket) => sum + bucket._count._all, 0);
    const testUsers = completedTestUsers[0]?.cnt ?? 0;
    const k = viralCoefficientOf(invitesAccepted, testUsers);

    return {
      totalRelationships,
      activeCount: countOf(statusBuckets, 'ACTIVE'),
      pendingCount: countOf(statusBuckets, 'PENDING_A_CONFIRM'),
      expiredCount: countOf(statusBuckets, 'EXPIRED'),
      removedCount: countOf(statusBuckets, 'REMOVED'),
      byRelationType: Object.fromEntries(typeBuckets.map((bucket) => [bucket.type, bucket._count._all])),
      inviteFunnel: {
        invitesCreated,
        invitesAccepted,
        acceptRate: safeRatio(invitesAccepted, invitesCreated),
        relationshipsActivated: activatedCount,
        activationRate: safeRatio(activatedCount, invitesAccepted),
        inviteToActiveRate: safeRatio(activatedCount, invitesCreated),
        viralCoefficientK: k,
        kTarget: VIRAL_COEFFICIENT_TARGET,
        isKOnTarget: k >= VIRAL_COEFFICIENT_TARGET,
      },
      compatibilityReportStats: {
        totalReports: compatAvg._count._all,
        generatedCount: countOf(compatStatusBuckets, 'SUCCEEDED'),
        failedCount: countOf(compatStatusBuckets, 'FAILED'),
        // 契约的「部分成功」：算分完成但 AI 解读未产出（`computedAt` 有值、`generatedAt` 为空）
        partialCount: await this.countPartialCompatReports(),
        averageScore: roundTo(compatAvg._avg.totalScore ?? 0, 1),
        unlockRate: safeRatio(unlockedRelationships.length, totalCompatReports),
      },
    };
  }

  /** 部分成功的匹配报告数（算分完成、AI 解读未产出） */
  private async countPartialCompatReports(): Promise<number> {
    return this.prisma.compatibilityReport.count({
      where: { deletedAt: null, computedAt: { not: null }, generatedAt: null },
    });
  }

  // ==========================================================================
  // 查询条件
  // ==========================================================================

  private buildWhere(query: AdminRelationshipsQueryDto): Prisma.RelationshipWhereInput {
    const where: Prisma.RelationshipWhereInput = { deletedAt: null };

    if (query.status !== undefined && query.status.length > 0) {
      // `RelationshipStatusFilter` 与 Prisma 的 `RelationshipStatus` 是同一组字符串字面量，
      // 因此无需断言 —— 展开成新数组即可满足可变数组的类型要求
      where.status = { in: [...query.status] };
    }

    if (query.relationType !== undefined && query.relationType.length > 0) {
      where.type = { in: [...query.relationType] };
    }

    if (query.userId !== undefined) {
      where.OR = [{ userAId: query.userId }, { userBId: query.userId }];
    }

    if (query.startTime !== undefined || query.endTime !== undefined) {
      where.createdAt = {
        ...(query.startTime !== undefined ? { gte: new Date(query.startTime) } : {}),
        ...(query.endTime !== undefined ? { lte: new Date(query.endTime) } : {}),
      };
    }

    const compatFilter: Prisma.CompatibilityReportWhereInput = { deletedAt: null };
    // 分数区间拼成一个独立的 IntFilter 再整体赋值。
    // 不用 `{ ...(compatFilter.totalScore ?? {}), lte: x }`：`totalScore` 的静态类型是
    // `IntFilter | number | null | undefined`，展开它 TS 会报「不能从非对象类型展开」
    // （且运行时若它是 number，展开结果也是错的）。
    const scoreFilter: Prisma.IntFilter = {};
    if (query.minScore !== undefined) scoreFilter.gte = query.minScore;
    if (query.maxScore !== undefined) scoreFilter.lte = query.maxScore;
    if (query.minScore !== undefined || query.maxScore !== undefined) {
      compatFilter.totalScore = scoreFilter;
    }

    if (query.hasCompatibilityReport !== undefined) {
      where.compatibilityReports = query.hasCompatibilityReport
        ? { some: compatFilter }
        : { none: { deletedAt: null } };
    } else if (query.minScore !== undefined || query.maxScore !== undefined) {
      where.compatibilityReports = { some: compatFilter };
    }

    if (query.sourceInviteCode !== undefined) {
      where.invites = { some: { code: query.sourceInviteCode, deletedAt: null } };
    }

    return where;
  }

  /**
   * 原生 SQL 版筛选条件（仅 `sortBy = overallScore` 路径使用）
   *
   * ⚠ 与 `buildWhere` 是**同一套语义的两份实现**：Prisma 的 where 无法参与原生 SQL。
   * 两者紧邻放置以便同步修改；若将来排序需求增多，应把筛选条件抽成单一真源
   * （例如统一走原生 SQL）。
   */
  private buildSqlFilters(query: AdminRelationshipsQueryDto): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`r.deleted_at IS NULL`];

    if (query.status !== undefined && query.status.length > 0) {
      parts.push(Prisma.sql`r.status::text IN (${Prisma.join(query.status)})`);
    }

    if (query.relationType !== undefined && query.relationType.length > 0) {
      parts.push(Prisma.sql`r.type::text IN (${Prisma.join(query.relationType)})`);
    }

    if (query.userId !== undefined) {
      parts.push(Prisma.sql`(r.user_a_id = ${query.userId}::uuid OR r.user_b_id = ${query.userId}::uuid)`);
    }

    if (query.startTime !== undefined) {
      parts.push(Prisma.sql`r.created_at >= ${new Date(query.startTime)}`);
    }

    if (query.endTime !== undefined) {
      parts.push(Prisma.sql`r.created_at <= ${new Date(query.endTime)}`);
    }

    if (query.sourceInviteCode !== undefined) {
      parts.push(Prisma.sql`EXISTS (
        SELECT 1 FROM relationship_invites i
        WHERE i.relationship_id = r.id AND i.deleted_at IS NULL AND i.code = ${query.sourceInviteCode}
      )`);
    }

    const scoreConditions: Prisma.Sql[] = [Prisma.sql`c.deleted_at IS NULL`];
    if (query.minScore !== undefined) scoreConditions.push(Prisma.sql`c.total_score >= ${query.minScore}::int`);
    if (query.maxScore !== undefined) scoreConditions.push(Prisma.sql`c.total_score <= ${query.maxScore}::int`);

    if (query.hasCompatibilityReport === true || query.minScore !== undefined || query.maxScore !== undefined) {
      parts.push(Prisma.sql`EXISTS (
        SELECT 1 FROM compatibility_reports c
        WHERE c.relationship_id = r.id AND ${Prisma.join(scoreConditions, ' AND ')}
      )`);
    }

    if (query.hasCompatibilityReport === false) {
      parts.push(Prisma.sql`NOT EXISTS (
        SELECT 1 FROM compatibility_reports c
        WHERE c.relationship_id = r.id AND c.deleted_at IS NULL
      )`);
    }

    return Prisma.join(parts, ' AND ');
  }

  /**
   * 排序映射
   *
   * `activatedAt` → `confirmedAt`（契约字段名与库内列名不同：`relationships` 用的是
   * 「确认时刻」，`activatedAt` 是运营语义）。
   */
  private buildOrderBy(sortBy: RelationshipSortField, order: SortOrder): Prisma.RelationshipOrderByWithRelationInput[] {
    const primary: Prisma.RelationshipOrderByWithRelationInput =
      sortBy === 'activatedAt' ? { confirmedAt: order } : { createdAt: order };

    // 次级排序固定 id：`confirmedAt` 可空，PostgreSQL 不保证稳定序，
    // 仅按单字段排序时分页会让同一条记录在第 1、2 页各出现一次
    return [primary, { id: 'desc' }];
  }
}
