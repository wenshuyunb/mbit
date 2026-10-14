/**
 * 页面跳转：自动区分 tabBar 页与普通页
 *
 * ## 为什么需要它
 *
 * 微信小程序里 **tabBar 页面不能用 `uni.navigateTo` 打开** —— 会直接抛
 * `navigateTo:fail can not navigateTo a tabbar page`，而且**页面不会跳转**：
 * 开发者工具里是一条红色报错，用户侧则是"点了没反应"。
 *
 * 本项目已经踩过一次：测评结果页的「我的报告」按钮指向 `pages/report/list`，
 * 而它是 tabBar 页，于是点击直接失败。
 *
 * ## 为什么用常量而不是运行时探测
 *
 * 运行时没有可靠的"这是不是 tabBar 页"的公开 API。两条看起来聪明的路都不行：
 *   · 读 uni-app 内部全局 `__uniConfig` —— 依赖未公开的实现细节；
 *   · 先 `navigateTo` 失败再 `switchTab` —— tabBar 页每次跳转都会在控制台
 *     留下一条 `navigateTo:fail` 报错，正是我们要消除的东西。
 *
 * 因此这里显式列出 tabBar 路径，并用**单测**断言它与 `pages.json` 一致
 *（`tests/utils/navigate.spec.ts`）—— 改 `pages.json` 时测试会失败，
 * 而不是等到线上点不动才发现。
 */

/** tabBar 页面路径（与 `src/pages.json` 的 `tabBar.list` 必须一致） */
export const TAB_BAR_PAGES: readonly string[] = ['/pages/index/index', '/pages/report/list', '/pages/profile/index'];

/** 去掉查询串、统一补前导斜杠，便于比较 */
const normalizePath = (url: string): string => {
  const [path = ''] = url.split('?');

  return `/${path.replace(/^\//, '')}`;
};

/** 该路径是否属于 tabBar 页 */
export const isTabBarPage = (url: string): boolean => TAB_BAR_PAGES.includes(normalizePath(url));

/**
 * 跳转到指定页面
 *
 * tabBar 页走 `switchTab`（该 API 不接受查询参数，也不该给 tabBar 页传参），
 * 其余页面走 `navigateTo` 并保留查询串。
 */
export const goToPage = (url: string): void => {
  if (url === '') return;

  if (isTabBarPage(url)) {
    uni.switchTab({ url: normalizePath(url) });

    return;
  }

  uni.navigateTo({ url });
};

/**
 * 返回上一页；没有上一页时（如从分享卡片直接进入）回首页
 *
 * 自定义导航栏（`navigationStyle: "custom"`）的页面**没有原生返回按钮**，
 * 必须自己画一个 —— 而"直接进入本页所以没有上一页"是真实存在的场景
 *（扫码/分享直达），此时 `navigateBack` 会失败，需要兜底。
 */
export const goBack = (fallbackUrl = '/pages/index/index'): void => {
  const pages = getCurrentPages();

  if (pages.length > 1) {
    uni.navigateBack();

    return;
  }

  goToPage(fallbackUrl);
};
