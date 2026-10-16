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
