/**
 * 管理端系统配置控制器（契约 §3.14.9.1 / §3.14.9.2）
 *
 * ## 守卫组合（管理端控制器的固定写法）
 *
 * `@Public()` 是**必须**的：`app.module.ts` 把用户端 `JwtAuthGuard` 注册为全局守卫，
 * 而管理员令牌的 realm 是 `admin`，在用户端守卫下会直接判 `20013`。
 * 这里 `@Public()` 的语义只是「跳过用户端守卫」，真正的保护来自
 * `AdminAuthGuard`（管理员令牌）→ `RolesGuard`（权限点）→ `ConfirmPasswordGuard`
 *（敏感操作二次确认）。**不要**使用 `@AdminPublic()`，那会让接口彻底公开。
 *
 * ## 为什么 PUT 必须显式声明 200
 *
 * NestJS 对 `@Put()` 默认返回 200，但本控制器与其它管理端写接口一样显式写出
 * `@HttpCode(HttpStatus.OK)`：契约里同一模块的 POST 接口要求 200、另一个要求 201，
 * 靠「框架默认值」记忆这种事迟早出错，显式声明让状态码在代码里可见。
 */

import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Ip, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../../common/decorators';
import type { RequestWithContext } from '../../../common/types/request.type';
import { SensitiveOperation } from '../decorators/sensitive-operation.decorator';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminConfigService } from './admin-config.service';
import { AdminConfigListQueryDto, AdminUpdateConfigsDto } from './dto/admin-config.dto';

@ApiTags('后台管理 - 系统配置')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/configs')
export class AdminConfigController {
  constructor(private readonly configs: AdminConfigService) {}

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.CONFIG_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '系统配置查询',
    description: [
      '按分组返回全系统配置项，用于后台「设置」页。',
      '',
      '**环境变量锁定项（关键）**：`envOverride` 非空的配置由环境变量决定，后台',
      '`isEditable: false` 只读 —— 这是「配置即环境变量」原则，避免高风险的全局开关',
      '被后台一次误操作改掉而无法从代码/部署侧追溯。',
      '',
      '**不返回任何密钥类配置**：`DEEPSEEK_API_KEY`、`WECHAT_PAY_PRIVATE_KEY`、',
      '`CRYPTO_KEY` 等只存在于环境变量，本接口只返回 `system_configs` 中的行。',
      '',
      '**`includeHistory=true`**：附上每条配置最近 5 次变更（来自 `admin_audit_logs`，',
      '与审计同源），用于回答「这个值是什么时候、被谁改的」。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（`groups` + 统计 + `configVersion`）' })
  @ApiResponse({ status: 400, description: '`group` 非枚举（`10001`）、`keys` 超过 50 个（`10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `system:config:read`（`20009`）' })
  async list(@Query() query: AdminConfigListQueryDto): Promise<Record<string, unknown>> {
    return this.configs.list({
      group: query.group,
      keys: query.keys,
      includeHistory: query.includeHistory,
    });
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.CONFIG_WRITE)
  @SensitiveOperation()
  // 契约 §3.14.9.2：adminId 20 次/60min。配置影响全站，写频率本该极低
  @Throttle({ global: { limit: 20, ttl: 3_600_000 } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '操作者本人密码（二次确认）；缺失 `20017`，错误 `20018`',
  })
  @ApiOperation({
    summary: '批量更新系统配置（敏感操作，需二次确认密码）',
    description: [
      '事务性批量更新：**全部成功或全部回滚**（单条校验失败即整体拒绝，且不进事务）。',
      '',
      '**环境变量锁定项禁止后台修改**：`envOverride` 非空的键返回 `10008` 并提示走部署流程。',
      '',
      '**试运行**：`dryRun = true` 时只校验并返回 `before`/`after` 对比，不写入、不失效缓存。',
      '',
      '**缓存失效**：写入成功后失效 `sm:system:config`（前台 `GET /system/config` 的缓存），',
      '`invalidateCaches = false` 时不失效，新值等 TTL（300s）自然过期。',
      '',
      '**审计**：记录 before/after diff、操作人、时间、IP 与每项的 `changeNote`（CRITICAL 级）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '更新成功（`configVersion` 递增 + `auditLogId`）' })
  @ApiResponse({
    status: 400,
    description: '`items` 结构非法 / 为空 / 超过 30 条 / 值超出 min-max 或类型不符（`10001`）',
  })
  @ApiResponse({
    status: 401,
    description: '缺少二次确认密码（`20017`）或密码错误（`20018`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `system:config:write`（`20009`）或修改环境变量锁定项（`10008`）' })
  @ApiResponse({ status: 404, description: '`key` 不存在（`90008`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 20 次（`10007`）' })
  async update(
    @Body() dto: AdminUpdateConfigsDto,
    @CurrentUser('userId') adminUserId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<Record<string, unknown>> {
    return this.configs.update(
      {
        items: dto.items.map((item) => ({ key: item.key, value: item.value, changeNote: item.changeNote })),
        dryRun: dto.dryRun,
        invalidateCaches: dto.invalidateCaches,
      },
      {
        adminUserId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        requestId: request.requestId ?? null,
      },
    );
  }
}
