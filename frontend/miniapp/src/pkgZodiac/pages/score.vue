<script setup lang="ts">
/**
 * 今日分数详情（分包 pkgZodiac）
 *
 * ## 页面结构（自上而下）
 *
 *   ① **综合分数**：大字 + 星级 + 今日基调 —— 一眼就能看完
 *   ② **五个分项**：爱情 / 财富 / 事业 / 学习 / 人际（带分数条）
 *   ③ **幸运三件**：颜色 / 数字 / 方向
 *   ④ **今日运势入口** → 运势详情页（日运 / 周运 / 月运 / 年运）
 *
 * ## 两条纪律
 *
 *   ① **不做任何本地计算**：分数、星级、文案全部来自服务端，
 *      前端只负责摆位置。前端一旦"顺手算一下"，就会出现横批 86 分、
 *      详情页 84 分这种无法解释的矛盾；
 *   ② 没设生日时是**空状态**（后端 `30019`），不是错误 —— 引导一次即可。
 */

import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';

import { getDailyFortune, type DailyFortune, type FortuneDimension } from '@/api/zodiac';
import { http } from '@/api/request';
import { ApiError, ERROR_CODES } from '@/api/types';

/** 详情页要展示的五个分项（顺序即用户要求的顺序） */
const DETAIL_DIMENSIONS: ReadonlyArray<{ key: FortuneDimension['key']; icon: string }> = [
  { key: 'LOVE', icon: '❤️' },
  { key: 'WEALTH', icon: '💰' },
  { key: 'CAREER', icon: '🚀' },
  { key: 'STUDY', icon: '📚' },
  { key: 'SOCIAL', icon: '🤝' },
];

const loading = ref(true);
const loadError = ref('');
const needsBirthday = ref(false);
const fortune = ref<DailyFortune | null>(null);

/** 今天的 `YYYY-MM-DD`（本地时区口径） */
const localToday = (): string => {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');

  return `${now.getFullYear()}-${month}-${day}`;
};

const today = localToday();

const overall = computed<FortuneDimension | null>(
  () => fortune.value?.dimensions.find((item) => item.key === 'OVERALL') ?? null,
);

/** 只取用户要求的五个分项（状态那维留给星座运势页，不在这里摊开） */
const detailDimensions = computed<FortuneDimension[]>(() => {
  const list = fortune.value?.dimensions ?? [];

  return DETAIL_DIMENSIONS.map((item) => list.find((dimension) => dimension.key === item.key)).filter(
    (dimension): dimension is FortuneDimension => dimension !== undefined,
  );
});

const overallStars = computed<string>(() => {
  const stars = overall.value?.stars ?? 0;

  return '★'.repeat(stars) + '☆'.repeat(Math.max(0, 5 - stars));
});

/** 分数条宽度（分数本身就是百分比，直接当宽度用） */
const barWidth = (score: number): string => `${Math.max(4, Math.min(100, score))}%`;

/** 分数配色：高分偏暖、低分偏淡，只影响观感，不表达吉凶 */
const barClass = (score: number): string =>
  score >= 85 ? 'score__bar--high' : score >= 70 ? 'score__bar--mid' : 'score__bar--low';

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
    fortune.value = await getDailyFortune(today);
    needsBirthday.value = false;
  } catch (error) {
    if (error instanceof ApiError && error.code === ERROR_CODES.ZODIAC_BIRTHDAY_REQUIRED) {
      needsBirthday.value = true;
      return;
    }

    console.error('[zodiac] 今日分数加载失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

/** 日期选择器（没生日时在本页直接选，不必来回跳） */
const birthdayDraft = ref('1996-01-01');
const saving = ref(false);

const onBirthdayChange = (event: { detail: { value: string } }): void => {
  birthdayDraft.value = event.detail.value;
};

const saveBirthday = async (): Promise<void> => {
  if (saving.value) return;

  saving.value = true;
  try {
    // 走统一的用户资料接口，而不是本模块自己写库
    await http.patch('/users/me', { birthday: birthdayDraft.value });
    uni.showToast({ title: '已记住你的生日', icon: 'none' });
    await bootstrap();
  } catch (error) {
    console.error('[zodiac] 保存出生日期失败：', error);
    uni.showToast({ title: '保存失败，请稍后再试', icon: 'none' });
  } finally {
    saving.value = false;
  }
};

const goFortune = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/fortune' });
};

const goZodiac = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/index' });
};
</script>

<template>
  <view class="score page-container">
    <view v-if="loading" class="card score__state">
      <text>正在算今天的分数…</text>
    </view>

    <view v-else-if="loadError" class="card score__state">
      <text class="score__state-title">{{ loadError }}</text>
      <button class="score__state-action" @tap="bootstrap">重新加载</button>
    </view>

    <view v-else-if="needsBirthday" class="card score__state">
      <text class="score__state-title">先选一次你的出生日期</text>
      <text class="score__state-desc">今日分数按星座算（只取月与日，年份不影响星座）。选一次就记住了。</text>
      <picker mode="date" :value="birthdayDraft" start="1900-01-01" :end="today" @change="onBirthdayChange">
        <view class="score__picker">
          <text class="score__picker-value">{{ birthdayDraft }}</text>
          <text class="score__picker-arrow">修改 ›</text>
        </view>
      </picker>
      <button class="score__state-action" :disabled="saving" @tap="saveBirthday">开始</button>
    </view>

    <template v-else-if="fortune && overall">
      <!-- ① 综合分数 -->
      <view class="score__hero">
        <text class="score__hero-label">今日综合</text>
        <view class="score__hero-row">
          <text class="score__hero-value">{{ overall.score }}</text>
          <text class="score__hero-unit">分</text>
          <text class="score__hero-stars">{{ overallStars }}</text>
        </view>
        <text class="score__hero-tone">{{ fortune.tone }}</text>
        <text class="score__hero-meta">{{ fortune.signName }} · {{ fortune.date }}</text>
      </view>

      <!-- ② 五个分项 -->
      <view class="card score__block">
        <text class="score__block-title">各分项</text>
        <view v-for="(item, index) in detailDimensions" :key="item.key" class="score__item">
          <view class="score__item-head">
            <text class="score__item-name"> {{ DETAIL_DIMENSIONS[index]?.icon }} {{ item.label }} </text>
            <text class="score__item-score">{{ item.score }} 分</text>
          </view>
          <view class="score__bar-track">
            <view class="score__bar" :class="barClass(item.score)" :style="{ width: barWidth(item.score) }" />
          </view>
          <text class="score__item-line">{{ item.line }}</text>
        </view>
      </view>

      <!-- ③ 幸运三件 -->
      <view class="card score__block">
        <text class="score__block-title">今天的幸运</text>
        <view class="score__lucky">
          <view class="score__lucky-item">
            <view class="score__lucky-dot" :style="{ backgroundColor: fortune.lucky.color.hex }" />
            <text class="score__lucky-label">幸运色</text>
            <text class="score__lucky-value">{{ fortune.lucky.color.name }}</text>
          </view>
          <view class="score__lucky-item">
            <text class="score__lucky-number">{{ fortune.lucky.number }}</text>
            <text class="score__lucky-label">幸运数字</text>
          </view>
          <view class="score__lucky-item">
            <text class="score__lucky-compass">🧭</text>
            <text class="score__lucky-label">幸运方向</text>
            <text class="score__lucky-value">{{ fortune.lucky.direction }}</text>
          </view>
        </view>
      </view>

      <!-- ④ 今日运势入口 -->
      <view class="card score__entry" @tap="goFortune">
        <view class="score__entry-body">
          <text class="score__entry-title">今日运势</text>
          <text class="score__entry-desc">日运 · 周运 · 月运 · 年运，想看哪一段点进去</text>
        </view>
        <text class="score__entry-arrow">→</text>
      </view>

      <!-- 宜 / 忌 与箴言（放最后，避免打断前面的分数阅读） -->
      <view class="card score__block">
        <text class="score__block-title">今日宜忌</text>
        <view class="score__good-avoid">
          <view class="score__ga-column">
            <text class="score__ga-label score__ga-label--good">宜</text>
            <text v-for="item in fortune.good" :key="item" class="score__ga-item">{{ item }}</text>
          </view>
          <view class="score__ga-column">
            <text class="score__ga-label score__ga-label--avoid">忌</text>
            <text v-for="item in fortune.avoid" :key="item" class="score__ga-item">{{ item }}</text>
          </view>
        </view>
        <text class="score__quote">{{ fortune.quote }}</text>
      </view>

      <view class="card score__more" @tap="goZodiac">
        <text class="score__more-text">看星座档案 · 星座配对 · 我的星盘</text>
        <text class="score__entry-arrow">→</text>
      </view>

      <!-- 合规声明：服务端下发，原样展示 -->
      <view class="card score__disclaimer">
        <text class="score__disclaimer-text">{{ fortune.disclaimer }}</text>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.score {
  &__state {
    text-align: center;
  }

  &__state-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__state-desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__state-action {
    margin-top: $space-md;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__picker {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $space-sm 0;
    margin-top: $space-sm;
  }

  &__picker-value {
    font-size: $font-size-md;
    color: $color-primary;
  }

  &__picker-arrow {
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__hero {
    padding: $space-lg $space-md;
    background: linear-gradient(135deg, #2b2f4a 0%, #4a3f6b 100%);
    border-radius: $radius-lg;
  }

  &__hero-label {
    display: block;
    color: $color-text-inverse;
    font-size: $font-size-xs;
    opacity: 0.75;
  }

  &__hero-row {
    display: flex;
    align-items: baseline;
    margin-top: $space-xs;
  }

  &__hero-value {
    font-size: 96rpx;
    font-weight: $font-weight-bold;
    line-height: 1.05;
    color: $color-text-inverse;
  }

  &__hero-unit {
    margin-left: 6rpx;
    font-size: $font-size-md;
    color: $color-text-inverse;
    opacity: 0.8;
  }

  &__hero-stars {
    margin-left: $space-md;
    font-size: $font-size-md;
    color: $color-secondary;
  }

  &__hero-tone {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-inverse;
    opacity: 0.9;
  }

  &__hero-meta {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-xs;
    color: $color-text-inverse;
    opacity: 0.7;
  }

  &__block {
    margin-top: $space-md;
  }

  &__block-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__item {
    margin-top: $space-md;
  }

  &__item-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__item-name {
    font-size: $font-size-sm;
    font-weight: $font-weight-medium;
  }

  &__item-score {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
  }

  &__bar-track {
    height: 12rpx;
    margin-top: $space-xs;
    overflow: hidden;
    background-color: $color-bg-hover;
    border-radius: $radius-round;
  }

  &__bar {
    height: 100%;
    border-radius: $radius-round;
  }

  &__bar--high {
    background-color: $color-success;
  }

  &__bar--mid {
    background-color: $color-primary;
  }

  &__bar--low {
    background-color: $color-warning;
  }

  &__item-line {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__lucky {
    display: flex;
    margin-top: $space-md;
  }

  &__lucky-item {
    flex: 1;
    text-align: center;
  }

  &__lucky-dot {
    width: 40rpx;
    height: 40rpx;
    margin: 0 auto;
    border-radius: $radius-round;
  }

  &__lucky-number,
  &__lucky-compass {
    display: block;
    height: 40rpx;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    line-height: 40rpx;
    color: $color-primary;
  }

  &__lucky-label {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__lucky-value {
    display: block;
    margin-top: 2rpx;
    font-size: $font-size-sm;
    font-weight: $font-weight-medium;
  }

  &__entry,
  &__more {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: $space-md;
  }

  &__entry-body {
    flex: 1;
  }

  &__entry-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__entry-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__entry-arrow {
    font-size: $font-size-md;
    color: $color-primary;
  }

  &__more-text {
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__good-avoid {
    display: flex;
    margin-top: $space-sm;
  }

  &__ga-column {
    flex: 1;
  }

  &__ga-label {
    display: block;
    font-size: $font-size-xs;
    font-weight: $font-weight-semibold;
  }

  &__ga-label--good {
    color: $color-success;
  }

  &__ga-label--avoid {
    color: $color-warning;
  }

  &__ga-item {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    color: $color-text-regular;
  }

  &__quote {
    display: block;
    margin-top: $space-md;
    padding-top: $space-md;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
    border-top: 1rpx solid $color-divider;
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
