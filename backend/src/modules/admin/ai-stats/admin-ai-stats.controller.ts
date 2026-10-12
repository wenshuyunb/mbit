/**
 * 管理端 AI 统计控制器（契约 §3.14.7.1 ~ §3.14.7.5，共 5 个接口）
 *
 * 三个控制器类分属三条路径前缀（Nest 的 `@Controller()` 一个类只能有一个前缀）：
 *   · `/admin/ai/stats/*`   → overview / usage / costs（`ai:stats:read`）
 *   · `/admin/ai/call-logs` → 调用审计日志（`ai:calllog:read`）
 *   · `/admin/ai/reports`   → 报告数据管理（`report:report:read`）
 *
 * 放在同一文件是因为它们共享同一套守卫组合与错误码约定；拆成三个文件会让
 * 「守卫写错一个」的风险乘以三。
 *
 * ## 守卫组合
 *
 * `@Public()` 跳过**用户端**全局守卫（管理员令牌会被判 realm 不匹配），
 * 管理端认证由 `AdminAuthGuard` + `RolesGuard` + `ConfirmPasswordGuard` 承接。
 * ⚠ 绝不能用 `@AdminPublic()`：那会让接口完全公开。
 *
 * ## 为什么 GET 不标 `@SensitiveOperation()`
 *
 * `/admin/ai/reports` 的 `includeContent=true` 按契约要求二次确认密码，但**不是**
 * 无条件要求 —— 给它标 `@SensitiveOperation()` 会把默认的 `includeContent=false`
 * 也只读请求一并拦住。因此该接口在 Service 内做**条件式**密码校验
 * （错误码仍是契约要求的 `20017` / `20018`）。
 */

import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../../common/decorators';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminAiCostsService } from './admin-ai-costs.service';
import type { AiCostsView } from './admin-ai-costs.service';
import { AdminAiCallLogService } from './admin-ai-call-log.service';
import type { AiCallLogView } from './admin-ai-call-log.service';
import { AdminAiReportService } from './admin-ai-report.service';
import type { AdminAiReportListView } from './admin-ai-report.service';
import { AdminAiStatsService } from './admin-ai-stats.service';
import type { AiOverviewView, AiUsageView } from './admin-ai-stats.service';
import {
  AiCallLogQueryDto,
  AiCostsQueryDto,
  AiOverviewQueryDto,
  AiReportsQueryDto,
  AiUsageQueryDto,
} from './dto/admin-ai-stats.dto';

/** 二次确认密码请求头（与 `ConfirmPasswordGuard` 使用的头名一致） */
const CONFIRM_PASSWORD_HEADER = 'x-confirm-password';

@ApiTags('后台管理 - AI 统计')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/ai/stats')
export class AdminAiStatsController {
  constructor(
    private readonly stats: AdminAiStatsService,
    // 注入的服务属性名不能叫 `costs`：会与下面 `@Get('costs')` 的处理方法同名，
    // 触发 TS2300 Duplicate identifier（同一个类里属性与方法不能重名），
    // 且 `this.costs` 到底是服务还是方法只能靠读代码猜。加 Service 后缀消除歧义。
    private readonly costsService: AdminAiCostsService,
  ) {}

  @Get('overview')
  @RequirePermission(ADMIN_PERMISSIONS.AI_STATS_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'AI 总览',
    description: [
      'AI 使用总览看板：调用量、成功率、成本、P95/P99 延迟、熔断状态、当日预算消耗。',
      '',
      '**时区口径（重要）**：范围边界与按日聚合统一使用 **UTC 自然日**，',
      '与契约示例一致（`rangeStart` 为 `...T00:00:00.000Z`），也与',
      '`ai_usage_logs.usage_date`（写入时按 UTC 截断）保持一致。',
      '副作用：北京时间 00:00–08:00 的调用会计入**前一天**。',
      '',
      '**性能**：全部走聚合 SQL（`groupBy` / `count FILTER` / `percentile_cont`），',
      '固定约 12 条查询且与数据量无关，命中 `[usageDate, taskType]` / `[createdAt]` 等既有索引。',
      '',
      '**熔断状态**：项目尚无运行时熔断器实现，`circuitState` 由「最近 N 次调用是否全部失败',
      '且仍在冷却窗口内」推导；`HALF_OPEN` 永不返回（无法从调用记录判定）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  @ApiResponse({ status: 400, description: 'range/task 非枚举、CUSTOM 缺时间范围、范围 > 366 天（均 `10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:stats:read`（`20009`）' })
  async overview(@Query() query: AiOverviewQueryDto): Promise<AiOverviewView> {
    return this.stats.getOverview(query);
  }

  @Get('usage')
  @RequirePermission(ADMIN_PERMISSIONS.AI_STATS_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'AI 用量统计（多维度交叉聚合）',
    description: [
      '按日/任务/provider/模型/prompt 版本/用户聚合用量、token 与成本，并与前一等长周期对比。',
      '',
      '**多维度交叉**：`groupBy=DATE,TASK` 返回（日期 × 任务）的行集；行数超 `limit` 时',
      '`isTruncated = true`。维度顺序按契约枚举顺序归一，`TASK,DATE` 与 `DATE,TASK` 结果一致。',
      '',
      '**粒度**：`HOUR` 仅允许 ≤ 7 天范围（防数据量爆炸），超出返回 `10001`。',
      '`HOUR` 走 `created_at`（`usage_date` 是日期列没有小时），但保留日期范围条件以命中索引。',
      '',
      '**`uniqueUsers`**：该聚合桶内 `count(DISTINCT user_id)` 的**精确值**',
      '（契约提到 HyperLogLog 近似，这里用精确 count，误差为 0）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（rows + totals + trend）' })
  @ApiResponse({ status: 400, description: '缺时间范围 / 范围 > 366 天 / HOUR > 7 天 / limit 越界（均 `10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:stats:read`（`20009`）' })
  async usage(@Query() query: AiUsageQueryDto): Promise<AiUsageView> {
    return this.stats.getUsage(query);
  }

  @Get('costs')
  @RequirePermission(ADMIN_PERMISSIONS.AI_STATS_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'AI 成本统计与预算',
    description: [
      '按 provider/模型/任务/日聚合成本，含预算消耗曲线、成本异常检测、单位经济模型与 Top 消费用户。',
      '',
      '**金额**：一律整数分（ADR-009），`costCents` 来自 `ai_usage_logs.cost_amount`。',
      '',
      '**单位经济模型**：单报告成本 = 期内**已成功报告**的成本均值（按报告类型），',
      '不含失败重试成本 —— 否则「重试率上升导致的单位成本恶化」会被摊薄掩盖。',
      '',
      '**异常检测**：`COST_SPIKE`（某日成本高于本区间日均 1.2 倍）与',
      '`UNIT_COST_DEVIATION`（某任务单次成本高于整体 1.15 倍）；基线取本区间自身分布，',
      '不编造无法持续获取的「近 7 日均值」。',
      '',
      '**隐私**：`topCostUsers` 只返回掩码昵称，🚫 不含手机号与 openid。',
      '',
      '⚠ 期内营收来自 `orders.paid_at`，该列**没有索引**（schema 不可改），详见交付说明。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  @ApiResponse({ status: 400, description: '缺时间范围 / 范围 > 366 天 / groupBy 非枚举（均 `10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:stats:read`（`20009`）' })
  async costs(@Query() query: AiCostsQueryDto): Promise<AiCostsView> {
    return this.costsService.getCosts(query);
  }
}

@ApiTags('后台管理 - AI 调用日志')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/ai/call-logs')
export class AdminAiCallLogController {
  constructor(private readonly callLogs: AdminAiCallLogService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.AI_CALLLOG_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'AI 调用审计日志',
    description: [
      '查询 AI 调用审计（`ai_call_audits`）：请求指纹、provider、是否缓存命中、错误码、耗时。',
      '',
      '**隐私底线（关键）**：审计日志**不存** Prompt 全文与模型输出全文（架构 §10.6）；',
      '本接口只返回 `requestFingerprint`（SHA-256）与长度桶，🚫 不返回任何正文片段',
      '（包括库中的 `redacted_sample` 列）。',
      '',
      '**时间范围限制 31 天**：审计日志量大（日均 3k+ 条），限制查询范围保护数据库。',
      '',
      '**状态映射**：契约枚举 ↔ 库内枚举为多对一 ——',
      '`SUCCESS` ← {SUCCESS, CACHE_HIT}；`FAILED` ← {FAILED, CIRCUIT_OPEN}；',
      '`ABORTED` ← {TIMEOUT}；`BLOCKED` ← {BLOCKED}。',
      '',
      '**成本与 token**：`ai_call_audits` 没有这些列，按 `request_id` 从 `ai_usage_logs`',
      '批量补齐（1 次 `IN` 查询，非逐行查询）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（items + summary + privacyNotice）' })
  @ApiResponse({ status: 400, description: '缺时间范围 / 范围 > 31 天 / 枚举或排序白名单非法（均 `10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `ai:calllog:read`（`20009`）' })
  async list(@Query() query: AiCallLogQueryDto): Promise<AiCallLogView> {
    return this.callLogs.listCallLogs(query);
  }
}

@ApiTags('后台管理 - AI 报告')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/ai/reports')
export class AdminAiReportController {
  constructor(private readonly reports: AdminAiReportService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.REPORT_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: false,
    description: '仅当 `includeContent=true` 时必填：查看报告正文需二次确认密码',
  })
  @ApiOperation({
    summary: '报告数据管理（AI 视角）',
    description: [
      '查询全站 AI 报告（个人报告 + 匹配报告），用于质量抽检、内容审核回溯与付费解锁统计。',
      '偏 **AI 成本与效率**视角（token、成本、prompt 版本、缓存命中）；',
      '内容治理视角见 `GET /admin/reports`。',
      '',
      '**正文默认不返回**：`includeContent` 默认 `false`；置 `true` 需携带',
      '`X-Confirm-Password`（操作者本人登录密码），缺失返回 `20017`、错误返回 `20018`，',
      '并通过后写入高等级审计。',
      '',
      '**类型/状态映射**：`COMPATIBILITY_REPORT` ↔ `AiReport.type = RELATIONSHIP_REPORT`',
      '且 `relationshipId` 非空；`GROWTH_REPORT` ↔ `GROWTH_SUMMARY`；`PENDING` ↔ `QUEUED`；',
      '`PARTIAL` = `FAILED` 且有 `relationshipId`（算分完成、AI 解读失败）。',
      '',
      '**隐私**：昵称掩码；匹配报告的 `userId` / 昵称按契约置 `null`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（items + summary + privacyNotice）' })
  @ApiResponse({
    status: 400,
    description: '枚举/排序白名单非法、minWordCount > maxWordCount（均 `10001`）',
  })
  @ApiResponse({ status: 401, description: '查看正文缺少或错误的二次确认密码（`20017` / `20018`）' })
  @ApiResponse({ status: 403, description: '缺少 `report:report:read`（`20009`）' })
  async list(
    @CurrentUser('userId') adminUserId: string,
    @Query() query: AiReportsQueryDto,
    @Headers(CONFIRM_PASSWORD_HEADER) confirmPassword?: string,
  ): Promise<AdminAiReportListView> {
    return this.reports.listReports(query, adminUserId, confirmPassword);
  }
}
