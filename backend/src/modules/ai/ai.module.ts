import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { LlmProviderFactory } from './provider/llm-provider.factory';
import { PromptService } from './prompt/prompt.service';
import { QueueModule } from '../../infra/queue/queue.module';
import { ReportController } from './report/report.controller';
import { ReportGenerationService } from './report/report-generation.service';
import { MembershipModule } from '../membership/membership.module';
import { ReportService } from './report/report.service';

/**
 * AI 模块
 *
 * 分层（架构 §6.1）：
 *   · `provider/` —— 多 Provider 抽象（3a）：协议、错误映射、计量、成本
 *   · `prompt/`   —— Prompt 模板系统（3b）：DB 版本化、加权分流、纯函数渲染
 *   · `context/`  —— 上下文组装（3c，确定性不调 AI）
 *   · `report/`   —— 报告流水线（3d）：分段解析、生成编排、按段裁剪、服务
 *
 * 对外出口原则：其他模块**不得**直接依赖某个 Provider 实现，
 * 只能通过 `LlmProviderFactory` 取接口 —— 这样换厂商不会波及业务代码。
 *
 * `imports: [MembershipModule]`：报告的付费裁剪需要读取权益
 * （`ReportController` 的解锁状态、列表里的 `isUnlocked`）。
 * 依赖方向是单向的 `ai` → `membership`，`membership` 不反向依赖任何业务模块。
 */
@Module({
  imports: [ConfigModule, QueueModule, MembershipModule],
  controllers: [ReportController],
  providers: [LlmProviderFactory, PromptService, ReportGenerationService, ReportService],
  exports: [LlmProviderFactory, PromptService, ReportGenerationService, ReportService],
})
export class AiModule {}
