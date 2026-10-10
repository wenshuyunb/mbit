<script setup lang="ts">
/**
 * 报告详情页（分包 pkgReport）
 *
 * 关键设计（架构文档 §2、§10.6）：
 *   · 免费用户只拿到服务端裁剪后的预览段落（`isFreePreview = true`）
 *   · 付费解锁后重新拉取，服务端返回全文；**绝不**把全文下发到前端再遮挡
 *   · 生成中展示进度并轮询；生成失败可重试
 *
 * ## 为什么用单一状态机而不是几个布尔
 *
 * 页面有六种互斥形态（加载中/生成中/失败/可读/整份锁定/不存在）。用
 * `loading` + `generating` + `failed` 几个布尔描述时，总会出现"两个都为真"
 * 或"全为假"的组合，而模板里 `v-if/v-else-if` 的顺序就成了隐藏的优先级规则 ——
 * 加一种状态时极易渲染出空白页。单一枚举让非法组合无法表达。
 */

import { computed } from 'vue';
import { onHide, onLoad, onShareAppMessage, onShow, onUnload } from '@dcloudio/uni-app';

import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import { progressStageLabel } from '@/api/report';
import { ApiError, ERROR_CODES } from '@/api/types';
import { useReportDetail } from '@/composables/use-report-detail';

/** 状态机在 composable 中（含轮询生命周期），此处只做页面绑定与交互 */
const {
  reportId,
  report,
  progress,
  state,
  failureMessage,
  pollTimedOut,
  isGenerating,
  isLocked,
  previewHint,
  load,
  refresh,
  retry: regenerate,
  pause,
  resume,
  dispose,
} = useReportDetail();

/** 生成阶段文案（后端不下发 stage，由状态推导） */
const stageLabel = computed(() => progressStageLabel(progress.value?.status, progress.value?.progress ?? 0));

onLoad((query) => {
  const id = query?.['id'];
  if (typeof id !== 'string') {
    state.value = 'missing';
    return;
  }

  reportId.value = id;
  void load();
});

// 切到后台暂停轮询：小程序被切走后继续每 2 秒请求是在浪费用户的流量与电量
onHide(pause);
onShow(resume);
onUnload(dispose);

onShareAppMessage(() => ({
  title: report.value
    ? `我的人格报告：${report.value.mbtiType ?? report.value.title ?? 'SoulMap AI'}`
    : 'SoulMap AI 人格报告',
  path: `/pkgReport/pages/detail?id=${reportId.value}`,
}));

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

const unlock = (): void => {
  // Phase 6：orderApi.createOrder({ productCode }) → wx.requestPayment → 轮询订单状态
  // `requiredProductCode` 由权益体系下发，Phase 6 前不存在该字段，因此这里不读它
  uni.showToast({ title: '支付功能将在 Phase 6 接入', icon: 'none' });
};

/**
 * 重新生成
 *
 * 与「刷新」是两个按钮：刷新只是重新拉取，重试会真的重新入队生成。
 * 混成一个按钮时，用户在生成中会反复触发新任务，白白消耗 AI 配额。
 */
const retry = async (): Promise<void> => {
  try {
    await regenerate();
  } catch (error) {
    const message =
      error instanceof ApiError && error.code === ERROR_CODES.AI_REPORT_REGENERATE_FORBIDDEN
        ? '重新生成需要会员权益'
        : error instanceof ApiError && error.code === ERROR_CODES.AI_QUOTA_EXCEEDED
          ? '本月生成次数已用完'
          : '重试失败，请稍后再试';

    uni.showToast({ title: message, icon: 'none' });
  }
};

const share = (): void => {
  // Phase 3 续作：createShareCard(reportId) 生成分享图后保存相册
  uni.showToast({ title: '分享图生成待接入', icon: 'none' });
};
</script>

<template>
  <view class="detail page-container">
    <!-- 加载中 -->
    <view v-if="state === 'loading'" class="detail__loading card">
      <text>加载中…</text>
    </view>

    <!-- 生成中 -->
    <view v-else-if="isGenerating" class="detail__generating card">
      <text class="detail__generating-title">AI 正在撰写你的报告</text>
      <text class="detail__generating-stage">{{ stageLabel }}</text>
      <view class="detail__progress">
        <view class="detail__progress-inner" :style="{ width: `${progress?.progress ?? 0}%` }" />
      </view>
      <text class="detail__generating-tip">通常需要 20–60 秒，可稍后到「我的报告」查看</text>
      <text v-if="pollTimedOut" class="detail__generating-timeout">
        生成时间超出预期，任务仍在后台进行。稍后回到本页会自动继续查询。
      </text>
      <button class="detail__retry" @tap="refresh">刷新状态</button>
    </view>

    <!-- 生成失败 -->
    <view v-else-if="state === 'failed'" class="detail__failed card">
      <text class="detail__failed-title">报告生成失败</text>
      <text class="detail__failed-desc">{{ failureMessage || '请稍后重试，重试不会重复扣减次数' }}</text>
      <button class="detail__retry" @tap="retry">重新生成</button>
    </view>

    <!-- 报告内容 -->
    <view v-else-if="state === 'ready' && report" class="detail__content">
      <view class="detail__header card">
        <text class="detail__title">{{ report.title ?? report.typeName }}</text>
        <text class="detail__meta">{{ report.mbtiType ?? '' }} · {{ report.model ?? '' }}</text>
      </view>

      <view v-for="section in report.sections" :key="section.sectionKey" class="detail__section card">
        <text class="detail__section-title">{{ section.title }}</text>
        <!-- 未解锁段落服务端不下发正文（content 为 null），只给引导文案 -->
        <text v-if="section.content" class="detail__section-content">{{ section.content }}</text>
        <view v-else class="detail__section-locked">
          <text class="detail__section-locked-text">{{ section.lockedHint ?? '解锁后可查看本段内容' }}</text>
          <text class="detail__section-locked-count">约 {{ section.contentLength }} 字</text>
        </view>
      </view>

      <SafetyDisclaimer variant="reportFooter" display="block" />

      <view class="detail__actions">
        <button class="detail__action" @tap="share">生成分享图</button>
      </view>
    </view>

    <!-- 整份报告均未解锁 -->
    <view v-else-if="state === 'locked'" class="detail__empty card">
      <text>报告已生成，解锁后可查看完整内容</text>
    </view>

    <!-- 不存在 -->
    <view v-else class="detail__empty card">
      <text>报告不存在或已删除</text>
    </view>

    <!-- 付费解锁浮层 -->
    <view v-if="isLocked" class="detail__paywall">
      <text class="detail__paywall-title">解锁完整报告</text>
      <text class="detail__paywall-desc"> {{ previewHint }}解锁后可查看完整的优势、盲点、沟通方式与成长建议 </text>
      <button class="detail__paywall-button" @tap="unlock">立即解锁</button>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.detail {
  padding-bottom: 240rpx;

  &__generating,
  &__failed,
  &__empty {
    text-align: center;
  }

  &__generating-title,
  &__failed-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__generating-stage,
  &__failed-desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__progress {
    overflow: hidden;
    height: 12rpx;
    margin-top: $space-lg;
    background-color: $color-border;
    border-radius: $radius-round;
  }

  &__progress-inner {
    height: 100%;
    background: linear-gradient(90deg, $color-primary-light, $color-primary);
    transition: width 0.4s ease;
  }

  &__generating-tip {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__retry {
    width: 320rpx;
    margin: $space-lg auto 0;

    @include button-primary;
  }

  &__header {
    margin-bottom: $space-md;
  }

  &__title {
    display: block;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
  }

  &__meta {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__section {
    margin-bottom: $space-md;
  }

  &__section-title {
    display: block;
    margin-bottom: $space-sm;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__section-content {
    display: block;
    font-size: $font-size-base;
    line-height: $line-height-loose;
    color: $color-text-regular;
    white-space: pre-wrap;
  }

  /* 未解锁段落：服务端不下发正文，这里只展示引导与字数，不做假模糊 */
  &__section-locked {
    padding: $space-md;
    text-align: center;
    background-color: $color-bg-hover;
    border-radius: $radius-md;
  }

  &__loading {
    padding: $space-xl 0;
    font-size: $font-size-sm;
    color: $color-text-secondary;
    text-align: center;
  }

  &__generating-timeout {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-xs;
    color: $color-warning;
  }

  &__section-locked-text {
    display: block;
    font-size: $font-size-sm;
    color: $color-secondary;
  }

  &__section-locked-count {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__actions {
    margin-top: $space-lg;
  }

  &__action {
    height: 88rpx;
    font-size: $font-size-base;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  &__paywall {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    padding: $space-lg;

    @include safe-area-padding-bottom($space-lg);

    background-color: $color-bg-card;
    border-radius: $radius-xl $radius-xl 0 0;
    box-shadow: 0 -8rpx 32rpx rgba(31, 31, 46, 0.12);
  }

  &__paywall-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__paywall-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__paywall-button {
    margin-top: $space-md;

    @include button-primary;
  }
}
</style>
