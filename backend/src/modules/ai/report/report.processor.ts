/**
 * AI 报告生成处理器（契约 §3.5.1 规则 1：`ai.report` 队列）
 *
 * 极薄的一层：把队列任务映射到 `ReportGenerationService.runGeneration`。
 * 业务逻辑全在服务里 —— 处理器只负责「从队列取出 reportId 并调用」，
 * 这样同一段逻辑既能被队列触发，也能在测试里直接调用，不必绕过 BullMQ。
 *
 * 🚫 本处理器只在 Worker 进程加载（见 `worker.module.ts`）：
 *    若被 HTTP 进程加载，同进程就会开始消费队列，「Worker 扩容」会变成
 *    「HTTP 扩容顺带消费队列」，并发与内存占用全部失控。
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_AI_REPORT } from '../../../infra/queue/queue.module';
import { ReportGenerationService } from './report-generation.service';

/** 队列任务载荷 */
export interface ReportJobData {
  reportId: string;
}

/**
 * 并发数
 *
 * 报告生成是**长耗时外部调用**（10–60s），并发过高会同时占用大量
 * 连接与内存，也容易触发厂商侧限流。取 3：既能并行处理几个用户，
 * 又不至于在厂商限流时雪崩。
 */
const REPORT_CONCURRENCY = 3;

@Processor(QUEUE_AI_REPORT, { concurrency: REPORT_CONCURRENCY })
export class ReportProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportProcessor.name);

  constructor(private readonly generation: ReportGenerationService) {
    super();
  }

  async process(job: Job<ReportJobData>): Promise<void> {
    const { reportId } = job.data;

    // 不在此处 try/catch：让错误原样抛出，由 BullMQ 记录失败并按策略重试。
    // `runGeneration` 内部已经把报告标记为 FAILED 并写入了用量日志，
    // 在这里再包一层只会掩盖真实的错误类型。
    await this.generation.runGeneration(reportId);

    this.logger.log(`报告任务处理完成 reportId=${reportId} attempt=${job.attemptsMade + 1}`);
  }
}
