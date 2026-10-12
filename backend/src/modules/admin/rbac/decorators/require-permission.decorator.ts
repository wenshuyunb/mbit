/**
 * `@RequirePermission(...)` — 声明接口所需的权限点
 *
 * 与 `@Roles(...)` 的分工：
 *   · `@Roles` 是**粗粒度**的角色门（「只有 SUPER_ADMIN 能进来」）
 *   · `@RequirePermission` 是**细粒度**的权限门（「需要 system:role:write」）
 * 两者由同一个 `RolesGuard` 消费，可同时使用（AND 关系）。
 *
 * 语义：列出的权限点**全部**需要（ALL-of），而非任一（ANY-of）。
 * 之所以选 ALL-of：权限点是「能力」而非「身份」，任一满足容易在叠加权限时
 * 意外放大授权范围；契约 §2.7.3 的每个接口也只声明一个权限点，实际不会用到多值。
 */

import { SetMetadata } from '@nestjs/common';

import type { AdminPermission } from '../admin-permission.constants';

export const PERMISSIONS_KEY = 'soulmap:permissions';

export const RequirePermission = (...permissions: readonly AdminPermission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);
