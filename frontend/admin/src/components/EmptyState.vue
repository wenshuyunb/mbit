<script setup lang="ts">
/**
 * 空状态组件
 *
 * 用途：列表无数据、图表无数据等场景的统一展示，避免各页面各写一套。
 * 插槽：默认插槽用于放置引导操作（如「新建」「返回」按钮），无内容时仅展示图片与描述。
 */

defineProps<{
  /** 描述文案，默认「暂无数据」 */
  description?: string;
  /** 图片尺寸（px），默认 96 */
  imageSize?: number;
  /** 紧凑模式：用于嵌入卡片内部的小区域 */
  compact?: boolean;
}>();
</script>

<template>
  <el-empty
    class="empty-state"
    :class="{ 'empty-state--compact': compact === true }"
    :description="description ?? '暂无数据'"
    :image-size="imageSize ?? 96"
  >
    <slot />
  </el-empty>
</template>

<style scoped lang="scss">
.empty-state {
  padding: $spacing-lg 0;

  &--compact {
    padding: $spacing-sm 0;

    :deep(.el-empty__image) {
      width: 72px;
    }
  }
}
</style>
