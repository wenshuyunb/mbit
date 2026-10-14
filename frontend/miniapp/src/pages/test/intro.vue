<script setup lang="ts">
/**
 * 测试介绍页（主包）
 *
 * 职责：说明测试内容、时长与合规声明，引导开始测试，并处理断点续答入口。
 *
 * ## ADR-038：本页是**三个模块共用**的，文案按模块切换
 *
 * 通过 `?code=EMOTION_LITE` 进来时，标题/说明/维度数全部换成情感模块的那一套。
 * 文案来源是 `config/modules.ts`（**唯一来源**），不再写死在模板里 ——
 * 此前写死的结果是"情感测评的介绍页写着 MBTI + 大五人格双模型测评"，
 * 而这类错误不会报错，只会让用户以为两个模块是同一个东西。
 *
 * 题量与时长优先用**服务端下发的真实值**（`GET /tests/{code}`）：
 * 种子数据改了题量而这里硬编码，首屏就会出现与真实不符的数字。
 */

import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import { getTest, type TestDefinition } from '@/api/test';
import { modulePresentation } from '@/config/modules';
import { useTestStore } from '@/store/test';

/**
 * 测试定义编码
 *
 * 与后端 `test_definitions.code` 对应。默认 `MBTI_LITE`（32 题）；
 * 情感测评走 `?code=EMOTION_LITE`（52 题）。
 */
const definitionCode = ref('MBTI_LITE');

/** 服务端下发的定义（拿不到时为 null，页面用模块配置的兜底值渲染） */
const definition = ref<TestDefinition | null>(null);

const testStore = useTestStore();

/** 模块展示配置（未知模块走降级配置，不抛错） */
const presentation = computed(() => modulePresentation(definition.value?.module));

/** 本地是否存在未完成的草稿（断点续答） */
const hasDraft = computed(() => {
  const draft = uni.getStorageSync(`sm_test_draft_${definitionCode.value}`);
  return Boolean(draft);
});

/**
 * 展示用题量与时长
 *
 * 优先取服务端定义的真实值；未取到时显示 `—` 而不是猜一个数字 ——
 * 猜错会让用户以为是 32 题、结果点进去有 52 题。
 */
const questionCount = computed(() => definition.value?.questionCount ?? null);
const estimatedMinutes = computed(() => definition.value?.estimatedMinutes ?? null);
const questionCountText = computed(() => (questionCount.value === null ? '—' : String(questionCount.value)));
const estimatedMinutesText = computed(() => (estimatedMinutes.value === null ? '—' : `约 ${estimatedMinutes.value}`));

const starting = ref(false);

onLoad(async (query) => {
  const code = query?.['code'];
  if (typeof code === 'string' && code.length > 0) {
    definitionCode.value = code;
  }

  try {
    definition.value = await getTest(definitionCode.value);
  } catch (error) {
    // 取不到定义不阻塞页面：用模块配置的兜底文案 + `—` 渲染，
    // 真正的失败会在点「开始测试」时由 startTest 明确报出来
    console.error('[test/intro] 拉取测试定义失败：', error);
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
      <text class="intro__title">{{ presentation.introTitle }}</text>
      <text class="intro__desc">{{ presentation.introDesc }}</text>

      <view class="intro__meta">
        <view class="intro__meta-item">
          <text class="intro__meta-value">{{ questionCountText }}</text>
          <text class="intro__meta-label">题目数量</text>
        </view>
        <view class="intro__meta-item">
          <text class="intro__meta-value">{{ estimatedMinutesText }}</text>
          <text class="intro__meta-label">分钟</text>
        </view>
        <view class="intro__meta-item">
          <text class="intro__meta-value">{{ presentation.introMetricValue }}</text>
          <text class="intro__meta-label">{{ presentation.introMetricLabel }}</text>
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
