/**
 * @CurrentUser() — 从请求上下文提取认证主体
 *
 * 用法：
 *   findAll(@CurrentUser() principal: AuthPrincipal)                  // 取整个主体
 *   findAll(@CurrentUser('userId') userId: string)                    // 取单个字段
 *   findAll(@OptionalUser() principal?: AuthPrincipal)                // 允许匿名的接口
 *
 * 注意：能取到值的前提是对应接口已通过 JwtAuthGuard（未被标记 @Public()）。
 */

import { InternalServerErrorException, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ErrorCode } from '../errors/error-code';
import type { AuthPrincipal, RequestWithContext } from '../types/request.type';

type PrincipalKey = keyof AuthPrincipal;

export const CurrentUser = createParamDecorator((key: PrincipalKey | undefined, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<RequestWithContext>();
  const principal = req.principal;

  if (!principal) {
    // 出现该错误说明接口缺少登录保护，属于编码错误而非用户错误
    throw new InternalServerErrorException({
      code: ErrorCode.INTERNAL_ERROR,
      message: '接口未正确配置认证守卫',
    });
  }

  return key ? principal[key] : principal;
});

/** 允许匿名访问的场景使用；未登录时返回 undefined 而不抛错 */
export const OptionalUser = createParamDecorator((key: PrincipalKey | undefined, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<RequestWithContext>();
  const principal = req.principal;

  if (!principal) return undefined;

  return key ? principal[key] : principal;
});
