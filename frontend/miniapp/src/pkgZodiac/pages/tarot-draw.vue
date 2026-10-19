<script setup lang="ts">
/**
 * 塔罗牌 · 抽卡与解读（分包 pkgZodiac）
 *
 * ## 页面节奏（三段式）
 *
 *   ① **洗牌**：按牌阵张数与**布局**摆出牌背，逐张翻开（220ms 间隔）——
 *      抽卡要有过程感，一次"啪"地全出来就成了静态图；
 *   ② **逐位置解读**：每张牌一个区块，写明"这个位置在问什么"，
 *      让用户知道这张牌在回答哪一句，而不是只看到牌名；
 *   ③ **整体解读**：先给一句话结论 + 两个数字（大牌占比 / 逆位占比），
 *      再给三条从牌面实际算出的结构分析，最后给可执行的收尾建议。
 *
 * ## 为什么按 `layout` 真实摆位
 *
 * 之前所有牌阵都用 `flex-wrap` 平铺，"七日指引"七张会自己折行、看起来像随机排列 ——
 * 而牌阵的**位置本身是有意义的**（周一在最左、周日收尾）。现在按布局分组：
 * 单张居中、时间之流一行、关系之镜上二下一、七日指引五加二。
 *
 * ## 两条纪律
 *
 *   ① **不做本地随机**：牌与解读全部来自服务端（种子 = 用户 + 日期 + 牌阵）；
 *   ② **逆位不用警示色**：逆位是受阻 / 内化 / 过量，不是坏牌。
 */

import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';

import TarotCard from '@/components/tarot/TarotCard.vue';
import { safeNavigateBack } from '@/utils/safe-navigate';
import { getTarotSpreadDraw, getTarotSpreads, type TarotSpread, type TarotSpreadReading } from '@/api/tarot';

/** 今天的 `YYYY-MM-DD`（本地时区口径） */
const localToday = (): string => {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');

  return `${now.getFullYear()}-${month}-${day}`;
};

const today = localToday();

const loading = ref(true);
const loadError = ref('');
const spread = ref<TarotSpread | null>(null);
const reading = ref<TarotSpreadReading | null>(null);

/** 已翻开的张数（驱动逐张翻牌动画） */
const revealedCount = ref(0);
const fullyRevealed = computed<boolean>(
  () => reading.value !== null && revealedCount.value >= reading.value.draws.length,
);

/**
 * 按牌阵布局把牌分组（每组一行）
 *
 * 位置顺序不能乱：七日指引里"周一"必须排第一，因此这里只做**分行**，不排序。
 */
const layoutRows = computed<number[][]>(() => {
  const layout = spread.value?.layout ?? 'ROW';
  const total = reading.value?.draws.length ?? 0;
  const indices = Array.from({ length: total }, (_, index) => index);

  if (layout === 'SINGLE') return [indices];
  if (layout === 'COLUMN') return indices.map((index) => [index]);
  if (layout === 'WEEK' && total >= 7) return [indices.slice(0, 5), indices.slice(5)];
  if (layout === 'CROSS' && total >= 4) return [[0, 1], [2], [3]];

  return [indices];
});

/** 单张牌阵用大牌，多张用小牌 */
const isSingle = computed<boolean>(() => (spread.value?.layout ?? 'ROW') === 'SINGLE');

onLoad((options) => {
  void bootstrap(options?.id);
});

onPullDownRefresh(async () => {
  // 下拉刷新不会换牌（种子含日期），只是保持已翻开状态
  revealedCount.value = reading.value?.draws.length ?? 0;
  uni.stopPullDownRefresh();
});

const bootstrap = async (spreadId?: string): Promise<void> => {
  loading.value = true;
  loadError.value = '';

  try {
    const spreads = await getTarotSpreads();
    const matched = spreads.find((item) => item.id === spreadId) ?? null;

    if (matched === null) {
      loadError.value = '这个牌阵不存在，请回上一页重新选择';

      return;
    }

    spread.value = matched;
    const result = await getTarotSpreadDraw(matched.id, today);

    if (result === null || result.draws === undefined || result.draws.length === 0) {
      loadError.value = '这一抽没有拿到牌，请稍后再试';

      return;
    }

    reading.value = result;

    // 逐张翻开：首张稍慢（像先抽出来），其余 220ms
    revealedCount.value = 0;
    for (let index = 0; index < result.draws.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 360 : 220));
      revealedCount.value = index + 1;
    }
  } catch (error) {
    console.error('[tarot] 牌阵抽卡失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

const isRevealed = (index: number): boolean => index < revealedCount.value;

const goBack = (): void => {
  safeNavigateBack();
};
</script>

<template>
  <view class="draw page-container">
    <view v-if="loading" class="card draw__state">
      <text class="draw__state-text">正在洗牌…</text>
    </view>

    <view v-else-if="loadError" class="card draw__state">
      <text class="draw__state-title">{{ loadError }}</text>
      <button class="draw__state-action" @tap="goBack">回去换一个牌阵</button>
    </view>

    <template v-else-if="reading && spread">
      <!-- 标题区 -->
      <view class="draw__head">
        <text class="draw__ornament">✦ ─────── ✦</text>
        <text class="draw__title">{{ reading.spreadName }}</text>
        <text class="draw__date">{{ reading.date }} · 共 {{ reading.draws.length }} 张</text>
      </view>

      <!-- ① 牌桌：按布局分行，逐张翻开 -->
      <view class="draw__table">
        <view v-for="(row, rowIndex) in layoutRows" :key="rowIndex" class="draw__row">
          <view v-for="index in row" :key="index" class="draw__slot" :class="{ 'draw__slot--single': isSingle }">
            <text class="draw__slot-label">{{ reading.draws[index]?.position.label }}</text>

            <!--
              牌面统一用 TarotCard 组件：
                · 牌背纹样、真·插画层（填了美术资源才出现）、图元占位三者由组件内部决定；
                · 两段式翻牌（0°→90° 换面→180°）也由组件负责，翻到侧缘时是"纸立起来"的瞬间；
                · 逆位是整张牌真实旋转 180°，不是只改文字标签。
              外层只负责"逐张出场"的淡入与上浮，两者职责分开。
            -->
            <view class="draw__card" :class="isRevealed(index) ? 'draw__card--in' : ''">
              <TarotCard
                v-if="reading.draws[index]"
                :card="reading.draws[index]!.card"
                :orientation="reading.draws[index]!.orientation"
                :size-rpx="isSingle ? 300 : 148"
                :flipped="isRevealed(index)"
              />
            </view>

            <text
              v-if="isRevealed(index)"
              class="draw__orientation"
              :class="reading.draws[index]?.orientation === 'REVERSED' ? 'draw__orientation--reversed' : ''"
              >{{ reading.draws[index]?.orientationLabel }}</text
            >
          </view>
        </view>
      </view>

      <!-- ② 整体解读 -->
      <template v-if="fullyRevealed">
        <view class="draw__summary">
          <text class="draw__summary-label">一句话结论</text>
          <text class="draw__summary-headline">{{ reading.summary.headline }}</text>

          <view class="draw__stats">
            <view class="draw__stat">
              <text class="draw__stat-value">{{ reading.summary.stats.majorCount }}</text>
              <text class="draw__stat-label">大阿卡纳 / 共 {{ reading.summary.stats.total }}</text>
            </view>
            <view class="draw__stat-divider" />
            <view class="draw__stat">
              <text class="draw__stat-value">{{ reading.summary.stats.reversedCount }}</text>
              <text class="draw__stat-label">逆位 / 共 {{ reading.summary.stats.total }}</text>
            </view>
          </view>
        </view>

        <view class="card draw__block">
          <text class="draw__block-title">牌阵结构</text>
          <text class="draw__block-body">{{ reading.summary.structure }}</text>
        </view>

        <view class="card draw__block">
          <text class="draw__block-title">逐张解读</text>
          <view v-for="item in reading.draws" :key="item.position.key" class="draw__reading">
            <view class="draw__reading-head">
              <text class="draw__reading-position">{{ item.position.label }}</text>
              <text class="draw__reading-card">{{ item.card.name }} · {{ item.orientationLabel }}</text>
            </view>
            <text class="draw__reading-question">{{ item.position.question }}</text>
            <text class="draw__reading-body">{{
              item.orientation === 'REVERSED' ? item.card.reversed : item.card.upright
            }}</text>
          </view>
        </view>

        <view class="card draw__block">
          <text class="draw__block-title">把牌串起来看</text>
          <text class="draw__block-body">{{ reading.summary.narrative }}</text>
        </view>

        <view class="card draw__block draw__block--advice">
          <text class="draw__block-title">可以怎么用</text>
          <text class="draw__block-body">{{ reading.summary.advice }}</text>
        </view>

        <text class="draw__note">同一天同一个牌阵的结果是固定的（刷新不会变）。明天再来会是一组新的牌。</text>

        <view class="card draw__disclaimer">
          <text class="draw__disclaimer-text">{{ reading.disclaimer }}</text>
        </view>
      </template>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.draw {
  // ---------------------------------------------------------------- 状态
  &__state {
    text-align: center;
  }

  &__state-text {
    font-size: $font-size-sm;
    color: $color-text-secondary;
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

  // ---------------------------------------------------------------- 标题
  &__head {
    padding: $space-md 0 $space-lg;
    text-align: center;
  }

  &__ornament {
    display: block;
    font-size: $font-size-xs;
    letter-spacing: 4rpx;
    color: #c8a96a;
    opacity: 0.8;
  }

  &__title {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
    letter-spacing: 2rpx;
  }

  &__date {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  // ---------------------------------------------------------------- 牌桌
  &__table {
    padding: $space-md $space-xs;
    background: radial-gradient(circle at 50% 0%, rgba(59, 45, 92, 0.16) 0%, rgba(36, 28, 59, 0) 70%);
    border-radius: $radius-lg;
  }

  &__row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: center;
  }

  &__slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 0 6rpx $space-lg;
  }

  &__slot--single {
    margin-bottom: $space-md;
  }

  &__slot-label {
    margin-bottom: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  // ---------------------------------------------------------------- 牌
  &__card {
    position: relative;
    border-radius: 14rpx;
    transition:
      opacity 0.34s cubic-bezier(0.22, 0.9, 0.3, 1),
      transform 0.34s cubic-bezier(0.22, 0.9, 0.3, 1);
  }

  &__card--small {
    width: 148rpx;
    height: 242rpx;
  }

  &__card--single {
    width: 300rpx;
    height: 492rpx;
  }

  // 未翻开：略微后仰 + 下沉 + 半透明
  &__card {
    opacity: 0.35;
    transform: translateY(18rpx) rotateY(-28deg) scale(0.92);
  }

  &__card--in {
    opacity: 1;
    transform: translateY(0) rotateY(0deg) scale(1);
    box-shadow: 0 10rpx 30rpx rgba(200, 169, 106, 0.28);
  }

  // ---------------------------------------------------------------- 牌背
  &__back {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 6rpx;
    background:
      repeating-linear-gradient(45deg, rgba(200, 169, 106, 0.16) 0 2rpx, transparent 2rpx 12rpx),
      repeating-linear-gradient(-45deg, rgba(200, 169, 106, 0.16) 0 2rpx, transparent 2rpx 12rpx),
      linear-gradient(160deg, #241c3b 0%, #3b2d5c 55%, #241c3b 100%);
    border: 2rpx solid #c8a96a;
    border-radius: 14rpx;
  }

  &__back-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    border: 2rpx solid rgba(200, 169, 106, 0.5);
    border-radius: 10rpx;
  }

  &__back-mark {
    font-size: 44rpx;
    color: #c8a96a;
    opacity: 0.9;
  }

  // ---------------------------------------------------------------- 牌面
  &__face {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 6rpx;
    border-radius: 14rpx;
    box-shadow: inset 0 0 24rpx rgba(0, 0, 0, 0.35);
  }

  &__face--major {
    background: linear-gradient(168deg, #1b2440 0%, #3b2d5c 48%, #1b2440 100%);
    border: 2rpx solid #c8a96a;
  }

  &__face--minor {
    background: linear-gradient(168deg, #1e2836 0%, #35505c 50%, #1e2836 100%);
    border: 2rpx solid #9fb4bd;
  }

  &__face-inner {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 4rpx;
    border: 2rpx solid rgba(255, 255, 255, 0.16);
    border-radius: 10rpx;
  }

  &__face-content {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: $space-sm 4rpx;
  }

  // 逆位：牌面内容整体倒转（不换图、不用警示色）
  &__face-content--reversed {
    transform: rotate(180deg);
  }

  &__face-corners {
    display: flex;
    justify-content: space-between;
    width: 100%;
    padding: 0 2rpx;
  }

  &__face-corner {
    font-size: 14rpx;
    color: rgba(200, 169, 106, 0.7);
  }

  &__face-top {
    font-size: $font-size-xs;
    font-weight: $font-weight-bold;
    letter-spacing: 2rpx;
    color: #e8d3a0;
  }

  // 中央光晕：让符号像是"浮"在牌面上
  &__face-aura {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 108rpx;
    height: 108rpx;
    background: radial-gradient(circle, rgba(232, 211, 160, 0.22) 0%, rgba(232, 211, 160, 0) 72%);
    border-radius: $radius-round;
  }

  &__card--single &__face-aura {
    width: 200rpx;
    height: 200rpx;
  }

  &__face-symbol {
    font-size: 56rpx;
    line-height: 1;
    color: #f5ebd6;
    text-shadow: 0 0 12rpx rgba(232, 211, 160, 0.5);
  }

  &__card--single &__face-symbol {
    font-size: 104rpx;
  }

  &__face-name {
    font-size: $font-size-xs;
    font-weight: $font-weight-semibold;
    letter-spacing: 1rpx;
    color: #f5ebd6;
  }

  &__card--single &__face-name {
    font-size: $font-size-md;
    letter-spacing: 4rpx;
  }

  &__face-rule {
    width: 40%;
    height: 1rpx;
    background: linear-gradient(90deg, transparent, rgba(200, 169, 106, 0.85), transparent);
  }

  &__orientation {
    padding: 2rpx $space-sm;
    margin-top: $space-xs;
    font-size: 18rpx;
    color: #c8a96a;
    background-color: rgba(200, 169, 106, 0.14);
    border-radius: $radius-round;
  }

  &__orientation--reversed {
    color: $color-text-secondary;
    background-color: $color-bg-hover;
  }

  // ---------------------------------------------------------------- 结论
  &__summary {
    padding: $space-lg $space-md;
    margin-top: $space-md;
    background: linear-gradient(150deg, #1b2440 0%, #3b2d5c 100%);
    border: 2rpx solid rgba(200, 169, 106, 0.5);
    border-radius: $radius-lg;
  }

  &__summary-label {
    display: block;
    font-size: $font-size-xs;
    letter-spacing: 2rpx;
    color: #c8a96a;
  }

  &__summary-headline {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: #f5ebd6;
  }

  &__stats {
    display: flex;
    align-items: center;
    margin-top: $space-md;
  }

  &__stat {
    flex: 1;
    text-align: center;
  }

  &__stat-divider {
    width: 1rpx;
    height: 56rpx;
    background: linear-gradient(180deg, transparent, rgba(200, 169, 106, 0.5), transparent);
  }

  &__stat-value {
    display: block;
    font-size: 44rpx;
    font-weight: $font-weight-bold;
    line-height: 1.1;
    color: #e8d3a0;
  }

  &__stat-label {
    display: block;
    margin-top: 2rpx;
    font-size: $font-size-xs;
    color: rgba(245, 235, 214, 0.7);
  }

  // ---------------------------------------------------------------- 正文
  &__block {
    margin-top: $space-md;
  }

  &__block--advice {
    border-left: 6rpx solid #c8a96a;
  }

  &__block-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__block-body {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__reading {
    padding-top: $space-md;
    margin-top: $space-md;
    border-top: 1rpx solid $color-divider;
  }

  &__reading-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__reading-position {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
  }

  &__reading-card {
    font-size: $font-size-xs;
    color: $color-primary;
  }

  &__reading-question {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__reading-body {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__note {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-placeholder;
    text-align: center;
  }

  &__disclaimer {
    margin-top: $space-md;
  }

  &__disclaimer-text {
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-placeholder;
  }
}
</style>
