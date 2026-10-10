/**
 * 管理端常量与类型定义
 *
 * 来源：docs/PROJECT_ARCHITECTURE.md §9.3（RBAC）与 docs/API_DESIGN.md §2.7.3（权限点清单）
 * 约定：权限点命名统一为 `<domain>:<resource>:<action>`，与后端 `RolesGuard` 的校验字符串逐字一致。
 */

import { ErrorCode, errorMessageOf, isAuthErrorCode } from './error-code';

// ---------------------------------------------------------------- 角色

/** 内置管理员角色码（与后端 `admin_users.roles` / `AdminRole` 枚举一致） */
export const ADMIN_ROLES = ['SUPER_ADMIN', 'OPERATOR', 'CONTENT_EDITOR', 'FINANCE', 'ANALYST'] as const;

/** 管理员角色码 */
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** 通配角色/权限标识：SUPER_ADMIN 拥有全部权限点 */
export const WILDCARD = '*';

/** 角色码 → 中文名（用于界面展示） */
export const ADMIN_ROLE_LABELS: Readonly<Record<AdminRole, string>> = {
  SUPER_ADMIN: '超级管理员',
  OPERATOR: '运营',
  CONTENT_EDITOR: '内容编辑',
  FINANCE: '财务',
  ANALYST: '数据分析',
};

/** 运行时判定：后端返回的角色字符串是否是已知角色码 */
export const isAdminRole = (value: string): value is AdminRole => (ADMIN_ROLES as readonly string[]).includes(value);

// ---------------------------------------------------------------- 权限点

/** 权限点格式：`<domain>:<resource>:<action>` */
export type PermissionCode = `${string}:${string}:${string}`;

/**
 * 管理端权限点清单（API_DESIGN §2.7.3 完整清单）
 * 用途：路由 meta.permissions、菜单可见性、按钮级 `v-permission`（Phase 1 实现指令）。
 */
export const PERMISSIONS = {
  // 看板
  DASHBOARD_METRICS_READ: 'dashboard:metrics:read',

  // 用户
  USER_READ: 'user:user:read',
  USER_WRITE: 'user:user:write',
  USER_DELETION_READ: 'user:deletion:read',

  // 题库
  QUESTION_READ: 'test:question:read',
  QUESTION_WRITE: 'test:question:write',
  TEST_DEFINITION_READ: 'test:definition:read',
  TEST_DEFINITION_WRITE: 'test:definition:write',

  // Prompt
  PROMPT_READ: 'ai:prompt:read',
  PROMPT_WRITE: 'ai:prompt:write',
  PROMPT_PUBLISH: 'ai:prompt:publish',

  // AI 统计
  AI_STATS_READ: 'ai:stats:read',
  AI_CALLLOG_READ: 'ai:calllog:read',

  // 订单与支付
  ORDER_READ: 'payment:order:read',
  ORDER_REFUND: 'payment:order:refund',
  ORDER_EXPORT: 'payment:order:export',

  // 关系与报告
  RELATIONSHIP_READ: 'relationship:relationship:read',
  REPORT_READ: 'report:report:read',

  // 系统
  CONFIG_READ: 'system:config:read',
  CONFIG_WRITE: 'system:config:write',
  AUDIT_READ: 'system:audit:read',
  ADMIN_READ: 'system:admin:read',
  ADMIN_WRITE: 'system:admin:write',
  ROLE_READ: 'system:role:read',
  ROLE_WRITE: 'system:role:write',
} as const satisfies Record<string, PermissionCode>;

// ---------------------------------------------------------------- 平台标识

/**
 * 调用端标识：写入 `X-Platform` 请求头。
 * 后端据此校验 jwt realm 是否匹配（API_DESIGN §2.2、§2.7.1）：管理员接口只接受 `admin`。
 */
export const ADMIN_PLATFORM = 'admin';

export { ErrorCode, errorMessageOf, isAuthErrorCode };
