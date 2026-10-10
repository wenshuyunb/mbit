/**
 * @Public() — 标记接口无需登录
 *
 * 安全默认：全局 JwtAuthGuard 默认拒绝所有未标记的接口。
 * 只有显式声明 @Public() 的接口才允许匿名访问（登录、健康检查、支付回调等）。
 */

import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'soulmap:is_public';

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
