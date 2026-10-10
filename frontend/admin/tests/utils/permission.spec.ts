/**
 * 权限判定单元测试
 *
 * 覆盖重点（对应架构 §9.3 RBAC 与 API_DESIGN §2.7.3 权限点清单）：
 *   - SUPER_ADMIN 通配（角色与权限点判定均通过）
 *   - 空权限集：未声明需求时通过，声明需求时拒绝
 *   - 未知角色不授予任何权限
 *   - 权限点段级通配匹配（`ai:prompt:*`）
 *   - 界面门禁 canAccess：权限上下文未初始化时放行（Phase 0/1 后端未下发权限的场景）
 */

import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@/constants';
import {
  canAccess,
  createPermissionContext,
  hasAccess,
  hasAllPermissions,
  hasPermission,
  hasRole,
  isPermissionContextReady,
  isSuperAdmin,
  matchesPermission,
} from '@/utils/permission';

/** 超级管理员：SUPER_ADMIN 角色 + `*` 权限点 */
const superAdmin = createPermissionContext(['SUPER_ADMIN'], ['*']);
/** 运营：仅用户与订单只读权限 */
const operator = createPermissionContext(['OPERATOR'], ['user:user:read', 'payment:order:read']);
/** 权限上下文未初始化（后端未下发角色/权限点） */
const empty = createPermissionContext();
/** 后端下发了未知角色（例如角色码变更后前端未同步） */
const unknownRole = createPermissionContext(['UNKNOWN_ROLE'], []);

describe('utils/permission —— 角色判定', () => {
  it('SUPER_ADMIN 通配：任意角色判定均通过', () => {
    expect(isSuperAdmin(superAdmin)).toBe(true);
    expect(hasRole(superAdmin, 'FINANCE')).toBe(true);
    expect(hasRole(superAdmin, ['CONTENT_EDITOR', 'ANALYST'])).toBe(true);
  });

  it('角色任一命中即通过；未声明所需角色则通过', () => {
    expect(hasRole(operator, ['SUPER_ADMIN', 'OPERATOR'])).toBe(true);
    expect(hasRole(operator, 'OPERATOR')).toBe(true);
    expect(hasRole(operator, ['FINANCE', 'ANALYST'])).toBe(false);
    expect(hasRole(operator, undefined)).toBe(true);
    expect(hasRole(operator, [])).toBe(true);
  });

  it('未知角色不授予任何角色与权限', () => {
    expect(isSuperAdmin(unknownRole)).toBe(false);
    expect(hasRole(unknownRole, 'OPERATOR')).toBe(false);
    expect(hasPermission(unknownRole, PERMISSIONS.USER_READ)).toBe(false);
  });
});

describe('utils/permission —— 权限点判定', () => {
  it('权限点精确匹配与段级通配匹配', () => {
    expect(matchesPermission('user:user:read', 'user:user:read')).toBe(true);
    expect(matchesPermission('ai:prompt:*', 'ai:prompt:publish')).toBe(true);
    expect(matchesPermission('ai:*:publish', 'ai:prompt:publish')).toBe(true);
    expect(matchesPermission('ai:prompt:*', 'ai:stats:read')).toBe(false);
    // 段数不同不予匹配，避免 `ai:prompt` 误匹配 `ai:prompt:publish`
    expect(matchesPermission('ai:prompt', 'ai:prompt:publish')).toBe(false);
    expect(matchesPermission('user:user:read', 'user:user:write')).toBe(false);
  });

  it('SUPER_ADMIN 通配：任意权限点判定均通过', () => {
    expect(hasPermission(superAdmin, PERMISSIONS.ROLE_WRITE)).toBe(true);
    expect(hasAllPermissions(superAdmin, [PERMISSIONS.ROLE_WRITE, PERMISSIONS.ORDER_REFUND])).toBe(true);
  });

  it('空权限集：声明需求时拒绝，未声明需求时通过', () => {
    expect(hasPermission(empty, PERMISSIONS.ORDER_REFUND)).toBe(false);
    expect(hasPermission(empty, undefined)).toBe(true);
    expect(hasPermission(empty, [])).toBe(true);
  });

  it('多个所需权限点：hasPermission 为「任一命中」，hasAllPermissions 为「全部命中」', () => {
    expect(hasPermission(operator, [PERMISSIONS.ORDER_REFUND, PERMISSIONS.USER_READ])).toBe(true);
    expect(hasAllPermissions(operator, [PERMISSIONS.ORDER_REFUND, PERMISSIONS.USER_READ])).toBe(false);
    expect(hasAllPermissions(operator, [PERMISSIONS.USER_READ, PERMISSIONS.ORDER_READ])).toBe(true);
  });

  it('角色 + 权限同时声明时按「与」判定（hasAccess）', () => {
    expect(hasAccess(operator, { roles: ['OPERATOR'], permissions: [PERMISSIONS.USER_READ] })).toBe(true);
    expect(hasAccess(operator, { roles: ['OPERATOR'], permissions: [PERMISSIONS.ORDER_READ] })).toBe(true);
    expect(hasAccess(operator, { roles: ['OPERATOR'], permissions: [PERMISSIONS.USER_WRITE] })).toBe(false);
    // 角色不满足时，即使权限点满足也不放行
    expect(hasAccess(operator, { roles: ['FINANCE'], permissions: [PERMISSIONS.ORDER_READ] })).toBe(false);
    expect(hasAccess(superAdmin, { roles: ['FINANCE'], permissions: [PERMISSIONS.ORDER_REFUND] })).toBe(true);
  });
});

describe('utils/permission —— 界面门禁（canAccess）', () => {
  it('权限上下文未初始化时放行（Phase 0/1 后端未下发 roles/permissions）', () => {
    expect(isPermissionContextReady(empty)).toBe(false);
    expect(canAccess(empty, { roles: ['SUPER_ADMIN'], permissions: [PERMISSIONS.USER_READ] })).toBe(true);
  });

  it('权限上下文已初始化时按角色 + 权限严格拦截', () => {
    expect(isPermissionContextReady(operator)).toBe(true);
    expect(canAccess(operator, { roles: ['OPERATOR'], permissions: [PERMISSIONS.USER_READ] })).toBe(true);
    expect(canAccess(operator, { roles: ['FINANCE'], permissions: [PERMISSIONS.USER_READ] })).toBe(false);
    expect(canAccess(operator, { roles: ['OPERATOR'], permissions: [PERMISSIONS.ORDER_REFUND] })).toBe(false);
  });

  it('canAccess 与 hasAccess 的差异仅体现在「上下文未初始化」时', () => {
    expect(hasAccess(empty, { roles: ['OPERATOR'] })).toBe(false);
    expect(canAccess(empty, { roles: ['OPERATOR'] })).toBe(true);
  });
});

describe('constants —— 权限点命名规范', () => {
  it('全部权限点均为 <domain>:<resource>:<action> 三段式', () => {
    const codes = Object.values(PERMISSIONS);
    expect(codes.length).toBeGreaterThan(0);

    for (const code of codes) {
      expect(code.split(':')).toHaveLength(3);
      expect(code).toBe(code.toLowerCase());
    }
  });
});
