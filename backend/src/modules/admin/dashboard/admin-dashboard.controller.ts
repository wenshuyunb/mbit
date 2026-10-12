/**
 * 管理端北极星指标看板控制器（契约 §3.14.9.9）
 *
 * 守卫组合（管理端固定写法）：`@Public()` 跳过**用户端**全局守卫
 * （管理员令牌会被判 realm 不匹配），管理端认证由 `AdminAuthGuard` +
 * `RolesGuard` + `ConfirmPasswordGuard` 承接。
 * ⚠ 绝不能用 `@AdminPublic()`（那会让接口完全公开）。
 *
 * 只读接口，不标 `@SensitiveOperation()`（二次确认密码针对的是写操作）。
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
import { AdminDashboardService } from './admin-dashboard.service';
import type { AdminDashboardView } from './admin-dashboard.service';
import { AdminDashboardQueryDto } from './dto/admin-dashboard.dto';

@ApiTags('后台管理 - 数据看板')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get('metrics')
  @RequirePermission(ADMIN_PERMISSIONS.DASHBOARD_METRICS_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '北极星指标看板',
    description: [
      '北极星与副指标看板（架构 1.4）：付费转化率、测试完成率、邀请裂变系数 K、',
      'AI 报告生成成功率、AI 单报告成本，以及增长漏斗、趋势与实时块。',
      '',
      '**指标口径显式化**：每项返回 `definition` + `numerator` + `denominator`，',
      '避免「同名指标口径不一致」的运营争议。',
      '',
      '**方向语义**：`isLowerBetter: true` 表示越低越好（如 AI 单报告成本）；',
      '🚫 前端不得假设「增长即正向」（如 `AI_SAFETY_BLOCK_RATE` 上升反映用户情绪困扰，',
      '需中性展示并读 `note`）。',
      '',
      '**时区口径**：范围边界与趋势分桶统一使用 **UTC 自然日/周/月**，与契约示例一致；',
      '北京时间 00:00–08:00 的行为会计入前一天（已在交付简报标注）。',
      '',
      '**缓存**：整包缓存 60 秒（`cachedAt` / `cacheTtlSeconds`），缓存键含全部筛选参数。',
      '',
      '🚫 不含用户级隐私数据：看板仅返回聚合指标。',
      '',
      '⚠ 数据源缺口：`funnel.stages[LAUNCH/LOGIN]` 与 `realtime.onlineUsersEstimate`',
      '因缺少全站访问日志表而返回 `null`（附 `note`），不以 0 冒充。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（northStar + keyMetrics + funnel + trends + realtime）' })
  @ApiResponse({
    status: 400,
    description: 'range/granularity 非枚举、CUSTOM 缺时间范围、范围 > 366 天（均 `10001`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `dashboard:metrics:read`（`20009`）' })
  async metrics(@Query() query: AdminDashboardQueryDto): Promise<AdminDashboardView> {
    return this.dashboard.getMetrics(query);
  }
}
