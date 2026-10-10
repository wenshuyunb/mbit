<script setup lang="ts">
/**
 * 通用「模块建设中」占位组件
 *
 * 用途：Phase 0 脚手架中，动态权限路由（用户/题库/Prompt/报告/订单/AI 统计/审计/设置）
 * 统一指向本组件，先打通「登录 → 布局 → 菜单 → 路由 → 权限声明 → 页面」的完整链路，
 * Phase 1 起逐个替换为真实业务页面。
 */

import { useRouter } from 'vue-router';
import EmptyState from '@/components/EmptyState.vue';
import PageHeader from '@/components/PageHeader.vue';
import { HOME_PATH } from '@/router/routes';

const props = withDefaults(
  defineProps<{
    /** 模块名称（由路由 props 注入） */
    title: string;
    /** 模块说明 */
    description?: string;
    /** 计划交付阶段 */
    phase?: string;
  }>(),
  {
    description: '',
    phase: 'Phase 1',
  },
);

const router = useRouter();

/** 返回数据看板 */
const goHome = (): void => {
  void router.push(HOME_PATH);
};
</script>

<template>
  <div class="sm-page module-placeholder">
    <PageHeader :title="props.title" :description="props.description">
      <template #actions>
        <el-tag type="warning" effect="plain">建设中 · {{ props.phase }}</el-tag>
      </template>
    </PageHeader>

    <el-card class="module-placeholder__card" shadow="never">
      <EmptyState :description="`${props.title}将在 ${props.phase} 交付，当前为 Phase 0 脚手架占位页面。`">
        <el-button type="primary" plain @click="goHome">返回数据看板</el-button>
      </EmptyState>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.module-placeholder {
  &__card {
    flex: 1;
    border-radius: var(--sm-radius-card);
  }
}
</style>
