/**
 * uni-app Vite 构建配置
 *
 * ⚠ 版本约束（不可随意升级）：
 *   @dcloudio/vite-plugin-uni 的 peerDependency 精确锁定 vite@5.2.8，
 *   且其内部打包了 @vue/compiler-sfc@3.4.21，因此：
 *     · vite 必须保持 5.2.8
 *     · vue 必须保持 3.4.21（与编译器版本一致，否则 SFC 编译产物不确定）
 *   升级 uni-app 时需同步核对这三个版本。
 */

import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [uni()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  css: {
    preprocessorOptions: {
      scss: {
        // 设计令牌全局可用，业务样式无需重复 @import
        additionalData: '@import "@/styles/tokens.scss";@import "@/styles/arcana-theme.scss";',
      },
    },
  },

  build: {
    // 小程序包体积敏感，构建产物不做 sourcemap（需要排查时临时开启）
    sourcemap: false,
    // 微信小程序主包上限 2MB，超限时必须拆分包（见 pages.json subPackages）
    chunkSizeWarningLimit: 1500,
    target: 'es2018',
  },

  // 显式声明：小程序运行时没有 Node 内置模块，避免误引入
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
});
