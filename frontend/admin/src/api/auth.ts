/**
 * 管理员认证接口（api 层）
 *
 * 契约来源：docs/API_DESIGN.md §2.7.1（L3 管理员，独立 realm）与 §9.2 双 realm 设计。
 *   - 管理端接口统一位于 `/api/v1/admin` 之下（api 层已配置 baseURL，这里只写相对路径）；
 *   - 鉴权使用 AdminAccessToken（`realm: admin`），与小程序用户 token 完全隔离（ADR-012）；
 *   - 管理员 AccessToken 有效期 1h、RefreshToken 7d（架构 §9.2），前端只在内存中保存。
 *
 * ⚠️ Phase 1 待后端落地：
 *   docs/API_DESIGN.md 的 §3.15（admin 模块，43 个接口）尚未展开明细，下列路径按
 *   §3.15 索引（`POST /admin/auth/login`）与命名规范（kebab-case、复数名词）拟定，
 *   后端 Swagger 产出 `openapi.json` 后应以生成类型为准（架构 P10 / ADR-007）。
 */

import type { AxiosRequestConfig } from 'axios';
import type {
  AdminChangePasswordRequest,
  AdminInfo,
  AdminLoginRequest,
  AdminLoginResult,
  AdminRefreshRequest,
} from '@/types/api';
import { http } from './client';

/** 管理员认证接口路径（集中声明，便于后端调整时一处修改） */
export const ADMIN_AUTH_ENDPOINTS = {
  /** 管理员账号密码登录 */
  LOGIN: '/admin/auth/login',
  /** 刷新令牌（RT 旋转，Phase 1 由 auth store 做单飞处理） */
  REFRESH: '/admin/auth/refresh',
  /** 登出当前会话 */
  LOGOUT: '/admin/auth/logout',
  /** 查询当前管理员信息（含 roles / permissions） */
  ME: '/admin/auth/me',
  /** 修改密码（敏感操作，需二次确认旧密码） */
  CHANGE_PASSWORD: '/admin/auth/password',
} as const;

/**
 * 管理员登录
 * @param payload 账号 + 密码
 * @param config 请求配置；登录页可传 `{ silent: true }` 以使用页内错误提示
 */
export const login = (payload: AdminLoginRequest, config?: AxiosRequestConfig): Promise<AdminLoginResult> =>
  http.post<AdminLoginResult>(ADMIN_AUTH_ENDPOINTS.LOGIN, payload, config);

/**
 * 刷新访问令牌（RT 旋转：后端签发新 RT 并作废旧 RT）
 * 说明：Phase 1 接入后，401 场景必须由 auth store 做**单飞**处理，避免并发风暴。
 */
export const refresh = (payload: AdminRefreshRequest, config?: AxiosRequestConfig): Promise<AdminLoginResult> =>
  http.post<AdminLoginResult>(ADMIN_AUTH_ENDPOINTS.REFRESH, payload, config);

/** 登出（后端作废当前 RefreshToken） */
export const logout = (config?: AxiosRequestConfig): Promise<void> =>
  http.post<void>(ADMIN_AUTH_ENDPOINTS.LOGOUT, undefined, config);

/** 获取当前管理员信息（登录态校验 + 角色/权限点来源） */
export const fetchCurrentAdmin = (config?: AxiosRequestConfig): Promise<AdminInfo> =>
  http.get<AdminInfo>(ADMIN_AUTH_ENDPOINTS.ME, config);

/** 修改密码（Phase 1 接入，敏感操作需后端二次校验） */
export const changePassword = (payload: AdminChangePasswordRequest, config?: AxiosRequestConfig): Promise<void> =>
  http.post<void>(ADMIN_AUTH_ENDPOINTS.CHANGE_PASSWORD, payload, config);
