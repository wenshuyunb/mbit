/**
 * AdminTestDefinitionModule — 管理端测试定义域
 *
 * `imports: [AdminModule]` 而不是 `AdminModule` 里的 `controllers` 数组：
 * 域模块自带控制器与 DTO，装配时只需复用 AdminModule 导出的
 * 守卫链（`AdminAuthGuard` / `RolesGuard` / `ConfirmPasswordGuard`）与
 * 审计服务（`AdminAuditService`）—— 它们必须在本模块的注入上下文里可见，
 * 否则 `@UseGuards(...)` 无法解析。
 *
 * ⚠ 本模块**尚未挂到 `AdminModule` 或 `AppModule` 的 imports 中**（这两个文件属共享文件，
 *   本次改动范围之外）。接入时应把它们加入 `AdminModule` 的 imports（或 AppModule），
 *   否则路由不会被注册。
 *
 * `PrismaService` 所在模块是 `@Global()`，无需在此 import。
 */

import { Module } from '@nestjs/common';

import { AdminModule } from '../admin.module';
import { AdminTestDefinitionController } from './test-definition.controller';
import { AdminTestDefinitionService } from './test-definition.service';

@Module({
  imports: [AdminModule],
  controllers: [AdminTestDefinitionController],
  providers: [AdminTestDefinitionService],
})
export class AdminTestDefinitionModule {}
