/**
 * 轻提示与加载态封装
 *
 * 价值：
 *   · 统一 toast 时长与图标，避免各页面参数不一致
 *   · 处理「错误提示去重」：并发请求失败时不刷屏（同一文案 1.5s 内只提示一次）
 *   · 统一 loading 引用计数，避免并发请求时 hideLoading 提前关闭
 */

let loadingCount = 0;
let lastToastMessage = '';
let lastToastAt = 0;

/** 提示去重窗口（毫秒） */
const TOAST_DEDUPE_WINDOW_MS = 1500;

export const toast = {
  info(title: string, duration = 2000): void {
    uni.showToast({ title, icon: 'none', duration });
  },

  success(title: string, duration = 1500): void {
    uni.showToast({ title, icon: 'success', duration, mask: false });
  },

  error(title: string, duration = 2500): void {
    const now = Date.now();
    if (title === lastToastMessage && now - lastToastAt < TOAST_DEDUPE_WINDOW_MS) {
      return;
    }
    lastToastMessage = title;
    lastToastAt = now;
    uni.showToast({ title, icon: 'none', duration });
  },

  loading(title = '加载中'): void {
    uni.showLoading({ title, mask: true });
  },

  hideLoading(): void {
    uni.hideLoading();
  },
};

/**
 * 引用计数式 loading 包装
 * 并发请求时只有最后一个结束时才真正隐藏 loading
 */
export const withLoading = async <T>(task: () => Promise<T>, title = '加载中'): Promise<T> => {
  if (loadingCount === 0) {
    toast.loading(title);
  }
  loadingCount += 1;

  try {
    return await task();
  } finally {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) {
      toast.hideLoading();
    }
  }
};

/** 确认对话框（Promise 化），用于删除报告、退出测试等危险操作 */
export const confirm = (options: {
  title?: string;
  content: string;
  confirmText?: string;
  cancelText?: string;
  confirmColor?: string;
}): Promise<boolean> =>
  new Promise((resolve) => {
    uni.showModal({
      title: options.title ?? '提示',
      content: options.content,
      confirmText: options.confirmText ?? '确定',
      cancelText: options.cancelText ?? '取消',
      confirmColor: options.confirmColor ?? '#5B4BE0',
      success: (res) => resolve(res.confirm === true),
      fail: () => resolve(false),
    });
  });
