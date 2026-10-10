<script setup lang="ts">
/**
 * 测试介绍页（主包）
 *
 * 职责：说明测试内容、时长与合规声明，引导开始测试，并处理断点续答入口。
 *
 * Phase 0 状态：页面结构与交互完整，测试定义数据为静态占位；
 *               Phase 2 接入 GET /tests 与本地草稿恢复状态。
 */

import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import { useTestStore } from '@/store/test';

/**
 * 测试定义编码
 *
 * 与后端 `test_definitions.code` 对应。当前默认使用已上架的 `MBTI_LITE`（32 题）；
 * `MBTI_FULL`（64 题深度版）在后端仍为 DRAFT 状态（配套题库尚未灌入），
 * 若在此引用会得到「测试已下架」错误 —— Phase 2b 内容增量完成后再切换默认值。
 */
const definitionCode = ref('MBTI_LITE');

const testStore = useTestStore();

/** 本地是否存在未完成的草稿（断点续答） */
const hasDraft = computed(() => {
  const draft = uni.getStorageSync(`sm_test_draft_${definitionCode.value}`);
  return Boolean(draft);
});

/**
 * 展示用题量与时长
 *
 * 优先取服务端定义的真实值（`testStore.startTest` 后从试卷快照得知）；
 * 这里的默认值与后端种子数据保持一致，避免首屏出现与真实不符的数字。
 */
const estimatedMinutes = ref(5);
const questionCount = ref(32);

const starting = ref(false);

onLoad((query) => {
  const code = query?.['code'];
  if (typeof code === 'string' && code.length > 0) {
    definitionCode.value = code;
  }
});

const start = async (): Promise<void> => {
  if (starting.value) return;
  starting.value = true;

  try {
    await testStore.startTest(definitionCode.value, { resume: true });
    uni.navigateTo({ url: '/pkgTest/pages/quiz' });
  } catch (error) {
    console.error('[test/intro] 开始测试失败：', error);
  } finally {
    starting.value = false;
  }
};

const discardDraft = (): void => {
  testStore.clearDraft(definitionCode.value);
  uni.showToast({ title: '已清除答题记录', icon: 'none' });
};
</script>

<template>
  <view class="intro page-container">
    <view class="intro__header card">
      <text class="intro__title">MBTI + 大五人格双模型测评</text>
      <text class="intro__desc">
        基于荣格类型学与五因素人格理论，从四个维度与五个特质描绘你的人格轮廓，再由 AI 生成个性化解读。
      </text>

      <view class="intro__meta">
        <view class="intro__meta-item">
          <text class="intro__meta-value">{{ questionCount }}</text>
          <text class="intro__meta-label">题目数量</text>
        </view>
        <view class="intro__meta-item">
          <text class="intro__meta-value">约 {{ estimatedMinutes }}</text>
          <text class="intro__meta-label">分钟</text>
        </view>
        <view class="intro__meta-item">
          <text class="intro__meta-value">15</text>
          <text class="intro__meta-label">个分析维度</text>
        </view>
      </view>
    </view>

    <view v-if="hasDraft" class="intro__draft card">
      <view class="intro__draft-info">
        <text class="intro__draft-title">检测到未完成的答题</text>
        <text class="intro__draft-desc">可以从中断的地方继续，已答题目不会丢失</text>
      </view>
      <text class="intro__draft-discard" @tap="discardDraft">重新开始</text>
    </view>

    <view class="intro__tips card">
      <text class="intro__tips-title">答题小提示</text>
      <text class="intro__tips-item">· 凭第一直觉作答，不必反复斟酌</text>
      <text class="intro__tips-item">· 没有对错之分，真实回答更准确</text>
      <text class="intro__tips-item">· 中途退出会被记录，可随时继续</text>
    </view>

    <SafetyDisclaimer display="block" />

    <view class="intro__footer" :class="{ 'is-loading': starting }">
      <button class="intro__button" :disabled="starting" @tap="start">
        {{ starting ? '正在准备题目…' : hasDraft ? '继续测试' : '开始测试' }}
      </button>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.intro {
  padding-bottom: 200rpx;

  &__title {
    display: block;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
  }

  &__desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__meta {
    display: flex;
    margin-top: $space-lg;
  }

  &__meta-item {
    flex: 1;
    text-align: center;
  }

  &__meta-value {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    color: $color-primary;
  }

  &__meta-label {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__draft {
    @include flex-between;
    margin-top: $space-md;
    border: 2rpx solid $color-primary-fade;
  }

  &__draft-info {
    flex: 1;
  }

  &__draft-title {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-semibold;
  }

  &__draft-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__draft-discard {
    font-size: $font-size-sm;
    color: $color-primary;
  }

  &__tips {
    margin-top: $space-md;
  }

  &__tips-title {
    display: block;
    margin-bottom: $space-sm;
    font-size: $font-size-base;
    font-weight: $font-weight-semibold;
  }

  &__tips-item {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    color: $color-text-regular;
  }

  &__footer {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    padding: $space-md $space-lg;

    @include safe-area-padding-bottom($space-md);

    background-color: $color-bg-card;
    box-shadow: 0 -4rpx 20rpx rgba(31, 31, 46, 0.06);
  }

  &__button {
    @include button-primary;

    &[disabled] {
      opacity: 0.7;
    }
  }
}
</style>
