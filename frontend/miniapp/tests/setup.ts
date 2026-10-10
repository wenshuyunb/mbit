/**
 * Vitest 全局测试环境准备
 *
 * 小程序 API（uni.*）在 Node 环境下不存在，这里注入一个可控的轻量 Mock：
 *   · 存储 API 用内存 Map 实现（可真实往返，供 storage 单测使用）
 *   · 网络 API 默认不实现（各测试自行 mock，避免测试之间的隐式依赖）
 *
 * 原则：Mock 只覆盖「被测试代码实际调用」的 API，不追求完整实现，
 *       以免 Mock 本身的行为偏差掩盖真实缺陷。
 */

import { beforeEach, vi } from 'vitest';

/** 内存存储：模拟 uni.getStorageSync / setStorageSync / removeStorageSync */
const memoryStore = new Map<string, unknown>();

/** 存储写入失败开关：用于测试配额满时的降级逻辑 */
let storageSetShouldFail = false;

const uniMock = {
  // ---------------------------------------------------------------- 存储
  getStorageSync: vi.fn((key: string) => memoryStore.get(key) ?? ''),
  setStorageSync: vi.fn((key: string, value: unknown) => {
    if (storageSetShouldFail) {
      throw new Error('setStorageSync:fail exceed storage limit');
    }
    memoryStore.set(key, value);
  }),
  removeStorageSync: vi.fn((key: string) => {
    memoryStore.delete(key);
  }),
  clearStorageSync: vi.fn(() => {
    memoryStore.clear();
  }),

  // ---------------------------------------------------------------- 交互
  showToast: vi.fn(),
  hideToast: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
  showModal: vi.fn(),
  navigateTo: vi.fn(),
  redirectTo: vi.fn(),
  switchTab: vi.fn(),
  navigateBack: vi.fn(),

  // ---------------------------------------------------------------- 登录
  login: vi.fn((options: { success?: (res: { code: string }) => void }) => {
    options.success?.({ code: 'mock_wechat_code' });
  }),

  // ---------------------------------------------------------------- 设备信息
  getWindowInfo: vi.fn(() => ({
    windowWidth: 375,
    windowHeight: 812,
    statusBarHeight: 44,
    pixelRatio: 2,
  })),
  getSystemInfoSync: vi.fn(() => ({
    windowWidth: 375,
    windowHeight: 812,
    statusBarHeight: 44,
    pixelRatio: 2,
  })),
  getMenuButtonBoundingClientRect: vi.fn(() => ({ top: 48, height: 32, width: 87, right: 368 })),
  getAccountInfoSync: vi.fn((): MiniProgramAccountInfo => ({
    miniProgram: { appId: 'wxmock', envVersion: 'develop', version: '1.0.0' },
  })),

  // ---------------------------------------------------------------- 网络
  request: vi.fn(),
  createSelectorQuery: vi.fn(),

  // ---------------------------------------------------------------- 画布/文件
  downloadFile: vi.fn(),
  saveImageToPhotosAlbum: vi.fn(),
};

// 挂到全局，供被测代码直接引用（小程序运行时 uni 即为全局变量）
(globalThis as unknown as { uni: typeof uniMock }).uni = uniMock;

/** 测试辅助：清空内存存储与调用记录 */
beforeEach(() => {
  memoryStore.clear();
  storageSetShouldFail = false;
  vi.clearAllMocks();
});

/** 导出给个别测试使用的控制入口 */
export const testHelpers = {
  memoryStore,
  failStorageWrite(value: boolean): void {
    storageSetShouldFail = value;
  },
};
