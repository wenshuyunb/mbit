<script setup lang="ts">
/**
 * 塔罗牌 · 抽卡与解读（分包 pkgZodiac）
 *
 * ## 页面节奏（三段式）
 *
 *   ① **洗牌**：按牌阵张数摆出牌背，逐个翻开（间隔 220ms）—— 抽卡要有过程感，
 *      一次"啪"地全出来就成了静态图；
 *   ② **逐位置解读**：每张牌一个卡片，卡片上写明"这个位置在问什么"，
 *      让用户知道这张牌在回答哪一句，而不是只看到牌名；
 *   ③ **整体解读**：先给一句话结论，再给三条从牌面实际算出来的结构分析
 *      （大阿卡纳占比 / 花色重心 / 逆位比重），最后给可执行的收尾建议。
 *
 * ## 两条纪律
 *
 *   ① **不做本地随机**：牌与解读全部来自服务端（种子 = 用户 + 日期 + 牌阵），
 *      前端一旦自己随机，就会出现"刷新一次换一组牌"；
 *   ② **逆位不用警示色**：逆位是受阻 / 内化 / 过量，不是坏牌。
 */

import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';

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
/** 是否全部翻完（翻完后才展示解读，避免解读先于牌出现） */
const fullyRevealed = computed<boolean>(
  () => reading.value !== null && revealedCount.value >= (reading.value.draws.length ?? 0),
);

onLoad((options) => {
  void bootstrap(options?.id);
});

onPullDownRefresh(async () => {
  // 下拉刷新不会换牌（种子含日期），只是重新拉一次
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
    reading.value = await getTarotSpreadDraw(matched.id, today);

    // 逐张翻开：间隔 220ms，让"抽卡"有过程感
    revealedCount.value = 0;
    for (let index = 0; index < reading.value.draws.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 320 : 220));
      revealedCount.value = index + 1;
    }
  } catch (error) {
    console.error('[tarot] 牌阵抽卡失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

/** 卡片是否已翻开 */
const isRevealed = (index: number): boolean => index < revealedCount.value;

/** 牌面顶部标记：大阿卡纳显示罗马数字，小阿卡纳显示花色符号 */
const topMarkOf = (draw: TarotSpreadReading['draws'][number]): string =>
  draw.card.arcana === 'MAJOR' ? (draw.card.numeral ?? '') : draw.card.symbol;

const goBack = (): void => {
  uni.navigateBack({ delta: 1 });
};
</script>

<template>
  <view class="draw page-container">
    <view v-if="loading" class="card draw__state">
      <text>正在洗牌…</text>
    </view>

    <view v-else-if="loadError" class="card draw__state">
      <text class="draw__state-title">{{ loadError }}</text>
      <button class="draw__state-action" @tap="goBack">回去换一个牌阵</button>
    </view>

    <template v-else-if="reading && spread">
      <view class="draw__head">
        <text class="draw__title">{{ reading.spreadName }}</text>
        <text class="draw__date">{{ reading.date }} · 共 {{ reading.draws.length }} 张</text>
      </view>

      <!-- ① 牌面：逐张翻开 -->
      <view class="draw__cards">
        <view v-for="(item, index) in reading.draws" :key="item.position.key" class="draw__slot">
          <text class="draw__position-label">{{ item.position.label }}</text>

          <view class="draw__card-wrap" :class="{ 'draw__card-wrap--in': isRevealed(index) }">
            <!-- 未翻开：牌背 -->
            <view v-if="!isRevealed(index)" class="draw__back">
              <text class="draw__back-mark">✦</text>
            </view>

            <!-- 已翻开：牌面 -->
            <view
              v-else
              class="draw__face"
              :class="item.card.arcana === 'MAJOR' ? 'draw__face--major' : 'draw__face--minor'"
            >
              <view class="draw__face-frame" :class="{ 'draw__face-frame--reversed': item.orientation === 'REVERSED' }">
                <text class="draw__face-top">{{ topMarkOf(item) }}</text>
                <text class="draw__face-symbol">{{ item.card.symbol }}</text>
                <text class="draw__face-name">{{ item.card.name }}</text>
              </view>
            </view>
          </view>

          <text
            v-if="isRevealed(index)"
            class="draw__orientation"
            :class="{ 'draw__orientation--reversed': item.orientation === 'REVERSED' }"
          >
            {{ item.orientationLabel }}
          </text>
        </view>
      </view>

      <!-- ② 逐位置解读 -->
      <template v-if="fullyRevealed">
        <view class="card draw__summary">
          <text class="draw__summary-label">一句话结论</text>
          <text class="draw__summary-headline">{{ reading.summary.headline }}</text>

          <view class="draw__stats">
            <view class="draw__stat">
              <text class="draw__stat-value"
                >{{ reading.summary.stats.majorCount }}/{{ reading.summary.stats.total }}</text
              >
              <text class="draw__stat-label">大阿卡纳</text>
            </view>
            <view class="draw__stat">
              <text class="draw__stat-value"
                >{{ reading.summary.stats.reversedCount }}/{{ reading.summary.stats.total }}</text
              >
              <text class="draw__stat-label">逆位</text>
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

        <text class="draw__note"> 同一天同一个牌阵的结果是固定的（刷新不会变）。明天再来会是一组新的牌。 </text>

        <view class="card draw__disclaimer">
          <text class="draw__disclaimer-text">{{ reading.disclaimer }}</text>
        </view>
      </template>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.draw {
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

  &__head {
    padding: $space-md 0 $space-lg;
    text-align: center;
  }

  &__title {
    display: block;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
  }

  &__date {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  // ---------------------------------------------------------------- 牌面
  &__cards {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
  }

  &__slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 0 $space-xs $space-md;
  }

  &__position-label {
    margin-bottom: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__card-wrap {
    // 翻牌动画：从下方轻微上浮 + 淡入 + 微旋转，像真的翻开一张牌
    width: 132rpx;
    height: 216rpx;
    opacity: 0.25;
    transform: translateY(16rpx) rotateY(-24deg) scale(0.94);
    transition:
      opacity 0.32s ease,
      transform 0.32s ease;
  }

  &__card-wrap--in {
    opacity: 1;
    transform: translateY(0) rotateY(0deg) scale(1);
  }

  &__back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: linear-gradient(160deg, #241c3b 0%, #3b2d5c 55%, #241c3b 100%);
    border: 2rpx solid #c8a96a;
    border-radius: 10rpx;
  }

  &__back-mark {
    font-size: 32rpx;
    color: #c8a96a;
    opacity: 0.85;
  }

  &__face {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 6rpx;
    border-radius: 10rpx;
    box-shadow: 0 8rpx 20rpx rgba(36, 28, 59, 0.32);
  }

  &__face--major {
    background: linear-gradient(165deg, #1f2a4a 0%, #3b2d5c 50%, #1f2a4a 100%);
  }

  &__face--minor {
    background: linear-gradient(165deg, #23303f 0%, #35505c 50%, #23303f 100%);
  }

  &__face-frame {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: $space-sm 2rpx;
    border: 2rpx solid rgba(200, 169, 106, 0.65);
    border-radius: 6rpx;
  }

  // 逆位：牌面内容整体倒过来（不换图，也不用警示色）
  &__face-frame--reversed {
    transform: rotate(180deg);
  }

  &__face-top {
    font-size: $font-size-xs;
    font-weight: $font-weight-bold;
    color: #d9bf85;
  }

  &__face-symbol {
    font-size: 48rpx;
    line-height: 1;
    color: #f0e5cf;
  }

  &__face-name {
    font-size: $font-size-xs;
    font-weight: $font-weight-semibold;
    color: #f0e5cf;
  }

  &__orientation {
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-primary;
  }

  &__orientation--reversed {
    color: $color-text-secondary;
  }

  // ---------------------------------------------------------------- 解读
  &__summary {
    margin-top: $space-md;
    background: linear-gradient(135deg, #2b2f4a 0%, #4a3f6b 100%);
  }

  &__summary-label {
    display: block;
    font-size: $font-size-xs;
    color: $color-text-inverse;
    opacity: 0.75;
  }

  &__summary-headline {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-inverse;
  }

  &__stats {
    display: flex;
    margin-top: $space-md;
  }

  &__stat {
    flex: 1;
    text-align: center;
  }

  &__stat-value {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    color: $color-secondary;
  }

  &__stat-label {
    display: block;
    margin-top: 2rpx;
    font-size: $font-size-xs;
    color: $color-text-inverse;
    opacity: 0.75;
  }

  &__block {
    margin-top: $space-md;
  }

  &__block--advice {
    border-left: 6rpx solid $color-primary;
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
