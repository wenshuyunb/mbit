/**
 * 会话服务（契约 §3.7.1 创建 / §3.7.3 详情 / §3.7.8 配额查询）
 *
 * ## 为什么"创建会话不扣配额"
 *
 * 契约 §3.7.1 业务规则 1 明确：**配额在消息成功生成后扣减**，创建会话本身不消耗额度。
 * 因此本文件只做**额度预检**（`70014`：免费用户额度用尽时仍允许创建空会话，
 * 只是在发消息时会被拦）。这条设计是对的 —— 若创建就扣，用户"想先看看有什么功能"
 * 也会被扣掉一次，而配额一旦扣掉无法自然返还。
 *
 * ## 归属校验：创建时 `50023` / `60020`，读取时 `50003` / `50004`
 *
 * 契约对 `relationshipId` 给了两个不同错误码：不属于当前用户（`50023` 越权）与
 * 非 `ACTIVE`（`60020` 状态冲突）。这两种情况的修复动作不同 —— 前者是安全隐患
 * （要能被监控发现），后者是正常业务状态（提示用户先确认关系）。因此不能合并。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { AppConfig } from '../../../config/config.type';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { LlmProviderFactory } from '../provider/llm-provider.factory';
import { PromptService } from '../prompt/prompt.service';
import {
  ChatContextService,
  type ConversationDetailView,
  type ConversationRelationshipView,
} from './chat-context.service';
import { promptKeyOf, templateKeyCandidatesOf } from './chat-prompt';
import { ChatQuotaService, type QuotaAvailability } from './chat-quota.service';
import { MAX_CONVERSATIONS_PER_DAY, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS } from './chat-quota.util';
import { TOKEN_BUDGET } from './chat-context.util';
import {
  CONFIG_KEY_MAX_CONCURRENT_STREAMS,
  DEFAULT_INCLUDE_PERSONA,
  DEFAULT_MODE,
  DEFAULT_TONE,
  FALLBACK_DISCLAIMER,
  MAX_MESSAGES_PER_CONVERSATION,
  decodeScene,
  encodeScene,
  modeNameOf,
  type ConversationMode,
  type ConversationTone,
} from './chat.types';

/** 创建会话入参 */
export interface CreateConversationInput {
  readonly userId: string;
  readonly title?: string;
  readonly relationshipId?: string;
  readonly mode?: ConversationMode;
  readonly tone?: ConversationTone;
  readonly includePersona?: boolean;
  readonly idempotencyKey: string;
}

/** 创建结果（契约 §3.7.1 响应 `data`） */
export interface ConversationCreatedView {
  readonly conversationId: string;
  readonly title: string;
  readonly mode: ConversationMode;
  readonly modeName: string;
  readonly tone: ConversationTone;
  readonly status: string;
  readonly includePersona: boolean;
  readonly relationship: ConversationRelationshipView | null;
  readonly personaInjected: {
    readonly myProfile: {
      readonly mbtiType: string;
      readonly profileVersion: number | null;
      readonly estimatedTokens: number;
    } | null;
    readonly partnerProfile: {
      readonly mbtiType: string;
      readonly profileVersion: number | null;
      readonly estimatedTokens: number;
    } | null;
    readonly memorySummary: string | null;
    readonly recentMessageCount: number;
  };
  readonly promptKey: string;
  readonly promptVersion: number | null;
  readonly provider: string;
  readonly model: string;
  readonly systemNotice: string;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly lastMessageAt: string | null;
  readonly quota: Awaited<ReturnType<ChatQuotaService['summaryFor']>>;
  readonly disclaimer: string;
}

/** 配额查询结果（契约 §3.7.8 响应 `data`） */
export interface AiQuotaView {
  readonly plan: {
    readonly type: string;
    readonly planCode: string | null;
    readonly planName: string | null;
    readonly isActive: boolean;
    readonly expiresAt: string | null;
    readonly remainingDays: number | null;
    readonly benefits: {
      readonly aiDailyLimit: number;
      readonly unlimitedReports: boolean;
      readonly reportRegenerateDailyLimit: number;
      readonly pdfExportUnlimited: boolean;
      readonly compatibilityReportIncluded: boolean;
    };
  };
  readonly quota: QuotaAvailability['view'];
  readonly exhausted: boolean;
  readonly nextActions: {
    readonly canChat: boolean;
    readonly upgradeUrl: string;
    readonly creditsUrl: string;
    readonly reason: string | null;
  };
  readonly usage: {
    readonly today: {
      readonly date: string;
      readonly messageCount: number;
      readonly totalTokens: number;
      readonly estimatedCostCents: number;
    };
    readonly last7Days: readonly {
      readonly date: string;
      readonly messageCount: number;
      readonly totalTokens: number;
      readonly estimatedCostCents: number;
    }[];
    readonly totalMessageCount: number;
    readonly totalTokens: number;
    readonly averageTokensPerMessage: number;
  };
  readonly limits: {
    readonly rateLimit: { readonly windowSeconds: number; readonly maxRequests: number; readonly errorCode: number };
    readonly maxConcurrentStreams: number;
    readonly maxMessageLength: number;
    readonly maxMessagesPerConversation: number;
    readonly maxConversationsPerDay: number;
    /**
     * ⚠ 契约 §3.7.8 的 `limits.newUserDailyLimit`（"新用户 7 天内 30 次/天"，
     * 契约 §3.7.5 规则 5 / 架构 R10）。**服务端未实现该限制**（缺配置键与
     * 防刷计数表），此处按契约的"静态契约回显"语义回显常量值。
     */
    readonly newUserDailyLimit: number;
  };
  readonly serverTime: string;
}

/** 创建会话的幂等作用域 */
const IDEMPOTENCY_SCOPE_CONVERSATION = 'conversation';

/**
 * 日创建上限（契约 §3.7.1：userId 10 次/24h）
 *
 * `system_configs` 里**没有**这个键（已核查配置目录），因此固定用契约值。
 */
const MAX_CONVERSATIONS_PER_DAY_LIMIT = MAX_CONVERSATIONS_PER_DAY;

/** 新用户日上限（契约 §3.7.5 规则 5；见 `AiQuotaView.limits.newUserDailyLimit` 的说明） */
const NEW_USER_DAILY_LIMIT = 30;

/**
 * 付费墙跳转地址（契约 §3.7.8 `nextActions.upgradeUrl` / `creditsUrl`）
 *
 * **必须指向真实存在的路由**。原先是 `/api/v1/membership/plans` 与
 * `/api/v1/products?type=AI_CREDITS` —— 这两个路径在本项目**都没有路由**
 * （ADR-033 已把 `plans` 与 `products` 合并到 `GET /membership/products`）。
 * 客户端照着跳直接 404，而这条链路正是「额度耗尽 → 拉起付费墙 → 去升级」的转化路径，
 * 链接坏掉等于把付费用户挡在门外。
 *
 * 提成常量是为了让 `chat-paywall-links.spec.ts` 能把它与
 * `MembershipController` 的**路由声明**绑定起来断言 —— 路由改名时那里会立刻变红。
 */
export const PAYWALL_UPGRADE_URL = '/api/v1/membership/products';

/** 次数包入口：带 `?type=AI_CREDITS`，该筛选已在本端点上实现 */
export const PAYWALL_CREDITS_URL = '/api/v1/membership/products?type=AI_CREDITS';

/** Prompt 元信息 */
interface PromptMetaView {
  readonly contractKey: string;
  readonly version: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
}

@Injectable()
export class ChatConversationService {
  private readonly logger = new Logger(ChatConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly context: ChatContextService,
    private readonly quota: ChatQuotaService,
    private readonly prompts: PromptService,
    private readonly providers: LlmProviderFactory,
  ) {}

  // ==========================================================================
  // 创建（契约 §3.7.1）
  // ==========================================================================

  /**
   * 创建会话
   *
   * 顺序：功能开关 → 幂等占位 → 关系校验 → 日创建上限 → 解析 Prompt 元信息 →
   * 落库 → 组装响应。**不写任何 `ai_messages`**（契约规则 6："不创建空消息"）。
   */
  async createConversation(input: CreateConversationInput): Promise<ConversationCreatedView> {
    this.assertAiChatEnabled();

    const claimed = await this.quota.claimIdempotency(
      IDEMPOTENCY_SCOPE_CONVERSATION,
      input.userId,
      input.idempotencyKey,
    );

    if (!claimed) {
      const replayed = await this.quota.readIdempotentResult<ConversationCreatedView>(
        IDEMPOTENCY_SCOPE_CONVERSATION,
        input.userId,
        input.idempotencyKey,
      );

      if (replayed !== null) {
        this.logger.log(`创建会话幂等命中，重放首次响应 userId=${input.userId}`);
        return replayed;
      }

      throw BusinessException.conflict(ErrorCode.RESOURCE_CONFLICT, '相同请求正在处理中，请稍后重试');
    }

    try {
      const mode = input.mode ?? DEFAULT_MODE;
      const tone = input.tone ?? DEFAULT_TONE;
      const includePersona = input.includePersona ?? DEFAULT_INCLUDE_PERSONA;

      const relationship = await this.resolveRelationship(input.userId, input.relationshipId ?? null);
      await this.enforceDailyConversationLimit(input.userId);

      /**
       * Prompt 元信息：这里用 `getTemplateMeta`（**不渲染**）而不是 `getPrompt`，
       * 理由与 `report.service.ts` 完全一致 —— 此刻还没有任何 Prompt 变量
       * （没有历史消息、没有本轮输入），为取元信息而传空变量去渲染只会因缺变量失败：
       * 那是"用错了接口"，不是"数据有问题"。
       */
      const meta = await this.resolvePromptMeta(mode);
      const myProfile = await this.loadMyProfile(input.userId);

      const conversation = await this.prisma.aiConversation.create({
        data: {
          userId: input.userId,
          relationshipId: relationship?.relationshipId ?? null,
          title: input.title !== undefined && input.title.trim().length > 0 ? input.title.trim() : null,
          // mode/tone/includePersona 无列可落，编码进 `scene`（见 `chat.types.ts` 说明）
          scene: encodeScene(mode, tone, includePersona),
          status: 'ACTIVE',
        },
        select: { id: true, title: true, createdAt: true, messageCount: true, lastMessageAt: true },
      });

      const [persona, systemNotice, disclaimer, quotaSummary] = await Promise.all([
        this.context.buildPersonaSummary(input.userId, relationship?.relationshipId ?? null, includePersona),
        this.context.systemNotice(),
        this.quota.readStringConfig('disclaimer.aiContent', FALLBACK_DISCLAIMER),
        this.quota.summaryFor(input.userId),
      ]);

      this.logger.log(
        `会话已创建 conversationId=${conversation.id} userId=${input.userId} mode=${mode} relationshipId=${relationship?.relationshipId ?? 'none'}`,
      );

      const view: ConversationCreatedView = {
        conversationId: conversation.id,
        title: conversation.title ?? '',
        mode,
        modeName: modeNameOf(mode),
        tone,
        status: 'ACTIVE',
        includePersona,
        relationship,
        personaInjected: {
          myProfile:
            persona.myMbtiType === null
              ? null
              : {
                  mbtiType: persona.myMbtiType,
                  profileVersion: myProfile?.version ?? null,
                  estimatedTokens: persona.myEstimatedTokens,
                },
          partnerProfile:
            persona.partnerMbtiType === null
              ? null
              : {
                  mbtiType: persona.partnerMbtiType,
                  profileVersion: null,
                  estimatedTokens: persona.partnerEstimatedTokens,
                },
          memorySummary: null,
          recentMessageCount: 0,
        },
        promptKey: promptKeyOf(mode),
        promptVersion: meta.version,
        ...this.resolveDefaultProviderAndModel(meta),
        systemNotice,
        messageCount: conversation.messageCount,
        createdAt: conversation.createdAt.toISOString(),
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        quota: quotaSummary,
        disclaimer,
      };

      await this.quota.saveIdempotentResult(IDEMPOTENCY_SCOPE_CONVERSATION, input.userId, input.idempotencyKey, view);

      return view;
    } catch (error) {
      // 失败释放幂等占位，让用户可以用同一个 key 重试
      await this.quota.releaseIdempotency(IDEMPOTENCY_SCOPE_CONVERSATION, input.userId, input.idempotencyKey);
      throw error;
    }
  }

  // ==========================================================================
  // 详情（契约 §3.7.3）
  // ==========================================================================

  /**
   * 会话详情
   *
   * 三处契约要求：
   *   ① **不返回消息列表**（走 `/messages` 接口）；
   *   ② **不返回 Prompt 全文**（防 Prompt 泄露与逆向，架构 R9）—— 只给 key/version/参数；
   *   ③ 归档会话**仍返回 200**，只把 `permissions.canSendMessage` 置 false
   *      （契约错误码表里 `50005` 的触发条件写着"仍返回 200"，属该表里"有码但不抛"的特例）。
   */
  async getConversation(userId: string, conversationId: string): Promise<ConversationDetailView> {
    const conversation = await this.context.requireOwnedConversationForRead(userId, conversationId);
    const scene = decodeScene(conversation.scene);

    const [persona, relationship, systemNotice, disclaimer, quotaSummary, latestAssistant, promptMeta, recentTokens] =
      await Promise.all([
        this.context.buildPersonaSummary(userId, conversation.relationshipId, scene.includePersona),
        this.loadRelationshipView(userId, conversation.relationshipId),
        this.context.systemNotice(),
        this.quota.readStringConfig('disclaimer.aiContent', FALLBACK_DISCLAIMER),
        this.quota.summaryFor(userId),
        // `context.injectedAt` 的语义是"上一次装配上下文的时间"。schema 没有该列
        // （见简报），因此用最近一条 AI 消息的时间作为近似 —— 那正是"上次真正
        // 喂过上下文"的时刻，比返回 null 更能回答"AI 为什么不记得我说过的话"
        this.prisma.aiMessage.findFirst({
          where: { conversationId, role: 'ASSISTANT', deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { createdAt: true, model: true, promptTokens: true },
        }),
        this.resolvePromptMetaBestEffort(scene.mode),
        this.readRecentTokens(conversationId),
      ]);

    const isArchived = conversation.status === 'ARCHIVED';
    const canSend =
      !isArchived && quotaSummary.remainingToday > 0 && conversation.messageCount < MAX_MESSAGES_PER_CONVERSATION;

    const lastPromptTokens = latestAssistant?.promptTokens ?? 0;
    const systemAndRules = Math.max(0, lastPromptTokens - recentTokens - conversation.memoryTokens);

    return {
      conversationId: conversation.id,
      // 未命名会话返回空串：契约把 `title` 定义为"由首条消息自动生成"，
      // 返回 null 会让前端模板渲染出 "null" 字样
      title: conversation.title ?? '',
      mode: scene.mode,
      modeName: modeNameOf(scene.mode),
      tone: scene.tone,
      status: conversation.status,
      includePersona: scene.includePersona,
      relationship,
      context: {
        promptKey: promptMeta.contractKey,
        promptVersion: promptMeta.version,
        ...this.resolveDefaultProviderAndModel(promptMeta, latestAssistant?.model ?? null),
        temperature: promptMeta.temperature,
        maxTokens: promptMeta.maxTokens,
        /**
         * `tokenBudget` 透明化（契约规则 1：便于排障"为什么 AI 不记得我之前说的"）。
         *
         * 详情接口**不渲染** Prompt（渲染需要用户输入与历史，属发消息链路），
         * 因此 `systemAndRules` 用"上次真实 `promptTokens` 减去可解释部分"反推 ——
         * 那是真实值，比按模板长度估算更可信。
         */
        tokenBudget: {
          systemAndRules,
          myPersona: persona.myEstimatedTokens,
          partnerPersona: persona.partnerEstimatedTokens,
          memorySummary: conversation.memoryTokens,
          recentMessages: recentTokens,
          total: lastPromptTokens,
          limit: TOKEN_BUDGET.total,
        },
        injectedAt: latestAssistant?.createdAt.toISOString() ?? null,
        missingPersona: persona.missingPersona,
      },
      messageCount: conversation.messageCount,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      totalTokens: conversation.totalTokens,
      estimatedCostCents: conversation.totalCostAmount,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      archivedAt: conversation.archivedAt?.toISOString() ?? null,
      permissions: {
        canSendMessage: canSend,
        canStream: canSend,
        canDelete: true,
        /**
         * 导出端点不存在（契约 §3.7 没有导出接口），因此恒为 false。
         * 不返回 `true`：前端会据此显示一个点了没反应的按钮。
         */
        canExport: false,
      },
      quota: quotaSummary,
      systemNotice,
      disclaimer,
    };
  }

  // ==========================================================================
  // 配额（契约 §3.7.8）
  // ==========================================================================

  /**
   * AI 配额与会员状态
   *
   * 配额判定全部走 `ChatQuotaService`（它内部用 `EntitlementService`，ADR-015）；
   * 本方法只负责组装响应。`includeUsage = true` 时才查近 7 天聚合 ——
   * 默认 false 的接口不该为一个不返回的字段付出聚合查询的代价。
   */
  async getQuota(userId: string, includeUsage: boolean): Promise<AiQuotaView> {
    const now = new Date();

    const [availability, limits, usage] = await Promise.all([
      this.quota.resolveAvailability(userId, now),
      this.quota.loadLimits(),
      this.loadUsageStats(userId, includeUsage),
    ]);

    const exhausted = !availability.view.hasQuota;

    return {
      plan: {
        type: availability.isMember ? 'MEMBERSHIP_ACTIVE' : availability.view.creditBalance > 0 ? 'AI_CREDITS' : 'FREE',
        planCode: availability.planCode,
        planName: availability.planName,
        isActive: availability.isMember,
        expiresAt: availability.expiresAt,
        remainingDays:
          availability.expiresAt === null
            ? null
            : Math.max(0, Math.ceil((new Date(availability.expiresAt).getTime() - now.getTime()) / 86_400_000)),
        benefits: {
          aiDailyLimit: limits.memberDailyLimit,
          /**
           * 以下四项的真实权益在 `MembershipPlan.benefits`，且真正的判定由
           * `EntitlementService` 在各业务接口内完成（ADR-015）。
           * AI 配额接口只需要回显"会员是否覆盖这些能力"，因此用 `isMember` 推导。
           */
          unlimitedReports: availability.isMember,
          reportRegenerateDailyLimit: 5,
          pdfExportUnlimited: availability.isMember,
          compatibilityReportIncluded: availability.isMember,
        },
      },
      quota: availability.view,
      exhausted,
      nextActions: {
        canChat: !exhausted,
        upgradeUrl: PAYWALL_UPGRADE_URL,
        creditsUrl: PAYWALL_CREDITS_URL,
        reason: exhausted ? exhaustedReasonOf(availability.view.limitedBy) : null,
      },
      usage,
      limits: {
        rateLimit: {
          windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
          maxRequests: RATE_LIMIT_MAX_REQUESTS,
          // 契约 §3.7.8 的静态回显里写的是 `50002`；本项目同码是
          // `AI_PROVIDER_RATE_LIMITED`（AI 提供方限流），而接口级限流码是
          // `RATE_LIMITED`（10007）。这里回显**本项目真正会抛出的那个码**，
          // 否则前端按码分支会永远匹配不上（已在简报标注该差异）
          errorCode: ErrorCode.RATE_LIMITED,
        },
        maxConcurrentStreams: await this.readLimit(CONFIG_KEY_MAX_CONCURRENT_STREAMS, 3),
        maxMessageLength: limits.maxMessageLength,
        maxMessagesPerConversation: MAX_MESSAGES_PER_CONVERSATION,
        maxConversationsPerDay: MAX_CONVERSATIONS_PER_DAY_LIMIT,
        newUserDailyLimit: NEW_USER_DAILY_LIMIT,
      },
      serverTime: now.toISOString(),
    };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** AI 功能开关（契约 §3.7.1 `90009`） */
  private assertAiChatEnabled(): void {
    const enabled = this.configService.get('features.aiChat', { infer: true });

    if (!enabled) {
      throw BusinessException.forbidden(ErrorCode.SERVICE_UNAVAILABLE, 'AI 助手功能暂未开放');
    }
  }

  /**
   * provider / model 的解析顺序：**Prompt 版本上钉住的 > 全局首选 Provider**
   *
   * 为什么响应里就必须给出：前端在**会话首屏**要显示"本次由哪个模型回答"
   * （`pkgChat/pages/index.vue` 展示 `meta.model`），而首屏时还没有任何消息。
   * 若此刻不填，前端只能等第一条回复才知道模型。
   */
  private resolveDefaultProviderAndModel(
    meta: PromptMetaView,
    fallbackModel?: string | null,
  ): {
    provider: string;
    model: string;
  } {
    const available = this.providers.resolveAvailable();

    return {
      // 契约里 provider 是小写字面量（`deepseek` / `openai` / `qwen`），
      // 而库内 `AiProvider` 是大写枚举，故统一转小写
      provider: (meta.provider ?? this.providers.configKeyOf(available.name)).toLowerCase(),
      model: meta.model ?? fallbackModel ?? available.defaultModel,
    };
  }

  /**
   * 关系校验（契约 `50023` / `60020`）
   *
   * 两种失败分别记不同日志：越权是**安全事件**（要能被监控发现），
   * 关系未生效是正常业务状态。混在一起记会让安全告警被业务噪声淹没。
   */
  private async resolveRelationship(
    userId: string,
    relationshipId: string | null,
  ): Promise<ConversationRelationshipView | null> {
    if (relationshipId === null) return null;

    const relationship = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, deletedAt: null },
      select: { id: true, type: true, status: true, userAId: true, userBId: true },
    });

    if (relationship === null || (relationship.userAId !== userId && relationship.userBId !== userId)) {
      this.logger.warn(`绑定关系不属于当前用户（可能的 IDOR 尝试）relationshipId=${relationshipId} userId=${userId}`);
      throw BusinessException.forbidden(ErrorCode.RELATIONSHIP_NOT_OWNED);
    }

    if (relationship.status !== 'ACTIVE') {
      throw new BusinessException(ErrorCode.RELATIONSHIP_STATUS_INVALID, '该关系尚未生效或已解除，无法绑定会话');
    }

    const partnerId = relationship.userAId === userId ? relationship.userBId : relationship.userAId;
    const [partner, partnerProfile] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: partnerId }, select: { nickname: true } }),
      this.prisma.personalityProfile.findFirst({
        where: { userId: partnerId, isCurrent: true, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { mbtiType: true },
      }),
    ]);

    return {
      relationshipId: relationship.id,
      relationType: relationship.type,
      status: relationship.status,
      partnerNickname: partner?.nickname?.trim() || null,
      partnerMbtiType: partnerProfile?.mbtiType ?? null,
    };
  }

  /** 详情接口的关系视图（关系已解除时仍返回，供前端展示"该关系已解除"） */
  private async loadRelationshipView(
    userId: string,
    relationshipId: string | null,
  ): Promise<ConversationRelationshipView | null> {
    return this.resolveRelationshipForDisplay(userId, relationshipId);
  }

  /** 与 `resolveRelationship` 的区别：**不抛错**（详情接口读已存在的会话时，关系可能已解除） */
  private async resolveRelationshipForDisplay(
    userId: string,
    relationshipId: string | null,
  ): Promise<ConversationRelationshipView | null> {
    if (relationshipId === null) return null;

    const relationship = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, deletedAt: null, OR: [{ userAId: userId }, { userBId: userId }] },
      select: { id: true, type: true, status: true, userAId: true, userBId: true },
    });

    if (relationship === null) return null;

    const partnerId = relationship.userAId === userId ? relationship.userBId : relationship.userAId;
    const [partner, partnerProfile] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: partnerId }, select: { nickname: true } }),
      this.prisma.personalityProfile.findFirst({
        where: { userId: partnerId, isCurrent: true, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { mbtiType: true },
      }),
    ]);

    return {
      relationshipId: relationship.id,
      relationType: relationship.type,
      status: relationship.status,
      partnerNickname: partner?.nickname?.trim() || null,
      partnerMbtiType: partnerProfile?.mbtiType ?? null,
    };
  }

  /**
   * 日创建次数上限（契约 §3.7.1 `10010`：24h 内 10 次）
   *
   * ⚠ 用 **DB 计数**而不是 Redis 计数：`ChatQuotaService` 的 Redis 键都带 UTC+8
   * 日期（日界语义），而契约这里是"24h 滑动窗口"。复用同一个键会让
   * "昨天 23:00 建了 10 个"在"今天 00:30"又允许 10 个。
   * 因此直接数 `ai_conversations.createdAt`：`[userId, status, lastMessageAt]`
   * 索引能先把范围收窄到该用户的几十行，代价可接受。
   */
  private async enforceDailyConversationLimit(userId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const created = await this.prisma.aiConversation.count({
      where: { userId, createdAt: { gte: since } },
    });

    if (created >= MAX_CONVERSATIONS_PER_DAY_LIMIT) {
      throw BusinessException.tooManyRequests(
        ErrorCode.RATE_LIMITED,
        `24 小时内最多创建 ${MAX_CONVERSATIONS_PER_DAY_LIMIT} 个会话，请稍后再试`,
      );
    }
  }

  /** 我的当前画像（取 `personaInjected.myProfile.profileVersion`） */
  private async loadMyProfile(userId: string): Promise<{ version: number } | null> {
    return this.prisma.personalityProfile.findFirst({
      where: { userId, isCurrent: true, deletedAt: null },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
  }

  /**
   * 解析 Prompt 元信息（不渲染）
   *
   * 与 `assembleChatPrompt` 用同一套候选键链，但**不需要变量**：创建会话时还没有
   * 任何上下文。找不到模板时**不报错**（与发消息链路不同）—— 会话本身可以先建好，
   * "模板还没上线"应该在**发消息**时明确报错，而不是让用户连会话都建不出来。
   */
  private async resolvePromptMetaBestEffort(mode: ConversationMode): Promise<PromptMetaView> {
    const contractKey = promptKeyOf(mode);
    const candidates = templateKeyCandidatesOf(contractKey);

    for (const candidate of candidates) {
      try {
        const meta = await this.prompts.getTemplateMeta(candidate);

        return {
          contractKey,
          version: meta.version,
          provider: meta.provider,
          model: meta.model,
          temperature: meta.temperature,
          maxTokens: meta.maxTokens,
        };
      } catch {
        // 继续尝试下一个候选键；全部失败时返回 null 元信息（见方法头说明）
        continue;
      }
    }

    this.logger.warn(
      `会话模板尚未配置，响应中的 promptVersion 将为 null contractKey=${contractKey} candidates=${candidates.join(',')}`,
    );

    return { contractKey, version: null, provider: null, model: null, temperature: null, maxTokens: null };
  }

  /** 创建接口复用同一份容错逻辑（它也需要 provider/model 回显） */
  private async resolvePromptMeta(mode: ConversationMode): Promise<PromptMetaView> {
    return this.resolvePromptMetaBestEffort(mode);
  }

  /** 最近 10 条消息占用的 token（`tokenBudget.recentMessages` 的近似值） */
  private async readRecentTokens(conversationId: string): Promise<number> {
    const rows = await this.prisma.aiMessage.findMany({
      where: { conversationId, deletedAt: null, role: { in: ['USER', 'ASSISTANT'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      select: { totalTokens: true },
    });

    return rows.reduce((sum, row) => sum + row.totalTokens, 0);
  }

  /** 读一个正整数限额配置（非数值或非正数一律用兜底） */
  private async readLimit(key: string, fallback: number): Promise<number> {
    const value = await this.quota.readStringConfig(key, String(fallback));
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
  }

  /**
   * 用量统计（契约 §3.7.8 `usage`）
   *
   * 只统计**成功且非缓存命中**的 `AI_COMPANION` 调用：失败调用不扣额度（契约规则 4），
   * 若把它们算进 `usedToday`，"今日已用"就会与实际扣减不一致，用户会看到
   * "我没聊几句怎么就用了 10 次"。
   *
   * 聚合走 `createdAt`（能命中 `[userId, createdAt]` 索引）；`usageDate` 是
   * `@db.Date` 且按 UTC 截断，用它聚合会与"UTC+8 日界"的配额口径打架
   * （见 `chat-quota.util.ts` 文件头的时区说明）。
   */
  private async loadUsageStats(userId: string, includeUsage: boolean): Promise<AiQuotaView['usage']> {
    const startOfToday = startOfShanghaiDay(new Date());
    const sevenDaysAgo = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
    const baseWhere = { userId, taskType: 'AI_COMPANION' as const, success: true, cacheHit: false };

    const [todayAggregate, totalAggregate, totalCount, recentRows] = await Promise.all([
      this.prisma.aiUsageLog.aggregate({
        where: { ...baseWhere, createdAt: { gte: startOfToday } },
        _sum: { totalTokens: true, costAmount: true },
        _count: { _all: true },
      }),
      this.prisma.aiUsageLog.aggregate({ where: baseWhere, _sum: { totalTokens: true } }),
      this.prisma.aiUsageLog.count({ where: baseWhere }),
      includeUsage
        ? this.prisma.aiUsageLog.findMany({
            where: { ...baseWhere, createdAt: { gte: sevenDaysAgo } },
            select: { totalTokens: true, costAmount: true, createdAt: true },
          })
        : Promise.resolve([]),
    ]);

    const totalTokens = totalAggregate._sum.totalTokens ?? 0;

    // 先把 7 天全部铺成 0：契约示例里 `2026-02-11` 是 `messageCount: 0` 的一天，
    // 说明"没有用量的日子也要出现"。只输出有数据的日期，前端画不出连续折线
    const byDay = new Map<string, { messageCount: number; totalTokens: number; estimatedCostCents: number }>();
    for (let offset = 0; offset < 7; offset += 1) {
      byDay.set(shanghaiDateKeyOf(new Date(sevenDaysAgo.getTime() + offset * 86_400_000)), {
        messageCount: 0,
        totalTokens: 0,
        estimatedCostCents: 0,
      });
    }

    for (const row of recentRows) {
      const current = byDay.get(shanghaiDateKeyOf(row.createdAt));
      if (current === undefined) continue;

      current.messageCount += 1;
      current.totalTokens += row.totalTokens;
      current.estimatedCostCents += row.costAmount;
    }

    return {
      today: {
        date: shanghaiIsoDateOf(new Date()),
        messageCount: todayAggregate._count._all,
        totalTokens: todayAggregate._sum.totalTokens ?? 0,
        estimatedCostCents: todayAggregate._sum.costAmount ?? 0,
      },
      last7Days: [...byDay.entries()].map(([key, value]) => ({
        date: `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
        messageCount: value.messageCount,
        totalTokens: value.totalTokens,
        estimatedCostCents: value.estimatedCostCents,
      })),
      totalMessageCount: totalCount,
      totalTokens,
      averageTokensPerMessage: totalCount === 0 ? 0 : Math.round(totalTokens / totalCount),
    };
  }
}

// ============================================================================
// 纯函数辅助
// ============================================================================

/** UTC+8 当天零点（配额统计的日界，见 `chat-quota.util.ts` 的时区说明） */
export const startOfShanghaiDay = (now: Date): Date => {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());

  return new Date(midnight - 8 * 60 * 60 * 1000);
};

/** UTC+8 的 `yyyyMMdd`（避免把整个 quota util 拖进本文件） */
export const shanghaiDateKeyOf = (date: Date): string => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);

  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
};

/** UTC+8 的 `yyyy-MM-dd` */
export const shanghaiIsoDateOf = (date: Date): string => {
  const key = shanghaiDateKeyOf(date);

  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
};

/** 配额耗尽原因（契约 §3.7.8 规则 2 的 `nextActions.reason`） */
export const exhaustedReasonOf = (limitedBy: QuotaAvailability['view']['limitedBy']): string | null => {
  switch (limitedBy) {
    case 'FREE_QUOTA':
      return 'FREE_QUOTA_EXHAUSTED';
    case 'CREDITS':
      return 'CREDITS_EXHAUSTED';
    case 'DAILY_LIMIT':
      return 'DAILY_LIMIT_REACHED';
    case 'NONE':
      return null;
  }
};
