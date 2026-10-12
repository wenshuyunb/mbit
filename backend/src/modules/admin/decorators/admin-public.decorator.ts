/**
 * `@AdminPublic()` — 标记「管理端无需登录」的接口
 *
 * ## 为什么不能复用 `@Public()`
 *
 * 管理端控制器**全部**要标 `@Public()`，否则会被 `app.module.ts` 里全局注册的
 * **用户端** `JwtAuthGuard` 拦下（管理员令牌在用户 realm 下无法通过校验）。
 * 也就是说 `@Public()` 在管理端路由上的含义是「跳过用户端守卫」，
 * **不代表可以匿名访问**。
 *
 * 如果 `AdminAuthGuard` 也认 `@Public()`，那么每一个管理端接口都会变成完全公开 ——
 * 一个「看起来加了守卫」却实际裸奔的严重漏洞。因此管理端用独立标记：
 *   · `@Public()`      → 跳过用户端守卫（所有管理端控制器都要加）
 *   · `@AdminPublic()` → 跳过管理端守卫（**仅**登录/刷新这类本就该公开的接口）
 */

import { SetMetadata } from '@nestjs/common';

export const ADMIN_PUBLIC_KEY = 'soulmap:admin-public';

export const AdminPublic = (): MethodDecorator & ClassDecorator => SetMetadata(ADMIN_PUBLIC_KEY, true);
