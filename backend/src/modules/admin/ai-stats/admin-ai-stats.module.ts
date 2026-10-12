/**
 * AdminAiStatsModule — 管理端 AI 统计域
 *
 * 契约：`docs/API_DESIGN.md` §3.14.7（5 个接口）
 *   · `GET /admin/ai/stats/overview`（`ai:stats:read`）
 *   · `GET /admin/ai/stats/usage`（`ai:stats:read`）
 *   · `GET /admin/ai/stats/costs`（`ai:stats:read`）
 *   · `GET /admin/ai/call-logs`（`ai:calllog:read`）
 *   · `GET /admin/ai/reports`（`report:report:read`）
 *
 * 依赖说明：
 *   · `AdminModule` —— 守卫（`AdminAuthGuard` / `RolesGuard` / `ConfirmPasswordGuard`）、
 *     `AdminAuditService`（正文访问高等级审计）、`PasswordService`（条件式二次确认校验）
 *   · `QueueModule` —— 总览的 `queueStatus` 段需要 BullMQ 队列句柄
 *
 * 本模块**没有**队列处理器：5 个接口全是只读聚合，不产生异步任务。
 */

import { Module } from '@nestjs/common';

import { QueueModule } from '../../../infra/queue/queue.module';
import { AdminModule } from '../admin.module';
import { AdminAiCallLogService } from './admin-ai-call-log.service';
import { AdminAiCostsService } from './admin-ai-costs.service';
import { AdminAiReportService } from './admin-ai-report.service';
import { AdminAiStatsService } from './admin-ai-stats.service';
import { AdminAiCallLogController, AdminAiReportController, AdminAiStatsController } from './admin-ai-stats.controller';

@Module({
  imports: [AdminModule, QueueModule],
  controllers: [AdminAiStatsController, AdminAiCallLogController, AdminAiReportController],
  providers: [AdminAiStatsService, AdminAiCostsService, AdminAiCallLogService, AdminAiReportService],
  exports: [AdminAiStatsService],
})
export class AdminAiStatsModule {}
