/**
 * 动态权限路由表
 *
 * 设计（架构 §5.4、§9.3；权限点清单见 API_DESIGN §2.7.3）：
 *   - 每条路由通过 `meta.roles`（角色码）与 `meta.permissions`（权限点）声明访问要求；
 *   - 守卫（router/index.ts）用 `canAccess()` 判定是否放行；
 *   - 侧边栏菜单直接由本表派生（`menuRoutes`），保证「菜单可见 ⇔ 路由可入」一致。
 *
 * Phase 0 现状：后端 admin 模块（API_DESIGN §3.15，43 个接口）与权限下发未接入，
 *   因此本表中的页面统一渲染「模块建设中」占位组件（ModulePlaceholder），
 *   由 router/index.ts 静态注册，保证脚手架可完整浏览。
 * Phase 1：改为登录后按角色调用 `router.addRoute(ROOT_ROUTE_NAME, route)` 动态注入，
 *   页面组件替换为真实业务页面；未命中的路由不注册（而非注册后拦截）。
 */

import type { RouteRecordRaw } from 'vue-router';
import { DASHBOARD_ROUTE } from './routes';

/** 通用占位组件：接收 title / description，Phase 1 起逐个替换为真实页面 */
const placeholder = (title: string, description: string) => ({
  component: () => import('@/views/placeholder/ModulePlaceholder.vue'),
  props: { title, description },
});

/** 用户管理（运营 / 超管） */
const usersRoute: RouteRecordRaw = {
  path: 'users',
  name: 'UserList',
  ...placeholder('用户管理', '用户列表、资料查看、封禁与解封、数据导出与注销申请处理。'),
  meta: {
    title: '用户管理',
    icon: 'User',
    roles: ['SUPER_ADMIN', 'OPERATOR'],
    permissions: ['user:user:read'],
  },
};

/** 题库管理（内容编辑 / 超管） */
const questionsRoute: RouteRecordRaw = {
  path: 'questions',
  name: 'QuestionList',
  ...placeholder('题库管理', 'MBTI / Big Five 题库的增删改查、批量导入与测试定义配置。'),
  meta: {
    title: '题库管理',
    icon: 'Document',
    roles: ['SUPER_ADMIN', 'CONTENT_EDITOR'],
    permissions: ['test:question:read'],
  },
};

/** Prompt 管理（内容编辑 / 超管） */
const promptsRoute: RouteRecordRaw = {
  path: 'prompts',
  name: 'PromptList',
  ...placeholder('Prompt 管理', 'Prompt 模板与版本管理、变量校验、发布与回滚（敏感操作需二次确认）。'),
  meta: {
    title: 'Prompt 管理',
    icon: 'MagicStick',
    roles: ['SUPER_ADMIN', 'CONTENT_EDITOR'],
    permissions: ['ai:prompt:read'],
  },
};

/** 报告管理（运营 / 超管） */
const reportsRoute: RouteRecordRaw = {
  path: 'reports',
  name: 'ReportList',
  ...placeholder('报告管理', 'AI 报告生成记录查询、失败重试、内容抽检（默认脱敏，不含用户隐私原文）。'),
  meta: {
    title: '报告管理',
    icon: 'Files',
    roles: ['SUPER_ADMIN', 'OPERATOR'],
    permissions: ['report:report:read'],
  },
};

/** 订单管理（财务 / 超管） */
const ordersRoute: RouteRecordRaw = {
  path: 'orders',
  name: 'OrderList',
  ...placeholder('订单管理', '订单与支付记录查询、对账、退款（退款为敏感操作，需二次确认密码）。'),
  meta: {
    title: '订单管理',
    icon: 'Money',
    roles: ['SUPER_ADMIN', 'FINANCE'],
    permissions: ['payment:order:read'],
  },
};

/** AI 统计（分析 / 超管） */
const aiStatsRoute: RouteRecordRaw = {
  path: 'ai-stats',
  name: 'AiStats',
  ...placeholder('AI 统计', '调用量、Token 消耗与成本趋势、Provider 成功率与熔断状态，支持按任务类型下钻。'),
  meta: {
    title: 'AI 统计',
    icon: 'TrendCharts',
    roles: ['SUPER_ADMIN', 'ANALYST'],
    permissions: ['ai:stats:read'],
  },
};

/** 审计日志（超管） */
const auditRoute: RouteRecordRaw = {
  path: 'audit',
  name: 'AuditLog',
  ...placeholder('审计日志', '管理员操作审计（谁、何时、对什么、改了什么），支持按操作人/资源检索。'),
  meta: {
    title: '审计日志',
    icon: 'Memo',
    roles: ['SUPER_ADMIN'],
    permissions: ['system:audit:read'],
  },
};

/** 系统设置（超管） */
const settingsRoute: RouteRecordRaw = {
  path: 'settings',
  name: 'SystemSettings',
  ...placeholder('系统设置', '系统配置（免责声明文案、功能开关）、管理员账号与角色权限管理。'),
  meta: {
    title: '系统设置',
    icon: 'Setting',
    roles: ['SUPER_ADMIN'],
    permissions: ['system:config:read'],
  },
};

/**
 * 动态权限路由（挂在根布局路由下，路径为相对路径）
 * Phase 1：由登录后的权限拉取流程按需注入。
 */
export const asyncRoutes: RouteRecordRaw[] = [
  usersRoute,
  questionsRoute,
  promptsRoute,
  reportsRoute,
  ordersRoute,
  aiStatsRoute,
  auditRoute,
  settingsRoute,
];

/**
 * 侧边栏菜单数据源：静态看板 + 动态权限模块
 * 菜单项顺序即数组顺序；`meta.hidden` 为 true 的路由不进入菜单。
 */
export const menuRoutes: readonly RouteRecordRaw[] = [DASHBOARD_ROUTE, ...asyncRoutes];
