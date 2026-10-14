<script setup lang="ts">
/**
 * 首页
 *
 * 承载核心流程入口（需求 §17.1）：开始测试 / 我的报告 / 情侣匹配 / AI 助手
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

import { computed } from 'vue';
import { onPullDownRefresh, onShow, onShareAppMessage, onShareTimeline } from '@dcloudio/uni-app';

import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import { useHome } from '@/composables/use-home';
import { modulePresentation } from '@/config/modules';
import { useAppStore } from '@/store/app';
import { useAuthStore } from '@/store/auth';

const appStore = useAppStore();
const authStore = useAuthStore();

/**
 * 情感测评的定义编码
 *
 * 与后端 `test_definitions.code` 对应。放在这里而不是写进 URL 字符串里散落各处：
 * 后端改编码时只需改这一处，且改错了会影响所有引用点（而不是某一条入口静默 404）。
 */
const EMOTION_TEST_CODE = 'EMOTION_LITE';

/** 两个模块的展示文案来自**同一份配置**（`config/modules.ts`），不在页面里写死 */
const personalityEntry = modulePresentation('PERSONALITY');
const emotionEntry = modulePresentation('EMOTION');

const { hasProfile, profileError, profileBadge, primaryTitle, primaryDesc, reportDesc, loadHomeData } = useHome();

/** 下拉刷新：同时刷新首页数据与系统配置 */
const refresh = async (): Promise<void> => {
  await Promise.allSettled([loadHomeData(), appStore.loadSystemConfig({ force: true })]);
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
      url: `/pages/test/intro?code=${EMOTION_TEST_CODE}`,
      enabled: emotionEntry.available,
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
      key: 'chat',
      title: 'AI 情感助手',
      desc: '结合你的人格画像，聊聊当下的困扰',
      icon: '💬',
      url: '/pkgChat/pages/index',
      enabled: appStore.features.aiChat,
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
  appStore.initSystemMetrics();
  // 回前台超过 5 分钟则刷新，保证画像与报告状态不过期
  if (appStore.shouldRefresh()) {
    void refresh();
  }
});

onPullDownRefresh(async () => {
  await Promise.allSettled([refresh(), authStore.fetchUserInfo()]);
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
