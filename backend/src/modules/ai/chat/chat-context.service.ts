/**
 * 会话上下文与查询服务（契约 §3.7.2 / §3.7.3 / §3.7.4 / §3.7.7）
 *
 * 职责划分：
 *   · 本文件——**读**（列表 / 详情 / 消息历史）、**删除**、以及把画像/关系/记忆
 *     组装成 `ChatContextInput`（纯计算在 `chat-context.util.ts` 与
 *     `chat-persona.util.ts`，本文件只负责取数）；
 *   · `chat-message.service.ts`——**写**（发消息 / 流式），因为它要串起
 *     安全检测 → 配额 → Prompt → Provider → 落库 的完整链路。
 *
 * ## IDOR 防护的统一写法
 *
 * 契约反复强调「强归属过滤 `WHERE userId = currentUser.id`」（§3.7.2 规则 1、
 * 架构 §14.1）。本文件所有查询都**同时**带 `id` 与 `userId`：
 * `findFirst({ where: { id, userId } })` —— 而不是"先按 id 查、再比较 userId"。
 * 后者的失败模式是：某天有人加了一条不经比较的分支，IDOR 就悄悄出现了。
 * 前者的失败模式是"查不到"，天然安全。
 *
 * ## 为什么用 `scene` 存 mode/tone
 *
 * `schema.prisma` 没有 `mode` / `tone` / `includePersona` 三列（属共享文件，
 * 禁止修改）。编解码集中在 `chat.types.ts` 的 `encodeScene` / `decodeScene`，
 * 本文件只调用而不自己拼字符串。详见简报「缺失的表/列」。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { relationTypeName } from '../../relationship/relationship-view.util';
import {
  RECENT_MESSAGE_LIMIT,
  assembleChatContext,
  resolveMissingPersona,
  type ChatContextAssembly,
  type ContextHintSnippet,
  type ConversationHistoryMessage,
  type MissingPersona as MissingPersonaValue,
} from './chat-context.util';
import { assemblePersona, type PersonaProfileRow } from './chat-persona.util';
import { ChatQuotaService } from './chat-quota.service';
import {
  AUTO_TITLE_LENGTH,
  CONFIG_KEY_SYSTEM_NOTICE,
  DEFAULT_SYSTEM_NOTICE,
  MESSAGE_PREVIEW_LENGTH,
  decodeScene,
  modeNameOf,
  type ContextHint,
  type ConversationMode,
  type ConversationSortField,
  type ConversationStatus,
  type ConversationTone,
  type DeleteMode,
  type SortOrder,
} from './chat.types';

/**
 * 契约 §3.7.3 的 `missingPersona` 取值域是
 * `null | 'MY_PROFILE_MISSING' | 'PARTNER_PROFILE_MISSING' | 'BOTH'`
 *
 * 这里重新导出（而不是让调用方从 `chat-context.util` 直接 import）只是为了让
 * 本文件与调用方的类型签名读起来自洽 —— 同一个语义的类型如果散落在两个文件里
 * 被各自引用，日后改名时极易漏改一处。
 */
export type MissingPersona = MissingPersonaValue;

/** 会话内嵌的关系摘要 */
export interface ConversationRelationshipView {
  readonly relationshipId: string;
  readonly relationType: string;
  readonly status?: string;
  readonly partnerNickname: string | null;
  readonly partnerMbtiType?: string | null;
}

/** 会话列表项（契约 §3.7.2 `items[]`） */
export interface ConversationListItemView {
  readonly conversationId: string;
  readonly title: string;
  readonly mode: ConversationMode;
  readonly modeName: string;
  readonly status: string;
  readonly includePersona: boolean;
  readonly relationship: ConversationRelationshipView | null;
  readonly messageCount: number;
  readonly userMessageCount: number;
  readonly assistantMessageCount: number;
  readonly lastMessage: {
    readonly messageId: string;
    readonly role: string;
    /** 截取 60 字，**不做 Markdown 渲染**（契约 §3.7.2 规则 2：防注入） */
    readonly preview: string;
    readonly createdAt: string;
  } | null;
  readonly lastMessageAt: string | null;
  readonly createdAt: string;
  readonly totalTokens: number;
  readonly estimatedCostCents: number;
}

/** 会话列表响应（契约 §3.7.2） */
export interface ConversationListView {
  readonly items: readonly ConversationListItemView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly summary: {
    readonly totalConversations: number;
    readonly activeConversations: number;
    readonly archivedConversations: number;
    readonly totalMessages: number;
  };
  readonly quota: Awaited<ReturnType<ChatQuotaService['summaryFor']>>;
}

/** 消息视图（契约 §3.7.4 `items[]`） */
export interface MessageView {
  readonly messageId: string;
  readonly conversationId: string;
  readonly role: string;
  readonly content: string;
  readonly contentFormat: 'PLAIN' | 'MARKDOWN';
  readonly tokens: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly latencyMs: number | null;
  readonly finishReason: string | null;
  readonly isStreamed: boolean;
  readonly isSafetyResponse: boolean;
  readonly createdAt: string;
}

/** 消息历史响应（契约 §3.7.4） */
export interface MessageListView {
  readonly items: readonly MessageView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly nextCursor: string | null;
  readonly summary: {
    readonly totalMessages: number;
    readonly userMessages: number;
    readonly assistantMessages: number;
    readonly safetyResponses: number;
    readonly totalTokens: number;
  };
}

/** 会话详情响应（契约 §3.7.3） */
export interface ConversationDetailView {
  readonly conversationId: string;
  readonly title: string;
  readonly mode: ConversationMode;
  readonly modeName: string;
  readonly tone: ConversationTone;
  readonly status: string;
  readonly includePersona: boolean;
  readonly relationship: ConversationRelationshipView | null;
  readonly context: {
    readonly promptKey: string;
    readonly promptVersion: number | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly temperature: number | null;
    readonly maxTokens: number | null;
    readonly tokenBudget: ChatContextAssembly['tokenBudget'];
    readonly injectedAt: string | null;
    readonly missingPersona: MissingPersona;
  };
  readonly messageCount: number;
  readonly lastMessageAt: string | null;
  readonly totalTokens: number;
  readonly estimatedCostCents: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly permissions: {
    readonly canSendMessage: boolean;
    readonly canStream: boolean;
    readonly canDelete: boolean;
    readonly canExport: boolean;
  };
  readonly quota: Awaited<ReturnType<ChatQuotaService['summaryFor']>>;
  readonly systemNotice: string;
  readonly disclaimer: string;
}

/** 删除结果（契约 §3.7.7） */
export interface DeleteConversationView {
  readonly conversationId: string;
  readonly previousStatus: string;
  readonly status: string;
  readonly mode: DeleteMode;
  readonly hardDelete: boolean;
  readonly affectedMessages: number;
  readonly contentCleared: boolean;
  readonly deletedAt: string;
  readonly canRestore: boolean;
  readonly usageRetained: {
    readonly note: string;
    readonly tokensRetained: number;
    readonly costCentsRetained: number;
  };
}

/** 列表查询入参（DTO 已校验，此处不重复判定） */
export interface ListConversationsInput {
  readonly userId: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: readonly ConversationStatus[];
  readonly relationshipId?: string;
  readonly mode?: readonly ConversationMode[];
  readonly keyword?: string;
  readonly sortBy?: ConversationSortField;
  readonly order?: SortOrder;
}

/** 消息历史查询入参 */
export interface ListMessagesInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly before?: string;
  readonly role?: string;
  readonly order?: SortOrder;
}

/** 会话 + 上下文（发消息链路用） */
export interface PreparedConversation {
  readonly conversationId: string;
  readonly userId: string;
  readonly title: string | null;
  readonly mode: ConversationMode;
  readonly tone: ConversationTone;
  readonly includePersona: boolean;
  readonly status: ConversationStatus;
  readonly messageCount: number;
  readonly relationshipId: string | null;
  readonly memorySummary: string | null;
  readonly context: ChatContextAssembly;
  readonly personaTokens: { readonly my: number; readonly partner: number };
  readonly missingPersona: MissingPersona;
  /** 关系仍有效（`status = ACTIVE`）时为 true；关系已解除时降级为"无关系上下文"（契约 §3.7.7 规则 5） */
  readonly relationshipActive: boolean;
  readonly partnerNickname: string | null;
  readonly relationType: string | null;
}

/** 硬删除时写入消息正文的占位（契约 §3.7.7：`hardDelete = true` 时消息 `content` 置为 `[已删除]`） */
export const DELETED_MESSAGE_PLACEHOLDER = '[已删除]';

/** 单条消息最多保留的预览字符（与 `MESSAGE_PREVIEW_LENGTH` 一致，单独命名以说明用途） */
const PREVIEW_SOURCE_LIMIT = MESSAGE_PREVIEW_LENGTH;

/** 画像行投影（只取装配人设需要的列） */
const PROFILE_SELECT = {
  mbtiType: true,
  mbtiConfidence: true,
  eiPercent: true,
  snPercent: true,
  tfPercent: true,
  jpPercent: true,
  openness: true,
  conscientiousness: true,
  extraversion: true,
  agreeableness: true,
  neuroticism: true,
  attachmentStyle: true,
  loveLanguages: true,
  conflictStyle: true,
} as const;

@Injectable()
export class ChatContextService {
  private readonly logger = new Logger(ChatContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: ChatQuotaService,
  ) {}

  // ==========================================================================
  // 上下文装配
  // ==========================================================================

  /**
   * 取用户昵称
   *
   * 取不到（历史数据缺昵称）时回落"你"：把 `undefined` 塞进 Prompt 会渲染成
   * `undefined` 字样出现在给模型看的人设里，而 `userName` 只是称呼，不是关键信息。
   */
  async loadUserName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true } });

    return user?.nickname?.trim() || '你';
  }

  /**
   * 读取并校验会话可见性（IDOR 防护的唯一入口）
   *
   * 「不存在」与「不属于你」**返回不同错误码**（`50003` / `50004`），这是契约
   * §3.7.3 明确要求的（与报告接口刻意同码的做法相反）。契约覆盖了同码更安全的
   * 通用原则，此处按契约实现 —— 已在简报中标注这一点。
   */
  async requireOwnedConversation(userId: string, conversationId: string): Promise<void> {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, status: true, deletedAt: true },
    });

    if (conversation === null || conversation.status === 'DELETED' || conversation.deletedAt !== null) {
      throw BusinessException.notFound(ErrorCode.AI_CONVERSATION_NOT_FOUND);
    }

    if (conversation.userId !== userId) {
      this.logger.warn(`会话归属校验失败（可能的 IDOR 尝试）conversationId=${conversationId} userId=${userId}`);
      throw BusinessException.forbidden(ErrorCode.AI_CONVERSATION_NOT_OWNED);
    }
  }

  /**
   * 装配一次对话所需的全部上下文
   *
   * 顺序：会话 → 双方画像 → 历史消息 → 记忆摘要 → 报告摘要 → 预算裁剪。
   * 每一步都允许"缺失"：没有画像、没有对方、没有历史、没有记忆，都是正常的
   * 会话形态（个人第一次倾诉就什么都没有），不能因此报错。
   */
  async buildContext(params: {
    userId: string;
    conversationId: string;
    includePersona: boolean;
    contextHints: readonly ContextHint[];
    /** 是否读取历史消息（SSE 与非流式都读；会话详情不读） */
    withHistory?: boolean;
  }): Promise<PreparedConversation> {
    const conversation = await this.requireOwnedConversationForRead(params.userId, params.conversationId);
    const scene = decodeScene(conversation.scene);

    const includePersona = params.includePersona && scene.includePersona;

    const [myProfile, relationship] = await Promise.all([
      this.loadCurrentProfile(params.userId),
      this.loadRelationship(params.userId, conversation.relationshipId),
    ]);

    const partnerProfile = relationship === null ? null : await this.loadCurrentProfile(relationship.partnerId);

    const persona = assemblePersona({
      includePersona,
      myProfile,
      partnerProfile,
      partnerNickname: relationship?.partnerNickname ?? null,
      relationTypeName: relationship === null ? null : relationTypeName(relationship.type),
    });

    const history =
      params.withHistory === false
        ? []
        : await this.loadRecentMessages(params.conversationId, RECENT_MESSAGE_LIMIT * 2);

    const hintSnippets =
      params.contextHints.length === 0
        ? []
        : await this.loadHintSnippets(params.userId, params.contextHints, conversation.relationshipId);

    /**
     * 画像缺失标记
     *
     * `includePersona = false` 时恒为 `null`：**"缺画像"与"用户主动不注入画像"是两种
     * 语义**。若把后者也报成 `MY_PROFILE_MISSING`，前端会弹出"先完成测试，助手会更懂你"
     * 的引导 —— 而用户刚刚主动关掉了画像注入，这个提示会显得莫名其妙。
     */
    const missingPersona = includePersona
      ? resolveMissingPersona(myProfile !== null, relationship !== null && partnerProfile !== null)
      : null;

    const assembly = assembleChatContext({
      includePersona,
      myPersona: persona.myPersona,
      partnerPersona: persona.partnerPersona,
      memorySummary: conversation.memorySummary,
      recentMessages: history,
      hintSnippets,
      missingPersona,
    });

    return {
      conversationId: conversation.id,
      userId: conversation.userId,
      title: conversation.title,
      mode: scene.mode,
      tone: scene.tone,
      includePersona,
      status: conversation.status,
      messageCount: conversation.messageCount,
      relationshipId: conversation.relationshipId,
      memorySummary: conversation.memorySummary,
      context: assembly,
      personaTokens: { my: persona.myEstimatedTokens, partner: persona.partnerEstimatedTokens },
      missingPersona,
      relationshipActive: relationship?.status === 'ACTIVE',
      partnerNickname: relationship?.partnerNickname ?? null,
      relationType: relationship === null ? null : relationTypeName(relationship.type),
    };
  }

  /** 会话详情接口需要的关系/画像信息（不读历史，故单独一个小入口） */
  async buildPersonaSummary(
    userId: string,
    relationshipId: string | null,
    includePersona: boolean,
  ): Promise<{
    myEstimatedTokens: number;
    partnerEstimatedTokens: number;
    missingPersona: MissingPersona;
    myMbtiType: string | null;
    partnerMbtiType: string | null;
  }> {
    const [myProfile, relationship] = await Promise.all([
      this.loadCurrentProfile(userId),
      this.loadRelationship(userId, relationshipId),
    ]);

    const partnerProfile = relationship === null ? null : await this.loadCurrentProfile(relationship.partnerId);

    const persona = assemblePersona({
      includePersona,
      myProfile,
      partnerProfile,
      partnerNickname: relationship?.partnerNickname ?? null,
    });

    return {
      myEstimatedTokens: persona.myEstimatedTokens,
      partnerEstimatedTokens: persona.partnerEstimatedTokens,
      missingPersona: includePersona
        ? resolveMissingPersona(myProfile !== null, relationship !== null && partnerProfile !== null)
        : null,
      myMbtiType: myProfile?.mbtiType ?? null,
      partnerMbtiType: partnerProfile?.mbtiType ?? null,
    };
  }

  // ==========================================================================
  // 会话列表
  // ==========================================================================

  /**
   * 会话列表（契约 §3.7.2）
   *
   * 三处容易做错的地方：
   * ① `summary` 是**该用户全部会话**的口径，不随筛选/翻页变化。若数当前页，
   *    翻到第 2 页会看到"共 1 个会话"，用户以为数据丢了（与 `report.service.ts` 同一处理）。
   * ② `lastMessage` 用**一次 `in` 查询**取回，不在循环里逐条查（100 条就是 100 次往返）。
   * ③ `userMessageCount` / `assistantMessageCount` 用一次 `groupBy` 聚合，
   *    而不是对每条会话各查两次。
   */
  async listConversations(input: ListConversationsInput): Promise<ConversationListView> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const statuses = input.status !== undefined && input.status.length > 0 ? input.status : (['ACTIVE'] as const);

    if (input.relationshipId !== undefined) {
      await this.requireOwnedRelationship(input.userId, input.relationshipId);
    }

    const baseWhere = {
      userId: input.userId,
      deletedAt: null,
      ...(input.relationshipId !== undefined ? { relationshipId: input.relationshipId } : {}),
    };

    const where = {
      ...baseWhere,
      status: { in: [...statuses] },
      /**
       * `mode` 筛选：`scene` 的编码形态是 `${mode}|${tone}|${0|1}`（见 `chat.types.encodeScene`），
       * 因此"按模式筛"就是前缀匹配。用 `startsWith` 而**不是** `in`：
       * `scene` 里除了 mode 还带 tone 与 includePersona，精确 `in` 永远匹配不到任何行 ——
       * 这类"筛出来永远是空列表"的 bug 在联调时极易被误判成"用户没有会话"。
       */
      ...(input.mode !== undefined && input.mode.length > 0
        ? { OR: input.mode.map((mode) => ({ scene: { startsWith: `${mode}|` } })) }
        : {}),
      ...(input.keyword !== undefined && input.keyword.length > 0
        ? // 标题是服务端生成的（非用户自由文本），契约明确其无注入风险；
          // 这里仍走 Prisma 的参数化查询，不存在 SQL 注入面
          { title: { contains: input.keyword, mode: 'insensitive' as const } }
        : {}),
    };

    const orderField = input.sortBy ?? 'lastMessageAt';
    const order = input.order ?? 'desc';

    const [rows, total, statusCounts, allConversations, messageTotals, quotaSummary] = await Promise.all([
      this.prisma.aiConversation.findMany({
        where,
        // `lastMessageAt` 可为 null（新建但还没发过消息），`nulls: 'last'` 让它们排在
        // 有消息的会话之后；否则默认 NULL FIRST 会把刚建的会话顶到最上面
        orderBy:
          orderField === 'lastMessageAt' ? { lastMessageAt: { sort: order, nulls: 'last' } } : { createdAt: order },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: CONVERSATION_SELECT,
      }),
      this.prisma.aiConversation.count({ where: { ...baseWhere, status: { in: [...statuses] } } }),
      this.prisma.aiConversation.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
      this.prisma.aiConversation.findMany({
        where: baseWhere,
        select: { id: true },
      }),
      this.prisma.aiConversation.aggregate({
        where: baseWhere,
        _sum: { messageCount: true },
      }),
      this.quota.summaryFor(input.userId),
    ]);

    const conversationIds = rows.map((row) => row.id);
    const [lastMessages, roleCounts] = await Promise.all([
      this.loadLastMessages(conversationIds),
      this.loadRoleCounts(conversationIds),
    ]);

    const relationshipIds = [
      ...new Set(rows.map((row) => row.relationshipId).filter((id): id is string => id !== null)),
    ];
    const relationships = await this.loadRelationshipViews(input.userId, relationshipIds);

    const countOf = (status: string): number => statusCounts.find((item) => item.status === status)?._count._all ?? 0;

    return {
      items: rows.map((row) => {
        const roles = roleCounts.get(row.id) ?? { user: 0, assistant: 0 };
        const last = lastMessages.get(row.id) ?? null;

        return {
          conversationId: row.id,
          title: row.title ?? '新对话',
          mode: decodeScene(row.scene).mode,
          modeName: modeNameOf(decodeScene(row.scene).mode),
          status: row.status,
          includePersona: decodeScene(row.scene).includePersona,
          relationship: row.relationshipId === null ? null : (relationships.get(row.relationshipId) ?? null),
          messageCount: row.messageCount,
          userMessageCount: roles.user,
          assistantMessageCount: roles.assistant,
          lastMessage: last,
          lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          totalTokens: row.totalTokens,
          // `ai_conversations.totalCostAmount` 的单位就是"分"（与 `estimateCostCents` 同源），
          // 契约字段名是 `estimatedCostCents`，直接透传即可，不做换算
          estimatedCostCents: row.totalCostAmount,
        };
      }),
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary: {
        // 只统计未软删除的会话：用户看到的是"我名下还有几个"
        totalConversations: allConversations.length,
        activeConversations: countOf('ACTIVE'),
        archivedConversations: countOf('ARCHIVED'),
        totalMessages: messageTotals._sum.messageCount ?? 0,
      },
      quota: quotaSummary,
    };
  }

  // ==========================================================================
  // 消息历史
  // ==========================================================================

  /**
   * 消息历史（契约 §3.7.4）
   *
   * `before` 游标优先于 `page`（契约明确"与 page 二选一，**优先**"）：游标分页是
   * 前端"上拉加载更早消息"的正确做法，深翻页时 `OFFSET` 会退化成全表扫描。
   * `nextCursor` 取本页**最后一条**的 `createdAt`，前端下次带它回来即可续上。
   */
  async listMessages(input: ListMessagesInput): Promise<MessageListView> {
    await this.requireOwnedConversation(input.userId, input.conversationId);

    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const order = input.order ?? 'desc';

    const baseWhere = {
      conversationId: input.conversationId,
      deletedAt: null,
      ...(input.role !== undefined && input.role.length > 0 ? { role: input.role as never } : {}),
    };

    const cursorWhere =
      input.before !== undefined && input.before.length > 0 ? { createdAt: { lt: new Date(input.before) } } : {};

    const [rows, total, roleGroups, aggregate] = await Promise.all([
      this.prisma.aiMessage.findMany({
        where: { ...baseWhere, ...cursorWhere },
        orderBy: [{ createdAt: order }, { id: order }],
        skip: input.before !== undefined && input.before.length > 0 ? 0 : (page - 1) * pageSize,
        take: pageSize,
        select: MESSAGE_SELECT,
      }),
      this.prisma.aiMessage.count({ where: { conversationId: input.conversationId, deletedAt: null } }),
      this.prisma.aiMessage.groupBy({
        by: ['role'],
        where: { conversationId: input.conversationId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.aiMessage.aggregate({
        where: { conversationId: input.conversationId, deletedAt: null },
        _sum: { totalTokens: true },
      }),
    ]);

    const safetyResponses = await this.prisma.aiMessage.count({
      where: {
        conversationId: input.conversationId,
        deletedAt: null,
        safetyStatus: 'BLOCKED',
      },
    });

    const countOf = (role: string): number => roleGroups.find((item) => item.role === role)?._count._all ?? 0;

    const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;

    return {
      items: rows.map(toMessageView),
      total,
      page,
      pageSize,
      // 页满即"可能还有下一页"。不用 `page * pageSize < total`：游标模式下 total 是
      // 整个会话的消息数，与"当前位置之后还有没有"无关 —— 那会让第一页就误报"没有更多"
      hasNext: rows.length === pageSize,
      nextCursor: rows.length === pageSize && lastRow !== undefined ? lastRow.createdAt.toISOString() : null,
      summary: {
        totalMessages: total,
        userMessages: countOf('USER'),
        assistantMessages: countOf('ASSISTANT'),
        safetyResponses,
        totalTokens: aggregate._sum.totalTokens ?? 0,
      },
    };
  }

  // ==========================================================================
  // 删除 / 归档
  // ==========================================================================

  /**
   * 删除或归档（契约 §3.7.7）
   *
   * 三处语义要点：
   * ① **天然幂等**：重复删除返回成功（契约"幂等：天然幂等"）。因此
   *    `requireOwnedConversation` 只在首次（会话仍可见）时校验，
   *    对**已经 DELETED 的会话**直接返回成功而不报 404 —— 否则前端重复点击会看到错误。
   * ② **硬删除清空正文但不删行**：保留消息计数与时间戳（统计口径）、保留
   *    `ai_usage_logs`（计费与审计）。契约明确 `usageRetained` 的语义就是"计量保留、正文不留"。
   * ③ **归档可恢复**（`canRestore = true`），硬删除不可恢复。
   */
  async deleteConversation(params: {
    userId: string;
    conversationId: string;
    mode: DeleteMode;
    hardDelete: boolean;
  }): Promise<DeleteConversationView> {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: params.conversationId },
      select: {
        id: true,
        userId: true,
        status: true,
        deletedAt: true,
        messageCount: true,
        totalTokens: true,
        totalCostAmount: true,
      },
    });

    if (conversation === null) {
      throw BusinessException.notFound(ErrorCode.AI_CONVERSATION_NOT_FOUND);
    }

    if (conversation.userId !== params.userId) {
      this.logger.warn(
        `删除会话归属校验失败（可能的 IDOR 尝试）conversationId=${params.conversationId} userId=${params.userId}`,
      );
      throw BusinessException.forbidden(ErrorCode.AI_CONVERSATION_NOT_OWNED);
    }

    // 幂等短路：已删除的会话重复删除直接返回成功（契约"天然幂等"）
    if (conversation.status === 'DELETED' && params.mode === 'DELETE') {
      return {
        conversationId: conversation.id,
        previousStatus: 'DELETED',
        status: 'DELETED',
        mode: params.mode,
        hardDelete: params.hardDelete,
        affectedMessages: 0,
        contentCleared: false,
        deletedAt: (conversation.deletedAt ?? new Date()).toISOString(),
        canRestore: false,
        usageRetained: {
          note: 'AI 用量与成本统计（ai_usage_logs）保留用于计费与审计，但不含任何对话正文。',
          tokensRetained: conversation.totalTokens,
          costCentsRetained: conversation.totalCostAmount,
        },
      };
    }

    const now = new Date();
    const previousStatus = conversation.status;

    /**
     * 硬删除：**清空正文而不是删除行**
     *
     * 删行会连带失去消息计数与时间戳（统计口径断裂），而契约要求"保留消息计数与
     * 时间戳用于统计"。同时把 `clientMessageId` 置空：它带有唯一约束，
     * 保留会让用户在同一会话里再也无法用同一个客户端消息 ID 重发。
     */
    let affectedMessages = 0;
    let contentCleared = false;

    const result = await this.prisma.$transaction(async (tx) => {
      if (params.hardDelete) {
        const cleared = await tx.aiMessage.updateMany({
          where: { conversationId: conversation.id, deletedAt: null, content: { not: DELETED_MESSAGE_PLACEHOLDER } },
          data: {
            content: DELETED_MESSAGE_PLACEHOLDER,
            contentLength: 0,
            clientMessageId: null,
            // 正文已清空，两处派生字段也必须一起清：留下它们等于留下了"原文字数/标签"
            // 这类可推断信息的残留
            safetyLabels: [],
          },
        });

        affectedMessages = cleared.count;
        contentCleared = cleared.count > 0;

        /**
         * 长期记忆向量（`ai_embedding` 队列数据，契约 §3.7.7 规则 2）
         *
         * ⚠ schema 中**没有** `AiEmbedding` 模型（`AiTaskType` 枚举里有
         * `MEMORY_SUMMARY` / `STRUCTURED_EXTRACT`，但没有向量表）。因此这里
         * 只能清掉会话自身的记忆摘要 —— 那是"长期记忆"在当前数据模型下唯一的载体。
         * 已在简报「缺失的表/列」中标注：向量表缺失时无法完成契约要求的向量清理。
         */
      }

      return tx.aiConversation.update({
        where: { id: conversation.id },
        data:
          params.mode === 'ARCHIVE'
            ? { status: 'ARCHIVED', archivedAt: now }
            : {
                status: 'DELETED',
                deletedAt: now,
                // 软删除也清掉记忆摘要：用户要求"不可再访问"之后，任何由对话派生的
                // 内容都不应继续留在库里参与后续会话的注入
                memorySummary: null,
                memoryTokens: 0,
                memoryUpdatedAt: null,
              },
        select: { status: true, deletedAt: true, archivedAt: true },
      });
    });

    this.logger.log(
      `会话已${params.mode === 'ARCHIVE' ? '归档' : '删除'} conversationId=${conversation.id} hardDelete=${params.hardDelete} affectedMessages=${affectedMessages}`,
    );

    return {
      conversationId: conversation.id,
      previousStatus,
      status: result.status,
      mode: params.mode,
      hardDelete: params.hardDelete,
      affectedMessages,
      contentCleared,
      deletedAt: (params.mode === 'ARCHIVE' ? result.archivedAt : result.deletedAt)?.toISOString() ?? now.toISOString(),
      // 归档可恢复（前端提供"取消归档"入口）；删除不可恢复
      canRestore: params.mode === 'ARCHIVE',
      usageRetained: {
        note: 'AI 用量与成本统计（ai_usage_logs）保留用于计费与审计，但不包含任何对话正文。',
        tokensRetained: conversation.totalTokens,
        costCentsRetained: conversation.totalCostAmount,
      },
    };
  }

  // ==========================================================================
  // 共享读取（供 chat-message.service.ts 复用）
  // ==========================================================================

  /**
   * 读取会话（含归属校验），并解码场景
   *
   * `requireOwnedConversation` 只做校验不返回数据（它会丢弃除归属之外的一切），
   * 而发消息链路需要 `messageCount` / `memorySummary` / `relationshipId`，
   * 因此这里提供"校验 + 取数"合一的方法，避免链接里查两遍。
   */
  async requireOwnedConversationForRead(
    userId: string,
    conversationId: string,
  ): Promise<{
    id: string;
    userId: string;
    title: string | null;
    scene: string | null;
    status: ConversationStatus;
    messageCount: number;
    totalTokens: number;
    totalCostAmount: number;
    memorySummary: string | null;
    memoryTokens: number;
    memoryUpdatedAt: Date | null;
    lastMessageAt: Date | null;
    archivedAt: Date | null;
    relationshipId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }> {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        userId: true,
        title: true,
        scene: true,
        status: true,
        messageCount: true,
        totalTokens: true,
        totalCostAmount: true,
        memorySummary: true,
        memoryTokens: true,
        memoryUpdatedAt: true,
        lastMessageAt: true,
        archivedAt: true,
        relationshipId: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });

    if (conversation === null || conversation.status === 'DELETED' || conversation.deletedAt !== null) {
      throw BusinessException.notFound(ErrorCode.AI_CONVERSATION_NOT_FOUND);
    }

    if (conversation.userId !== userId) {
      this.logger.warn(`会话归属校验失败（可能的 IDOR 尝试）conversationId=${conversationId} userId=${userId}`);
      throw BusinessException.forbidden(ErrorCode.AI_CONVERSATION_NOT_OWNED);
    }

    return conversation;
  }

  /** 最近 N 条消息（**升序**返回，供 Prompt 注入；`chat-context.util` 依赖这个顺序） */
  async loadRecentMessages(conversationId: string, limit: number): Promise<ConversationHistoryMessage[]> {
    const rows = await this.prisma.aiMessage.findMany({
      where: { conversationId, deletedAt: null, role: { in: ['USER', 'ASSISTANT'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { role: true, content: true },
    });

    // 查询用倒序（拿最新的 N 条），返回前翻回升序（注入 Prompt 必须按时间正序）
    return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
  }

  /** 读取会话首屏合规提示（`system_configs` 优先，读不到用契约示例文案） */
  async systemNotice(): Promise<string> {
    return this.quota.readStringConfig(CONFIG_KEY_SYSTEM_NOTICE, DEFAULT_SYSTEM_NOTICE);
  }

  /** 计数：会话内消息数（硬删除后仍计入统计口径，与契约"保留消息计数"一致） */
  async countMessages(conversationId: string): Promise<number> {
    return this.prisma.aiMessage.count({ where: { conversationId, deletedAt: null } });
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 当前生效画像（`isCurrent = true`，取版本最高的一条） */
  private async loadCurrentProfile(userId: string): Promise<PersonaProfileRow | null> {
    return this.prisma.personalityProfile.findFirst({
      where: { userId, isCurrent: true, deletedAt: null },
      orderBy: { version: 'desc' },
      select: PROFILE_SELECT,
    });
  }

  /**
   * 关系 + 对方信息
   *
   * 关系已解除（`status !== 'ACTIVE'`）时**仍然返回**，由调用方决定降级策略
   * （契约 §3.7.7 规则 5：新建消息时自动降级为"无关系上下文"并提示用户，不报错）。
   * 若这里直接过滤掉非 ACTIVE 关系，链路就失去了"该提示用户"的信息。
   */
  private async loadRelationship(
    userId: string,
    relationshipId: string | null,
  ): Promise<{
    id: string;
    type: string;
    status: string;
    partnerId: string;
    partnerNickname: string | null;
  } | null> {
    if (relationshipId === null) return null;

    const relationship = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, deletedAt: null, OR: [{ userAId: userId }, { userBId: userId }] },
      select: { id: true, type: true, status: true, userAId: true, userBId: true },
    });

    if (relationship === null) return null;

    const partnerId = relationship.userAId === userId ? relationship.userBId : relationship.userAId;
    const partner = await this.prisma.user.findUnique({ where: { id: partnerId }, select: { nickname: true } });

    return {
      id: relationship.id,
      type: relationship.type,
      status: relationship.status,
      partnerId,
      partnerNickname: partner?.nickname?.trim() || null,
    };
  }

  /** 会话列表里内嵌的关系摘要（一次批量取回，避免 N+1） */
  private async loadRelationshipViews(
    userId: string,
    relationshipIds: readonly string[],
  ): Promise<Map<string, ConversationRelationshipView>> {
    const result = new Map<string, ConversationRelationshipView>();
    if (relationshipIds.length === 0) return result;

    const rows = await this.prisma.relationship.findMany({
      where: { id: { in: [...relationshipIds] }, deletedAt: null },
      select: { id: true, type: true, status: true, userAId: true, userBId: true },
    });

    const partnerIds = rows.map((row) => (row.userAId === userId ? row.userBId : row.userAId));
    const partnerProfiles = await this.prisma.personalityProfile.findMany({
      where: { userId: { in: partnerIds }, isCurrent: true, deletedAt: null },
      select: { userId: true, mbtiType: true },
    });
    const profiles = await this.prisma.user.findMany({
      where: { id: { in: partnerIds } },
      select: { id: true, nickname: true },
    });
    const nicknameById = new Map(profiles.map((row) => [row.id, row.nickname?.trim() || null]));
    const mbtiById = new Map(partnerProfiles.map((row) => [row.userId, row.mbtiType]));

    for (const row of rows) {
      const partnerId = row.userAId === userId ? row.userBId : row.userAId;

      result.set(row.id, {
        relationshipId: row.id,
        relationType: row.type,
        status: row.status,
        partnerNickname: nicknameById.get(partnerId) ?? null,
        // 列表项契约里没有 `partnerMbtiType`（只有详情有），这里带上不会有害：
        // 前端可以少发一次详情请求就能渲染"小满 · INFJ"这类标签
        partnerMbtiType: mbtiById.get(partnerId) ?? null,
      });
    }

    return result;
  }

  /** 每个会话的最后一条消息（一次 `in` 查询 + 内存归组，避免 N+1） */
  private async loadLastMessages(
    conversationIds: readonly string[],
  ): Promise<Map<string, ConversationListItemView['lastMessage']>> {
    const result = new Map<string, ConversationListItemView['lastMessage']>();
    if (conversationIds.length === 0) return result;

    const rows = await this.prisma.aiMessage.findMany({
      where: { conversationId: { in: [...conversationIds] }, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, conversationId: true, role: true, content: true, createdAt: true },
    });

    for (const row of rows) {
      if (result.has(row.conversationId)) continue;

      result.set(row.conversationId, {
        messageId: row.id,
        role: row.role,
        preview: buildPreview(row.content),
        createdAt: row.createdAt.toISOString(),
      });
    }

    return result;
  }

  /** 每个会话的角色计数（一次 `groupBy`，避免逐条会话各查两次） */
  private async loadRoleCounts(
    conversationIds: readonly string[],
  ): Promise<Map<string, { user: number; assistant: number }>> {
    const result = new Map<string, { user: number; assistant: number }>();
    if (conversationIds.length === 0) return result;

    const rows = await this.prisma.aiMessage.groupBy({
      by: ['conversationId', 'role'],
      where: { conversationId: { in: [...conversationIds] }, deletedAt: null },
      _count: { _all: true },
    });

    for (const row of rows) {
      const current = result.get(row.conversationId) ?? { user: 0, assistant: 0 };
      if (row.role === 'USER') current.user = row._count._all;
      if (row.role === 'ASSISTANT') current.assistant = row._count._all;
      result.set(row.conversationId, current);
    }

    return result;
  }

  /**
   * `contextHints` → 摘要片段（契约 §3.7.5：是否额外注入最近报告/测试摘要）
   *
   * 只取**已成功**的报告：生成中的报告没有正文，注入一段空内容会让模型以为
   * "用户没有报告"。摘要长度各截 400 字 —— 它们是"补充上下文"，
   * 不应挤占 `Recent > Persona > Memory` 的预算（契约规则 2 的优先级里没有它们）。
   */
  private async loadHintSnippets(
    userId: string,
    hints: readonly ContextHint[],
    relationshipId: string | null,
  ): Promise<ContextHintSnippet[]> {
    const snippets: ContextHintSnippet[] = [];

    if (hints.includes('RECENT_REPORT')) {
      const report = await this.prisma.aiReport.findFirst({
        where: { userId, status: 'SUCCEEDED', deletedAt: null, type: { in: ['MBTI_REPORT', 'BIG_FIVE_REPORT'] } },
        orderBy: { createdAt: 'desc' },
        select: { type: true, title: true, summary: true },
      });

      if (report !== null) {
        snippets.push({
          label: `最近的${report.type === 'MBTI_REPORT' ? '人格深度' : '大五特质'}报告摘要`,
          text: `${report.title ?? ''}\n${report.summary ?? ''}`.trim().slice(0, HINT_TEXT_LIMIT),
        });
      }
    }

    if (hints.includes('RECENT_TEST')) {
      const session = await this.prisma.testSession.findFirst({
        where: { userId, deletedAt: null, status: { in: ['SCORED', 'REPORT_READY'] } },
        orderBy: { createdAt: 'desc' },
        select: {
          definitionCode: true,
          answeredCount: true,
          questionCount: true,
          consistencyScore: true,
          createdAt: true,
        },
      });

      if (session !== null) {
        snippets.push({
          label: '最近一次测评',
          text: [
            `量表：${session.definitionCode}`,
            `完成题数：${session.answeredCount}/${session.questionCount}`,
            // `test_sessions` 里没有"总分"列（分数落在 `test_results`），
            // 一致性分数是会话侧唯一可用的质量指标，如实给出而不是编一个分数
            session.consistencyScore === null ? null : `作答一致性：${Math.round(session.consistencyScore)}`,
            `时间：${session.createdAt.toISOString()}`,
          ]
            .filter((line): line is string => line !== null)
            .join('；'),
        });
      }
    }

    if (hints.includes('RELATIONSHIP_REPORT') && relationshipId !== null) {
      const report = await this.prisma.aiReport.findFirst({
        where: { userId, relationshipId, type: 'RELATIONSHIP_REPORT', status: 'SUCCEEDED', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { title: true, summary: true },
      });

      if (report !== null) {
        snippets.push({
          label: '最近的关系匹配解读摘要',
          text: `${report.title ?? ''}\n${report.summary ?? ''}`.trim().slice(0, HINT_TEXT_LIMIT),
        });
      }
    }

    return snippets;
  }

  /** 关系归属校验（`relationshipId` 不属于当前用户 → `50023` → 本项目 `RELATIONSHIP_NOT_OWNED`） */
  private async requireOwnedRelationship(userId: string, relationshipId: string): Promise<void> {
    const relationship = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, deletedAt: null, OR: [{ userAId: userId }, { userBId: userId }] },
      select: { id: true, status: true },
    });

    if (relationship === null) {
      throw BusinessException.forbidden(ErrorCode.RELATIONSHIP_NOT_OWNED);
    }

    if (relationship.status !== 'ACTIVE') {
      throw new BusinessException(ErrorCode.RELATIONSHIP_STATUS_INVALID, '该关系尚未生效或已解除，无法绑定会话');
    }
  }
}

/** `contextHints` 摘要的单块长度上限（字符） */
const HINT_TEXT_LIMIT = 400;

/** 会话行投影 */
const CONVERSATION_SELECT = {
  id: true,
  title: true,
  scene: true,
  status: true,
  messageCount: true,
  totalTokens: true,
  totalCostAmount: true,
  lastMessageAt: true,
  createdAt: true,
  relationshipId: true,
} as const;

/** 消息行投影 */
const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  role: true,
  content: true,
  contentLength: true,
  provider: true,
  model: true,
  promptTokens: true,
  completionTokens: true,
  totalTokens: true,
  latencyMs: true,
  finishReason: true,
  safetyStatus: true,
  safetyLabels: true,
  createdAt: true,
} as const;

/**
 * 行 → 消息视图
 *
 * 两个字段是**推导**出来的，而不是直接落库的：
 *   · `contentFormat`：`ASSISTANT` 的回复是 Markdown（模板要求分段/加粗），
 *     用户输入是纯文本。契约把 `PLAIN` 给了用户消息、`MARKDOWN` 给了 AI 回复，
 *     这与"用户输入原样保存"的要求一致 —— 前端按纯文本渲染用户消息，
 *     就不会把用户打的 `**` 当成加粗。
 *   · `isStreamed`：schema 没有该列（见简报），而契约把它作为消息字段返回。
 *     这里用"是否为 AI 回复且**真的调用过模型**"来推导：只有真实模型调用才有
 *     `provider`；安全关怀响应两者皆为 `null`/`0`，因此被正确判为 `false`。
 *     ⚠ 无法区分"流式"与"非流式"两种 AI 回复 —— 这是 schema 缺列导致的，
 *     已在简报「缺失的表/列」中标注。
 */
export const toMessageView = (row: {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  provider: string | null;
  model: string | null;
  totalTokens: number;
  latencyMs: number | null;
  finishReason: string | null;
  safetyStatus: string;
  createdAt: Date;
}): MessageView => ({
  messageId: row.id,
  conversationId: row.conversationId,
  role: row.role,
  content: row.content,
  contentFormat: row.role === 'ASSISTANT' ? 'MARKDOWN' : 'PLAIN',
  tokens: row.totalTokens,
  provider: row.provider,
  model: row.model,
  latencyMs: row.latencyMs,
  finishReason: row.finishReason,
  // 用 `provider !== null` 而不是 `latencyMs !== null`：安全关怀响应会把
  // `latencyMs` 落成 `0`（契约要求计量全 0），而 `0 !== null` 为真 ——
  // 那会把"没调用模型"的回复误判成流式输出
  isStreamed: row.role === 'ASSISTANT' && row.provider !== null,
  isSafetyResponse: row.safetyStatus === 'BLOCKED',
  createdAt: row.createdAt.toISOString(),
});

/**
 * 生成列表预览文本（契约 §3.7.2 规则 2：截取 60 字，**不做 Markdown 渲染**）
 *
 * 换行统一压成空格：预览是一行文本，保留 `\n` 会让列表项高度不可控。
 * 不剥离 Markdown 记号（`**`、`#`）是刻意的 —— 契约只说"不做渲染"，
 * 而剥离记号需要引入解析器，那比"让它显示成纯文本 `**加粗**`"更复杂也更易错。
 */
export const buildPreview = (content: string): string => {
  const flat = content.replace(/\s+/g, ' ').trim();

  return flat.length <= PREVIEW_SOURCE_LIMIT ? flat : `${flat.slice(0, PREVIEW_SOURCE_LIMIT)}…`;
};

/**
 * 会话标题自动生成（契约 §3.7.1 规则 6：取首条消息前 20 字）
 *
 * 单独导出以便单测：标题是**服务端生成的非用户自由文本**，契约据此认定它在
 * 列表搜索里"无注入风险"—— 因此它的生成规则必须稳定且可验证。
 * 去掉换行与多余空白，避免标题里出现多行把列表项撑开。
 */
export const buildAutoTitle = (firstMessage: string): string => {
  const flat = firstMessage.replace(/\s+/g, ' ').trim();

  return flat.length <= AUTO_TITLE_LENGTH ? flat : `${flat.slice(0, AUTO_TITLE_LENGTH)}…`;
};
