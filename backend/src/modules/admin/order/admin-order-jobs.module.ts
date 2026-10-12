/**
 * AdminOrderJobsModule — 订单导出的**队列处理器**（仅在 Worker 进程加载）
 *
 * 为什么不放进 `AdminOrderModule`：处理器一旦被 HTTP 进程加载，就会在同进程内
 * 开始消费队列 —— 「Worker 扩容」于是变成「HTTP 扩容顺带消费队列」，
 * 任务并发、内存占用与部署形态全部失控。用户端数据导出（`UserJobsModule`）
 * 采用同一模式。
 *
 * ⚠ 接入方式（**需其它文件的 owner 完成**，本轮不可改共享文件）：
 * 在 `backend/src/worker.module.ts` 的 `imports` 中加入 `AdminOrderJobsModule`。
 * 未接入时导出任务会停留在 `PENDING`（HTTP 侧一切正常，任务不会被执行）。
 */

import { Module } from '@nestjs/common';

import { QueueModule } from '../../../infra/queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { AdminOrderExportProcessor } from './admin-order-export.processor';
import { AdminOrderModule } from './admin-order.module';

@Module({
  imports: [AdminOrderModule, StorageModule, QueueModule],
  providers: [AdminOrderExportProcessor],
})
export class AdminOrderJobsModule {}
