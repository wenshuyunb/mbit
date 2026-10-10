import { Module } from '@nestjs/common';

import { QueueModule } from '../../../infra/queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { UserModule } from '../user.module';
import { DataExportProcessor } from './data-export.processor';

/**
 * 用户模块的**队列处理器**（仅在 Worker 进程中加载）
 *
 * 为什么不放在 `UserModule` 里：处理器一旦被 HTTP 进程加载，就会在同进程内
 * 开始消费队列 —— 于是「Worker 扩容」变成「HTTP 扩容顺带消费队列」，
 * 任务并发、内存占用与部署形态全部失控。因此把处理器隔离到独立模块，
 * 只由 `WorkerModule` 引入（见 `backend/src/worker.module.ts`）。
 *
 * 后续处理器按同一模式加入：`ai.report`（Phase 3）、`compatibility.calc`（Phase 4）、
 * `maintenance.cleanup`（孤儿对象与旧头像清理）。
 */
@Module({
  imports: [UserModule, StorageModule, QueueModule],
  providers: [DataExportProcessor],
})
export class UserJobsModule {}
