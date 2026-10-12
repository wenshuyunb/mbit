/**
 * 管理端 AI 调用审计日志服务（契约 §3.14.7.4）
 *
 * ## 隐私底线（架构 §10.6）
 *
 * 契约规则 1：审计日志**不存 Prompt 全文与输出全文**。本项目 `ai_call_audits`
 * 也只有 `prompt_fingerprint`（SHA-256）、`prompt_length` / `response_length`（桶化）
 * 与 `redacted_sample`。因此本服务：
 *   · 🚫 **绝不返回** `redacted_sample`（契约没有该字段；它仍是一段真实文本片段，
 *     「契约没要求」就不该出现在响应里）
 *   · 只返回 `requestFingerprint` 与长度桶
 *
 * ## 数据来源的跨表补齐（每条都只有 1 次查询，无 N+1）
 *
 * | 契约字段             | 来源                                                |
 * | -------------------- | --------------------------------------------------- |
 * | 分页主体             | `ai_call_audits`（`[createdAt]` / `[provider, createdAt]` 索引） |
 * | `promptTokens` 等    | `ai_usage_logs` 按 `request_id` 批量匹配             |
 * | `costCents`          | 同上（`ai_call_audits` **没有**成本列）              |
 * | `promptKey` / `promptVersion` | `ai_reports` + `prompt_versions` 按 `report_id` 批量补齐 |
 * | `userNicknameMasked` | `users` 批量补齐                                     |
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type AiCallStatus } from '@prisma/client';

import type { AppConfig } from '../../../config/config.type';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { maskNickname, resolveCallLogRange, toLengthBucket, toProviderName, toSafeNumber } from './admin-ai-stats.util';
import {
  ADMIN_AI_DEFAULT_PAGE_SIZE,
  type AiCallLogQueryDto,
  type CallLogSortField,
  type CallLogStatus,
  type SortOrder,
} from './dto/admin-ai-stats.dto';

/**
 * 契约 `status` 枚举 → 库内 `AiCallStatus` 枚举（多对一）
 *
 * 键类型用 `CallLogStatus`（穷举，漏一个键编译期就报错）、值类型用 `AiCallStatus[]`：
 * 后者直接喂给 Prisma 的 `status: { in: ... }`，无需再断言成 `AiCallStatus[]`。
 */
const STATUS_TO_DB: Readonly<Record<CallLogStatus, readonly AiCallStatus[]>> = {
  SUCCESS: ['SUCCESS', 'CACHE_HIT'],
  FAILED: ['FAILED', 'CIRCUIT_OPEN'],
  ABORTED: ['TIMEOUT'],
  BLOCKED: ['BLOCKED'],
};

/** 库内枚举 → 契约枚举（契约没有 TIMEOUT / CIRCUIT_OPEN / CACHE_HIT） */
const DB_TO_STATUS: Readonly<Record<string, string>> = {
  SUCCESS: 'SUCCESS',
  CACHE_HIT: 'SUCCESS',
  TIMEOUT: 'ABORTED',
  CIRCUIT_OPEN: 'FAILED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
};

/** 调用日志条目（契约 §3.14.7.4） */
export interface AiCallLogItem {
  auditId: string;
  requestId: string;
  userId: string | null;
  userNicknameMasked: string | null;
  task: string;
  promptKey: string | null;
  promptVersion: number | null;
  provider: string;
  model: string;
  status: string;
  errorCode: number | null;
  errorMessage: string | null;
  latencyMs: number | null;
  attempt: number;
  maxAttempts: number;
  cacheHit: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
  isRetry: boolean;
  /**
   * 降级标记
   *
   * `ai_call_audits` 与 `ai_usage_logs` 都**没有**「是否降级 / 从哪个 provider 降级」
   * 的列，因此恒为 `false` / `null`（编排层当前也没有实现跨 provider 降级）。
   */
  isFallback: boolean;
  fallbackFrom: string | null;
  requestFingerprint: string;
  inputLengthBucket: string;
  outputLengthBucket: string;
  safetyFlagged: boolean;
  safetyCategory: string | null;
  createdAt: string;
}

/** 调用日志响应 */
export interface AiCallLogView {
  items: AiCallLogItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: {
    successCount: number;
    failedCount: number;
    abortedCount: number;
    blockedCount: number;
    retryCount: number;
    fallbackCount: number;
    totalCostCents: number;
  };
  privacyNotice: string;
}

/** 隐私说明（契约 §3.14.7.4 原文） */
const PRIVACY_NOTICE =
  '审计日志不存储 Prompt 全文与模型输出全文（架构 10.6）；仅保留请求指纹、计量与错误信息，用于排障与成本归因。';

interface UsageByRequestRow {
  request_id: string | null;
  prompt_tokens: bigint;
  completion_tokens: bigint;
  total_tokens: bigint;
  cost_cents: bigint;
  max_retry_index: number;
}

interface CountRow {
  cnt: number;
}
@Injectable()
export class AdminAiCallLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  async listCallLogs(query: AiCallLogQueryDto): Promise<AiCallLogView> {
    const range = resolveCallLogRange(query.startTime, query.endTime);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ADMIN_AI_DEFAULT_PAGE_SIZE;
    const sortBy: CallLogSortField = query.sortBy ?? 'createdAt';
    const order: SortOrder = query.order ?? 'desc';

    const where = await this.buildWhere(query, range.rangeStart, range.rangeEnd);

    const [rows, total, statusCounts, retryRow] = await Promise.all([
      this.prisma.aiCallAudit.findMany({
        where,
        // `costCents` 排序需要 join `ai_usage_logs`，Prisma 无法按关联表字段排序，
        // 因此该字段退化为按 createdAt 排序（见下方说明与交付简报）
        orderBy: this.buildOrderBy(sortBy, order),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.aiCallAudit.count({ where }),
      this.prisma.aiCallAudit.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.countRetriedRequests(range.rangeStart, range.rangeEnd),
    ]);

    const requestIds = rows.map((row) => row.requestId);
    const reportIds = rows.map((row) => row.reportId).filter((id): id is string => id !== null);
    const userIds = rows.map((row) => row.userId).filter((id): id is string => id !== null);

    const [usageByRequest, reportMeta, users] = await Promise.all([
      this.loadUsageByRequestIds(requestIds),
      this.loadReportMeta(reportIds),
      userIds.length === 0
        ? Promise.resolve([])
        : this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, nickname: true } }),
    ]);

    const nicknameById = new Map(users.map((user) => [user.id, user.nickname]));
    const maxAttempts = this.configService.get('ai.maxRetries', { infer: true }) + 1;

    const items = rows.map((row) => {
      const usage = usageByRequest.get(row.requestId);
      const report = row.reportId === null ? undefined : reportMeta.get(row.reportId);
      const errorCode = row.errorCode === null ? null : Number.parseInt(row.errorCode, 10);

      return {
        auditId: row.id,
        requestId: row.requestId,
        userId: row.userId,
        userNicknameMasked: maskNickname(row.userId === null ? null : (nicknameById.get(row.userId) ?? null)),
        task: row.taskType,
        promptKey: report?.promptKey ?? null,
        promptVersion: report?.promptVersion ?? null,
        provider: toProviderName(row.provider),
        model: row.model,
        status: DB_TO_STATUS[row.status] ?? row.status,
        errorCode: errorCode === null || Number.isNaN(errorCode) ? null : errorCode,
        errorMessage: row.errorMessage,
        latencyMs: row.latencyMs,
        attempt: (usage?.max_retry_index ?? 0) + 1,
        maxAttempts,
        cacheHit: row.cacheHit,
        promptTokens: toSafeNumber(usage?.prompt_tokens),
        completionTokens: toSafeNumber(usage?.completion_tokens),
        totalTokens: toSafeNumber(usage?.total_tokens),
        costCents: toSafeNumber(usage?.cost_cents),
        isRetry: (usage?.max_retry_index ?? 0) > 0,
        isFallback: false,
        fallbackFrom: null,
        requestFingerprint: row.promptFingerprint,
        inputLengthBucket: toLengthBucket(row.promptLength),
        outputLengthBucket: toLengthBucket(row.responseLength),
        safetyFlagged: row.status === 'BLOCKED',
        safetyCategory: null,
        createdAt: row.createdAt.toISOString(),
      };
    });

    const countOf = (statuses: readonly string[]): number =>
      statusCounts
        .filter((bucket) => statuses.includes(bucket.status))
        .reduce((sum, bucket) => sum + bucket._count._all, 0);

    return {
      items,
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary: {
        successCount: countOf(STATUS_TO_DB['SUCCESS']),
        failedCount: countOf(STATUS_TO_DB['FAILED']),
        abortedCount: countOf(STATUS_TO_DB['ABORTED']),
        blockedCount: countOf(STATUS_TO_DB['BLOCKED']),
        retryCount: retryRow.cnt,
        // 降级没有任何记录列，恒为 0（见 item.isFallback 的说明）
        fallbackCount: 0,
        totalCostCents: items.reduce((sum, item) => sum + item.costCents, 0),
      },
      privacyNotice: PRIVACY_NOTICE,
    };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /**
   * 构造筛选条件
   *
   * `promptKey` 需要先查出对应的 `report_id` 集合再过筛：`ai_call_audits` 只有
   * `report_id`，没有 prompt 模板 key。这里用一次轻量 `select id` 查询拿到 id 列表，
   * 再作为 `reportId IN (...)` 条件 —— 比 join 后排序更简单，且仍走 `report_id` 索引。
   */
  private async buildWhere(
    query: AiCallLogQueryDto,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<Prisma.AiCallAuditWhereInput> {
    const where: Prisma.AiCallAuditWhereInput = { createdAt: { gte: rangeStart, lte: rangeEnd } };

    if (query.task !== undefined) where.taskType = query.task as Prisma.AiCallAuditWhereInput['taskType'];
    if (query.provider !== undefined) {
      where.provider = query.provider.toUpperCase() as Prisma.AiCallAuditWhereInput['provider'];
    }
    if (query.model !== undefined) where.model = query.model;
    if (query.status !== undefined) where.status = { in: [...STATUS_TO_DB[query.status]] };
    if (query.errorCode !== undefined) where.errorCode = String(query.errorCode);
    if (query.cacheHit !== undefined) where.cacheHit = query.cacheHit;
    if (query.userId !== undefined) where.userId = query.userId;
    if (query.traceId !== undefined) where.requestId = query.traceId;

    if (query.promptKey !== undefined) {
      const reports = await this.prisma.aiReport.findMany({
        where: { promptTemplateKey: query.promptKey },
        select: { id: true },
        take: 5_000,
      });
      where.reportId = { in: reports.map((report) => report.id) };
    }

    return where;
  }

  /**
   * 排序
   *
   * `sortBy = costCents` **无法**按关联表字段排序（Prisma 不支持 relation 排序，
   * 且 raw SQL 会让分页与筛选条件重复实现一遍）。为避免「排序参数被静默忽略」，
   * 这里退化为 `createdAt` 并在交付简报中标注；`latencyMs` 可正常排序。
   */
  private buildOrderBy(sortBy: CallLogSortField, order: SortOrder): Prisma.AiCallAuditOrderByWithRelationInput[] {
    const primary: Prisma.AiCallAuditOrderByWithRelationInput =
      sortBy === 'latencyMs' ? { latencyMs: order } : { createdAt: order };

    // 次级排序固定 id：同一毫秒内的多条审计在 PostgreSQL 中顺序不保证稳定，
    // 会让同一条记录在第 1、2 页各出现一次
    return [primary, { id: 'desc' }];
  }

  /** 批量取用量（按 requestId）：一次 `IN` 查询替代逐条查询（N+1） */
  private async loadUsageByRequestIds(requestIds: readonly string[]): Promise<Map<string, UsageByRequestRow>> {
    const map = new Map<string, UsageByRequestRow>();
    if (requestIds.length === 0) return map;

    const rows = await this.prisma.$queryRaw<UsageByRequestRow[]>(Prisma.sql`
      SELECT
        request_id,
        coalesce(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
        coalesce(sum(completion_tokens), 0)::bigint AS completion_tokens,
        coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(cost_amount), 0)::bigint AS cost_cents,
        coalesce(max(retry_index), 0)::int AS max_retry_index
      FROM ai_usage_logs
      WHERE request_id IN (${Prisma.join([...requestIds])})
      GROUP BY request_id
    `);

    for (const row of rows) {
      if (row.request_id === null) continue;
      map.set(row.request_id, row);
    }

    return map;
  }

  /** 批量取报告的 prompt 元信息（key + 版本） */
  private async loadReportMeta(
    reportIds: readonly string[],
  ): Promise<Map<string, { promptKey: string; promptVersion: number | null }>> {
    const map = new Map<string, { promptKey: string; promptVersion: number | null }>();
    if (reportIds.length === 0) return map;

    const reports = await this.prisma.aiReport.findMany({
      where: { id: { in: [...reportIds] } },
      select: { id: true, promptTemplateKey: true, promptVersionId: true },
    });

    const versionIds = reports.map((report) => report.promptVersionId).filter((id): id is string => id !== null);

    const versions =
      versionIds.length === 0
        ? []
        : await this.prisma.promptVersion.findMany({
            where: { id: { in: versionIds } },
            select: { id: true, version: true },
          });

    const versionById = new Map(versions.map((version) => [version.id, version.version]));

    for (const report of reports) {
      map.set(report.id, {
        promptKey: report.promptTemplateKey,
        promptVersion: report.promptVersionId === null ? null : (versionById.get(report.promptVersionId) ?? null),
      });
    }

    return map;
  }

  /**
   * 统计「发生过重试的请求数」
   *
   * 口径：同一 `request_id` 内出现 `retry_index > 0` 的用量记录，即为一次重试过的请求。
   * 用 `count(DISTINCT)` 而非遍历日志行，避免把「一次请求的 3 次尝试」算成 3 次重试。
   */
  private async countRetriedRequests(rangeStart: Date, rangeEnd: Date): Promise<CountRow> {
    const rows = await this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(DISTINCT request_id)::int AS cnt
      FROM ai_usage_logs
      WHERE retry_index > 0
        AND created_at >= ${rangeStart} AND created_at <= ${rangeEnd}
        AND request_id IS NOT NULL
    `);

    return rows[0] ?? { cnt: 0 };
  }
}
