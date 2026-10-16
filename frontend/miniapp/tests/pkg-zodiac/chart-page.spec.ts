/**
 * 星盘页结构守卫（pkgZodiac/pages/chart.vue）
 *
 * ## 这里守的是三条"页面能正常渲染、但产品已经错了"的底线
 *
 *   ① **非会员绝不能看到完整盘**：页面只渲染 `preview`（三个星座名），
 *      而且不得为了"占位好看"去伪造一个空壳盘。权限泄漏不会崩、不会报错，
 *      只会在某天被人截图发出来；
 *   ② **缺出生时间/城市时不能编一个**：这两条来自用户实测踩过的同类陷阱
 *      （"默认中午"会给大多数用户一个错的上升星座）。页面必须把服务端的
 *      `noTimeNotice` / `noPlaceNotice` 原样展示，并且不显示任何上升星座的值；
 *   ③ **服务端文案不得被前端改写**：`precisionNote` 与 `disclaimer` 必须原样输出 ——
 *      前者是精度声明，后者是合规声明，改一个字性质就变了。
 *
 * 与 `tests/pkg-chat/chat-scroll.spec.ts` 同样的理由：这些约束靠"读代码"来守，
 * 类型检查与构建都发现不了。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CHART_PAGE = resolve(process.cwd(), 'src/pkgZodiac/pages/chart.vue');
const PAGES_JSON = resolve(process.cwd(), 'src/pages.json');

const source = readFileSync(CHART_PAGE, 'utf8');
const pagesJson = readFileSync(PAGES_JSON, 'utf8');

/**
 * 只取模板部分：样式与脚本里的 `=` 不该被下面的规则误伤
 *
 * ⚠ 必须用 **lastIndexOf**：本页用了嵌套 `<template v-else-if>`，
 * 取第一个 `</template>` 会把模板截断在中间 —— 第一版就是这样，
 * 结果「事件绑定不得用内联语句」这条守卫**检查不到页面下半部分**，
 * 而真正的 bug（`@tap="cityPanelOpen = false"`）恰好就在下半部分。
 * 一条检查不全的守卫比没有守卫更危险：它会让人以为已经守住了。
 */
const templateOnly = (): string => source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));
const template = templateOnly();

/** 抽出 `&__xxx { … }` 的声明块（到第一个 `}` 为止；这些块里没有嵌套规则） */
const styleBlockOf = (selector: string): string => {
  const start = source.indexOf(selector);
  if (start < 0) return '';

  const end = source.indexOf('}', start);

  return source.slice(start, end);
};

describe('星盘页：用户实测踩过的两个坑（都必须有守卫）', () => {
  /**
   * 【坑一】`@tap="cityPanelOpen = false"` 这种**内联语句**会被微信编译器
   * 编译成一个"方法名"，实测生成的是名为 `false` 的方法，运行时控制台报：
   * `does not have a method "false" to handle event "tap"`。
   * 页面看起来正常，只有点下去才报错 —— 类型检查、构建、单测全都发现不了。
   */
  it('事件绑定必须是具名方法或方法调用，不能写内联语句', () => {
    const handlers = [...templateOnly().matchAll(/@[a-z]+(?:\.[a-z]+)*="([^"]+)"/g)].map((match) => match[1]);
    expect(handlers.length).toBeGreaterThan(5);

    for (const handler of handlers) {
      // 允许：methodName / methodName(arg) / methodName(a.b) / 传入 $event 的调用
      expect(`${handler} -> ${/^[A-Za-z_$][\w$]*(\([^)]*\))?$/.test(handler)}`).toBe(`${handler} -> true`);
    }
  });

  /**
   * 【坑二】面板里的城市列表是竖向 `scroll-view`，它需要**确定的可用高度**。
   * 第一版面板只写了 `max-height: 70vh`（高度由内容决定），列表自身是
   * `height: 0; flex: 1` → flex 没有可分配空间 → 列表高度 0，
   * 用户看到的只有标题和输入框，其余一片空白（实测反馈为"白屏"）。
   *
   * 规则：面板必须自己把高度定下来（有 `height:`），列表用 `flex: 1` + `min-height: 0`。
   */
  it('城市面板自身必须是确定高度，否则列表高度为 0（就是白屏）', () => {
    const panel = styleBlockOf('&__panel {');

    expect(panel).toMatch(/(^|[^-a-z])height:/);
    expect(panel).not.toMatch(/^\s*max-height:/m);
  });

  it('城市列表用 flex 分配高度，且带 min-height: 0（否则会被内容撑开）', () => {
    const list = styleBlockOf('&__panel-list {');

    expect(list).toContain('flex: 1');
    expect(list).toContain('min-height: 0');
    // 不该再出现独立的 `height: 0`（那是聊天页的写法，依赖父级有确定高度链）
    expect(list).not.toMatch(/(^|[^-a-z])height:\s*0/);
  });

  it('面板有明确的关闭入口（不能只靠点遮罩，那个入口刚刚才修好）', () => {
    expect(source).toContain('closeCityPanel');
    expect(template).toContain('@tap="closeCityPanel"');
  });

  it('模板切片确实覆盖到页面下半部分（防止守卫本身被截断而失效）', () => {
    // 城市面板在模板最后，如果切片方式退化成 `indexOf`，这里会失败
    expect(template).toContain('chart__panel-list');
    expect(template).toContain('chart__disclaimer-text');
  });

  it('任何分支下都有可见内容（不留白屏）', () => {
    // 分支顺序：loading → loadError → needsBirthday → 既无 chart 也无 preview 的兜底 → data
    expect(template).toContain('v-if="loading"');
    expect(template).toContain('v-else-if="loadError"');
    expect(template).toContain('v-else-if="needsBirthday"');
    expect(template).toContain('v-else-if="!chart && !preview"');
    expect(template).toContain('v-else-if="data"');
  });
});

describe('星盘页：页面注册', () => {
  it('已在 pkgZodiac 分包里注册（否则 navigateTo 会静默失败）', () => {
    expect(pagesJson).toContain('"path": "pages/chart"');
    expect(pagesJson).toContain('"navigationBarTitleText": "我的本命星盘"');
  });

  it('从星座主页有入口指向它', () => {
    const indexPage = readFileSync(resolve(process.cwd(), 'src/pkgZodiac/pages/index.vue'), 'utf8');

    expect(indexPage).toContain('/pkgZodiac/pages/chart');
  });
});

describe('星盘页：会员边界', () => {
  it('只渲染 chart 与 preview，且不伪造空壳盘', () => {
    expect(source).toContain('data.value?.chart ?? null');
    expect(source).toContain('data.value?.preview ?? null');

    // 不允许出现"造一个默认 chart 对象"这类兜底
    expect(source).not.toMatch(/chart\s*=\s*ref<[^>]*>\(\s*\{/);
  });

  it('非会员时展示服务端下发的解锁清单，而不是把内容糊掉', () => {
    expect(source).toContain('access.lockedSections');
    expect(source).toContain('access.membershipHint');
  });

  it('完整盘的所有区块都在 `v-if="chart"` 之内（否则非会员会看到空区块）', () => {
    // 行星表 / 十二宫 / 相位 / 元素分布 都必须依赖 chart
    expect(source).toContain('v-for="item in chart.positions"');
    expect(source).toContain('v-if="chart.houses"');
    expect(source).toContain('v-for="(aspect, index) in chart.aspects"');
    expect(source).toContain('v-for="entry in chart.elementDistribution"');
  });
});

describe('星盘页：缺信息时不猜', () => {
  it('上升星座只在两种情况下显示：有完整盘、或服务端预览里有值', () => {
    expect(source).toContain("'待补全'");
    // 不允许出现任何"默认中午""默认北京"式的兜底文案或常量
    expect(source).not.toContain('默认中午');
    expect(source).not.toContain('116.4');
    expect(source).not.toContain('39.9');
  });

  it('把服务端的缺信息提示原样展示（noTimeNotice / noPlaceNotice）', () => {
    expect(source).toContain('noTimeNotice');
    expect(source).toContain('noPlaceNotice');
  });

  it('补齐出生信息走统一的用户资料接口，且城市四个字段一起提交', () => {
    expect(source).toContain("http.patch('/users/me'");

    for (const field of ['birthPlace', 'birthLatitude', 'birthLongitude', 'birthTimezoneOffset']) {
      expect(source).toContain(field);
    }
  });

  it('出生时间用系统时间选择器（不手输，手输一定会有人写成 3 点半）', () => {
    expect(source).toContain('mode="time"');
    expect(source).not.toMatch(/placeholder="[^"]*(出生时间|时间)[^"]*"/);
  });

  it('没设生日时本页直接给日期选择器（不要让用户跳回上一页再找回来）', () => {
    expect(source).toContain('mode="date"');
    expect(source).toContain('saveBirthday');
  });
});

describe('星盘页：服务端文案与合规声明', () => {
  it('精度说明与合规声明原样输出（不得改写、不得省略）', () => {
    expect(source).toContain('{{ chart.precisionNote }}');
    expect(source).toContain('{{ data.disclaimer }}');
  });

  it('页面上不出现预测性/占卜性的自造文案', () => {
    const forbidden = ['算命', '风水', '转运', '消灾', '改命', '准确率', '必定'];

    for (const word of forbidden) {
      expect(source).not.toContain(word);
    }
  });

  it('不出现 Markdown 标记（`<text>` 会把 `**` 原样显示成星号）', () => {
    // 模板里凡是要显示的文字都不能带 `**`
    const templateOnly = source.slice(source.indexOf('<template>'), source.indexOf('</template>'));

    expect(templateOnly).not.toContain('**');
  });
});
