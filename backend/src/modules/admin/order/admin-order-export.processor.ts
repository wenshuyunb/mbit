/**
 * 订单导出处理器（契约 §3.14.6.4 规则 3：`export.data` 队列，并发 2，重试 2 次）
 *
 * 🚫 本处理器**不接收 HTTP 请求**，只消费队列；HTTP 进程不会加载它。
 *
 * ## job name 过滤是**必需**的
 *
 * `export.data` 队列上同时挂着用户端数据导出处理器（`generate` 任务），
 * BullMQ 按队列分发、不按 job name 过滤。若本处理器不过滤 job name，
 * 它会尝试把用户侧任务当成订单导出任务处理（读到 null 状态后静默 return），
 * 反之亦然 —— 两个处理器必须各自只认自己的 job name。
 *
 * ✅ 两侧过滤现已对称：用户端 `user/jobs/data-export.processor.ts` 也已补上
 * `if (job.name !== EXPORT_DATA_JOB_NAME) return;`（job name = `'generate'`）。
 * 任一侧缺失都会让另一侧的 job 被「读成 null → 正常 return → 标记 completed」吞掉。
 *
 * ## 幂等与失败语义
 *
 * · 已成功的任务重复投递直接跳过（生成两次会给管理员两个不同链接，旧文件无人清理）
 * · 可重试错误抛出交给 BullMQ；**仅在最后一次尝试失败时**释放「单任务」占用，
 *   提前释放会让管理员在任务仍会重试时又建一个新任务
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_EXPORT_DATA } from '../../../infra/queue/queue.module';
import { StorageService } from '../../storage/storage.service';
import {
  AdminOrderExportService,
  ORDER_EXPORT_JOB_NAME,
  ORDER_EXPORT_SIGNED_URL_TTL_SECONDS,
  type OrderExportTaskState,
} from './admin-order-export.service';
import {
  EXPORT_FORMAT_META,
  buildOrderExportMatrix,
  renderOrderExportCsv,
  renderOrderExportXlsx,
} from './admin-order-export.builder';
import { AdminOrderService } from './admin-order.service';

/** 队列并发（契约 §3.14.6.4 规则 3：并发 2） */
export const ORDER_EXPORT_CONCURRENCY = 2;

/** 导出文件的下载文件名前缀（契约示例：`soulmap-orders-20260201-20260214.xlsx`） */
const EXPORT_FILE_PREFIX = 'soulmap-orders';

/** 队列任务载荷 */
export interface OrderExportJobData {
  taskId: string;
  adminUserId: string;
}

@Processor(QUEUE_EXPORT_DATA, { concurrency: ORDER_EXPORT_CONCURRENCY })
export class AdminOrderExportProcessor extends WorkerHost {
  private readonly logger = new Logger(AdminOrderExportProcessor.name);

  constructor(
    private readonly storage: StorageService,
    private readonly exportService: AdminOrderExportService,
    private readonly orders: AdminOrderService,
  ) {
    super();
  }

  async process(job: Job<OrderExportJobData>): Promise<void> {
    // 只认自己的任务：同一队列上还有用户端数据导出处理器
    if (job.name !== ORDER_EXPORT_JOB_NAME) {
      return;
    }

    const { taskId, adminUserId } = job.data;
    const task = await this.exportService.loadTask(taskId);

    if (task === null) {
      // 任务状态已被 TTL 回收：不是错误，重试也不会变好
      this.logger.warn(`订单导出任务状态不存在，跳过 taskId=${taskId}`);
      return;
    }

    if (task.status === 'SUCCEEDED') {
      this.logger.log(`订单导出任务已完成，跳过重复生成 taskId=${taskId}`);
      return;
    }

    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    try {
      await this.advance(task, { status: 'PROCESSING', progress: 20 });

      const collection = await this.orders.collectForExport(task.filters);

      await this.advance(task, { progress: 60 });

      const matrix = buildOrderExportMatrix(collection.items, task.fields, task.maskSensitive);
      const now = new Date();
      const fileName = this.buildFileName(task, now);
      const body =
        task.format === 'XLSX' ? renderOrderExportXlsx(matrix, '订单明细', now) : renderOrderExportCsv(matrix);

      await this.advance(task, { progress: 80 });

      const objectKey = this.buildObjectKey(taskId, task.format);
      const meta = EXPORT_FORMAT_META[task.format];
      const uploaded = await this.storage.uploadServerObject({
        objectKey,
        body,
        contentType: meta.mime,
      });

      const signed = this.storage.signServerObjectUrl(
        objectKey,
        ORDER_EXPORT_SIGNED_URL_TTL_SECONDS,
        `attachment; filename="${fileName}"`,
      );

      const summary = {
        orderCount: collection.rowCount,
        totalAmount: collection.totalAmount,
        totalRefundedAmount: collection.totalRefundedAmount,
        netRevenue: collection.totalAmount - collection.totalRefundedAmount,
      };

      await this.advance(task, {
        status: 'SUCCEEDED',
        progress: 100,
        rowCount: collection.rowCount,
        isTruncated: collection.truncated,
        fileName,
        fileSizeBytes: uploaded.sizeBytes,
        downloadUrl: signed.url,
        summary,
        finishedAt: new Date().toISOString(),
      });

      // 成功后才释放「单任务」占用，让管理员可以再次导出
      await this.exportService.releaseActiveSlot(adminUserId);

      this.logger.log(
        `订单导出任务完成 taskId=${taskId} rows=${collection.rowCount} bytes=${uploaded.sizeBytes} truncated=${collection.truncated}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.advance(task, { status: 'FAILED', progress: 100, errorMessage: message.slice(0, 500) });

      // 只有最后一次尝试失败才释放占用：否则任务仍会重试，管理员却已能再建一个新任务
      if (isFinalAttempt) {
        await this.exportService.releaseActiveSlot(adminUserId);
      }

      this.logger.error(
        `订单导出任务失败 taskId=${taskId} attempt=${job.attemptsMade + 1} final=${isFinalAttempt}: ${message}`,
      );

      throw error;
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 更新任务状态（只改传入字段，避免手写整对象时漏字段） */
  private async advance(
    task: OrderExportTaskState,
    patch: Partial<OrderExportTaskState>,
  ): Promise<OrderExportTaskState> {
    const next = { ...task, ...patch };
    await this.exportService.saveTask(next);
    return next;
  }

  /**
   * 文件名：`soulmap-orders-{起始日}-{结束日}.{ext}`（契约示例形态）
   *
   * 日期取导出**筛选条件的日期范围**而非当前时间 —— 财务同事同时下载多份导出时，
   * 文件名是唯一的区分依据，用「下载时刻」会让多份文件难以区分。
   */
  private buildFileName(task: OrderExportTaskState, now: Date): string {
    const start = toDateStamp(task.query.createdStartTime, now);
    const end = toDateStamp(task.query.createdEndTime, now);
    return `${EXPORT_FILE_PREFIX}-${start}-${end}.${EXPORT_FORMAT_META[task.format].extension}`;
  }

  /**
   * 对象键：`exports/orders/{taskId}.{ext}`
   *
   * 与用户端导出（`exports/data/...`）分开前缀：两者的清理策略与访问角色不同，
   * 混在同一前缀下会让「按前缀做生命周期规则」变得不可能。
   */
  private buildObjectKey(taskId: string, format: OrderExportTaskState['format']): string {
    return `exports/orders/${taskId}.${EXPORT_FORMAT_META[format].extension}`;
  }
}

/** ISO 时间 → `yyyyMMdd`；解析失败时回落到当前日期（不因脏数据让整次导出失败） */
const toDateStamp = (iso: string, fallback: Date): string => {
  const parsed = new Date(iso);
  const date = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
};
