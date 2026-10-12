/**
 * AdminDashboardModule — 管理端北极星指标看板
 *
 * 契约：`docs/API_DESIGN.md` §3.14.9.9（1 个接口：`GET /admin/dashboard/metrics`）
 *
 * 依赖说明：
 *   · `AdminModule` —— 守卫（`AdminAuthGuard` / `RolesGuard` / `ConfirmPasswordGuard`）
 *   · `QueueModule` —— `realtime.queueBacklog` 需要 BullMQ 队列句柄
 *   · `RedisService` / `PrismaService` / `ConfigService` 所在模块均为全局，无需 import
 *
 * 本模块无队列处理器（看板是纯只读聚合 + 60 秒缓存）。
 */

import { Module } from '@nestjs/common';

import { QueueModule } from '../../../infra/queue/queue.module';
import { AdminModule } from '../admin.module';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';

@Module({
  imports: [AdminModule, QueueModule],
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService],
  exports: [AdminDashboardService],
})
export class AdminDashboardModule {}
