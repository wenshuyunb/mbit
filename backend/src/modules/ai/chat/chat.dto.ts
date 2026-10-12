/**
 * AI 助手 DTO（契约 §3.7）
 *
 * 契约来源：docs/API_DESIGN.md §3.7.1–§3.7.8。
 *
 * ## 枚举与「逗号分隔多值」的处理
 *
 * 与 `report.dto.ts` 同一套做法：用 `@Transform(splitCommaSeparated)` 把
 * `'COMPANION,PRACTICE'` 拆成数组再 `@IsIn(..., { each: true })`。全局
 * `ValidationPipe` 开了 `enableImplicitConversion`，不先拆就会拿整个字符串
 * 去比对枚举 → 误判为非法值。
 *
 * ## 为什么错误码要"按契约的触发条件"而不是照抄契约数字
 *
 * 契约里的错误码（如 `10001` 参数非法、`10011` 缺幂等键）与本项目 `error-code.ts`
 * 的编号**并不一一对应**（见简报"契约模糊/矛盾处"）。DTO 只负责**触发条件**：
 * 参数不合法 → `PARAM_INVALID`；缺幂等键 → `IDEMPOTENCY_KEY_MISSING`（由
 * `@IdempotencyKey()` 装饰器统一产出）。这样前端拿到的码永远与
 * `error-code.ts` 自洽。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  CONTEXT_HINTS,
  CONVERSATION_MODES,
  CONVERSATION_SORT_FIELDS,
  CONVERSATION_STATUSES,
  DELETE_MODES,
  MAX_CONTEXT_HINTS,
  MAX_TITLE_LENGTH,
  MESSAGE_ROLES,
  SORT_ORDERS,
  type ContextHint,
  type ConversationMode,
  type ConversationSortField,
  type ConversationStatus,
  type ConversationTone,
  type DeleteMode,
  type MessageRole,
  type SortOrder,
} from './chat.types';

/** 分页上限（契约 §3.7.2 / §3.7.4：`pageSize ≤ 100`） */
export const MAX_CHAT_PAGE_SIZE = 100;

/** 默认分页大小 */
export const DEFAULT_CHAT_PAGE_SIZE = 20;

/** 逗号分隔多值 → 数组（与 `report.dto.ts` 的 `splitCommaSeparated` 同语义） */
const splitCommaSeparated = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
};

/** `'true'` / `'false'` → 布尔（查询串里布尔值是字符串） */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;

  return value;
};

// ============================================================================
// §3.7.1 POST /ai/conversations
// ============================================================================

export class CreateConversationDto {
  @ApiPropertyOptional({
    description: '会话标题；**不传时由首条消息自动生成摘要标题**（取前 20 字）',
    example: '和男友的沟通问题',
    maxLength: MAX_TITLE_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'title 必须是字符串' })
  @Length(0, MAX_TITLE_LENGTH, { message: `title 长度不能超过 ${MAX_TITLE_LENGTH} 个字符` })
  title?: string;

  @ApiPropertyOptional({
    description: '绑定关系（注入双方画像）。必须属于当前用户且 `status = ACTIVE`',
    example: '0195f3a2-d46a-7ca8-8d13-9fca6d7e8b67',
  })
  @IsOptional()
  @IsUUID('all', { message: 'relationshipId 必须是合法的 UUID' })
  relationshipId?: string;

  @ApiPropertyOptional({
    enum: CONVERSATION_MODES,
    description: [
      '会话模式（影响 System Prompt 的模板键）：',
      '· `COMPANION` 情感陪伴（默认）',
      '· `ANALYSIS` 关系分析',
      '· `PRACTICE` 沟通练习',
    ].join('\n'),
    example: 'COMPANION',
    default: 'COMPANION',
  })
  @IsOptional()
  @IsIn(CONVERSATION_MODES, { message: 'mode 取值不合法' })
  mode?: ConversationMode;

  @ApiPropertyOptional({
    enum: ['WARM', 'NEUTRAL', 'DIRECT'],
    description: '回复语气：`WARM`（默认）| `NEUTRAL` | `DIRECT`',
    example: 'WARM',
    default: 'WARM',
  })
  @IsOptional()
  @IsIn(['WARM', 'NEUTRAL', 'DIRECT'], { message: 'tone 取值不合法' })
  tone?: ConversationTone;

  @ApiPropertyOptional({
    description: '是否注入人格画像；`false` 时助手是更中立的倾听者',
    example: true,
    default: true,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'includePersona 必须是布尔值' })
  includePersona?: boolean;
}

// ============================================================================
// §3.7.2 GET /ai/conversations
// ============================================================================

export class ListConversationsQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @Min(1, { message: 'page 不得小于 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，最大 ${MAX_CHAT_PAGE_SIZE}`,
    example: DEFAULT_CHAT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_CHAT_PAGE_SIZE,
    default: DEFAULT_CHAT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1, { message: 'pageSize 不得小于 1' })
  @Max(MAX_CHAT_PAGE_SIZE, { message: `pageSize 不得超过 ${MAX_CHAT_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({
    enum: CONVERSATION_STATUSES,
    isArray: true,
    description: '状态筛选，逗号分隔；默认 `ACTIVE`',
    example: 'ACTIVE',
    default: 'ACTIVE',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(CONVERSATION_STATUSES, { each: true, message: 'status 含非法枚举值' })
  status?: ConversationStatus[];

  @ApiPropertyOptional({
    description: '按绑定关系筛选（必须属于当前用户，否则 `RELATIONSHIP_NOT_OWNED`）',
    example: '0195f3a2-d46a-7ca8-8d13-9fca6d7e8b67',
  })
  @IsOptional()
  @IsUUID('all', { message: 'relationshipId 必须是合法的 UUID' })
  relationshipId?: string;

  @ApiPropertyOptional({
    enum: CONVERSATION_MODES,
    isArray: true,
    description: '按模式筛选，逗号分隔',
    example: 'COMPANION',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(CONVERSATION_MODES, { each: true, message: 'mode 含非法枚举值' })
  mode?: ConversationMode[];

  @ApiPropertyOptional({
    description: '按标题模糊搜索（标题为服务端生成，非用户自由文本）',
    example: '沟通',
    maxLength: 50,
  })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @Length(1, 50, { message: 'keyword 长度不能超过 50 个字符' })
  keyword?: string;

  @ApiPropertyOptional({
    enum: CONVERSATION_SORT_FIELDS,
    description: '排序字段（白名单）',
    example: 'lastMessageAt',
    default: 'lastMessageAt',
  })
  @IsOptional()
  @IsIn(CONVERSATION_SORT_FIELDS, { message: 'sortBy 不在允许的排序字段内' })
  sortBy?: ConversationSortField;

  @ApiPropertyOptional({
    enum: SORT_ORDERS,
    description: '排序方向',
    example: 'desc',
    default: 'desc',
  })
  @IsOptional()
  @IsIn(SORT_ORDERS, { message: 'order 必须是 asc 或 desc' })
  order?: SortOrder;
}

// ============================================================================
// §3.7.3 / §3.7.4 / §3.7.6 / §3.7.7 路径参数
// ============================================================================

export class ConversationIdParamDto {
  @ApiProperty({ description: '会话 ID（UUID）', example: '0195f3a2-c35f-7b97-9c02-8ebf5c6d7a56' })
  @IsUUID('all', { message: '会话 ID 必须是合法的 UUID' })
  conversationId!: string;
}

// ============================================================================
// §3.7.4 GET /ai/conversations/{id}/messages
// ============================================================================

export class ListMessagesQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始（与 `before` 二选一，`before` 优先）', example: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @Min(1, { message: 'page 不得小于 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，最大 ${MAX_CHAT_PAGE_SIZE}`,
    example: DEFAULT_CHAT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_CHAT_PAGE_SIZE,
    default: DEFAULT_CHAT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1, { message: 'pageSize 不得小于 1' })
  @Max(MAX_CHAT_PAGE_SIZE, { message: `pageSize 不得超过 ${MAX_CHAT_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({
    description: '游标：仅返回该时间之前的消息（ISO 8601）。**优先于 `page`**，用于上拉加载更早消息',
    example: '2026-02-14T16:05:12.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'before 必须是合法的 ISO 8601 时间' })
  before?: string;

  @ApiPropertyOptional({
    enum: MESSAGE_ROLES,
    description: '按角色筛选',
    example: 'ASSISTANT',
  })
  @IsOptional()
  @IsIn(MESSAGE_ROLES, { message: 'role 取值不合法' })
  role?: MessageRole;

  @ApiPropertyOptional({
    enum: SORT_ORDERS,
    description: '排序方向（默认倒序，最新在前）',
    example: 'desc',
    default: 'desc',
  })
  @IsOptional()
  @IsIn(SORT_ORDERS, { message: 'order 必须是 asc 或 desc' })
  order?: SortOrder;
}

// ============================================================================
// §3.7.5 POST /ai/conversations/{id}/messages
// ============================================================================

export class SendMessageDto {
  @ApiProperty({
    description: '用户消息内容（1–2000 字符，trim 后非空）',
    example: '他昨天又说我想太多，我一句话都不想说了。',
    minLength: 1,
    maxLength: 2000,
  })
  @IsString({ message: 'content 必须是字符串' })
  @Length(1, 2000, { message: 'content 长度必须在 1–2000 个字符之间' })
  content!: string;

  @ApiPropertyOptional({
    enum: ['TEXT'],
    description: '内容类型（预留扩展，当前仅支持 `TEXT`）',
    example: 'TEXT',
    default: 'TEXT',
  })
  @IsOptional()
  @IsIn(['TEXT'], { message: 'contentType 取值不合法' })
  contentType?: 'TEXT';

  @ApiPropertyOptional({
    description: '客户端本地消息 ID（8–64 字符，用于去重与乐观 UI 对账）',
    example: 'cli_msg_a71f3c9e2b04',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'clientMessageId 必须是字符串' })
  @Length(8, 64, { message: 'clientMessageId 长度必须在 8–64 个字符之间' })
  clientMessageId?: string;

  @ApiPropertyOptional({
    enum: CONTEXT_HINTS,
    isArray: true,
    description: `额外注入的上下文提示，最多 ${MAX_CONTEXT_HINTS} 个`,
    example: ['RECENT_REPORT'],
  })
  @IsOptional()
  @IsArray({ message: 'contextHints 必须是数组' })
  @ArrayMaxSize(MAX_CONTEXT_HINTS, { message: `contextHints 最多 ${MAX_CONTEXT_HINTS} 个` })
  @IsIn(CONTEXT_HINTS, { each: true, message: 'contextHints 含非法枚举值' })
  contextHints?: ContextHint[];
}

// ============================================================================
// §3.7.6 GET /ai/conversations/{id}/stream
// ============================================================================

/**
 * 流式对话的 Query 参数
 *
 * ⚠ `message` 走 **Query 而非 Body**（契约 §3.7.6 的"方法选择说明"）：小程序端
 * SSE 依赖 `uni.request` 的 `enableChunked: true`，而 `EventSource` 不支持自定义
 * 请求头（无法带 `Authorization`）。代价是消息正文会进入网关/代理的访问日志 ——
 * 这一点已在简报中标注为需要 Nginx 层配合脱敏的事项。
 */
export class StreamQueryDto {
  @ApiProperty({
    description: '用户消息内容（1–2000 字符，**需 URL 编码**）',
    example: '他又说我想太多',
    minLength: 1,
    maxLength: 2000,
  })
  @IsString({ message: 'message 必须是字符串' })
  @Length(1, 2000, { message: 'message 长度必须在 1–2000 个字符之间' })
  message!: string;

  @ApiPropertyOptional({
    description: '消息级幂等键（16–64 字符），防重复计费',
    example: 'idem_msg_9c3f7a21b4e85d60',
    minLength: 16,
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'messageIdempotencyKey 必须是字符串' })
  @Length(16, 64, { message: 'messageIdempotencyKey 长度必须在 16–64 个字符之间' })
  messageIdempotencyKey?: string;

  @ApiPropertyOptional({
    description: '客户端消息 ID（8–64 字符，乐观 UI 对账）',
    example: 'cli_msg_a71f3c9e2b04',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'clientMessageId 必须是字符串' })
  @Length(8, 64, { message: 'clientMessageId 长度必须在 8–64 个字符之间' })
  clientMessageId?: string;

  @ApiPropertyOptional({
    description: '额外上下文提示，逗号分隔，最多 3 个',
    example: 'RECENT_REPORT',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @ArrayMaxSize(MAX_CONTEXT_HINTS, { message: `contextHints 最多 ${MAX_CONTEXT_HINTS} 个` })
  @IsIn(CONTEXT_HINTS, { each: true, message: 'contextHints 含非法枚举值' })
  contextHints?: ContextHint[];

  @ApiPropertyOptional({
    description: '心跳间隔（毫秒），5000–30000，默认 15000',
    example: 15000,
    minimum: 5000,
    maximum: 30000,
    default: 15000,
  })
  @IsOptional()
  @Type(() => Number)
  @Min(5000, { message: 'heartbeatMs 不得小于 5000' })
  @Max(30000, { message: 'heartbeatMs 不得超过 30000' })
  heartbeatMs?: number;
}

// ============================================================================
// §3.7.7 DELETE /ai/conversations/{id}
// ============================================================================

export class DeleteConversationQueryDto {
  @ApiPropertyOptional({
    enum: DELETE_MODES,
    description: '`DELETE`（默认，软删除）| `ARCHIVE`（归档，保留只读，可恢复）',
    example: 'DELETE',
    default: 'DELETE',
  })
  @IsOptional()
  @IsIn(DELETE_MODES, { message: 'mode 取值不合法' })
  mode?: DeleteMode;

  @ApiPropertyOptional({
    description: '⚠️ 是否同时清空消息正文（置为 `[已删除]`，**不可恢复**）',
    example: false,
    default: false,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'hardDelete 必须是布尔值' })
  hardDelete?: boolean;
}

// ============================================================================
// §3.7.8 GET /ai/quota
// ============================================================================

export class AiQuotaQueryDto {
  @ApiPropertyOptional({
    description: '是否返回近 7 天用量明细（按日聚合）',
    example: false,
    default: false,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'includeUsage 必须是布尔值' })
  includeUsage?: boolean;
}
