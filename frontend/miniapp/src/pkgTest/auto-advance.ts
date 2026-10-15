/**
 * 答题页的「作答后自动跳下一题」控制器
 *
 * ## 为什么单独抽出来
 *
 * 2026-10-15 真机故障：用户在 52 题的情感测评里答到最后，提交被拒
 * 「还有 4 道题未作答」，缺的是**散落**的第 10、34、37、49 题。
 *
 * 根因就是这段逻辑原先写在页面里、且长这样：
 *
 * ```ts
 * if (!isLast) setTimeout(() => testStore.next(), 180);   // 句柄没保存
 * ```
 *
 * 定时器**没有句柄、无法取消**，于是：
 *
 * ```
 * t+0    点选项 → 排一个 180ms 后 next()
 * t+50   用户觉得没反应，点了「下一题」 → next()      ← 到第 n+1 题
 * t+180  定时器触发 → next()                          ← 又到第 n+2 题
 *        第 n+1 题从未显示，也不会有答案 —— 静默漏答
 * ```
 *
 * 修法不是"把延时调长"，而是**让待执行的跳转可被取消**：任何手动翻页都先取消它。
 * 这段时序逻辑留在 `.vue` 里只能靠肉眼看，抽成纯模块后可以用假定时器精确验证
 * （`tests/pkg-test/auto-advance.spec.ts`）。
 */

/** 自动跳题控制器 */
export interface AutoAdvance {
  /**
   * 排一次跳转；重复调用**只会保留最后一次**（不会叠加成连跳两题）
   *
   * @param delayMs 本次的延时；不传则用创建时的默认值。
   *                沉浸式场景题需要更长的时间（用户要读完那句即时反馈），
   *                而量表题只要"看到选中态"就够了。
   */
  schedule(delayMs?: number): void;
  /** 取消待执行的跳转（手动翻页、跳题、离开页面时调用） */
  cancel(): void;
  /** 当前是否有待执行的跳转（测试与调试用） */
  readonly pending: boolean;
}

/**
 * 创建一个自动跳题控制器
 *
 * @param delayMs 默认延时（要给用户"看到自己点的选项被选中"的时间）
 * @param advance 到点后执行的动作（通常是 `goTo(currentIndex + 1)`）
 */
export const createAutoAdvance = (delayMs: number, advance: () => void): AutoAdvance => {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule(overrideMs?: number): void {
      // 先取消再排：连点两次选项不应该连跳两题
      cancel();
      timer = setTimeout(() => {
        timer = null;
        advance();
      }, overrideMs ?? delayMs);
    },

    cancel,

    get pending(): boolean {
      return timer !== null;
    },
  };
};
