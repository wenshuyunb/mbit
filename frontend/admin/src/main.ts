/**
 * 应用入口
 *
 * 初始化顺序（重要）：
 *   1. 安装 Pinia —— 路由守卫、axios 令牌提供者都依赖 store；
 *   2. 安装 Router —— `app.use(router)` 会触发首次导航，此时守卫执行必须已有激活的 Pinia；
 *   3. 安装 Element Plus（全量引入 + 中文语言包）；
 *   4. 注册「令牌提供者」与「全局错误通知器」，把 api 层与 store / UI 层解耦（避免循环依赖）；
 *   5. 应用持久化主题后挂载。
 *
 * 安全（架构 §16.3）：本文件及所有前端代码不得出现任何密钥；
 * 管理员令牌仅存内存（架构 §9.2），刷新页面即失效，需重新登录。
 */

import { createApp } from 'vue';
import ElementPlus, { ElMessage } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
// Element Plus 暗色主题变量（由 html.dark 类启用，见 store/app.ts 的 applyTheme）
import 'element-plus/theme-chalk/dark/css-vars.css';
import '@/styles/index.scss';
import { setErrorNotifier, setTokenProvider } from '@/api/client';
import App from './App.vue';
import router from './router';
import pinia from './store';
import { useAppStore } from './store/app';
import { useAuthStore } from './store/auth';

const app = createApp(App);

// ① Pinia 必须先于 Router 安装（守卫内会读取 auth store）
app.use(pinia);
// ② 路由（含导航守卫与 401 未授权处理器）
app.use(router);
// ③ UI 库：Phase 0 全量引入，换取接入确定性（构建时 Element Plus 已拆为独立 chunk）
app.use(ElementPlus, { locale: zhCn });

// ④ 令牌提供者：axios 请求拦截器每次请求时读取内存中的 AccessToken
const authStore = useAuthStore(pinia);
setTokenProvider((): string | null => authStore.accessToken);

// ⑤ 全局错误提示：api 层抛出 ApiError 时统一提示；单次请求可传 `silent: true` 关闭
setErrorNotifier((error): void => {
  ElMessage.error({ message: error.message, duration: 4000, showClose: true });
});

// ⑥ 应用持久化的主题偏好
useAppStore(pinia).applyTheme();

app.mount('#app');
