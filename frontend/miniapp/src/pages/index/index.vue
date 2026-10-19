<script setup lang="ts">
/**
 * 首页
 *
 * 承载核心流程入口（需求 §17.1）：三个测评模块 / 我的报告 / 情侣匹配 / AI 管家
 *
 * ## 数据来源
 *
 *   · 是否有画像 → `GET /personality/me`（返回 null 表示尚未测评，是空状态而非错误）
 *   · 报告卡片   → `GET /reports`（列表摘要 + 最新一条）
 *   · 测试耗时   → `GET /tests`（题库由服务端下发，前端不写死「约 8 分钟」）
 *
 * 三个请求用 `Promise.allSettled` 并发：任一失败只降级对应区块，不整页白屏。
 * 但**画像请求失败必须显式提示** —— 它是「开始测试 / 重新测试」这条主行动的
 * 分支依据，误判会让用户点进错误的流程。
 */

import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow, onShareAppMessage, onShareTimeline } from '@dcloudio/uni-app';

import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import GenderOnboarding from '@/components/GenderOnboarding.vue';
import { useHome } from '@/composables/use-home';
import { modulePresentation, type ModulePresentation } from '@/config/modules';
import { getDailyFortune, type DailyFortune } from '@/api/zodiac';
import { ApiError, ERROR_CODES } from '@/api/types';
import { useAppStore } from '@/store/app';
import { useAuthStore } from '@/store/auth';

/** 今天的 `YYYY-MM-DD`（本地时区：用户眼里的"今天"就是本地今天） */
const localToday = (): string => {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');

  return `${now.getFullYear()}-${month}-${day}`;
};

const appStore = useAppStore();
const authStore = useAuthStore();

/**
 * 三个模块的展示文案与题库编码都来自**同一份配置**（`config/modules.ts`），
 * 不在页面里写死 —— 后端改编码或改文案时只需改那一处，且改错了会影响所有引用点
 * （而不是某一条入口静默 404）。
 */
const personalityEntry = modulePresentation('PERSONALITY');
const emotionEntry = modulePresentation('EMOTION');
const mentalHealthEntry = modulePresentation('MENTAL_HEALTH');

/** 拼出某个模块的介绍页地址（编码为空时退回默认人格入口） */
const introUrlOf = (entry: ModulePresentation): string =>
  entry.testCode.length > 0 ? `/pages/test/intro?code=${entry.testCode}` : '/pages/test/intro';

const { hasProfile, profileError, profileBadge, primaryTitle, primaryDesc, reportDesc, loadHomeData } = useHome();

// ---------------------------------------------------------------------------
// 今日分数（横批）
//
// 数据来自星座模块的今日运势（只用到综合分与今日基调），签名由星座决定，
// 而星座由账号里的出生日期决定 —— 因此**没设生日时它是空状态而不是错误**。
//
// ⚠ 这里的失败绝不能影响首页其它区块：首页的主行动是"开始测试"，
// 运势只是锦上添花，挂掉时安静地不显示即可（除了"没设生日"要引导一次）。
// ---------------------------------------------------------------------------
const dailyFortune = ref<DailyFortune | null>(null);
/** 没有出生日期：展示"设置后看今日分数"的引导 */
const needsBirthdayForFortune = ref(false);

const loadFortune = async (): Promise<void> => {
  try {
    dailyFortune.value = await getDailyFortune(localToday());
    needsBirthdayForFortune.value = false;
  } catch (error) {
    dailyFortune.value = null;

    if (error instanceof ApiError && error.code === ERROR_CODES.ZODIAC_BIRTHDAY_REQUIRED) {
      needsBirthdayForFortune.value = true;
    }
  }
};

/** 今日综合分（详情页与横批共用同一个口径：取 OVERALL 那一维） */
const overallScore = computed<number | null>(
  () => dailyFortune.value?.dimensions.find((item) => item.key === 'OVERALL')?.score ?? null,
);

/** 综合星级 → ★串（横批用） */
const overallStars = computed<string>(() => {
  const stars = dailyFortune.value?.dimensions.find((item) => item.key === 'OVERALL')?.stars ?? 0;

  return '★'.repeat(stars) + '☆'.repeat(Math.max(0, 5 - stars));
});

const goScore = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/score' });
};

/**
 * 下拉刷新：同时刷新首页数据、系统配置与用户快照
 *
 * ⚠ 必须带上 `fetchUserInfo()`：`genderDeclared`（性别问过没有，ADR-039）
 * 只有 `/users/me` 才返回，登录响应里没有。少了它，性别引导在**首屏永远不弹** ——
 * 而"不弹"的表现是静默的：用户照常能用，只是情感测评永远出中性版场景。
 */
const refresh = async (): Promise<void> => {
  await Promise.allSettled([loadHomeData(), appStore.loadSystemConfig({ force: true }), authStore.fetchUserInfo()]);
};

/** 性别引导完成 */
const onGenderDone = (): void => {
  uni.showToast({ title: '已记录，测评会按这个来出题', icon: 'none' });
};

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
});

/** 功能入口（开关由后端 /system/config 下发，关闭的入口不展示） */
const entrances = computed(() =>
  [
    {
      key: 'test',
      title: personalityEntry.entranceTitle,
      desc: hasProfile.value ? '重新测试，更新画像' : personalityEntry.entranceDesc,
      icon: personalityEntry.icon,
      url: '/pages/test/intro',
      enabled: true,
    },
    {
      /**
       * 情感测评入口（ADR-038 阶段 3）
       *
       * 与人格测试是**两个独立入口**，不走同一个按钮：两者测的不是一回事，
       * 合并成一个"开始测评"会让人以为做完人格测评就顺便得到了情感结论 ——
       * 而那正是整改要消除的误解。
       */
      key: 'emotion',
      title: emotionEntry.entranceTitle,
      desc: emotionEntry.entranceDesc,
      icon: emotionEntry.icon,
      url: introUrlOf(emotionEntry),
      enabled: emotionEntry.available,
    },
    {
      /**
       * 心理状态自评入口（ADR-038 阶段 4）
       *
       * 与另两个模块同样是**独立入口**。它排在人格局与情感测评之后、报告之前：
       * 前两者是"了解自己是什么样"，这一项是"看看最近怎么样"，
       * 放在一起便于用户按"想了解什么"来选。
       */
      key: 'mentalHealth',
      title: mentalHealthEntry.entranceTitle,
      desc: mentalHealthEntry.entranceDesc,
      icon: mentalHealthEntry.icon,
      url: introUrlOf(mentalHealthEntry),
      enabled: mentalHealthEntry.available,
    },
    {
      key: 'report',
      title: '我的报告',
      desc: reportDesc.value,
      icon: '📖',
      url: '/pages/report/list',
      enabled: true,
    },
    {
      key: 'match',
      title: '情侣匹配',
      desc: '邀请 TA 一起测，看懂你们的相处模式',
      icon: '💞',
      url: '/pkgMatch/pages/invite',
      enabled: appStore.features.coupleMatch,
    },
    {
      /**
       * AI 管家入口（ADR-038 阶段 5）
       *
       * 从"情感助手"改成"管家"：它现在读的是**三个模块**的画像，
       * 只服务情感模块的名字会让用户以为心理状态那部分不归它管。
       * 它是会员功能，因此入口文案里直接写明"会员"，避免点进去才被拦住。
       */
      key: 'chat',
      title: 'AI 管家（会员）',
      desc: '读得到你三个模块的测评，帮你总结和梳理',
      icon: '💬',
      url: '/pkgChat/pages/index',
      enabled: appStore.features.aiChat,
    },
    {
      /**
       * 星座运势入口（2026-10-16）
       *
       * ⚠ 它是**内容娱乐模块**，不是第四个测评：不进测评框架、不写画像、
       * 与三个测评模块完全隔离（用户明确要求"完全隔离"）。
       * 因此文案刻意不带"测"字 —— 写成"测测你的星座"会让人以为这又是一份测评报告。
       */
      key: 'zodiac',
      title: '星座运势',
      desc: '选一次出生日期，看看今天的你',
      icon: '✨',
      url: '/pkgZodiac/pages/index',
      enabled: true,
    },
  ].filter((item) => item.enabled),
);

const goTo = (url: string): void => {
  uni.navigateTo({ url });
};

/** 分享给好友 */
onShareAppMessage(() => ({
  title: appStore.shareInfo.title,
  path: appStore.shareInfo.path,
  imageUrl: appStore.shareInfo.imageUrl ?? undefined,
}));

/** 分享到朋友圈 */
onShareTimeline(() => ({
  title: appStore.shareInfo.title,
  imageUrl: appStore.shareInfo.imageUrl ?? undefined,
}));

onShow(() => {
  /**
   * 系统尺寸（状态栏/胶囊）已在 `App.vue` 的 `onLaunch` 初始化过一次；
   * 这里**保留**再算一次是有意的：横竖屏切换、分屏、以及部分机型在 onLaunch
   * 阶段拿到的窗口信息并不准确，回首页时刷新一次成本极低。
   *
   * ⚠ 但**不能只在这里初始化** —— 从分享/消息直接进入子包页面时首页不会挂载，
   * 那样 `statusBarHeight` 会停在默认值，自定义导航栏就会被状态栏遮住（已踩过）。
   */
  appStore.initSystemMetrics();

  // 今日分数：与画像/报告互不影响，单独拉（失败就安静地不显示）
  void loadFortune();

  // 回前台超过 5 分钟则刷新，保证画像与报告状态不过期
  if (appStore.shouldRefresh()) {
    void refresh();
  }
});

onPullDownRefresh(async () => {
  await Promise.allSettled([refresh(), loadFortune()]);
  uni.stopPullDownRefresh();
});

// 首屏加载：不能只依赖 onShow（首次进入时 shouldRefresh 恒为 false）
void refresh();
</script>

<template>
  <view class="home">
    <!-- 顶部问候与状态栏占位 -->
    <view class="home__hero" :style="{ paddingTop: `${appStore.statusBarHeight + 12}px` }">
      <text class="home__greeting">{{ greeting }}，{{ authStore.displayName }}</text>
      <text v-if="profileError" class="home__slogan home__slogan--error" @tap="loadHomeData">
        {{ profileError }}（点击重试）
      </text>
      <text v-else class="home__slogan">
        {{ profileBadge ? '你的画像：' + profileBadge : '认识自己，是理解关系的第一步' }}
      </text>
    </view>

    <!-- 今日分数横批：醒目、一行看完、点一下进详情 -->
    <view v-if="dailyFortune && overallScore !== null" class="home__score card" @tap="goScore">
      <view class="home__score-left">
        <text class="home__score-label">今日分数</text>
        <view class="home__score-value-row">
          <text class="home__score-value">{{ overallScore }}</text>
          <text class="home__score-unit">分</text>
          <text class="home__score-stars">{{ overallStars }}</text>
        </view>
        <text class="home__score-tone">{{ dailyFortune.tone }}</text>
      </view>
      <view class="home__score-right">
        <text class="home__score-sign">{{ dailyFortune.signName }}</text>
        <text class="home__score-arrow">看详情 →</text>
      </view>
    </view>

    <!-- 没设生日：给一次引导，而不是留一个空位 -->
    <view v-else-if="needsBirthdayForFortune" class="home__score home__score--empty card" @tap="goScore">
      <view class="home__score-left">
        <text class="home__score-label">今日分数</text>
        <text class="home__score-empty-text">设置出生日期，就能看到今天的综合分数与各分项</text>
      </view>
      <text class="home__score-arrow">去设置 →</text>
    </view>

    <!-- 主行动卡片 -->
    <view class="home__primary card" @tap="goTo('/pages/test/intro')">
      <view class="home__primary-content">
        <text class="home__primary-title">{{ primaryTitle }}</text>
        <text class="home__primary-desc">{{ primaryDesc }}</text>
      </view>
      <text class="home__primary-arrow">→</text>
    </view>

    <!-- 功能入口网格 -->
    <view class="home__grid">
      <view v-for="item in entrances" :key="item.key" class="home__entry card" @tap="goTo(item.url)">
        <text class="home__entry-icon">{{ item.icon }}</text>
        <text class="home__entry-title">{{ item.title }}</text>
        <text class="home__entry-desc">{{ item.desc }}</text>
      </view>
    </view>

    <!-- 合规免责声明（AI 内容展示必备） -->
    <SafetyDisclaimer display="block" />

    <!--
      性别引导（ADR-039）：只在服务端明确说"没问过"时出现

      它决定情感测评出哪一套场景题，所以必须在用户进入测评之前问一次；
      放在首页而不是测评前，是因为**报告也要按性别出**，只问在测评入口就晚了。
    -->
    <GenderOnboarding v-if="authStore.needsGenderSetup" @done="onGenderDone" />
  </view>
</template>

<style lang="scss" scoped>
.home {
  min-height: 100vh;
  padding: 0 $space-lg $space-xxl;
  background: linear-gradient(180deg, $color-primary-fade 0%, $color-bg-page 320rpx);

  &__hero {
    padding-bottom: $space-lg;
  }

  &__greeting {
    display: block;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
    color: $color-text-primary;
  }

  &__slogan {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    color: $color-text-secondary;

    /* 画像加载失败：可点击重试，用警示色与普通文案区分 */
    &--error {
      color: $color-danger;
    }
  }

  &__score {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: $space-md;
    background: linear-gradient(135deg, #2b2f4a 0%, #4a3f6b 100%);
    box-shadow: $shadow-md;
  }

  &__score-left {
    flex: 1;
  }

  &__score-label {
    display: block;
    font-size: $font-size-xs;
    color: $color-text-inverse;
    opacity: 0.75;
  }

  &__score-value-row {
    display: flex;
    align-items: baseline;
    margin-top: $space-xxs;
  }

  &__score-value {
    font-size: 64rpx;
    font-weight: $font-weight-bold;
    line-height: 1.1;
    color: $color-text-inverse;
  }

  &__score-unit {
    margin-left: 4rpx;
    font-size: $font-size-sm;
    color: $color-text-inverse;
    opacity: 0.8;
  }

  &__score-stars {
    margin-left: $space-sm;
    font-size: $font-size-sm;
    color: $color-secondary;
  }

  &__score-tone {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-inverse;
    opacity: 0.9;
  }

  &__score-right {
    flex-shrink: 0;
    margin-left: $space-md;
    text-align: right;
  }

  &__score-sign {
    display: block;
    font-size: $font-size-sm;
    color: $color-text-inverse;
    opacity: 0.85;
  }

  &__score-arrow {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-secondary;
  }

  &__score--empty {
    background: linear-gradient(135deg, $color-primary-fade 0%, $color-bg-card 100%);
  }

  &__score--empty &__score-label {
    color: $color-text-primary;
    opacity: 1;
  }

  &__score-empty-text {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__primary {
    @include flex-between;
    margin-bottom: $space-lg;
    background: linear-gradient(135deg, $color-primary-light 0%, $color-primary 100%);
    box-shadow: $shadow-primary;

    &:active {
      opacity: 0.92;
    }
  }

  &__primary-content {
    flex: 1;
  }

  &__primary-title {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
    color: $color-text-inverse;
  }

  &__primary-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-sm;
    color: rgba(255, 255, 255, 0.82);
  }

  &__primary-arrow {
    font-size: $font-size-xl;
    color: $color-text-inverse;
  }

  &__grid {
    display: flex;
    flex-wrap: wrap;
    gap: $space-md;
  }

  &__entry {
    width: calc((100% - #{$space-md}) / 2);
    padding: $space-md;

    &:active {
      background-color: $color-bg-hover;
    }
  }

  &__entry-icon {
    display: block;
    font-size: 48rpx;
    line-height: 1;
  }

  &__entry-title {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__entry-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-secondary;

    @include text-ellipsis-multi(2);
  }
}
</style>
