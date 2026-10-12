/**
 * AdminOrderModule — 管理端订单域
 *
 * 契约：`docs/API_DESIGN.md` §3.14.6（列表 / 详情 / 导出，共 3 个接口）
 *
 * 依赖 `AdminModule` 的原因：守卫（`AdminAuthGuard` / `RolesGuard` /
 * `ConfirmPasswordGuard`）与 `AdminAuditService` 由它导出；不 import 的话
 * `@UseGuards(...)` 在模块上下文里解析不到守卫类，Nest 会在启动时报错
 * （而不是运行时 401 —— 那样反而不易发现）。
 *
 * ⚠ 本模块只装配 **HTTP 侧**（Controller + 查询/导出服务）。导出**处理器**
 * 属 Worker 进程，由 `AdminOrderJobsModule` 装配（见同目录
 * `admin-order-jobs.module.ts`），避免 HTTP 进程顺带消费队列。
 */

import { Module } from '@nestjs/common';

import { QueueModule } from '../../../infra/queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { AdminModule } from '../admin.module';
import { AdminOrderExportService } from './admin-order-export.service';
import { AdminOrderController } from './admin-order.controller';
import { AdminOrderService } from './admin-order.service';

@Module({
  imports: [AdminModule, StorageModule, QueueModule],
  controllers: [AdminOrderController],
  providers: [AdminOrderService, AdminOrderExportService],
  exports: [AdminOrderService, AdminOrderExportService],
})
export class AdminOrderModule {}
