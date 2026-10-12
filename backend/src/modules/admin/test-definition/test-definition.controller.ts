/**
 * 管理端测试定义控制器
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.4（2 个接口：列表 / 新建）
 *
 * ## 守卫组合（管理端控制器的固定写法）
 *
 * `@Public()` 跳过的是**用户端**全局 `JwtAuthGuard`（管理员令牌的 `realm = admin`
 * 在它手里会被判 `REALM_MISMATCH`），管理端认证交由
 * `AdminAuthGuard` + `RolesGuard` + `ConfirmPasswordGuard` 承担。
 * 🚫 绝不能用 `@AdminPublic()` —— 那是匿名标记，会让接口彻底公开。
 *
 * ## 只读接口之外的写操作
 *
 * `POST` 属写操作：除审计（Service 内写 `admin_audit_logs`）外还建议客户端带
 * `X-Idempotency-Key`（契约 §3.14.4.2）。本接口的幂等由 `code` 唯一约束兜底 ——
 * 重复提交会得到 409 而不是产生两条定义，因此不额外依赖幂等键缓存。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../../common/decorators';
import type { RequestWithContext } from '../../../common/types/request.type';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { CreateTestDefinitionDto, ListTestDefinitionsQueryDto } from './dto/test-definition.dto';
import {
  AdminTestDefinitionService,
  type CreateTestDefinitionResult,
  type TestDefinitionListResult,
} from './test-definition.service';

@ApiTags('后台管理 - 测试定义')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/test-definitions')
export class AdminTestDefinitionController {
  constructor(private readonly testDefinitionService: AdminTestDefinitionService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.TEST_DEFINITION_READ)
  // 契约限流：adminId 300 次/60s
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '测试定义列表',
    description: [
      '查询全部测试定义（含下线项、题量统计、关联题目 ID 集合）。',
      '',
      '**`includeQuestionIds`**：为 `true` 时额外返回 `questionIds`（该定义名下启用中的题目 ID）。',
      '`quotaConfig` 始终返回，其 `availableCount` / `isSufficient` 由题库实时统计得出 ——',
      '任一维度 `isSufficient=false` 即意味着抽题风险（用户创建会话可能失败）。',
      '',
      '**`summary`** 是全局口径（不受分页影响），因此 `total` 与 `items.length` 不必相等。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({
    status: 400,
    description: '参数不合法（`10001`：category 非枚举 / isActive 非布尔 / pageSize > 100）',
  })
  @ApiResponse({ status: 403, description: '缺少 `test:definition:read`（`20009`）' })
  async list(@Query() query: ListTestDefinitionsQueryDto): Promise<TestDefinitionListResult> {
    return this.testDefinitionService.list(query);
  }

  @Post()
  /**
   * 契约要求成功响应为 **201 Created**（与 §3.14.5 的 Prompt 接口不同，后者为 200）。
   * NestJS 的 `@Post()` 默认就是 201，这里显式写出以免后续有人「顺手」加 `@HttpCode(200)`。
   */
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(ADMIN_PERMISSIONS.TEST_DEFINITION_WRITE)
  // 契约限流：adminId 20 次/60min
  @Throttle({ global: { limit: 20, ttl: 3600_000 } })
  @ApiHeader({ name: 'X-Idempotency-Key', required: false, description: '建议携带（重复提交由 code 唯一约束兜底）' })
  @ApiOperation({
    summary: '新建测试定义',
    description: [
      '新建测试定义（含抽题规则与计分模型绑定）。',
      '',
      '**新建默认下线**（`isActive` 默认 `false`）：草稿态，配置与题量校验通过后再启用，',
      '避免半成品定义被用户看到。',
      '',
      '**`readiness` 是综合判定**（题目池可用题量 + 配额合计 + 计分模型与维度匹配 + 付费准入）：',
      '`blockers` 非空时**不允许启用**。判据取自运行期实际下发试卷的逻辑，',
      '因此 `isReady=true` 表示用户真的能开出这个测试。',
      '',
      '**`questionIds` 的语义**：本数据模型中题目通过 `test_definition_id` 归属定义，',
      '不存在「题目-定义」多对多表，因此传入的题目会被**转移到新定义名下**；',
      '若转移会使来源定义题量不足，请求会被拒绝（避免一次新建打挂另一个在架测试）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '参数/结构非法（`10001`）或必填字段缺失（`10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `test:definition:write`（`20009`）' })
  @ApiResponse({ status: 409, description: '`code` 已存在（`10003`，契约原文为 `10012`）' })
  async create(
    @Body() dto: CreateTestDefinitionDto,
    @CurrentUser('userId') adminUserId: string,
    @Req() request: RequestWithContext,
  ): Promise<CreateTestDefinitionResult> {
    return this.testDefinitionService.create(dto, adminUserId, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      requestId: request.requestId,
    });
  }
}
