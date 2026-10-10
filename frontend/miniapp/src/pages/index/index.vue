<script setup lang="ts">
/**
 * 首页
 *
 * 承载核心流程入口（需求 §17.1）：开始测试 / 我的报告 / 情侣匹配 / AI 助手
 *
 * Phase 0 状态：布局与入口完整，数据为占位；
 *   Phase 2 接入「测试定义列表 + 用户画像状态」，
 *   Phase 3 接入「最新报告卡片 + 生成进度」。
 */

import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow, onShareAppMessage, onShareTimeline } from '@dcloudio/uni-app';

import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import { useAppStore } from '@/store/app';
import { useAuthStore } from '@/store/auth';

const appStore = useAppStore();
const authStore = useAuthStore();

/** 是否已完成人格测试（Phase 2 接入 /personality/me 后由真实数据驱动） */
const hasProfile = ref(false);
/** 最近一次报告的简要信息（Phase 3 接入） */
const latestReportTitle = ref('');

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
      title: '人格测试',
      desc: hasProfile.value ? '重新测试，更新画像' : '约 8 分钟，了解真实的自己',
      icon: '🧭',
      url: '/pages/test/intro',
      enabled: true,
    },
    {
      key: 'report',
      title: '我的报告',
      desc: latestReportTitle.value || '查看 AI 生成的深度人格解读',
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
  // 回前台超过 5 分钟则刷新配置，保证开关与文案不过期
  if (appStore.shouldRefresh()) {
    void appStore.loadSystemConfig({ force: true });
  }
});

onPullDownRefresh(async () => {
  await Promise.allSettled([appStore.loadSystemConfig({ force: true }), authStore.fetchUserInfo()]);
  uni.stopPullDownRefresh();
});
</script>

<template>
  <view class="home">
    <!-- 顶部问候与状态栏占位 -->
    <view class="home__hero" :style="{ paddingTop: `${appStore.statusBarHeight + 12}px` }">
      <text class="home__greeting">{{ greeting }}，{{ authStore.displayName }}</text>
      <text class="home__slogan">{{ hasProfile ? '你的画像已就绪' : '认识自己，是理解关系的第一步' }}</text>
    </view>

    <!-- 主行动卡片 -->
    <view class="home__primary card" @tap="goTo('/pages/test/intro')">
      <view class="home__primary-content">
        <text class="home__primary-title">{{ hasProfile ? '重新测试人格' : '开始人格测试' }}</text>
        <text class="home__primary-desc">
          {{ hasProfile ? '看看这段时间你的变化' : 'MBTI + 大五人格双模型 · 约 8 分钟' }}
        </text>
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
