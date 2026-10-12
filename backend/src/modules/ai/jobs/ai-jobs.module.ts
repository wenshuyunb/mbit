/**
 * AI 模块的**队列处理器**（仅在 Worker 进程中加载）
 *
 * 与 `UserJobsModule` 同一模式：处理器隔离到独立模块，
 * 只由 `WorkerModule` 引入，HTTP 进程的模块图里没有它。
 *
 * 现有处理器：
 *   · `ai.report`   报告生成（`ReportProcessor`）
 *   · `export.pdf`  报告 PDF 导出（`ReportExportProcessor`，契约 §3.5.8）
 *
 * ⚠ 两个处理器的入队方都在 `AiModule` 内（`ReportService` / `ReportExportService`），
 * 因此这里只需 `imports: [AiModule]` —— 队列名称与并发都在各自文件里定义，
 * 处理器与入队方共用同一份常量，避免"改了队列名一半"的静默失配。
 */

import { Module } from '@nestjs/common';

import { QueueModule } from '../../../infra/queue/queue.module';
import { AiModule } from '../ai.module';
import { ReportExportProcessor } from '../report/report-export.processor';
import { ReportProcessor } from '../report/report.processor';

@Module({
  imports: [AiModule, QueueModule],
  providers: [ReportProcessor, ReportExportProcessor],
})
export class AiJobsModule {}
