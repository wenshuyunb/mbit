/**
 * 全局 JWT 认证守卫
 *
 * 安全默认（架构 §14.1）：**默认拒绝**。未显式标记 `@Public()` 的接口一律要求登录。
 * 这样新增接口时忘记加保护会「不工作」而不是「裸奔」—— 失败的可见性远好于静默的漏洞。
 *
 * 错误归一化：passport 抛出的 UnauthorizedException 与业务错误码语义不一致，
 * 这里统一映射为 `TOKEN_EXPIRED` / `TOKEN_INVALID` / `UNAUTHORIZED`，
 * 使前端可以据此区分「过期需静默续期」与「无效需重新登录」。
 */

import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { AuthPrincipal, RequestWithContext } from '../../../common/types/request.type';
import { USER_JWT_STRATEGY } from '../strategies/jwt.strategy';

@Injectable()
export class JwtAuthGuard extends AuthGuard(USER_JWT_STRATEGY) {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  /**
   * 把认证结果写入请求上下文
   *
   * passport 默认放到 `request.user`，本项目的约定字段是 `request.principal`
   * （见 common/types/request.type.ts），在此统一转换，避免各 Controller 读到两套字段。
   */
  override handleRequest<TUser = AuthPrincipal>(
    err: Error | null,
    user: TUser | false,
    info: { message?: string; name?: string } | undefined,
    context: ExecutionContext,
  ): TUser {
    if (err) {
      // 策略内抛出的业务异常（realm 不匹配、黑名单命中）原样透出，保留精确错误码
      throw err;
    }

    if (!user) {
      throw this.mapAuthFailure(info);
    }

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    request.principal = user as unknown as AuthPrincipal;

    return user;
  }

  /** 依据 passport 的失败原因映射为精确的业务错误码 */
  private mapAuthFailure(info: { message?: string; name?: string } | undefined): BusinessException {
    const name = info?.name ?? '';
    const message = info?.message ?? '';

    if (name === 'TokenExpiredError' || message.includes('jwt expired')) {
      return BusinessException.unauthorized(ErrorCode.TOKEN_EXPIRED);
    }

    if (name === 'JsonWebTokenError' || message.includes('jwt')) {
      return BusinessException.unauthorized(ErrorCode.TOKEN_INVALID);
    }

    // 缺少 Authorization 头、格式不是 Bearer 等
    return BusinessException.unauthorized(ErrorCode.UNAUTHORIZED);
  }
}
