<script setup lang="ts">
/**
 * 页面头部：标题 + 描述 + 操作区
 *
 * 用途：所有列表页/详情页统一使用，保证后台各页面视觉与结构一致。
 * 插槽：
 *   - `actions`：操作按钮区（右上角）
 *   - 默认插槽：与 actions 同区域，用于补充自定义内容
 */

defineProps<{
  /** 页面标题 */
  title: string;
  /** 页面说明（可选，用于解释页面用途） */
  description?: string;
  /** 是否展示底部细分割线，默认 true */
  bordered?: boolean;
}>();
</script>

<template>
  <header class="page-header" :class="{ 'page-header--bordered': bordered !== false }">
    <div class="page-header__main">
      <h2 class="page-header__title">{{ title }}</h2>
      <p v-if="description" class="page-header__description">{{ description }}</p>
    </div>

    <div class="page-header__actions">
      <slot name="actions" />
      <slot />
    </div>
  </header>
</template>

<style scoped lang="scss">
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: $spacing-md;
  padding-bottom: $spacing-md;

  &--bordered {
    border-bottom: 1px solid var(--sm-border-color);
  }

  &__main {
    min-width: 0;
  }

  &__title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.4;
    color: var(--sm-text-primary);
  }

  &__description {
    margin: $spacing-xs 0 0;
    font-size: 13px;
    line-height: 1.6;
    color: $color-text-secondary;
  }

  &__actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: $spacing-sm;
  }
}
</style>
