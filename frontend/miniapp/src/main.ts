/**
 * 小程序入口
 *
 * uni-app Vue3 要求导出 createApp 工厂函数（而非直接挂载），
 * 由各端运行时（mp-weixin / h5）调用。
 */

import { createSSRApp } from 'vue';
import App from './App.vue';
import { setupStore } from './store';

export function createApp(): { app: ReturnType<typeof createSSRApp> } {
  const app = createSSRApp(App);
  setupStore(app);
  return { app };
}
