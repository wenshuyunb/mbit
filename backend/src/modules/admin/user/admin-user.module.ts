/**
 * AdminUserModule — 管理端用户管理域
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.2（4 个接口，前缀 `/api/v1/admin/users`）
 *
 * ## 为什么只 import `AdminModule` + `AuthModule`
 *
 * 管理端各业务域需要复用认证与横切能力，它们都在 `AdminModule` 里提供并被导出：
 *   · `AdminAuthGuard` / `RolesGuard` / `ConfirmPasswordGuard` → 守卫链（`@UseGuards` 需要在本模块上下文可解析）
 *   · `AdminAuditService`                                       → 写操作与敏感读的审计
 * `PrismaService` / `CryptoService` 等为全局模块，无需在此声明。
 *
 * 额外引入 `AuthModule` 只为拿到 `TokenService`：封禁必须撤销用户登录态，而会话存储
 * 是 `auth` 模块的内部实现（见 ADR-032 —— 这是架构 §6.1 依赖白名单的显式登记例外）。
 *
 * ⚠ 本模块需被 `admin.module.ts` 的 `imports` 引用后路由才会生效。
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { AdminModule } from '../admin.module';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';

@Module({
  imports: [AdminModule, AuthModule],
  controllers: [AdminUserController],
  providers: [AdminUserService],
  // 导出供后续管理端模块（如注销申请域、审计域）复用用户视图组装能力
  exports: [AdminUserService],
})
export class AdminUserModule {}
