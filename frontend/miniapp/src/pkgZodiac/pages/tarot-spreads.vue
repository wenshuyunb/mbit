<script setup lang="ts">
/**
 * 塔罗牌 · 形式选择（分包 pkgZodiac）
 *
 * ## 这一页解决什么
 *
 * 用户说「塔罗牌也有很多形式对吧」—— 对，塔罗的玩法本来就是「牌阵 × 牌义」。
 * 同样一张「塔」，在「时间之流」里读作"已经发生过的断裂"，在「二选一」里读作
 * "这个选项会带来突变"。**位置才让牌有意义**。
 *
 * 因此这一页不是"选一张好看的牌"，而是让用户**按处境选牌阵**：
 * 一句话副标题回答"我现在该选哪个"，可展开的简介讲清楚"它适合什么、怎么读"，
 * 缩略图让人先看到会摆几张、怎么摆。
 *
 * ## 为什么缩略图用 CSS 摆位而不是用图
 *
 * 五种布局各配一张图的话，改布局还得同步图片资源；用几个小方块按 `layout`
 * 与百分比坐标摆位，前端不必为每个牌阵单独写代码，也不需要额外的图片。
 */

import { ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';

import { getTarotSpreads, type TarotSpread } from '@/api/tarot';

const loading = ref(true);
const loadError = ref('');
const spreads = ref<TarotSpread[]>([]);

/** 展开的牌阵（一次只展开一个：同时展开五个会把页面变成一堵字） */
const expanded = ref<string | null>(null);

/** 布局 → 缩略图里小方块的位置（百分比，直接用 style 渲染） */
const LAYOUT_SLOTS: Readonly<Record<string, ReadonlyArray<{ left: string; top: string }>>> = {
  SINGLE: [{ left: '50%', top: '50%' }],
  ROW: [
    { left: '22%', top: '50%' },
    { left: '50%', top: '50%' },
    { left: '78%', top: '50%' },
  ],
  COLUMN: [
    { left: '50%', top: '20%' },
    { left: '50%', top: '50%' },
    { left: '50%', top: '80%' },
  ],
  CROSS: [
    { left: '24%', top: '30%' },
    { left: '76%', top: '30%' },
    { left: '50%', top: '52%' },
    { left: '50%', top: '82%' },
  ],
  WEEK: [
    { left: '18%', top: '38%' },
    { left: '32%', top: '30%' },
    { left: '46%', top: '40%' },
    { left: '60%', top: '30%' },
    { left: '74%', top: '38%' },
    { left: '52%', top: '72%' },
    { left: '86%', top: '64%' },
  ],
};

const slotsOf = (layout: string): ReadonlyArray<{ left: string; top: string }> =>
  LAYOUT_SLOTS[layout] ?? [{ left: '50%', top: '50%' }];

onLoad(() => {
  void bootstrap();
});

onPullDownRefresh(async () => {
  await bootstrap();
  uni.stopPullDownRefresh();
});

const bootstrap = async (): Promise<void> => {
  loading.value = true;
  loadError.value = '';

  try {
    spreads.value = await getTarotSpreads();
  } catch (error) {
    console.error('[tarot] 牌阵列表加载失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

const toggle = (id: string): void => {
  expanded.value = expanded.value === id ? null : id;
};

/** 进入抽卡页（牌阵 id 带过去，抽卡与解读都在那一页完成） */
const start = (spread: TarotSpread): void => {
  uni.navigateTo({ url: `/pkgZodiac/pages/tarot-draw?id=${spread.id}` });
};

/** 今日单张（轻量玩法，仍保留） */
const goDaily = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/tarot-daily' });
};
</script>

<template>
  <view class="spreads page-container">
    <view v-if="loading" class="card spreads__state">
      <text>正在摆牌…</text>
    </view>

    <view v-else-if="loadError" class="card spreads__state">
      <text class="spreads__state-title">{{ loadError }}</text>
      <button class="spreads__state-action" @tap="bootstrap">重新加载</button>
    </view>

    <template v-else>
      <view class="spreads__intro">
        <text class="spreads__intro-title">选一个牌阵</text>
        <text class="spreads__intro-desc">
          塔罗不是"抽一张看运气"。同样一张牌，放在「过去」还是「选项 A」上，意思完全不同 ——
          先按你现在想问的事挑一个牌阵，牌阵决定了每张牌在回答什么。
        </text>
      </view>

      <!-- 今日单张：轻量玩法入口 -->
      <view class="card spreads__quick" @tap="goDaily">
        <view class="spreads__quick-body">
          <text class="spreads__quick-title">只想抽一张？</text>
          <text class="spreads__quick-desc">今日单张指引 · 看今天把注意力放在哪里</text>
        </view>
        <text class="spreads__quick-arrow">→</text>
      </view>

      <view v-for="spread in spreads" :key="spread.id" class="spreads__item card">
        <view class="spreads__head" @tap="toggle(spread.id)">
          <!-- 布局缩略图：小方块按 layout 摆位 -->
          <view class="spreads__thumb">
            <view
              v-for="(slot, index) in slotsOf(spread.layout)"
              :key="index"
              class="spreads__thumb-card"
              :style="{ left: slot.left, top: slot.top }"
            />
          </view>

          <view class="spreads__head-body">
            <view class="spreads__name-row">
              <text class="spreads__name">{{ spread.name }}</text>
              <text class="spreads__count">{{ spread.cardCount }} 张</text>
            </view>
            <text class="spreads__tagline">{{ spread.tagline }}</text>
          </view>

          <text class="spreads__chevron">{{ expanded === spread.id ? '收起' : '详情' }}</text>
        </view>

        <!-- 展开：简介 + 每个位置在问什么 -->
        <view v-if="expanded === spread.id" class="spreads__detail">
          <text class="spreads__detail-text">{{ spread.intro }}</text>

          <text class="spreads__detail-label">每张牌在回答什么</text>
          <view v-for="(position, index) in spread.positions" :key="position.key" class="spreads__position">
            <text class="spreads__position-index">{{ index + 1 }}</text>
            <view class="spreads__position-body">
              <text class="spreads__position-label">{{ position.label }}</text>
              <text class="spreads__position-question">{{ position.question }}</text>
            </view>
          </view>
        </view>

        <button class="spreads__start" @tap="start(spread)">用这个牌阵抽卡</button>
      </view>

      <text class="spreads__note">每天每个牌阵的结果是固定的（刷新不会变），隔天再来会是一组新的牌。</text>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.spreads {
  &__state {
    text-align: center;
  }

  &__state-title {
    display: block;
    margin-bottom: $space-md;
  }

  &__state-action {
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__intro {
    padding: $space-md 0 $space-lg;
  }

  &__intro-title {
    display: block;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
  }

  &__intro-desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__quick {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: $space-md;
    background: linear-gradient(135deg, #241c3b 0%, #3b2d5c 100%);
  }

  &__quick-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
    color: #f0e5cf;
  }

  &__quick-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: rgba(240, 229, 207, 0.8);
  }

  &__quick-arrow {
    font-size: $font-size-md;
    color: #d9bf85;
  }

  &__item {
    margin-bottom: $space-md;
  }

  &__head {
    display: flex;
    align-items: center;
  }

  &__thumb {
    position: relative;
    flex-shrink: 0;
    width: 120rpx;
    height: 120rpx;
    background: linear-gradient(160deg, #241c3b 0%, #3b2d5c 100%);
    border-radius: $radius-sm;
  }

  &__thumb-card {
    position: absolute;
    width: 18rpx;
    height: 30rpx;
    background-color: rgba(200, 169, 106, 0.85);
    border-radius: 3rpx;
    transform: translate(-50%, -50%);
  }

  &__head-body {
    flex: 1;
    margin-left: $space-md;
  }

  &__name-row {
    display: flex;
    align-items: baseline;
  }

  &__name {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__count {
    padding: 0 $space-xs;
    margin-left: $space-xs;
    font-size: $font-size-xs;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  &__tagline {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__chevron {
    margin-left: $space-sm;
    font-size: $font-size-xs;
    color: $color-primary;
  }

  &__detail {
    padding-top: $space-md;
    margin-top: $space-md;
    border-top: 1rpx solid $color-divider;
  }

  &__detail-text {
    display: block;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__detail-label {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__position {
    display: flex;
    align-items: flex-start;
    margin-top: $space-sm;
  }

  &__position-index {
    flex-shrink: 0;
    width: 32rpx;
    height: 32rpx;
    margin-right: $space-sm;
    font-size: $font-size-xs;
    line-height: 32rpx;
    color: $color-primary;
    text-align: center;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  &__position-body {
    flex: 1;
  }

  &__position-label {
    font-size: $font-size-sm;
    font-weight: $font-weight-medium;
  }

  &__position-question {
    display: block;
    margin-top: 2rpx;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__start {
    margin-top: $space-md;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__note {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-placeholder;
    text-align: center;
  }
}
</style>
