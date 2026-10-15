/**
 * AI 助手（"管家"）接口
 *
 * ## ADR-038 阶段 5：助手是**会员专属**，且读三个模块
 *
 * 与旧版的区别有两处，都属于契约变更而非实现细节：
 *
 *   1. **会员门槛**：助手不再是"免费用户有几次额度"的产品，
 *      而是会员权益。服务端在**建会话**与**发消息**两处都会拦，
 *      抛 `70016 ENTITLEMENT_REQUIRED`（不是配额码 `50006`）——
 *      两者必须分开处理：`50006` 的出路是"买次数包/等明天"，
 *      `70016` 的出路是"开通会员"，指错路等于把付费用户挡在门外。
 *      `GET /ai/quota` 不抛错，回 `assistantMembersOnly` + `nextActions.canChat`，
 *      前端靠它提前渲染会员引导，而不是等用户点了发送才发现用不了。
 *
 *   2. **`ALL_MODULES` 上下文**：助手可以一次读全三个模块的画像
 *      （人格 / 情感 / 心理状态），所以发消息时带 `contextHints: ['ALL_MODULES']`。
 *      ⚠ 它是**发消息**的参数，不是建会话的（`CreateConversationDto` 里没有这个字段，
 *      全局管道开着 `forbidNonWhitelisted`，传过去直接 `10001`）。
 *
 * ## 回复模式
 *
 *   · SSE 流式（体验好）：`POST /ai/conversations/{id}/stream`
 *     小程序端 `uni.request` 不支持 SSE，需 `enableChunked: true` + `onChunkReceived`，
 *     详见 `src/utils/sse.ts`。
 *   · 非流式（兜底，当前前端走这条）：`POST /ai/conversations/{id}/messages`
 *
 * 合规约束：危险内容（自伤/他伤/医疗诊断）由服务端预筛并返回固定关怀文案，
 * 前端必须原样展示并引导至专业资源，禁止自行改写。
 */

import { createIdempotencyKey } from '@/utils/request-id';

import { http, httpPage } from './request';
import type { PaginatedData } from './types';

/** 会话模式（影响 System Prompt 模板键） */
export type ConversationMode = 'COMPANION' | 'ANALYSIS' | 'PRACTICE';

/**
 * 上下文提示（契约 §3.7.5 + ADR-038 阶段 5）
 *
 * `ALL_MODULES` 是阶段 5 新增的：一次性注入三个模块的摘要。
 */
export type ChatContextHint = 'RECENT_REPORT' | 'RECENT_TEST' | 'RELATIONSHIP_REPORT' | 'ALL_MODULES';

/**
 * 默认上下文提示
 *
 * 管家定位就是"读得到我测过的所有东西"，因此默认就带 `ALL_MODULES`：
 * 让用户每轮都手动勾选"要读哪个模块"是错的，那是配置项而不是对话内容。
 */
export const DEFAULT_CONTEXT_HINTS: readonly ChatContextHint[] = ['ALL_MODULES'];

/** 消息角色 */
export type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM';

/**
 * 消息（契约 §3.7.4 `items[]`）
 *
 * ⚠ 主键字段名是 `messageId`（不是 `id`），且没有 `meta` 子对象 ——
 * 模型与耗时是平铺的 `provider`/`model`/`latencyMs`。
 * 旧版本这里写的是 `{ id, meta: { model, latencyMs } }`，与后端响应完全对不上，
 * 只是因为聊天页一直是占位实现才没暴露出来。
 */
export interface ChatMessage {
  messageId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  contentFormat: 'PLAIN' | 'MARKDOWN';
  tokens: number;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  finishReason: string | null;
  isStreamed: boolean;
  /** 是否为安全兜底文案（前端必须原样展示，不得改写） */
  isSafetyResponse: boolean;
  createdAt: string;
}

/** 会话列表项（契约 §3.7.2 `items[]`） */
export interface Conversation {
  conversationId: string;
  title: string;
  mode: ConversationMode;
  modeName: string;
  status: string;
  includePersona: boolean;
  relationship: { relationshipId: string; partnerNickname: string | null } | null;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  lastMessage: { messageId: string; role: string; preview: string; createdAt: string } | null;
  lastMessageAt: string | null;
  createdAt: string;
  totalTokens: number;
  estimatedCostCents: number;
}

/** 创建会话的结果（契约 §3.7.1；只声明前端用得到的字段） */
export interface ConversationCreated {
  conversationId: string;
  title: string;
  mode: ConversationMode;
  modeName: string;
  /** 实际注入画像的摘要（前端可据此提示"还没测过人格"） */
  personaInjected: {
    myProfile: { mbtiType: string; profileVersion: number | null } | null;
    partnerProfile: { mbtiType: string; profileVersion: number | null } | null;
    memorySummary: string | null;
    recentMessageCount: number;
  };
  model: string;
  systemNotice: string;
  disclaimer: string;
}

/** 一轮对话的结果（契约 §3.7.5；只声明前端用得到的字段） */
export interface ChatTurn {
  conversationId: string;
  /** 命中安全风险时为 `true`，此时 `assistantMessage` 是固定关怀文案 */
  blocked: boolean;
  blockedReason: string | null;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  quota: {
    consumed: number;
    remainingToday: number;
    dailyLimit: number;
    creditBalance: number;
    resetAt: string;
    exhausted: boolean;
  };
  /** 本轮实际注入了哪些上下文（用于"助手读了三个模块"的可观测性） */
  contextUsed: {
    myPersonaInjected: boolean;
    partnerPersonaInjected: boolean;
    memorySummaryInjected: boolean;
    reportContextInjected: boolean;
  };
}

/** 会员权益（`/ai/quota` 的 `plan.benefits`） */
export interface AiPlanBenefits {
  aiDailyLimit: number;
  unlimitedReports: boolean;
  reportRegenerateDailyLimit: number;
  pdfExportUnlimited: boolean;
  compatibilityReportIncluded: boolean;
}

/** 配额视图（契约 §3.7.8 `data.quota`） */
export interface AiQuotaView {
  hasQuota: boolean;
  /** 当前限制来源：`DAILY_LIMIT` | `FREE_QUOTA` | `AI_CREDITS` | `NONE` */
  limitedBy: string;
  remainingToday: number;
  dailyLimit: number;
  usedToday: number;
  resetAt: string;
  creditBalance: number;
  freeQuota: { totalLimit: number; used: number; remaining: number; exhausted: boolean };
}

/**
 * `/ai/quota` 响应（契约 §3.7.8 `data`）
 *
 * 这里只声明前端要用的字段：完整契约还有 `usage` / `limits` / `serverTime`。
 */
export interface AiQuota {
  plan: {
    type: string;
    planCode: string | null;
    planName: string | null;
    isActive: boolean;
    expiresAt: string | null;
    remainingDays: number | null;
    benefits: AiPlanBenefits;
  };
  quota: AiQuotaView;
  /** 没有任何可用额度（或被门槛拦住） */
  exhausted: boolean;
  nextActions: {
    canChat: boolean;
    upgradeUrl: string;
    creditsUrl: string;
    /** `MEMBERSHIP_REQUIRED`（会员门槛）/ `QUOTA_EXHAUSTED` / `null` */
    reason: string | null;
  };
  /**
   * AI 助手是否为会员专属（配置项 `ai.assistantMembersOnly`，默认 `true`）
   *
   * `true` 且 `nextActions.canChat === false` 时展示**会员引导**，
   * 绝不要展示"剩余 N 次"——后者会让人以为再等等就能用。
   */
  assistantMembersOnly: boolean;
}

/**
 * 创建会话
 *
 * ⚠ 必须带幂等键：`POST /ai/conversations` 的 `@IdempotencyKey()` 默认必填
 * （缺失直接 `10001 IDEMPOTENCY_KEY_MISSING`）。旧版本这里依赖请求层自动生成，
 * 而请求层只在显式传入时才写这个头 —— 即"点一次新建会话必然 400"。
 */
export const createConversation = (
  payload: { relationshipId?: string; title?: string; mode?: ConversationMode } = {},
): Promise<ConversationCreated> =>
  http.post<ConversationCreated>('/ai/conversations', payload, {
    timeout: 30_000,
    idempotencyKey: createIdempotencyKey(),
  });

/** 会话列表 */
export const listConversations = (
  query: { page?: number; pageSize?: number } = {},
): Promise<PaginatedData<Conversation>> => httpPage('/ai/conversations', query);

/** 会话详情 */
export const getConversation = (id: string): Promise<Conversation> => http.get<Conversation>(`/ai/conversations/${id}`);

/** 历史消息（分页，从新到旧） */
export const listMessages = (
  conversationId: string,
  query: { page?: number; pageSize?: number } = {},
): Promise<PaginatedData<ChatMessage>> => httpPage(`/ai/conversations/${conversationId}/messages`, query);

/**
 * 非流式发送消息（当前前端走这条；流式见文件头）
 *
 * `contextHints` 默认 `['ALL_MODULES']` —— 见 `DEFAULT_CONTEXT_HINTS` 的说明。
 *
 * ⚠ 幂等键语义：**同一条消息重试要复用同一个 key**（否则重试会真的多发一条，
 * 既扣额度又会得到两条不同回复）。因此由调用方在"用户点发送时"生成一次并传入，
 * 重试沿用；不传时按新消息处理，自动生成。
 */
export const sendMessage = (
  conversationId: string,
  content: string,
  options: { contextHints?: readonly ChatContextHint[]; idempotencyKey?: string } = {},
): Promise<ChatTurn> =>
  http.post<ChatTurn>(
    `/ai/conversations/${conversationId}/messages`,
    { content, contextHints: options.contextHints ?? DEFAULT_CONTEXT_HINTS },
    { timeout: 90_000, idempotencyKey: options.idempotencyKey ?? createIdempotencyKey() },
  );

/** 删除会话 */
export const deleteConversation = (id: string): Promise<void> => http.delete<void>(`/ai/conversations/${id}`);

/** 查询配额（会员门槛也从这里读，失败不弹全局 toast） */
export const getQuota = (): Promise<AiQuota> => http.get<AiQuota>('/ai/quota', undefined, { showError: false });
