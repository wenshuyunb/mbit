/**
 * 管理端审计日志控制器（契约 §3.14.9.3）
 *
 * ## 守卫组合是固定写法，不能少也不能改
 *
 * ```
 * @Public()                                   // 只跳过**用户端**全局守卫，不代表可匿名访问
 * @UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
 * ```
 *   · `@Public()`：管理员令牌在用户 realm 下过不了全局 `JwtAuthGuard`（`APP_GUARD`），
 *     不标它管理端接口一律被 `REALM_MISMATCH` 拒掉；
 *   · `AdminAuthGuard`：管理端认证（realm、令牌黑名单、会话仍然存在）；
 *   · `RolesGuard`：消费 `@RequirePermission(ADMIN_PERMISSIONS.AUDIT_READ)`；
 *   · `ConfirmPasswordGuard`：只对标记了 `@SensitiveOperation()` 的接口要求
 *     `X-Confirm-Password`，本接口是只读查询，故**不标记**（标了会强行要求管理员
 *     每次翻页都输密码）。
 *
 * ⚠ **绝不能**用 `@AdminPublic()` —— 那是登录/刷新这类"本就该公开"的接口专用，
 *   用在这里等于把审计日志（含 before/after 全量快照）彻底敞开
 *   （见 `decorators/admin-public.decorator.ts`）。
 *
 * ## 只读接口不写审计
 *
 * 本接口**不写** `admin_audit_logs`：`AdminAuditAction` 枚举里没有 `READ`，
 * 硬套别的动作去记录"谁看了审计页"属于往合规表里写伪造数据
 * （契约业务规则 1：审计仅追加）。详见 Service 头部说明。
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../../common/decorators';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminAuditLogService } from './admin-audit-log.service';
import { AdminAuditLogQueryDto } from './dto/admin-audit-log-query.dto';
import { AdminAuditLogListDto } from './dto/admin-audit-log-response.dto';

@ApiTags('后台管理 - 审计日志')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/audit-logs')
export class AdminAuditLogController {
  constructor(private readonly auditLogService: AdminAuditLogService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.AUDIT_READ)
  // 契约 §3.14.9.3：adminId 维度 300 次/60s（审计页要反复调时间范围与筛选）
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '审计日志查询',
    description: [
      '查询管理员操作审计日志（谁、何时、对什么、改了什么，含 `before` / `after` diff），用于合规与内部审计。',
      '',
      '**`startTime` / `endTime` 必填**，且 `endTime` 必须晚于 `startTime`、范围不超过 **90 天**；',
      '超出范围的错误码为 `10001`（契约原文写作 `10016`，本仓库无此码，见下方说明）。',
      '',
      '**`action` / `severity` / `targetType` 是派生字段**：`admin_audit_logs` 表里只有',
      '「资源类型 + 动作枚举 + 成败」，权限点 / 风险等级 / 目标类型都是由',
      '`(resourceType, action)` 反推出来的。因此：',
      '  · `action` 传**权限点**（如 `payment:order:refund`）会展开成对应的动作与资源类型组合过滤；',
      '    传裸动作名（如 `refund`）按动作过滤；都反推不出来时按 `resourceType` 精确匹配；',
      '  · `severity` = `CRITICAL` / `SENSITIVE` 由契约业务规则 2 的权限点表反推，',
      '    `NORMAL` 是二者的**补集**（三项之和恒等于 `totalLogs`）；',
      '  · `targetType` 由 `resourceType` 归一（`admin_user` / `admin` → `ADMIN`）。',
      '',
      '**`result`**：`SUCCESS` → `success = true`；`DENIED` → `success = false` 且 `errorCode = 20009`',
      '（越权尝试，安全审计重点）；`FAILED` → 其余失败。',
      '',
      '**`keyword`** 在 `changeNote`（`reason` / `diff_summary`）与动作内搜索；关键词恰好等于某个',
      '权限点或动作名时按该动作匹配（`action` 是枚举列，无法做文本包含匹配）。',
      '',
      '**`summary`** 基于**当前过滤条件**统计（不是当前页），`byAction` / `byOperator` 各取 Top 10，',
      '`weeklyTrend` 为 `endTime` 所在 UTC 日往前 7 天（无记录的日子补 0）。',
      '',
      '**`metadata`** 仅返回有真实来源的字段（目前只有 `latencyMs`），否则为 `null` ——',
      '契约示例中的 `ticketId` / `confirmPasswordVerified` 等在本仓库没有任何列承载，不编造。',
      '',
      '⚠ 契约错误表里的 `10016`（时间范围 > 90 天）在本仓库**不存在**，也不允许新增错误码，',
      '故统一用 `10001`；契约中 `10001` / `10002` 两码在当前实现里也只用 `10001`',
      '（仓库的 `10002` 是 `RESOURCE_NOT_FOUND` / 404，语义不符）。',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: '查询成功（分页 + `summary` + `retentionNotice`）',
    type: AdminAuditLogListDto,
  })
  @ApiResponse({
    status: 400,
    description:
      '缺少 `startTime` / `endTime`、不是合法 ISO 8601、`endTime` 不晚于 `startTime`、范围 > 90 天、' +
      '`targetType` / `result` / `severity` / `sortBy` 非枚举值、`keyword` / `targetId` 超长、' +
      '`operatorAdminId` / `targetId` 非 UUID（`10001`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `system:audit:read`（`20009`）' })
  async list(@Query() query: AdminAuditLogQueryDto): Promise<AdminAuditLogListDto> {
    return this.auditLogService.list(query);
  }
}
