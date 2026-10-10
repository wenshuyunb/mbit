<script setup lang="ts">
/**
 * 后台主布局
 *
 * 结构：左侧导航（可折叠）+ 顶栏（折叠开关、面包屑、主题切换、用户菜单）+ 内容区
 *
 * 菜单来源：`@/router/asyncRoutes` 的 menuRoutes（静态看板 + 动态权限模块），
 * 与路由表同源，保证「菜单可见 ⇔ 路由可入」一致；可见性判定复用 `canAccess`
 * （权限上下文由后端下发前不拦截，见 utils/permission.ts 的说明）。
 */

import { computed, type Component as VueComponent } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import {
  DataAnalysis,
  DataLine,
  Document,
  Expand,
  Files,
  Fold,
  MagicStick,
  Memo,
  Menu as MenuIcon,
  Money,
  Moon,
  Setting,
  Sunny,
  SwitchButton,
  TrendCharts,
  User,
  UserFilled,
} from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { menuRoutes } from '@/router/asyncRoutes';
import { HOME_PATH, LOGIN_PATH } from '@/router/routes';
import { useAppStore } from '@/store/app';
import { useAuthStore } from '@/store/auth';
import { canAccess, type PermissionContext } from '@/utils/permission';

/** 图标名 → 组件映射（路由 meta.icon 存字符串，避免路由表直接依赖组件实现） */
const ICON_MAP: Readonly<Record<string, VueComponent>> = {
  DataLine,
  DataAnalysis,
  Document,
  Files,
  MagicStick,
  Memo,
  Money,
  Setting,
  TrendCharts,
  User,
};

/** 侧边栏菜单项 */
interface MenuItem {
  /** 完整路径 */
  path: string;
  /** 标题 */
  title: string;
  /** 图标名 */
  icon: string;
}

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const authStore = useAuthStore();

const { sidebarCollapsed, theme } = storeToRefs(appStore);
const { displayName, primaryRoleLabel } = storeToRefs(authStore);

/** 取图标组件；未配置或名称未知时回落到通用菜单图标 */
const iconOf = (name: string): VueComponent => ICON_MAP[name] ?? MenuIcon;

/** 当前权限上下文 */
const permissionContext = computed<PermissionContext>(() => authStore.permissionContext);

/** 可见菜单（按 meta.hidden 与权限过滤） */
const menuItems = computed<MenuItem[]>(() =>
  menuRoutes
    .filter((item) => item.meta?.hidden !== true)
    .filter((item) =>
      canAccess(permissionContext.value, { roles: item.meta?.roles, permissions: item.meta?.permissions }),
    )
    .map((item) => ({
      path: `/${item.path}`,
      title: item.meta?.title ?? item.path,
      icon: item.meta?.icon ?? '',
    })),
);

/** 当前高亮的菜单项（Phase 1 支持详情页时需映射到父级路径） */
const activeMenu = computed<string>(() => route.path);

/** 面包屑：固定首项为数据看板，末项为当前页 */
const breadcrumbs = computed<{ title: string; path: string }[]>(() => {
  const currentTitle = route.meta.title ?? '';
  const items: { title: string; path: string }[] = [{ title: '数据看板', path: HOME_PATH }];
  if (currentTitle !== '' && route.path !== HOME_PATH) {
    items.push({ title: currentTitle, path: route.path });
  }
  return items;
});

/** 折叠/展开侧边栏 */
const toggleSidebar = (): void => {
  appStore.toggleSidebar();
};

/** 切换明亮/暗色主题 */
const toggleTheme = (): void => {
  appStore.toggleTheme();
};

/** 退出登录：二次确认 → 调用后端登出 → 清理本地登录态 → 回登录页 */
const handleLogout = async (): Promise<void> => {
  try {
    await ElMessageBox.confirm('退出后需要重新输入账号密码登录，确认退出？', '退出登录', {
      confirmButtonText: '确认退出',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    // 用户取消
    return;
  }

  await authStore.logout();
  ElMessage.success('已退出登录');
  await router.replace({ path: LOGIN_PATH });
};
</script>

<template>
  <el-container class="layout">
    <!-- 左侧导航 -->
    <el-aside class="layout__aside" :width="appStore.asideWidth">
      <div class="layout__logo">
        <span class="layout__logo-mark">SM</span>
        <span v-if="!sidebarCollapsed" class="layout__logo-text">SoulMap AI</span>
      </div>

      <el-scrollbar class="layout__menu-scroll">
        <el-menu
          class="layout__menu"
          router
          :default-active="activeMenu"
          :collapse="sidebarCollapsed"
          :collapse-transition="false"
        >
          <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
            <el-icon><component :is="iconOf(item.icon)" /></el-icon>
            <template #title>{{ item.title }}</template>
          </el-menu-item>
        </el-menu>
      </el-scrollbar>
    </el-aside>

    <el-container class="layout__body">
      <!-- 顶栏 -->
      <el-header class="layout__header">
        <div class="layout__header-left">
          <el-button
            text
            class="layout__icon-button"
            :title="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
            @click="toggleSidebar"
          >
            <el-icon :size="18">
              <Expand v-if="sidebarCollapsed" />
              <Fold v-else />
            </el-icon>
          </el-button>

          <el-breadcrumb separator="/">
            <el-breadcrumb-item v-for="item in breadcrumbs" :key="item.path" :to="{ path: item.path }">
              {{ item.title }}
            </el-breadcrumb-item>
          </el-breadcrumb>
        </div>

        <div class="layout__header-right">
          <el-button
            text
            class="layout__icon-button"
            :title="theme === 'dark' ? '切换为明亮主题' : '切换为暗色主题'"
            @click="toggleTheme"
          >
            <el-icon :size="18">
              <Sunny v-if="theme === 'dark'" />
              <Moon v-else />
            </el-icon>
          </el-button>

          <el-dropdown trigger="click">
            <span class="layout__user">
              <el-icon :size="18"><UserFilled /></el-icon>
              <span class="layout__user-name">{{ displayName }}</span>
              <el-tag size="small" type="info" effect="plain">{{ primaryRoleLabel }}</el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>当前角色：{{ primaryRoleLabel }}</el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">
                  <el-icon><SwitchButton /></el-icon>
                  退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 内容区 -->
      <el-main class="layout__main">
        <router-view v-slot="{ Component }">
          <transition name="layout-fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped lang="scss">
.layout {
  height: 100%;

  &__aside {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: var(--sm-bg-container);
    border-right: 1px solid var(--sm-border-color);
    transition: width 0.2s ease-in-out;
  }

  &__logo {
    display: flex;
    flex-shrink: 0;
    gap: $spacing-sm;
    align-items: center;
    height: $layout-header-height;
    padding: 0 $spacing-md;
    border-bottom: 1px solid var(--sm-border-color);
  }

  &__logo-mark {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    font-size: $font-size-xs;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.5px;
    background-color: $color-primary;
    border-radius: $radius-sm;
  }

  &__logo-text {
    font-size: $font-size-lg;
    font-weight: 600;
    white-space: nowrap;
    color: var(--sm-text-primary);
  }

  &__menu-scroll {
    flex: 1;
    min-height: 0;
  }

  &__menu {
    border-right: none;

    &:not(.el-menu--collapse) {
      width: 100%;
    }
  }

  &__body {
    min-width: 0;
  }

  &__header {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    height: $layout-header-height;
    padding: 0 $spacing-md;
    background-color: var(--sm-bg-container);
    border-bottom: 1px solid var(--sm-border-color);
  }

  &__header-left,
  &__header-right {
    display: flex;
    align-items: center;
    gap: $spacing-sm;
  }

  &__icon-button {
    padding: $spacing-xs;
    color: var(--sm-text-regular);

    &:hover {
      color: $color-primary;
    }
  }

  &__user {
    display: flex;
    gap: $spacing-sm;
    align-items: center;
    padding: $spacing-xs $spacing-sm;
    cursor: pointer;
    border-radius: $radius-sm;
    outline: none;
    transition: $transition-base;

    &:hover {
      background-color: var(--sm-bg-page);
    }
  }

  &__user-name {
    font-size: $font-size-base;
    color: var(--sm-text-primary);
  }

  &__main {
    padding: $layout-content-padding;
    overflow: auto;
    background-color: var(--sm-bg-page);
  }
}
</style>
