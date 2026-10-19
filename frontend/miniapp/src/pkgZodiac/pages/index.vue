<script setup lang="ts">
/**
 * 星座运势（分包 pkgZodiac）—— 主页面
 *
 * ## 与三个测评模块的关系：**完全隔离**（用户拍板）
 *
 * 它不是测评：没有题目、没有作答、不写画像。这里唯一的个人信息是**出生日期**，
 * 而它存在账号里（`users.birthday`），因此第二次进来不必再选。
 *
 * ## 页面结构（自上而下，与"先看结论再细看"的阅读顺序一致）
 *
 *   ① 生日未设置 → 顶一个日期选择卡（这是本模块唯一的必填项）
 *   ② 星座徽章 + 今日基调 + 娱乐性质声明（合规文案由服务端下发）
 *   ③ 今日五维（星级 + 一句话）
 *   ④ 幸运元素 + 速配 / 留意星座
 *   ⑤ 宜 / 忌
 *   ⑥ 今日箴言
 *   ⑦ 周运 / 月运（切换）
 *   ⑧ 入口：十二星座档案 / 星座配对
 *
 * ⚠ 生日选择用 `picker mode="date"`：**不手输**。手输的日期一定有人写成 3/8、1996年3月8日，
 * 而后端只认 `YYYY-MM-DD`；用系统选择器从源头消掉这类错误。
 */

import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';

import {
  getDailyFortune,
  getMonthlyFortune,
  getWeeklyFortune,
  listZodiacProfiles,
  type DailyFortune,
  type MonthlyFortune,
  type WeeklyFortune,
  type ZodiacProfile,
} from '@/api/zodiac';
import { http } from '@/api/request';
import { ApiError, ERROR_CODES } from '@/api/types';

/** 今天的 `YYYY-MM-DD`（本地时区口径：用户眼里的"今天"就是本地今天） */
const localToday = (): string => {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');

  return `${now.getFullYear()}-${month}-${day}`;
};

const today = localToday();

const loading = ref(true);
const loadError = ref('');
/** 未设置生日（后端 `30019`）：此时页面只展示生日选择卡 */
const needsBirthday = ref(false);
const daily = ref<DailyFortune | null>(null);
const weekly = ref<WeeklyFortune | null>(null);
const monthly = ref<MonthlyFortune | null>(null);
const profiles = ref<ZodiacProfile[]>([]);
const period = ref<'DAILY' | 'WEEKLY' | 'MONTHLY'>('DAILY');
const saving = ref(false);

/** 日期选择器的当前值（默认按 1996-01-01，避免每次都从今天滑起） */
const birthdayDraft = ref('1996-01-01');

/** 我的星座档案（用于"看看这个星座"入口） */
const myProfile = computed(() => profiles.value.find((item) => item.sign === daily.value?.sign) ?? null);

/** 星级渲染成 ★★★★★（前端拼串，模板里的表达式能力有限） */
const starsOf = (stars: number): string =>
  '★'.repeat(Math.max(0, Math.min(5, stars))) + '☆'.repeat(5 - Math.max(0, Math.min(5, stars)));

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
    // 档案是公开接口，先取（即使没生日也能看百科）
    if (profiles.value.length === 0) {
      profiles.value = await listZodiacProfiles();
    }

    await loadFortunes();
  } catch (error) {
    console.error('[zodiac] 加载失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

/** 拉三种周期的运势；未设置生日时后端返回 `30019`，转为"去设置生日"的状态 */
const loadFortunes = async (): Promise<void> => {
  try {
    daily.value = await getDailyFortune(today);
    needsBirthday.value = false;
  } catch (error) {
    if (error instanceof ApiError && error.code === ERROR_CODES.ZODIAC_BIRTHDAY_REQUIRED) {
      needsBirthday.value = true;
      return;
    }

    throw error;
  }

  // 周运/月运失败不该让整页挂掉：今日运势才是主体，另两个是补充
  const [weeklyResult, monthlyResult] = await Promise.allSettled([getWeeklyFortune(today), getMonthlyFortune(today)]);

  weekly.value = weeklyResult.status === 'fulfilled' ? weeklyResult.value : null;
  monthly.value = monthlyResult.status === 'fulfilled' ? monthlyResult.value : null;
};

/** 保存出生日期（走统一的用户资料接口，而不是本模块自己写库） */
const saveBirthday = async (): Promise<void> => {
  if (saving.value) return;

  saving.value = true;
  try {
    await http.patch('/users/me', { birthday: birthdayDraft.value });
    uni.showToast({ title: '已记住你的生日', icon: 'none' });
    await loadFortunes();
  } catch (error) {
    console.error('[zodiac] 保存生日失败：', error);
    uni.showToast({ title: '保存失败，请稍后再试', icon: 'none' });
  } finally {
    saving.value = false;
  }
};

const onBirthdayChange = (event: { detail: { value: string } }): void => {
  birthdayDraft.value = event.detail.value;
};

const goSigns = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/signs' });
};

const goChart = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/chart' });
};

const goReading = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/reading' });
};

const goTarot = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/tarot' });
};

const goMatch = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/match' });
};
</script>

<template>
  <view class="zodiac page-container">
    <view v-if="loading" class="card zodiac__state">
      <text>正在看看今天的你…</text>
    </view>

    <view v-else-if="loadError" class="card zodiac__state">
      <text class="zodiac__state-title">{{ loadError }}</text>
      <button class="zodiac__state-action" @tap="bootstrap">重新加载</button>
    </view>

    <template v-else>
      <!-- ① 生日未设置：本模块唯一的必填项 -->
      <view v-if="needsBirthday" class="card zodiac__setup">
        <text class="zodiac__setup-title">先选一次你的出生日期</text>
        <text class="zodiac__setup-desc">
          只用来判断你的星座（只取月与日，年份不影响结果）。选一次就会记住，之后进来直接看今天。
        </text>
        <picker mode="date" :value="birthdayDraft" start="1900-01-01" :end="today" @change="onBirthdayChange">
          <view class="zodiac__setup-picker">
            <text class="zodiac__setup-value">{{ birthdayDraft }}</text>
            <text class="zodiac__setup-arrow">修改 ›</text>
          </view>
        </picker>
        <button class="zodiac__setup-button" :disabled="saving" @tap="saveBirthday">开始</button>
      </view>

      <template v-else-if="daily">
        <!-- ② 星座徽章 + 今日基调 -->
        <view class="zodiac__hero">
          <text class="zodiac__hero-sign">{{ daily.signName }}</text>
          <text class="zodiac__hero-date">{{ daily.date }} · 生日 {{ daily.birthdaySource }}</text>
          <text class="zodiac__hero-tone">{{ daily.tone }}</text>
        </view>

        <!-- 周期切换 -->
        <view class="zodiac__tabs">
          <text
            v-for="item in [
              { key: 'DAILY', label: '今日' },
              { key: 'WEEKLY', label: '本周' },
              { key: 'MONTHLY', label: '本月' },
            ]"
            :key="item.key"
            :class="['zodiac__tab', { 'is-active': period === item.key }]"
            @tap="period = item.key as 'DAILY' | 'WEEKLY' | 'MONTHLY'"
          >
            {{ item.label }}
          </text>
        </view>

        <!-- ③ 今日五维 -->
        <template v-if="period === 'DAILY'">
          <view class="card zodiac__block">
            <text class="zodiac__block-title">今日五个方面</text>
            <view v-for="item in daily.dimensions" :key="item.key" class="zodiac__dimension">
              <view class="zodiac__dimension-head">
                <text class="zodiac__dimension-label">{{ item.label }}</text>
                <text class="zodiac__dimension-stars">{{ starsOf(item.stars) }}</text>
              </view>
              <text class="zodiac__dimension-line">{{ item.line }}</text>
            </view>
          </view>

          <!-- ④ 幸运元素 + 速配 -->
          <view class="card zodiac__block">
            <text class="zodiac__block-title">今日幸运</text>
            <view class="zodiac__lucky">
              <view class="zodiac__lucky-item">
                <text class="zodiac__lucky-label">幸运色</text>
                <view class="zodiac__lucky-color">
                  <view class="zodiac__lucky-dot" :style="{ backgroundColor: daily.lucky.color.hex }" />
                  <text class="zodiac__lucky-value">{{ daily.lucky.color.name }}</text>
                </view>
              </view>
              <view class="zodiac__lucky-item">
                <text class="zodiac__lucky-label">幸运数字</text>
                <text class="zodiac__lucky-value">{{ daily.lucky.number }}</text>
              </view>
              <view class="zodiac__lucky-item">
                <text class="zodiac__lucky-label">幸运方位</text>
                <text class="zodiac__lucky-value">{{ daily.lucky.direction }}</text>
              </view>
              <view class="zodiac__lucky-item">
                <text class="zodiac__lucky-label">状态较好的时段</text>
                <text class="zodiac__lucky-value">{{ daily.lucky.hour }}</text>
              </view>
            </view>
            <view class="zodiac__pair">
              <text class="zodiac__pair-item">今天与「{{ daily.match.best.name }}」合拍</text>
              <text class="zodiac__pair-item zodiac__pair-item--muted"
                >与「{{ daily.match.watch.name }}」多留一点耐心</text
              >
            </view>
          </view>

          <!-- ⑤ 宜 / 忌 -->
          <view class="card zodiac__block">
            <text class="zodiac__block-title">今天适合 / 不适合</text>
            <view class="zodiac__lists">
              <view class="zodiac__list">
                <text class="zodiac__list-title zodiac__list-title--good">宜</text>
                <text v-for="(item, index) in daily.good" :key="index" class="zodiac__list-item">{{ item }}</text>
              </view>
              <view class="zodiac__list">
                <text class="zodiac__list-title zodiac__list-title--avoid">忌</text>
                <text v-for="(item, index) in daily.avoid" :key="index" class="zodiac__list-item">{{ item }}</text>
              </view>
            </view>
          </view>

          <!-- ⑥ 箴言 -->
          <view class="card zodiac__quote">
            <text class="zodiac__quote-text">{{ daily.quote }}</text>
          </view>
        </template>

        <!-- ⑦ 周运 -->
        <view v-else-if="period === 'WEEKLY' && weekly" class="card zodiac__block">
          <text class="zodiac__block-title">{{ weekly.startDate }} ~ {{ weekly.endDate }}</text>
          <view v-for="item in weekly.sections" :key="item.key" class="zodiac__dimension">
            <view class="zodiac__dimension-head">
              <text class="zodiac__dimension-label">{{ item.label }}</text>
              <text class="zodiac__dimension-stars">{{ starsOf(item.stars) }}</text>
            </view>
            <text class="zodiac__dimension-line">{{ item.line }}</text>
          </view>
          <text class="zodiac__tip">{{ weekly.tip }}</text>
        </view>

        <!-- ⑦ 月运 -->
        <view v-else-if="period === 'MONTHLY' && monthly" class="card zodiac__block">
          <text class="zodiac__block-title">{{ monthly.month }} · 本月主题「{{ monthly.theme }}」</text>
          <text class="zodiac__dimension-stars">{{ starsOf(monthly.stars) }}</text>
          <view v-for="item in monthly.sections" :key="item.key" class="zodiac__dimension">
            <view class="zodiac__dimension-head">
              <text class="zodiac__dimension-label">{{ item.label }}</text>
            </view>
            <text class="zodiac__dimension-line">{{ item.line }}</text>
          </view>
        </view>

        <!-- ⑧ 其他入口 -->
        <view class="zodiac__entries">
          <view class="card zodiac__entry" @tap="goChart">
            <text class="zodiac__entry-icon">🌌</text>
            <view class="zodiac__entry-body">
              <text class="zodiac__entry-title">我的本命星盘</text>
              <text class="zodiac__entry-desc">十大行星、上升星座与十二宫 —— 同一个星座的人，星盘也各不相同</text>
            </view>
          </view>
          <view class="card zodiac__entry" @tap="goReading">
            <text class="zodiac__entry-icon">📖</text>
            <view class="zodiac__entry-body">
              <text class="zodiac__entry-title">星盘解读</text>
              <text class="zodiac__entry-desc">看不懂星盘也没关系 —— 把盘翻成人话，先看一段免费</text>
            </view>
          </view>
          <view class="card zodiac__entry" @tap="goTarot">
            <text class="zodiac__entry-icon">🃏</text>
            <view class="zodiac__entry-body">
              <text class="zodiac__entry-title">今日塔罗</text>
              <text class="zodiac__entry-desc">抽一张牌，看看今天适合把注意力放在哪里</text>
            </view>
          </view>
          <view class="card zodiac__entry" @tap="goSigns">
            <text class="zodiac__entry-icon">📖</text>
            <view class="zodiac__entry-body">
              <text class="zodiac__entry-title">十二星座档案</text>
              <text class="zodiac__entry-desc">{{
                myProfile ? `看看${myProfile.name}的完整档案` : '看看每个星座的性格与相处方式'
              }}</text>
            </view>
          </view>
          <view class="card zodiac__entry" @tap="goMatch">
            <text class="zodiac__entry-icon">💫</text>
            <view class="zodiac__entry-body">
              <text class="zodiac__entry-title">星座配对</text>
              <text class="zodiac__entry-desc">看看两个星座的相处基调</text>
            </view>
          </view>
        </view>

        <!-- 合规声明：服务端下发，原样展示，不得省略 -->
        <view class="card zodiac__disclaimer">
          <text class="zodiac__disclaimer-text">{{ daily.disclaimer }}</text>
        </view>
      </template>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.zodiac {
  &__state {
    text-align: center;
  }

  &__state-title {
    display: block;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__state-action {
    width: 320rpx;
    margin: $space-lg auto 0;

    @include button-primary;
  }

  /* ---------------------------------------------------------- 生日设置 */
  &__setup-title {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
  }

  &__setup-desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__setup-picker {
    @include flex-between;
    padding: $space-md;
    margin-top: $space-lg;
    background-color: $color-bg-hover;
    border-radius: $radius-md;
  }

  &__setup-value {
    font-size: $font-size-md;
    font-weight: $font-weight-medium;
  }

  &__setup-arrow {
    font-size: $font-size-sm;
    color: $color-primary;
  }

  &__setup-button {
    margin-top: $space-lg;

    @include button-primary;
  }

  /* ---------------------------------------------------------- 星座徽章 */
  &__hero {
    padding: $space-xl $space-lg;
    margin-bottom: $space-md;
    background: linear-gradient(160deg, rgba(91, 75, 224, 0.12) 0%, rgba(255, 122, 89, 0.1) 100%);
    border-radius: $radius-lg;
  }

  &__hero-sign {
    display: block;
    font-size: $font-size-xxl;
    font-weight: $font-weight-bold;
    color: $color-primary;
  }

  &__hero-date {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__hero-tone {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-medium;
    line-height: $line-height-base;
  }

  /* ---------------------------------------------------------- 周期切换 */
  &__tabs {
    display: flex;
    margin-bottom: $space-md;
  }

  &__tab {
    flex: 1;
    padding: $space-sm 0;
    font-size: $font-size-base;
    color: $color-text-secondary;
    text-align: center;
    background-color: $color-bg-card;
    border-radius: $radius-round;

    &.is-active {
      font-weight: $font-weight-semibold;
      color: $color-text-inverse;
      background: linear-gradient(135deg, $color-primary-light 0%, $color-primary 100%);
    }

    & + & {
      margin-left: $space-sm;
    }
  }

  /* ---------------------------------------------------------- 内容块 */
  &__block {
    margin-bottom: $space-md;
  }

  &__block-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__dimension {
    margin-top: $space-md;
  }

  &__dimension-head {
    @include flex-between;
  }

  &__dimension-label {
    font-size: $font-size-base;
    color: $color-text-regular;
  }

  &__dimension-stars {
    font-size: $font-size-base;
    color: $color-secondary;
  }

  &__dimension-line {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__tip {
    display: block;
    padding: $space-md;
    margin-top: $space-md;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
    background-color: $color-primary-fade;
    border-radius: $radius-md;
  }

  /* ---------------------------------------------------------- 幸运元素 */
  &__lucky {
    display: flex;
    flex-wrap: wrap;
    margin-top: $space-md;
  }

  &__lucky-item {
    width: 50%;
    margin-bottom: $space-md;
  }

  &__lucky-label {
    display: block;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__lucky-value {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-base;
    font-weight: $font-weight-medium;
  }

  &__lucky-color {
    @include flex-center(row);
    justify-content: flex-start;
    margin-top: $space-xxs;
  }

  &__lucky-dot {
    width: 32rpx;
    height: 32rpx;
    margin-right: $space-xs;
    border-radius: $radius-round;
  }

  &__pair {
    padding-top: $space-md;
    border-top: 2rpx solid $color-divider;
  }

  &__pair-item {
    display: block;
    font-size: $font-size-sm;
    color: $color-text-regular;

    &--muted {
      margin-top: $space-xs;
      color: $color-text-secondary;
    }
  }

  /* ---------------------------------------------------------- 宜忌 */
  &__lists {
    display: flex;
    margin-top: $space-md;
  }

  &__list {
    flex: 1;

    & + & {
      margin-left: $space-md;
    }
  }

  &__list-title {
    display: inline-block;
    padding: 2rpx $space-sm;
    margin-bottom: $space-sm;
    font-size: $font-size-xs;
    border-radius: $radius-xs;

    &--good {
      color: $color-success;
      background-color: rgba(34, 197, 94, 0.12);
    }

    &--avoid {
      color: $color-secondary;
      background-color: $color-secondary-fade;
    }
  }

  &__list-item {
    display: block;
    margin-bottom: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-regular;
  }

  /* ---------------------------------------------------------- 箴言 */
  &__quote {
    margin-bottom: $space-md;
    background-color: $color-primary-fade;
    box-shadow: none;
  }

  &__quote-text {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-medium;
    line-height: $line-height-base;
    color: $color-primary-dark;
  }

  /* ---------------------------------------------------------- 其他入口 */
  &__entries {
    margin-bottom: $space-md;
  }

  &__entry {
    @include flex-center(row);
    justify-content: flex-start;
    margin-bottom: $space-sm;
  }

  &__entry-icon {
    margin-right: $space-md;
    font-size: 40rpx;
  }

  &__entry-body {
    flex: 1;
  }

  &__entry-title {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-medium;
  }

  &__entry-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  /* ---------------------------------------------------------- 合规声明 */
  &__disclaimer {
    background-color: transparent;
    border: 2rpx solid $color-border;
  }

  &__disclaimer-text {
    display: block;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }
}
</style>
