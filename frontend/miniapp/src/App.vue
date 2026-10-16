<script setup lang="ts">
/**
 * 应用根组件
 *
 * 职责（Phase 0）：
 *   · **启动时初始化系统尺寸**（状态栏高度 / 胶囊按钮）—— 自定义导航栏靠它让开刘海
 *   · 启动时执行一次静默登录（wx.login → 换取 token，不弹授权框）
 *   · 拉取系统配置（功能开关、免责声明、分享文案），失败不阻塞启动
 *   · 全局错误兜底：onError / onUnhandledRejection 上报
 *
 * 注意：登录失败不阻断进入首页（游客可浏览首页与测试介绍），
 *       真正需要身份的操作在调用时再引导登录。
 */

import { onLaunch, onShow, onError, onUnhandledRejection } from '@dcloudio/uni-app';
import { useAuthStore } from '@/store/auth';
import { useAppStore } from '@/store/app';

onLaunch(() => {
  const appStore = useAppStore();
  const authStore = useAuthStore();

  /**
   * ⚠ 系统尺寸必须在这里初始化，**不能只在首页初始化**（2026-10-16 修）
   *
   * 原先这行只写在 `pages/index/index.vue` 里，于是**从分享/消息直接进入子包页面**时
   * （也就是首页从未挂载的路径）`statusBarHeight` 停留在默认值 20，
   * 而 `pages/result`、`pages/quiz` 是 `navigationStyle: custom` ——
   * 系统不给导航栏，页面靠这个值让开状态栏。值偏小 → 标题与返回按钮被状态栏挡住。
   *
   * 用户报的就是这个：「评测报告的 UI 被手机的上端遮挡了」。
   * 放在 `onLaunch` 里是**一次且必然发生**的；放在某个页面里则取决于用户从哪儿进来。
   */
  appStore.initSystemMetrics();

  // 系统配置与登录并行，互不阻塞；任一失败只记录日志，不影响进入首页
  void Promise.allSettled([appStore.loadSystemConfig(), authStore.silentLogin()]).then((results) => {
    results.forEach((result) => {
      if (result.status === 'rejected') {
        console.warn('[App] 启动初始化部分失败：', result.reason);
      }
    });
  });
});

onShow(() => {
  useAppStore().markForeground();
});

onError((error) => {
  // Phase 7 接入 Sentry 上报；当前至少保证不被静默吞掉
  console.error('[App] 未捕获错误：', error);
});

onUnhandledRejection((event) => {
  console.error('[App] 未处理的 Promise 拒绝：', event.reason);
});
</script>

<style lang="scss">
/* 全局样式：仅在根组件引入一次 */
@import '@/styles/global.scss';
</style>
