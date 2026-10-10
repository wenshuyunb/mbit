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
import { BIG_FIVE_DIMENSIONS, MBTI_DIMENSIONS } from '@/config/constants';

const sessionId = ref('');
const result = ref<TestSessionResult | null>(null);
const loading = ref(true);
const loadFailed = ref(false);
/** 报告生成进度（Phase 3 由轮询/SSE 驱动） */
const reportProgress = ref(0);
const generating = ref(false);

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

const generateReport = async (): Promise<void> => {
  // Phase 3：调用 reportApi.createReport 并轮询进度
  generating.value = true;
  uni.showToast({ title: '报告生成功能将在 Phase 3 接入', icon: 'none' });
  setTimeout(() => {
    generating.value = false;
  }, 1200);
};

const goReport = (): void => {
  uni.navigateTo({ url: '/pages/report/list' });
};
</script>

<template>
  <view class="result">
    <!-- 加载中 -->
    <view v-if="loading" class="card result__state">
      <text>正在获取测评结果…</text>
    </view>

    <!-- 加载失败 -->
    <view v-else-if="loadFailed" class="card result__state">
      <text class="result__state-title">未能获取测评结果</text>
      <text class="result__state-desc">测评可能尚未提交或已过期，请返回重新开始测评</text>
      <button class="result__state-action" @tap="goReport">查看我的报告</button>
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

      <!-- 底部行动 -->
      <view class="result__footer">
        <button class="result__button-ghost" @tap="goReport">我的报告</button>
        <button class="result__button" :disabled="generating" @tap="generateReport">
          {{ generating ? `AI 正在解读 ${reportProgress}%` : '生成深度报告' }}
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
}
</style>
