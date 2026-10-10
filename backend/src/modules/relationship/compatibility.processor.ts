/**
 * 匹配算分处理器（`compatibility.calc` 队列；架构 §6.4）
 *
 * 与 `ReportProcessor` 同一模式：HTTP 进程只入队，Worker 进程消费
 * （架构 §17.1：HTTP 与 Worker 同镜像、不同启动命令）。
 *
 * 并发设为 2：算分是纯数学（毫秒级），真正的瓶颈是随后的 AI 解读。
 * 并发过高没有收益，反而会因为同时占用多个 DB 连接影响其他任务。
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_COMPATIBILITY_CALC } from '../../infra/queue/queue.module';
import { CompatibilityService } from './compatibility.service';

/** 算分任务的载荷 */
interface CompatibilityJobData {
  readonly reportId: string;
}

const CONCURRENCY = 2;

@Processor(QUEUE_COMPATIBILITY_CALC, { concurrency: CONCURRENCY })
export class CompatibilityProcessor extends WorkerHost {
  private readonly logger = new Logger(CompatibilityProcessor.name);

  constructor(private readonly compatibility: CompatibilityService) {
    super();
  }

  async process(job: Job<CompatibilityJobData>): Promise<void> {
    const { reportId } = job.data;

    if (typeof reportId !== 'string' || reportId.length === 0) {
      // 载荷非法属代码缺陷，重试没有意义 —— 直接失败让告警发现它
      this.logger.error(`匹配任务载荷非法 jobId=${job.id}`);
      throw new Error('匹配任务缺少 reportId');
    }

    this.logger.log(`开始算分 reportId=${reportId} attempt=${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`);

    // 失败由 `computeAndPersist` 落库为 FAILED 后重新抛出，让 BullMQ 记录重试
    await this.compatibility.computeAndPersist(reportId);
  }
}
