<script setup lang="ts">
/**
 * 答题页（分包 pkgTest）
 *
 * 职责：逐题作答、进度展示、断点续答、提交算分。
 *
 * ## ⚠ 2026-10-15 修掉的真实故障：题目被**静默跳过**
 *
 * 真机实测：用户在 52 题的情感测评里答到最后，提交被服务端拒绝
 * 「还有 4 道题未作答」，而未答的 4 道是**散落**在卷中的（第 10、34、37、49 题）。
 * 根因是自动跳题的竞态：
 *
 * ```
 * 点选项 → 180ms 后自动 next()   ← 定时器没有任何取消机制
 * 用户在这 180ms 内又点了「下一题」→ 第二次 next()
 * 结果：连跳两题，中间那道**从未显示**，也不会有答案
 * ```
 *
 * 修法分两层，缺一不可：
 *
 *   1. **消除竞态**：自动跳题的定时器可取消，任何手动翻页（上一题/下一题/题号跳转）
 *      与页面卸载都先 `clearTimeout`；同一次作答只留一个待执行的跳转；
 *   2. **让漏答可见可操作**：光修竞态不够 —— 已经漏掉的题必须能被发现。
 *      底部常驻「还有 N 题未作答 · 去补答」，点一下直接跳到第一道缺题；
 *      提交前也会引导过去，而不是让用户对着计数器自己找
 *      （52 题里找 4 道没答的题，靠人眼是不可能完成的任务）。
 *
 * 关键实现：
 *   · 答案立即写本地草稿（store 内），服务端按 2s 节流批量 upsert，杀进程不丢答案
 *   · 选项点击后自动跳下一题（可被手动翻页打断，见上）
 *   · 提交前强制同步剩余答案，避免服务端判定未答完
 */

import { computed, onUnmounted, ref } from 'vue';
import { onHide, onLoad, onUnload } from '@dcloudio/uni-app';

import { presentationByTestCode } from '@/config/modules';
import { createAutoAdvance } from '@/pkgTest/auto-advance';
import { useAppStore } from '@/store/app';
import { useTestStore } from '@/store/test';
import { goBack } from '@/utils/navigate';
import { confirm } from '@/utils/toast';

const appStore = useAppStore();
const testStore = useTestStore();

/** 提交中：防止重复提交 */
const submitting = ref(false);
const showJumpPanel = ref(false);

const question = computed(() => testStore.currentQuestion);
const progressText = computed(() => `${testStore.answeredCount} / ${testStore.total}`);

/**
 * 标题随模块走（人格 / 情感 / 心理状态）
 *
 * ⚠ 本页是 `navigationStyle: custom`，**没有原生标题栏、也没有原生返回按钮**，
 * 顶部这一行必须自己画 —— 顺带就有了"这是哪个模块"的位置：
 * 用户在情感测评里看到"人格测试"会以为自己点错了入口。
 */
const moduleTitle = computed(() => presentationByTestCode(testStore.paper?.testCode).entranceTitle);

const currentAnswer = computed<number | null>(() => {
  const current = question.value;
  if (!current) return null;
  return testStore.answers[current.questionId] ?? null;
});

/** 是否为最后一题 */
const isLast = computed(() => testStore.currentIndex >= testStore.total - 1);

/**
 * 当前题的**做法反馈**（沉浸式场景题专有）
 *
 * 用户选完一个做法后，先给他一句"这样做常见的后续"，再滑入下一幕 ——
 * 沉浸感主要来自"叙事 + 即时反馈"，而不是分支剧情。
 * 量表题没有这个字段，因此这里为 `null` 时走原来的快速跳题节奏。
 */
const currentFeedback = computed<string | null>(() => {
  const current = question.value;
  const selected = currentAnswer.value;
  if (!current || selected === null) return null;

  return current.options.find((option) => option.value === selected)?.feedback ?? null;
});

/** 是否为沉浸式场景题（由是否存在提问句判定） */
const isScenario = computed(() => Boolean(question.value?.scenarioPrompt));

/**
 * 自动跳题延时
 *
 * 220ms 而不是更短：要留出"看到自己点的选项被选中"的时间，
 * 太短会让人怀疑自己有没有点到（然后重复点击 —— 又回到竞态里）。
 */
const ADVANCE_DELAY_MS = 220;

/**
 * 场景题的跳题延时：要留出**读完那句反馈**的时间
 *
 * 1400ms 是"能读完一句话、又不至于让人等"的经验值。
 * 反馈只有十几个字，但一闪而过就等于没有 —— 那样这个功能就白做了。
 */
const SCENARIO_ADVANCE_DELAY_MS = 1400;

/**
 * 自动跳题控制器（见 `@/pkgTest/auto-advance` 的说明）
 *
 * ⚠ 这一段就是那次"静默漏答 4 题"的根因所在：原先写成 `setTimeout(() => next(), 180)`，
 * 句柄没保存、取消不掉，手动翻页后它照样触发 → 连跳两题 → 中间那道题从未显示。
 * 现在所有手动翻页路径（上一题 / 下一题 / 题号跳转 / 补答）都会先 `cancel()`。
 */
const autoAdvance = createAutoAdvance(ADVANCE_DELAY_MS, () => testStore.next());

onUnmounted(() => autoAdvance.cancel());
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

  // 作答后自动跳下一题（最后一题停留，等待用户提交）
  if (isLast.value) {
    autoAdvance.cancel();
    return;
  }

  // 场景题多留一会儿：用户要先读完那句即时反馈，再进入下一幕
  autoAdvance.schedule(isScenario.value ? SCENARIO_ADVANCE_DELAY_MS : ADVANCE_DELAY_MS);
};

/** 退出答题（自定义导航栏没有原生返回键，必须自己给一个） */
const quit = (): void => goBack('/pages/test/intro');

/** 上一题 / 下一题（手动翻页一律先取消待执行的自动跳题） */
const goPrev = (): void => {
  autoAdvance.cancel();
  testStore.prev();
};

const goNext = (): void => {
  autoAdvance.cancel();
  testStore.next();
};

/** 跳转到指定题号 */
const jumpTo = (index: number): void => {
  autoAdvance.cancel();
  testStore.goTo(index);
  showJumpPanel.value = false;
};

/** 跳到第一道未作答的题（漏答时的补救入口） */
const gotoFirstUnanswered = (): void => {
  const index = testStore.firstUnansweredIndex;
  if (index < 0) return;

  autoAdvance.cancel();
  testStore.goTo(index);
  showJumpPanel.value = false;
};

/** 提交 */
const submit = async (): Promise<void> => {
  if (submitting.value) return;

  if (!testStore.isComplete) {
    /**
     * 未答完时**不给"仍要提交"这个选项**
     *
     * 服务端规则是"题量不完整即拒绝算分"（`40006`），所以"仍要提交"必然是死路：
     * 用户点了、请求发了、被拒了，除了消耗信任没有任何作用。
     * 唯一的出路是把缺的题补上，所以对话框只有一个动作：去补答。
     */
    const go = await confirm({
      title: '还有题目没答',
      content: `还有 ${testStore.unansweredCount} 道题未作答，答完才能生成结果。已为你跳到第一道未作答的题。`,
      confirmText: '去补答',
      cancelText: '知道了',
    });
    if (go) gotoFirstUnanswered();
    return;
  }

  submitting.value = true;
  autoAdvance.cancel();

  try {
    const result = await testStore.submit();
    uni.redirectTo({
      // 结果页只依赖 sessionId，自行从服务端拉取算分结果（避免 URL 传递不一致的数据）
      url: `/pkgTest/pages/result?sessionId=${result.sessionId}`,
    });
  } catch (error) {
    /**
     * 服务端仍判定未答完（例如本地与服务端记录不一致）时，把用户送到缺题处
     *
     * 不做静默 `console.error`：那样用户只会看到"点了没反应" —— 这正是本次故障里
     * "提交也提交不了"的由来。请求层已弹出服务端文案，这里只负责把动作接上。
     */
    console.error('[quiz] 提交失败：', error);

    if (testStore.firstUnansweredIndex >= 0) {
      gotoFirstUnanswered();
    }
  } finally {
    submitting.value = false;
  }
};

/** 退出确认（避免误触丢失进度） */
onHide(() => {
  autoAdvance.cancel();
  // 切后台时立即同步一次，降低丢答案概率
  void testStore.syncAnswers();
});

onUnload(() => {
  autoAdvance.cancel();
  void testStore.syncAnswers();
});
</script>

<template>
  <view class="quiz">
    <!--
      顶栏：返回 + 模块标题
      ⚠ 本页是 `navigationStyle: custom`（自定义导航栏），系统**不会**给状态栏留位置，
      不自己加 `statusBarHeight` 的话，标题会直接贴到刘海/状态栏上。
    -->
    <view class="quiz__nav-bar" :style="{ paddingTop: `${appStore.statusBarHeight + 8}px` }">
      <text class="quiz__back" @tap="quit">‹</text>
      <text class="quiz__title">{{ moduleTitle }}</text>
      <text class="quiz__jump" @tap="showJumpPanel = true">题号</text>
    </view>

    <!-- 题目区 -->
    <view v-if="question" class="quiz__body">
      <!--
        沉浸式场景题（ADR-039）：情境叙述 + 提问 + 做法 + 即时反馈

        计量表题与场景题的唯一区别**只在排版**：数据侧两者都是"题干 + 若干选项"。
        因此这里不另开一个页面 —— 两套模板并存于同一页，
        断点续答、漏答补救、进度条这些都只有一份实现。
      -->
      <template v-if="isScenario">
        <text class="quiz__index">第 {{ testStore.currentIndex + 1 }} 幕 / 共 {{ testStore.total }} 幕</text>
        <view class="quiz__scene">
          <text class="quiz__scene-text">{{ question.content }}</text>
        </view>
        <text class="quiz__prompt">{{ question.scenarioPrompt }}</text>
      </template>

      <template v-else>
        <text class="quiz__index">第 {{ testStore.currentIndex + 1 }} 题 / 共 {{ testStore.total }} 题</text>
        <text class="quiz__content">{{ question.content }}</text>
      </template>

      <view class="quiz__options">
        <view
          v-for="option in question.options"
          :key="option.value"
          :class="['quiz__option', { 'is-selected': currentAnswer === option.value }]"
          @tap="select(option.value)"
        >
          <text class="quiz__option-label">{{ option.label }}</text>
          <text class="quiz__option-check">{{ currentAnswer === option.value ? '✓' : '' }}</text>
        </view>
      </view>

      <!-- 即时反馈：选完才出现，给用户一句"这样做常见的后续"（不评判对错） -->
      <view v-if="currentFeedback" class="quiz__feedback">
        <text class="quiz__feedback-text">{{ currentFeedback }}</text>
      </view>
    </view>

    <view v-else class="quiz__empty">
      <text>题目加载中…</text>
    </view>

    <!--
      底部：漏答提示 + 进度 + 操作
      ⚠ 进度条从顶部移到底部（用户要求）：顶部留给题目本身，
      进度属于"我做到哪了"的反馈，放在拇指附近的操作区更自然。
    -->
    <view class="quiz__footer">
      <view v-if="!testStore.isComplete && testStore.answeredCount > 0" class="quiz__gap" @tap="gotoFirstUnanswered">
        <text class="quiz__gap-text">还有 {{ testStore.unansweredCount }} 题未作答</text>
        <text class="quiz__gap-action">去补答 ›</text>
      </view>

      <view class="quiz__progress">
        <view class="quiz__progress-bar">
          <view class="quiz__progress-inner" :style="{ width: `${testStore.progress}%` }" />
        </view>
        <text class="quiz__counter">{{ progressText }}</text>
      </view>

      <view class="quiz__actions">
        <button
          class="quiz__nav"
          :class="{ 'is-disabled': testStore.currentIndex === 0 }"
          :disabled="testStore.currentIndex === 0"
          @tap="goPrev"
        >
          上一题
        </button>

        <button v-if="!isLast" class="quiz__nav quiz__nav--next" @tap="goNext">下一题</button>
        <button v-else class="quiz__submit" :disabled="submitting" @tap="submit">
          {{ submitting ? '正在分析…' : '提交并生成结果' }}
        </button>
      </view>
    </view>

    <!-- 题号面板 -->
    <view v-if="showJumpPanel" class="quiz__panel-mask" @tap="showJumpPanel = false">
      <view class="quiz__panel" @tap.stop>
        <text class="quiz__panel-title">跳转到题目</text>
        <text class="quiz__panel-hint">高亮为已作答，灰色为未作答</text>
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
  height: 100vh;
  padding: 0 $space-lg;
  background-color: $color-bg-card;

  /**
   * 顶栏内边距由模板按 `statusBarHeight` 动态设置（自定义导航栏需要自己让开状态栏），
   * 这里只负责高度与对齐 —— 两处都写 padding-top 会让人分不清谁在生效。
   */
  &__nav-bar {
    @include flex-between;
    padding-bottom: $space-sm;
  }

  &__back {
    width: 60rpx;
    font-size: 44rpx;
    font-weight: $font-weight-medium;
    line-height: 1;
    color: $color-text-primary;
  }

  &__title {
    flex: 1;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
    text-align: center;
  }

  &__body {
    flex: 1;
    padding-top: $space-lg;
    overflow-y: auto;
  }

  &__index {
    font-size: $font-size-sm;
    color: $color-text-placeholder;
  }

  &__jump {
    width: 60rpx;
    font-size: $font-size-sm;
    color: $color-primary;
    text-align: right;
  }

  &__content {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
    line-height: $line-height-base;
  }

  /**
   * 场景叙述（沉浸式场景题专用）
   *
   * 与量表题的"题干"刻意做出**观感差别**：量表题干是一行陈述，
   * 而场景是一段处境 —— 更大的行距、更宽的内边距、独立卡片，
   * 让人先"进入这个场景"，再看到提问。沉浸感有一半来自这里。
   */
  &__scene {
    padding: $space-lg;
    margin-top: $space-md;
    background-color: $color-bg-hover;
    border-radius: $radius-lg;
  }

  &__scene-text {
    font-size: $font-size-md;
    line-height: $line-height-loose;
    color: $color-text-primary;
  }

  &__prompt {
    display: block;
    margin-top: $space-lg;
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
    line-height: $line-height-base;
  }

  /**
   * 即时反馈
   *
   * 选完做法后出现的一句话，只描述"这样做的常见后续"，不评判对错。
   * 用主色淡底 + 左侧竖线，读起来像旁白而不是评分。
   */
  &__feedback {
    padding: $space-md $space-lg;
    margin-top: $space-md;
    background-color: $color-primary-fade;
    border-left: 6rpx solid $color-primary;
    border-radius: $radius-sm;
  }

  &__feedback-text {
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__options {
    margin-top: $space-xl;
  }

  /**
   * 选项
   *
   * `@include flex-between` 而不是单纯 padding：勾选标记要贴右边，
   * 与文字之间留出空间（否则长选项会把 ✓ 挤到换行处）
   */
  &__option {
    @include flex-between;
    min-height: 96rpx;
    padding: $space-md $space-lg;
    margin-bottom: $space-sm;
    border: 2rpx solid $color-border;
    border-radius: $radius-md;
    transition: all 0.15s ease;

    &.is-selected {
      background-color: $color-primary-fade;
      border-color: $color-primary;

      .quiz__option-label {
        font-weight: $font-weight-semibold;
        color: $color-primary;
      }

      .quiz__option-check {
        color: $color-primary;
      }
    }

    &:active {
      background-color: $color-bg-hover;
    }
  }

  &__option-label {
    flex: 1;
    font-size: $font-size-base;
    line-height: $line-height-base;
    color: $color-text-primary;
  }

  &__option-check {
    margin-left: $space-sm;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__empty {
    @include flex-center;
    flex: 1;
    color: $color-text-secondary;
  }

  &__footer {
    padding-top: $space-sm;
    background-color: $color-bg-card;
    border-top: 1rpx solid $color-divider;

    @include safe-area-padding-bottom($space-md);
  }

  &__gap {
    @include flex-between;
    padding: $space-xs $space-md;
    margin-bottom: $space-sm;
    background-color: $color-warning-fade;
    border-radius: $radius-sm;
  }

  &__gap-text {
    font-size: $font-size-xs;
    color: $color-warning;
  }

  &__gap-action {
    font-size: $font-size-xs;
    font-weight: $font-weight-semibold;
    color: $color-warning;
  }

  &__progress {
    display: flex;
    align-items: center;
    gap: $space-sm;
    margin-bottom: $space-sm;
  }

  &__progress-bar {
    flex: 1;
    overflow: hidden;
    height: 10rpx;
    background-color: $color-border;
    border-radius: $radius-round;
  }

  &__progress-inner {
    height: 100%;
    background: linear-gradient(90deg, $color-primary-light, $color-primary);
    border-radius: $radius-round;
    transition: width 0.25s ease;
  }

  &__counter {
    min-width: 120rpx;
    font-size: $font-size-xs;
    color: $color-text-secondary;
    text-align: right;
  }

  &__actions {
    display: flex;
    gap: $space-sm;
  }

  /**
   * 次级按钮（上一题 / 下一题）
   *
   * ⚠ 小程序 `<button>` 有三个默认样式会毁掉居中：
   *   ① `text-align: center` 只管水平，垂直方向靠 `line-height`（默认 2.5+ 会把文字顶出去）；
   *   ② 默认 `padding: 0 14px` 与 `margin`；
   *   ③ `::after` 的白边（`global.scss` 里已统一去掉，但 `display` 仍需自己设）。
   * 因此这里**两条路都锁**：`flex` 居中（能生效时）+ `line-height` 等于按钮高度
   * （flex 没作用到按钮内部文本节点时也不会跑偏）。
   */
  &__nav {
    @include flex-center;
    flex: 1;
    height: 88rpx;
    font-size: $font-size-base;
    font-weight: $font-weight-medium;
    line-height: 88rpx;
    color: $color-text-regular;
    background-color: $color-bg-hover;
    border-radius: $radius-round;

    &.is-disabled,
    &[disabled] {
      color: $color-text-placeholder;
      background-color: $color-bg-page;
    }

    &--next {
      color: $color-primary;
      background-color: $color-primary-fade;
    }
  }

  &__submit {
    flex: 1.6;
    // 与 `button-primary` 的 88rpx 等高：文字垂直居中的第二道保险（同 `&__nav`）
    line-height: 88rpx;

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
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__panel-hint {
    display: block;
    margin-top: $space-xxs;
    margin-bottom: $space-md;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
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
