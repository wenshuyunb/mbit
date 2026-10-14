/**
 * 管理端 AI 报告数据服务（契约 §3.14.7.5）
 *
 * ## 契约类型 / 状态 ↔ 数据模型的差异（逐条映射，不猜测）
 *
 * | 契约值                 | 数据模型                                                        |
 * | ---------------------- | --------------------------------------------------------------- |
 * | `MBTI_REPORT`          | `AiReport.type = MBTI_REPORT`                                    |
 * | `BIG_FIVE_REPORT`      | `AiReport.type = BIG_FIVE_REPORT`                                |
 * | `GROWTH_REPORT`        | `AiReport.type = GROWTH_SUMMARY`（枚举名不同）                   |
 * | `COMPATIBILITY_REPORT` | `AiReport.type = RELATIONSHIP_REPORT` **且** `relationshipId != null`（匹配报告的 AI 正文载体） |
 * | `PENDING`              | `AiReportStatus.QUEUED`                                          |
 * | `PARTIAL`              | `status = FAILED` **且** `relationshipId != null`（算分已完成、AI 解读失败） |
 *
 * 反向（输出）映射同理。
 *
 * ## 正文默认不可见（隐私底线）
 *
 * 契约 §3.14.7.5 规则 1：`includeContent` 默认 `false`，开启需 `X-Confirm-Password`
 * + 高等级审计。这里**不**给 GET 标 `@SensitiveOperation()` —— 那个装饰器是
 * 「无条件要求密码」，会把默认的 `includeContent=false` 也一并拦住（等于让所有
 * 只读查询都要求输入密码）。因此按**条件校验**实现：仅在 `includeContent=true` 时
 * 要求并校验密码（缺失 → `20017`，错误 → `20018`，与 `ConfirmPasswordGuard` 同语义），
 * 通过后写一条高等级审计（动作 `EXPORT`，语义即「把正文读出接口」）。
 *
 * ## 隐私脱敏
 *
 * · 昵称一律掩码；`COMPATIBILITY_REPORT` 的 `userId` / 昵称置 `null`（契约规则 5）
 * · 正文只在 `includeContent=true` 且密码校验通过时出现在 `contentPreview`
 * · 🚫 不返回任何用户手机号 / openid
 *
 * ## N+1 规避
 *
 * 分页主体 1 条 + 摘要 6 条聚合 + 关联补齐 7 条批量查询，与页大小无关。
 */

import { Injectable } from '@nestjs/common';
import type { AiReport } from '@prisma/client';
import { AdminAuditAction, Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { reportTypeName } from '../../ai/report/report-list.util';
import { AdminAuditService } from '../audit/admin-audit.service';
import { PasswordService } from '../auth/password.service';
import { maskNickname } from './admin-ai-stats.util';
import {
  ADMIN_AI_DEFAULT_PAGE_SIZE,
  type AdminReportSortField,
  type AdminReportStatus,
  type AdminReportType,
  type AiReportsQueryDto,
  type SortOrder,
} from './dto/admin-ai-stats.dto';

/** 契约报告类型 → 库内 `AiReportType` */
const TYPE_TO_DB: Readonly<Record<AdminReportType, string>> = {
  MBTI_REPORT: 'MBTI_REPORT',
  BIG_FIVE_REPORT: 'BIG_FIVE_REPORT',
  GROWTH_REPORT: 'GROWTH_SUMMARY',
  COMPATIBILITY_REPORT: 'RELATIONSHIP_REPORT',
  // ADR-038 阶段 3。⚠ 这张映射表在管理端有**两处**（本文件与 `admin/report/admin-report.util.ts`），
  // 加上两处 `ADMIN_REPORT_TYPES` 白名单，一次"加报告类型"要改四处 —— 漏改只会表现为
  // "某个后台页面筛不到/显示成原始枚举值"，不会有任何报错
  EMOTION_REPORT: 'EMOTION_REPORT',
};

/** 库内类型 → 契约类型 */
const DB_TO_TYPE: Readonly<Record<string, AdminReportType>> = {
  MBTI_REPORT: 'MBTI_REPORT',
  BIG_FIVE_REPORT: 'BIG_FIVE_REPORT',
  GROWTH_SUMMARY: 'GROWTH_REPORT',
  RELATIONSHIP_REPORT: 'COMPATIBILITY_REPORT',
  EMOTION_REPORT: 'EMOTION_REPORT',
};

/** 契约状态 → 库内 `AiReportStatus`（`PARTIAL` 无对应成员，以条件表达） */
const STATUS_TO_DB: Readonly<Record<AdminReportStatus, string>> = {
  PENDING: 'QUEUED',
  GENERATING: 'GENERATING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PARTIAL: 'FAILED',
};

/** 解锁判定用的权益状态（`CONSUMED` 仍视为已解锁：一次性权益用尽 ≠ 未解锁） */
const UNLOCKED_ENTITLEMENT_STATUSES = ['ACTIVE', 'CONSUMED'] as const;

/** 正文预览长度（即使允许查看正文也不整篇回传） */
const CONTENT_PREVIEW_LENGTH = 200;

/** 报告条目（契约 §3.14.7.5） */
export interface AdminAiReportItem {
  reportId: string;
  type: string;
  typeName: string;
  status: string;
  userId: string | null;
  userNicknameMasked: string | null;
  title: string | null;
  mbtiType: string | null;
  profileVersion: number | null;
  engineVersion: string | null;
  wordCount: number;
  sectionCount: number;
  isUnlocked: boolean;
  unlockType: string | null;
  promptKey: string;
  promptVersion: number | null;
  provider: string | null;
  model: string | null;
  totalTokens: number;
  costCents: number;
  generationDurationMs: number;
  cacheHit: boolean;
  regenerateCount: number;
  /**
   * 用户反馈
   *
   * 契约的 `userFeedback` 来自用户在 `POST /reports/{id}/regenerate` 提交的
   * `reason`/`feedback`，但当前 schema **没有**承载它的表/列
   * （`ai_reports` 只有 `retry_count` / `quality_score`），因此恒为 `null`。
   */
  userFeedback: null;
  safetyFlagged: boolean;
  createdAt: string;
  generatedAt: string | null;
  hasPdf: boolean;
  contentPreview: string | null;
  failureReason?: string | null;
  relationshipId?: string | null;
  overallScore?: number | null;
  qualityIssue?: boolean;
}

/** `byPromptVersion[]` 项 */
export interface AdminAiReportPromptVersionStat {
  promptKey: string;
  promptVersion: number | null;
  reportCount: number;
  averageWordCount: number;
  regenerateRate: number;
  unlockRate: number;
}

/** 报告列表响应（契约 §3.14.7.5） */
export interface AdminAiReportListView {
  items: AdminAiReportItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: {
    totalReports: number;
    succeededCount: number;
    failedCount: number;
    partialCount: number;
    generatingCount: number;
    unlockedCount: number;
    unlockRate: number;
    averageWordCount: number;
    averageGenerationMs: number;
    cacheHitRate: number;
    regenerateRate: number;
    safetyFlaggedCount: number;
    byPromptVersion: AdminAiReportPromptVersionStat[];
  };
  privacyNotice: string;
}

/** 隐私说明（契约 §3.14.7.5 原文） */
const PRIVACY_NOTICE =
  '报告正文默认不返回（includeContent=false）。如需查看正文，接口要求二次确认密码并将记录高等级审计（用于内容合规抽检）。';

/** 类型 × 状态聚合桶 */
interface TypeStatusBucket {
  type: string;
  status: string;
  _count: { _all: number };
  _avg: { contentLength: number | null };
}

/** prompt 版本聚合桶 */
interface PromptBucket {
  promptTemplateKey: string;
  promptVersionId: string | null;
  _count: { _all: number };
  _avg: { contentLength: number | null };
}

/** prompt 版本计数桶 */
interface PromptCountBucket {
  promptTemplateKey: string;
  promptVersionId: string | null;
  _count: { _all: number };
}

@Injectable()
export class AdminAiReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * 报告列表（契约 §3.14.7.5）
   *
   * @param adminUserId     当前管理员（正文访问审计用）
   * @param confirmPassword `X-Confirm-Password` 原值（仅 `includeContent = true` 时校验）
   */
  async listReports(
    query: AiReportsQueryDto,
    adminUserId: string,
    confirmPassword: string | undefined,
  ): Promise<AdminAiReportListView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ADMIN_AI_DEFAULT_PAGE_SIZE;
    const includeContent = query.includeContent ?? false;

    if (
      query.minWordCount !== undefined &&
      query.maxWordCount !== undefined &&
      query.minWordCount > query.maxWordCount
    ) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'minWordCount 不能大于 maxWordCount');
    }

    const where = await this.buildWhere(query);

    // 先校验访问权限再查库：未通过时不应把任何报告数据取到内存
    if (includeContent) {
      await this.assertContentAccess(adminUserId, confirmPassword);
    }

    const [
      rows,
      total,
      typeStatusBuckets,
      promptBuckets,
      regenBuckets,
      unlockBuckets,
      safetyFlaggedCount,
      cacheHitCount,
      latencyAggregate,
    ] = await Promise.all([
      this.prisma.aiReport.findMany({
        where,
        orderBy: this.buildOrderBy(query.sortBy ?? 'createdAt', query.order ?? 'desc'),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.aiReport.count({ where }),
      this.prisma.aiReport.groupBy({
        by: ['type', 'status'],
        where,
        _count: { _all: true },
        _avg: { contentLength: true },
      }),
      this.prisma.aiReport.groupBy({
        by: ['promptTemplateKey', 'promptVersionId'],
        where,
        _count: { _all: true },
        _avg: { contentLength: true },
      }),
      this.prisma.aiReport.groupBy({
        by: ['promptTemplateKey', 'promptVersionId'],
        where: { AND: [where, { retryCount: { gt: 0 } }] },
        _count: { _all: true },
      }),
      this.prisma.aiReport.groupBy({
        by: ['promptTemplateKey', 'promptVersionId'],
        where: { AND: [where, { entitlements: { some: this.unlockedEntitlementFilter() } }] },
        _count: { _all: true },
      }),
      this.prisma.aiReport.count({ where: { AND: [where, { callAudits: { some: { status: 'BLOCKED' } } }] } }),
      this.prisma.aiReport.count({ where: { AND: [where, { usageLogs: { some: { cacheHit: true } } }] } }),
      this.prisma.aiReport.aggregate({ where, _avg: { latencyMs: true } }),
    ]);

    const [items, promptVersionNumbers] = await Promise.all([
      this.toItems(rows, includeContent),
      this.loadPromptVersionNumbers(promptBuckets),
    ]);

    if (includeContent) {
      await this.writeContentAccessAudit(adminUserId, items.length, query);
    }

    return {
      items,
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary: this.buildSummary({
        total,
        typeStatusBuckets,
        promptBuckets,
        regenBuckets,
        unlockBuckets,
        promptVersionNumbers,
        safetyFlaggedCount,
        cacheHitCount,
        averageGenerationMs: Math.round(latencyAggregate._avg.latencyMs ?? 0),
      }),
      privacyNotice: PRIVACY_NOTICE,
    };
  }

  // ==========================================================================
  // 关键子流程
  // ==========================================================================

  /**
   * 校验「查看报告正文」的二次确认
   *
   * 与 `ConfirmPasswordGuard` 保持同一语义：同样的错误码、同样不区分
   * 「管理员不存在」与「密码错误」（否则会给出探测管理员 ID 是否有效的旁路）。
   */
  private async assertContentAccess(adminUserId: string, confirmPassword: string | undefined): Promise<void> {
    if (confirmPassword === undefined || confirmPassword.length === 0) {
      throw BusinessException.unauthorized(
        ErrorCode.ADMIN_CONFIRM_PASSWORD_REQUIRED,
        '查看报告正文需要二次确认密码，请重新输入登录密码',
      );
    }

    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
      select: { passwordHash: true },
    });

    if (admin === null) {
      throw BusinessException.unauthorized(ErrorCode.ADMIN_CONFIRM_PASSWORD_INVALID, '二次确认密码错误');
    }

    const ok = await this.passwords.verify(admin.passwordHash, confirmPassword);
    if (!ok) {
      throw BusinessException.unauthorized(ErrorCode.ADMIN_CONFIRM_PASSWORD_INVALID, '二次确认密码错误');
    }
  }

  /** 高等级审计：记录「谁在什么筛选条件下读取了多少份报告正文」 */
  private async writeContentAccessAudit(
    adminUserId: string,
    itemCount: number,
    query: AiReportsQueryDto,
  ): Promise<void> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
      select: { username: true, nickname: true, realName: true },
    });

    await this.audit.log({
      adminUserId,
      adminUsername: admin?.nickname ?? admin?.realName ?? admin?.username ?? adminUserId,
      action: AdminAuditAction.EXPORT,
      resourceType: 'ai_report_content',
      // 只读接口没有单个资源 ID：用筛选摘要作为可追溯依据（契约要求「含查询条件」）
      afterData: {
        includeContent: true,
        type: query.type ?? null,
        status: query.status ?? null,
        userId: query.userId ?? null,
        promptKey: query.promptKey ?? null,
        promptVersion: query.promptVersion ?? null,
        returnedItems: itemCount,
      },
      diffSummary: `查看报告正文（合规抽检，返回 ${itemCount} 条预览）`,
      reason: '报告正文属敏感内容，读取行为按契约 §3.14.7.5 规则 1 记录高等级审计',
    });
  }

  // ==========================================================================
  // 查询条件
  // ==========================================================================

  private async buildWhere(query: AiReportsQueryDto): Promise<Prisma.AiReportWhereInput> {
    const and: Prisma.AiReportWhereInput[] = [{ deletedAt: null }];

    if (query.type !== undefined && query.type.length > 0) {
      and.push({ OR: this.typeConditions(query.type) });
    }

    if (query.status !== undefined && query.status.length > 0) {
      and.push({ OR: this.statusConditions(query.status) });
    }

    if (query.userId !== undefined) and.push({ userId: query.userId });

    if (query.isUnlocked !== undefined) {
      and.push({
        entitlements: query.isUnlocked
          ? { some: this.unlockedEntitlementFilter() }
          : { none: this.unlockedEntitlementFilter() },
      });
    }

    if (query.promptKey !== undefined) and.push({ promptTemplateKey: query.promptKey });

    if (query.promptVersion !== undefined) {
      // `ai_reports` 只存 `prompt_version_id`，版本号在 `prompt_versions`：
      // 先取 id 集合再 IN，比 join 更简单且仍走主键索引
      const versions = await this.prisma.promptVersion.findMany({
        where: { version: query.promptVersion },
        select: { id: true },
      });
      and.push({ promptVersionId: { in: versions.map((version) => version.id) } });
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

    return { AND: and };
  }

  /** 契约类型 → OR 条件（`COMPATIBILITY_REPORT` 需要额外的 relationshipId 判定） */
  private typeConditions(types: readonly AdminReportType[]): Prisma.AiReportWhereInput[] {
    return types.map((type) =>
      type === 'COMPATIBILITY_REPORT'
        ? { type: 'RELATIONSHIP_REPORT', relationshipId: { not: null } }
        : { type: TYPE_TO_DB[type] as Prisma.AiReportWhereInput['type'] },
    );
  }

  /** 契约状态 → OR 条件 */
  private statusConditions(statuses: readonly AdminReportStatus[]): Prisma.AiReportWhereInput[] {
    return statuses.map((status) =>
      status === 'PARTIAL'
        ? { status: 'FAILED', relationshipId: { not: null } }
        : { status: STATUS_TO_DB[status] as Prisma.AiReportWhereInput['status'] },
    );
  }

  private unlockedEntitlementFilter(): Prisma.EntitlementWhereInput {
    return { deletedAt: null, status: { in: [...UNLOCKED_ENTITLEMENT_STATUSES] } };
  }

  /**
   * 排序映射
   *
   * 契约的 `generatedAt` 在 `ai_reports` 上叫 `generationFinishedAt`，
   * `wordCount` 是 `contentLength` —— 显式映射，避免「参数被静默忽略」。
   */
  private buildOrderBy(sortBy: AdminReportSortField, order: SortOrder): Prisma.AiReportOrderByWithRelationInput[] {
    const primary: Prisma.AiReportOrderByWithRelationInput =
      sortBy === 'generatedAt'
        ? { generationFinishedAt: order }
        : sortBy === 'wordCount'
          ? { contentLength: order }
          : sortBy === 'totalTokens'
            ? { totalTokens: order }
            : { createdAt: order };

    // 次级排序固定 id：`generatedAt` 可空，PostgreSQL 不保证稳定序，
    // 仅按单字段排序时分页会让同一条记录在第 1、2 页各出现一次
    return [primary, { id: 'desc' }];
  }

  // ==========================================================================
  // 条目组装（批量补齐关联，无 N+1）
  // ==========================================================================

  private async toItems(rows: readonly AiReport[], includeContent: boolean): Promise<AdminAiReportItem[]> {
    if (rows.length === 0) return [];

    const reportIds = rows.map((row) => row.id);
    const profileIds = rows.map((row) => row.profileId).filter((id): id is string => id !== null);
    const versionIds = rows.map((row) => row.promptVersionId).filter((id): id is string => id !== null);
    const userIds = rows.map((row) => row.userId);

    const [profiles, versions, entitlements, usageLogs, blockedAudits, compatReports, users] = await Promise.all([
      profileIds.length === 0
        ? Promise.resolve([])
        : this.prisma.personalityProfile.findMany({
            where: { id: { in: profileIds } },
            select: { id: true, mbtiType: true, version: true, engineVersion: true },
          }),
      versionIds.length === 0
        ? Promise.resolve([])
        : this.prisma.promptVersion.findMany({
            where: { id: { in: versionIds } },
            select: { id: true, version: true },
          }),
      this.prisma.entitlement.findMany({
        where: { reportId: { in: reportIds }, deletedAt: null, status: { in: [...UNLOCKED_ENTITLEMENT_STATUSES] } },
        select: { reportId: true, type: true },
      }),
      this.prisma.aiUsageLog.findMany({
        where: { reportId: { in: reportIds } },
        select: { reportId: true, cacheHit: true },
      }),
      this.prisma.aiCallAudit.findMany({
        where: { reportId: { in: reportIds }, status: 'BLOCKED' },
        select: { reportId: true },
      }),
      this.prisma.compatibilityReport.findMany({
        where: { aiReportId: { in: reportIds } },
        select: { aiReportId: true, totalScore: true, engineVersion: true },
      }),
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, nickname: true } }),
    ]);

    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const versionById = new Map(versions.map((version) => [version.id, version.version]));
    const nicknameById = new Map(users.map((user) => [user.id, user.nickname]));
    const unlockByReport = new Map(entitlements.map((item) => [item.reportId ?? '', item.type]));
    const cacheHitReports = new Set(usageLogs.filter((log) => log.cacheHit).map((log) => log.reportId ?? ''));
    const blockedReports = new Set(blockedAudits.map((audit) => audit.reportId ?? ''));
    const compatByReport = new Map(compatReports.map((report) => [report.aiReportId ?? '', report]));

    return rows.map((row) => {
      const contractType = DB_TO_TYPE[row.type] ?? row.type;
      const isCompatibility = contractType === 'COMPATIBILITY_REPORT';
      const profile = row.profileId === null ? undefined : profileById.get(row.profileId);
      const compat = compatByReport.get(row.id);
      const status = this.toContractStatus(row.status, isCompatibility);
      const generatedAt = row.generationFinishedAt;
      const isProblem = status === 'PARTIAL' || status === 'FAILED';

      return {
        reportId: row.id,
        type: contractType,
        // 复用 ai 模块的类型中文名表（含 GROWTH_SUMMARY → 成长回顾报告），避免两处口径漂移
        typeName: reportTypeName(row.type),
        status,
        // 契约规则 5：匹配报告归属关系而非单用户，因此 userId / 昵称置 null
        userId: isCompatibility ? null : row.userId,
        userNicknameMasked: isCompatibility ? null : maskNickname(nicknameById.get(row.userId) ?? null),
        title: row.title,
        mbtiType: profile?.mbtiType ?? null,
        profileVersion: profile?.version ?? null,
        engineVersion: profile?.engineVersion ?? compat?.engineVersion ?? null,
        wordCount: row.contentLength,
        sectionCount: row.sectionCount,
        isUnlocked: unlockByReport.has(row.id),
        unlockType: unlockByReport.get(row.id) ?? null,
        promptKey: row.promptTemplateKey,
        promptVersion: row.promptVersionId === null ? null : (versionById.get(row.promptVersionId) ?? null),
        provider: row.provider === null ? null : row.provider.toLowerCase(),
        model: row.model,
        totalTokens: row.totalTokens,
        costCents: row.costAmount,
        generationDurationMs: this.generationDurationOf(row),
        cacheHit: cacheHitReports.has(row.id),
        regenerateCount: row.retryCount,
        userFeedback: null,
        safetyFlagged: blockedReports.has(row.id),
        createdAt: row.createdAt.toISOString(),
        generatedAt: generatedAt?.toISOString() ?? null,
        hasPdf: row.pdfUrl !== null,
        contentPreview: includeContent ? previewOf(row.content) : null,
        ...(isProblem ? { failureReason: row.errorMessage ?? 'AI 解读生成失败' } : {}),
        ...(isCompatibility ? { relationshipId: row.relationshipId, overallScore: compat?.totalScore ?? null } : {}),
        qualityIssue: isProblem || blockedReports.has(row.id),
      };
    });
  }

  /**
   * 生成耗时
   *
   * 优先用「开始 → 结束」墙钟差（用户实际等待时长）；缺失时回落 `latencyMs`
   * （单次模型调用耗时）。口径与 `report-list.util.computeGenerationDurationMs`
   * 一致 —— 两者不可混用，一次生成可能包含多次调用与重试。
   */
  private generationDurationOf(row: AiReport): number {
    if (row.generationStartedAt !== null && row.generationFinishedAt !== null) {
      return Math.max(0, row.generationFinishedAt.getTime() - row.generationStartedAt.getTime());
    }

    return Math.max(0, row.latencyMs ?? 0);
  }

  /** 契约状态推导 */
  private toContractStatus(dbStatus: string, isCompatibility: boolean): string {
    if (dbStatus === 'QUEUED') return 'PENDING';
    if (dbStatus === 'FAILED' && isCompatibility) return 'PARTIAL';
    return dbStatus;
  }

  /** 摘要里的 prompt 版本号（`promptVersionId` → `version`） */
  private async loadPromptVersionNumbers(buckets: readonly PromptBucket[]): Promise<Map<string, number>> {
    const versionIds = buckets.map((bucket) => bucket.promptVersionId).filter((id): id is string => id !== null);
    if (versionIds.length === 0) return new Map();

    const versions = await this.prisma.promptVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, version: true },
    });

    return new Map(versions.map((version) => [version.id, version.version]));
  }

  // ==========================================================================
  // 摘要
  // ==========================================================================

  private buildSummary(input: {
    total: number;
    typeStatusBuckets: readonly TypeStatusBucket[];
    promptBuckets: readonly PromptBucket[];
    regenBuckets: readonly PromptCountBucket[];
    unlockBuckets: readonly PromptCountBucket[];
    promptVersionNumbers: ReadonlyMap<string, number>;
    safetyFlaggedCount: number;
    cacheHitCount: number;
    averageGenerationMs: number;
  }): AdminAiReportListView['summary'] {
    const { total } = input;

    let succeededCount = 0;
    let failedCount = 0;
    let partialCount = 0;
    let generatingCount = 0;
    let wordCountSum = 0;
    let wordCountWeight = 0;

    for (const bucket of input.typeStatusBuckets) {
      const count = bucket._count._all;
      const isCompatibility = bucket.type === 'RELATIONSHIP_REPORT';

      if (bucket.status === 'SUCCEEDED') succeededCount += count;

      if (bucket.status === 'FAILED') {
        // 匹配报告的 FAILED 对外呈现为 PARTIAL：算分已完成、只有 AI 解读失败，
        // 与「整份报告失败」是两种不同的运营含义，混在一个计数里会误导抽检优先级
        if (isCompatibility) partialCount += count;
        else failedCount += count;
      }

      if (bucket.status === 'QUEUED' || bucket.status === 'GENERATING') generatingCount += count;

      if (bucket._avg.contentLength !== null) {
        wordCountSum += bucket._avg.contentLength * count;
        wordCountWeight += count;
      }
    }

    const regenByKey = bucketKeyMap(input.regenBuckets);
    const unlockByKey = bucketKeyMap(input.unlockBuckets);
    const unlockedCount = [...unlockByKey.values()].reduce((sum, value) => sum + value, 0);

    const byPromptVersion: AdminAiReportPromptVersionStat[] = input.promptBuckets.map((bucket) => {
      const key = bucketKey(bucket.promptTemplateKey, bucket.promptVersionId);
      const count = bucket._count._all;

      return {
        promptKey: bucket.promptTemplateKey,
        // `promptVersionId` 为 null 表示历史报告未记录版本，**不代表 v0**
        promptVersion: promptVersionOf(bucket.promptVersionId, input.promptVersionNumbers),
        reportCount: count,
        averageWordCount: Math.round(bucket._avg.contentLength ?? 0),
        regenerateRate: rateOfCount(count === 0 ? 0 : (regenByKey.get(key) ?? 0), count),
        unlockRate: rateOfCount(count === 0 ? 0 : (unlockByKey.get(key) ?? 0), count),
      };
    });

    return {
      totalReports: total,
      succeededCount,
      failedCount,
      partialCount,
      generatingCount,
      unlockedCount,
      unlockRate: rateOfCount(unlockedCount, total),
      averageWordCount: wordCountWeight === 0 ? 0 : Math.round(wordCountSum / wordCountWeight),
      averageGenerationMs: input.averageGenerationMs,
      cacheHitRate: rateOfCount(input.cacheHitCount, total),
      regenerateRate: rateOfCount(
        input.regenBuckets.reduce((sum, bucket) => sum + bucket._count._all, 0),
        total,
      ),
      safetyFlaggedCount: input.safetyFlaggedCount,
      byPromptVersion,
    };
  }
}

/** 预览文本（按字符截断：按字节截断会把汉字切成两半，产生乱码） */
const previewOf = (content: string | null): string | null => {
  if (content === null) return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= CONTENT_PREVIEW_LENGTH ? trimmed : `${trimmed.slice(0, CONTENT_PREVIEW_LENGTH)}…`;
};

/** 比率（分母为 0 → 0，避免 NaN 被序列化成 null） */
const rateOfCount = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));

const bucketKey = (promptKey: string, versionId: string | null): string => `${promptKey}#${versionId ?? 'none'}`;

/**
 * 版本 ID → 版本号
 *
 * 抽成函数而不是内联三元：`cond ? null : map.get(id) ?? null` 这种「三元 + 空值合并」
 * 混写既难读，也容易被格式化工具改写成不同形态（造成 diff 噪音）。
 */
const promptVersionOf = (versionId: string | null, versions: ReadonlyMap<string, number>): number | null => {
  if (versionId === null) return null;
  return versions.get(versionId) ?? null;
};

const bucketKeyMap = (buckets: readonly PromptCountBucket[]): Map<string, number> =>
  new Map(buckets.map((bucket) => [bucketKey(bucket.promptTemplateKey, bucket.promptVersionId), bucket._count._all]));
