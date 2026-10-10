/**
 * Vitest 配置（小程序端单元测试）
 *
 * 说明：小程序 API（uni.*）在 Node 环境下不存在，测试通过 tests/setup.ts
 *       注入轻量 Mock。这里只测试纯逻辑（工具函数、store、算法、请求层），
 *       不做真实渲染测试（渲染验证交给微信开发者工具 + 真机）。
 */

import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/utils/**/*.ts', 'src/config/**/*.ts', 'src/api/**/*.ts', 'src/store/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
