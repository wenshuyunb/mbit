import { Module } from '@nestjs/common';

import { QueueModule } from '../../../infra/queue/queue.module';
import { AiModule } from '../ai.module';
import { ReportProcessor } from '../report/report.processor';

/**
 * AI 模块的**队列处理器**（仅在 Worker 进程中加载）
 *
 * 与 `UserJobsModule` 同一模式：处理器隔离到独立模块，
 * 只由 `WorkerModule` 引入，HTTP 进程的模块图里没有它。
 */
@Module({
  imports: [AiModule, QueueModule],
  providers: [ReportProcessor],
})
export class AiJobsModule {}
