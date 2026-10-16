/**
 * 星盘计算的结构与自洽测试
 *
 * ## 这一层测的不是"天文算得对不对"
 *
 * 天文层的正确性已经在 `zodiac-astro.util.spec.ts` 里用**外部事实**（节气、
 * 行星换座、朔望月、地平线物理反验）钉住了。这一层测的是**组装逻辑**：
 * 宫位与星座是否自洽、缺出生时间时是否真的不出四轴、统计是否守恒。
 *
 * ## 两条最容易悄悄错的规则
 *
 *   ① **整宫制宫位必须与上升星座自洽**：第 1 宫 = 上升星座，某行星的宫位 =
 *      `(行星星座序号 − 上升星座序号 + 12) % 12 + 1`。写反了页面上照样显示
 *      1–12 的数字，看不出问题；
 *   ② **缺出生时间必须不出上升点与宫位**。如果哪天有人"顺手"给个默认时间，
 *      用户会拿到一个看起来正常、实际对大多数人是错的上升星座 —— 这里把它钉死。
 */

import {
  buildNatalChart,
  CHART_LOCKED_SECTIONS,
  CHART_MEMBERSHIP_HINT,
  CHART_NO_PLACE_NOTICE,
  CHART_NO_TIME_NOTICE,
  CHART_PRECISION_NOTE,
  PLANET_META,
  resolveSignPosition,
} from './zodiac-chart.util';
import { signIndexOf } from './zodiac-astro.util';
import { ZODIAC_SIGNS } from './zodiac.types';

/** 样例：1988-07-15 14:30 出生在北京（**落在 1988 年夏令时窗口内**，应算 +9 时区） */
const BEIJING_1988 = {
  birthday: '1988-07-15',
  birthTime: '14:30',
  birthPlace: '北京',
  birthLatitude: 39.9042,
  birthLongitude: 116.4074,
} as const;

describe('buildNatalChart：结构与自洽', () => {
  const chart = buildNatalChart(BEIJING_1988);

  it('十大行星 + 上升点 + 天顶都在盘上', () => {
    expect(chart.positions).toHaveLength(10);
    expect(chart.positions.map((position) => position.key)).toEqual(PLANET_META.map((meta) => meta.key));
    expect(chart.angles.ascendant).not.toBeNull();
    expect(chart.angles.midheaven).not.toBeNull();
  });

  it('每个天体的黄经都在 0–360，且星座归属与黄经一致', () => {
    for (const position of chart.positions) {
      expect(position.longitude).toBeGreaterThanOrEqual(0);
      expect(position.longitude).toBeLessThan(360);
      expect(position.sign).toBe(ZODIAC_SIGNS[signIndexOf(position.longitude)]);
    }
  });

  it('十二宫按整宫制：宫头是连续的十二个星座，第 1 宫就是上升星座', () => {
    const houses = chart.houses;
    expect(houses).not.toBeNull();
    expect(houses!).toHaveLength(12);

    const ascendantSign = chart.angles.ascendant!.sign;
    expect(houses![0].sign).toBe(ascendantSign);

    for (let index = 0; index < 12; index += 1) {
      const expectedSign = ZODIAC_SIGNS[(signIndexOf(houses![0].cusp) + index) % 12];
      expect(houses![index].index).toBe(index + 1);
      expect(houses![index].sign).toBe(expectedSign);
    }
  });

  it('【关键】行星宫位与上升星座自洽（写反了看不出来）', () => {
    const ascendantSignIndex = signIndexOf(chart.angles.ascendant!.longitude);

    for (const position of chart.positions) {
      const expected = ((signIndexOf(position.longitude) - ascendantSignIndex + 12) % 12) + 1;

      expect(position.house).toBe(expected);
    }
  });

  it('上升点在第 1 宫，且上升点与天顶的宫位关系合理（天顶不会落在第 1 宫）', () => {
    expect(chart.angles.ascendant!.house).toBe(1);
    expect(chart.angles.midheaven!.house).not.toBe(1);
  });

  it('元素分布与宫位类型分布各自守恒（合计 = 十大行星 10 个）', () => {
    expect(chart.elementDistribution.reduce((sum, entry) => sum + entry.count, 0)).toBe(10);
    expect(chart.modeDistribution.reduce((sum, entry) => sum + entry.count, 0)).toBe(10);

    // 百分比四舍五入后允许 ±2 的误差
    expect(
      Math.abs(chart.elementDistribution.reduce((sum, entry) => sum + entry.percent, 0) - 100),
    ).toBeLessThanOrEqual(2);
    expect(Math.abs(chart.modeDistribution.reduce((sum, entry) => sum + entry.percent, 0) - 100)).toBeLessThanOrEqual(
      2,
    );
  });

  it('主导元素一定是数量最多的那个', () => {
    const max = Math.max(...chart.elementDistribution.map((entry) => entry.count));

    expect(chart.dominantElement).not.toBeNull();
    expect(chart.dominantElement!.count).toBe(max);
  });

  it('缺失元素列表与数量为 0 的元素一致', () => {
    const zero = chart.elementDistribution.filter((entry) => entry.count === 0).map((entry) => entry.key);

    expect(chart.missingElements).toEqual(zero);
  });

  it('星群只在同星座行星数 ≥ 3 时出现，且成员确实都在该星座', () => {
    for (const stellium of chart.stelliums) {
      expect(stellium.bodies.length).toBeGreaterThanOrEqual(3);
      expect(chart.positions.filter((position) => position.sign === stellium.sign)).toHaveLength(
        stellium.bodies.length,
      );
    }
  });

  it('命主星 = 上升星座的守护星，且落点与盘上该行星一致', () => {
    const ascendantSign = chart.angles.ascendant!.sign;
    const ruler = chart.chartRuler;

    expect(ruler).not.toBeNull();

    const matched = chart.positions.find((position) => position.name === ruler!.planetName);
    expect(matched).toBeDefined();
    expect(ruler!.position).toBe(matched!.position);
    // 守护星表来自星座档案，白羊的守护星是火星
    if (ascendantSign === 'ARIES') expect(ruler!.planetName).toBe('火星');
  });

  it('相位里不会出现"自己与自己"，且都带天体中文名', () => {
    for (const aspect of chart.aspects) {
      expect(aspect.from).not.toBe(aspect.to);
      expect(aspect.fromName.length).toBeGreaterThan(0);
      expect(aspect.toName.length).toBeGreaterThan(0);
      expect(aspect.orb).toBeLessThanOrEqual(8);
    }
  });

  it('出生时间与地点的回显与输入一致（含时区推断标记）', () => {
    expect(chart.moment.localDateTime).toBe('1988-07-15 14:30');
    expect(chart.moment.place).toBe('北京');
    expect(chart.moment.latitude).toBeCloseTo(39.9042, 4);
    expect(chart.moment.longitude).toBeCloseTo(116.4074, 4);
    expect(chart.houseSystem).toBe('WHOLE_SIGN');
    expect(chart.precisionNote.length).toBeGreaterThan(50);
    expect(chart.hasBirthPlace).toBe(true);
    expect(chart.noPlaceNotice).toBeNull();
  });

  it('【关键】1988 年夏天出生按夏令时 +9 处理（否则上升点会整体错一个星座）', () => {
    expect(chart.moment.timezoneOffset).toBe(9);
    expect(chart.moment.timezoneInferred).toBe(true);

    // 世界时应比当地时间早 9 小时：14:30 当地 = 05:30 UTC
    expect(chart.moment.utcDateTime).toBe('1988-07-15 05:30');
  });

  it('算出的是**上升点**而不是下降点（白羊/天秤这类成对的星座要能区分）', () => {
    // 上升点与同盘天顶的黄经距离（劣弧）应在 60–120°，若取到下降点会变成 180 附近
    const ascendant = chart.angles.ascendant!.longitude;
    const midheaven = chart.angles.midheaven!.longitude;
    const arc = Math.abs(((midheaven - ascendant + 540) % 360) - 180);

    expect(arc).toBeGreaterThan(60);
    expect(arc).toBeLessThan(120);
  });
});

describe('buildNatalChart：缺出生城市时的降级（不能拿某个城市去猜）', () => {
  const chart = buildNatalChart({ birthday: '1988-07-15', birthTime: '14:30' });

  it('【关键】有出生时间但没出生城市 → 仍然不出上升点与十二宫', () => {
    expect(chart.hasBirthTime).toBe(true);
    expect(chart.hasBirthPlace).toBe(false);
    expect(chart.angles.ascendant).toBeNull();
    expect(chart.angles.midheaven).toBeNull();
    expect(chart.houses).toBeNull();
  });

  it('提示语解释了"为什么必须要出生城市"（东西部地方时差 4 小时以上）', () => {
    expect(chart.noPlaceNotice).not.toBeNull();
    expect(chart.noPlaceNotice!).toContain('出生城市');
    // 有出生时间时不该再提示"缺时间"，避免两条提示互相矛盾
    expect(chart.noTimeNotice).toBeNull();
  });

  it('经纬度缺失时不回显任何坐标（不能用默认值假装知道）', () => {
    expect(chart.moment.latitude).toBeNull();
    expect(chart.moment.longitude).toBeNull();
  });

  it('行星部分照常给出，且太阳不会被误标为不可靠', () => {
    const sun = chart.positions.find((position) => position.key === 'SUN')!;
    const moon = chart.positions.find((position) => position.key === 'MOON')!;

    expect(chart.positions).toHaveLength(10);
    expect(sun.uncertain).toBe(false);
    // 有出生时间 → 月亮的时刻是准的，不受"缺城市"影响（月亮只需要时间，不需要地点）
    expect(moon.uncertain).toBe(false);
  });

  it('命主星仍然为空（命主星由上升星座决定）', () => {
    expect(chart.chartRuler).toBeNull();
  });

  it('同时缺时间与缺城市时两条提示都给（各自说明缺什么）', () => {
    const missingBoth = buildNatalChart({ birthday: '1988-07-15' });

    expect(missingBoth.noTimeNotice).not.toBeNull();
    expect(missingBoth.noPlaceNotice).not.toBeNull();
  });
});

describe('buildNatalChart：缺出生时间时的降级（宁可少给，不给错）', () => {
  const chart = buildNatalChart({ birthday: '1988-07-15' });

  it('【关键】不出上升点与天顶', () => {
    expect(chart.hasBirthTime).toBe(false);
    expect(chart.angles.ascendant).toBeNull();
    expect(chart.angles.midheaven).toBeNull();
  });

  it('【关键】不出十二宫，行星也都不带宫位', () => {
    expect(chart.houses).toBeNull();
    expect(chart.positions.every((position) => position.house === null)).toBe(true);
  });

  it('没有命主星（命主星由上升星座决定）', () => {
    expect(chart.chartRuler).toBeNull();
  });

  it('月亮被标记为位置不可靠（日行 11.8–15.4°，按中午算可能偏出小半个星座）', () => {
    const moon = chart.positions.find((position) => position.key === 'MOON')!;

    expect(moon.uncertain).toBe(true);
    expect(chart.positions.filter((position) => position.uncertain)).toHaveLength(1);
  });

  it('给出"缺时间"提示，且提示里说明了补时间能解锁什么', () => {
    expect(chart.noTimeNotice).not.toBeNull();
    expect(chart.noTimeNotice!).toContain('上升星座');
  });

  it('行星部分照常给出（太阳系行星不依赖出生时间，只依赖日期）', () => {
    expect(chart.positions).toHaveLength(10);
    expect(chart.positions.every((position) => position.position.length > 0)).toBe(true);
  });

  it('有出生时间时 noTimeNotice 必须为 null（不能既算又提示）', () => {
    expect(buildNatalChart(BEIJING_1988).noTimeNotice).toBeNull();
  });
});

describe('buildNatalChart：确定性与敏感性', () => {
  it('同一输入连算 20 次结果完全一致', () => {
    const first = JSON.stringify(buildNatalChart(BEIJING_1988));

    for (let index = 0; index < 20; index += 1) {
      expect(JSON.stringify(buildNatalChart(BEIJING_1988))).toBe(first);
    }
  });

  it('出生时间差 2 小时 → 上升点几乎必然变化（上升星座约 2 小时换一个）', () => {
    const earlier = buildNatalChart({ ...BEIJING_1988, birthTime: '08:00' });
    const later = buildNatalChart({ ...BEIJING_1988, birthTime: '20:00' });

    expect(earlier.angles.ascendant!.longitude).not.toBe(later.angles.ascendant!.longitude);
  });

  it('出生地经度变化会影响上升点（经度通过恒星时生效）', () => {
    const beijing = buildNatalChart(BEIJING_1988);
    const urumqi = buildNatalChart({
      ...BEIJING_1988,
      birthPlace: '乌鲁木齐',
      birthLongitude: 87.6168,
      birthLatitude: 43.8256,
    });

    expect(beijing.angles.ascendant!.longitude).not.toBe(urumqi.angles.ascendant!.longitude);
  });

  it('同一天不同时间 → 月亮位置不同（月亮是变化最快的天体）', () => {
    const morning = buildNatalChart({ ...BEIJING_1988, birthTime: '00:00' });
    const evening = buildNatalChart({ ...BEIJING_1988, birthTime: '23:59' });
    const moonMorning = morning.positions.find((position) => position.key === 'MOON')!;
    const moonEvening = evening.positions.find((position) => position.key === 'MOON')!;

    expect(moonMorning.longitude).not.toBe(moonEvening.longitude);
    // 不到一天，月亮最多走 15.4°
    const delta = Math.abs(((moonEvening.longitude - moonMorning.longitude + 540) % 360) - 180);
    expect(delta).toBeLessThan(16);
  });

  it('显式给出时区偏移时优先使用（海外出生）', () => {
    const tokyo = buildNatalChart({
      ...BEIJING_1988,
      birthTimezoneOffset: 9,
      birthLongitude: 139.6917,
      birthLatitude: 35.6895,
    });

    expect(tokyo.moment.timezoneOffset).toBe(9);
    expect(tokyo.moment.timezoneInferred).toBe(false);
  });

  it('非夏令时年份按 +8 处理', () => {
    expect(buildNatalChart({ birthday: '1995-07-15', birthTime: '14:30' }).moment.timezoneOffset).toBe(8);
  });

  it('出生日期格式不合法时抛出可读错误', () => {
    expect(() => buildNatalChart({ birthday: '1988/07/15' })).toThrow(RangeError);
    expect(() => buildNatalChart({ birthday: '1988-07-15', birthTime: '25:00' })).toThrow(RangeError);
  });
});

describe('星盘文案的合规与可读性（与 zodiac-content.spec.ts 同一套红线）', () => {
  /** 所有会被用户直接读到的星盘文案 */
  const USER_FACING: ReadonlyArray<readonly [string, string]> = [
    ['精度说明', CHART_PRECISION_NOTE],
    ['缺时间提示', CHART_NO_TIME_NOTICE],
    ['缺城市提示', CHART_NO_PLACE_NOTICE],
    ['会员解锁说明', CHART_MEMBERSHIP_HINT],
    ...CHART_LOCKED_SECTIONS.map((line, index) => [`会员权益第 ${index + 1} 条`, line] as const),
  ];

  it('没有一篇是空文案或占位符（漏了就等于页面上少一段关键说明）', () => {
    for (const [label, text] of USER_FACING) {
      // 阈值取 8：权益清单里有「上升星座与天顶的精确度数」这类短句，是完整的表述
      expect(`${label}:${text.trim().length >= 8}`).toBe(`${label}:true`);
      expect(`${label}:${/TODO|待补|xxx|占位/.test(text)}`).toBe(`${label}:false`);
    }
  });

  it('【关键】不得出现 Markdown 标记（`<text>` 会把 `**` 原样显示出来）', () => {
    for (const [label, text] of USER_FACING) {
      expect(`${label}:${/\*\*|^#|\[.*\]\(.*\)/.test(text)}`).toBe(`${label}:false`);
    }
  });

  it('不做决策引导（不出现投资/签约/就医/辞职这类会左右真实决策的词）', () => {
    const decisionWords = ['投资', '签约', '就医', '辞职', '离婚', '买房', '手术'];

    for (const [label, text] of USER_FACING) {
      for (const word of decisionWords) {
        expect(`${label}:${word}:${text.includes(word)}`).toBe(`${label}:${word}:false`);
      }
    }
  });

  it('不做承诺式预测（不出现"必定/一定会/准确率/精准预测"）', () => {
    const promiseWords = ['必定', '一定会', '准确率', '精准预测', '保证'];

    for (const [label, text] of USER_FACING) {
      for (const word of promiseWords) {
        expect(`${label}:${word}:${text.includes(word)}`).toBe(`${label}:${word}:false`);
      }
    }
  });

  it('不用占卜词汇（算命/风水/转运/消灾/改命）', () => {
    const divinationWords = ['算命', '风水', '转运', '消灾', '改命', '化解霉运'];

    for (const [label, text] of USER_FACING) {
      for (const word of divinationWords) {
        expect(`${label}:${word}:${text.includes(word)}`).toBe(`${label}:${word}:false`);
      }
    }
  });

  it('精度说明如实交代了能力边界（宫位制式、误差来源、不宣称专业星历级）', () => {
    // 少任何一条，用户都可能把这份盘当成专业星历结果
    expect(CHART_PRECISION_NOTE).toContain('整宫制');
    expect(CHART_PRECISION_NOTE).toContain('0.1°');
    expect(CHART_PRECISION_NOTE).toContain('章动');
    expect(CHART_PRECISION_NOTE).toContain('不作为');
  });

  it('缺城市提示说清楚了"为什么必须要城市"（不是含糊地让用户填）', () => {
    expect(CHART_NO_PLACE_NOTICE).toContain('经度');
    expect(CHART_NO_PLACE_NOTICE).toContain('上升');
  });
});

describe('resolveSignPosition：度分展示', () => {
  it('狮子 22.15° → 狮子座 22°09′', () => {
    const resolved = resolveSignPosition(4 * 30 + 22.15);

    expect(resolved.sign).toBe('LEO');
    expect(resolved.degree).toBe(22);
    expect(resolved.minute).toBe(9);
    expect(resolved.position).toBe('狮子座 22°09′');
  });

  it('29°59.7′ 不会进位成 30°00′（展示上会越到下一个星座）', () => {
    const resolved = resolveSignPosition(29.9999);

    expect(resolved.sign).toBe('ARIES');
    expect(resolved.degree).toBe(29);
    expect(resolved.minute).toBe(59);
  });

  it('恰好 30° 属于下一个星座的 0°', () => {
    const resolved = resolveSignPosition(30);

    expect(resolved.sign).toBe('TAURUS');
    expect(resolved.degree).toBe(0);
    expect(resolved.minute).toBe(0);
  });

  it('359.9° 仍属双鱼座而不是越界', () => {
    const resolved = resolveSignPosition(359.9);

    expect(resolved.sign).toBe('PISCES');
    expect(resolved.degree).toBe(29);
  });

  it('负角度与超过 360° 都能被归一化', () => {
    expect(resolveSignPosition(-10).sign).toBe('PISCES');
    expect(resolveSignPosition(370).sign).toBe('ARIES');
  });
});
