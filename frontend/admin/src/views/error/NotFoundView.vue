<script setup lang="ts">
/**
 * 404 页面
 *
 * 说明：本路由为顶层兜底路由（不在主布局内），因此需要自带返回入口。
 * 若用户已登录并停留在错误地址，也可通过浏览器后退或点击下方按钮回到看板。
 */

import { useRouter } from 'vue-router';
import EmptyState from '@/components/EmptyState.vue';
import { HOME_PATH } from '@/router/routes';

const router = useRouter();

/** 返回数据看板 */
const goHome = (): void => {
  void router.push(HOME_PATH);
};
</script>

<template>
  <div class="not-found">
    <div class="not-found__code">404</div>
    <EmptyState description="页面不存在或已被移除，请检查访问地址是否正确。">
      <el-button type="primary" @click="goHome">返回数据看板</el-button>
    </EmptyState>
  </div>
</template>

<style scoped lang="scss">
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: $spacing-xl;

  &__code {
    font-size: 72px;
    font-weight: 700;
    line-height: 1;
    color: $color-primary-light;
    letter-spacing: 4px;
  }
}
</style>
