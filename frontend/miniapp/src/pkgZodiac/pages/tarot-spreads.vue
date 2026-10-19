<script setup lang="ts">
/**
 * 塔罗牌 · 牌阵选择（分包 pkgZodiac）— Celestial Arcana｜星夜秘境
 *
 * ## 这一版与上一版的差别（不是换颜色）
 *
 * | | 上一版 | 现在 |
 * | --- | --- | --- |
 * | 导航 | 系统白色导航栏 | 沉浸式深色自定义导航 + 月相图腾，避开胶囊与状态栏 |
 * | 顶部 | 一段说明文字 | 艺术主题区：月相刻线图 + 衬线主标题 + 副标题 |
 * | 今日指引 | 与其它牌阵同样的卡片 | **主推横向艺术卡**：左侧真实牌背、右侧标题与金线箭头 |
 * | 其它牌阵 | 同样的缩略图换数字 | 每个牌阵**专属排列图**（时间之流横向、关系之镜镜像、七日指引扇形） |
 * | 交互 | 点一下跳转 | 触碰缩放 0.98 + 金边增强，松手进入 |
 *
 * 业务逻辑（拉列表、跳转抽卡页、今日单张入口）与上一版完全一致，未改协议。
 */

import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';

import MysticBackdrop from '@/components/tarot/MysticBackdrop.vue';
import SpreadGlyph from '@/components/tarot/SpreadGlyph.vue';
import { getTarotSpreads, type TarotSpread } from '@/api/tarot';
import { safeNavigate, safeNavigateBack } from '@/utils/safe-navigate';
import { useAppStore } from '@/store/app';

const appStore = useAppStore();

const loading = ref(true);
const loadError = ref('');
const spreads = ref<TarotSpread[]>([]);
/** 展开详情的牌阵（一次一个） */
const expanded = ref<string | null>(null);
/** 按下的牌阵（做按压反馈） */
const pressed = ref<string | null>(null);

/** 导航栏高度：状态栏 + 与胶囊对齐的 44px 区，避开系统按钮 */
const navHeight = computed<number>(() => appStore.statusBarHeight + 44);
const navPaddingTop = computed<number>(() => appStore.statusBarHeight + 8);

/** 主推牌阵（今日指引）与其余牌阵分开渲染 */
const featured = computed<TarotSpread | null>(() => spreads.value.find((item) => item.id === 'DAILY') ?? null);
const others = computed<TarotSpread[]>(() => spreads.value.filter((item) => item.id !== 'DAILY'));

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

const onPressIn = (id: string): void => {
  pressed.value = id;
};

const onPressOut = (): void => {
  pressed.value = null;
};

/** 进入抽卡页（牌阵 id 带过去，抽卡与解读都在那一页完成） */
const start = (spread: TarotSpread): void => {
  safeNavigate(`/pkgZodiac/pages/tarot-draw?id=${spread.id}`);
};

const goDaily = (): void => {
  safeNavigate('/pkgZodiac/pages/tarot-daily');
};

const goBack = (): void => {
  safeNavigateBack();
};

/** 英文副标题（设计语言里的 eyebrow 层） */
const EYEBROW: Readonly<Record<string, string>> = {
  DAILY: 'ONE CARD · DAILY GUIDANCE',
  THREE_TIME: 'THREE CARDS · PAST / PRESENT / FUTURE',
  CHOICE: 'THREE CARDS · TWO PATHS',
  RELATIONSHIP: 'FOUR CARDS · THE MIRROR',
  WEEK: 'SEVEN CARDS · THE WHEEL OF WEEK',
};
</script>

<template>
  <view class="arcana">
    <MysticBackdrop :moonlight-top="-160" />

    <!-- 沉浸式导航：避开状态栏与胶囊 -->
    <view class="arcana__nav" :style="{ height: `${navHeight}px`, paddingTop: `${navPaddingTop}px` }">
      <view class="arcana__nav-back" @tap="goBack">
        <text class="arcana__nav-arrow">‹</text>
      </view>
      <view class="arcana__nav-title-box">
        <text class="arcana__nav-title">塔罗牌</text>
      </view>
      <!-- 月相图腾：三个不同盈亏的月亮，作为品牌记号（不抢标题） -->
      <view class="arcana__nav-moon">
        <view class="arcana__moon-dot arcana__moon-dot--new" />
        <view class="arcana__moon-dot arcana__moon-dot--half" />
        <view class="arcana__moon-dot arcana__moon-dot--full" />
      </view>
    </view>

    <view class="arcana__body" :style="{ paddingTop: `${navHeight + 8}px` }">
      <!-- 主题区 -->
      <view class="arcana__hero">
        <view class="arcana__hero-moon">
          <view class="arcana__hero-moon-core" />
          <view class="arcana__hero-moon-ring arcana__hero-moon-ring--outer" />
          <view class="arcana__hero-moon-ring arcana__hero-moon-ring--inner" />
          <!-- 黄道刻度：八道短线，绕月相一圈 -->
          <view
            v-for="tick in 8"
            :key="tick"
            class="arcana__hero-tick"
            :style="{ transform: `rotate(${tick * 45}deg)` }"
          />
        </view>

        <text class="arcana__hero-title">向星辰寻一个答案</text>
        <text class="arcana__hero-sub">选择一种牌阵，让问题慢慢显现。</text>
      </view>

      <view v-if="loading" class="arcana__state">
        <text class="arcana__state-text">正在翻阅星象手稿…</text>
      </view>

      <view v-else-if="loadError" class="arcana__state">
        <text class="arcana__state-text">{{ loadError }}</text>
        <view class="arcana__retry" @tap="bootstrap">重新加载</view>
      </view>

      <template v-else>
        <!-- 主推：今日指引（横向艺术卡） -->
        <view
          v-if="featured"
          class="arcana__featured"
          :class="pressed === featured.id ? 'arcana__featured--pressed' : ''"
          @touchstart="onPressIn(featured.id)"
          @touchend="onPressOut"
          @touchcancel="onPressOut"
          @tap="start(featured)"
        >
          <!-- 左侧：真实牌背（倾斜摆放，带月光） -->
          <view class="arcana__featured-art">
            <view class="arcana__featured-glow" />
            <view class="arcana__featured-card">
              <view class="arcana__featured-card-frame">
                <text class="arcana__featured-glyph">✦</text>
              </view>
            </view>
          </view>

          <!-- 右侧：标题与引导 -->
          <view class="arcana__featured-body">
            <text class="arcana__eyebrow">{{ EYEBROW['DAILY'] }}</text>
            <text class="arcana__featured-title">今日指引</text>
            <text class="arcana__featured-desc">一张牌，感受今天的方向。</text>
            <view class="arcana__featured-action">
              <view class="arcana__featured-arrow">
                <text class="arcana__featured-arrow-glyph">→</text>
              </view>
            </view>
          </view>
        </view>

        <!-- 今日单张入口（轻量玩法）：做成一行细金线分隔的次要入口 -->
        <view class="arcana__minor" @tap="goDaily">
          <text class="arcana__minor-text">只想抽一张？今日单张指引</text>
          <text class="arcana__minor-arrow">›</text>
        </view>

        <!-- 其余牌阵：各自专属排列图 -->
        <view class="arcana__section">
          <text class="arcana__section-title">其他牌阵</text>
          <view class="arcana__section-rule" />
        </view>

        <view
          v-for="spread in others"
          :key="spread.id"
          class="arcana__item"
          :class="pressed === spread.id ? 'arcana__item--pressed' : ''"
          @touchstart="onPressIn(spread.id)"
          @touchend="onPressOut"
          @touchcancel="onPressOut"
        >
          <view class="arcana__item-main" @tap="start(spread)">
            <SpreadGlyph
              :layout="spread.layout"
              :card-count="spread.cardCount"
              :width-rpx="180"
              :height-rpx="132"
              :card-rpx="24"
            />

            <view class="arcana__item-body">
              <view class="arcana__item-head">
                <text class="arcana__item-title">{{ spread.name }}</text>
                <text class="arcana__item-count">{{ spread.cardCount }} 张</text>
              </view>
              <text class="arcana__eyebrow arcana__item-eyebrow">{{ EYEBROW[spread.id] ?? '' }}</text>
              <text class="arcana__item-desc">{{ spread.tagline }}</text>
            </view>

            <view class="arcana__item-arrow">
              <text class="arcana__item-arrow-glyph">›</text>
            </view>
          </view>

          <view class="arcana__item-toggle" @tap="toggle(spread.id)">
            <text class="arcana__item-toggle-text">{{ expanded === spread.id ? '收起说明' : '这个牌阵怎么读' }}</text>
          </view>

          <view v-if="expanded === spread.id" class="arcana__item-detail">
            <text class="arcana__item-intro">{{ spread.intro }}</text>
            <view v-for="(position, index) in spread.positions" :key="position.key" class="arcana__pos">
              <text class="arcana__pos-index">{{ index + 1 }}</text>
              <view class="arcana__pos-body">
                <text class="arcana__pos-label">{{ position.label }}</text>
                <text class="arcana__pos-question">{{ position.question }}</text>
              </view>
            </view>
          </view>
        </view>

        <text class="arcana__footnote">每天每个牌阵的牌是固定的（刷新不会变）。明天再来会是一组新的牌。</text>
      </template>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.arcana {
  position: relative;
  min-height: 100vh;
  padding-bottom: $arcana-space-xxl;
  background-color: $arcana-ink;

  // ---------------------------------------------------------------- 导航
  &__nav {
    position: fixed;
    top: 0;
    right: 0;
    left: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    box-sizing: border-box;
    padding-right: $arcana-space-md;
    padding-left: $arcana-space-md;
    background: linear-gradient(180deg, rgba(16, 20, 34, 0.96) 0%, rgba(16, 20, 34, 0.7) 70%, rgba(16, 20, 34, 0) 100%);
  }

  &__nav-back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56rpx;
    height: 56rpx;
  }

  &__nav-arrow {
    font-size: 40rpx;
    line-height: 1;
    color: $arcana-gold;
  }

  &__nav-title-box {
    flex: 1;
    margin-left: $arcana-space-xs;
  }

  &__nav-title {
    font-family: $arcana-font-serif;
    font-size: 32rpx;
    letter-spacing: 6rpx;
    color: $arcana-moon;
  }

  &__nav-moon {
    display: flex;
    align-items: center;
  }

  &__moon-dot {
    width: 10rpx;
    height: 10rpx;
    margin-left: 8rpx;
    border-radius: 50%;
  }

  &__moon-dot--new {
    background-color: transparent;
    border: 1rpx solid rgba(201, 171, 115, 0.6);
  }

  &__moon-dot--half {
    background: linear-gradient(90deg, $arcana-gold 50%, transparent 50%);
    border: 1rpx solid rgba(201, 171, 115, 0.6);
  }

  &__moon-dot--full {
    background-color: $arcana-gold;
  }

  &__body {
    position: relative;
    z-index: 2;
    padding-right: $arcana-space-lg;
    padding-left: $arcana-space-lg;
  }

  // ---------------------------------------------------------------- 主题区
  &__hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: $arcana-space-xl 0 $arcana-space-lg;
  }

  &__hero-moon {
    position: relative;
    width: 200rpx;
    height: 200rpx;
  }

  &__hero-moon-core {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 96rpx;
    height: 96rpx;
    margin-top: -48rpx;
    margin-left: -48rpx;
    background: radial-gradient(circle at 36% 32%, #f7f1e4 0%, #e2d7bf 46%, #b9a880 100%);
    border-radius: 50%;
    box-shadow: 0 0 40rpx rgba(242, 235, 221, 0.22);
    animation: hero-moon 7s ease-in-out infinite;
  }

  &__hero-moon-ring {
    position: absolute;
    top: 50%;
    left: 50%;
    border: 1rpx solid rgba(201, 171, 115, 0.28);
    border-radius: 50%;
  }

  &__hero-moon-ring--outer {
    width: 184rpx;
    height: 184rpx;
    margin-top: -92rpx;
    margin-left: -92rpx;
  }

  &__hero-moon-ring--inner {
    width: 140rpx;
    height: 140rpx;
    margin-top: -70rpx;
    margin-left: -70rpx;
    border-color: rgba(201, 171, 115, 0.14);
  }

  &__hero-tick {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 1rpx;
    height: 92rpx;
    margin-top: -92rpx;
    background: linear-gradient(180deg, rgba(201, 171, 115, 0.5) 0%, rgba(201, 171, 115, 0) 26%);
    transform-origin: center bottom;
  }

  &__hero-title {
    margin-top: $arcana-space-lg;
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-display;
    letter-spacing: 4rpx;
    color: $arcana-moon;
  }

  &__hero-sub {
    margin-top: $arcana-space-sm;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-meta;
    letter-spacing: 1rpx;
    color: $arcana-silver;
  }

  // ---------------------------------------------------------------- 主推卡
  &__featured {
    display: flex;
    align-items: center;
    padding: $arcana-space-md;
    background: linear-gradient(132deg, #1b2337 0%, #252039 58%, #1a2135 100%);
    border: 1rpx solid rgba(201, 171, 115, 0.32);
    border-radius: $arcana-radius-lg;
    box-shadow: 0 12rpx 36rpx rgba(5, 7, 14, 0.45);
    transition:
      transform $arcana-dur-tap $arcana-ease,
      border-color $arcana-dur-tap $arcana-ease,
      box-shadow $arcana-dur-tap $arcana-ease;
  }

  &__featured--pressed {
    border-color: $arcana-gold;
    box-shadow: 0 12rpx 40rpx rgba(201, 171, 115, 0.22);
    transform: scale(0.98);
  }

  &__featured-art {
    position: relative;
    flex-shrink: 0;
    width: 176rpx;
    height: 268rpx;
  }

  &__featured-glow {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 240rpx;
    height: 240rpx;
    margin-top: -120rpx;
    margin-left: -130rpx;
    @include arcana-moonlight(0.16);
    border-radius: 50%;
  }

  &__featured-card {
    position: absolute;
    top: 50%;
    left: 50%;
    box-sizing: border-box;
    width: 148rpx;
    height: 240rpx;
    padding: 5rpx;
    margin-top: -120rpx;
    margin-left: -74rpx;
    background:
      repeating-linear-gradient(45deg, rgba(201, 171, 115, 0.1) 0 2rpx, transparent 2rpx 14rpx),
      repeating-linear-gradient(-45deg, rgba(201, 171, 115, 0.1) 0 2rpx, transparent 2rpx 14rpx),
      linear-gradient(162deg, #1a2135 0%, #2b2440 52%, #171d2c 100%);
    border: 1rpx solid rgba(201, 171, 115, 0.5);
    border-radius: 10rpx;
    box-shadow: 0 10rpx 28rpx rgba(5, 7, 14, 0.55);
    transform: rotate(-8deg);
  }

  &__featured-card-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    border: 1rpx solid rgba(201, 171, 115, 0.25);
    border-radius: 7rpx;
  }

  &__featured-glyph {
    font-size: 28rpx;
    color: $arcana-gold;
    opacity: 0.85;
  }

  &__featured-body {
    flex: 1;
    padding-left: $arcana-space-lg;
  }

  &__eyebrow {
    @include arcana-eyebrow;
  }

  &__featured-title {
    display: block;
    margin-top: $arcana-space-xs;
    font-family: $arcana-font-serif;
    font-size: 44rpx;
    letter-spacing: 4rpx;
    color: $arcana-moon;
  }

  &__featured-desc {
    display: block;
    margin-top: $arcana-space-sm;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-meta;
    line-height: 1.6;
    color: $arcana-silver;
  }

  &__featured-action {
    display: flex;
    margin-top: $arcana-space-lg;
  }

  &__featured-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64rpx;
    height: 64rpx;
    border: 1rpx solid rgba(201, 171, 115, 0.55);
    border-radius: 50%;
  }

  &__featured-arrow-glyph {
    font-size: 28rpx;
    color: $arcana-gold;
  }

  // ---------------------------------------------------------------- 次要入口
  &__minor {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $arcana-space-md 0;
    margin-top: $arcana-space-md;
  }

  &__minor-text {
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-meta;
    color: $arcana-silver;
  }

  &__minor-arrow {
    font-size: 30rpx;
    color: rgba(201, 171, 115, 0.6);
  }

  // ---------------------------------------------------------------- 区块标题
  &__section {
    display: flex;
    align-items: center;
    margin: $arcana-space-lg 0 $arcana-space-md;
  }

  &__section-title {
    margin-right: $arcana-space-md;
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-card;
    letter-spacing: 3rpx;
    color: $arcana-moon;
  }

  &__section-rule {
    flex: 1;
    @include arcana-rule;
  }

  // ---------------------------------------------------------------- 牌阵项
  &__item {
    margin-bottom: $arcana-space-md;
    background-color: $arcana-navy;
    border: 1rpx solid rgba(201, 171, 115, 0.18);
    border-radius: $arcana-radius-card;
    transition:
      transform $arcana-dur-tap $arcana-ease,
      border-color $arcana-dur-tap $arcana-ease;
  }

  &__item--pressed {
    border-color: rgba(201, 171, 115, 0.6);
    transform: scale(0.98);
  }

  &__item-main {
    display: flex;
    align-items: center;
    padding: $arcana-space-md;
  }

  &__item-body {
    flex: 1;
    padding-left: $arcana-space-md;
  }

  &__item-head {
    display: flex;
    align-items: baseline;
  }

  &__item-title {
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-card;
    letter-spacing: 2rpx;
    color: $arcana-moon;
  }

  &__item-count {
    margin-left: $arcana-space-sm;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    color: rgba(201, 171, 115, 0.75);
  }

  &__item-eyebrow {
    display: block;
    margin-top: 6rpx;
    font-size: 16rpx;
    letter-spacing: 2rpx;
  }

  &__item-desc {
    display: block;
    margin-top: $arcana-space-xs;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-meta;
    line-height: 1.55;
    color: $arcana-silver;
  }

  &__item-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48rpx;
  }

  &__item-arrow-glyph {
    font-size: 30rpx;
    color: rgba(201, 171, 115, 0.7);
  }

  &__item-toggle {
    padding: $arcana-space-sm $arcana-space-md;
    border-top: 1rpx solid $arcana-gold-faint;
  }

  &__item-toggle-text {
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    letter-spacing: 1rpx;
    color: rgba(201, 171, 115, 0.8);
  }

  &__item-detail {
    padding: 0 $arcana-space-md $arcana-space-md;
  }

  &__item-intro {
    display: block;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-meta;
    line-height: $arcana-lh-body;
    color: $arcana-silver;
  }

  &__pos {
    display: flex;
    align-items: flex-start;
    margin-top: $arcana-space-md;
  }

  &__pos-index {
    flex-shrink: 0;
    width: 34rpx;
    height: 34rpx;
    margin-right: $arcana-space-sm;
    font-family: $arcana-font-serif;
    font-size: 18rpx;
    line-height: 34rpx;
    color: $arcana-gold;
    text-align: center;
    border: 1rpx solid rgba(201, 171, 115, 0.4);
    border-radius: 50%;
  }

  &__pos-body {
    flex: 1;
  }

  &__pos-label {
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-meta;
    color: $arcana-moon;
  }

  &__pos-question {
    display: block;
    margin-top: 2rpx;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    line-height: 1.6;
    color: rgba(168, 166, 184, 0.85);
  }

  // ---------------------------------------------------------------- 状态
  &__state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: $arcana-space-xxl 0;
  }

  &__state-text {
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-meta;
    color: $arcana-silver;
  }

  &__retry {
    padding: $arcana-space-sm $arcana-space-lg;
    margin-top: $arcana-space-md;
    font-size: $arcana-fs-meta;
    color: $arcana-gold;
    border: 1rpx solid rgba(201, 171, 115, 0.5);
    border-radius: $arcana-radius-round;
  }

  &__footnote {
    display: block;
    margin-top: $arcana-space-lg;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    line-height: 1.7;
    color: rgba(168, 166, 184, 0.6);
    text-align: center;
  }
}

@keyframes hero-moon {
  0%,
  100% {
    box-shadow: 0 0 34rpx rgba(242, 235, 221, 0.18);
  }

  50% {
    box-shadow: 0 0 54rpx rgba(242, 235, 221, 0.3);
  }
}

@media (prefers-reduced-motion: reduce) {
  .arcana__hero-moon-core {
    animation: none;
  }
}
</style>
