/**
 * 静态路由表
 *
 * 划分原则（架构 §5.4）：
 *   - **静态路由**：与权限无关，所有登录用户可见（登录页、根布局、数据看板、404）
 *   - **动态路由**：按角色/权限点声明，见 `./asyncRoutes.ts`
 *
 * 说明：所有页面组件均使用动态 `import()` 懒加载，保证首屏体积最小（Element Plus 之外不预载业务代码）。
 */

import type { RouteRecordRaw } from 'vue-router';

/** 登录页路径 */
export const LOGIN_PATH = '/login';

/** 登录后默认落地页（数据看板） */
export const HOME_PATH = '/dashboard';

/** 根布局路由名称：动态路由通过 `router.addRoute(ROOT_ROUTE_NAME, route)` 注入到该布局下 */
export const ROOT_ROUTE_NAME = 'Root';

/** 登录后回跳地址的 query 参数名 */
export const REDIRECT_QUERY_KEY = 'redirect';

/**
 * 数据看板路由（静态路由）
 *
 * 看板是登录后的默认落地页，所有角色都可访问；页面内部再按 `dashboard:metrics:read`
 * 决定各指标卡是否渲染（Phase 7 接入真实数据）。
 */
export const DASHBOARD_ROUTE: RouteRecordRaw = {
  path: 'dashboard',
  name: 'Dashboard',
  component: () => import('@/views/dashboard/DashboardView.vue'),
  meta: {
    title: '数据看板',
    icon: 'DataLine',
    permissions: ['dashboard:metrics:read'],
  },
};

/** 静态路由表 */
export const staticRoutes: RouteRecordRaw[] = [
  {
    // 空白布局：登录页不展示侧边栏与顶栏
    path: LOGIN_PATH,
    component: () => import('@/layouts/BlankLayout.vue'),
    children: [
      {
        path: '',
        name: 'Login',
        component: () => import('@/views/login/LoginView.vue'),
        meta: { title: '管理员登录', public: true },
      },
    ],
  },
  {
    path: '/',
    name: ROOT_ROUTE_NAME,
    component: () => import('@/layouts/DefaultLayout.vue'),
    redirect: HOME_PATH,
    children: [DASHBOARD_ROUTE],
  },
  {
    // 兜底 404：放在最后声明（vue-router 会按路径评分排序，catch-all 优先级最低）
    // 注意：本路由**不标记 public**，未登录访问未知路径时仍会先跳登录页
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/error/NotFoundView.vue'),
    meta: { title: '页面不存在' },
  },
];
