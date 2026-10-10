<script setup lang="ts">
/**
 * 合规免责声明组件
 *
 * 强制约定（架构文档 §1.2 / §14.4）：
 *   所有展示 AI 生成内容的页面都必须渲染本组件，文案由后端下发，
 *   禁止在页面里另写一份文案（合规文案必须可热更、且全站一致）。
 */

import { computed } from 'vue';
import { useAppStore } from '@/store/app';

interface Props {
  /** 文案类型：AI 内容通用声明 / 报告页脚声明 */
  variant?: 'aiContent' | 'reportFooter';
  /** 视觉样式：行内小字 / 卡片块 */
  display?: 'inline' | 'block';
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'aiContent',
  display: 'inline',
});

const appStore = useAppStore();

const text = computed(() => {
  const disclaimers = appStore.systemConfig.disclaimers;
  return props.variant === 'reportFooter' ? disclaimers.reportFooter : disclaimers.aiContent;
});
</script>

<template>
  <view :class="['disclaimer', `disclaimer--${display}`]">
    <text class="disclaimer__icon">ⓘ</text>
    <text class="disclaimer__text">{{ text }}</text>
  </view>
</template>

<style lang="scss" scoped>
.disclaimer {
  display: flex;
  gap: $space-xs;
  color: $color-text-secondary;

  &--inline {
    padding: $space-sm 0;
    font-size: $font-size-xs;
    line-height: $line-height-base;
  }

  &--block {
    padding: $space-md;
    margin-top: $space-md;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    background-color: $color-bg-hover;
    border-radius: $radius-md;
  }

  &__icon {
    flex-shrink: 0;
    color: $color-text-placeholder;
  }

  &__text {
    flex: 1;
  }
}
</style>
