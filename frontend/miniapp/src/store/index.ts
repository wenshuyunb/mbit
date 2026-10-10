/**
 * Pinia 实例与持久化
 *
 * 说明：不引入 pinia-plugin-persistedstate（避免额外依赖与其对 pinia 版本的强绑定），
 *       改为在需要持久化的 store 中显式调用 utils/storage，语义更清晰、可控。
 */

import { createPinia, type Pinia } from 'pinia';
import type { App } from 'vue';

const pinia: Pinia = createPinia();

export const setupStore = (app: App): void => {
  app.use(pinia);
};

export { pinia };
