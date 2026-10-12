/**
 * 管理端题库控制器
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.3（7 个接口：列表 / 新建 / 详情 / 修改 / 删除 /
 * 批量导入 / 启用停用）
 *
 * ## 守卫组合（管理端控制器的固定写法，见 `admin/decorators/admin-public.decorator.ts`）
 *
 * `@Public()` 跳过的是**用户端**全局守卫（`app.module.ts` 里的 `JwtAuthGuard`），
 * 否则管理员令牌（`realm = 'admin'`）会被判为 realm 不匹配（`20013`）。
 * 管理端自身的认证与授权由 `AdminAuthGuard` + `RolesGuard` 承接，
 * 敏感操作再由 `ConfirmPasswordGuard` 要求 `X-Confirm-Password`。
 * ⚠ 这里**绝不能**用 `@AdminPublic()` —— 那会让接口完全匿名可访问。
 *
 * ## 错误码映射（重要）
 *
 * 契约 §3.14.3 的错误码编号与本仓库 `common/errors/error-code.ts` 的既有编号**不一致**
 * （例如契约的 `10008` 表示「题目不存在」，本仓库的 `10008` 是 `OPERATION_FORBIDDEN`）。
 * 按「不新增错误码」的约定，本模块统一使用既有码中语义最接近者，映射关系写在
 * 每个接口的 `@ApiResponse` 说明里，汇总见实现简报：
 *
 * | 契约码 | 含义 | 本模块实际返回 |
 * | ------ | ---- | -------------- |
 * | 10001 / 10002 / 10004 / 10005 / 10016 | 参数、枚举、分页、越界 | `10001 PARAM_INVALID` |
 * | 10003 | id 非合法 UUID | `10001 PARAM_INVALID`（`ParseUUIDPipe` → ValidationPipe） |
 * | 10006 | data 超 512KB | `10005 PAYLOAD_TOO_LARGE` |
 * | 10008 | 题目不存在 | `40009 QUESTION_NOT_FOUND` |
 * | 10010 | 限流 | `10007 RATE_LIMITED` |
 * | 10011 | 缺 `X-Idempotency-Key` | `10009 IDEMPOTENCY_KEY_MISSING` |
 * | 10012 | `code` 冲突 | `10003 RESOURCE_CONFLICT` |
 * | 40008 | 选项 value 重复 / LIKERT5 非 1–5 | `10001 PARAM_INVALID` |
 * | 40011 | 禁止物理删除已使用的题 | `10008 OPERATION_FORBIDDEN` |
 * | 10002 | 缺必填字段 | `10001 PARAM_INVALID` |
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { CurrentUser, IdempotencyKey, Public } from '../../../common/decorators';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { SensitiveOperation } from '../decorators/sensitive-operation.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type {
  AdminQuestionCreateResult,
  AdminQuestionDeleteResult,
  AdminQuestionDetailResult,
  AdminQuestionImportResult,
  AdminQuestionListResult,
  AdminQuestionRequestContext,
  AdminQuestionToggleResult,
  AdminQuestionUpdateResult,
} from './admin-question.service';
import { AdminQuestionService } from './admin-question.service';
import {
  CreateAdminQuestionDto,
  DeleteAdminQuestionDto,
  ImportAdminQuestionsDto,
  ListAdminQuestionsQueryDto,
  ToggleAdminQuestionDto,
  UpdateAdminQuestionDto,
} from './dto/admin-question.dto';

/** 限流时间窗（毫秒） */
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;

@ApiTags('后台管理 - 题库')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/questions')
export class AdminQuestionController {
  constructor(private readonly questionService: AdminQuestionService) {}

  @Get()
  @RequirePermission('test:question:read')
  @Throttle({ global: { limit: 300, ttl: ONE_MINUTE_MS } })
  @ApiOperation({
    summary: '题目列表',
    description: [
      '分页查询题库，支持按维度、题型、启用状态、标签、所属测试定义筛选，用于内容运营。',
      '',
      '**`summary` 不受筛选条件影响**：它是整个题库的态势（总数 / 启用数 / 各维度与各题型分布），',
      '运营看的是整体均衡度，而不是当前这一页。',
      '',
      '**`usageCount`** 是会话快照引用计数（`test_sessions.paper_snapshot` 中引用该题的会话数），',
      '用于识别冷门题；**`updatedBy`** 取最近一条审计记录的操作人显示名（审计追溯）。',
      '',
      '**`testCodes`** 当前实现恒为 0/1 个元素：数据模型 `Question.testDefinitionId` 是必填外键，',
      '一道题只能归属一个测试定义（契约的多归属需新增关联表，见实现简报）。',
      '',
      '⚠ 契约要求题干按 `tsvector` 全文检索（架构 4.1），但数据模型没有该列，',
      '本实现退化为 `ILIKE %keyword%`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  @ApiResponse({
    status: 400,
    description: '参数不合法：枚举非法 / `sortBy` 不在白名单 / `pageSize > 100`（契约 `10001` / `10004` / `10005`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `test:question:read`（`20009`）' })
  @ApiResponse({ status: 429, description: '超过限流（300 次/60s）' })
  async list(@Query() query: ListAdminQuestionsQueryDto): Promise<AdminQuestionListResult> {
    return this.questionService.list(query);
  }

  @Post()
  @RequirePermission('test:question:write')
  @Throttle({ global: { limit: 60, ttl: ONE_HOUR_MS } })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description: '幂等键（8–64 位）：防表单重复提交（契约标注为「建议」）',
  })
  @ApiOperation({
    summary: '新建题目',
    description: [
      '新增题目（含选项定义），写入后即可被后续新建的会话抽中。',
      '',
      '**默认 201 Created**（契约 §3.14.3.2）。',
      '',
      '**选项**：`LIKERT5` 可省略 `options`，服务端生成 1–5 的标准选项；',
      '`BINARY` / `FORCED_CHOICE` / `RANK` 必须显式提供 2–8 个选项。',
      '',
      '**题干是自由文本**：🚫 不支持 HTML，服务端在存储前剥离标签（架构 14.3）。',
      '',
      '**写入后的三项校验**（均不阻断，只提示）：维度题量均衡（偏离配额 ±20% 告警）、',
      '同维度正/反向题比例（建议 0.3–0.7，影响一致性指标）、题干重复度（> 0.85 告警）。',
      '',
      '**不影响进行中会话**：新题只参与后续新建会话的抽题（快照固化，架构 11.1）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({
    status: 400,
    description:
      '参数不合法：缺必填字段 / `type`、`dimension`、`testCodes` 非法 / `weight`、`order` 越界 / 选项 value 题内重复或 LIKERT5 非 1–5（契约 `10001` / `10002` / `10016` / `40008`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `test:question:write`（`20009`）' })
  @ApiResponse({ status: 409, description: '`code` 已存在（含被软删除题目占用的情况，契约 `10012`）' })
  @ApiResponse({ status: 429, description: '超过限流（60 次/60min）' })
  async create(
    @CurrentUser('userId') adminUserId: string,
    @Body() dto: CreateAdminQuestionDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AdminQuestionCreateResult> {
    return this.questionService.create(adminUserId, dto, this.buildContext(ip, userAgent, requestId));
  }

  @Get(':id')
  @RequirePermission('test:question:read')
  @Throttle({ global: { limit: 300, ttl: ONE_MINUTE_MS } })
  @ApiOperation({
    summary: '题目详情',
    description: [
      '返回题目的完整定义（含选项、计分映射、统计与最近变更）。',
      '',
      '**`selectedCount` / `selectedRatio`**：选项被选次数与占比 —— 用于识别「所有人都选 3」的无效题。',
      '',
      '**`discriminationIndex`**：题目作答值与同维度总分的相关系数；`< 0.2` 建议下线',
      '（`qualityLevel: POOR`）。样本不足 30 条时返回 `null` 且 `qualityLevel: INSUFFICIENT_DATA`，',
      '避免用几条作答就给题目判死刑。',
      '',
      '**`changeHistory`**：来自审计日志的题目维度切片（最近 50 条）。',
      'seed 灌入的历史题目没有审计记录，因此其 `changeHistory` 为空数组。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '题目 UUID', example: '0195f3a2-29cf-7bfd-9c68-e4bf1c2d3a1c' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '`id` 非合法 UUID（契约 `10003` → 本模块 `10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `test:question:read`（`20009`）' })
  @ApiResponse({ status: 404, description: '题目不存在或已被删除（`40009`）' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminQuestionDetailResult> {
    return this.questionService.detail(id);
  }

  @Patch(':id')
  @RequirePermission('test:question:write')
  @Throttle({ global: { limit: 60, ttl: ONE_HOUR_MS } })
  @ApiOperation({
    summary: '修改题目',
    description: [
      '修改题干、维度、权重、反向计分、启用状态、标签、归属与选项（PATCH 语义，全部字段可选）。',
      '',
      '**`code` 与 `type` 不可变**：`code` 被试卷快照引用（历史可解释性），`type` 变更会破坏已有',
      '选项结构。请求体里带这两个字段会因 `forbidNonWhitelisted` 直接返回 `10001`。',
      '',
      '**`options` 是全量替换语义**：传入数组即最终状态；若选项 `value` 集合不变则保留原 `optionId`，',
      '统计连续性不断裂。',
      '',
      '**`impactAssessment`** 明确「只影响新建会话」；若改动了 `dimension` / `weight` / `reverseScored`，',
      '`scoringImpact` 会指出算分口径的变化（属于高风险变更，审计必须留 before/after）。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '题目 UUID' })
  @ApiResponse({ status: 200, description: '修改成功' })
  @ApiResponse({
    status: 400,
    description:
      '字段类型错误 / 试图修改 `code`、`type` / `weight`、`order` 越界 / 选项 value 重复（契约 `10001` / `10003` / `10016` / `40008`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `test:question:write`（`20009`）' })
  @ApiResponse({ status: 404, description: '题目不存在或已被删除（`40009`）' })
  @ApiResponse({ status: 429, description: '超过限流（60 次/60min）' })
  async update(
    @CurrentUser('userId') adminUserId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAdminQuestionDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AdminQuestionUpdateResult> {
    return this.questionService.update(adminUserId, id, dto, this.buildContext(ip, userAgent, requestId));
  }

  @Delete(':id')
  @RequirePermission('test:question:write')
  @SensitiveOperation()
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 20, ttl: ONE_HOUR_MS } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人的登录密码（破坏性操作的二次确认）',
  })
  @ApiOperation({
    summary: '删除题目（软删除）',
    description: [
      '**软删除**：置 `deletedAt` + `isActive = false`，历史快照与统计保留（架构 P9）。',
      '',
      '**立即生效**：删除后新建会话不再抽到该题；已开始/已完成的会话使用冻结快照，不受影响。',
      '',
      '**`hardDelete = true` 仅在「从未被任何会话引用**且**没有任何答题记录」时允许** —— ',
      '`test_answers.question_id` 的外键是 `onDelete: Restrict`，物理删除会破坏历史答卷的引用完整性。',
      '',
      '**幂等**：已删除的题再次删除仍返回成功（不重复变更数据）。',
      '',
      '**题量预警**：若删除后某测试定义的可用题量低于其要求，`impactAssessment.sufficientQuota` 给出提示',
      '（不阻断，但需尽快补题，否则新建会话会触发 40011）。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '题目 UUID' })
  @ApiResponse({ status: 200, description: '删除成功（含幂等重复删除）' })
  @ApiResponse({
    status: 400,
    description: '`reason` 缺失或超长 / `id` 非合法 UUID（契约 `10001` / `10002` / `10003`）',
  })
  @ApiResponse({ status: 401, description: '缺少或错误的二次确认密码（`20017` / `20018`）' })
  @ApiResponse({
    status: 403,
    description: '缺少 `test:question:write`（`20009`）或禁止物理删除已使用的题（契约 `40011` → 本模块 `10008`）',
  })
  @ApiResponse({ status: 404, description: '题目不存在（`40009`）' })
  @ApiResponse({ status: 429, description: '超过限流（20 次/60min）' })
  async remove(
    @CurrentUser('userId') adminUserId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DeleteAdminQuestionDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AdminQuestionDeleteResult> {
    return this.questionService.remove(adminUserId, id, dto, this.buildContext(ip, userAgent, requestId));
  }

  @Post('import')
  @RequirePermission('test:question:write')
  @SensitiveOperation()
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 5, ttl: ONE_HOUR_MS } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人的登录密码（批量导入为敏感操作）',
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description: '幂等键；`dryRun = false` 时**必填**（缺失返回 `10009`，契约码 `10011`）',
  })
  @ApiOperation({
    summary: '批量导入题目',
    description: [
      '批量导入题目（JSON 或 CSV），支持**试运行（dryRun）**逐行校验与错误报告。',
      '',
      '**状态码**：`dryRun = true`（默认）返回 **200** 试运行报告；实际写入返回 **201**。',
      '',
      '**先试后写**：`dryRun` 默认 `true`。试运行只校验不写库，`cacheInvalidated` 恒为 `false`；',
      '确认无误后再以 `dryRun = false` 提交（此时必须携带 `X-Idempotency-Key`）。',
      '',
      '**`onError`**：`ABORT`（默认）在存在非法行时**整批拒绝**（400，不写入任何一行）；',
      '`SKIP` 跳过非法行、写入合法行，并在 `errors` 中逐行报告。',
      '',
      '**`mode`**：`APPEND`（仅新增，命中既有 code 即报错）/ `UPSERT`（按 code 更新）',
      '/ `REPLACE`（⚠️ 软删除该测试下未出现在导入数据中的题，必须指定 `testCode`）。',
      '',
      '**CSV 表头约定**：`code,content,type,dimension,weight,reverseScored,order,tags,optionLabels,optionValues,scoreMaps`',
      '（`tags` / `optionLabels` / `optionValues` 用 `|` 分隔；`scoreMaps` 每个选项一段，段内多维度用 `;` 分隔，如 `EI:-2;SN:1`）。',
      '',
      '**同步上限 500 题**（超出请分批）；> 500 题的异步队列导入（契约的 202 + `taskId` 路径）未实现。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '试运行校验结果（`dryRun: true`）' })
  @ApiResponse({ status: 201, description: '实际写入结果（`dryRun: false`）' })
  @ApiResponse({
    status: 400,
    description:
      '枚举非法 / 缺 `format`、`data` / 单批 > 500 题 / 缺幂等键 / ABORT 模式下存在非法行（契约 `10001` / `10002` / `10016` / `10011`）',
  })
  @ApiResponse({ status: 401, description: '缺少或错误的二次确认密码（`20017` / `20018`）' })
  @ApiResponse({ status: 403, description: '缺少 `test:question:write`（`20009`）' })
  @ApiResponse({ status: 409, description: '`UPSERT` 与既有 `code` 字段不兼容（契约 `10012` → `10003`）' })
  @ApiResponse({ status: 413, description: '`data` 超过 512KB（契约 `10006` → 本模块 `10005`）' })
  @ApiResponse({ status: 429, description: '超过限流（5 次/60min）' })
  async importQuestions(
    @CurrentUser('userId') adminUserId: string,
    @Body() dto: ImportAdminQuestionsDto,
    @IdempotencyKey(false) idempotencyKey: string | undefined,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
    @Headers('user-agent') userAgent?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AdminQuestionImportResult> {
    const result = await this.questionService.importQuestions(
      adminUserId,
      dto,
      this.buildContext(ip, userAgent, requestId, idempotencyKey),
    );

    /**
     * 契约 §3.14.3.6 对同一接口给了两个成功状态码：
     * 试运行 **200**、实际写入 **201**。`@HttpCode` 是静态的，因此这里按结果动态设置
     * （与 `test.controller.ts` 的「复用会话 200 / 新建 201」同一手法）。
     */
    res.status(result.dryRun ? HttpStatus.OK : HttpStatus.CREATED);

    return result;
  }

  @Post(':id/toggle')
  @RequirePermission('test:question:write')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 120, ttl: ONE_HOUR_MS } })
  @ApiOperation({
    summary: '启用/停用题目',
    description: [
      '快速切换题目启用状态（无需完整 PATCH）。停用后不再被抽题，历史快照不受影响。',
      '',
      '**显式传目标状态**（`isActive: true|false`），🚫 不使用「切换」语义：',
      '并发双请求在「切换」语义下会互相抵消，而显式目标值天然幂等。',
      '',
      '**停用 ≠ 删除**：停用后仍可查询，传 `isActive: true` 即可恢复。',
      '',
      '**题量预警**：停用导致某测试定义可用题量不足时，`sufficientQuota` 明确提示（架构 11.1）。',
      '',
      '**服务端已同步 `questionCount`**：停用会减少可用题量，若不回填，用户端新建会话会直接 40011。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '题目 UUID' })
  @ApiResponse({ status: 200, description: '操作成功（重复传同一目标状态亦返回成功）' })
  @ApiResponse({
    status: 400,
    description: '`isActive` 缺失或非布尔 / `id` 非合法 UUID（契约 `10001` / `10002` / `10003`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `test:question:write`（`20009`）' })
  @ApiResponse({ status: 404, description: '题目不存在或已被删除（`40009`）' })
  @ApiResponse({ status: 429, description: '超过限流（120 次/60min）' })
  async toggle(
    @CurrentUser('userId') adminUserId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ToggleAdminQuestionDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AdminQuestionToggleResult> {
    return this.questionService.toggle(adminUserId, id, dto, this.buildContext(ip, userAgent, requestId));
  }

  /** 组装 Service 需要的请求上下文（审计用；Service 不依赖 express 类型） */
  private buildContext(
    ip: string,
    userAgent?: string,
    requestId?: string,
    idempotencyKey?: string,
  ): AdminQuestionRequestContext {
    return {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      requestId: requestId ?? null,
      idempotencyKey: idempotencyKey ?? null,
    };
  }
}
