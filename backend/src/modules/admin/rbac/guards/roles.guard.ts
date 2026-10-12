/**
 * RolesGuard — 管理端 RBAC 守卫
 *
 * 消费两个装饰器（可单独或同时使用，同时使用时为 AND 关系）：
 *   · `@Roles(...)`            — 角色门（任一命中即可）
 *   · `@RequirePermission(...)` — 权限门（全部命中才可；持有 `*` 视为全通过）
 *
 * ## 为什么不是全局守卫
 *
 * `app.module.ts` 已经把**用户端**的 `JwtAuthGuard` 注册为 `APP_GUARD`，
 * 它按用户 realm 校验令牌 —— 管理员令牌（`realm = 'admin'`）在它手里会直接被判为
 * `REALM_MISMATCH`（20013）。因此管理端控制器必须显式标记 `@Public()` 跳过它，
 * 再通过 `@UseGuards(AdminAuthGuard, RolesGuard)` 挂上本守卫链。
 * 这不是「忘了加保护」，而是**两套 realm 守卫不能同时挂在同一条路由上**。
 *
 * 安全默认：本守卫在拿不到管理端主体时**拒绝**（而不是放行），
 * 与用户端守卫的默认拒绝保持一致 —— 漏配守卫应该「不工作」，而不是「裸奔」。
 */

import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '../../../../common/errors/business.exception';
import { ErrorCode } from '../../../../common/errors/error-code';
import { ROLES_KEY } from '../../../../common/decorators/roles.decorator';
import type { RequestWithContext } from '../../../../common/types/request.type';
import { PERMISSION_WILDCARD } from '../admin-permission.constants';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles =
      this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [context.getHandler(), context.getClass()]) ?? [];
    const requiredPermissions =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];

    // 未声明任何要求：只需已认证（由 AdminAuthGuard 保证），直接放行
    if (requiredRoles.length === 0 && requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const principal = request.principal;

    if (!principal || principal.realm !== 'admin') {
      throw BusinessException.forbidden(ErrorCode.PERMISSION_DENIED, '该接口仅限管理端访问');
    }

    if (requiredRoles.length > 0 && !requiredRoles.some((role) => principal.roles.includes(role))) {
      throw BusinessException.forbidden(ErrorCode.PERMISSION_DENIED, '当前角色无权访问该接口');
    }

    if (requiredPermissions.length > 0) {
      const granted =
        principal.permissions.includes(PERMISSION_WILDCARD) ||
        requiredPermissions.every((permission) => principal.permissions.includes(permission));

      if (!granted) {
        throw BusinessException.forbidden(ErrorCode.PERMISSION_DENIED, '当前账号缺少所需权限');
      }
    }

    return true;
  }
}
