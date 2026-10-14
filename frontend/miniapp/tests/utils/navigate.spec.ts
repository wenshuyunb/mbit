/**
 * 页面跳转工具测试
 *
 * 守的核心是**"tabBar 页不能用 navigateTo"**这条小程序硬规则 —— 违反它不会报编译错误，
 * 只在运行时抛 `navigateTo:fail can not navigateTo a tabbar page` 并**让跳转静默失效**
 *（用户侧表现为"点了没反应"）。测评结果页的「我的报告」按钮就是这样坏的。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { TAB_BAR_PAGES, goBack, goToPage, isTabBarPage } from '@/utils/navigate';

/** 从 `src/pages.json` 读出真实声明的 tabBar 列表 */
const declaredTabBarPages = (): string[] => {
  const raw = readFileSync(join(process.cwd(), 'src', 'pages.json'), 'utf8');
  const parsed = JSON.parse(raw) as { tabBar?: { list?: { pagePath: string }[] } };

  return (parsed.tabBar?.list ?? []).map((item) => `/${item.pagePath.replace(/^\//, '')}`);
};

/** 模拟小程序全局 `getCurrentPages`（页面栈） */
const setPageStack = (depth: number): void => {
  (globalThis as unknown as { getCurrentPages: () => unknown[] }).getCurrentPages = () =>
    Array.from({ length: depth }, () => ({}));
};

describe('页面跳转工具', () => {
  beforeEach(() => {
    setPageStack(1);
  });

  it('【关键】tabBar 路径清单与 pages.json 完全一致（改 pages.json 时这条必须失败）', () => {
    expect(declaredTabBarPages()).toEqual([...TAB_BAR_PAGES]);
  });

  it('【关键】tabBar 页必须走 switchTab —— 用 navigateTo 会失败且跳不过去', () => {
    goToPage('/pages/report/list');

    expect(uni.switchTab).toHaveBeenCalledWith({ url: '/pages/report/list' });
    expect(uni.navigateTo).not.toHaveBeenCalled();
  });

  it('普通页走 navigateTo（分包页同样）', () => {
    goToPage('/pkgTest/pages/quiz');

    expect(uni.navigateTo).toHaveBeenCalledWith({ url: '/pkgTest/pages/quiz' });
    expect(uni.switchTab).not.toHaveBeenCalled();
  });

  it('tabBar 页带查询串时去掉查询串（switchTab 不接受参数）', () => {
    goToPage('/pages/index/index?from=share');

    expect(uni.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
  });

  it('路径比较容忍前导斜杠差异', () => {
    expect(isTabBarPage('pages/profile/index')).toBe(true);
    expect(isTabBarPage('/pages/profile/index')).toBe(true);
    expect(isTabBarPage('/pkgChat/pages/index')).toBe(false);
  });

  it('空 url 不做任何跳转（避免跳到空白页）', () => {
    goToPage('');

    expect(uni.navigateTo).not.toHaveBeenCalled();
    expect(uni.switchTab).not.toHaveBeenCalled();
  });

  it('有上一页时 goBack 用 navigateBack', () => {
    setPageStack(2);

    goBack();

    expect(uni.navigateBack).toHaveBeenCalledTimes(1);
    expect(uni.switchTab).not.toHaveBeenCalled();
  });

  it('【关键】没有上一页时（分享/扫码直达）goBack 兜底回首页', () => {
    setPageStack(1);

    goBack();

    expect(uni.navigateBack).not.toHaveBeenCalled();
    expect(uni.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
  });
});
