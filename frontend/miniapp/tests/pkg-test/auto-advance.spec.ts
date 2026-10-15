/**
 * 自动跳题控制器测试
 *
 * 锁死 2026-10-15 真机踩到的**静默漏答**故障：
 * 用户在 52 题的情感测评里答到最后，提交被拒「还有 4 道题未作答」，
 * 缺的是散落的第 10、34、37、49 题。
 *
 * 原因是「作答后自动跳下一题」用的是无句柄的 `setTimeout`：
 * 用户在 180ms 内又点了「下一题」，两次跳转叠加 → 中间那道题**从未显示**，
 * 也不会有答案，而界面上没有任何地方提示"你漏了一题"。
 *
 * 控制器的三条不变量在这里逐条验证：
 *   ① 排一次，到点执行**一次**；
 *   ② 连排两次只执行一次（不叠加成连跳）；
 *   ③ 手动翻页前 `cancel()` 之后，到点**什么也不做**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAutoAdvance } from '@/pkgTest/auto-advance';

const DELAY_MS = 220;

let advance: ReturnType<typeof vi.fn>;
let controller: ReturnType<typeof createAutoAdvance>;

beforeEach(() => {
  vi.useFakeTimers();
  advance = vi.fn();
  controller = createAutoAdvance(DELAY_MS, advance);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAutoAdvance', () => {
  it('排一次 → 到点执行一次', () => {
    controller.schedule();
    expect(advance).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DELAY_MS);

    expect(advance).toHaveBeenCalledTimes(1);
    expect(controller.pending).toBe(false);
  });

  it('延时未到不执行（给用户看到选中态的时间）', () => {
    controller.schedule();
    vi.advanceTimersByTime(DELAY_MS - 1);

    expect(advance).not.toHaveBeenCalled();
  });

  it('【关键】连排两次只跳一题（否则会跳过一题且不留痕迹）', () => {
    controller.schedule();
    vi.advanceTimersByTime(50);
    controller.schedule(); // 用户又点了一下选项 / 快速点了下一题

    vi.advanceTimersByTime(DELAY_MS);

    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('【关键】取消后到点不执行（手动翻页必须能打断自动跳题）', () => {
    controller.schedule();
    controller.cancel();
    expect(controller.pending).toBe(false);

    vi.advanceTimersByTime(DELAY_MS * 3);

    expect(advance).not.toHaveBeenCalled();
  });

  it('取消后再排，仍然正常执行（取消不是"用一次就废"）', () => {
    controller.schedule();
    controller.cancel();
    controller.schedule();

    vi.advanceTimersByTime(DELAY_MS);

    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('重复取消不抛错（页面卸载时会再取消一次）', () => {
    controller.schedule();
    controller.cancel();
    controller.cancel();

    expect(controller.pending).toBe(false);
  });

  it('执行过一次后再取消，不会重复执行', () => {
    controller.schedule();
    vi.advanceTimersByTime(DELAY_MS);
    controller.cancel();
    vi.advanceTimersByTime(DELAY_MS);

    expect(advance).toHaveBeenCalledTimes(1);
  });

  /**
   * 场景题需要更长的延时的原因：要留出**读完那句即时反馈**的时间。
   * 反馈只有十几个字，但一闪而过就等于没有 —— 那样这个功能就白做了。
   */
  it('可以按次覆盖延时（场景题读反馈用更长时间）', () => {
    const LONG_MS = 1400;

    controller.schedule(LONG_MS);
    vi.advanceTimersByTime(DELAY_MS);
    expect(advance).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LONG_MS - DELAY_MS);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('覆盖延时后仍然只跳一次、且可被取消', () => {
    controller.schedule(1400);
    controller.schedule(1400);
    controller.cancel();
    vi.advanceTimersByTime(3000);

    expect(advance).not.toHaveBeenCalled();
  });
});
