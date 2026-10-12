/**
 * AI 情感助手模块（契约 §3.7，Phase 5）
 *
 * ## 为什么单独成模块而不是把 8 个接口塞进 `AiModule`
 *
 * `AiModule` 现有的职责是**报告流水线**（provider / prompt / context / report 四层），
 * 对话是另一条完整的业务链路（会话、消息、配额、SSE、安全干预）。
 * 两者的共享部分（Provider 工厂、Prompt 服务）通过 `imports: [AiModule]` 拿到
 * **同一个实例**，因此不会出现"两套 Prompt 缓存"。
 *
 * ## 依赖方向
 *
 * ```
 * ChatModule → AiModule        （Provider 工厂 + Prompt 服务）
 *            → MembershipModule（EntitlementService：会员判定的唯一依据，ADR-015）
 *            → SystemModule    （SystemConfigService：免责声明、限额、危机资源）
 *            → WechatModule    （WechatService.msgSecCheck：内容安全必接）
 * ```
 *
 * 依赖是单向的，`ChatModule` 不被任何模块反向依赖 —— 这一点很重要：
 * 一旦 `AiModule` 反过来依赖 `ChatModule`，Provider 工厂就会出现两份实例，
 * 而 Provider 层承载着重试/退避/降级策略，两份实例意味着两套退避状态。
 */

import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AiModule } from '../ai.module';
import { MembershipModule } from '../../membership/membership.module';
import { SystemModule } from '../../system/system.module';
import { WechatModule } from '../../../infra/wechat/wechat.module';
import { ChatContextService } from './chat-context.service';
import { ChatConversationService } from './chat-conversation.service';
import { ChatController } from './chat.controller';
import { ChatMessageService } from './chat-message.service';
import { ChatQuotaService } from './chat-quota.service';
import { ChatSafetyService } from './chat-safety.service';

@Module({
  imports: [
    ConfigModule,
    // Provider 工厂 + Prompt 服务（**复用**而不是各建一份）
    //
    // ⚠ 必须 `forwardRef`：`AiModule` 也 `imports` 本模块（用户的 5 个报告扩展接口
    // 需要把对话域带进模块图，而 `app.module.ts` 是冻结的共享文件）。
    // 两侧如果不是 forwardRef，模块装饰器求值时对方还是 `undefined`，
    // 启动会直接抛 "Nest cannot create the XModule instance. The module at index [0]
    // of the imports array is undefined. Potential causes: A circular dependency
    // between modules. Use forwardRef..."（已用最小复现实测）。
    // 两侧都 forwardRef 后拿到的是**同一个** AiModule 实例，Provider 工厂不会出现两份。
    forwardRef(() => AiModule),
    // 会员与配额判定（`AI_CREDITS` 权益、会员每日额度）
    MembershipModule,
    // 系统配置（免责声明、AI 限额、危机干预资源）
    SystemModule,
    // 内容安全（`msgSecCheck`，架构 §10.5「发布前必接」）
    WechatModule,
  ],
  controllers: [ChatController],
  providers: [ChatContextService, ChatConversationService, ChatMessageService, ChatQuotaService, ChatSafetyService],
  exports: [ChatContextService, ChatQuotaService],
})
export class ChatModule {}
