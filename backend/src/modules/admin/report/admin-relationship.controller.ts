/**
 * 管理端关系数据控制器（契约 §3.14.8.1）
 *
 * 守卫组合（管理端固定写法）：`@Public()` 跳过**用户端**全局守卫，
 * 管理端认证由 `AdminAuthGuard` + `RolesGuard` + `ConfirmPasswordGuard` 承接。
 * ⚠ 绝不能用 `@AdminPublic()`（那会让接口完全公开）。
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
import { AdminRelationshipService } from './admin-relationship.service';
import type { AdminRelationshipListView } from './admin-relationship.service';
import { AdminRelationshipsQueryDto } from './dto/admin-report.dto';

@ApiTags('后台管理 - 关系数据')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/relationships')
export class AdminRelationshipController {
  constructor(private readonly relationships: AdminRelationshipService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.RELATIONSHIP_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '关系数据列表',
    description: [
      '查询全站关系数据（状态、类型、双方摘要、匹配分数），用于裂变分析（K 值）与风控。',
      '',
      '**裂变指标**：`summary.inviteFunnel.viralCoefficientK` = 被接受的有效邀请数 ÷',
      '完成测试用户数（架构 §1.4 口径，与看板保持一致），`kTarget = 0.8`，',
      '`isKOnTarget` 直接给出达标判断。',
      '',
      '**摘要口径**：`items` 受筛选条件影响，而 `summary` 是**全站口径**',
      '（契约示例中 `total = 2140` 而 `summary.totalRelationships = 4826`）。',
      '',
      '**隐私**：双方昵称一律掩码；🚫 不返回手机号、openid；不含任何 AI 对话内容。',
      '',
      '**性能**：单页固定 7 条查询 + 摘要 9 条聚合，与页大小无关；',
      '`sortBy=overallScore` 因分数在一对多关联上而走原生 SQL（见服务实现说明）。',
      '',
      '⚠ `isAbnormal` 由读时规则推导（同一对用户多次建立/解除、有报告但缺分数）；',
      '`relationships` 表没有风控标记列，真实的风控结论需补列或独立表。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（items + summary）' })
  @ApiResponse({ status: 400, description: '枚举/排序白名单非法、minScore > maxScore（均 `10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `relationship:relationship:read`（`20009`）' })
  async list(@Query() query: AdminRelationshipsQueryDto): Promise<AdminRelationshipListView> {
    return this.relationships.listRelationships(query);
  }
}
