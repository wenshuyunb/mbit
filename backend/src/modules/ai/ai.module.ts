import { BullModule } from '@nestjs/bullmq';
import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { LlmProviderFactory } from './provider/llm-provider.factory';
import { PromptService } from './prompt/prompt.service';
import { QueueModule } from '../../infra/queue/queue.module';
import { REPORT_EXPORT_QUEUE_NAME } from './report/report-export.util';
import { ReportController } from './report/report.controller';
import { ReportEngagementController } from './report/report-engagement.controller';
import { ReportExportService } from './report/report-export.service';
import { ReportGenerationOptionsService } from './report/report-generation-options.service';
import { ReportGenerationService } from './report/report-generation.service';
import { ReportLiveProgressService } from './report/report-live-progress.service';
import { ReportQuotaService } from './report/report-quota.service';
import { ReportRegenerateService } from './report/report-regenerate.service';
import { ReportSectionsService } from './report/report-sections.service';
import { ReportService } from './report/report.service';
import { ReportShareCardService } from './report/report-share-card.service';
import { ReportStreamService } from './report/report-stream.service';
import { MembershipModule } from '../membership/membership.module';
import { StorageModule } from '../storage/storage.module';
import { SystemModule } from '../system/system.module';
import { ChatModule } from './chat/chat.module';

/**
 * AI 模块
 *
 * 分层（架构 §6.1）：
 *   · `provider/` —— 多 Provider 抽象（3a）：协议、错误映射、计量、成本
 *   · `prompt/`   —— Prompt 模板系统（3b）：DB 版本化、加权分流、纯函数渲染
 *   · `context/`  —— 上下文组装（3c，确定性不调 AI）
 *   · `report/`   —— 报告流水线（3d）：分段解析、生成编排、按段裁剪、服务
 *   · `chat/`     —— AI 情感助手（Phase 5，契约 §3.7）：会话、消息、配额、SSE、安全干预
 *
 * 对外出口原则：其他模块**不得**直接依赖某个 Provider 实现，
 * 只能通过 `LlmProviderFactory` 取接口 —— 这样换厂商不会波及业务代码。
 *
 * `imports: [MembershipModule]`：报告的付费裁剪需要读取权益
 * （`ReportController` 的解锁状态、列表里的 `isUnlocked`）。
 * 依赖方向是单向的 `ai` → `membership`，`membership` 不反向依赖任何业务模块。
 *
 * `imports: [ChatModule]`：对话域单独成模块（它是一条完整的业务链路），
 * 但**必须由本模块导入**才能被 `app.module.ts` 的 `imports: [AiModule]` 带到 ——
 * 这样 `app.module.ts`（共享文件）无需改动。`ChatModule` 反向 `imports` 本模块，
 * 拿到的是**同一个** `LlmProviderFactory` / `PromptService` 实例，
 * 因此不会出现"两套 Provider 退避状态"或"两套 Prompt 缓存"。
 *
 * ⚠ `ChatModule` 与"报告扩展接口"这两处新增都是**双向依赖**，两侧都必须
 *    `forwardRef`（否则模块装饰器求值时对方还是 `undefined`，启动直接失败，
 *   实测报错："The module at index [N] of the imports array is undefined.
 *   Potential causes: A circular dependency between modules. Use forwardRef…"）。
 *
 * `imports: [StorageModule]`：报告 PDF 与分享卡要写对象存储并构造访问地址。
 * 依赖 `StorageService` 而不是直接用 `OssService`：全项目只有 storage 模块直接使用
 * OSS 写入能力，散开会导致"有的地方设 ACL、有的地方不设"。
 *
 * `imports: [SystemModule]`：分享文案、免责声明、重生成每日上限都来自 `system_configs`，
 * 复用带缓存的 `SystemConfigService`（后台改配置后会被失效），不自己查库也不会硬编码。
 *
 * `BullModule.registerQueue({ name: 'export.pdf' })`：契约 §3.5.8 指定的导出队列，
 * 并发 2、重试 2 次（见 `report-export.util.ts`）。没有改全局的
 * `infra/queue/queue.module.ts`（多任务共用的共享文件），而是在本模块局部注册 ——
 * BullMQ 按队列名消费，注册位置不影响行为。
 */
@Module({
  imports: [
    ConfigModule,
    QueueModule,
    MembershipModule,
    StorageModule,
    SystemModule,
    BullModule.registerQueue({ name: REPORT_EXPORT_QUEUE_NAME }),
    // 双向依赖：两侧都要 forwardRef（见文件头说明）
    forwardRef(() => ChatModule),
  ],
  controllers: [ReportController, ReportEngagementController],
  providers: [
    LlmProviderFactory,
    PromptService,
    ReportGenerationService,
    ReportService,
    // ------ 本轮新增：契约 §3.5.4 / §3.5.6 / §3.5.7 / §3.5.8 / §3.5.9 ------
    ReportSectionsService,
    ReportStreamService,
    ReportLiveProgressService,
    ReportGenerationOptionsService,
    ReportRegenerateService,
    ReportExportService,
    ReportShareCardService,
    ReportQuotaService,
  ],
  exports: [
    LlmProviderFactory,
    PromptService,
    ReportGenerationService,
    ReportService,
    // 队列处理器（`AiJobsModule`）复用同一份导出任务实现
    ReportExportService,
  ],
})
export class AiModule {}
