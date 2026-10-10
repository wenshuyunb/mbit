/**
 * 管理员认证状态（auth store）
 *
 * 安全与持久化（架构 §9.2）：
 *   - AccessToken / RefreshToken **仅保存在内存**，刷新页面即失效，必须重新登录；
 *     这样即使前端产物存在 XSS 风险，也不会从 localStorage 中直接窃取长期凭证。
 *   - 仅 `admin` / `roles` / `permissions` 三类非敏感信息按 store/index.ts 的 PERSIST_CONFIG 持久化。
 *
 * ⚠️ Phase 1 待接入后端：
 *   - `login` / `refreshSession` / `loadCurrentAdmin` 已按 api/auth.ts 的接口契约实现调用；
 *   - **单飞刷新**（并发 401 只发一次 /admin/auth/refresh，其余请求排队等待）在 Phase 1 实现，
 *     实现位置：本文件的 `refreshSession`（配合 api/client.ts 注册的未授权处理器）；
 *   - 登录失败次数锁定（错误码 20011）的倒计时展示在 Phase 1 随登录页完善。
 */

import { defineStore } from 'pinia';
import * as authApi from '@/api/auth';
import { ADMIN_ROLE_LABELS, ADMIN_ROLES, isAdminRole, type AdminRole } from '@/constants';
import type { AdminInfo, AdminLoginRequest } from '@/types/api';
import {
  createPermissionContext,
  hasPermission as checkPermission,
  hasRole as checkRole,
  isSuperAdmin as checkSuperAdmin,
  type PermissionContext,
  type PermissionRequirement,
  type RoleRequirement,
} from '@/utils/permission';

/** 认证状态结构 */
export interface AuthState {
  /** 管理员 AccessToken（JWT，1h；仅内存） */
  accessToken: string;
  /** RefreshToken（7d；仅内存） */
  refreshToken: string;
  /** AccessToken 过期时间戳（ms）；0 表示未知 */
  expiresAt: number;
  /** 当前管理员信息 */
  admin: AdminInfo | null;
  /** 角色码（已过滤掉未知角色） */
  roles: AdminRole[];
  /** 权限点 */
  permissions: string[];
  /** 登录请求进行中 */
  loading: boolean;
}

/** 初始状态（登出与 $reset 共用） */
export const createInitialAuthState = (): AuthState => ({
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  admin: null,
  roles: [],
  permissions: [],
  loading: false,
});

export const useAuthStore = defineStore('auth', {
  // 持久化策略见 store/index.ts 的 PERSIST_CONFIG.auth
  state: createInitialAuthState,

  getters: {
    /** 是否已登录（内存中存在 AccessToken） */
    isLoggedIn: (state): boolean => state.accessToken !== '',

    /** 展示名：昵称 → 账号 → 未登录 */
    displayName: (state): string => state.admin?.nickname ?? state.admin?.username ?? '未登录',

    /** 主角色中文名（顶栏展示用） */
    primaryRoleLabel: (state): string => {
      const role = state.roles[0];
      return role ? ADMIN_ROLE_LABELS[role] : '未分配角色';
    },

    /** 权限判定上下文（供路由守卫、菜单过滤、v-permission 使用） */
    permissionContext: (state): PermissionContext => createPermissionContext(state.roles, state.permissions),

    /** 是否超级管理员（拥有全部权限） */
    isSuperAdmin(): boolean {
      return checkSuperAdmin(this.permissionContext);
    },
  },

  actions: {
    /** 写入登录结果（登录 / 刷新共用） */
    setSession(result: { accessToken: string; refreshToken: string; expiresIn: number; admin: AdminInfo }): void {
      this.accessToken = result.accessToken;
      this.refreshToken = result.refreshToken;
      this.expiresAt = result.expiresIn > 0 ? Date.now() + result.expiresIn * 1000 : 0;
      this.applyAdminInfo(result.admin);
    },

    /** 写入管理员信息并归一化角色/权限点 */
    applyAdminInfo(admin: AdminInfo): void {
      this.admin = admin;
      this.roles = admin.roles.filter(isAdminRole);
      this.permissions = [...admin.permissions];
    },

    /**
     * 管理员登录
     * @throws ApiError 登录失败（由登录页捕获并展示页内错误提示）
     */
    async login(payload: AdminLoginRequest): Promise<AdminInfo> {
      this.loading = true;
      try {
        // silent: 登录页使用页内 el-alert 展示错误，避免与全局 ElMessage 重复提示
        const result = await authApi.login(payload, { silent: true });
        this.setSession(result);
        return result.admin;
      } finally {
        this.loading = false;
      }
    },

    /**
     * 刷新访问令牌
     * Phase 1 补充：单飞（single-flight）——并发 401 只发一次刷新请求，其余请求等待同一 Promise；
     * 刷新失败（RT 过期/被作废）统一清理登录态并跳登录页。
     * @returns 是否刷新成功
     */
    async refreshSession(): Promise<boolean> {
      const current = this.refreshToken;
      if (current === '') return false;

      try {
        const result = await authApi.refresh({ refreshToken: current }, { silent: true });
        this.setSession(result);
        return true;
      } catch {
        this.clearSession();
        return false;
      }
    },

    /** 拉取当前管理员信息（路由守卫中用于校验登录态有效期，或登录后补齐角色/权限点） */
    async loadCurrentAdmin(): Promise<AdminInfo> {
      const admin = await authApi.fetchCurrentAdmin({ silent: true });
      this.applyAdminInfo(admin);
      return admin;
    },

    /** 登出：后端作废 RT（失败不阻塞前端清理） */
    async logout(): Promise<void> {
      try {
        if (this.accessToken !== '') await authApi.logout({ silent: true });
      } catch {
        // 后端登出失败时仍继续清理本地登录态（服务端 RT 会自然过期）
      } finally {
        this.clearSession();
      }
    },

    /** 清理内存登录态（401 处理、登出、刷新失败共用），同时清空已持久化的管理员信息 */
    clearSession(): void {
      this.$reset();
    },

    /** 角色判定（含 SUPER_ADMIN 通配） */
    hasRole(required: RoleRequirement): boolean {
      return checkRole(this.permissionContext, required);
    },

    /** 权限点判定（含 SUPER_ADMIN 通配与段级通配） */
    hasPermission(required: PermissionRequirement): boolean {
      return checkPermission(this.permissionContext, required);
    },

    /** 超级管理员角色码（供界面展示逻辑判断，避免各处硬编码字符串） */
    hasSuperAdminRole(): boolean {
      return this.roles.includes(ADMIN_ROLES[0]);
    },
  },
});
