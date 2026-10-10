/**
 * Vitest 单元测试配置 —— SoulMap AI Web 管理后台
 *
 * 说明：
 *   - 测试环境使用 jsdom（需要 localStorage / ResizeObserver 等浏览器 API，补丁见 tests/setup.ts）
 *   - 仅收集 tests/**\/*.spec.ts，组件与工具函数测试均放在 tests 目录，与 src 分离
 *   - 覆盖率由 CI 统一配置，此处不启用（避免引入额外依赖）
 */

import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    // 每个用例前清空 mock 调用记录（不重置实现，避免影响 vi.mock 的模块级替身）
    clearMocks: true,
    // 单元测试不依赖真实网络，任何真实请求都视为缺陷
    testTimeout: 10000,
  },
});
