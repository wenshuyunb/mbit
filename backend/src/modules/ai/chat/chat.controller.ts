/**
 * AI 情感助手控制器（契约 §3.7，8 个接口）
 *
 * 分层约定（架构 §6.1 P2）：Controller 只做参数校验、调用 Service、组装响应。
 * 本文件唯一"越界"的地方是 SSE 端点的响应写入 —— 那不是业务逻辑，而是
 * **传输层格式**，而契约 §3.7.6 对事件协议有逐字节要求（`event:` / `data:` 行、
 * `: ping` 心跳），这属于控制器职责。
 *
 * ## 全部接口都是 🔑（默认拒绝）
 *
 * 全局 `JwtAuthGuard` 是"默认拒绝、`@Public()` 白名单"模型（架构 §14.1），
 * 因此这里**不加任何** `@Public()`。
 *
 * ## 为什么 SSE 用手写 `text/event-stream` 而不是 `@Sse()`
 *
 * `@Sse()` 只能返回 `Observable<MessageEvent>`，无法控制：
 *   · 客户端断连的清理时机（名额释放、取消生成、写 `aborted` 用量日志）；
 *   · 心跳的精确格式（契约要求 `: ping` 注释行）；
 *   · 超时边界（首 token ≤ 20s / 总时长 ≤ 180s 到期必须发 `error` 再关闭）。
 * 手写 `res` 让这些都在一处可见，代价是必须自己处理"响应头已发出后不能再发 JSON"，
 * 因此所有**流建立后**的失败都走 `error` 事件（契约 §3.7.6 明确区分了两张错误码表）。
 */

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { CurrentUser, IdempotencyKey, RawResponse } from '../../../common/decorators';
import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { RequestWithContext } from '../../../common/types/request.type';
import {
  AiQuotaQueryDto,
  ConversationIdParamDto,
  CreateConversationDto,
  DeleteConversationQueryDto,
  ListConversationsQueryDto,
  ListMessagesQueryDto,
  SendMessageDto,
  StreamQueryDto,
} from './chat.dto';
import { ChatConversationService, type AiQuotaView, type ConversationCreatedView } from './chat-conversation.service';
import {
  ChatContextService,
  type ConversationDetailView,
  type ConversationListView,
  type DeleteConversationView,
  type MessageListView,
} from './chat-context.service';
import { ChatMessageService, type ChatStreamEvent, type ChatTurnResult } from './chat-message.service';
import { ChatQuotaService } from './chat-quota.service';
import {
  DEFAULT_HEARTBEAT_MS,
  MAX_CONCURRENT_STREAMS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  STREAM_TOTAL_TIMEOUT_MS,
} from './chat-quota.util';

/** 无统一包络的原始响应（与 `AllExceptionsFilter` 的输出格式一致） */
interface RawEnvelope<T> {
  readonly code: number;
  readonly message: string;
  readonly data: T;
  readonly requestId: string;
  readonly timestamp: string;
}

/** 危险内容拦截的响应体（契约 §3.7.5「成功响应 200（危险内容拦截）」） */
interface SafetyInterventionResponse extends RawEnvelope<unknown> {
  readonly code: number;
  readonly message: string;
}

/** 控制器内复用：把业务结果包成原始响应 */
const envelope = <T>(data: T, requestId: string, code = 0, message = 'ok'): RawEnvelope<T> => ({
  code,
  message,
  data,
  requestId,
  timestamp: new Date().toISOString(),
});

@ApiTags('AI 助手')
@ApiBearerAuth('user-token')
@Controller('ai')
export class ChatController {
  constructor(
    private readonly conversations: ChatConversationService,
    private readonly context: ChatContextService,
    private readonly messages: ChatMessageService,
    private readonly quota: ChatQuotaService,
  ) {}

  // ==========================================================================
  // §3.7.1 创建对话会话
  // ==========================================================================

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { limit: 10, ttl: 86_400_000 } })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: '幂等键（8–64 位字母/数字/下划线/连字符）。缺失返回 `10009`',
  })
  @ApiOperation({
    summary: '创建对话会话',
    description: [
      '创建 AI 情感助手会话，可绑定某段关系（`relationshipId` 会注入双方人格画像）。',
      '',
      '**创建不消耗配额**：配额在**消息成功生成后**扣减（架构 15.5）。',
      '免费用户额度用尽时仍可创建空会话，只是在发消息时会被拦（错误码 `AI_QUOTA_EXCEEDED`）。',
      '',
      '**幂等**：同一 `X-Idempotency-Key` 重放返回首次响应，不会重复落库。',
      '',
      '**不创建空消息**：`title` 不传时由首条消息自动生成（取前 20 字）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '创建成功（含 `personaInjected` 上下文摘要与 `systemNotice`）' })
  @ApiResponse({ description: '`mode`/`tone` 非枚举、`title` 超长（`10001`）', status: 400 })
  @ApiResponse({ description: '缺少 `X-Idempotency-Key`（`10009`）或相同请求正在处理中（`10003`）', status: 400 })
  @ApiResponse({ description: '`relationshipId` 不属于当前用户（`RELATIONSHIP_NOT_OWNED`）', status: 403 })
  @ApiResponse({ description: 'AI 功能开关关闭（`90001`）', status: 403 })
  @ApiResponse({ description: '指定关系非 `ACTIVE`（`RELATIONSHIP_STATUS_INVALID`）', status: 409 })
  @ApiResponse({ description: '24h 内创建超过 10 次（`10007`）', status: 429 })
  @ApiResponse({ description: 'Prompt 模板尚未配置时仍会创建会话，响应中 `promptVersion` 为 `null`', status: 201 })
  async createConversation(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateConversationDto,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<ConversationCreatedView> {
    return this.conversations.createConversation({
      userId,
      idempotencyKey,
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.relationshipId !== undefined ? { relationshipId: dto.relationshipId } : {}),
      ...(dto.mode !== undefined ? { mode: dto.mode } : {}),
      ...(dto.tone !== undefined ? { tone: dto.tone } : {}),
      ...(dto.includePersona !== undefined ? { includePersona: dto.includePersona } : {}),
    });
  }

  // ==========================================================================
  // §3.7.2 会话列表
  // ==========================================================================

  @Get('conversations')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '会话列表',
    description: [
      '分页返回当前用户的 AI 会话，含最近消息摘要、绑定关系与用量。',
      '',
      '**`lastMessage.preview` 截取 60 字且不做 Markdown 渲染**（防注入，前端按纯文本展示）。',
      '**不返回消息正文列表**（走 `/conversations/{id}/messages`），避免响应过大。',
      '',
      '`summary` 的统计口径是**该用户全部会话**，不随筛选与翻页变化。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（`items` + `total` + `hasNext` + `summary` + `quota`）' })
  @ApiResponse({
    description: '枚举非法（`10001`）、`sortBy` 越界（`10004`）、`pageSize > 100`（`10005`）',
    status: 400,
  })
  @ApiResponse({ description: '`relationshipId` 不属于当前用户（`RELATIONSHIP_NOT_OWNED`）', status: 403 })
  async listConversations(
    @CurrentUser('userId') userId: string,
    @Query() query: ListConversationsQueryDto,
  ): Promise<ConversationListView> {
    return this.context.listConversations({
      userId,
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.relationshipId !== undefined ? { relationshipId: query.relationshipId } : {}),
      ...(query.mode !== undefined ? { mode: query.mode } : {}),
      ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
      ...(query.sortBy !== undefined ? { sortBy: query.sortBy } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
    });
  }

  // ==========================================================================
  // §3.7.8 查询 AI 配额与会员状态
  // ==========================================================================

  /**
   * ⚠ 路由顺序：`quota` 必须注册在 `conversations/:conversationId` **之前**
   *
   * NestJS 按声明顺序匹配路由，而 `:conversationId` 会吞掉任意一段路径。
   * 本控制器里 `quota` 与 `conversations/...` 前缀不同，实际不会冲突；
   * 把它放在这里只是为了让 8 个接口在文件里的顺序与契约一致（§3.7.1→§3.7.8）。
   */
  @Get('quota')
  @Throttle({ global: { limit: 240, ttl: 60_000 } })
  @ApiOperation({
    summary: '查询 AI 配额与会员状态',
    description: [
      '返回当前用户的 AI 剩余配额、会员状态与消耗明细摘要。',
      '',
      '**配额优先级**（架构 10.5 / 13.1）：`MEMBERSHIP_ACTIVE`（每日 N 次）→ `AI_CREDITS`（次数包，计数递减）→ 免费总额度（M 次）。',
      '`quota.limitedBy` 标识当前生效的限制来源：`DAILY_LIMIT` | `CREDITS` | `FREE_QUOTA` | `NONE`。',
      '',
      '**计数器存储**：Redis（`sm:ai:quota:{userId}:{yyyyMMdd}`，原子 Lua 脚本扣减）',
      '+ DB 兜底（`ai_usage_logs` 日聚合，Redis 丢失时以 DB 为准重建）。',
      '',
      '**时区**：每日配额按 **UTC+8** 自然日重置（`resetAt` 为对应的 UTC 时间戳）。',
      '',
      '`limits` 为**静态契约回显**，便于前端预校验；真实阈值以服务端为准。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（含 `plan` / `quota` / `usage` / `limits` / `nextActions`）' })
  @ApiResponse({ description: '`includeUsage` 非布尔（`10001`）', status: 400 })
  @ApiResponse({ description: '未登录（`20000`）或 AT 过期（`20001`）', status: 401 })
  async getQuota(@CurrentUser('userId') userId: string, @Query() query: AiQuotaQueryDto): Promise<AiQuotaView> {
    return this.conversations.getQuota(userId, query.includeUsage ?? false);
  }

  // ==========================================================================
  // §3.7.3 会话详情
  // ==========================================================================

  @Get('conversations/:conversationId')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '会话详情（含上下文装配摘要）',
    description: [
      '返回会话元数据与**上下文装配摘要**（注入了哪些画像与记忆），不返回消息列表。',
      '',
      '**`context.tokenBudget` 透明化**：便于排障「为什么 AI 不记得我之前说的」——',
      '看 `memorySummary` 是否被裁剪即可。',
      '',
      '`context.missingPersona` 说明缺失的画像：`MY_PROFILE_MISSING` / `PARTNER_PROFILE_MISSING` / `BOTH`。',
      '',
      '**归档会话仍返回 200**，只把 `permissions.canSendMessage` 置为 `false`（契约 `50005` 的实现说明）。',
      '',
      '🚫 **不返回 Prompt 全文**（防 Prompt 泄露与逆向，架构 R9），只给 key/version/参数。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  @ApiResponse({ description: '会话 ID 非合法 UUID（`10001`）', status: 400 })
  @ApiResponse({ description: '会话不存在或已物理清理（`AI_CONVERSATION_NOT_FOUND`）', status: 404 })
  @ApiResponse({ description: '会话属于其他用户（`AI_CONVERSATION_NOT_OWNED`，IDOR 防护）', status: 403 })
  async getConversation(
    @CurrentUser('userId') userId: string,
    @Param() params: ConversationIdParamDto,
  ): Promise<ConversationDetailView> {
    return this.conversations.getConversation(userId, params.conversationId);
  }

  // ==========================================================================
  // §3.7.4 消息历史
  // ==========================================================================

  @Get('conversations/:conversationId/messages')
  @Throttle({ global: { limit: 240, ttl: 60_000 } })
  @ApiOperation({
    summary: '消息历史（分页）',
    description: [
      '分页拉取消息历史（默认倒序，最新在前），支持上拉加载更早消息。',
      '',
      '**游标优先**：`before` 与 `page` 二选一，`before` 优先。内部按 `(createdAt, id)` 复合排序，',
      '避免深分页时 `OFFSET` 退化成全表扫描。`nextCursor` 传回即可续上。',
      '',
      '**消息完整性**：用户消息、AI 回复、安全关怀响应**全部落库**；',
      '`isSafetyResponse` 标记危险内容拦截的固定回复。',
      '',
      '**用户消息原样保存**（用户数据权利：导出与删除），但**日志中不打印正文**。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（`items` + `nextCursor` + `summary`）' })
  @ApiResponse({
    description: '会话 ID 非 UUID 或 `before` 非合法 ISO 时间（`10001`）；枚举非法；`pageSize > 100`',
    status: 400,
  })
  @ApiResponse({ description: '会话不存在（`AI_CONVERSATION_NOT_FOUND`）', status: 404 })
  @ApiResponse({ description: '会话属于其他用户（`AI_CONVERSATION_NOT_OWNED`）', status: 403 })
  async listMessages(
    @CurrentUser('userId') userId: string,
    @Param() params: ConversationIdParamDto,
    @Query() query: ListMessagesQueryDto,
  ): Promise<MessageListView> {
    return this.context.listMessages({
      userId,
      conversationId: params.conversationId,
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      ...(query.before !== undefined ? { before: query.before } : {}),
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
    });
  }

  // ==========================================================================
  // §3.7.5 发送消息（非流式）
  // ==========================================================================

  @Post('conversations/:conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: '幂等键（8–64 位）。同一键重放返回首次响应，**不重复扣配额、不重复落库**',
  })
  @ApiOperation({
    summary: '发送消息（非流式，返回完整回复）',
    description: [
      '发送用户消息，**同步**返回 AI 完整回复（适用于弱网、无需打字机效果的场景）。',
      '',
      '**⚠️ 危险内容拦截的特殊约定**：命中自伤/他伤/医疗诊断关键词预筛时**不调用模型**，',
      '返回 **HTTP 200 且 `code = 50008`**，`data.blocked = true`，并在 `data.resources` 给出转介资源。',
      '**前端必须按正常消息渲染关怀文案与资源卡，禁止弹出错误 Toast**（`uiHint` 字段会同步说明）。',
      '该路径 **不扣任何配额**（`quota.consumed = 0`），但两侧消息**都会落库**（合规留痕）。',
      '',
      '**配额扣减时机**：成功生成后扣减；失败（provider 失败 / 超时 / 输出审核未通过）**自动回补**。',
      '',
      '**幂等**：同一 `X-Idempotency-Key` 重放返回首次响应，避免重复调用导致重复扣配额。',
      '',
      '**Prompt 注入防护**：用户自由文本会被包裹进 `<user_data>…</user_data>` 定界符，',
      '并中和其中的定界符字符（架构 10.3 / 契约 §3.7.5 规则 6）。',
    ].join('\n'),
  })
  @ApiResponse({
    status: 201,
    description: '生成成功；**危险内容拦截时同样是 201 但 `code = 50008` 且 `data.blocked = true`**',
  })
  @ApiResponse({
    description: '`content` 缺失/为空/超 2000 字符（`10001`）；`contextHints` 非法（`10001`）',
    status: 400,
  })
  @ApiResponse({ description: '缺少 `X-Idempotency-Key`（`10009`）；相同请求处理中（`10003`）', status: 400 })
  @ApiResponse({ description: 'AI 配额不足（`AI_QUOTA_EXCEEDED`）', status: 402 })
  @ApiResponse({ description: '会话不属于当前用户（`AI_CONVERSATION_NOT_OWNED`）', status: 403 })
  @ApiResponse({ description: '会话不存在（`AI_CONVERSATION_NOT_FOUND`）', status: 404 })
  @ApiResponse({ description: '会话已归档（`AI_CONVERSATION_CLOSED`）；消息数已达上限 200（`10003`）', status: 409 })
  @ApiResponse({ description: '输出内容安全审核未通过（`AI_CONTENT_BLOCKED`，**回复不入库**）', status: 422 })
  @ApiResponse({ description: '输入内容安全未通过（`AI_CONTENT_BLOCKED`）；60s 内超过 10 次（`10007`）', status: 429 })
  @ApiResponse({
    description: '主备 Provider 均失败（`AI_PROVIDER_UNAVAILABLE`）/ 超时（`AI_PROVIDER_TIMEOUT`）',
    status: 502,
  })
  @ApiResponse({
    description: 'Prompt 模板不可用（`AI_PROMPT_TEMPLATE_NOT_FOUND`）或变量缺失（`AI_PROMPT_VARIABLE_MISSING`）',
    status: 500,
  })
  async sendMessage(
    @CurrentUser('userId') userId: string,
    @Param() params: ConversationIdParamDto,
    @Body() dto: SendMessageDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() request: RequestWithContext,
  ): Promise<RawEnvelope<ChatTurnResult> | SafetyInterventionResponse> {
    // 限流按 **userId**（契约 §3.7.5：单用户 60s 内 ≤ 10 次）
    await this.quota.enforceRateLimit(userId, 'message', RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS);

    const result = await this.messages.runTurn({
      userId,
      conversationId: params.conversationId,
      content: dto.content,
      clientMessageId: dto.clientMessageId ?? null,
      contextHints: dto.contextHints ?? [],
      idempotencyKey,
      streamed: false,
      requestId: request.requestId ?? 'unknown',
      request,
    });

    const requestId = request.requestId ?? 'unknown';

    if (!result.blocked) return envelope(result, requestId);

    /**
     * 危险内容拦截：**必须绕过统一包络**才能返回 `code = 50008`。
     *
     * 统一包络把 `code` 固定为 0（`TransformInterceptor`），而契约要求这里
     * `code = 50008` + HTTP 200。因此本方法返回带 `@Res()` 的原始响应 ——
     * 这与 `DocumentedRawResponse` 的取舍同理：契约优先于统一的便利性。
     *
     * `data` 的字段与控制器的 `envelope` 一致（`requestId` / `timestamp` 由框架层
     * 统一生成时也这样），此处手工补齐以保证前端只解析一种结构。
     */
    return {
      code: 50008,
      message: '听到了你的声音，这里有一些可以帮到你的方式',
      data: {
        ...result,
        uiHint: {
          showAsMessage: true,
          showResourceCard: true,
          showErrorToast: false,
          note: '⚠️ HTTP 200 且 code=50008：前端按正常消息渲染关怀文案与资源卡，禁止弹出错误 Toast',
        },
        aiGeneratedNotice: '本条回复由安全审核规则生成，非模型输出。',
      },
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // §3.7.6 流式对话（SSE）
  // ==========================================================================

  @Get('conversations/:conversationId/stream')
  @RawResponse()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @ApiQuery({ name: 'message', required: true, description: '用户消息内容（需 URL 编码）' })
  @ApiQuery({ name: 'messageIdempotencyKey', required: false, description: '消息级幂等键（16–64 字符）' })
  @ApiQuery({ name: 'clientMessageId', required: false, description: '客户端消息 ID（8–64 字符）' })
  @ApiQuery({ name: 'contextHints', required: false, description: '逗号分隔，最多 3 个' })
  @ApiQuery({ name: 'heartbeatMs', required: false, description: '心跳间隔（5000–30000，默认 15000）' })
  @ApiOperation({
    summary: '流式对话（SSE）',
    description: [
      '以 Server-Sent Events 逐字返回 AI 回复。事件类型：`start` / `delta` / `usage` / `done` / `error`。',
      '',
      '**⚠️ 方法选择说明**：用户消息通过 **Query 参数** `message` 传递（`GET` 语义），原因是小程序端',
      'SSE 依赖 `uni.request` 的 `enableChunked: true`（支持 query 与 header），而不支持在 `EventSource`',
      '上自定义请求头（Admin 端需用 `fetch` + `ReadableStream` 解析）。副作用由服务端幂等控制。',
      '',
      '**超时约束**：首 token ≤ 20s、总时长 ≤ 180s；超时发 `error` 后关闭连接。',
      '',
      '**危险内容拦截**：命中预筛时**不调用模型**，以一次全量 `delta` 下发固定关怀文案，',
      '随后正常发 `usage`（全 0）与 `done`（`quota.consumed = 0`、`safety.inputBlocked = true`），',
      '**不使用 `error`** —— 因为这不是错误，而是设计内的安全响应。',
      '',
      '**连接管理**：每用户最多 3 条并发 SSE（超出返回 `10007`）；断开后服务端停止写入并释放名额。',
      '',
      '**心跳**：默认 15s 一次 `: ping` 注释行，防网关 60s 空闲断开。',
      '',
      '🚫 **Nginx 必须配置** `proxy_buffering off` + `proxy_read_timeout 200s` + `X-Accel-Buffering: no`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: 'SSE 流（`Content-Type: text/event-stream`）' })
  @ApiResponse({ description: '`message` 缺失/为空/超长（`10001`）；`pageSize`/`contextHints` 非法', status: 400 })
  @ApiResponse({ description: 'AI 配额不足（`AI_QUOTA_EXCEEDED`）', status: 402 })
  @ApiResponse({
    description: '会话不存在（`AI_CONVERSATION_NOT_FOUND`）或不属于当前用户（`AI_CONVERSATION_NOT_OWNED`）',
    status: 404,
  })
  @ApiResponse({ description: '会话已归档（`AI_CONVERSATION_CLOSED`）；消息数已达上限（`10003`）', status: 409 })
  @ApiResponse({
    description: '输入内容安全未通过（`AI_CONTENT_BLOCKED`）；60s 内超过 10 次或并发流超过 3（`10007`）',
    status: 429,
  })
  async stream(
    @CurrentUser('userId') userId: string,
    @Param() params: ConversationIdParamDto,
    @Query() query: StreamQueryDto,
    @Req() request: Request,
    @Res() res: Response,
  ): Promise<void> {
    const requestId = (request as unknown as RequestWithContext).requestId ?? 'unknown';
    const userIdValue = userId;

    // 限流（userId 维度）+ 并发流名额
    await this.quota.enforceRateLimit(userIdValue, 'stream', RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS);
    const slot = await this.quota.acquireStreamSlot(userIdValue, MAX_CONCURRENT_STREAMS);

    if (!slot.acquired) {
      // 名额不足发生在**流建立之前**，因此走普通 JSON 错误包络（契约 §3.7.6 第一张错误码表）
      throw BusinessException.tooManyRequests(
        ErrorCode.RATE_LIMITED,
        `同时进行的流式对话最多 ${MAX_CONCURRENT_STREAMS} 条，请等待当前对话结束`,
      );
    }

    // ---- 建立 SSE 流 ----
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 必须显式关掉 Nginx 的缓冲，否则事件会被攒起来一次性下发，打字机效果消失
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Request-Id', requestId);
    res.flushHeaders();

    let seq = 0;
    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;

    /** 单点写入：所有事件都经这里，保证 `seq` 单调、连接关闭后不再写入 */
    const write = (event: string, payload: Record<string, unknown>): void => {
      if (closed) return;

      seq += 1;
      const body = { requestId, seq, ts: new Date().toISOString(), ...payload };
      res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
    };

    const close = (): void => {
      if (closed) return;
      closed = true;

      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }

      // 名额释放必须在**所有**退出路径上发生（正常结束 / 异常 / 客户端断连 / 超时），
      // 否则用户会永久占着 3 个名额之一
      void this.quota.releaseStreamSlot(userIdValue).catch(() => undefined);

      if (!res.writableEnded) res.end();
    };

    // 客户端断连：契约 §3.7.6 规则 5 要求"取消生成并释放 token 消耗"。
    // Provider 接口没有 AbortSignal 入参（见 `chat-message.service.ts` 文件头），
    // 因此这里能做的是：停止写入、释放名额、不再落库（消息未生成）。
    request.on('close', () => {
      if (closed) return;

      closed = true;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }

      void this.quota.releaseStreamSlot(userIdValue).catch(() => undefined);
    });

    const heartbeatMs = query.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    heartbeat = setInterval(() => {
      // `writableEnded` 也要判：`close()` 之后到定时器真正被清理之间存在极短窗口，
      // 而在已结束的响应上 write 会触发 ERR_STREAM_WRITE_AFTER_END
      if (closed || res.writableEnded) return;
      // 契约要求的心跳形态是 SSE 注释行（不是 `event:`），客户端不会把它当成事件
      res.write(': ping\n\n');
    }, heartbeatMs);

    // 总时长上限（契约：≤ 180s）
    const totalTimer = setTimeout(() => {
      if (closed) return;

      write('error', {
        conversationId: params.conversationId,
        code: 50010,
        message: 'AI 回复超时，请重试',
        canRetry: true,
        partialContentLength: 0,
        attempt: 1,
        maxAttempts: 1,
      });
      close();
    }, STREAM_TOTAL_TIMEOUT_MS);

    try {
      await this.messages.runTurn({
        userId: userIdValue,
        conversationId: params.conversationId,
        content: query.message,
        clientMessageId: query.clientMessageId ?? null,
        contextHints: query.contextHints ?? [],
        idempotencyKey: query.messageIdempotencyKey ?? null,
        // `isStreamed` 由数据库推导（schema 无该列），这里只作为"是否走事件通道"的开关
        streamed: false,
        requestId,
        request: request as unknown as RequestWithContext,
        onEvent: (event: ChatStreamEvent) => {
          if (closed) return;

          write(event.type, {
            conversationId: params.conversationId,
            ...event.payload,
          });
        },
      });
    } catch (error) {
      /**
       * 流已建立后的失败**必须走 `error` 事件**（契约 §3.7.6 第二张错误码表）。
       *
       * ⚠ 若错误是配额不足（402）这类"本该在建立流之前就拦下"的失败，
       * 此时响应头已经发出，无法改 HTTP 状态码 —— 只能以 `error` 事件告知。
       * 客户端因此必须同时处理"连接前 JSON 错误"与"连接后 error 事件"两条路径，
       * 这正是契约把错误码分成两张表的原因。
       */
      const code = error instanceof Error && 'code' in error ? Number((error as { code: unknown }).code) : 90000;

      write('error', {
        conversationId: params.conversationId,
        code: Number.isFinite(code) && code > 0 ? code : 90000,
        message: error instanceof Error ? error.message : 'AI 服务暂时不可用，请稍后重试',
        canRetry: !(code === 50019 || code === 50022),
        partialContentLength: 0,
        attempt: 1,
        maxAttempts: 1,
      });
    } finally {
      clearTimeout(totalTimer);
      close();
    }
  }

  // ==========================================================================
  // §3.7.7 删除 / 归档会话
  // ==========================================================================

  @Delete('conversations/:conversationId')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 20, ttl: 3_600_000 } })
  @ApiOperation({
    summary: '删除/归档会话',
    description: [
      '默认**软删除**（`mode = DELETE`）：置 `deletedAt` 与 `status = DELETED`，列表默认过滤。',
      '`mode = ARCHIVE` 保留会话但只读，`canRestore = true`（前端可提供「取消归档」入口）。',
      '',
      '**⚠️ 硬删除**（`hardDelete = true`）：消息 `content` 置为 `[已删除]`（**不可恢复**），',
      '但**保留**消息计数与时间戳（统计口径）、`ai_usage_logs` 计量记录（计费与成本，不含正文）、',
      '`ai_call_audits` 审计指纹（不存全文）。符合架构 9.4 用户数据权利。',
      '',
      '**天然幂等**：重复删除返回成功（不会因为「已经删过了」而报错）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '删除/归档成功（含 `affectedMessages` / `usageRetained`）' })
  @ApiResponse({ description: '会话 ID 非合法 UUID 或 `mode` 非枚举（`10001`）', status: 400 })
  @ApiResponse({ description: '会话不存在或已被硬删除（`AI_CONVERSATION_NOT_FOUND`）', status: 404 })
  @ApiResponse({ description: '会话属于其他用户（`AI_CONVERSATION_NOT_OWNED`，IDOR 防护）', status: 403 })
  @ApiResponse({ description: '60min 内超过 20 次（`10007`）', status: 429 })
  async deleteConversation(
    @CurrentUser('userId') userId: string,
    @Param() params: ConversationIdParamDto,
    @Query() query: DeleteConversationQueryDto,
  ): Promise<DeleteConversationView> {
    return this.context.deleteConversation({
      userId,
      conversationId: params.conversationId,
      mode: query.mode ?? 'DELETE',
      hardDelete: query.hardDelete ?? false,
    });
  }
}
