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
 *
 * ## 2026-10-15 改版：从"一堵字"到"先给结论，想细读再展开"
 *
 * 用户的实测反馈是「点开一看，哇，全是字，我是用户我看都不想看，累不累啊，
 * 最好是图文并茂，一针见血，显得有亲和力，而不是字多就行」。
 *
 * 报告**内容**不动（上一轮他刚说过"信息也不多"），改的是**阅读路径**：
 *
 *   ① 顶部一句话（服务端摘要 / 确定性结论的 headline）—— 3 秒知道这份报告在说什么；
 *   ② 画像数据卡（`ReportProfileChart`）—— 把正文里那些数字画成条形图，
 *      一眼看到自己是哪一种、两条轴各在哪儿、最在意什么；
 *   ③ 结论卡（情感）—— "你最需要什么" + 3 件可以立刻做的事；
 *   ④ 六段正文各自成卡（`ReportSectionCard`）—— 首句放大、其余折叠、
 *      建议拆成 5 张编号卡、行动拆成两周两块。
 */

import { computed } from 'vue';
import { onHide, onLoad, onShareAppMessage, onShow, onUnload } from '@dcloudio/uni-app';

import ReportProfileChart from '@/components/ReportProfileChart.vue';
import ReportSectionCard from '@/components/ReportSectionCard.vue';
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

/**
 * 画像快照
 *
 * ⚠ 用 `?? null` 而不是直接取属性：本字段是后端后加的，
 * 在它上线之前生成的报告（历史数据）拿不到这个 key。
 */
const profileSnapshot = computed(() => report.value?.profileSnapshot ?? null);

/** 情感报告才有确定性结论；人格/关系/成长报告走纯 AI 正文 */
const conclusion = computed(() =>
  profileSnapshot.value?.kind === 'EMOTION' ? profileSnapshot.value.conclusion : null,
);

/**
 * 首屏那一句话
 *
 * 优先用**确定性结论**（它专为"让人一眼看懂自己"而写），没有结论的报告
 * 退回服务端生成时写的摘要（`ai_reports.summary`），再退回标题。
 */
const heroHeadline = computed(
  () => conclusion.value?.headline ?? report.value?.summary ?? report.value?.title ?? report.value?.typeName ?? '',
);

/** 阅读时长：按 400 字/分钟估算，至少 1 分钟 */
const readMinutes = computed(() => {
  const total = (report.value?.sections ?? []).reduce((sum, section) => sum + section.contentLength, 0);

  return Math.max(1, Math.round(total / 400));
});

/** 副标题：类型 / 模型 / 生成时间，给"这份报告是怎么来的"一点交代 */
const metaLine = computed(() => {
  const parts: string[] = [];
  const mbti = report.value?.mbtiType;

  if (typeof mbti === 'string' && mbti.length > 0) parts.push(mbti);
  if (report.value?.model) parts.push(report.value.model);

  return parts.join(' · ');
});

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

onShareAppMessage(() => {
  const headline = conclusion.value?.headline;

  return {
    title: headline ?? (report.value ? `我的报告：${report.value.title ?? report.value.typeName}` : 'SoulMap AI 报告'),
    path: `/pkgReport/pages/detail?id=${reportId.value}`,
  };
});

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
      <!-- ① 一句话说清这份报告在讲什么 -->
      <view class="detail__hero">
        <text class="detail__hero-kicker">{{ report.typeName }}</text>
        <text class="detail__hero-headline">{{ heroHeadline }}</text>
        <text v-if="metaLine" class="detail__hero-meta">{{ metaLine }}</text>
        <view class="detail__chips">
          <text class="detail__chip">{{ report.sectionCount }} 段解读</text>
          <text class="detail__chip">约 {{ readMinutes }} 分钟</text>
          <text v-if="report.visibility.isFullyUnlocked" class="detail__chip detail__chip--accent">已解锁全文</text>
        </view>
      </view>

      <!-- ② 画像数据卡：把正文里的数字画出来 -->
      <ReportProfileChart :snapshot="profileSnapshot" />

      <!-- ③ 结论卡：我最需要什么 + 可以立刻做的三件事（服务端确定性规则算出） -->
      <view v-if="conclusion" class="card detail__verdict">
        <text class="detail__verdict-title">你在关系里最需要什么</text>
        <text class="detail__verdict-text">{{ conclusion.needs }}</text>

        <text class="detail__verdict-title detail__verdict-title--second">可以立刻开始做的三件事</text>
        <view v-for="(item, index) in conclusion.suggestions" :key="index" class="detail__verdict-item">
          <text class="detail__verdict-index">{{ index + 1 }}</text>
          <text class="detail__verdict-item-text">{{ item }}</text>
        </view>
        <text class="detail__verdict-note">{{ conclusion.note }}</text>
      </view>

      <!-- ④ 六段正文：每段先给一句结论，想细读再展开 -->
      <ReportSectionCard
        v-for="(section, index) in report.sections"
        :key="section.sectionKey"
        :section="section"
        :index="index + 1"
      />

      <SafetyDisclaimer variant="reportFooter" display="block" />

      <view class="detail__actions">
        <button class="detail__action" @tap="share">生成分享图</button>
        <button class="detail__action detail__action--ghost" @tap="retry">重新生成</button>
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

  /* ---------------------------------------------------------- ① 首屏一句话 */
  &__hero {
    padding: $space-xl $space-lg;
    margin-bottom: $space-md;
    background: linear-gradient(160deg, rgba(91, 75, 224, 0.1) 0%, rgba(255, 122, 89, 0.08) 100%);
    border-radius: $radius-lg;
  }

  &__hero-kicker {
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__hero-headline {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    line-height: $line-height-base;
    color: $color-text-primary;
  }

  &__hero-meta {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    margin-top: $space-md;
  }

  &__chip {
    padding: $space-xxs $space-sm;
    margin: 0 $space-xs $space-xs 0;
    font-size: $font-size-xs;
    color: $color-text-secondary;
    background-color: $color-bg-card;
    border-radius: $radius-round;

    &--accent {
      color: $color-secondary;
      background-color: $color-secondary-fade;
    }
  }

  /* ---------------------------------------------------------- ③ 结论卡 */
  &__verdict {
    margin-bottom: $space-md;
  }

  &__verdict-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;

    &--second {
      margin-top: $space-lg;
    }
  }

  &__verdict-text {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-base;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__verdict-item {
    @include flex-center(row);
    align-items: flex-start;
    margin-top: $space-md;
  }

  &__verdict-index {
    @include flex-center;
    flex-shrink: 0;
    width: 40rpx;
    height: 40rpx;
    margin-right: $space-sm;
    font-size: $font-size-xs;
    font-weight: $font-weight-bold;
    color: $color-text-inverse;
    background-color: $color-secondary;
    border-radius: $radius-round;
  }

  &__verdict-item-text {
    flex: 1;
    font-size: $font-size-base;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__verdict-note {
    display: block;
    margin-top: $space-lg;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-placeholder;
  }

  /* ---------------------------------------------------------- 底部操作 */
  &__actions {
    margin-top: $space-lg;
  }

  &__action {
    height: 88rpx;
    font-size: $font-size-base;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;

    &--ghost {
      margin-top: $space-sm;
      color: $color-text-secondary;
      background-color: $color-bg-hover;
    }
  }

  /* ---------------------------------------------------------- 其他状态 */
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
