/**
 * 报告详情页状态机测试
 *
 * 重点覆盖**只在时序上出错**的三类缺陷 —— 肉眼验收时全都看不出来：
 *   ① 定时器泄漏：离开页面后仍每 2 秒打到服务端
 *   ② 终态未停：SUCCEEDED / FAILED / CANCELLED 之后仍在轮询
 *   ③ 无上限：任务长期停在 QUEUED 时页面永远转圈
 *
 * 另外覆盖错误码 → 形态的映射，尤其是**默认分支**：未知错误若落到
 * "可读"形态，用户会看到一个半渲染的空壳页面，以为报告就这么多内容。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReportDetail, ReportProgress } from '@/api/report';
import { ApiError, ERROR_CODES } from '@/api/types';
import {
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  stateFromErrorCode,
  useReportDetail,
} from '@/composables/use-report-detail';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const REPORT_ID = '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d';

const makeDetail = (lockedSections = 0, unlockedSections = 2): ReportDetail => ({
  reportId: REPORT_ID,
  type: 'MBTI_REPORT',
  typeName: '人格深度报告',
  status: 'SUCCEEDED',
  title: '你的 INFJ 深度解读',
  summary: null,
  sectionCount: lockedSections + unlockedSections,
  sections: [],
  visibility: {
    totalSections: lockedSections + unlockedSections,
    unlockedSections,
    lockedSections,
    isFullyUnlocked: lockedSections === 0,
    isFullyLocked: unlockedSections === 0,
  },
  mbtiType: 'INFJ',
  engineVersion: 'pe-v1.0.0',
  provider: 'deepseek',
  model: 'deepseek-chat',
  createdAt: '2026-10-10T12:00:00.000Z',
  finishedAt: '2026-10-10T12:00:52.400Z',
  // 画像快照（详情页画条形图用）：本夹具只关心状态机，给 null 即可
  profileSnapshot: null,
});

const makeProgress = (status: ReportProgress['status'], progress = 0): ReportProgress => ({
  reportId: REPORT_ID,
  status,
  progress,
  errorCode: null,
  errorMessage: null,
  requestedAt: '2026-10-10T12:00:00.000Z',
  finishedAt: null,
});

const apiError = (code: number, message = 'boom'): ApiError =>
  new ApiError({ code, message, httpStatus: 400, requestId: 'req-1' });

/** 建立一个带桩依赖的 composable，并设置好 reportId */
const setup = (deps: {
  getReport?: () => Promise<ReportDetail>;
  getReportProgress?: () => Promise<ReportProgress>;
  regenerateReport?: () => Promise<unknown>;
}) => {
  const composable = useReportDetail({
    getReport: deps.getReport ?? ((): Promise<ReportDetail> => Promise.resolve(makeDetail())),
    getReportProgress:
      deps.getReportProgress ?? ((): Promise<ReportProgress> => Promise.resolve(makeProgress('GENERATING'))),
    regenerateReport: deps.regenerateReport ?? ((): Promise<unknown> => Promise.resolve({})),
  });
  composable.reportId.value = REPORT_ID;

  return composable;
};

/** 推进假定时器并冲掉挂起的 promise 链 */
const tick = async (times = 1): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  }
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 错误码映射
// ---------------------------------------------------------------------------

describe('stateFromErrorCode', () => {
  it('50017 生成中 → generating', () => {
    expect(stateFromErrorCode(ERROR_CODES.AI_REPORT_GENERATING)).toBe('generating');
  });

  it('50018 生成失败 → failed', () => {
    expect(stateFromErrorCode(ERROR_CODES.AI_REPORT_GENERATION_FAILED)).toBe('failed');
  });

  it('50019 整份未解锁 → locked', () => {
    expect(stateFromErrorCode(ERROR_CODES.AI_REPORT_NOT_UNLOCKED)).toBe('locked');
  });

  it('50016 报告不存在 → missing', () => {
    expect(stateFromErrorCode(ERROR_CODES.AI_REPORT_NOT_FOUND)).toBe('missing');
  });

  it('【关键】未知错误码一律落到 missing，绝不落到 ready', () => {
    // 落到 ready 会渲染一个半空页面（title/sections 全是 undefined），
    // 用户以为报告内容就这么少 —— 比"报告不存在"更难排查
    for (const unknown of [0, 1, 10000, 50020, 99999]) {
      expect(stateFromErrorCode(unknown)).toBe('missing');
    }
  });
});

// ---------------------------------------------------------------------------
// 首次加载
// ---------------------------------------------------------------------------

describe('useReportDetail 首次加载', () => {
  it('成功时进入 ready 并带上报告', async () => {
    const c = setup({});
    await c.load();

    expect(c.state.value).toBe('ready');
    expect(c.report.value?.mbtiType).toBe('INFJ');
    expect(c.isGenerating.value).toBe(false);
  });

  it('reportId 为空时直接 missing（不发请求）', async () => {
    const getReport = vi.fn();
    const c = useReportDetail({
      getReport,
      getReportProgress: vi.fn(),
      regenerateReport: vi.fn(),
    });

    await c.load();

    expect(c.state.value).toBe('missing');
    expect(getReport).not.toHaveBeenCalled();
  });

  it('【关键】50017 进入 generating 并启动轮询', async () => {
    const getReportProgress = vi.fn(() => Promise.resolve(makeProgress('GENERATING', 40)));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    expect(c.state.value).toBe('generating');

    await tick();
    expect(getReportProgress).toHaveBeenCalledTimes(1);
    expect(c.progress.value?.progress).toBe(40);
  });

  it('50018 进入 failed 并展示服务端文案', async () => {
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATION_FAILED, 'AI 服务暂时不可用')),
    });

    await c.load();

    expect(c.state.value).toBe('failed');
    expect(c.failureMessage.value).toBe('AI 服务暂时不可用');
  });

  it('50019 进入 locked（仍进页面，让用户看到解锁入口）', async () => {
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_NOT_UNLOCKED)),
    });

    await c.load();

    expect(c.state.value).toBe('locked');
    expect(c.isLocked.value).toBe(true);
  });

  it('非 ApiError（如代码异常）不冒充生成中，按 missing 处理', async () => {
    const c = setup({ getReport: () => Promise.reject(new Error('TypeError')) });

    await c.load();

    expect(c.state.value).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

describe('useReportDetail 轮询', () => {
  it('【关键】SUCCEEDED 后停止轮询并自动拉取详情', async () => {
    const getReportProgress = vi.fn(() => Promise.resolve(makeProgress('SUCCEEDED', 100)));
    const getReport = vi
      .fn<() => Promise<ReportDetail>>()
      .mockRejectedValueOnce(apiError(ERROR_CODES.AI_REPORT_GENERATING))
      .mockResolvedValue(makeDetail());

    const c = setup({ getReport, getReportProgress });

    await c.load();
    expect(c.state.value).toBe('generating');

    await tick();
    expect(c.state.value).toBe('ready');
    expect(c.report.value).not.toBeNull();

    // 关键：终态之后不能再有请求。此前若忘记 stopPolling，定时器会一直转
    await tick(3);
    expect(getReportProgress).toHaveBeenCalledTimes(1);
  });

  it('【关键】FAILED 后停止轮询', async () => {
    const getReportProgress = vi.fn(() => Promise.resolve({ ...makeProgress('FAILED'), errorMessage: '上游限流' }));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    await tick();

    expect(c.state.value).toBe('failed');
    expect(c.failureMessage.value).toBe('上游限流');

    await tick(3);
    expect(getReportProgress).toHaveBeenCalledTimes(1);
  });

  it('【关键】CANCELLED 也视为终态并停止轮询', async () => {
    const getReportProgress = vi.fn(() => Promise.resolve(makeProgress('CANCELLED')));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    await tick();

    expect(c.state.value).toBe('failed');

    await tick(3);
    expect(getReportProgress).toHaveBeenCalledTimes(1);
  });

  it('QUEUED / GENERATING 继续轮询', async () => {
    const getReportProgress = vi.fn(() => Promise.resolve(makeProgress('GENERATING', 10)));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    await tick(3);

    expect(getReportProgress).toHaveBeenCalledTimes(3);
    expect(c.state.value).toBe('generating');
  });

  it('【关键】单次轮询网络失败不中断（否则进度条永久停住）', async () => {
    const getReportProgress = vi
      .fn<() => Promise<ReportProgress>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(makeProgress('GENERATING', 50));

    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    await tick(2);

    expect(getReportProgress).toHaveBeenCalledTimes(2);
    expect(c.progress.value?.progress).toBe(50);
    expect(c.state.value).toBe('generating');
  });

  it('【关键】轮询中报告被删除（50016）→ 停止轮询并转 missing', async () => {
    const getReportProgress = vi.fn(() => Promise.reject(apiError(ERROR_CODES.AI_REPORT_NOT_FOUND)));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    await tick();

    expect(c.state.value).toBe('missing');

    await tick(3);
    expect(getReportProgress).toHaveBeenCalledTimes(1);
  });

  it('【关键】超过次数上限后停止轮询并置 pollTimedOut', async () => {
    const getReportProgress = vi.fn(() => Promise.resolve(makeProgress('QUEUED', 0)));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    await tick(MAX_POLL_ATTEMPTS + 5);

    expect(c.pollTimedOut.value).toBe(true);
    // 上限之后一次都不该再发
    expect(getReportProgress).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS);
    expect(c.state.value).toBe('generating');
  });

  it('【关键】pause 后不再请求，resume 恢复轮询', async () => {
    const getReportProgress = vi.fn(() => Promise.resolve(makeProgress('GENERATING', 10)));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    await tick();
    expect(getReportProgress).toHaveBeenCalledTimes(1);

    // 模拟切到后台
    c.pause();
    await tick(5);
    expect(getReportProgress).toHaveBeenCalledTimes(1);

    c.resume();
    await tick();
    expect(getReportProgress).toHaveBeenCalledTimes(2);
  });

  it('【关键】dispose 后定时器彻底清理（离开页面不得继续打服务端）', async () => {
    const getReportProgress = vi.fn(() => Promise.resolve(makeProgress('GENERATING', 10)));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATING)),
      getReportProgress,
    });

    await c.load();
    c.dispose();
    await tick(10);

    expect(getReportProgress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('不在生成中形态时 resume 不会凭空启动轮询', async () => {
    const getReportProgress = vi.fn();
    const c = setup({ getReportProgress });

    await c.load();
    expect(c.state.value).toBe('ready');

    c.resume();
    await tick(3);

    expect(getReportProgress).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

describe('useReportDetail 重试', () => {
  it('【关键】重试会真的重新入队，而不是只刷新', async () => {
    const regenerateReport = vi.fn(() => Promise.resolve({}));
    const getReportProgress = vi.fn(() => Promise.resolve(makeProgress('GENERATING', 5)));
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATION_FAILED)),
      getReportProgress,
      regenerateReport,
    });

    await c.load();
    expect(c.state.value).toBe('failed');

    await c.retry();

    expect(regenerateReport).toHaveBeenCalledWith(REPORT_ID);
    expect(c.state.value).toBe('generating');
    expect(c.failureMessage.value).toBe('');

    await tick();
    expect(getReportProgress).toHaveBeenCalledTimes(1);
  });

  it('重试失败时抛出，由调用方决定提示文案（状态不被破坏）', async () => {
    const c = setup({
      getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_GENERATION_FAILED)),
      regenerateReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_REGENERATE_FORBIDDEN)),
    });

    await c.load();
    const before = c.state.value;

    await expect(c.retry()).rejects.toBeInstanceOf(ApiError);
    expect(c.state.value).toBe(before);
  });

  it('reportId 为空时重试不发请求', async () => {
    const regenerateReport = vi.fn();
    const c = useReportDetail({
      getReport: vi.fn(),
      getReportProgress: vi.fn(),
      regenerateReport,
    });

    await c.retry();

    expect(regenerateReport).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 派生展示值
// ---------------------------------------------------------------------------

describe('useReportDetail 派生展示值', () => {
  it('有锁定段落时展示付费墙', async () => {
    const c = setup({ getReport: () => Promise.resolve(makeDetail(1, 2)) });
    await c.load();

    expect(c.isLocked.value).toBe(true);
    expect(c.previewHint.value).toContain('67%');
  });

  it('全部解锁时不展示付费墙', async () => {
    const c = setup({ getReport: () => Promise.resolve(makeDetail(0, 3)) });
    await c.load();

    expect(c.isLocked.value).toBe(false);
  });

  it('【关键】整份锁定时不显示"已展示约 0%"（那是误导）', async () => {
    const c = setup({ getReport: () => Promise.reject(apiError(ERROR_CODES.AI_REPORT_NOT_UNLOCKED)) });
    await c.load();

    expect(c.previewHint.value).toBe('免费预览仅展示部分内容，');
    expect(c.previewHint.value).not.toContain('0%');
  });

  it('总段数为 0 时不会除零', async () => {
    const c = setup({ getReport: () => Promise.resolve(makeDetail(0, 0)) });
    await c.load();

    expect(c.previewHint.value).toBe('免费预览仅展示部分内容，');
  });
});
