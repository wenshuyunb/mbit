<script setup lang="ts">
/**
 * 我的报告列表（主包，tabBar 页面）
 *
 * 已接入真实接口 `GET /reports`（契约 §3.5.2）。
 *
 * 两个**服务端已处理、前端不要再做**的点：
 *   · 进行中的报告由服务端置顶，**且已参与分页计算**。前端若再做一次本地重排，
 *     会打乱服务端算好的分页区间，导致某些报告重复出现或被整条跳过。
 *   · 未解锁段落服务端不下发正文（`content` 为 `null`），列表页只拿到
 *     `previewText` 摘要 —— 不是"前端遮挡全文"。
 */

import { ref } from 'vue';
import { onPullDownRefresh, onReachBottom, onShow } from '@dcloudio/uni-app';

import EmptyState from '@/components/EmptyState.vue';
import { listReports, type ReportSummary } from '@/api/report';
import { formatRelativeTime } from '@/utils/format';

/** 每页条数 */
const PAGE_SIZE = 10;

const reports = ref<ReportSummary[]>([]);
const loading = ref(false);
const finished = ref(false);
const page = ref(1);

/**
 * 生成状态展示文案
 *
 * 键必须与 Prisma `AiReportStatus` 一致。此前的 `PENDING`/`READY` 是契约文档里的
 * 简写，与数据库枚举对不上 —— 界面会退化成显示 `SUCCEEDED` 这种英文原始值。
 */
const STATUS_LABEL: Record<string, string> = {
  QUEUED: '排队中',
  GENERATING: '生成中',
  SUCCEEDED: '已生成',
  FAILED: '生成失败',
  CANCELLED: '已取消',
};

/** 徽标配色类名（与下方 SCSS 对应） */
const STATUS_CLASS: Record<string, string> = {
  QUEUED: 'is-queued',
  GENERATING: 'is-generating',
  SUCCEEDED: 'is-succeeded',
  FAILED: 'is-failed',
  CANCELLED: 'is-cancelled',
};

const loadMore = async (): Promise<void> => {
  if (loading.value || finished.value) return;
  loading.value = true;

  try {
    const result = await listReports({ page: page.value, pageSize: PAGE_SIZE });

    reports.value = page.value === 1 ? result.items : [...reports.value, ...result.items];
    finished.value = !result.hasNext;
    page.value += 1;
  } catch (error) {
    // 不把 finished 置真：网络抖动导致的失败应当允许用户下拉重试，
    // 置真会让列表永久停在"没有更多了"
    console.error('[report/list] 加载失败：', error);
  } finally {
    loading.value = false;
  }
};

const openReport = (report: ReportSummary): void => {
  uni.navigateTo({ url: `/pkgReport/pages/detail?id=${report.reportId}` });
};

const goTest = (): void => {
  uni.navigateTo({ url: '/pages/test/intro' });
};

onShow(() => {
  page.value = 1;
  finished.value = false;
  void loadMore();
});

onPullDownRefresh(async () => {
  page.value = 1;
  finished.value = false;
  await loadMore();
  uni.stopPullDownRefresh();
});

onReachBottom(() => {
  void loadMore();
});
</script>

<template>
  <view class="report-list page-container">
    <view v-if="reports.length > 0" class="report-list__items">
      <view v-for="report in reports" :key="report.reportId" class="report-list__item card" @tap="openReport(report)">
        <view class="report-list__item-head">
          <text class="report-list__item-title">{{ report.title ?? report.typeName }}</text>
          <text :class="['report-list__badge', STATUS_CLASS[report.status] ?? '']">
            {{ STATUS_LABEL[report.status] ?? report.status }}
          </text>
        </view>

        <view class="report-list__item-meta">
          <text v-if="report.mbtiType" class="report-list__mbti">{{ report.mbtiType }}</text>
          <text class="report-list__time">{{ formatRelativeTime(report.createdAt) }}</text>
        </view>

        <!-- 预览摘要由服务端裁剪下发；无正文（失败/生成中）时不渲染这一行 -->
        <view v-if="report.previewText" class="report-list__preview">
          <text>{{ report.previewText }}</text>
        </view>

        <view v-if="report.failureReason" class="report-list__failure">
          <text>{{ report.failureReason }}</text>
        </view>

        <view v-else-if="!report.isUnlocked" class="report-list__lock">
          <text class="report-list__lock-text">🔒 付费解锁完整报告</text>
        </view>
      </view>

      <view v-if="loading" class="report-list__loading">加载中…</view>
      <view v-else-if="finished && reports.length > 0" class="report-list__loading">没有更多了</view>
    </view>

    <EmptyState
      v-else-if="!loading"
      icon="📖"
      title="还没有报告"
      description="完成人格或情感测评后，即可生成属于你的深度解读报告"
      action-text="开始测试"
      @action="goTest"
    />
  </view>
</template>

<style lang="scss" scoped>
.report-list {
  &__item {
    margin-bottom: $space-md;

    &:active {
      background-color: $color-bg-hover;
    }
  }

  &__item-head {
    @include flex-between;
  }

  &__item-title {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__badge {
    padding: 4rpx 16rpx;
    font-size: $font-size-xs;
    color: $color-text-secondary;
    background-color: $color-bg-hover;
    border-radius: $radius-round;

    &.is-queued {
      color: $color-text-secondary;
      background-color: $color-bg-hover;
    }

    &.is-generating {
      color: $color-warning;
      background-color: rgba(245, 158, 11, 0.12);
    }

    &.is-succeeded {
      color: $color-success;
      background-color: rgba(34, 197, 94, 0.12);
    }

    &.is-failed {
      color: $color-danger;
      background-color: rgba(239, 68, 68, 0.12);
    }

    &.is-cancelled {
      color: $color-text-placeholder;
      background-color: $color-bg-hover;
    }
  }

  &__preview {
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: 1.6;
    color: $color-text-secondary;

    /* 摘要最多三行，避免长预览把列表撑成"每屏一条" */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__failure {
    padding-top: $space-sm;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    color: $color-danger;
    border-top: 1rpx solid $color-divider;
  }

  &__item-meta {
    @include flex-between;
    margin-top: $space-sm;
  }

  &__mbti {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
    letter-spacing: 2rpx;
  }

  &__time {
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__lock {
    padding-top: $space-sm;
    margin-top: $space-sm;
    border-top: 1rpx solid $color-divider;
  }

  &__lock-text {
    font-size: $font-size-sm;
    color: $color-secondary;
  }

  &__loading {
    padding: $space-md 0;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
    text-align: center;
  }
}
</style>
