<script setup lang="ts">
/**
 * 塔罗牌 · 抽卡与解读（分包 pkgZodiac）
 *
 * ## 页面节奏（四层）
 *
 *   ① **牌桌**：按牌阵布局真实摆位，逐张翻开（首张 360ms，其余 220ms）——
 *      抽卡要有过程感，一次"啪"地全出来就成了静态图；
 *   ② **一句话启示**：先给结论，再给细节。用户最先要的是"这跟我有什么关系"；
 *   ③ **逐张象征 + 串起来看**：这个位置在问什么、这张牌说了什么、几张合起来是什么走向；
 *   ④ **可以怎么用**：落到可执行的收尾建议。
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

/** 同一牌阵里最挤的一行有几张 */
const widestRow = computed<number>(() => layoutRows.value.reduce((max, row) => Math.max(max, row.length), 1));

/**
 * 多张牌阵的牌面宽度（rpx）
 *
 * ⚠ 这里必须反算，不能一律写死 148rpx：
 *   750rpx 设计宽度 − 页面左右内边距 = 约 670rpx 可用，
 *   每张牌左右各留 5rpx → 单张实际占 `宽 + 10`rpx。
 *   5 张 × 148rpx = 800rpx，已超过可用宽度，`flex` 会自己折成 4+1 ——
 *   "七日指引"的五加二就成了四加三，牌阵位置的意义当场丢掉。
 * 所以按最挤的那一行反算，且同一牌阵内所有牌等大（大小混排同样破坏格局）。
 */
const cardSizeRpx = computed<number>(() => {
  if (isSingle.value) return 300;

  const available = 670;
  const slotGap = 10;
  const fitted = Math.floor((available - slotGap * widestRow.value) / widestRow.value);

  return Math.min(148, fitted);
});

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
  <view class="draw">
    <view v-if="loading" class="draw__state">
      <text class="draw__state-text">正在洗牌…</text>
    </view>

    <view v-else-if="loadError" class="draw__state">
      <text class="draw__state-title">{{ loadError }}</text>
      <view class="draw__state-action" @tap="goBack">回去换一个牌阵</view>
    </view>

    <template v-else-if="reading && spread">
      <!-- ① 标题区 -->
      <view class="draw__head">
        <text class="draw__ornament">✦ ─────── ✦</text>
        <text class="draw__title">{{ reading.spreadName }}</text>
        <text class="draw__date">{{ reading.date }} · 共 {{ reading.draws.length }} 张</text>
      </view>

      <!-- ② 牌桌：按布局分行，逐张翻开 -->
      <view class="draw__table">
        <view v-for="(row, rowIndex) in layoutRows" :key="rowIndex" class="draw__row">
          <view v-for="index in row" :key="index" class="draw__slot" :class="{ 'draw__slot--single': isSingle }">
            <text class="draw__slot-label" :style="{ maxWidth: `${cardSizeRpx}rpx` }">{{
              reading.draws[index]?.position.label
            }}</text>

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
                :size-rpx="cardSizeRpx"
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

      <template v-if="fullyRevealed">
        <!-- ③ 一句话启示：先给结论 -->
        <view class="draw__summary">
          <text class="draw__summary-label">这一抽在说什么</text>
          <text class="draw__summary-headline">{{ reading.summary.headline }}</text>

          <view class="draw__stats">
            <view class="draw__stat">
              <text class="draw__stat-value">{{ reading.summary.stats.majorCount }}</text>
              <text class="draw__stat-label">大阿卡纳 · 共 {{ reading.summary.stats.total }} 张</text>
            </view>
            <view class="draw__stat-divider" />
            <view class="draw__stat">
              <text class="draw__stat-value">{{ reading.summary.stats.reversedCount }}</text>
              <text class="draw__stat-label">逆位 · 共 {{ reading.summary.stats.total }} 张</text>
            </view>
          </view>
        </view>

        <!-- ④ 逐张象征 -->
        <view class="draw__block">
          <view class="draw__block-head">
            <text class="draw__block-eyebrow">CARD BY CARD</text>
            <text class="draw__block-title">逐张看</text>
          </view>

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

        <!-- ⑤ 牌阵结构 -->
        <view class="draw__block">
          <view class="draw__block-head">
            <text class="draw__block-eyebrow">THE PATTERN</text>
            <text class="draw__block-title">牌与牌之间</text>
          </view>
          <text class="draw__block-body">{{ reading.summary.structure }}</text>
        </view>

        <!-- ⑥ 串起来看 -->
        <view class="draw__block">
          <view class="draw__block-head">
            <text class="draw__block-eyebrow">IN ONE READING</text>
            <text class="draw__block-title">把牌串起来看</text>
          </view>
          <text class="draw__block-body">{{ reading.summary.narrative }}</text>
        </view>

        <!-- ⑦ 建议 -->
        <view class="draw__block draw__block--advice">
          <view class="draw__block-head">
            <text class="draw__block-eyebrow">TO TAKE AWAY</text>
            <text class="draw__block-title">可以怎么用</text>
          </view>
          <text class="draw__block-body">{{ reading.summary.advice }}</text>
        </view>

        <text class="draw__note">同一天同一个牌阵的结果是固定的（刷新不会变）。明天再来会是一组新的牌。</text>

        <view class="draw__disclaimer">
          <text class="draw__disclaimer-text">{{ reading.disclaimer }}</text>
        </view>
      </template>
    </template>
  </view>
</template>

<style lang="scss" scoped>
/**
 * 本页是深色场景（$arcana-night），三条纪律：
 *
 *   ① **不借用全局 `.card`**：那是白底深字的浅色卡片，压在夜空上像贴了一叠纸，
 *      深色文字也几乎看不见。容器全部在这里用 `$arcana-*` 自己写；
 *   ② **底板与辉光分开写**：辉光用 `background-image`，不用 `background` 简写 ——
 *      简写会把 `background-color` 重置成透明，深色卡片就"漏底"了；
 *   ③ **根节点锁横向溢出**：牌宽已从可用宽度反算（见 `cardSizeRpx`），
 *      但 rpx 取整、小屏缩放仍可能有 1~2rpx 余量，`overflow-x: hidden` 兜住，
 *      否则整页能被左右拖动，用户第一眼就会觉得"歪了"。
 */
.draw {
  box-sizing: border-box;
  min-height: 100vh;
  padding: $arcana-space-lg $arcana-space-md 120rpx;
  overflow-x: hidden;
  background-color: $arcana-night;

  // ---------------------------------------------------------------- 状态
  &__state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: $arcana-space-xxl $arcana-space-lg;
    text-align: center;
  }

  &__state-text {
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-body;
    color: $arcana-silver;
  }

  &__state-title {
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-card;
    line-height: 1.6;
    color: $arcana-moon;
  }

  &__state-action {
    padding: $arcana-space-sm $arcana-space-xl;
    margin-top: $arcana-space-lg;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-meta;
    color: $arcana-gold;
    border: 1rpx solid $arcana-gold-soft;
    border-radius: $arcana-radius-round;
  }

  // ---------------------------------------------------------------- 标题
  &__head {
    padding: $arcana-space-md 0 $arcana-space-lg;
    text-align: center;
  }

  &__ornament {
    display: block;
    font-size: $arcana-fs-micro;
    letter-spacing: 6rpx;
    color: $arcana-gold-soft;
  }

  &__title {
    display: block;
    margin-top: $arcana-space-sm;
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-title;
    letter-spacing: 3rpx;
    color: $arcana-moon;
  }

  &__date {
    display: block;
    margin-top: $arcana-space-xs;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    letter-spacing: 1rpx;
    color: rgba(168, 166, 184, 0.72);
  }

  // ---------------------------------------------------------------- 牌桌
  &__table {
    padding: $arcana-space-md $arcana-space-xs;
    background-color: $arcana-navy-deep;
    background-image: radial-gradient(circle at 50% 0%, rgba(242, 235, 221, 0.07) 0%, rgba(242, 235, 221, 0) 68%);
    border: 1rpx solid $arcana-gold-faint;
    border-radius: $arcana-radius-lg;
  }

  &__row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: center;

    // 行与行之间留白，靠兄弟选择器而不是给每行都加 margin-bottom
    & + & {
      margin-top: $arcana-space-md;
    }
  }

  &__slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 0 5rpx;
  }

  &__slot--single {
    width: 100%;
    margin: 0;
  }

  &__slot-label {
    margin-bottom: $arcana-space-xs;
    overflow: hidden;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    letter-spacing: 1rpx;
    color: rgba(242, 235, 221, 0.66);
    text-align: center;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  // ---------------------------------------------------------------- 牌出场
  &__card {
    opacity: 0.35;
    transform: translateY(18rpx) scale(0.94);
    transition:
      opacity 0.34s $arcana-ease-out,
      transform 0.34s $arcana-ease-out;
  }

  &__card--in {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  &__orientation {
    padding: 2rpx $arcana-space-sm;
    margin-top: $arcana-space-xs;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    letter-spacing: 1rpx;
    color: $arcana-gold;
    background-color: rgba(201, 171, 115, 0.14);
    border-radius: $arcana-radius-round;
  }

  // 逆位是中性的"受阻 / 内化 / 过量"，不换警示色
  &__orientation--reversed {
    color: $arcana-lilac;
    background-color: rgba(175, 163, 200, 0.16);
  }

  // ---------------------------------------------------------------- 一句话启示
  &__summary {
    padding: $arcana-space-lg $arcana-space-md;
    margin-top: $arcana-space-lg;
    background-color: $arcana-navy;
    background-image: radial-gradient(circle at 50% 0%, rgba(242, 235, 221, 0.09) 0%, rgba(242, 235, 221, 0) 72%);
    border: 1rpx solid $arcana-gold-soft;
    border-radius: $arcana-radius-card;
  }

  &__summary-label {
    display: block;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    letter-spacing: 3rpx;
    color: rgba(201, 171, 115, 0.75);
  }

  &__summary-headline {
    display: block;
    margin-top: $arcana-space-sm;
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-card;
    line-height: 1.75;
    color: $arcana-moon;
  }

  // 统计只当"可信度注脚"：字号压到最小、不加色块，别跟结论抢
  &__stats {
    display: flex;
    align-items: center;
    padding-top: $arcana-space-md;
    margin-top: $arcana-space-md;
    border-top: 1rpx solid $arcana-gold-faint;
  }

  &__stat {
    flex: 1;
    text-align: center;
  }

  &__stat-divider {
    width: 1rpx;
    height: 48rpx;
    background-image: linear-gradient(
      180deg,
      rgba(201, 171, 115, 0) 0%,
      $arcana-gold-soft 50%,
      rgba(201, 171, 115, 0) 100%
    );
  }

  &__stat-value {
    display: block;
    font-family: $arcana-font-serif;
    font-size: 40rpx;
    font-weight: 600;
    line-height: 1.1;
    color: $arcana-gold;
  }

  &__stat-label {
    display: block;
    margin-top: 4rpx;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    color: rgba(168, 166, 184, 0.78);
  }

  // ---------------------------------------------------------------- 正文区块
  &__block {
    padding: $arcana-space-lg $arcana-space-md;
    margin-top: $arcana-space-md;
    background-color: $arcana-navy;
    border: 1rpx solid $arcana-gold-faint;
    border-radius: $arcana-radius-card;
  }

  &__block--advice {
    border-left: 4rpx solid $arcana-gold-soft;
  }

  &__block-head {
    margin-bottom: $arcana-space-md;
  }

  &__block-eyebrow {
    display: block;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    letter-spacing: 3rpx;
    color: rgba(201, 171, 115, 0.62);
  }

  &__block-title {
    display: block;
    margin-top: 4rpx;
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-card;
    letter-spacing: 2rpx;
    color: $arcana-moon;
  }

  &__block-body {
    display: block;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-body;
    line-height: $arcana-lh-body;
    color: $arcana-silver;
  }

  // ---------------------------------------------------------------- 逐张
  &__reading {
    // 只在"两张之间"画分隔线：用兄弟选择器，
    // 而不是给每张加 border-top 后再想办法去掉第一条（在 view 上 :first-of-type 并不可靠）
    & + & {
      padding-top: $arcana-space-md;
      margin-top: $arcana-space-md;
      border-top: 1rpx solid $arcana-gold-faint;
    }
  }

  // 位置名与牌名左右分列：左边是"问什么"，右边是"抽到什么"
  &__reading-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__reading-position {
    flex: 0 0 auto;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-meta;
    font-weight: 600;
    letter-spacing: 1rpx;
    color: $arcana-moon;
  }

  &__reading-card {
    flex: 0 1 auto;
    min-width: 0;
    margin-left: $arcana-space-sm;
    overflow: hidden;
    font-family: $arcana-font-serif;
    font-size: $arcana-fs-meta;
    color: $arcana-gold;
    text-align: right;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &__reading-question {
    display: block;
    margin-top: 4rpx;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    line-height: 1.5;
    color: rgba(175, 163, 200, 0.82);
  }

  &__reading-body {
    display: block;
    margin-top: $arcana-space-xs;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-body;
    line-height: $arcana-lh-body;
    color: $arcana-silver;
  }

  // ---------------------------------------------------------------- 脚注
  &__note {
    display: block;
    margin-top: $arcana-space-lg;
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    line-height: 1.7;
    color: rgba(168, 166, 184, 0.6);
    text-align: center;
  }

  &__disclaimer {
    padding: $arcana-space-md;
    margin-top: $arcana-space-md;
    border: 1rpx solid $arcana-gold-faint;
    border-radius: $arcana-radius-card;
  }

  &__disclaimer-text {
    font-family: $arcana-font-sans;
    font-size: $arcana-fs-micro;
    line-height: 1.8;
    color: rgba(168, 166, 184, 0.6);
  }
}
</style>
