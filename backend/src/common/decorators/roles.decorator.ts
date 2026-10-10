/**
 * @Roles(...) — 管理端 RBAC 角色要求
 *
 * 仅在管理端 realm 生效；用户端接口不应使用本装饰器。
 * 角色码见 PROJECT_ARCHITECTURE.md §9.3（SUPER_ADMIN / OPERATOR / CONTENT_EDITOR / FINANCE / ANALYST）
 */

import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'soulmap:roles';

export type AdminRoleCode = 'SUPER_ADMIN' | 'OPERATOR' | 'CONTENT_EDITOR' | 'FINANCE' | 'ANALYST';

export const Roles = (...roles: AdminRoleCode[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
