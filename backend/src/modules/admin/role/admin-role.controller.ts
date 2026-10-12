/**
 * 管理端角色控制器（契约 §3.14.9.7 / §3.14.9.8）
 *
 * ## 守卫组合是固定写法，不能少也不能改
 *
 * ```
 * @Public()                                   // 只跳过**用户端**全局守卫，不代表可匿名访问
 * @UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
 * ```
 *   · `@Public()`：管理员令牌在用户 realm 下过不了 `JwtAuthGuard`（全局 `APP_GUARD`），
 *     不标它管理端接口一律 403；
 *   · `AdminAuthGuard`：管理端认证（校验 realm、黑名单、**会话仍然存在**）；
 *   · `RolesGuard`：消费 `@RequirePermission`；
 *   · `ConfirmPasswordGuard`：只对标记了 `@SensitiveOperation()` 的接口要求
 *     `X-Confirm-Password`，未标记的接口直接放行。
 *
 * ⚠ **绝不能**在这里用 `@AdminPublic()` —— 那是登录/刷新这类"本就该公开"的接口专用，
 *   用在本接口等于把角色管理接口敞开（见 `admin-public.decorator.ts`）。
 *
 * ## 为什么 PATCH 要显式写 `@HttpCode(HttpStatus.OK)`
 *
 * NestJS 的 PATCH 默认就是 200，所以这行今天是"冗余"的。写它是为了防**日后被人
 * 改成 POST**：POST 默认 201，而契约与前端都按 200 判断（`admin-auth.controller.ts`
 * 的 `login` 就踩过这个坑并留了注释）。留着这一行，改动者不会悄悄改变成功码。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Headers, Ip, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../../common/decorators';
import type { RequestWithContext } from '../../../common/types/request.type';
import { SensitiveOperation } from '../decorators/sensitive-operation.decorator';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminRoleService, type AdminRoleListView, type AdminRoleUpdateView } from './admin-role.service';
import { AdminRoleUpdateDto } from './dto/admin-role.dto';

@ApiTags('后台管理 - 角色与权限')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/roles')
export class AdminRoleController {
  constructor(private readonly roleService: AdminRoleService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.ROLE_READ)
  // 契约 §3.14.9.7：adminId 维度 300 次/60s（角色配置界面会频繁刷新）
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '角色与权限点列表',
    description: [
      '返回全部**未软删**角色及其权限点映射，以及按领域分组的全部可用权限点清单（供角色配置界面渲染）。',
      '',
      '**`isEditable`**：`roles` 表没有这一列，由规则推导 —— `SUPER_ADMIN` 为 `false`（权限恒为 `*`），',
      '其余角色为 `true`。',
      '',
      '**`adminCount`**：该角色被多少**未软删**管理员使用，用于评估改动影响面，一次 `groupBy` 批量统计。',
      '',
      '**`severity`**：权限风险等级（`NORMAL` / `SENSITIVE` / `CRITICAL`）；授予或移除 `CRITICAL` 级权限点时，',
      '修改接口会返回 `riskWarnings`，前端应做强提示。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功（`roles` + `allPermissions` + 统计）' })
  @ApiResponse({ status: 403, description: '缺少 `system:role:read`（`20009`）' })
  async listRoles(): Promise<AdminRoleListView> {
    return this.roleService.listRoles();
  }

  @Patch(':id')
  /**
   * 契约 §3.14.9.8 的成功码是 **200**（PATCH 的框架默认值）。显式声明的原因见文件头。
   */
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.ROLE_WRITE)
  // 敏感操作：由 ConfirmPasswordGuard 校验 X-Confirm-Password（本控制器不读该请求头）
  @SensitiveOperation()
  // 契约 §3.14.9.8：adminId 维度 10 次/60min（CRITICAL 级操作，不做"手快"式试错）
  @Throttle({ global: { limit: 10, ttl: 3_600_000 } })
  @ApiParam({ name: 'id', description: '角色 UUID', example: '0195f3a2-2be1-7a53-9c68-f6db3e4f5c3a' })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description:
      '操作者本人登录密码（二次确认）。缺失 `20017`，错误 `20018`；**必须放在请求头**，放 body 会被 `10001` 拒绝',
  })
  @ApiOperation({
    summary: '修改角色权限（敏感操作）',
    description: [
      '按**覆盖语义**替换角色的权限点集合（传入集合即最终权限，传 `[]` 表示清空），可选同时修改名称与描述。',
      '',
      '**二次确认密码**：必须携带请求头 `X-Confirm-Password`（操作者本人密码），否则 `20017`/`20018`。',
      '',
      '**`SUPER_ADMIN` 不可修改**（`20009`）：防止「先创建高权角色再赋给自己」的提权链。',
      '',
      '**自锁死护栏**：若本次修改会导致全系统没有任何账号再持有 `system:role:write`，直接拒绝（`10008`）',
      '且不写入 —— 否则将没有任何人还能管理角色与权限。',
      '',
      '**即时生效的方式**：本仓库把权限写进了管理员令牌且守卫不重新查库，因此修改成功后会',
      '**撤销受影响管理员的全部会话**，他们需重新登录才会拿到新权限（`requiresReLogin: true`；',
      '契约规则 2 假设守卫层实时查缓存，故契约写的是 `false`，属刻意差异）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '修改成功，返回权限 diff、影响面、风险提示与审计信息' })
  @ApiResponse({
    status: 400,
    description: '权限点不在白名单内 / 数量超限（`10001`）、内置角色改名（`10001`）、缺少必填字段（`10001`）',
  })
  @ApiResponse({ status: 401, description: '缺少（`20017`）或错误（`20018`）的二次确认密码' })
  @ApiResponse({
    status: 403,
    description:
      '缺少 `system:role:write`（`20009`）、尝试修改 `SUPER_ADMIN`（`20009`）、改动会导致无人可管理角色（`10008`）',
  })
  @ApiResponse({ status: 404, description: '角色不存在或已删除（`20023`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 10 次（`10010`）' })
  async updateRole(
    @Param('id') roleId: string,
    @Body() dto: AdminRoleUpdateDto,
    @CurrentUser('userId') operatorAdminId: string,
    @Ip() ip: string,
    @Req() request: RequestWithContext,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminRoleUpdateView> {
    return this.roleService.updateRole(roleId, dto, {
      operatorAdminId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      // 请求追踪 ID 由 RequestIdMiddleware 注入；中间件未装配时取不到，允许为 null
      requestId: request.requestId ?? null,
    });
  }
}
