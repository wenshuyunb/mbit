/**
 * Vite 构建/开发配置 —— SoulMap AI Web 管理后台
 *
 * 关键约定（见 docs/PROJECT_ARCHITECTURE.md §16.3、§17.1）：
 *   - 开发端口 5174，`/api` 反向代理到本地后端 127.0.0.1:3000（后端统一前缀 api/v1）
 *   - 生产由 Nginx 将 `/api/*` 代理到 backend 容器，前端只使用相对路径，避免 CORS
 *   - ECharts / Element Plus 体积较大，构建时按包拆分 chunk
 */

import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * SCSS 全局注入设计令牌。
 * 使用 Vite 的 `@` 别名而非绝对路径：绝对路径在 Windows 下的盘符（D:/...）会被 Sass 当成 URL scheme 解析失败。
 */
const scssAdditionalData = '@use "@/styles/variables.scss" as *;\n';

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    // 管理后台只在本地回环地址暴露，避免开发机端口被同网段访问
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },

  build: {
    target: 'es2022',
    outDir: 'dist',
    // 生产构建不产出 sourcemap，避免源码泄漏（架构 §14 安全设计）
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'element-plus': ['element-plus', '@element-plus/icons-vue'],
          echarts: ['echarts'],
        },
      },
    },
  },

  css: {
    preprocessorOptions: {
      scss: {
        additionalData: scssAdditionalData,
      },
    },
  },
});
