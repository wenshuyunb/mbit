/**
 * 报告详情页状态机（可单测，不依赖 uni-app 运行时）
 *
 * ## 为什么从页面里抽出来
 *
 * 这段逻辑有三个**只在时序上出错**的缺陷类型，写在 `.vue` 的 `<script setup>` 里
 * 无法测试 —— 而它们都不会在肉眼验收时暴露：
 *
 *   ① 轮询定时器泄漏：用户离开页面后定时器仍在跑，每 2 秒继续打到服务端
 *   ② 终态未停：`SUCCEEDED` / `FAILED` / `CANCELLED` 之后仍在轮询
 *   ③ 无上限：任务因队列积压长期停在 `QUEUED` 时，页面永远转圈
 *
 * 抽成 composable 后可以注入假的接口与假定时器，把上述路径全部断言出来
 * （与 ADR-027「纯逻辑抽为独立可测模块」同一思路）。
 *
 * ## 「生成中」是从错误码分支出来的
 *
 * 后端把 `QUEUED` / `GENERATING` 视为"还没好"，详情接口直接返回 `50017`
 * （`AI_REPORT_GENERATING`），而不是下发一份没有正文的报告。
 * 因此**不能**靠 `report.status` 判断生成中 —— 那条分支永远走不到。
 */

import { computed, ref } from 'vue';

import {
  getReport as defaultGetReport,
  getReportProgress as defaultGetProgress,
  regenerateReport as defaultRegenerate,
  type ReportDetail,
  type ReportProgress,
} from '@/api/report';
import { ApiError, ERROR_CODES } from '@/api/types';

/** 页面形态（互斥） */
export type ReportDetailState = 'loading' | 'generating' | 'failed' | 'ready' | 'locked' | 'missing';

/** 轮询间隔（毫秒） */
export const POLL_INTERVAL_MS = 2000;

/**
 * 轮询次数上限（约 3 分钟）
 *
 * 必须有上限：生成任务可能因队列积压长时间停在 `QUEUED`，无上限轮询会让页面
 * 永远转圈，用户既不知道发生了什么也无法重试。
 */
export const MAX_POLL_ATTEMPTS = 90;

/** 依赖注入（测试传入桩实现） */
export interface ReportDetailDeps {
  getReport: (reportId: string) => Promise<ReportDetail>;
  getReportProgress: (reportId: string) => Promise<ReportProgress>;
  regenerateReport: (reportId: string) => Promise<unknown>;
}

const defaultDeps: ReportDetailDeps = {
  getReport: defaultGetReport,
  getReportProgress: defaultGetProgress,
  regenerateReport: defaultRegenerate,
};

/** 错误码 → 页面形态（**默认分支必须是 missing**，见下方说明） */
export const stateFromErrorCode = (code: number): ReportDetailState => {
  switch (code) {
    case ERROR_CODES.AI_REPORT_GENERATING:
      return 'generating';
    case ERROR_CODES.AI_REPORT_GENERATION_FAILED:
      return 'failed';
    case ERROR_CODES.AI_REPORT_NOT_UNLOCKED:
      return 'locked';
    default:
      // 未知错误一律按"不存在"处理：宁可提示报告不见了，也不能给一个
      // 半渲染的空壳页面 —— 后者会让用户以为报告内容就是这么少
      return 'missing';
  }
};

export interface UseReportDetailResult {
  reportId: ReturnType<typeof ref<string>>;
  report: ReturnType<typeof ref<ReportDetail | null>>;
  progress: ReturnType<typeof ref<ReportProgress | null>>;
  state: ReturnType<typeof ref<ReportDetailState>>;
  failureMessage: ReturnType<typeof ref<string>>;
  pollTimedOut: ReturnType<typeof ref<boolean>>;
  isGenerating: ReturnType<typeof computed<boolean>>;
  isLocked: ReturnType<typeof computed<boolean>>;
  previewHint: ReturnType<typeof computed<string>>;
  /** 首次加载（绑定 `reportId` 后调用） */
  load: () => Promise<void>;
  /** 仅重新拉取，不触发新的生成任务 */
  refresh: () => Promise<void>;
  /** 重新入队生成（与刷新分开，避免生成中反复触发新任务浪费配额） */
  retry: () => Promise<void>;
  /** 页面隐藏时暂停轮询 */
  pause: () => void;
  /** 页面重新可见时若仍在生成则恢复轮询 */
  resume: () => void;
  /** 页面销毁时清理定时器 */
  dispose: () => void;
}

export const useReportDetail = (deps: Partial<ReportDetailDeps> = {}): UseReportDetailResult => {
  const api: ReportDetailDeps = { ...defaultDeps, ...deps };

  const reportId = ref('');
  const report = ref<ReportDetail | null>(null);
  const progress = ref<ReportProgress | null>(null);
  const state = ref<ReportDetailState>('loading');
  const failureMessage = ref('');
  const pollTimedOut = ref(false);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollAttempts = 0;

  const isGenerating = computed(() => state.value === 'generating');

  const isLocked = computed(() => state.value === 'locked' || (report.value?.visibility.lockedSections ?? 0) > 0);

  const previewHint = computed(() => {
    const visibility = report.value?.visibility;
    // 整份锁定时不能显示"已展示约 0%"：那是误导，实际情况是还没解锁任何内容
    if (!visibility || visibility.totalSections <= 0) return '免费预览仅展示部分内容，';

    const ratio = Math.round((visibility.unlockedSections / visibility.totalSections) * 100);

    return `免费预览已展示约 ${ratio}% 内容，`;
  });

  const stopPolling = (): void => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const load = async (): Promise<void> => {
    if (reportId.value === '') {
      state.value = 'missing';
      return;
    }

    state.value = 'loading';

    try {
      report.value = await api.getReport(reportId.value);
      state.value = 'ready';
      return;
    } catch (error) {
      if (!(error instanceof ApiError)) {
        state.value = 'missing';
        return;
      }

      state.value = stateFromErrorCode(error.code);
      if (state.value === 'failed') {
        failureMessage.value = error.message;
      }
      if (state.value === 'generating') {
        startPolling();
      }
    }
  };

  function scheduleNextPoll(): void {
    stopPolling();
    pollTimer = setTimeout(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);
  }

  const pollOnce = async (): Promise<void> => {
    // 已离开生成中形态（用户手动刷新成功、页面被销毁）时不再发起请求
    if (state.value !== 'generating') return;

    pollAttempts += 1;
    if (pollAttempts > MAX_POLL_ATTEMPTS) {
      stopPolling();
      pollTimedOut.value = true;
      return;
    }

    try {
      const result = await api.getReportProgress(reportId.value);
      progress.value = result;

      if (result.status === 'SUCCEEDED') {
        stopPolling();
        await load();
        return;
      }
      if (result.status === 'FAILED' || result.status === 'CANCELLED') {
        stopPolling();
        state.value = 'failed';
        failureMessage.value = result.errorMessage ?? '生成未完成，请重新生成';
        return;
      }
    } catch (error) {
      // 单次轮询失败**不**中断：网络抖动就让进度条永久停住的话，
      // 用户只能退出去重进。但"报告不存在"是确定性错误，继续轮询毫无意义
      if (error instanceof ApiError && error.code === ERROR_CODES.AI_REPORT_NOT_FOUND) {
        stopPolling();
        state.value = 'missing';
        return;
      }
    }

    scheduleNextPoll();
  };

  function startPolling(): void {
    pollAttempts = 0;
    pollTimedOut.value = false;
    scheduleNextPoll();
  }

  const refresh = async (): Promise<void> => {
    await load();
  };

  const retry = async (): Promise<void> => {
    if (reportId.value === '') return;

    try {
      await api.regenerateReport(reportId.value);
      progress.value = null;
      failureMessage.value = '';
      state.value = 'generating';
      startPolling();
    } catch (error) {
      // 交给调用方展示 toast；此处只保证状态不被破坏
      throw error;
    }
  };

  return {
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
    retry,
    pause: stopPolling,
    resume: (): void => {
      if (state.value === 'generating') {
        startPolling();
      }
    },
    dispose: stopPolling,
  };
};
