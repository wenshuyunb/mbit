/**
 * 手写的基础 API 类型（Phase 0 临时契约）
 *
 * ⚠️ 后续由 openapi-typescript 生成覆盖：
 *   1. 后端导出契约：`pnpm --filter @soulmap/server openapi:export` → 仓库根 `openapi.json`
 *      （架构 P10 / ADR-007：前后端契约由 OpenAPI 单向生成）
 *   2. 生成前端类型：`pnpm --filter @soulmap/admin api:types` → `src/types/openapi.d.ts`
 *   3. 之后业务代码应改为从 `openapi.d.ts` 取接口出入参类型，
 *      本文件仅保留「后端契约尚未覆盖」的通用结构（如登录态、分页请求参数）。
 *
 * 本文件是 `*.d.ts`（仅类型，无运行时代码），导入时必须使用 `import type`。
 */

/** 管理员账号状态（与后端 admin_users.status 一致） */
export type AdminStatus = 'ACTIVE' | 'DISABLED';

/** 管理员信息（GET /api/v1/admin/auth/me 返回） */
export interface AdminInfo {
  /** 管理员 ID（UUIDv7） */
  id: string;
  /** 登录账号 */
  username: string;
  /** 显示名 */
  nickname: string;
  /** 邮箱（可空） */
  email?: string | null;
  /** 账号状态 */
  status: AdminStatus;
  /** 角色码列表，如 ['SUPER_ADMIN'] */
  roles: string[];
  /** 权限点列表，如 ['user:user:read']；SUPER_ADMIN 为 ['*'] */
  permissions: string[];
  /** 上次登录时间（ISO 8601 UTC） */
  lastLoginAt?: string | null;
  /** 是否已完成敏感操作二次密码设置 */
  confirmPasswordEnabled?: boolean;
}

/** 管理员登录请求 */
export interface AdminLoginRequest {
  username: string;
  password: string;
}

/** 管理员登录/刷新成功返回 */
export interface AdminLoginResult {
  /** 管理员 AccessToken（JWT，有效期 1h） */
  accessToken: string;
  /** RefreshToken（不透明随机串，有效期 7d） */
  refreshToken: string;
  /** AccessToken 有效期（秒） */
  expiresIn: number;
  /** 管理员信息 */
  admin: AdminInfo;
}

/** 刷新令牌请求 */
export interface AdminRefreshRequest {
  refreshToken: string;
}

/** 修改密码请求 */
export interface AdminChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

/** 排序方向 */
export type SortOrder = 'asc' | 'desc';

/** 通用分页请求参数（pageSize 上限 100，由后端校验；见架构 §6.2） */
export interface PageQuery {
  page: number;
  pageSize: number;
  sortBy?: string;
  order?: SortOrder;
}

/** 通用分页返回结构 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

/** 看板指标项（Phase 7 由 GET /api/v1/admin/dashboard/metrics 返回） */
export interface MetricItem {
  /** 指标键，如 `paidConversionRate` */
  key: string;
  /** 指标中文名 */
  label: string;
  /** 指标值；缺失时为 null，前端展示占位符 */
  value: number | null;
  /** 单位，如 `%`、`分`、`次`；无单位时为空字符串 */
  unit: string;
  /** 同比/环比变化（百分数，可空） */
  changeRate?: number | null;
}
