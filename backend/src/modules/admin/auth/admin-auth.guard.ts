/**
 * AdminAuthGuard — 管理端认证守卫
 *
 * 用法（管理端控制器的固定组合）：
 * ```ts
 * @Public()                                  // 跳过**用户端**全局守卫
 * @UseGuards(AdminAuthGuard, RolesGuard)     // 管理端认证 + RBAC
 * @RequirePermission('user:user:read')
 * @Controller('admin/users')
 * ```
 *
 * ⚠ 本守卫**只认 `@AdminPublic()`**，不认 `@Public()` —— 原因见
 * `decorators/admin-public.decorator.ts`：管理端所有控制器都必须标 `@Public()`
 * 来绕开用户端守卫，若本守卫也认它，管理端接口会全部变成公开接口。
 */

import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { AuthPrincipal, RequestWithContext } from '../../../common/types/request.type';
import { ADMIN_PUBLIC_KEY } from '../decorators/admin-public.decorator';
import { ADMIN_JWT_STRATEGY } from './admin-jwt.strategy';

@Injectable()
export class AdminAuthGuard extends AuthGuard(ADMIN_JWT_STRATEGY) {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isAdminPublic = this.reflector.getAllAndOverride<boolean>(ADMIN_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isAdminPublic) {
      return true;
    }

    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  /** 把认证结果写入 `request.principal`（与用户端守卫保持同一约定字段） */
  override handleRequest<TUser = AuthPrincipal>(
    err: Error | null,
    user: TUser | false,
    info: { message?: string; name?: string } | undefined,
    context: ExecutionContext,
  ): TUser {
    if (err) {
      // 策略内抛出的业务异常（realm 不匹配、会话已撤销）原样透出，保留精确错误码
      throw err;
    }

    if (!user) {
      throw this.mapAuthFailure(info);
    }

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    request.principal = user as unknown as AuthPrincipal;

    return user;
  }

  /**
   * 依据 passport 的失败原因映射为精确的业务错误码
   *
   * 跨 realm 令牌（用户令牌调管理端接口）在此表现为 `TOKEN_INVALID`：
   * 两端密钥不同，签名校验阶段就失败，解不出 realm 字段。这是双 realm 隔离
   * 生效的正常结果，不是缺陷（见 `admin-jwt.strategy.ts` 的说明）。
   */
  private mapAuthFailure(info: { message?: string; name?: string } | undefined): BusinessException {
    const name = info?.name ?? '';
    const message = info?.message ?? '';

    if (name === 'TokenExpiredError' || message.includes('jwt expired')) {
      return BusinessException.unauthorized(ErrorCode.TOKEN_EXPIRED);
    }

    if (name === 'JsonWebTokenError' || message.includes('jwt')) {
      return BusinessException.unauthorized(ErrorCode.TOKEN_INVALID);
    }

    return BusinessException.unauthorized(ErrorCode.UNAUTHORIZED);
  }
}
