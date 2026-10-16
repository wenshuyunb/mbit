/**
 * 聊天页滚动结构守卫（pkgChat）
 *
 * ## 为什么给 CSS 写测试
 *
 * 用户的实测反馈是「AI 能回答，但对话框没有办法拖动，就像卡死了一样」。
 * 根因**不在交互逻辑里**，而是两行样式：消息列表是竖向 `scroll-view`，
 * 而它只有 `flex: 1` —— flex 项的自动最小尺寸是内容高度（`min-height: auto`），
 * 消息一多就撑到跟内容一样高，内部没有可滚区域；而该页在 `pages.json` 里
 * 是 `disableScroll: true`（页面级滚动关闭）→ **两边都不能滚**，手指怎么拉都不动。
 *
 * 这类缺陷的特殊之处是：
 *   · 类型检查、单测、构建、甚至页面能正常渲染 —— **全都发现不了**；
 *   · 只有在"消息足够长"的那一刻才出现，短消息下完全正常；
 *   · 修复方式是一行 `min-height: 0`，而被后来者"顺手清理"掉也不会报错。
 *
 * 因此这里直接对**结构**下断言：读文件、抽出 `.chat__body` 的声明块，
 * 要求它同时具备「可收缩（min-height: 0）」与「高度由 flex 决定（height: 0）」。
 * 这是少数值得用文本断言盯住的样式规则。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ⚠ 这里用 `process.cwd()` 而不是 `import.meta.url`：
 * vitest 在本项目里跑的是 jsdom 环境，`import.meta.url` 不是 `file:` 协议，
 * `fileURLToPath` 会直接抛 "The URL must be of scheme file"。
 * vitest 的 cwd 是前端工程根目录，因此下面的相对路径是稳定的。
 */
const CHAT_PAGE = resolve(process.cwd(), 'src/pkgChat/pages/index.vue');
const PAGES_JSON = resolve(process.cwd(), 'src/pages.json');

const source = readFileSync(CHAT_PAGE, 'utf8');
const pagesJson = readFileSync(PAGES_JSON, 'utf8');

/** 抽出 `&__body { … }` 的声明块（到第一个 `}` 为止；该块没有嵌套规则） */
const bodyBlockOf = (text: string): string => {
  const start = text.indexOf('&__body {');
  if (start < 0) return '';

  const end = text.indexOf('}', start);

  return end < 0 ? '' : text.slice(start, end);
};

describe('聊天页的滚动结构（pkgChat/pages/index.vue）', () => {
  it('消息列表确实是竖向 scroll-view', () => {
    expect(source).toContain('<scroll-view');
    expect(source).toContain('scroll-y');
  });

  it('【关键】scroll-view 有确定高度：`height: 0` + `min-height: 0` 都必须有', () => {
    const block = bodyBlockOf(source);

    expect(block).not.toBe('');
    // `min-height: 0`：允许收缩到比内容更小，否则内部没有可滚区域
    expect(block).toMatch(/min-height:\s*0\s*;/);
    // `height: 0`：让高度完全由 flex 分配决定（只写 min-height 在部分机型上仍被内容撑开）
    expect(block).toMatch(/height:\s*0\s*;/);
    // 仍然要靠 flex 撑满剩余空间
    expect(block).toMatch(/flex:\s*1\s*;/);
  });

  it('【关键】这一页禁用了页面级滚动，因此容器必须裁掉溢出', () => {
    // pages.json 里 chat 页是 disableScroll: true —— 页面滚不动是**设计**（输入框固定在底部）
    expect(pagesJson).toMatch(/"path":\s*"pages\/index"[\s\S]{0,200}?"disableScroll":\s*true/);

    // 既然页面滚不动，根容器就必须 overflow: hidden，否则内容一多就顶出视口且看不到下半截
    const rootBlock = source.slice(source.indexOf('.chat {'), source.indexOf('&__quota {'));
    expect(rootBlock).toMatch(/overflow:\s*hidden\s*;/);
    // 根容器必须有确定高度，否则 flex 分配无从谈起
    expect(rootBlock).toMatch(/height:\s*100vh\s*;/);
  });

  it('自动滚到底用的是有效 id（微信要求 id 不能以数字开头）', () => {
    const ids = [...source.matchAll(/id="`?([a-zA-Z][\w-]*)\$\{/g)].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(0);
    for (const prefix of ids) {
      expect(prefix).toMatch(/^[a-zA-Z]/);
    }
  });
});
