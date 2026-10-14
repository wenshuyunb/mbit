<script setup lang="ts">
/**
 * 答题页（分包 pkgTest）
 *
 * 职责：逐题作答、进度展示、断点续答、提交算分。
 *
 * 关键实现：
 *   · 答案立即写本地草稿（store 内），服务端按 2s 节流批量 upsert，杀进程不丢答案
 *   · 支持左右滑动切题 + 题号跳转
 *   · 提交前强制同步剩余答案，避免服务端判定未答完
 *
 * Phase 0 状态：交互与状态机完整（依赖 store/test.ts 的真实实现），
 *               题库数据来自服务端，Phase 2 联调。
 */

import { computed, ref } from 'vue';
import { onHide, onLoad, onUnload } from '@dcloudio/uni-app';

import { useTestStore } from '@/store/test';
import { useAppStore } from '@/store/app';
import { confirm } from '@/utils/toast';

const appStore = useAppStore();
const testStore = useTestStore();

/** 提交中：防止重复提交 */
const submitting = ref(false);
/** 选项切换动画锚点 */
const lastAnsweredId = ref<string | null>(null);

const question = computed(() => testStore.currentQuestion);
const showJumpPanel = ref(false);

const progressText = computed(() => `${testStore.answeredCount} / ${testStore.total}`);

const currentAnswer = computed<number | null>(() => {
  const current = question.value;
  if (!current) return null;
  return testStore.answers[current.questionId] ?? null;
});

/** 是否为最后一题 */
const isLast = computed(() => testStore.currentIndex >= testStore.total - 1);

onLoad(() => {
  // 直接进入答题页（如从分享链接）时没有会话，退回介绍页
  if (!testStore.paper) {
    uni.redirectTo({ url: '/pages/test/intro' });
  }
});

/** 选择某个选项 */
const select = (value: number): void => {
  const current = question.value;
  if (!current) return;

  testStore.answer(current.questionId, value);
  lastAnsweredId.value = current.questionId;

  // 作答后自动跳下一题（最后一题停留，等待用户提交）
  if (!isLast.value) {
    setTimeout(() => testStore.next(), 180);
  }
};

/** 上一题 / 下一题 */
const goPrev = (): void => testStore.prev();
const goNext = (): void => testStore.next();

/** 跳转到指定题号 */
const jumpTo = (index: number): void => {
  testStore.goTo(index);
  showJumpPanel.value = false;
};

/** 提交 */
const submit = async (): Promise<void> => {
  if (submitting.value) return;

  if (!testStore.isComplete) {
    const unanswered = testStore.total - testStore.answeredCount;
    const ok = await confirm({
      content: `还有 ${unanswered} 道题未作答，未作答的题目会影响结果准确度。确定要提交吗？`,
      confirmText: '继续作答',
      cancelText: '仍要提交',
    });
    // confirm 返回 true 表示点了「继续作答」，此处语义反转
    if (ok) return;
  }

  submitting.value = true;
  try {
    const result = await testStore.submit();
    uni.redirectTo({
      // 结果页只依赖 sessionId，自行从服务端拉取算分结果（避免 URL 传递不一致的数据）
      url: `/pkgTest/pages/result?sessionId=${result.sessionId}`,
    });
  } catch (error) {
    console.error('[quiz] 提交失败：', error);
  } finally {
    submitting.value = false;
  }
};

/** 退出确认（避免误触丢失进度） */
onHide(() => {
  // 切后台时立即同步一次，降低丢答案概率
  void testStore.syncAnswers();
});

onUnload(() => {
  void testStore.syncAnswers();
});
</script>

<template>
  <view class="quiz">
    <!--
      顶部：进度 + 题号
      ⚠ 本页在 pages.json 里是 `navigationStyle: custom`（自定义导航栏），
      系统**不会**给状态栏留位置 —— 不自己加 `statusBarHeight` 的话，
      进度条会直接贴在手机屏幕最上沿（刘海/状态栏上）。这里与首页保持一致的做法。
    -->
    <view class="quiz__header" :style="{ paddingTop: `${appStore.statusBarHeight + 12}px` }">
      <view class="quiz__progress-bar">
        <view class="quiz__progress-inner" :style="{ width: `${testStore.progress}%` }" />
      </view>
      <view class="quiz__header-row">
        <text class="quiz__counter">{{ progressText }}</text>
        <text class="quiz__jump" @tap="showJumpPanel = true">题号</text>
      </view>
    </view>

    <!-- 题目区 -->
    <view v-if="question" class="quiz__body">
      <text class="quiz__index">第 {{ testStore.currentIndex + 1 }} 题</text>
      <text class="quiz__content">{{ question.content }}</text>

      <view class="quiz__options">
        <view
          v-for="option in question.options"
          :key="option.value"
          :class="['quiz__option', { 'is-selected': currentAnswer === option.value }]"
          @tap="select(option.value)"
        >
          <text class="quiz__option-label">{{ option.label }}</text>
        </view>
      </view>
    </view>

    <view v-else class="quiz__empty">
      <text>题目加载中…</text>
    </view>

    <!-- 底部操作 -->
    <view class="quiz__footer">
      <button class="quiz__nav" :disabled="testStore.currentIndex === 0" @tap="goPrev">上一题</button>
      <button v-if="!isLast" class="quiz__nav" @tap="goNext">下一题</button>
      <button v-else class="quiz__submit" :disabled="submitting" @tap="submit">
        {{ submitting ? '正在分析…' : '提交并生成画像' }}
      </button>
    </view>

    <!-- 题号面板 -->
    <view v-if="showJumpPanel" class="quiz__panel-mask" @tap="showJumpPanel = false">
      <view class="quiz__panel" @tap.stop>
        <text class="quiz__panel-title">跳转到题目</text>
        <view class="quiz__panel-grid">
          <view
            v-for="(item, index) in testStore.paper?.questions ?? []"
            :key="item.questionId"
            :class="[
              'quiz__panel-item',
              {
                'is-answered': testStore.answers[item.questionId] !== undefined,
                'is-current': index === testStore.currentIndex,
              },
            ]"
            @tap="jumpTo(index)"
          >
            {{ index + 1 }}
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.quiz {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 0 $space-lg;
  background-color: $color-bg-card;

  /**
   * 顶部内边距由模板按 `statusBarHeight` 动态设置（自定义导航栏需要自己让开状态栏），
   * 这里只负责与题目区之间的间距 —— 两者都写 padding-top 会让人分不清谁在生效。
   */
  &__header {
    padding-bottom: $space-sm;
  }

  &__progress-bar {
    overflow: hidden;
    height: 8rpx;
    background-color: $color-border;
    border-radius: $radius-round;
  }

  &__progress-inner {
    height: 100%;
    background: linear-gradient(90deg, $color-primary-light, $color-primary);
    border-radius: $radius-round;
    transition: width 0.25s ease;
  }

  &__header-row {
    @include flex-between;
    margin-top: $space-sm;
  }

  &__counter {
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__jump {
    font-size: $font-size-sm;
    color: $color-primary;
  }

  &__body {
    flex: 1;
    padding-top: $space-xl;
  }

  &__index {
    display: block;
    font-size: $font-size-sm;
    color: $color-text-placeholder;
  }

  &__content {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
    line-height: $line-height-base;
  }

  &__options {
    margin-top: $space-xl;
  }

  &__option {
    padding: $space-md $space-lg;
    margin-bottom: $space-sm;
    border: 2rpx solid $color-border;
    border-radius: $radius-md;
    transition: all 0.15s ease;

    &.is-selected {
      background-color: $color-primary-fade;
      border-color: $color-primary;
    }

    &:active {
      background-color: $color-bg-hover;
    }
  }

  &__option-label {
    font-size: $font-size-base;
    color: $color-text-primary;
  }

  &__empty {
    @include flex-center;
    flex: 1;
    color: $color-text-secondary;
  }

  &__footer {
    display: flex;
    gap: $space-sm;
    padding: $space-md 0;

    @include safe-area-padding-bottom($space-md);
  }

  &__nav {
    flex: 1;
    height: 88rpx;
    font-size: $font-size-base;
    color: $color-text-regular;
    background-color: $color-bg-hover;
    border-radius: $radius-round;

    &[disabled] {
      opacity: 0.4;
    }
  }

  &__submit {
    flex: 2;

    @include button-primary;
  }

  &__panel-mask {
    position: fixed;
    inset: 0;
    z-index: $z-index-mask;
    background-color: $color-bg-mask;
  }

  &__panel {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    max-height: 70vh;
    padding: $space-lg;

    @include safe-area-padding-bottom($space-lg);

    overflow-y: auto;
    background-color: $color-bg-card;
    border-radius: $radius-xl $radius-xl 0 0;
  }

  &__panel-title {
    display: block;
    margin-bottom: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__panel-grid {
    display: flex;
    flex-wrap: wrap;
    gap: $space-sm;
  }

  &__panel-item {
    @include flex-center;
    width: 76rpx;
    height: 76rpx;
    font-size: $font-size-sm;
    color: $color-text-regular;
    background-color: $color-bg-hover;
    border-radius: $radius-sm;

    &.is-answered {
      color: $color-primary;
      background-color: $color-primary-fade;
    }

    &.is-current {
      color: $color-text-inverse;
      background-color: $color-primary;
    }
  }
}
</style>
