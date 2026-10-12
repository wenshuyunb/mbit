/**
 * AdminModule — 后台管理
 *
 * ## 契约
 *
 * `docs/API_DESIGN.md` §3.14（43 个接口，前缀 `/api/v1/admin`，独立 realm）。
 * 本文件目前只装配**认证与 RBAC 基础**；各业务域的控制器随实现逐步加入
 * `controllers` 数组。
 *
 * ## 与用户端的关系
 *
 * 管理端与用户端是**两条独立的认证链**（ADR-012 双 realm）：
 *   · 不同密钥（`JWT_SECRET` / `ADMIN_JWT_SECRET`，配置层强校验二者不同值）
 *   · 不同策略（`user-jwt` / `admin-jwt`）
 *   · 不同守卫（`JwtAuthGuard` / `AdminAuthGuard`）
 *
 * 管理端控制器必须同时写 `@Public()`（跳过用户端全局守卫）与
 * `@UseGuards(AdminAuthGuard, RolesGuard)`，原因见 `decorators/admin-public.decorator.ts`。
 *
 * ## 依赖
 *
 * PrismaService / RedisService / CryptoService 所在模块均为 `@Global()`，
 * 因此这里无需 import。
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import type { AppConfig } from '../../config/config.type';
import { AdminAuditService } from './audit/admin-audit.service';
import { AdminAuthController } from './auth/admin-auth.controller';
import { AdminAuthGuard } from './auth/admin-auth.guard';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminJwtStrategy, ADMIN_JWT_STRATEGY } from './auth/admin-jwt.strategy';
import { AdminTokenService } from './auth/admin-token.service';
import { PasswordService } from './auth/password.service';
import { AdminRbacService } from './rbac/admin-rbac.service';
import { ConfirmPasswordGuard } from './rbac/guards/confirm-password.guard';
import { RolesGuard } from './rbac/guards/roles.guard';

@Module({
  imports: [
    ConfigModule,
    // 与用户端模块一样：JwtModule 只提供 signAsync / verifyAsync 能力，
    // 具体密钥在调用处以 per-call 形式传入，避免「两端共用默认密钥」的隐式约定
    PassportModule.register({ defaultStrategy: ADMIN_JWT_STRATEGY, session: false }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => ({
        secret: configService.get('jwt.adminSecret', { infer: true }),
      }),
    }),
  ],
  controllers: [AdminAuthController],
  providers: [
    // 认证
    AdminAuthService,
    AdminTokenService,
    PasswordService,
    AdminJwtStrategy,
    // RBAC
    AdminRbacService,
    RolesGuard,
    AdminAuthGuard,
    ConfirmPasswordGuard,
    // 审计
    AdminAuditService,
  ],
  // 业务域控制器需要复用这些能力：
  //   · AdminAuthGuard + RolesGuard  → 守卫链
  //   · AdminAuditService           → 写操作审计
  //   · AdminRbacService            → 角色与权限查询（管理员管理接口用）
  exports: [AdminAuthService, AdminTokenService, AdminRbacService, AdminAuditService, PasswordService],
})
export class AdminModule {}
