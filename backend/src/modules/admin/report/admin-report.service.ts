/**
 * 管理端报告数据列表服务（契约 §3.14.8.2，内容治理视角）
 *
 * ## 与 `GET /admin/ai/reports` 的区别
 *
 * 数据同源、视图不同（契约明确说明）：本站偏**内容治理**（审核抽检、被举报内容、
 * 质量复盘、按类型统计），`ai-stats` 那站偏 **AI 成本与效率**（token、成本、
 * prompt 版本、缓存命中）。因此本站**不返回** `totalTokens` / `costCents` /
 * `promptVersion` / `cacheHit`，避免「一个接口承担两种权限语义」。
 *
 * ## 正文默认不可见
 *
 * 本接口**没有** `includeContent` 参数，因此**永不返回报告正文**
 * （契约 §3.14.8.2 的 `privacyNotice` 与业务规则 1）。审核抽检需要正文时走
 * `POST /admin/reports/{id}/review` 流程（不在本任务范围）。
 * `summary` 是**服务端生成的摘要**（`ai_reports.summary`，≤ 1024 字符），
 * 契约明确允许在不解锁正文的前提下返回，用于审核初筛。
 *
 * ## 已知数据模型缺口（**不是实现遗漏**）
 *
 * | 契约字段              | 现状                                                        |
 * | --------------------- | ----------------------------------------------------------- |
 * | `reviewStatus`        | 无 `review_status` 列与审核表 → 只能推导 `REMOVED`（`deletedAt`）与 `PENDING` |
 * | `reviewNote`          | 无对应列 → 恒为 `null`                                       |
 * | `reportedByUsers`     | 无举报表 → 恒为 `0`                                          |
 * | `reportedByUsers` 之外的 `FLAGGED`/`APPROVED` 过滤 | 无法表达 → 返回空集 |
 */

import { Injectable } from '@nestjs/common';
import type { AiReport } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { reportTypeName } from '../../ai/report/report-list.util';
import {
  ADMIN_REPORT_DEFAULT_PAGE_SIZE,
  type AdminReportsQueryDto,
  type ReportSortField,
  type SortOrder,
} from './dto/admin-report.dto';
import {
  DB_TO_TYPE,
  STATUS_TO_DB,
  TYPE_TO_DB,
  UNLOCKED_ENTITLEMENT_STATUSES,
  maskNickname,
  reviewStatusOf,
  safeRatio,
} from './admin-report.util';

/** 报告条目（契约 §3.14.8.2） */
export interface AdminReportItem {
  reportId: string;
  type: string;
  typeName: string;
  status: string;
  reviewStatus: string;
  reviewNote: string | null;
  userId: string | null;
  userNicknameMasked: string | null;
  relationshipId: string | null;
  title: string | null;
  summary: string | null;
  mbtiType: string | null;
  wordCount: number;
  sectionCount: number;
  isUnlocked: boolean;
  unlockType: string | null;
  safetyFlagged: boolean;
  reportCount: number;
  regenerateCount: number;
  createdAt: string;
  generatedAt: string | null;
  overallScore?: number | null;
}

/** 报告列表响应（契约 §3.14.8.2） */
export interface AdminReportListView {
  items: AdminReportItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: {
    totalReports: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    byReviewStatus: Record<string, number>;
    safetyFlagged: number;
    reportedByUsers: number;
    averageWordCount: number;
    unlockRate: number;
  };
  privacyNotice: string;
}

/** 隐私说明（契约 §3.14.8.2 原文） */
const PRIVACY_NOTICE =
  '本接口默认不返回报告正文。内容审核抽检需通过 POST /api/v1/admin/reports/{id}/review 流程（含二次确认与高等级审计）。';

@Injectable()
export class AdminReportService {
  constructor(private readonly prisma: PrismaService) {}

  async listReports(query: AdminReportsQueryDto): Promise<AdminReportListView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ADMIN_REPORT_DEFAULT_PAGE_SIZE;

    if (
      query.minWordCount !== undefined &&
      query.maxWordCount !== undefined &&
      query.minWordCount > query.maxWordCount
    ) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'minWordCount 不能大于 maxWordCount');
    }

    const where = this.buildWhere(query);

    const [rows, total, typeBuckets, statusBuckets, safetyFlaggedCount, unlockedCount, removedCount, wordAvg] =
      await Promise.all([
        this.prisma.aiReport.findMany({
          where,
          orderBy: this.buildOrderBy(query.sortBy ?? 'generatedAt', query.order ?? 'desc'),
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.aiReport.count({ where }),
        this.prisma.aiReport.groupBy({ by: ['type'], where, _count: { _all: true } }),
        this.prisma.aiReport.groupBy({ by: ['status'], where, _count: { _all: true } }),
        this.prisma.aiReport.count({ where: { AND: [where, { callAudits: { some: { status: 'BLOCKED' } } }] } }),
        this.prisma.aiReport.count({
          where: { AND: [where, { entitlements: { some: this.unlockedEntitlementFilter() } }] },
        }),
        // `deletedAt != null` 的报告被上面的 where 排除了，这里单独统计「已下架」数量
        this.prisma.aiReport.count({
          where: { AND: [this.withoutDeletedFilter(where), { deletedAt: { not: null } }] },
        }),
        this.prisma.aiReport.aggregate({ where, _avg: { contentLength: true } }),
      ]);

    const items = await this.toItems(rows);

    return {
      items,
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary: {
        totalReports: total,
        byType: this.toContractTypeCounts(typeBuckets),
        byStatus: Object.fromEntries(statusBuckets.map((bucket) => [bucket.status, bucket._count._all])),
        byReviewStatus: {
          // 审核状态只能推导：`deletedAt != null` → REMOVED，其余 PENDING（见文件头缺口表）
          PENDING: total - removedCount,
          APPROVED: 0,
          FLAGGED: 0,
          REMOVED: removedCount,
        },
        safetyFlagged: safetyFlaggedCount,
        // 无举报落库表 → 恒为 0（架构 R2 观测指标缺数据源）
        reportedByUsers: 0,
        averageWordCount: Math.round(wordAvg._avg.contentLength ?? 0),
        unlockRate: safeRatio(unlockedCount, total),
      },
      privacyNotice: PRIVACY_NOTICE,
    };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private unlockedEntitlementFilter(): Prisma.EntitlementWhereInput {
    return { deletedAt: null, status: { in: [...UNLOCKED_ENTITLEMENT_STATUSES] } };
  }

  /** 去掉 `deletedAt: null` 条件（用于统计「已下架」报告数） */
  private withoutDeletedFilter(where: Prisma.AiReportWhereInput): Prisma.AiReportWhereInput {
    const conditions = Array.isArray(where.AND) ? where.AND : [where];
    const kept = conditions.filter((condition) => {
      if (typeof condition !== 'object' || condition === null) return true;
      return !('deletedAt' in condition);
    });

    return { AND: kept };
  }

  private buildWhere(query: AdminReportsQueryDto): Prisma.AiReportWhereInput {
    const and: Prisma.AiReportWhereInput[] = [{ deletedAt: null }];

    if (query.type !== undefined && query.type.length > 0) {
      and.push({ OR: query.type.map((type) => this.typeCondition(type)) });
    }

    if (query.status !== undefined && query.status.length > 0) {
      and.push({ OR: query.status.map((status) => this.statusCondition(status)) });
    }

    if (query.userId !== undefined) and.push({ userId: query.userId });
    if (query.relationshipId !== undefined) and.push({ relationshipId: query.relationshipId });

    if (query.isUnlocked !== undefined) {
      and.push({
        entitlements: query.isUnlocked
          ? { some: this.unlockedEntitlementFilter() }
          : { none: this.unlockedEntitlementFilter() },
      });
    }

    if (query.minWordCount !== undefined || query.maxWordCount !== undefined) {
      and.push({
        contentLength: {
          ...(query.minWordCount !== undefined ? { gte: query.minWordCount } : {}),
          ...(query.maxWordCount !== undefined ? { lte: query.maxWordCount } : {}),
        },
      });
    }

    if (query.startTime !== undefined || query.endTime !== undefined) {
      and.push({
        createdAt: {
          ...(query.startTime !== undefined ? { gte: new Date(query.startTime) } : {}),
          ...(query.endTime !== undefined ? { lte: new Date(query.endTime) } : {}),
        },
      });
    }

    // `hasReport`：契约语义是「关联对象是否有报告（如关系是否有匹配报告）」。
    // 在「报告列表」里唯一说得通的解释是「该匹配报告是否已有算分记录」，
    // 因此先限定为匹配报告行（`RELATIONSHIP_REPORT` + 有 relationshipId），
    // 再按是否存在 `compatibility_report` 过滤 —— 否则 hasReport=false 会把
    // 全部个人报告都算进来（它们本就没有算分记录），语义完全跑偏。
    if (query.hasReport !== undefined) {
      and.push({ type: 'RELATIONSHIP_REPORT', relationshipId: { not: null } });
      and.push(query.hasReport ? { compatibilityReport: { isNot: null } } : { compatibilityReport: { is: null } });
    }

    // `reviewStatus` 只能部分表达（见文件头缺口表）：
    //   · REMOVED  → deletedAt 非空（需要绕开默认的 deletedAt: null 条件）
    //   · PENDING  → deletedAt 为空
    //   · APPROVED / FLAGGED → 无数据可依据，返回空集而不是「当成 PENDING 返回全部」
    if (query.reviewStatus === 'REMOVED') {
      const withoutDeleted = this.withoutDeletedFilter({ AND: and });
      return { AND: [withoutDeleted, { deletedAt: { not: null } }] };
    }

    if (query.reviewStatus === 'APPROVED' || query.reviewStatus === 'FLAGGED') {
      and.push({ id: { in: [] } });
    }

    return { AND: and };
  }

  private typeCondition(type: string): Prisma.AiReportWhereInput {
    if (type === 'COMPATIBILITY_REPORT') {
      return { type: 'RELATIONSHIP_REPORT', relationshipId: { not: null } };
    }

    return { type: TYPE_TO_DB[type] as Prisma.AiReportWhereInput['type'] };
  }

  private statusCondition(status: string): Prisma.AiReportWhereInput {
    if (status === 'PARTIAL') {
      return { status: 'FAILED', relationshipId: { not: null } };
    }

    return { status: STATUS_TO_DB[status] as Prisma.AiReportWhereInput['status'] };
  }

  /**
   * 排序映射
   *
   * `generatedAt` → `generationFinishedAt`（库内列名），`wordCount` → `contentLength`。
   */
  private buildOrderBy(sortBy: ReportSortField, order: SortOrder): Prisma.AiReportOrderByWithRelationInput[] {
    const primary: Prisma.AiReportOrderByWithRelationInput =
      sortBy === 'wordCount'
        ? { contentLength: order }
        : sortBy === 'createdAt'
          ? { createdAt: order }
          : { generationFinishedAt: order };

    return [primary, { id: 'desc' }];
  }

  /** 批次补齐关联（用户昵称 / 权益 / 安全拦截 / 兼容性算分）—— 4 条批量查询 */
  private async toItems(rows: readonly AiReport[]): Promise<AdminReportItem[]> {
    if (rows.length === 0) return [];

    const reportIds = rows.map((row) => row.id);
    const userIds = rows.map((row) => row.userId);

    const [users, entitlements, blockedAudits, compatReports, profiles] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, nickname: true } }),
      this.prisma.entitlement.findMany({
        where: { reportId: { in: reportIds }, deletedAt: null, status: { in: [...UNLOCKED_ENTITLEMENT_STATUSES] } },
        select: { reportId: true, type: true },
      }),
      this.prisma.aiCallAudit.findMany({
        where: { reportId: { in: reportIds }, status: 'BLOCKED' },
        select: { reportId: true },
      }),
      this.prisma.compatibilityReport.findMany({
        where: { aiReportId: { in: reportIds } },
        select: { aiReportId: true, totalScore: true },
      }),
      // 一次批量取「当前人格画像」的 MBTI 类型（按 userId 去重查询，不逐报告查询）
      this.prisma.personalityProfile.findMany({
        where: { userId: { in: userIds }, deletedAt: null, isCurrent: true },
        select: { userId: true, mbtiType: true },
      }),
    ]);

    const nicknameById = new Map(users.map((user) => [user.id, user.nickname]));
    const unlockByReport = new Map(entitlements.map((item) => [item.reportId ?? '', item.type]));
    const blockedReports = new Set(blockedAudits.map((audit) => audit.reportId ?? ''));
    const scoreByReport = new Map(compatReports.map((report) => [report.aiReportId ?? '', report.totalScore]));
    const mbtiByUser = new Map(profiles.map((profile) => [profile.userId, profile.mbtiType]));

    return rows.map((row) => {
      const contractType = DB_TO_TYPE[row.type] ?? row.type;
      const isCompatibility = contractType === 'COMPATIBILITY_REPORT';
      const safetyFlagged = blockedReports.has(row.id);

      return {
        reportId: row.id,
        type: contractType,
        typeName: reportTypeName(row.type),
        status: contractStatusOf(row.status, isCompatibility),
        reviewStatus: reviewStatusOf(row.deletedAt, safetyFlagged),
        // 无审核备注列 → 恒为 null（缺口表）
        reviewNote: null,
        // 契约：匹配报告归属关系而非单用户，userId / 昵称置 null
        userId: isCompatibility ? null : row.userId,
        userNicknameMasked: isCompatibility ? null : maskNickname(nicknameById.get(row.userId) ?? null),
        relationshipId: row.relationshipId,
        title: row.title,
        // `summary` 是服务端生成的摘要（≤ 1024 字符），契约明确允许默认返回用于审核初筛
        summary: row.summary,
        mbtiType: isCompatibility ? null : (mbtiByUser.get(row.userId) ?? null),
        wordCount: row.contentLength,
        sectionCount: row.sectionCount,
        isUnlocked: unlockByReport.has(row.id),
        unlockType: unlockByReport.get(row.id) ?? null,
        safetyFlagged,
        // 契约示例的个人报告与匹配报告都是 1；关系级累计报告数在
        // `/admin/relationships` 的 `compatibility.reportCount` 里给出，此处不重复计算
        reportCount: 1,
        regenerateCount: row.retryCount,
        createdAt: row.createdAt.toISOString(),
        generatedAt: row.generationFinishedAt?.toISOString() ?? null,
        ...(isCompatibility ? { overallScore: scoreByReport.get(row.id) ?? null } : {}),
      };
    });
  }

  /** 类型计数按契约类型聚合（`GROWTH_SUMMARY` → `GROWTH_REPORT` 等） */
  private toContractTypeCounts(buckets: Array<{ type: string; _count: { _all: number } }>): Record<string, number> {
    const result: Record<string, number> = {};

    for (const bucket of buckets) {
      const contractType = DB_TO_TYPE[bucket.type] ?? bucket.type;
      result[contractType] = (result[contractType] ?? 0) + bucket._count._all;
    }

    return result;
  }
}

/**
 * 契约状态推导
 *
 * `QUEUED` → `PENDING`；匹配报告（`RELATIONSHIP_REPORT`）的 `FAILED` → `PARTIAL`
 * （算分已完成、只有 AI 解读失败）。用函数而不是嵌套三元：后者的可读性与
 * 格式化稳定性都更差。
 */
const contractStatusOf = (dbStatus: string, isCompatibility: boolean): string => {
  if (dbStatus === 'QUEUED') return 'PENDING';
  if (dbStatus === 'FAILED' && isCompatibility) return 'PARTIAL';
  return dbStatus;
};
