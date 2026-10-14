<script setup lang="ts">
/**
 * 测试结果页（分包 pkgTest）
 *
 * 展示：MBTI 四字母 + 四维倾向条 + Big Five 雷达图 + 置信度提示 + 生成报告入口
 *
 * 数据来源：`GET /tests/sessions/{id}/result`（服务端在提交时已同步算分并落库）。
 * 页面只依赖 URL 中的 `sessionId`，不接收其他数据 —— 避免出现「URL 里的类型」
 * 与「服务端落库的类型」不一致。
 */

import { computed, ref } from 'vue';
import { onLoad, onShareAppMessage } from '@dcloudio/uni-app';

import RadarChart from '@/components/RadarChart.vue';
import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import { getSessionResult, type TestSessionResult } from '@/api/test';
import { createReport, getReportProgress, progressStageLabel, type ReportStatus } from '@/api/report';
import { ApiError } from '@/api/types';
import { BIG_FIVE_DIMENSIONS, MBTI_DIMENSIONS } from '@/config/constants';
import { useAppStore } from '@/store/app';
import { goBack, goToPage } from '@/utils/navigate';

const appStore = useAppStore();

const sessionId = ref('');
const result = ref<TestSessionResult | null>(null);
const loading = ref(true);
const loadFailed = ref(false);
/** 报告生成进度（0–100）与状态，由轮询驱动 */
const reportProgress = ref(0);
const reportStatus = ref<ReportStatus | undefined>(undefined);
const generating = ref(false);
/** 本次生成出来的报告 id（失败/超时后仍可进详情页查看状态） */
const reportId = ref<string | null>(null);
/** 生成失败或超时的提示；成功与重新开始时清空 */
const generateError = ref<string | null>(null);

const summary = computed(() => result.value?.result ?? null);
const mbtiType = computed(() => summary.value?.mbtiType ?? null);
const mbtiLetters = computed(() => (mbtiType.value ?? '????').split(''));

/** 四维倾向（0–100，≥ 50 偏向正极字母），用于绘制双向条 */
const dimensionBars = computed(() =>
  MBTI_DIMENSIONS.map((dimension) => {
    // 服务端返回 { percent, pole, leftLabel, rightLabel }，percent ≥ 50 即偏向正极
    const percent = summary.value?.dimensions?.[dimension.key]?.percent ?? 50;
    return {
      key: dimension.key,
      label: dimension.label,
      positive: dimension.positive,
      negative: dimension.negative,
      positiveLabel: dimension.positiveLabel,
      negativeLabel: dimension.negativeLabel,
      percent,
      positiveWidth: percent,
      negativeWidth: 100 - percent,
    };
  }),
);

/** Big Five 雷达图数据 */
const radarDimensions = computed(() =>
  BIG_FIVE_DIMENSIONS.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    value: summary.value?.bigFive?.[dimension.key] ?? 0,
  })),
);

/**
 * 结果提示文案
 *
 * 优先使用服务端下发的 `quality.notice`（阈值由后端统一控制），
 * 避免前后端各写一套判断标准而出现文案矛盾。
 */
const qualityNotice = computed(() => summary.value?.quality?.notice ?? null);

onLoad(async (query) => {
  const id = query?.['sessionId'];
  if (typeof id === 'string') {
    sessionId.value = id;
  }

  if (!sessionId.value) {
    loading.value = false;
    loadFailed.value = true;
    return;
  }

  try {
    result.value = await getSessionResult(sessionId.value);
  } catch (error) {
    // 失败原因可能是会话未提交/已过期（409）或网络问题，此处统一展示可重试的提示
    console.error('[result] 拉取算分结果失败：', error);
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
});

onShareAppMessage(() => ({
  title: mbtiType.value ? `我的人格类型是 ${mbtiType.value}，你也来测测看` : '做一个 5 分钟的人格测评，认识真实的自己',
  path: '/pages/index/index',
}));

// ============================================================================
// 生成报告：真实链路（建任务 → 轮询进度 → 进入报告详情）
// ============================================================================

/**
 * 轮询间隔与总超时
 *
 * 后端是**异步任务**：`POST /reports` 返回 202 与 reportId，由 worker 生成。
 * 因此必须轮询；但也不能无限等 —— worker 未启动或网络异常时要有兜底，
 * 让用户至少能进详情页看到真实状态，而不是卡在一个转不动的按钮上。
 */
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 120_000;

/** 生成中的按钮文案：失败时直接显示原因，成功/进行中显示阶段 + 百分比 */
const generatingText = computed(() => {
  if (generateError.value !== null) return generateError.value;

  return `${progressStageLabel(reportStatus.value, reportProgress.value)} ${reportProgress.value}%`;
});

const openReportDetail = (id: string): void => {
  goToPage(`/pkgReport/pages/detail?id=${id}`);
};

/** 轮询直到终态；返回是否成功 */
const waitForReport = async (id: string): Promise<boolean> => {
  const deadline = Date.now() + POLL_MAX_MS;

  while (Date.now() < deadline) {
    const progress = await getReportProgress(id);
    reportProgress.value = progress.progress;
    reportStatus.value = progress.status;

    if (progress.status === 'SUCCEEDED') return true;

    if (progress.status === 'FAILED' || progress.status === 'CANCELLED') {
      generateError.value = progress.errorMessage ?? '报告生成失败，可稍后重试';

      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  generateError.value = '生成时间较长，已转入后台继续，可稍后在详情页查看';

  return false;
};

/**
 * 生成深度报告
 *
 * 注意**不传 `sessionId`**：后端 `CreateReportDto` 只接受 `type` / `relationshipId`，
 * 全局管道开着 `forbidNonWhitelisted`，多传一个字段会直接 `400/10001`。
 * 报告取的是**当前画像**（由最近一次已算分的测评产生），不需要会话 id。
 */
const generateReport = async (): Promise<void> => {
  if (generating.value) return;

  generating.value = true;
  reportProgress.value = 0;
  reportStatus.value = 'QUEUED';
  generateError.value = null;

  try {
    const created = await createReport({ type: 'MBTI_REPORT' });
    reportId.value = created.reportId;

    const finished = await waitForReport(created.reportId);

    if (finished) {
      uni.showToast({ title: '报告已生成', icon: 'success' });
    }

    // 成功与"超时但有报告 id"都进详情页：那里能看到实时状态与完整正文
    openReportDetail(created.reportId);
  } catch (error) {
    generateError.value = error instanceof ApiError ? error.message : '网络异常，请稍后重试';
  } finally {
    generating.value = false;
  }
};

// ============================================================================
// 页面动作
// ============================================================================

/** 本页是自定义导航栏（`navigationStyle: custom`），没有原生返回按钮，需自己处理 */
const onBack = (): void => goBack();

const goReportList = (): void => goToPage('/pages/report/list');
const goChat = (): void => goToPage('/pkgChat/pages/index');
const goHome = (): void => goToPage('/pages/index/index');
const goRetake = (): void => goToPage('/pages/test/intro');

/** 已有报告时，「下一步」里把按钮换成"查看报告详情" */
const goMyReportDetail = (): void => {
  if (reportId.value !== null) {
    openReportDetail(reportId.value);

    return;
  }

  goReportList();
};
</script>

<template>
  <view class="result">
    <!--
      自定义导航栏（pages.json 里本页是 navigationStyle: custom）
      —— 系统不会给返回按钮，必须自己画；顶部内边距还要加上状态栏高度，
      否则内容会顶到刘海/状态栏上。
    -->
    <view class="result__navbar" :style="{ paddingTop: `${appStore.statusBarHeight}px` }">
      <view class="result__navbar-back" @tap="onBack">
        <text class="result__navbar-back-icon">‹</text>
      </view>
      <text class="result__navbar-title">测试结果</text>
      <view class="result__navbar-back result__navbar-back--placeholder" />
    </view>

    <!-- 加载中 -->
    <view v-if="loading" class="card result__state">
      <text>正在获取测评结果…</text>
    </view>

    <!-- 加载失败 -->
    <view v-else-if="loadFailed" class="card result__state">
      <text class="result__state-title">未能获取测评结果</text>
      <text class="result__state-desc">测评可能尚未提交或已过期，请返回重新开始测评</text>
      <button class="result__state-action" @tap="goReportList">查看我的报告</button>
      <button class="result__state-action result__state-action--ghost" @tap="goRetake">重新测一次</button>
    </view>

    <template v-else>
      <!-- MBTI 四字母 -->
      <view class="result__hero">
        <text class="result__label">你的人格类型</text>
        <view class="result__letters">
          <text v-for="(letter, index) in mbtiLetters" :key="index" class="result__letter">{{ letter }}</text>
        </view>
        <text class="result__summary">
          {{ mbtiType ?? '待生成' }} · 结果置信度 {{ (summary?.confidence ?? 0).toFixed(0) }}% · 仅供自我探索参考
        </text>
      </view>

      <!-- 结果提示（阈值由服务端统一控制） -->
      <view v-if="qualityNotice" class="result__notice card">
        <text class="result__notice-text">{{ qualityNotice }}</text>
      </view>

      <!-- 四维倾向 -->
      <view class="card result__section">
        <text class="result__section-title">四个维度的倾向</text>
        <view v-for="bar in dimensionBars" :key="bar.key" class="result__dimension">
          <view class="result__dimension-head">
            <text class="result__dimension-label">{{ bar.label }}</text>
            <text class="result__dimension-value">{{ bar.percent.toFixed(0) }}%</text>
          </view>
          <view class="result__dimension-bar">
            <view class="result__dimension-left" :style="{ width: `${bar.negativeWidth}%` }">
              <text class="result__dimension-side">{{ bar.negative }}</text>
            </view>
            <view class="result__dimension-right" :style="{ width: `${bar.positiveWidth}%` }">
              <text class="result__dimension-side">{{ bar.positive }}</text>
            </view>
          </view>
          <view class="result__dimension-legend">
            <text>{{ bar.negativeLabel }}</text>
            <text>{{ bar.positiveLabel }}</text>
          </view>
        </view>
      </view>

      <!-- Big Five 雷达图 -->
      <view class="card result__section">
        <text class="result__section-title">大五人格特质</text>
        <RadarChart :dimensions="radarDimensions" :size="560" />
        <view class="result__bigfive-list">
          <view v-for="item in radarDimensions" :key="item.key" class="result__bigfive-item">
            <text class="result__bigfive-label">{{ item.label }}</text>
            <text class="result__bigfive-value">{{ item.value.toFixed(0) }}</text>
          </view>
        </view>
      </view>

      <SafetyDisclaimer variant="reportFooter" display="block" />

      <!-- 失败/超时提示：把原因说清楚，并给出可执行的下一步，而不是只让按钮转圈 -->
      <view v-if="generateError" class="card result__error">
        <text class="result__error-text">{{ generateError }}</text>
        <button class="result__error-action" @tap="goMyReportDetail">查看报告详情</button>
      </view>

      <!--
        「接下来可以做什么」——
        拿到结果页之后用户往往不知道下一步干嘛，这里把三条最自然的动线摆出来，
        而不是只留一个孤零零的按钮。
      -->
      <view class="card result__section">
        <text class="result__section-title">接下来可以做什么</text>

        <view class="result__next-item" @tap="generateReport">
          <text class="result__next-icon">📄</text>
          <view class="result__next-body">
            <text class="result__next-title">生成深度报告</text>
            <text class="result__next-desc">AI 逐段解读你的画像、关系模式与成长建议</text>
          </view>
          <text class="result__next-arrow">›</text>
        </view>

        <view class="result__next-item" @tap="goChat">
          <text class="result__next-icon">💬</text>
          <view class="result__next-body">
            <text class="result__next-title">和 AI 助手聊聊</text>
            <text class="result__next-desc">带着你的画像，说说最近在关系里的困扰</text>
          </view>
          <text class="result__next-arrow">›</text>
        </view>

        <view class="result__next-item" @tap="goRetake">
          <text class="result__next-icon">🔁</text>
          <view class="result__next-body">
            <text class="result__next-title">过段时间再测一次</text>
            <text class="result__next-desc">画像会随状态变化，多次测评能看出趋势</text>
          </view>
          <text class="result__next-arrow">›</text>
        </view>

        <view class="result__next-item" @tap="goHome">
          <text class="result__next-icon">🏠</text>
          <view class="result__next-body">
            <text class="result__next-title">回到首页</text>
            <text class="result__next-desc">看看还有哪些测评与内容</text>
          </view>
          <text class="result__next-arrow">›</text>
        </view>
      </view>

      <!-- 底部行动（固定） -->
      <view class="result__footer">
        <button class="result__button-ghost" @tap="goReportList">我的报告</button>
        <button class="result__button" :disabled="generating" @tap="generateReport">
          {{ generating ? generatingText : '生成深度报告' }}
        </button>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.result {
  min-height: 100vh;
  padding: $space-lg $space-lg 200rpx;
  background: linear-gradient(180deg, $color-primary-fade 0%, $color-bg-page 400rpx);

  &__hero {
    padding: $space-xl 0;
    text-align: center;
  }

  &__label {
    display: block;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__letters {
    @include flex-center;
    gap: $space-sm;
    margin-top: $space-md;
  }

  &__letter {
    @include flex-center;
    width: 104rpx;
    height: 128rpx;
    font-size: 64rpx;
    font-weight: $font-weight-bold;
    color: $color-text-inverse;
    background: linear-gradient(160deg, $color-primary-light, $color-primary);
    border-radius: $radius-lg;
    box-shadow: $shadow-primary;
  }

  &__summary {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__notice {
    margin-bottom: $space-md;
    background-color: rgba(245, 158, 11, 0.08);
  }

  &__notice-text {
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: #92400e;
  }

  &__section {
    margin-bottom: $space-md;
  }

  &__section-title {
    display: block;
    margin-bottom: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__dimension {
    margin-bottom: $space-lg;
  }

  &__dimension-head {
    @include flex-between;
    margin-bottom: $space-xs;
  }

  &__dimension-label {
    font-size: $font-size-sm;
    color: $color-text-regular;
  }

  &__dimension-value {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
  }

  &__dimension-bar {
    display: flex;
    overflow: hidden;
    height: 28rpx;
    border-radius: $radius-round;
  }

  &__dimension-left {
    @include flex-center;
    justify-content: flex-start;
    padding-left: $space-xs;
    background-color: $color-border;
    transition: width 0.3s ease;
  }

  &__dimension-right {
    @include flex-center;
    justify-content: flex-end;
    padding-right: $space-xs;
    background: linear-gradient(90deg, $color-primary-light, $color-primary);
    transition: width 0.3s ease;
  }

  &__dimension-side {
    font-size: $font-size-xs;
    font-weight: $font-weight-semibold;
    color: $color-text-inverse;
  }

  &__dimension-legend {
    @include flex-between;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__bigfive-list {
    margin-top: $space-md;
  }

  &__bigfive-item {
    @include flex-between;
    padding: $space-xs 0;
    border-bottom: 1rpx solid $color-divider;
  }

  &__bigfive-label {
    font-size: $font-size-sm;
    color: $color-text-regular;
  }

  &__bigfive-value {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
  }

  &__footer {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    gap: $space-sm;
    padding: $space-md $space-lg;

    @include safe-area-padding-bottom($space-md);

    background-color: $color-bg-card;
    box-shadow: 0 -4rpx 20rpx rgba(31, 31, 46, 0.06);
  }

  &__button-ghost {
    flex: 1;
    height: 88rpx;
    font-size: $font-size-base;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  &__button {
    flex: 2;

    @include button-primary;
  }

  // ---------------------------------------------------------------- 自定义导航栏
  /**
   * 本页 `navigationStyle: custom`，系统不提供导航栏与返回按钮。
   * 顶部内边距由模板按 `statusBarHeight` 动态设置，这里只负责高度与排版。
   */
  &__navbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: $navbar-height;
    margin: -$space-lg -$space-lg 0;
    padding-right: $space-lg;
    padding-left: $space-lg;
  }

  &__navbar-back {
    @include flex-center;

    width: 64rpx;
    height: 64rpx;
  }

  // 占位：让标题在视觉上居中（左右各一个等宽元素）
  &__navbar-back--placeholder {
    opacity: 0;
  }

  &__navbar-back-icon {
    font-size: 48rpx;
    line-height: 1;
    color: $color-text-primary;
  }

  &__navbar-title {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
    color: $color-text-primary;
  }

  // ---------------------------------------------------------------- 生成失败提示
  &__error {
    margin-bottom: $space-md;
    background-color: rgba(239, 68, 68, 0.06);
  }

  &__error-text {
    display: block;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: #b91c1c;
  }

  &__error-action {
    height: 64rpx;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  // ---------------------------------------------------------------- 下一步动向
  &__next-item {
    display: flex;
    align-items: center;
    gap: $space-md;
    padding: $space-md 0;
    border-bottom: 1rpx solid $color-divider;

    &:last-child {
      border-bottom: none;
    }
  }

  &__next-icon {
    font-size: 40rpx;
  }

  &__next-body {
    flex: 1;
  }

  &__next-title {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-semibold;
    color: $color-text-primary;
  }

  &__next-desc {
    display: block;
    margin-top: 4rpx;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__next-arrow {
    font-size: 40rpx;
    color: $color-text-placeholder;
  }

  // ---------------------------------------------------------------- 空态补充按钮
  &__state-action--ghost {
    margin-top: $space-sm;
    color: $color-text-secondary;
    background-color: $color-bg-page;
  }
}
</style>
