/**
 * 星盘解读页的结构守卫（pkgZodiac/pages/reading.vue）
 *
 * ## 守的是"页面能正常渲染、但产品已经错了"的几条底线
 *
 *   ① **未解锁时绝不渲染章节**：后端在未解锁时 `sections` 为 `null`，
 *      页面必须按 `access.unlocked` 判断，而不是"有 sections 就渲染"——
 *      否则哪天后端改回"返回但打码"，页面会静默变成全部可见；
 *   ② **不做打码式占位**：未解锁时只显示"完整解读共几章、多少字"，
 *      不能把正文截断后照样铺出来（那等于半个免费）；
 *   ③ **邀请解锁的当天失效要如实显示**：`expireAt` 来自服务端，
 *      页面不得自己算"明天再说"，也不得省略；
 *   ④ **合规声明必须原样展示**（服务端下发）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const PAGE = resolve(process.cwd(), 'src/pkgZodiac/pages/reading.vue');
const PAGES_JSON = resolve(process.cwd(), 'src/pages.json');

const source = readFileSync(PAGE, 'utf8');
const pagesJson = readFileSync(PAGES_JSON, 'utf8');

/**
 * 只取模板部分
 *
 * ⚠ 必须用 lastIndexOf：本页用了嵌套 `<template v-if>`，
 * 取第一个 `</template>` 会把模板截断在中间（上一轮在星盘页踩过这个坑）。
 */
const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));

describe('解读页：页面注册与入口', () => {
  it('已在 pkgZodiac 分包里注册', () => {
    expect(pagesJson).toContain('"path": "pages/reading"');
    expect(pagesJson).toContain('"navigationBarTitleText": "星盘解读"');
  });

  it('星座主页有入口指向它', () => {
    const indexPage = readFileSync(resolve(process.cwd(), 'src/pkgZodiac/pages/index.vue'), 'utf8');

    expect(indexPage).toContain('/pkgZodiac/pages/reading');
  });
});

describe('解读页：免费与付费边界', () => {
  it('【关键】完整章节只在 unlocked 为真时渲染', () => {
    expect(source).toContain('access.unlocked === true');
    // 章节循环必须落在这个分支内
    expect(template).toContain('v-for="section in sections"');
    expect(template).toContain('v-if="unlocked"');
  });

  it('【关键】未解锁时只公布规模，不铺正文（不做打码式占位）', () => {
    expect(template).toContain('totalSections');
    expect(template).toContain('totalChars');
    // 不允许"截断正文"这类打码手法出现在模板里
    expect(template).not.toMatch(/slice\(0,\s*\d+\)/);
  });

  it('首段（preview）无条件展示', () => {
    expect(template).toContain('{{ reading.preview }}');
  });

  it('三种解锁入口都在：会员 / 单次购买 / 邀请分享', () => {
    expect(source).toContain('/pkgMember/pages/index');
    expect(source).toContain('open-type="share"');
    expect(source).toContain('buyOnce');
  });

  it('邀请解锁的当天失效时间来自服务端 expireAt，页面不自己编', () => {
    expect(source).toContain('access.expireAt');
    expect(source).toContain("source !== 'INVITE'");
  });

  it('支付未接通时如实告知，而不是给一个点了没反应的按钮', () => {
    expect(source).toContain('showModal');
    expect(source).toContain('商户号');
  });
});

describe('解读页：AI 重写是显式动作', () => {
  it('只有点按钮才调用生成接口（不在 onLoad 里自动触发，避免白烧调用）', () => {
    const onLoadBlock = source.slice(source.indexOf('onLoad('), source.indexOf('onPullDownRefresh('));

    expect(onLoadBlock).not.toContain('generateZodiacReading');
    expect(source).toContain('generateZodiacReading');
  });

  it('生成期间有明确的进行中状态（同步接口要等 10–30 秒）', () => {
    expect(source).toContain('generating');
    expect(source).toContain('正在重写');
  });

  it('如实显示这一版是 AI 还是系统生成', () => {
    expect(source).toContain("reading.source === 'AI'");
  });
});

describe('解读页：合规与文案纪律', () => {
  it('合规声明原样展示', () => {
    expect(template).toContain('{{ reading.disclaimer }}');
  });

  it('页面不得出现 Markdown 标记（`<text>` 会把 `**` 原样显示）', () => {
    // 说明段落里若需要强调，用中文书名号或直接陈述，不用星号
    const displayed = template.replace(/\{\{[\s\S]*?\}\}/g, '');

    expect(displayed).not.toContain('**');
  });

  it('不自造预测性文案（承诺、占卜词汇都不允许）', () => {
    const forbidden = ['必定', '一定会', '准确率', '保证', '算命', '风水', '转运', '消灾', '改命'];

    for (const word of forbidden) {
      expect(`${word}:${source.includes(word)}`).toBe(`${word}:false`);
    }
  });
});
