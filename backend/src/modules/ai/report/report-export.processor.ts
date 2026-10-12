/**
 * 报告 PDF 导出处理器（契约 §3.5.8：`export.pdf` 队列，并发 2，重试 2 次）
 *
 * 与 `ReportProcessor` 同一模式：处理器极薄，业务全在 `ReportExportService.runExportTask`。
 * 这样同一段逻辑既能在队列里跑，也能在测试里直接调用，不必绕过 BullMQ。
 *
 * 🚫 只在 Worker 进程加载（见 `ai-jobs.module.ts`）：若被 HTTP 进程加载，
 *    「Worker 扩容」会变成「HTTP 扩容顺带渲染 PDF」，CPU 占用直接失控。
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { ReportExportService } from './report-export.service';
import {
  REPORT_EXPORT_CONCURRENCY,
  REPORT_EXPORT_JOB_ATTEMPTS,
  REPORT_EXPORT_JOB_NAME,
  REPORT_EXPORT_QUEUE_NAME,
} from './report-export.util';

/** 队列任务载荷 */
export interface ReportExportJobData {
  readonly taskId: string;
}

@Processor(REPORT_EXPORT_QUEUE_NAME, { concurrency: REPORT_EXPORT_CONCURRENCY })
export class ReportExportProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportExportProcessor.name);

  constructor(private readonly exports: ReportExportService) {
    super();
  }

  async process(job: Job<ReportExportJobData>): Promise<void> {
    /**
     * job name 过滤（与 `DataExportProcessor` 同一课）：
     * BullMQ 按**队列**消费、不按 job name 过滤。同一队列上将来若有别的任务
     * （例如"批量导出"），不过滤就会被这里执行 —— 而任务状态键不同，
     * 结果是 `loadTask` 读到 null、只记一条 warn 就正常返回，BullMQ 把该 job
     * 标记为 **completed**，真正该做的工作永远不会执行且没有任何失败信号。
     */
    if (job.name !== REPORT_EXPORT_JOB_NAME) {
      return;
    }

    const { taskId } = job.data;
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? REPORT_EXPORT_JOB_ATTEMPTS);

    // 不在此处 try/catch：`runExportTask` 已经按"是否值得重试"决定了自己抛不抛错，
    // 在这里再包一层只会掩盖真实的错误类型
    await this.exports.runExportTask(taskId, { isFinalAttempt });

    this.logger.log(`PDF 导出任务处理结束 taskId=${taskId} attempt=${job.attemptsMade + 1}`);
  }
}
