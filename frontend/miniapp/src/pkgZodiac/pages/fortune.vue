<script setup lang="ts">
/**
 * 运势详情（分包 pkgZodiac）：日运 / 周运 / 月运 / 年运
 *
 * ## 为什么放在**一个页面里用 tab 切换**，而不是四个页面
 *
 * 四种周期是同一个东西的不同时间尺度，用户会来回对照（"这周和这个月对得上吗"）。
 * 拆成四个页面意味着每次对照都要退出再进，返回键会变成迷宫 ——
 * 这与"星座档案做成十二个页面"是同一类错误，都不该做。
 *
 * ## 数据懒加载
 *
 * 首屏只拉日运（立刻可见），切到周/月/年时再拉对应数据并缓存到内存：
 * 四个接口一次性全拉会让首屏变慢，而多数用户只看日运。
 */

import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';

import {
  getDailyFortune,
  getMonthlyFortune,
  getWeeklyFortune,
  getYearlyFortune,
  type DailyFortune,
  type MonthlyFortune,
  type WeeklyFortune,
  type YearlyFortune,
} from '@/api/zodiac';
import { ApiError, ERROR_CODES } from '@/api/types';

type TabKey = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'DAILY', label: '日运' },
  { key: 'WEEKLY', label: '周运' },
  { key: 'MONTHLY', label: '月运' },
  { key: 'YEARLY', label: '年运' },
];

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
const needsBirthday = ref(false);
const activeTab = ref<TabKey>('DAILY');
/** 正在拉取的周期（切换 tab 时的局部 loading） */
const tabLoading = ref(false);

const daily = ref<DailyFortune | null>(null);
const weekly = ref<WeeklyFortune | null>(null);
const monthly = ref<MonthlyFortune | null>(null);
const yearly = ref<YearlyFortune | null>(null);

/** 星级渲染成 ★★★★★（模板里的表达式能力有限，前端拼串） */
const starsOf = (stars: number): string =>
  '★'.repeat(Math.max(0, Math.min(5, stars))) + '☆'.repeat(5 - Math.max(0, Math.min(5, stars)));

/** 当前 tab 是否还没有数据（用于显示局部 loading） */
const currentEmpty = computed<boolean>(() => {
  if (activeTab.value === 'DAILY') return daily.value === null;
  if (activeTab.value === 'WEEKLY') return weekly.value === null;
  if (activeTab.value === 'MONTHLY') return monthly.value === null;

  return yearly.value === null;
});

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
    daily.value = await getDailyFortune(today);
    needsBirthday.value = false;
  } catch (error) {
    if (error instanceof ApiError && error.code === ERROR_CODES.ZODIAC_BIRTHDAY_REQUIRED) {
      needsBirthday.value = true;
      return;
    }

    console.error('[zodiac] 运势加载失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

/**
 * 切换周期
 *
 * 已经有数据就直接切（内存缓存），没有才去拉 —— 四个周期都只是几 KB，
 * 但一次性全拉会让首屏多等三个请求，而多数人只看日运。
 */
const switchTab = async (key: TabKey): Promise<void> => {
  activeTab.value = key;

  if (!currentEmpty.value || tabLoading.value) return;

  tabLoading.value = true;
  try {
    if (key === 'WEEKLY' && weekly.value === null) weekly.value = await getWeeklyFortune(today);
    if (key === 'MONTHLY' && monthly.value === null) monthly.value = await getMonthlyFortune(today);
    if (key === 'YEARLY' && yearly.value === null) yearly.value = await getYearlyFortune(today);
  } catch (error) {
    console.error('[zodiac] 运势分周期加载失败：', error);
    uni.showToast({ title: '这一段暂时取不到，稍后再试', icon: 'none' });
  } finally {
    tabLoading.value = false;
  }
};

const goScore = (): void => {
  uni.navigateBack({ delta: 1 });
};
</script>

<template>
  <view class="fortune page-container">
    <view v-if="loading" class="card fortune__state">
      <text>正在看你的运势…</text>
    </view>

    <view v-else-if="loadError" class="card fortune__state">
      <text class="fortune__state-title">{{ loadError }}</text>
      <button class="fortune__state-action" @tap="bootstrap">重新加载</button>
    </view>

    <view v-else-if="needsBirthday" class="card fortune__state">
      <text class="fortune__state-title">先设置出生日期</text>
      <text class="fortune__state-desc">运势按星座算，星座由出生日期（月与日）决定。</text>
      <button class="fortune__state-action" @tap="goScore">回去设置</button>
    </view>

    <template v-else>
      <!-- 周期切换 -->
      <view class="fortune__tabs">
        <text
          v-for="tab in TABS"
          :key="tab.key"
          class="fortune__tab"
          :class="{ 'fortune__tab--active': activeTab === tab.key }"
          @tap="switchTab(tab.key)"
          >{{ tab.label }}</text
        >
      </view>

      <view v-if="tabLoading" class="card fortune__state">
        <text>正在拉取…</text>
      </view>

      <!-- 日运 -->
      <template v-else-if="activeTab === 'DAILY' && daily">
        <view class="fortune__hero">
          <text class="fortune__hero-sign">{{ daily.signName }}</text>
          <text class="fortune__hero-date">{{ daily.date }}</text>
          <text class="fortune__hero-tone">{{ daily.tone }}</text>
        </view>

        <view class="card fortune__block">
          <text class="fortune__block-title">今日各项</text>
          <view v-for="item in daily.dimensions" :key="item.key" class="fortune__row">
            <text class="fortune__row-name">{{ item.label }}</text>
            <text class="fortune__row-score">{{ item.score }} 分</text>
            <text class="fortune__row-stars">{{ starsOf(item.stars) }}</text>
            <text class="fortune__row-line">{{ item.line }}</text>
          </view>
        </view>
      </template>

      <!-- 周运 -->
      <template v-else-if="activeTab === 'WEEKLY' && weekly">
        <view class="fortune__hero">
          <text class="fortune__hero-sign">{{ weekly.signName }} · 本周</text>
          <text class="fortune__hero-date">{{ weekly.startDate }} ~ {{ weekly.endDate }}</text>
          <text class="fortune__hero-tone">{{ weekly.tip }}</text>
        </view>

        <view class="card fortune__block">
          <text class="fortune__block-title">这一周</text>
          <view v-for="item in weekly.sections" :key="item.key" class="fortune__row">
            <text class="fortune__row-name">{{ item.label }}</text>
            <text class="fortune__row-stars">{{ starsOf(item.stars) }}</text>
            <text class="fortune__row-line">{{ item.line }}</text>
          </view>
        </view>
      </template>

      <!-- 月运 -->
      <template v-else-if="activeTab === 'MONTHLY' && monthly">
        <view class="fortune__hero">
          <text class="fortune__hero-sign">{{ monthly.signName }} · 本月</text>
          <text class="fortune__hero-date">{{ monthly.month }} · 主题：{{ monthly.theme }}</text>
          <text class="fortune__hero-tone">整体 {{ starsOf(monthly.stars) }}</text>
        </view>

        <view class="card fortune__block">
          <text class="fortune__block-title">上旬 / 中旬 / 下旬</text>
          <view v-for="item in monthly.sections" :key="item.key" class="fortune__row">
            <text class="fortune__row-name">{{ item.label }}</text>
            <text class="fortune__row-stars">{{ starsOf(item.stars) }}</text>
            <text class="fortune__row-line">{{ item.line }}</text>
          </view>
        </view>
      </template>

      <!-- 年运 -->
      <template v-else-if="activeTab === 'YEARLY' && yearly">
        <view class="fortune__hero">
          <text class="fortune__hero-sign">{{ yearly.signName }} · {{ yearly.year }} 年</text>
          <text class="fortune__hero-date">年度主题：{{ yearly.theme }}</text>
          <text class="fortune__hero-tone">整体 {{ yearly.score }} 分 · {{ starsOf(yearly.stars) }}</text>
        </view>

        <view class="card fortune__block">
          <text class="fortune__block-title">四个季度</text>
          <view v-for="item in yearly.sections" :key="item.key" class="fortune__row">
            <text class="fortune__row-name">{{ item.label }}</text>
            <text class="fortune__row-stars">{{ starsOf(item.stars) }}</text>
            <text class="fortune__row-line">{{ item.line }}</text>
          </view>
        </view>

        <view class="card fortune__block">
          <text class="fortune__block-title">一句年度提醒</text>
          <text class="fortune__tip">{{ yearly.tip }}</text>
        </view>
      </template>

      <view v-if="daily" class="card fortune__disclaimer">
        <text class="fortune__disclaimer-text">{{ daily.disclaimer }}</text>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.fortune {
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
    color: $color-text-secondary;
  }

  &__state-action {
    margin-top: $space-md;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__tabs {
    display: flex;
    padding: 6rpx;
    margin-bottom: $space-md;
    background-color: $color-bg-hover;
    border-radius: $radius-round;
  }

  &__tab {
    flex: 1;
    padding: $space-sm 0;
    font-size: $font-size-sm;
    color: $color-text-secondary;
    text-align: center;
    border-radius: $radius-round;
  }

  &__tab--active {
    color: $color-text-inverse;
    background-color: $color-primary;
  }

  &__hero {
    padding: $space-lg $space-md;
    background: linear-gradient(135deg, #2b2f4a 0%, #4a3f6b 100%);
    border-radius: $radius-lg;
  }

  &__hero-sign {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    color: $color-text-inverse;
  }

  &__hero-date {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-inverse;
    opacity: 0.8;
  }

  &__hero-tone {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-inverse;
    opacity: 0.9;
  }

  &__block {
    margin-top: $space-md;
  }

  &__block-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__row {
    padding: $space-md 0;
    border-bottom: 1rpx solid $color-divider;
  }

  &__row-name {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
  }

  &__row-score {
    margin-left: $space-sm;
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
  }

  &__row-stars {
    margin-left: $space-sm;
    font-size: $font-size-xs;
    color: $color-secondary;
  }

  &__row-line {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-regular;
  }

  &__tip {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
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
