/**
 * 权限判定工具（RBAC）
 *
 * 契约来源：架构 §9.3（`AdminUser ─N:M─ Role ─N:M─ Permission`）与 API_DESIGN §2.7.3（权限点清单）。
 *
 * 判定规则（与后端 RolesGuard 语义对齐）：
 *   1. `SUPER_ADMIN` 角色（或持有 `*` 权限点）为**通配**：任何角色/权限点判定均通过；
 *   2. 未声明所需角色/权限（undefined / null / 空数组）视为「不需要额外权限」，直接通过；
 *   3. 角色判定为「任一命中」；权限判定为「任一命中」，且支持**段级通配**：
 *      持有 `ai:prompt:*` 可满足 `ai:prompt:publish`（子段必须以 `:` 分隔，长度一致）。
 *
 * 说明：本文件是纯函数，不依赖 Pinia，可被路由守卫、菜单过滤、`v-permission` 指令（Phase 1）复用。
 */

import { WILDCARD, type AdminRole } from '@/constants';

/** 权限判定上下文（来自 auth store，登录后由 `GET /api/v1/admin/auth/me` 下发） */
export interface PermissionContext {
  /** 当前管理员角色码 */
  roles: readonly string[];
  /** 当前管理员权限点 */
  permissions: readonly string[];
}

/** 所需权限的声明形态：单个、多个，或未声明 */
export type PermissionRequirement = string | readonly string[] | null | undefined;

/** 所需角色的声明形态：单个、多个，或未声明 */
export type RoleRequirement = string | readonly string[] | null | undefined;

/** 创建判定上下文（自动把 undefined 归一为空数组，避免调用方到处判空） */
export const createPermissionContext = (
  roles?: readonly string[] | null,
  permissions?: readonly string[] | null,
): PermissionContext => ({
  roles: roles ?? [],
  permissions: permissions ?? [],
});

/** 把单个/多个声明归一为数组 */
const normalize = (requirement: PermissionRequirement): string[] => {
  if (requirement === null || requirement === undefined) return [];
  return typeof requirement === 'string' ? [requirement] : [...requirement];
};

/** 是否拥有全部权限（超级管理员） */
export const isSuperAdmin = (context: PermissionContext): boolean =>
  context.roles.includes('SUPER_ADMIN' satisfies AdminRole) || context.permissions.includes(WILDCARD);

/**
 * 角色判定
 * @param context 当前管理员上下文
 * @param required 需要的角色（任一命中即通过）；未声明则视为通过
 */
export const hasRole = (context: PermissionContext, required: RoleRequirement): boolean => {
  const requiredRoles = normalize(required);
  if (requiredRoles.length === 0) return true;
  if (isSuperAdmin(context)) return true;
  return requiredRoles.some((role) => context.roles.includes(role));
};

/**
 * 权限点段级匹配
 * @param held 持有的权限点（可含 `*` 通配段）
 * @param required 需要的权限点
 * @example matchesPermission('ai:prompt:*', 'ai:prompt:publish') === true
 */
export const matchesPermission = (held: string, required: string): boolean => {
  if (held === required) return true;
  if (!held.includes(WILDCARD)) return false;

  const heldSegments = held.split(':');
  const requiredSegments = required.split(':');
  if (heldSegments.length !== requiredSegments.length) return false;

  return heldSegments.every((segment, index) => segment === WILDCARD || segment === requiredSegments[index]);
};

/**
 * 权限点判定
 * @param context 当前管理员上下文
 * @param required 需要的权限点（任一命中即通过）；未声明则视为通过
 */
export const hasPermission = (context: PermissionContext, required: PermissionRequirement): boolean => {
  const requiredPermissions = normalize(required);
  if (requiredPermissions.length === 0) return true;
  if (isSuperAdmin(context)) return true;
  return requiredPermissions.some((permission) =>
    context.permissions.some((held) => matchesPermission(held, permission)),
  );
};

/**
 * 需要**同时**满足全部权限点（用于「导出并允许退款」这类组合场景）
 * 未声明所需权限时视为通过。
 */
export const hasAllPermissions = (context: PermissionContext, required: PermissionRequirement): boolean => {
  const requiredPermissions = normalize(required);
  if (requiredPermissions.length === 0) return true;
  if (isSuperAdmin(context)) return true;
  return requiredPermissions.every((permission) =>
    context.permissions.some((held) => matchesPermission(held, permission)),
  );
};

/**
 * 角色 + 权限点双重判定（角色的**任一**命中 且 权限点的**任一**命中）
 * 典型用途：路由守卫（`meta.roles` + `meta.permissions` 同时声明时）。
 */
export const hasAccess = (
  context: PermissionContext,
  required: { roles?: RoleRequirement; permissions?: PermissionRequirement },
): boolean => hasRole(context, required.roles) && hasPermission(context, required.permissions);

/**
 * 权限上下文是否已初始化（后端已下发角色或权限点）
 *
 * 说明：登录接口 / `GET /admin/auth/me` 未返回任何角色与权限点时，视为「权限体系尚未初始化」。
 */
export const isPermissionContextReady = (context: PermissionContext): boolean =>
  context.roles.length > 0 || context.permissions.length > 0;

/**
 * **界面门禁**判定（路由守卫、菜单可见性、按钮显隐使用）
 *
 * 语义与 `hasAccess` 的唯一区别：上下文未初始化时**放行**。
 * 原因：Phase 0/1 后端 admin 模块尚未下发角色与权限点，若严格拦截会导致登录后看不到任何菜单；
 * 而真正的鉴权始终由后端 `AdminAuthGuard` + `RolesGuard` 完成（架构 §14.1「默认拒绝」），
 * 前端门禁只负责「不给用户看见用不了的入口」，不承担安全职责。
 *
 * Phase 1 起后端下发角色/权限点后，本函数即等价于 `hasAccess`。
 */
export const canAccess = (
  context: PermissionContext,
  required: { roles?: RoleRequirement; permissions?: PermissionRequirement },
): boolean => !isPermissionContextReady(context) || hasAccess(context, required);
