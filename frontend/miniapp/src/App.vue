<script setup lang="ts">
/**
 * 应用根组件
 *
 * 职责（Phase 0）：
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
