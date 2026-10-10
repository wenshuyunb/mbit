/**
 * 测试控制器
 *
 * 契约来源：docs/API_DESIGN.md §3.3
 * 分层约定（架构 §6.1 P2）：Controller 只做参数校验、调用 Service、返回 DTO。
 *
 * ⚠ 路由注册顺序很重要：`GET /tests/sessions` 必须注册在 `GET /tests/:code` **之前**，
 *   否则 `sessions` 会被当作测试定义编码匹配到 `:code` 而返回 404。
 */

import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { CurrentUser, IdempotencyKey } from '../../common/decorators';
import {
  CreateSessionDto,
  GetSessionQueryDto,
  ListSessionsQueryDto,
  ListTestsQueryDto,
  SaveAnswersDto,
  SessionIdParamDto,
  SubmitSessionDto,
  TestCodeParamDto,
} from './dto/test.dto';
import {
  TestService,
  type SaveAnswersResult,
  type SessionHistoryItem,
  type SubmitResultView,
  type TestDefinitionView,
  type TestSessionView,
} from './test.service';

@ApiTags('测评')
@ApiBearerAuth('user-token')
@Controller('tests')
export class TestController {
  constructor(private readonly testService: TestService) {}

  // ==========================================================================
  // 固定路径优先（必须先于 :code 注册）
  // ==========================================================================

  @Get('sessions')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '测试历史列表', description: '分页返回当前用户的测评历史（含进行中与已过期）。' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async listSessions(
    @CurrentUser('userId') userId: string,
    @Query() query: ListSessionsQueryDto,
  ): Promise<{
    items: SessionHistoryItem[];
    total: number;
    page: number;
    pageSize: number;
    hasNext: boolean;
  }> {
    return this.testService.listSessions(userId, query);
  }

  @Get('sessions/:id')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '获取会话（断点续答）',
    description: [
      '按批次返回试卷题目，并附带**已作答题目 ID 列表**，供前端回填与断点续答。',
      '',
      '**状态呈现**：会话过期后对外统一呈现为 `EXPIRED`（不暴露内部状态）。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '会话 ID（UUIDv7）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 403, description: '会话归属他人（`40003`，IDOR 防护）' })
  @ApiResponse({ status: 404, description: '会话不存在（`40002`）' })
  async getSession(
    @CurrentUser('userId') userId: string,
    @Param() params: SessionIdParamDto,
    @Query() query: GetSessionQueryDto,
  ): Promise<TestSessionView> {
    return this.testService.getSession(userId, params.id, query);
  }

  @Get('sessions/:id/result')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '测试结果详情',
    description: '返回已算分会话的完整结果（MBTI 维度、大五分数、关系风格、质量指标）。',
  })
  @ApiParam({ name: 'id', description: '会话 ID（UUIDv7）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 409, description: '会话尚未提交（`40005`）或已过期（`40004`）' })
  async getSessionResult(
    @CurrentUser('userId') userId: string,
    @Param() params: SessionIdParamDto,
  ): Promise<SubmitResultView> {
    return this.testService.getSessionResult(userId, params.id);
  }

  @Put('sessions/:id/answers')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '批量 upsert 答案',
    description: [
      '批量写入或更新答案（`UNIQUE(sessionId, questionId)` 从数据库层防重复作答）。',
      '',
      '**整批原子**：任一题非法（不属于本试卷 / 值域不符）则**整批拒绝并回滚**，',
      '保证客户端与服务端的作答进度始终一致，不会出现部分写入的错位。',
      '',
      '**状态限制**：仅 `CREATED` / `IN_PROGRESS` 可写；提交后写答案返回 `40005`',
      '（防止提交后篡改答案影响已算分结果）。',
      '',
      '**不触发算分**：本接口只写答案，算分在提交时同步执行。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '会话 ID（UUIDv7）' })
  @ApiResponse({ status: 200, description: '写入成功，返回最新进度' })
  @ApiResponse({ status: 400, description: '题目不属于本试卷（`40008`）或值域不符（`40007`）' })
  @ApiResponse({ status: 403, description: '会话归属他人（`40003`）' })
  @ApiResponse({ status: 409, description: '会话已提交或已过期（`40005` / `40004`）' })
  async saveAnswers(
    @CurrentUser('userId') userId: string,
    @Param() params: SessionIdParamDto,
    @Body() dto: SaveAnswersDto,
  ): Promise<SaveAnswersResult> {
    return this.testService.saveAnswers(userId, params.id, dto);
  }

  @Post('sessions/:id/submit')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: '提交并同步算分',
    description: [
      '提交测评并**同步**执行算分（纯函数，耗时 < 10ms，因此无需异步与轮询）。',
      '',
      '**提交前校验**：题量完整（禁止服务端代填空值，会污染算法结果）、会话归属、未过期。',
      '',
      '**落库（同一事务）**：会话置 `SCORED` → `test_results` 原始分与维度分 →',
      '`personality_profiles` 新版本画像（版本递增，旧版本不重算）→ `personality_snapshots` 时间序列点。',
      '',
      '**幂等**：重复提交直接返回既有结果（`isDuplicate: true`），**不会重复递增画像版本**。',
      '',
      '**质量提示**：一致性低于 60 分时返回提示文案，但不阻断流程。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '会话 ID（UUIDv7）' })
  @ApiResponse({ status: 200, description: '算分成功（或返回既有结果）' })
  @ApiResponse({ status: 400, description: '题量不完整（`40006`）或未确认提交（`10001`）' })
  @ApiResponse({ status: 403, description: '会话归属他人（`40003`）' })
  @ApiResponse({ status: 409, description: '会话已过期（`40004`）' })
  async submitSession(
    @CurrentUser('userId') userId: string,
    @Param() params: SessionIdParamDto,
    @Body() dto: SubmitSessionDto,
  ): Promise<SubmitResultView> {
    return this.testService.submit(userId, params.id, dto);
  }

  // ==========================================================================
  // 测试定义
  // ==========================================================================

  @Get()
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '测试定义列表',
    description: '返回全部上架（`isActive = true` 且 `status = ACTIVE`）的测试定义。',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async listTests(
    @CurrentUser('userId') userId: string,
    @Query() query: ListTestsQueryDto,
  ): Promise<TestDefinitionView[]> {
    return this.testService.listDefinitions(userId, query);
  }

  @Get(':code')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '测试定义详情',
    description: '返回单个测试定义，并附带当前用户的完成次数与是否存在进行中的会话。',
  })
  @ApiParam({ name: 'code', description: '测试定义编码', example: 'MBTI_LITE' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '测试定义不存在（`40000`）' })
  @ApiResponse({ status: 409, description: '测试定义已下线（`40001`）' })
  async getTest(@CurrentUser('userId') userId: string, @Param() params: TestCodeParamDto): Promise<TestDefinitionView> {
    return this.testService.getDefinition(userId, params.code);
  }

  @Post(':code/sessions')
  @Throttle({ global: { limit: 10, ttl: 3_600_000 } })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: '幂等键（8–64 位），防止双击创建双会话',
  })
  @ApiOperation({
    summary: '开始测试（创建会话并下发试卷快照）',
    description: [
      '创建测试会话：服务端抽题 + 乱序 + 固化 `paperSnapshot`，一次性返回第一批题目。',
      '',
      '**复用**：默认 `reuseInProgress = true`，存在未过期的进行中会话时直接复用（不重置进度），',
      '此时返回 **200** + `isReused: true`；新建会话返回 **201**。',
      '',
      '**分批**：完整试卷体积较大，默认每批返回 20 题；用 `GET /tests/sessions/{id}?batch=N` 取后续批次。',
      '',
      '**快照固化**：`paperSnapshot` 写入后永不修改，题库后续改动不影响进行中的会话与历史结果。',
    ].join('\n'),
  })
  @ApiParam({ name: 'code', description: '测试定义编码', example: 'MBTI_LITE' })
  @ApiResponse({ status: 201, description: '新建会话成功' })
  @ApiResponse({ status: 200, description: '复用了进行中的会话（`isReused: true`）' })
  @ApiResponse({ status: 400, description: '参数不合法 / 缺少幂等键（`10001` / `10009`）' })
  @ApiResponse({ status: 403, description: '注销冷静期内禁止开始测评（`30012`）' })
  @ApiResponse({ status: 409, description: '定义已下线（`40001`）' })
  async createSession(
    @CurrentUser('userId') userId: string,
    @Param() params: TestCodeParamDto,
    @Body() dto: CreateSessionDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-platform') platform?: string,
    @Headers('x-client-version') clientVersion?: string,
  ): Promise<TestSessionView> {
    const { view, created } = await this.testService.createSession(userId, params.code, dto, {
      idempotencyKey,
      platform,
      clientVersion,
    });

    // 复用既有会话时返回 200（契约规则 5），避免客户端把「复用」误判为「新建」
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);

    return view;
  }
}
