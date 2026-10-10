<script setup lang="ts">
/**
 * 空状态组件
 *
 * 用于列表为空、未登录、未完成测试等场景。
 * 统一空状态交互，避免各页面各写一套。
 */

interface Props {
  /** 主文案 */
  title?: string;
  /** 补充说明 */
  description?: string;
  /** 按钮文案；不传则不显示按钮 */
  actionText?: string;
  /** 图标（emoji 占位，后续可替换为设计稿图片） */
  icon?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: '这里还是空的',
  description: '',
  actionText: '',
  icon: '🌱',
});

const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <view class="empty-state">
    <text class="empty-state__icon">{{ props.icon }}</text>
    <text class="empty-state__title">{{ props.title }}</text>
    <text v-if="props.description" class="empty-state__desc">{{ props.description }}</text>

    <button v-if="props.actionText" class="empty-state__action" @tap="emit('action')">
      {{ props.actionText }}
    </button>
  </view>
</template>

<style lang="scss" scoped>
.empty-state {
  @include flex-center(column);
  padding: $space-xxl $space-lg;

  &__icon {
    font-size: 96rpx;
    line-height: 1;
  }

  &__title {
    margin-top: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
    color: $color-text-primary;
  }

  &__desc {
    margin-top: $space-xs;
    font-size: $font-size-sm;
    color: $color-text-secondary;
    text-align: center;
  }

  &__action {
    min-width: 320rpx;
    margin-top: $space-lg;

    @include button-primary;
  }
}
</style>
