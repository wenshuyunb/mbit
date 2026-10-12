/**
 * AdminAuditLogModule — 审计日志查询（契约 §3.14.9.3）
 *
 * ## 为什么要 `imports: [AdminModule]`
 *
 * `@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)` 引用的三个守卫
 * 由 `AdminModule` **导出**。Nest 的模块作用域是封闭的：不 import 它，
 * `@UseGuards(AdminAuthGuard)` 会在运行时因"找不到 provider"直接报错 ——
 * 而不是"守卫不生效"，很容易被误判成配置没问题。
 *
 * `PrismaService` / `RedisService` / `CryptoService` 所在模块均为 `@Global()`，
 * 因此这里无需 import。
 *
 * ⚠ 本模块**尚未挂载**：`admin.module.ts` 的 `imports` 与 `app.module.ts` 都未引用它
 * （本次任务明确禁止修改既有文件）。需要由调用方把 `AdminAuditLogModule` 加入
 * `admin.module.ts`（或 `app.module.ts`）的 `imports` 后，`GET /api/v1/admin/audit-logs`
 * 才会真正生效 —— 单测覆盖控制器与服务的逻辑，无法替代这一步装配。
 */

import { Module } from '@nestjs/common';

import { AdminModule } from '../admin.module';
import { AdminAuditLogController } from './admin-audit-log.controller';
import { AdminAuditLogService } from './admin-audit-log.service';

@Module({
  imports: [AdminModule],
  controllers: [AdminAuditLogController],
  providers: [AdminAuditLogService],
})
export class AdminAuditLogModule {}
