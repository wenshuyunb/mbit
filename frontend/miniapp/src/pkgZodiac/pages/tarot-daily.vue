<script setup lang="ts">
/**
 * 塔罗牌（分包 pkgZodiac）：今日抽卡 + 解卡
 *
 * ## 交互为什么是"点一张牌翻开"
 *
 * 今日牌本身是**确定性**的（同一天同一用户永远是同一张），所以"选哪一张"并不影响结果。
 * 但抽卡这件事的仪式感就在"翻开"这个动作上：直接甩出结果会让它变成一个静态卡片。
 * 因此保留"点一张翻开"，同时在文案里诚实地说清楚"今天为你备好的牌就是这一张"——
 * 不做"你选错了"这类虚假反馈。
 *
 * ## 卡面为什么用纯 CSS 画
 *
 *   ① 小程序包体积：78 张图会直接把包撑爆；
 *   ② 一致性：符号 + 罗马数字 + 金色描边，用字符与渐变就能做出成色，
 *      而且**逆位只是把内容旋转 180°**，不需要第二套图。
 *
 * ## 逆位的渲染口径
 *
 * 逆位 = 这股能量受阻 / 内化 / 过量，**不是坏牌**。因此逆位不用红色警示色，
 * 只在牌面上把内容倒过来、并标注「逆位」二字。
 */

import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';

import { getDailyTarot, type TarotDailyDraw } from '@/api/tarot';

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
const draw = ref<TarotDailyDraw | null>(null);

/** 是否已翻开（抽卡态 → 解读态） */
const revealed = ref(false);
/** 翻开的是第几张牌背（只影响哪张牌先翻，不影响结果） */
const pickedIndex = ref<number | null>(null);

/** 牌背的三张牌（视觉上的"一叠"，实际点哪张都一样） */
const CARD_BACKS = [0, 1, 2];

const isReversed = computed(() => draw.value?.orientation === 'REVERSED');

/** 牌面顶部：大阿卡纳显示罗马数字，小阿卡纳显示花色符号 */
const topMark = computed<string>(() => {
  const card = draw.value?.card;
  if (card === undefined) return '';

  return card.arcana === 'MAJOR' ? (card.numeral ?? '') : card.symbol;
});

const cardClass = computed<string>(() => {
  if (draw.value === null) return 'tarot__face';

  return draw.value.card.arcana === 'MAJOR' ? 'tarot__face tarot__face--major' : 'tarot__face tarot__face--minor';
});

onLoad(() => {
  void bootstrap();
});

onPullDownRefresh(async () => {
  // 下拉刷新**不会换牌**（今日牌是确定性的），只是重新拉一次数据
  await bootstrap();
  uni.stopPullDownRefresh();
});

const bootstrap = async (): Promise<void> => {
  loading.value = true;
  loadError.value = '';

  try {
    draw.value = await getDailyTarot(today);
  } catch (error) {
    console.error('[tarot] 今日抽卡失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

/** 翻开第 index 张 */
const reveal = (index: number): void => {
  if (revealed.value) return;

  pickedIndex.value = index;
  // 给翻牌一个极短的缓冲，避免"点了没反应"的错觉
  setTimeout(() => {
    revealed.value = true;
  }, 260);
};

const goZodiac = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/tarot-spreads' });
};
</script>

<template>
  <view class="tarot page-container">
    <view v-if="loading" class="card tarot__state">
      <text>正在洗牌…</text>
    </view>

    <view v-else-if="loadError" class="card tarot__state">
      <text class="tarot__state-title">{{ loadError }}</text>
      <button class="tarot__state-action" @tap="bootstrap">重新加载</button>
    </view>

    <template v-else-if="draw">
      <!-- 抽卡态：三张牌背 -->
      <view v-if="!revealed" class="tarot__draw">
        <text class="tarot__draw-title">今日之牌</text>
        <text class="tarot__draw-desc">今天为你备好了一张牌，点一张翻开</text>

        <view class="tarot__backs">
          <view
            v-for="index in CARD_BACKS"
            :key="index"
            class="tarot__back"
            :class="{ 'tarot__back--picked': pickedIndex === index }"
            @tap="reveal(index)"
          >
            <view class="tarot__back-inner">
              <text class="tarot__back-mark">✦</text>
            </view>
          </view>
        </view>

        <text class="tarot__draw-date">{{ draw.date }}</text>
      </view>

      <!-- 解读态：牌面 + 牌义 -->
      <template v-else>
        <view class="tarot__stage">
          <!-- 牌面（逆位时内容整体旋转 180°） -->
          <view :class="cardClass">
            <view class="tarot__face-frame" :class="{ 'tarot__face-frame--reversed': isReversed }">
              <text class="tarot__face-top">{{ topMark }}</text>
              <text class="tarot__face-symbol">{{ draw.card.symbol }}</text>
              <text class="tarot__face-name">{{ draw.card.name }}</text>
              <text class="tarot__face-arcana">{{ draw.card.arcana === 'MAJOR' ? '大阿卡纳' : '小阿卡纳' }}</text>
            </view>
          </view>

          <view class="tarot__orientation" :class="{ 'tarot__orientation--reversed': isReversed }">
            <text class="tarot__orientation-text">{{ draw.orientationLabel }}</text>
          </view>
        </view>

        <view class="tarot__name-row">
          <text class="tarot__name">{{ draw.card.name }}</text>
          <text class="tarot__date">{{ draw.date }}</text>
        </view>

        <view class="tarot__chips">
          <text v-for="keyword in draw.card.keywords" :key="keyword" class="tarot__chip">{{ keyword }}</text>
        </view>

        <view class="card tarot__block">
          <text class="tarot__block-title">{{ draw.orientationLabel }}的牌义</text>
          <text class="tarot__block-body">{{ isReversed ? draw.card.reversed : draw.card.upright }}</text>
        </view>

        <view class="card tarot__block tarot__block--advice">
          <text class="tarot__block-title">今天可以试试</text>
          <text class="tarot__block-body">{{ draw.advice }}</text>
        </view>

        <text class="tarot__note">今日之牌按日期固定，刷新不会换 —— 明天再来会是一张新的牌。</text>

        <view class="card tarot__entry" @tap="goZodiac">
          <text class="tarot__entry-text">看看我的星座运势 · 星盘 · 星盘解读</text>
          <text class="tarot__entry-arrow">→</text>
        </view>

        <!-- 合规声明：服务端下发，原样展示 -->
        <view class="card tarot__disclaimer">
          <text class="tarot__disclaimer-text">{{ draw.disclaimer }}</text>
        </view>
      </template>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.tarot {
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

  // ---------------------------------------------------------------- 抽卡态
  &__draw {
    padding: $space-xl 0 $space-lg;
    text-align: center;
  }

  &__draw-title {
    display: block;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
    color: $color-text-primary;
  }

  &__draw-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__backs {
    display: flex;
    justify-content: center;
    margin-top: $space-xl;
  }

  &__back {
    width: 150rpx;
    height: 250rpx;
    margin: 0 -18rpx;
    background: linear-gradient(160deg, #241c3b 0%, #3b2d5c 55%, #241c3b 100%);
    border: 2rpx solid #c8a96a;
    border-radius: 12rpx;
    box-shadow: 0 8rpx 24rpx rgba(36, 28, 59, 0.35);
    transition: transform 0.26s ease;

    // 三张牌略微错开并旋转，像手里摊开的牌
    &:nth-child(1) {
      transform: rotate(-9deg) translateY(10rpx);
    }

    &:nth-child(2) {
      transform: translateY(-6rpx);
      z-index: 2;
    }

    &:nth-child(3) {
      transform: rotate(9deg) translateY(10rpx);
    }
  }

  &__back--picked {
    transform: translateY(-30rpx) scale(1.06) !important;
    box-shadow: 0 14rpx 32rpx rgba(200, 169, 106, 0.45);
  }

  &__back-inner {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    border: 2rpx solid rgba(200, 169, 106, 0.45);
    border-radius: 8rpx;
  }

  &__back-mark {
    font-size: 40rpx;
    color: #c8a96a;
    opacity: 0.9;
  }

  &__draw-date {
    display: block;
    margin-top: $space-xl;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  // ---------------------------------------------------------------- 牌面
  &__stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: $space-lg;
  }

  &__face {
    width: 320rpx;
    height: 520rpx;
    padding: 10rpx;
    border-radius: 18rpx;
    box-shadow: 0 18rpx 44rpx rgba(36, 28, 59, 0.38);
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
    padding: $space-lg $space-sm;
    border: 2rpx solid rgba(200, 169, 106, 0.7);
    border-radius: 12rpx;
    transition: transform 0.4s ease;
  }

  // 逆位：牌面内容整体倒过来（不换图、不换色）
  &__face-frame--reversed {
    transform: rotate(180deg);
  }

  &__face-top {
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    letter-spacing: 2rpx;
    color: #d9bf85;
  }

  &__face-symbol {
    font-size: 110rpx;
    line-height: 1;
    color: #f0e5cf;
    opacity: 0.92;
  }

  &__face-name {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
    color: #f0e5cf;
  }

  &__face-arcana {
    font-size: $font-size-xs;
    letter-spacing: 2rpx;
    color: #d9bf85;
    opacity: 0.75;
  }

  &__orientation {
    padding: 4rpx $space-md;
    margin-top: $space-md;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  &__orientation-text {
    font-size: $font-size-xs;
    color: $color-primary;
  }

  // 逆位不用警示色：它表示"受阻/内化"，不是坏牌
  &__orientation--reversed &__orientation-text {
    color: $color-text-secondary;
  }

  // ---------------------------------------------------------------- 解读
  &__name-row {
    display: flex;
    align-items: baseline;
    justify-content: center;
    margin-top: $space-md;
  }

  &__name {
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
  }

  &__date {
    margin-left: $space-sm;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: $space-sm;
  }

  &__chip {
    padding: 4rpx $space-sm;
    margin: 0 $space-xs $space-xs 0;
    font-size: $font-size-xs;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
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

  &__note {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-placeholder;
    text-align: center;
  }

  &__entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: $space-md;
  }

  &__entry-text {
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__entry-arrow {
    font-size: $font-size-md;
    color: $color-primary;
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
