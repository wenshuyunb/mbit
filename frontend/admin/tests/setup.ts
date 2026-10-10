/**
 * Vitest 全局测试环境补丁（jsdom）
 *
 * jsdom 未实现部分浏览器 API，而 Element Plus / ECharts 在挂载时会调用它们；
 * 这里做最小化补齐，避免测试因环境缺失而失败（而不是因为被测逻辑有缺陷）。
 * 另外统一在每个用例前清理本地存储，避免 store 持久化、storage 用例相互污染。
 */

import { beforeEach, vi } from 'vitest';

/** jsdom 缺失的 ResizeObserver（ECharts 容器尺寸监听、Element Plus 部分组件使用） */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // 测试环境不需要真实回调
  }

  unobserve(): void {
    // 测试环境不需要真实回调
  }

  disconnect(): void {
    // 测试环境不需要真实回调
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
}

/** jsdom 缺失的 matchMedia（暗色主题媒体查询等） */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
