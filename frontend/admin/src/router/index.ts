/**
 * 路由实例与导航守卫
 *
 * 职责：
 *   1. `createWebHistory` 模式（history 路由），base 取 `import.meta.env.BASE_URL`，
 *      部署到 `/admin/` 子路径时只需调整 Vite 的 `base`，无需改代码。
 *   2. 导航守卫：未登录一律跳登录页并记录回跳地址；已登录访问登录页则回到落地页；
 *      按 `meta.roles` / `meta.permissions` 做界面门禁（真正的鉴权在后端，见 utils/permission.ts）。
 *   3. 注册「未授权处理器」：api/client.ts 捕获 401 或认证类错误码时回调这里，
 *      统一清理内存登录态并跳转登录页 —— 用注册回调而非直接 import，避免 api ↔ router ↔ store 循环依赖。
 *   4. 同步浏览器标题。
 */

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { setUnauthorizedHandler } from '@/api/client';
import type { AdminRole } from '@/constants';
import { useAuthStore } from '@/store/auth';
import { canAccess } from '@/utils/permission';
import { asyncRoutes } from './asyncRoutes';
import { HOME_PATH, LOGIN_PATH, REDIRECT_QUERY_KEY, ROOT_ROUTE_NAME, staticRoutes } from './routes';

/** 路由元信息类型增强（全局生效，供 routes.ts / asyncRoutes.ts 使用） */
declare module 'vue-router' {
  interface RouteMeta {
    /** 页面标题（用于侧边栏菜单与浏览器标题） */
    title?: string;
    /** Element Plus 图标组件名（见 @element-plus/icons-vue） */
    icon?: string;
    /** 是否为公开路由（无需登录）；默认 false，即「默认拒绝」（架构 §14.1） */
    public?: boolean;
    /** 是否在侧边栏菜单中隐藏 */
    hidden?: boolean;
    /** 允许访问的角色码（任一命中） */
    roles?: readonly AdminRole[];
    /** 允许访问的权限点（任一命中，支持段级通配如 `ai:prompt:*`） */
    permissions?: readonly string[];
  }
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: staticRoutes,
  // 切换路由后回到顶部（列表页翻页返回时保持滚动位置的需求在 Phase 1 按页面单独处理）
  scrollBehavior: () => ({ top: 0 }),
});

/**
 * Phase 0：动态权限路由静态注册，保证脚手架可完整浏览（菜单项可直接点开占位页）。
 * Phase 1：改为登录成功、拿到 roles/permissions 之后按需 `addRoute`，并在登出时移除。
 */
const registerAsyncRoutes = (routes: readonly RouteRecordRaw[]): void => {
  for (const route of routes) {
    router.addRoute(ROOT_ROUTE_NAME, route);
  }
};

registerAsyncRoutes(asyncRoutes);

// ---------------------------------------------------------------- 导航守卫

router.beforeEach((to) => {
  const auth = useAuthStore();

  // ① 公开路由：登录页
  if (to.meta.public === true) {
    if (to.path === LOGIN_PATH && auth.isLoggedIn) return { path: HOME_PATH };
    return true;
  }

  // ② 未登录：跳登录页并记录来源，登录成功后回跳
  if (!auth.isLoggedIn) {
    return { path: LOGIN_PATH, query: { [REDIRECT_QUERY_KEY]: to.fullPath } };
  }

  // ③ 界面门禁：无权限时不进入目标页（Phase 7 提供独立的 403 页面，当前回落到看板）
  if (!canAccess(auth.permissionContext, { roles: to.meta.roles, permissions: to.meta.permissions })) {
    return { path: HOME_PATH };
  }

  return true;
});

router.afterEach((to) => {
  const appTitle = import.meta.env.VITE_APP_TITLE || 'SoulMap AI 管理后台';
  const pageTitle = to.meta.title;
  document.title = pageTitle ? `${pageTitle} - ${appTitle}` : appTitle;
});

// ---------------------------------------------------------------- 未授权处理

/**
 * 401 / 认证类错误码：清理登录态 → 跳登录页。
 * 注意：并发多个请求同时 401 时，`router.replace` 会被多次调用，
 * vue-router 对相同目标会合并导航，不会产生重复跳转（Phase 1 引入单飞刷新后此路径将更少触发）。
 */
setUnauthorizedHandler((): void => {
  const auth = useAuthStore();
  const current = router.currentRoute.value;
  const redirectPath = current.path === LOGIN_PATH ? '' : current.fullPath;

  auth.clearSession();

  if (current.path === LOGIN_PATH) return;

  void router.replace({
    path: LOGIN_PATH,
    query: redirectPath === '' ? {} : { [REDIRECT_QUERY_KEY]: redirectPath },
  });
});

export default router;
