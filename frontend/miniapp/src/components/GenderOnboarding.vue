<script setup lang="ts">
/**
 * 性别引导弹窗（ADR-039）
 *
 * ## 为什么要问
 *
 * 情感测评已改为**沉浸式场景题**，而"恋爱里会遇到什么处境"本身带性别角色差异
 * （谁先开口、见家长、生育、被说"太黏人/太冷淡"）。因此场景题分三套独立内容：
 * 男生版 / 女生版 / 中性版，报告措辞也按性别调整。**没有性别就出不了贴合的题**，
 * 所以必须在进入测评之前问一次。
 *
 * ## 为什么是三个选项而不是两个
 *
 * 只给「男生 / 女生」会强迫不愿归类或不愿透露的用户二选一，而他们给出的会是
 * **假数据** —— 假数据比缺失数据更糟：它会让人拿到一套明显不贴切的场景，
 * 却以为系统"就该这样"。因此第三个选项是「不想说」，走中性版场景，
 * 报告里也不出现性别化措辞。
 *
 * ## 为什么"不想说"也要写服务端
 *
 * 服务端据此记下"已经问过了"（`genderDeclaredAt`），否则换设备/清缓存后会再被问一遍。
 * 判断"要不要弹"只看服务端这一个标记 —— 不能用 `gender === 'UNKNOWN'` 代替，
 * 因为 `UNKNOWN` 既可能是"没问过"也可能是"问过但不说"。
 */

import { ref } from 'vue';

import type { UserGenderCode } from '@/api/user';
import { useAuthStore } from '@/store/auth';

const authStore = useAuthStore();

const saving = ref(false);

const OPTIONS: Array<{ value: UserGenderCode; label: string; desc: string; icon: string }> = [
  { value: 'MALE', label: '男生', desc: '场景与报告按男生视角出', icon: '👦' },
  { value: 'FEMALE', label: '女生', desc: '场景与报告按女生视角出', icon: '👧' },
  { value: 'UNKNOWN', label: '不想说', desc: '使用中性场景，同样完整体验', icon: '🙂' },
];

const emit = defineEmits<{ done: [] }>();

const choose = async (gender: UserGenderCode): Promise<void> => {
  if (saving.value) return;

  saving.value = true;
  try {
    await authStore.saveGender(gender);
    emit('done');
  } catch (error) {
    console.error('[gender] 保存失败：', error);
    uni.showToast({ title: '保存失败，请稍后重试', icon: 'none' });
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <view class="gender-mask">
    <view class="gender">
      <text class="gender__title">先告诉我你是男生还是女生</text>
      <text class="gender__desc">
        情感测评用的是恋爱与相处中的真实场景。不同性别的处境差别很大，所以场景与解读会按你的性别来出。
      </text>

      <view class="gender__options">
        <view
          v-for="option in OPTIONS"
          :key="option.value"
          :class="['gender__option', { 'is-disabled': saving }]"
          @tap="choose(option.value)"
        >
          <text class="gender__option-icon">{{ option.icon }}</text>
          <view class="gender__option-body">
            <text class="gender__option-label">{{ option.label }}</text>
            <text class="gender__option-desc">{{ option.desc }}</text>
          </view>
        </view>
      </view>

      <text class="gender__note">这个选择随时可以在「我的」里修改，已经生成的报告不会被改写。</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.gender-mask {
  position: fixed;
  inset: 0;
  z-index: $z-index-mask;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $space-lg;
  background-color: $color-bg-mask;
}

.gender {
  width: 100%;
  padding: $space-xl $space-lg;
  background-color: $color-bg-card;
  border-radius: $radius-xl;

  &__title {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
    text-align: center;
  }

  &__desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
    text-align: center;
  }

  &__options {
    margin-top: $space-lg;
  }

  &__option {
    @include flex-center(row);
    justify-content: flex-start;
    padding: $space-md;
    margin-bottom: $space-sm;
    background-color: $color-bg-hover;
    border: 2rpx solid transparent;
    border-radius: $radius-md;

    &:active {
      background-color: $color-primary-fade;
      border-color: $color-primary;
    }

    &.is-disabled {
      opacity: 0.5;
    }
  }

  &__option-icon {
    margin-right: $space-md;
    font-size: 40rpx;
  }

  &__option-body {
    flex: 1;
  }

  &__option-label {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-medium;
  }

  &__option-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__note {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-placeholder;
    text-align: center;
  }
}
</style>
