/**
 * AdminRoleModule — 角色与权限点管理（契约 §3.14.9.7 / §3.14.9.8）
 *
 * ## 为什么要 `imports: [AdminModule]`
 *
 * 守卫（`AdminAuthGuard` / `RolesGuard` / `ConfirmPasswordGuard` 由 `@UseGuards` 引用）
 * 与依赖的服务（`AdminTokenService`、`AdminAuditService`）由 `AdminModule` **导出**。
 * Nest 的模块作用域是封闭的：不 import 它，`@UseGuards(AdminAuthGuard)` 在运行时
 * 会因为"找不到 provider"直接报错 —— 而不是"守卫不生效"，容易误判成配置没问题。
 *
 * `PrismaService` / `RedisService` / `CryptoService` 所在模块均为 `@Global()`，
 * 因此这里无需 import。
 *
 * ⚠ 本模块**尚未挂载**：`admin.module.ts` 的 `imports` 与 `app.module.ts` 都未引用它
 * （本次任务明确禁止修改既有文件），需要由调用方把 `AdminRoleModule` 加入
 * `admin.module.ts` 的 `imports`（或 `app.module.ts`）后，`/api/v1/admin/roles`
 * 两个路由才会真正生效。单测覆盖的是控制器与服务的逻辑，无法替代这一步装配。
 */

import { Module } from '@nestjs/common';

import { AdminModule } from '../admin.module';
import { AdminRoleController } from './admin-role.controller';
import { AdminRoleService } from './admin-role.service';

@Module({
  imports: [AdminModule],
  controllers: [AdminRoleController],
  providers: [AdminRoleService],
})
export class AdminRoleModule {}
