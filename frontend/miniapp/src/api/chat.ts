/**
 * AI 情感助手接口
 *
 * 两种回复模式（架构文档 §10）：
 *   1. SSE 流式（推荐，逐字输出体验好）：POST /ai/conversations/{id}/stream
 *      小程序端 uni.request 不支持 SSE，需用 enableChunked: true + onChunkReceived 接收分块，
 *      详见 src/utils/sse.ts（Phase 5 实现）。
 *   2. 非流式（兜底，网络差或基础库过低时使用）：POST /ai/conversations/{id}/messages
 *
 * 合规约束：危险内容（自伤/他伤/医疗诊断）由服务端预筛，返回固定关怀文案，
 *           前端必须原样展示并引导至专业资源，禁止自行改写。
 */

import { http, httpPage } from './request';
import type { PaginatedData } from './types';

/** 会话 */
export interface Conversation {
  id: string;
  title: string;
  /** 绑定的关系（个人咨询为空） */
  relationshipId: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

/** 消息角色 */
export type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM';

/** 消息 */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** AI 消息的元信息（诊断与成本追踪用，前端可展示模型与耗时） */
  meta?: {
    provider: string;
    model: string;
    totalTokens: number;
    latencyMs: number;
  };
  createdAt: string;
}

/** 配额信息 */
export interface AiQuota {
  /** 是否会员 */
  isMember: boolean;
  /** 会员到期时间 */
  membershipExpiresAt: string | null;
  /** 剩余可用次数（免费用户为总剩余；会员为今日剩余） */
  remaining: number;
  /** 每日/总上限 */
  limit: number;
  /** 重置时间（会员每日配额） */
  resetAt: string | null;
}

/** 创建会话 */
export const createConversation = (payload: { relationshipId?: string; title?: string } = {}): Promise<Conversation> =>
  http.post<Conversation>('/ai/conversations', payload);

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

/** 非流式发送消息（兜底方案） */
export const sendMessage = (conversationId: string, content: string): Promise<ChatMessage> =>
  http.post<ChatMessage>(
    `/ai/conversations/${conversationId}/messages`,
    { content },
    { timeout: 90_000, idempotencyKey: undefined },
  );

/** 删除会话 */
export const deleteConversation = (id: string): Promise<void> => http.delete<void>(`/ai/conversations/${id}`);

/** 查询配额 */
export const getQuota = (): Promise<AiQuota> => http.get<AiQuota>('/ai/quota', undefined, { showError: false });
