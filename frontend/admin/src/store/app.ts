/**
 * 界面状态（app store）
 *
 * 职责：侧边栏折叠、主题（明亮/暗色）、面包屑开关等纯 UI 状态。
 * 持久化策略见 store/index.ts 的 PERSIST_CONFIG.app（`sidebarCollapsed`、`theme`）。
 */

import { defineStore } from 'pinia';

/** 主题模式 */
export type AppTheme = 'light' | 'dark';

/** 侧边栏展开宽度（与 DefaultLayout 的 el-aside 保持一致） */
export const SIDEBAR_WIDTH = '220px';

/** 侧边栏折叠宽度 */
export const SIDEBAR_COLLAPSED_WIDTH = '64px';

export interface AppState {
  /** 侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 主题 */
  theme: AppTheme;
  /** 是否展示面包屑 */
  showBreadcrumb: boolean;
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    sidebarCollapsed: false,
    theme: 'light',
    showBreadcrumb: true,
  }),

  getters: {
    /** 侧边栏当前宽度 */
    asideWidth: (state): string => (state.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH),

    /** 是否暗色主题 */
    isDark: (state): boolean => state.theme === 'dark',
  },

  actions: {
    /** 切换侧边栏折叠状态 */
    toggleSidebar(): void {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },

    /** 设置侧边栏折叠状态 */
    setSidebarCollapsed(collapsed: boolean): void {
      this.sidebarCollapsed = collapsed;
    },

    /** 设置主题并立即应用到 DOM */
    setTheme(theme: AppTheme): void {
      this.theme = theme;
      this.applyTheme();
    },

    /** 在明亮/暗色之间切换 */
    toggleTheme(): void {
      this.setTheme(this.theme === 'dark' ? 'light' : 'dark');
    },

    /**
     * 应用主题到 `<html>`：
     * Element Plus 的暗色主题基于 `html.dark` 类名（其暗色 CSS 变量已在 main.ts 引入）。
     */
    applyTheme(): void {
      if (typeof document === 'undefined') return;
      document.documentElement.classList.toggle('dark', this.theme === 'dark');
    },

    /** 是否展示面包屑 */
    setShowBreadcrumb(show: boolean): void {
      this.showBreadcrumb = show;
    },
  },
});
