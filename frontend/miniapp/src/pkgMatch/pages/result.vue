<script setup lang="ts">
/**
 * 关系匹配报告页（分包 pkgMatch）
 *
 * 关键设计（架构文档 §12.2）：
 *   匹配分数由**确定性算法**算出（纯函数 + 权重配置表），AI 只负责生成「人话」解读。
 *   因此前端展示的分数、子项拆解与 AI 文案是两个来源，分数必须可解释、可复现。
 *
 * Phase 0 状态：页面骨架与图表容器就绪；Phase 4 接入真实接口。
 */

import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import RadarChart from '@/components/RadarChart.vue';
import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import { BIG_FIVE_DIMENSIONS } from '@/config/constants';

const relationshipId = ref('');
const score = ref<number | null>(null);
const generating = ref(false);

/** 我 / TA 的 Big Five 对比数据（Phase 4 由匹配报告接口提供） */
const myDimensions = ref(BIG_FIVE_DIMENSIONS.map((item) => ({ key: item.key, label: item.label, value: 0 })));
const peerDimensions = ref(BIG_FIVE_DIMENSIONS.map((item) => ({ key: item.key, label: item.label, value: 0 })));

/** 子项得分拆解 */
const breakdown = ref<Array<{ key: string; label: string; score: number; weight: number }>>([]);

/** AI 解读结果 */
const strengths = ref<Array<{ title: string; content: string }>>([]);
const conflicts = ref<Array<{ title: string; content: string }>>([]);
const suggestions = ref<Array<{ title: string; content: string }>>([]);

const scoreLevel = computed(() => {
  const value = score.value ?? 0;
  if (value >= 80) return { label: '高度契合', color: '#22C55E' };
  if (value >= 65) return { label: '较为契合', color: '#5B4BE0' };
  if (value >= 50) return { label: '需要磨合', color: '#F59E0B' };
  return { label: '差异较大', color: '#EF4444' };
});

onLoad((query) => {
  const id = query?.['relationshipId'];
  if (typeof id === 'string') {
    relationshipId.value = id;
  }
  // Phase 4：relationshipApi.getCompatibility(relationshipId)，未生成则触发生成并轮询
});

const regenerate = (): void => {
  generating.value = true;
  uni.showToast({ title: '重新分析将在 Phase 4 接入', icon: 'none' });
  setTimeout(() => {
    generating.value = false;
  }, 1200);
};
</script>

<template>
  <view class="match page-container">
    <!-- 匹配总分 -->
    <view class="match__score card">
      <text class="match__score-label">关系契合度</text>
      <view class="match__score-value">
        <text class="match__score-number" :style="{ color: scoreLevel.color }">
          {{ score === null ? '--' : score.toFixed(0) }}
        </text>
        <text class="match__score-unit">分</text>
      </view>
      <text class="match__score-level" :style="{ color: scoreLevel.color }">{{ scoreLevel.label }}</text>
      <text class="match__score-note">分数由人格维度加权计算，AI 负责解读，不含主观判断</text>
    </view>

    <!-- 双人雷达对比 -->
    <view class="card match__radar">
      <text class="match__section-title">人格特质对比</text>
      <RadarChart
        :dimensions="myDimensions"
        :compare-dimensions="peerDimensions"
        :size="600"
        color="#5B4BE0"
        compare-color="#FF7A59"
      />
      <view class="match__legend">
        <view class="match__legend-item">
          <view class="match__legend-dot match__legend-dot--me" />
          <text>我</text>
        </view>
        <view class="match__legend-item">
          <view class="match__legend-dot match__legend-dot--peer" />
          <text>TA</text>
        </view>
      </view>
    </view>

    <!-- 子项拆解 -->
    <view v-if="breakdown.length > 0" class="card match__breakdown">
      <text class="match__section-title">分数构成</text>
      <view v-for="item in breakdown" :key="item.key" class="match__breakdown-item">
        <view class="match__breakdown-head">
          <text class="match__breakdown-label">{{ item.label }}</text>
          <text class="match__breakdown-score">{{ item.score.toFixed(0) }}</text>
        </view>
        <view class="match__breakdown-bar">
          <view class="match__breakdown-inner" :style="{ width: `${item.score}%` }" />
        </view>
        <text class="match__breakdown-weight">权重 {{ Math.round(item.weight * 100) }}%</text>
      </view>
    </view>

    <!-- AI 解读 -->
    <view v-if="strengths.length > 0" class="card match__section">
      <text class="match__section-title">你们的优势</text>
      <view v-for="item in strengths" :key="item.title" class="match__item">
        <text class="match__item-title">{{ item.title }}</text>
        <text class="match__item-content">{{ item.content }}</text>
      </view>
    </view>

    <view v-if="conflicts.length > 0" class="card match__section">
      <text class="match__section-title">可能的摩擦点</text>
      <view v-for="item in conflicts" :key="item.title" class="match__item">
        <text class="match__item-title">{{ item.title }}</text>
        <text class="match__item-content">{{ item.content }}</text>
      </view>
    </view>

    <view v-if="suggestions.length > 0" class="card match__section">
      <text class="match__section-title">相处建议</text>
      <view v-for="item in suggestions" :key="item.title" class="match__item">
        <text class="match__item-title">{{ item.title }}</text>
        <text class="match__item-content">{{ item.content }}</text>
      </view>
    </view>

    <!-- 未生成时展示引导 -->
    <view v-if="score === null && !generating" class="card match__empty">
      <text class="match__empty-title">匹配报告尚未生成</text>
      <text class="match__empty-desc">需要你们双方都完成人格测试后，才能生成关系匹配报告</text>
    </view>

    <SafetyDisclaimer variant="reportFooter" display="block" />

    <button class="match__regenerate" :disabled="generating" @tap="regenerate">
      {{ generating ? '正在重新分析…' : '重新生成分析' }}
    </button>
  </view>
</template>

<style lang="scss" scoped>
.match {
  &__score {
    margin-bottom: $space-md;
    text-align: center;
  }

  &__score-label {
    display: block;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__score-value {
    display: flex;
    align-items: baseline;
    justify-content: center;
    margin-top: $space-sm;
  }

  &__score-number {
    font-size: 120rpx;
    font-weight: $font-weight-bold;
    line-height: 1;
  }

  &__score-unit {
    margin-left: $space-xs;
    font-size: $font-size-md;
    color: $color-text-secondary;
  }

  &__score-level {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__score-note {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__radar,
  &__breakdown,
  &__section {
    margin-bottom: $space-md;
  }

  &__section-title {
    display: block;
    margin-bottom: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__legend {
    @include flex-center;
    gap: $space-lg;
    margin-top: $space-sm;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__legend-item {
    display: flex;
    align-items: center;
    gap: $space-xxs;
  }

  &__legend-dot {
    width: 16rpx;
    height: 16rpx;
    border-radius: $radius-round;

    &--me {
      background-color: $color-primary;
    }

    &--peer {
      background-color: $color-secondary;
    }
  }

  &__breakdown-item {
    margin-bottom: $space-md;
  }

  &__breakdown-head {
    @include flex-between;
  }

  &__breakdown-label {
    font-size: $font-size-sm;
    color: $color-text-regular;
  }

  &__breakdown-score {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
  }

  &__breakdown-bar {
    overflow: hidden;
    height: 16rpx;
    margin-top: $space-xs;
    background-color: $color-border;
    border-radius: $radius-round;
  }

  &__breakdown-inner {
    height: 100%;
    background: linear-gradient(90deg, $color-primary-light, $color-primary);
  }

  &__breakdown-weight {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__item {
    margin-bottom: $space-md;

    &:last-child {
      margin-bottom: 0;
    }
  }

  &__item-title {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-semibold;
  }

  &__item-content {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__empty {
    text-align: center;
  }

  &__empty-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__empty-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__regenerate {
    margin-top: $space-lg;
    font-size: $font-size-base;
    color: $color-primary;
  }
}
</style>
