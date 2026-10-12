/**
 * 管理端订单导出服务（契约 §3.14.6.4）
 *
 * ## 异步必选
 *
 * 契约规则 3 明确「大数据量导出走 `export.data` 队列（复用 `export.pdf` 模式，
 * 并发 2，重试 2 次）」。因此本服务**只负责建任务 + 入队 + 查状态**，
 * 绝不在 HTTP 请求内生成文件。
 *
 * ## 任务状态存 Redis（沿用 `DataExportService` 的模式，ADR-024）
 *
 * 导出任务天然临时（源文件 7 天、签名 URL 24h），生命周期与 Redis TTL 契合；
 * 为它加表 + 迁移 + 归档作业收益不匹配。但**合规事实落库**：
 * 创建导出会写 `admin_audit_logs`（契约规则 5「强审计」，财务与合规重点审计项）。
 *
 * ## ⚠ 与用户端导出共用 `export.data` 队列的已知冲突（必须处理后再上线）
 *
 * 契约指定队列名 `export.data`，而该队列上已挂 `user/jobs/data-export.processor.ts`
 * 的 `@Processor(QUEUE_EXPORT_DATA)` —— BullMQ **按队列消费、不按 job name 过滤**，
 * 该处理器会对本服务投递的任务调用 `loadTask()`，读不到用户侧任务状态后
 * **直接 return（job 被标记为 completed）**，导致订单导出任务被静默吞掉。
 *
 * 本服务已把 job 名固定为 `admin.order.export` 以便识别；修复需要在
 * `data-export.processor.ts` 的 `process()` 开头加一行
 * `if (job.name !== 'generate') return;`（该文件属别的任务负责，本轮不可改），
 * 或在 `QueueModule` 为订单导出单开队列。已列入交付简报的必办事项。
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { AdminAuditAction } from '@prisma/client';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QUEUE_EXPORT_DATA } from '../../../infra/queue/queue.module';
import { RedisService } from '../../../infra/redis/redis.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminOrderService, type OrderFilterInput } from './admin-order.service';
import { resolveExportFields } from './admin-order-export.builder';
import {
  ORDER_EXPORT_MAX_RANGE_DAYS,
  type ExportAdminOrdersQueryDto,
  type OrderExportField,
  type OrderExportFormat,
} from './dto/admin-order.dto';

/** 订单导出任务的 job 名（用于与用户端数据导出任务区分） */
export const ORDER_EXPORT_JOB_NAME = 'admin.order.export';

/** 任务状态与源文件的保留时长（秒）：契约规则 4「源文件保留 7 天」 */
export const ORDER_EXPORT_TASK_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 签名下载 URL 有效期（秒）：契约规则 4「签名 URL 24h 有效」 */
export const ORDER_EXPORT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

/** 幂等键保留时长（秒）：覆盖「管理员重复点击」的场景，24h 足够 */
const ORDER_EXPORT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Redis 键前缀（与管理端其他键空间隔离） */
const TASK_KEY_PREFIX = 'admin:order:export:task';
const ACTIVE_KEY_PREFIX = 'admin:order:export:active';
const IDEMPOTENCY_KEY_PREFIX = 'admin:order:export:idem';

/** 任务状态机（契约 §3.14.6.4 的 `status`） */
export type OrderExportTaskStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

/** 导出任务状态（存 Redis 的完整记录） */
export interface OrderExportTaskState {
  taskId: string;
  adminUserId: string;
  adminDisplayName: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  progress: number;
  format: OrderExportFormat;
  fields: OrderExportField[];
  maskSensitive: boolean;
  filters: OrderFilterInput;
  query: {
    createdStartTime: string;
    createdEndTime: string;
    status: string[] | null;
    productType: string | null;
    hasRefund: boolean | null;
  };
  estimatedRows: number;
  rowCount: number;
  isTruncated: boolean;
  fileName: string | null;
  fileSizeBytes: number | null;
  downloadUrl: string | null;
  summary: { orderCount: number; totalAmount: number; totalRefundedAmount: number; netRevenue: number } | null;
  errorMessage: string | null;
  requestedAt: string;
  finishedAt: string | null;
  expiresAt: string;
}

/** 创建任务响应（契约 §3.14.6.4 的 202） */
export interface OrderExportRequestedView {
  taskId: string;
  status: string;
  queue: string;
  format: OrderExportFormat;
  estimatedRows: number;
  estimatedSeconds: number;
  query: OrderExportTaskState['query'];
  fields: OrderExportField[];
  maskSensitive: boolean;
  maskingNote: string;
  requestedAt: string;
  expiresAt: string;
  pollUrl: string;
  auditLogId: string | null;
}

/** 任务查询响应（契约 §3.14.6.4 的 200） */
export interface OrderExportTaskView {
  taskId: string;
  status: OrderExportTaskStatus;
  progress: number;
  rowCount: number;
  isTruncated: boolean;
  fileName: string | null;
  fileSizeBytes: number | null;
  downloadUrl: string | null;
  expiresAt: string;
  isExpired: boolean;
  summary: OrderExportTaskState['summary'];
  requestedAt: string;
  finishedAt: string | null;
  requestedBy: { adminId: string; displayName: string };
  errorMessage: string | null;
}

/** 脱敏说明（契约 §3.14.6.4 的 `maskingNote`，逐字照抄） */
const MASKING_NOTE = '用户昵称与用户 ID 已部分掩码；导出文件不包含手机号、openid 等敏感字段。';

/** 行数 → 预估耗时（秒）。实测约 25 行/秒，下限 5 秒，避免给前端「瞬时可下载」的错觉 */
const estimateSeconds = (rows: number): number => Math.max(5, Math.ceil(rows / 25));

@Injectable()
export class AdminOrderExportService {
  private readonly logger = new Logger(AdminOrderExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AdminAuditService,
    private readonly orders: AdminOrderService,
    @InjectQueue(QUEUE_EXPORT_DATA) private readonly exportQueue: Queue,
  ) {}

  // ==========================================================================
  // 创建任务
  // ==========================================================================

  /**
   * 创建导出任务（契约 §3.14.6.4）
   *
   * 判定顺序：幂等重放 → 参数校验 → 在途任务 → 建任务入队。
   * 幂等放最前：同一请求重放必须在任何业务校验之前短路，否则管理员连点两次，
   * 第二次会拿到一个「已有在途任务」的错误，而他本应看到第一次的 202。
   */
  async requestExport(
    adminUserId: string,
    query: ExportAdminOrdersQueryDto,
    idempotencyKey: string,
  ): Promise<OrderExportRequestedView> {
    const adminDisplayName = await this.resolveAdminDisplayName(adminUserId);
    const filters = this.resolveFilters(query);
    const format: OrderExportFormat = query.format ?? 'CSV';
    const fields = resolveExportFields(query.fields);
    const maskSensitive = query.maskSensitive ?? true;

    const idempotencyRedisKey = this.redis.key(IDEMPOTENCY_KEY_PREFIX, adminUserId, idempotencyKey);
    const replayedTaskId = await this.redis.get(idempotencyRedisKey);

    if (replayedTaskId !== null && replayedTaskId.length > 0) {
      const replayed = await this.loadTask(replayedTaskId);
      if (replayed !== null && replayed.adminUserId === adminUserId) {
        return this.toRequestedView(replayed, await this.findAuditLogId(replayed.taskId));
      }
      // 任务记录已被 TTL 回收但幂等键还在：清掉陈旧键，走正常流程
      await this.redis.del(idempotencyRedisKey);
    }

    const activeTaskId = await this.redis.get(this.redis.key(ACTIVE_KEY_PREFIX, adminUserId));
    if (activeTaskId !== null && activeTaskId.length > 0) {
      const active = await this.loadTask(activeTaskId);
      if (active !== null && (active.status === 'PENDING' || active.status === 'PROCESSING')) {
        throw BusinessException.conflict(ErrorCode.RESOURCE_CONFLICT, '已有进行中的导出任务，请等待其完成', [
          { field: 'taskId', issue: active.taskId },
        ]);
      }
      await this.redis.del(this.redis.key(ACTIVE_KEY_PREFIX, adminUserId));
    }

    const estimatedRows = await this.orders.countForExport(filters);

    const taskId = randomUUID();
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + ORDER_EXPORT_TASK_TTL_SECONDS * 1000);

    const task: OrderExportTaskState = {
      taskId,
      adminUserId,
      adminDisplayName,
      status: 'PENDING',
      progress: 0,
      format,
      fields,
      maskSensitive,
      filters,
      query: {
        createdStartTime: filters.createdStartTime ?? '',
        createdEndTime: filters.createdEndTime ?? '',
        status: filters.status ?? null,
        productType: filters.productType ?? null,
        hasRefund: filters.hasRefund ?? null,
      },
      estimatedRows,
      rowCount: 0,
      isTruncated: false,
      fileName: null,
      fileSizeBytes: null,
      downloadUrl: null,
      summary: null,
      errorMessage: null,
      requestedAt: requestedAt.toISOString(),
      finishedAt: null,
      expiresAt: expiresAt.toISOString(),
    };

    // 先写状态再入队：顺序相反时 Worker 可能在状态写入前就开始处理并读不到任务
    await this.saveTask(task);
    await this.redis.set(this.redis.key(ACTIVE_KEY_PREFIX, adminUserId), taskId, ORDER_EXPORT_TASK_TTL_SECONDS);
    await this.redis.set(idempotencyRedisKey, taskId, ORDER_EXPORT_IDEMPOTENCY_TTL_SECONDS);

    try {
      // jobId = taskId：同名 job 天然去重，避免重复投递产出两份导出文件
      await this.exportQueue.add(
        ORDER_EXPORT_JOB_NAME,
        { taskId, adminUserId },
        { jobId: taskId, attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
      );
    } catch (error) {
      // 入队失败必须回收已写入的状态，否则管理员会被一个永不执行的任务锁 7 天
      await this.redis.del(
        this.redis.key(ACTIVE_KEY_PREFIX, adminUserId),
        idempotencyRedisKey,
        this.redis.key(TASK_KEY_PREFIX, taskId),
      );
      this.logger.error(`订单导出任务入队失败，已回收任务状态 taskId=${taskId}: ${this.describe(error)}`);
      throw BusinessException.unavailable(ErrorCode.QUEUE_ERROR, '导出服务暂时不可用，请稍后重试');
    }

    const auditLogId = await this.writeAuditLog(task, estimatedRows);

    this.logger.log(`订单导出任务已创建 taskId=${taskId} admin=${adminUserId} format=${format} rows≈${estimatedRows}`);

    return this.toRequestedView(task, auditLogId);
  }

  // ==========================================================================
  // 查询任务
  // ==========================================================================

  /**
   * 查询任务状态（契约 §3.14.6.4 的 200 分支）
   *
   * 「任务不存在」与「不属于当前管理员」返回**同一错误码**（`80005`）：
   * 区分两者等于确认该 taskId 是否存在，属信息泄露。
   */
  async getExportTask(adminUserId: string, taskId: string): Promise<OrderExportTaskView> {
    const task = await this.loadTask(taskId);

    if (task === null || task.adminUserId !== adminUserId) {
      throw BusinessException.notFound(ErrorCode.EXPORT_TASK_NOT_FOUND, '导出任务不存在或已过期');
    }

    return this.toTaskView(task);
  }

  /** 保存任务状态（Processor 更新进度；本服务是任务状态的唯一读写入口） */
  async saveTask(task: OrderExportTaskState): Promise<void> {
    await this.redis.setJson(this.redis.key(TASK_KEY_PREFIX, task.taskId), task, ORDER_EXPORT_TASK_TTL_SECONDS);
  }

  /** 读取任务状态（不存在返回 null） */
  async loadTask(taskId: string): Promise<OrderExportTaskState | null> {
    return this.redis.getJson<OrderExportTaskState>(this.redis.key(TASK_KEY_PREFIX, taskId));
  }

  /** 释放「单任务」占用（任务终结后调用，让管理员可以再次导出） */
  async releaseActiveSlot(adminUserId: string): Promise<void> {
    await this.redis.del(this.redis.key(ACTIVE_KEY_PREFIX, adminUserId));
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /**
   * 解析操作者展示名
   *
   * 审计表的 `admin_username` 是**必填**且要求「账号被删后仍能追责」，因此这里
   * 从库里取稳定的展示名（昵称 → 真名 → 用户名），而不是从 JWT 里取 ——
   * 令牌里的角色/权限是签发时的快照，展示名同样可能已过期。
   */
  private async resolveAdminDisplayName(adminUserId: string): Promise<string> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
      select: { username: true, nickname: true, realName: true },
    });

    if (admin === null) {
      throw BusinessException.notFound(ErrorCode.ADMIN_NOT_FOUND, '管理员不存在');
    }

    return admin.nickname ?? admin.realName ?? admin.username;
  }

  /**
   * 参数校验与归一
   *
   * 契约规则 1：🚫 不允许无时间范围的导出（防一次性拖走全量订单数据）。
   * 契约 §3.14.6.4 的 `10002`（缺必填）与 `10016`（范围 > 366 天）在本项目
   * 均映射为 `10001 PARAM_INVALID`（见 DTO 文件头的错误码映射表）。
   */
  private resolveFilters(query: ExportAdminOrdersQueryDto): OrderFilterInput {
    if (query.createdStartTime === undefined || query.createdEndTime === undefined) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        '导出必须指定 createdStartTime 与 createdEndTime（禁止无时间范围的全量导出）',
      );
    }

    const start = new Date(query.createdStartTime);
    const end = new Date(query.createdEndTime);

    if (start.getTime() > end.getTime()) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'createdStartTime 不能晚于 createdEndTime');
    }

    const rangeDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    if (rangeDays > ORDER_EXPORT_MAX_RANGE_DAYS) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `导出时间范围不能超过 ${ORDER_EXPORT_MAX_RANGE_DAYS} 天`,
      );
    }

    if (query.paidStartTime !== undefined && query.paidEndTime !== undefined) {
      if (new Date(query.paidStartTime).getTime() > new Date(query.paidEndTime).getTime()) {
        throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'paidStartTime 不能晚于 paidEndTime');
      }
    }

    return {
      createdStartTime: query.createdStartTime,
      createdEndTime: query.createdEndTime,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.productType !== undefined ? { productType: query.productType } : {}),
      ...(query.hasRefund !== undefined ? { hasRefund: query.hasRefund } : {}),
      ...(query.paidStartTime !== undefined ? { paidStartTime: query.paidStartTime } : {}),
      ...(query.paidEndTime !== undefined ? { paidEndTime: query.paidEndTime } : {}),
    };
  }

  /**
   * 写导出审计（契约规则 5：强审计）
   *
   * `AdminAuditService.log()` 只返回成功与否，不返回主键，因此这里用
   * `resourceType + resourceId(=taskId)` 反查一次拿 `auditLogId`。
   * `resourceId` 是任务创建时生成的 UUID，反查结果唯一，不存在竞态。
   */
  private async writeAuditLog(task: OrderExportTaskState, estimatedRows: number): Promise<string | null> {
    await this.audit.log({
      adminUserId: task.adminUserId,
      adminUsername: task.adminDisplayName,
      action: AdminAuditAction.EXPORT,
      resourceType: 'order_export',
      resourceId: task.taskId,
      afterData: {
        format: task.format,
        fields: task.fields,
        maskSensitive: task.maskSensitive,
        createdStartTime: task.query.createdStartTime,
        createdEndTime: task.query.createdEndTime,
        status: task.query.status,
        productType: task.query.productType,
        hasRefund: task.query.hasRefund,
        estimatedRows,
      },
      diffSummary: `申请导出订单（${task.format}，预计 ${estimatedRows} 行，字段 ${task.fields.length} 个）`,
    });

    return this.findAuditLogId(task.taskId);
  }

  private async findAuditLogId(taskId: string): Promise<string | null> {
    const row = await this.prisma.adminAuditLog.findFirst({
      where: { resourceType: 'order_export', resourceId: taskId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row?.id ?? null;
  }

  private toRequestedView(task: OrderExportTaskState, auditLogId: string | null): OrderExportRequestedView {
    return {
      taskId: task.taskId,
      status: task.status,
      queue: QUEUE_EXPORT_DATA,
      format: task.format,
      estimatedRows: task.estimatedRows,
      estimatedSeconds: estimateSeconds(task.estimatedRows),
      query: task.query,
      fields: task.fields,
      maskSensitive: task.maskSensitive,
      maskingNote: task.maskSensitive ? MASKING_NOTE : '本次导出未掩码（仅限内部合规审计场景，操作已留痕）。',
      requestedAt: task.requestedAt,
      expiresAt: task.expiresAt,
      pollUrl: `/api/v1/admin/orders/export?taskId=${task.taskId}`,
      auditLogId,
    };
  }

  private toTaskView(task: OrderExportTaskState): OrderExportTaskView {
    const isExpired = Date.parse(task.expiresAt) <= Date.now();

    return {
      taskId: task.taskId,
      // 源文件已过期时即便曾成功也对外呈现 EXPIRED，避免前端给出 410 的下载链接
      status: isExpired && task.status === 'SUCCEEDED' ? 'EXPIRED' : task.status,
      progress: task.progress,
      rowCount: task.rowCount,
      isTruncated: task.isTruncated,
      fileName: task.fileName,
      fileSizeBytes: task.fileSizeBytes,
      downloadUrl: isExpired ? null : task.downloadUrl,
      expiresAt: task.expiresAt,
      isExpired,
      summary: task.summary,
      requestedAt: task.requestedAt,
      finishedAt: task.finishedAt,
      requestedBy: { adminId: task.adminUserId, displayName: task.adminDisplayName },
      errorMessage: task.errorMessage,
    };
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
