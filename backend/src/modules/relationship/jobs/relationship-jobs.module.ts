import { Module } from '@nestjs/common';

import { QueueModule } from '../../../infra/queue/queue.module';
import { CompatibilityProcessor } from '../compatibility.processor';
import { RelationshipModule } from '../relationship.module';

/**
 * 关系模块的**队列处理器**（仅在 Worker 进程中加载）
 *
 * 与 `UserJobsModule` / `AiJobsModule` 同一模式：处理器隔离到独立模块，
 * 只由 `WorkerModule` 引入 —— 否则 HTTP 进程会在同进程内开始消费队列，
 * 「Worker 扩容」变成「HTTP 扩容顺带消费队列」，任务并发与部署形态全部失控。
 */
@Module({
  imports: [RelationshipModule, QueueModule],
  providers: [CompatibilityProcessor],
})
export class RelationshipJobsModule {}
