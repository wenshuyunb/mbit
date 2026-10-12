/**
 * 管理端报告数据控制器（契约 §3.14.8.2，内容治理视角）
 *
 * 与 `GET /admin/ai/reports`（AI 成本视角）数据同源、权限同为 `report:report:read`，
 * 但视图不同：本站面向审核抽检与质量复盘，🚫 **永不返回报告正文**。
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
import { AdminReportService } from './admin-report.service';
import type { AdminReportListView } from './admin-report.service';
import { AdminReportsQueryDto } from './dto/admin-report.dto';

@ApiTags('后台管理 - 报告核查')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/reports')
export class AdminReportController {
  constructor(private readonly reports: AdminReportService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.REPORT_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '报告数据列表（含匹配报告）',
    description: [
      '查询全站个人报告 + 匹配报告，服务内容审核抽检、举报处置与质量复盘。',
      '',
      '**与 `GET /admin/ai/reports` 的区别**：本接口偏内容治理（审核状态、举报、',
      '字数与质量），返回字段不含 token/成本/prompt 版本/缓存命中。',
      '',
      '**正文默认不可见**：本接口**没有** `includeContent` 参数，🚫 永不返回报告正文；',
      '`summary` 是服务端生成的摘要（用于不解锁正文的审核初筛）。',
      '审核抽检需走 `POST /admin/reports/{id}/review` 流程（含二次确认与高等级审计）。',
      '',
      '**隐私**：昵称掩码；匹配报告的 `userId` / 昵称置 `null`（归属关系而非单用户）。',
      '',
      '⚠ 已知数据模型缺口（已在交付简报标注，非实现遗漏）：',
      '`reviewStatus` / `reviewNote` 无对应列，只能推导 `REMOVED`（`deletedAt`）与',
      '`PENDING`，按 `APPROVED` / `FLAGGED` 过滤返回空集；`reportedByUsers` 无举报表，恒为 0。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（items + summary + privacyNotice）' })
  @ApiResponse({
    status: 400,
    description: '枚举/排序白名单非法、minWordCount > maxWordCount（均 `10001`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `report:report:read`（`20009`）' })
  async list(@Query() query: AdminReportsQueryDto): Promise<AdminReportListView> {
    return this.reports.listReports(query);
  }
}
