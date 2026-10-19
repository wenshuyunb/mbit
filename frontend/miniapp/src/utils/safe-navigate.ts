/**
 * 页面跳转的健壮封装
 *
 * ## 为什么不能直接写 `uni.navigateTo({ url })`
 *
 * `uni.navigateTo` 不传回调时**返回 Promise**。一旦失败（目标页渲染超时、
 * 快速连点导致重复入栈、分包未就绪），就会变成一个**未处理的 Promise 拒绝** ——
 * 控制台只留下 `[App] 未处理的 Promise 拒绝：{errMsg: "navigateTo:fail timeout"}`，
 * 既看不出是哪一次跳转，也没有任何用户可见反馈。
 *
 * 因此这里统一做三件事：
 *
 *   ① **导航锁**：同一次手势内的重复跳转直接忽略（连点卡片会触发两次 navigateTo，
 *      第二次必然失败，用户看到的是"点了没反应"）；
 *   ② **失败可见**：失败时给一条 toast，并把 `errMsg` 打到控制台，便于定位；
 *   ③ **锁自动释放**：微信的页面跳转没有"完成"回调，因此用短定时器释放锁
 *      （600ms，够覆盖一次正常跳转，又不会在手滑后长时间失效）。
 */

/** 导航锁：是否正在跳转 */
let navigating = false;

/** 释放锁的定时器 */
let unlockTimer: ReturnType<typeof setTimeout> | null = null;

const release = (): void => {
  if (unlockTimer !== null) {
    clearTimeout(unlockTimer);
    unlockTimer = null;
  }

  navigating = false;
};

/**
 * 跳转到新页面（带导航锁与失败提示）
 *
 * @returns 是否真正发起了跳转（被锁拦下时为 false）
 */
export const safeNavigate = (url: string): boolean => {
  if (navigating) return false;

  navigating = true;
  unlockTimer = setTimeout(release, 600);

  uni.navigateTo({
    url,
    fail: (error: { errMsg?: string }) => {
      release();
      console.error(`[nav] 跳转失败 ${url}：${error?.errMsg ?? 'unknown'}`);

      // 超时通常是目标页渲染卡住，让用户重试一次比静默失败好
      uni.showToast({ title: '页面加载超时，请再试一次', icon: 'none' });
    },
    success: release,
  });

  return true;
};

/** 返回上一页（同样带锁，避免连点导致退出多级） */
export const safeNavigateBack = (): boolean => {
  if (navigating) return false;

  navigating = true;
  unlockTimer = setTimeout(release, 600);

  uni.navigateBack({
    delta: 1,
    fail: () => {
      // 没有上一页（例如从分享直接进入）时回首页，而不是卡住
      release();
      safeNavigate('/pages/index/index');
    },
    success: release,
  });

  return true;
};
