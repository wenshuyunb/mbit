/**
 * 管理端 Prompt 控制器
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.5（7 个接口）
 *
 * ## 守卫组合（管理端控制器的固定写法）
 *
 * `@Public()` 跳过的是**用户端**全局 `JwtAuthGuard`（管理员令牌 realm=admin 会被它判
 * `REALM_MISMATCH`），管理端认证由 `AdminAuthGuard` + `RolesGuard` + `ConfirmPasswordGuard`
 * 承接。🚫 不能用 `@AdminPublic()`（那是匿名标记，会让接口彻底公开）。
 *
 * ## 发布/回滚是敏感操作
 *
 * 除了 `ai:prompt:publish` 权限点，还必须带 `X-Confirm-Password`（操作者本人密码）：
 * 发布直接影响**全部用户**看到的 AI 输出质量与合规边界，
 * 仅凭会话令牌即可操作意味着「一次 XSS 或未锁屏的工位就能改掉线上提示词」。
 * 缺失密码 → `20017`，密码错误 → `20018`（由 `ConfirmPasswordGuard` 返回）。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../../common/decorators';
import type { RequestWithContext } from '../../../common/types/request.type';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { SensitiveOperation } from '../decorators/sensitive-operation.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import {
  CreatePromptTemplateDto,
  CreatePromptVersionDto,
  ListPromptsQueryDto,
  PromptDetailQueryDto,
  PromptKeyParamDto,
  PromptVersionParamDto,
  PublishPromptVersionDto,
  RollbackPromptVersionDto,
  TestRenderPromptDto,
} from './dto/prompt.dto';
import {
  AdminPromptService,
  type CreatePromptTemplateResult,
  type CreatePromptVersionResult,
  type PromptDetailResult,
  type PromptListResult,
  type PublishPromptVersionResult,
  type RollbackPromptVersionResult,
  type TestRenderResult,
} from './prompt.service';

@ApiTags('后台管理 - Prompt')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/prompts')
export class AdminPromptController {
  constructor(private readonly promptService: AdminPromptService) {}

  // ==========================================================================
  // 列表与新建
  // ==========================================================================

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.PROMPT_READ)
  // 契约限流：adminId 300 次/60s
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Prompt 模板列表',
    description: [
      '列出全部 Prompt 模板及其当前生效版本、AB 测试权重、调用统计。',
      '',
      '**`activeVersionId` 是唯一生效指针**（架构 10.3）；`abTest.enabled` 只有在',
      '「指针为空 + 多个带权重的 ACTIVE 版本」时才为 `true` —— 因为运行期在指针非空时',
      '会直接钉住该版本，权重不参与选择。',
      '',
      '**`summary.templatesWithoutActiveVersion > 0` 是故障信号**：这些模板的调用会失败',
      '（运行期返回 `50011`），必须在监控侧告警。',
      '',
      '统计均为**近 7 天**口径；无数据时比率类字段返回 `null`（而不是 0，避免被误读为质量事故）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '参数不合法（`10001`：type 非枚举 / pageSize > 100）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:prompt:read`（`20009`）' })
  async list(@Query() query: ListPromptsQueryDto): Promise<PromptListResult> {
    return this.promptService.list(query);
  }

  @Post()
  @RequirePermission(ADMIN_PERMISSIONS.PROMPT_WRITE)
  // 契约限流：adminId 20 次/60min
  @Throttle({ global: { limit: 20, ttl: 3600_000 } })
  @ApiHeader({ name: 'X-Idempotency-Key', required: false, description: '建议携带（key 唯一约束兜底）' })
  @ApiOperation({
    summary: '新建 Prompt 模板',
    description: [
      '新建模板（`key` 唯一），可同时创建首个 `DRAFT` 版本。',
      '',
      '**首个版本不生效**：需显式调用 publish（防误发布）。',
      '',
      '**变量一致性校验**：服务端解析 `systemPrompt` + `userPromptTemplate` 中的 `{{var}}` 与',
      '`{{#if var}}` 占位符，与 `variables`（JSON Schema）比对；使用了未声明的变量直接失败，',
      '仅声明未使用只给警告（模板可能正在改）。',
      '',
      '**注入防护与边界规则**为启发式检查，结果在 `validation` 中返回，不阻断创建 ——',
      '但发布前应确认这两项为 `true`（合规要求）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '参数不合法（`10001`：key 格式/枚举/必填缺失）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:prompt:write`（`20009`）' })
  @ApiResponse({ status: 409, description: '`key` 已存在（`10003`，契约原文为 `10012`）' })
  @ApiResponse({ status: 500, description: '首个版本的变量声明缺失（`50012`，契约原文为 `50021`）' })
  async createTemplate(
    @Body() dto: CreatePromptTemplateDto,
    @CurrentUser('userId') adminUserId: string,
    @Req() request: RequestWithContext,
  ): Promise<CreatePromptTemplateResult> {
    return this.promptService.createTemplate(dto, adminUserId, this.requestContext(request));
  }

  // ==========================================================================
  // 详情
  // ==========================================================================

  @Get(':key')
  @RequirePermission(ADMIN_PERMISSIONS.PROMPT_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Prompt 模板详情（含全部版本）',
    description: [
      '返回模板详情与全部版本（含完整 Prompt 内容、状态、流量权重、发布审计）。',
      '',
      '**Prompt 全文仅管理员可见**：🚫 绝不通过用户侧接口暴露（防逆向与 Prompt 攻击，架构 R9）。',
      '`includeContent=false` 时只返回元数据（全文大，列表页不需要）。',
      '',
      '**`cacheStatus.cachedKeys`** 按**运行期真实缓存键**（按版本内容缓存）判定，',
      '因此不会出现「后台说已缓存、线上其实没缓存」。',
    ].join('\n'),
  })
  @ApiParam({ name: 'key', description: '模板键', example: 'MBTI_REPORT' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '`version` 非正整数（`10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:prompt:read`（`20009`）' })
  @ApiResponse({ status: 404, description: '`key`/`version` 不存在（`50011`，契约原文为 `50020`）' })
  async getDetail(
    @Param() params: PromptKeyParamDto,
    @Query() query: PromptDetailQueryDto,
  ): Promise<PromptDetailResult> {
    return this.promptService.getDetail(params.key, query);
  }

  // ==========================================================================
  // 新建版本
  // ==========================================================================

  @Post(':key/versions')
  @RequirePermission(ADMIN_PERMISSIONS.PROMPT_WRITE)
  @Throttle({ global: { limit: 60, ttl: 3600_000 } })
  @ApiHeader({ name: 'X-Idempotency-Key', required: false, description: '建议携带' })
  @ApiOperation({
    summary: '新建 Prompt 版本',
    description: [
      '为模板新建 `DRAFT` 版本（可基于指定版本克隆，便于增量修改）。',
      '',
      '**版本号自增**（`max(version) + 1`，不可指定）；并发新建时依赖',
      '`(templateId, version)` 唯一约束取号重试，不会产生重复版本。',
      '',
      '**新版本默认 `trafficWeight = 0`**：不参与流量，需显式发布后才生效。',
      '',
      '**变量校验是硬性的**：使用了未声明的 `{{var}}` → `50012`（契约原文 `50021`），',
      '且校验在落库**之前**完成 —— 否则库里会留下无法发布的版本。',
    ].join('\n'),
  })
  @ApiParam({ name: 'key', description: '模板键', example: 'MBTI_REPORT' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '参数不合法（`10001`：长度/范围越界）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:prompt:write`（`20009`）' })
  @ApiResponse({ status: 404, description: '`key` 不存在或 `cloneFromVersionId` 不属于该模板（`50011`）' })
  @ApiResponse({ status: 409, description: '并发创建版本号冲突（`10003`）' })
  @ApiResponse({ status: 500, description: '变量校验失败：使用了未声明的变量（`50012`）' })
  async createVersion(
    @Param() params: PromptKeyParamDto,
    @Body() dto: CreatePromptVersionDto,
    @CurrentUser('userId') adminUserId: string,
    @Req() request: RequestWithContext,
  ): Promise<CreatePromptVersionResult> {
    return this.promptService.createVersion(params.key, dto, adminUserId, this.requestContext(request));
  }

  // ==========================================================================
  // 发布（敏感操作）
  // ==========================================================================

  @Post(':key/versions/:versionId/publish')
  /**
   * 契约要求成功响应为 **200**（NestJS 的 `@Post()` 默认 201，必须显式覆盖）。
   */
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.PROMPT_PUBLISH)
  @SensitiveOperation()
  @Throttle({ global: { limit: 10, ttl: 3600_000 } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人登录密码（敏感操作二次确认）',
  })
  @ApiOperation({
    summary: '发布 Prompt 版本（敏感操作）',
    description: [
      '将指定 `DRAFT` 版本发布为 `ACTIVE`，更新模板 `activeVersionId` 并**主动失效缓存**（架构 10.3）。',
      '',
      '**`FULL`（默认）**：新版本权重 100，其他 `ACTIVE` 版本归档 → 同一时刻只有一个生效版本。',
      '',
      '**`AB_TEST`**：按 `trafficWeight` 分桶，其余权重按比例分摊给其他 `ACTIVE` 版本（合计恒为 100）；',
      '此模式下模板的 `activeVersionId` 会被置为 `null` —— 运行期只有在指针为空时才会按权重选择，',
      '否则权重不生效（这是运行期 `resolveVersion` 的既定行为）。',
      '',
      '**带病版本禁止发布**：版本使用的变量未在 `variables` 中声明时直接拒绝（`50012`）。',
      '',
      '**影响面**：仅影响新调用的报告生成；进行中的生成与已生成报告不受影响',
      '（报告 `cacheKey` 含 `promptVersionId`，历史报告继续命中旧键）。',
    ].join('\n'),
  })
  @ApiParam({ name: 'key', description: '模板键' })
  @ApiParam({ name: 'versionId', description: '版本 ID（必须属于该模板）' })
  @ApiResponse({ status: 200, description: '发布成功' })
  @ApiResponse({
    status: 400,
    description: '`mode` 非枚举 / AB 模式缺 `trafficWeight` / 无其他 ACTIVE 版本（`10001`）',
  })
  @ApiResponse({ status: 401, description: '缺少或错误的二次确认密码（`20017` / `20018`）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:prompt:publish`（`20009`）' })
  @ApiResponse({ status: 404, description: '`key`/`versionId` 不存在或不属于该模板（`50011`）' })
  @ApiResponse({ status: 500, description: '版本变量校验不通过，禁止发布（`50012`）' })
  async publish(
    @Param() params: PromptVersionParamDto,
    @Body() dto: PublishPromptVersionDto,
    @CurrentUser('userId') adminUserId: string,
    @Req() request: RequestWithContext,
  ): Promise<PublishPromptVersionResult> {
    return this.promptService.publish(params.key, params.versionId, dto, adminUserId, this.requestContext(request));
  }

  // ==========================================================================
  // 回滚（敏感操作）
  // ==========================================================================

  @Post(':key/versions/:versionId/rollback')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.PROMPT_PUBLISH)
  @SensitiveOperation()
  @Throttle({ global: { limit: 10, ttl: 3600_000 } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人登录密码（敏感操作二次确认）',
  })
  @ApiOperation({
    summary: '回滚到指定版本（敏感操作）',
    description: [
      '将指定历史版本重新设为生效版本（回滚），并归档当前版本。',
      '',
      '**回滚不删除新版本**：保留为 `ARCHIVED`，便于复盘与再次尝试修复。',
      '',
      '**`ALL`（默认）**：立即全量回滚（权重 100），被回滚版本归档。',
      '**`CANARY`**：灰度回滚，被回滚版本保留 10% 流量用于对照观察；',
      '此模式下 `activeVersionId` 置为 `null`（否则权重分流不生效）。',
      '',
      '**草稿不可作为回滚目标**（`50021`）。',
    ].join('\n'),
  })
  @ApiParam({ name: 'key', description: '模板键' })
  @ApiParam({ name: 'versionId', description: '目标版本 ID（`status ≠ DRAFT`）' })
  @ApiResponse({ status: 200, description: '回滚成功' })
  @ApiResponse({ status: 400, description: '`reason` 缺失/超长或 `revertWindow` 非枚举（`10001`）' })
  @ApiResponse({ status: 401, description: '缺少或错误的二次确认密码（`20017` / `20018`）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:prompt:publish`（`20009`）' })
  @ApiResponse({ status: 404, description: '`key`/`versionId` 不存在或不属于该模板（`50011`）' })
  @ApiResponse({ status: 500, description: '目标版本为 `DRAFT`，不可回滚（`50021`）' })
  async rollback(
    @Param() params: PromptVersionParamDto,
    @Body() dto: RollbackPromptVersionDto,
    @CurrentUser('userId') adminUserId: string,
    @Req() request: RequestWithContext,
  ): Promise<RollbackPromptVersionResult> {
    return this.promptService.rollback(params.key, params.versionId, dto, adminUserId, this.requestContext(request));
  }

  // ==========================================================================
  // 渲染预览
  // ==========================================================================

  @Post(':key/test-render')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.PROMPT_READ)
  @Throttle({ global: { limit: 60, ttl: 3600_000 } })
  @ApiOperation({
    summary: '变量渲染预览',
    description: [
      '在**不调用 LLM** 的前提下，用给定变量渲染指定版本的 Prompt，',
      '校验变量完整性与注入防护效果（架构 10.3 渲染规则）。',
      '',
      '**只读操作**：不发布、不写库、不产生成本（`ai_usage_logs` 不会有记录）。',
      '可预览 `DRAFT` 版本，是「新建版本 → test-render → publish」工作流的核心一环。',
      '',
      '**变量校验**：`strictValidation=true`（默认）时缺失必填变量直接报错（`50012`）；',
      '`false` 时缺失变量渲染为空串并给出警告。',
      '',
      '**条件块**：`{{#if var}}...{{/if}}` 在变量为空/未提供时整块跳过，结果在 `conditionalBlocks` 中列出。',
      '⚠ 当前运行期渲染器尚未实现条件块，预览响应会显式给出警告。',
      '',
      '**`ACTUAL_CALL` 模式当前未实现**（会明确报错）：真实调用会消耗 token 成本并写入用量日志，',
      '而本接口的定位是纯预览。',
    ].join('\n'),
  })
  @ApiParam({ name: 'key', description: '模板键' })
  @ApiResponse({ status: 200, description: '渲染成功' })
  @ApiResponse({ status: 400, description: '缺 `variables` / `mode` 非枚举 / 请求了未实现的 `ACTUAL_CALL`（`10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:prompt:read`（`20009`）' })
  @ApiResponse({ status: 404, description: '`key`/`versionId` 不存在（`50011`，契约原文为 `50020`）' })
  @ApiResponse({ status: 500, description: '缺失必填变量（`50012`，契约原文为 `50021`）' })
  async testRender(@Param() params: PromptKeyParamDto, @Body() dto: TestRenderPromptDto): Promise<TestRenderResult> {
    return this.promptService.testRender(params.key, dto);
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 审计上下文的统一提取（避免每个方法重复三行样板） */
  private requestContext(request: RequestWithContext): { ip?: string; userAgent?: string; requestId?: string } {
    return {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      requestId: request.requestId,
    };
  }
}
