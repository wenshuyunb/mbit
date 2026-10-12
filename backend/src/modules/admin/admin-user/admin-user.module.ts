/**
 * AdminUserModule — 管理端「管理员账号」域（契约 §3.14.9.4 / §3.14.9.5 / §3.14.9.6）
 *
 * 为什么 `imports: [AdminModule]` 而不是把控制器塞进 `AdminModule.controllers`：
 * AdminModule 是**共享文件**（本次改动范围之外），域模块自带控制器与 DTO 更内聚；
 * 而守卫链（`AdminAuthGuard` / `RolesGuard` / `ConfirmPasswordGuard`）、
 * 审计（`AdminAuditService`）、RBAC（`AdminRbacService`）、密码（`PasswordService`）、
 * 令牌撤销（`AdminTokenService`）都必须在本模块的注入上下文里可见，
 * 否则 `@UseGuards(...)` 与构造函数注入都会在启动时报「无法解析依赖」。
 *
 * ⚠ 本模块**尚未挂到 `AdminModule` / `AppModule` 的 imports 中**（这两个文件属共享文件，
 *   本次改动范围之外）。接入方式：把它加入 `AdminModule` 的 `imports`
 *   （或 `AppModule` 的业务模块区）。**在此之前路由不会被注册**。
 *
 * `PrismaService` / `RedisService` 所在模块均为 `@Global()`，无需在此 import。
 */

import { Module } from '@nestjs/common';

import { AdminModule } from '../admin.module';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';

@Module({
  imports: [AdminModule],
  controllers: [AdminUserController],
  providers: [AdminUserService],
})
export class AdminUserModule {}
