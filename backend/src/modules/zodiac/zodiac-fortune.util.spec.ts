/**
 * 运势生成的**确定性**与结构测试
 *
 * ## 这一层最核心的主张只有一条：**同一天同星座，永远是同一份内容**
 *
 * 用户拍板"确定性生成"的理由之一是体验：下拉刷新一次内容就变，那更像随机数，
 * 不像"运势"。因此这里把"确定性"当作硬约束来测：
 *   · 同一输入连算 100 次必须完全一致；
 *   · 换一天必须换一份（否则页面看起来永远没更新）；
 *   · 同一天换星座必须不同（否则十二个星座共用一份内容）。
 *
 * 另外两条结构性约束：
 *   · 周运按**周一**做种子（同一周内任何一天看都是同一份）；
 *   · 配对**顺序无关**（`match(a,b) === match(b,a)`）——否则"你和 TA"与"TA 和你"
 *     会得到两个分数，这是必错的。
 */

import { buildDailyFortune, buildMonthlyFortune, buildWeeklyFortune, buildZodiacMatch } from './zodiac-fortune.util';
import { ZODIAC_SIGNS } from './zodiac.types';

describe('buildDailyFortune（今日运势）', () => {
  it('【关键】同一日期 + 同一星座，连算 100 次结果完全一致', () => {
    const first = JSON.stringify(buildDailyFortune('PISCES', '2026-10-16'));

    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(buildDailyFortune('PISCES', '2026-10-16'))).toBe(first);
    }
  });

  it('【关键】换一天就换一份（否则用户会觉得页面没更新）', () => {
    const today = JSON.stringify(buildDailyFortune('PISCES', '2026-10-16'));
    const tomorrow = JSON.stringify(buildDailyFortune('PISCES', '2026-10-17'));

    expect(tomorrow).not.toBe(today);
  });

  it('【关键】同一天不同星座内容不同（十二个星座不能共用一份）', () => {
    const seen = new Set(ZODIAC_SIGNS.map((sign) => JSON.stringify(buildDailyFortune(sign, '2026-10-16'))));

    expect(seen.size).toBe(ZODIAC_SIGNS.length);
  });

  it('结构齐备：五维 + 幸运元素 + 速配 + 宜忌 + 箴言', () => {
    const fortune = buildDailyFortune('ARIES', '2026-10-16');

    expect(fortune.sign).toBe('ARIES');
    expect(fortune.signName).toBe('白羊座');
    expect(fortune.date).toBe('2026-10-16');
    expect(fortune.tone.length).toBeGreaterThan(10);

    expect(fortune.dimensions).toHaveLength(5);
    for (const dimension of fortune.dimensions) {
      expect(dimension.stars).toBeGreaterThanOrEqual(1);
      expect(dimension.stars).toBeLessThanOrEqual(5);
      expect(dimension.line.length).toBeGreaterThan(8);
      expect(dimension.label.length).toBeGreaterThan(0);
    }

    expect(fortune.lucky.color.hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(fortune.lucky.number).toBeGreaterThanOrEqual(1);
    expect(fortune.lucky.number).toBeLessThanOrEqual(9);
    expect(fortune.lucky.direction.length).toBeGreaterThan(0);
    expect(fortune.lucky.hour.length).toBeGreaterThan(0);

    // 速配与留意必须是**两个不同的、且不是自己的**星座
    expect(fortune.match.best.sign).not.toBe('ARIES');
    expect(fortune.match.watch.sign).not.toBe('ARIES');
    expect(fortune.match.best.sign).not.toBe(fortune.match.watch.sign);

    expect(fortune.good).toHaveLength(3);
    expect(fortune.avoid).toHaveLength(2);
    expect(new Set(fortune.good).size).toBe(3);
    expect(fortune.quote.length).toBeGreaterThan(8);
  });

  it('星级分布不是"天天爆棚"也不是"全都低分"（一年 365 天的统计）', () => {
    const counts = new Map<number, number>();

    for (let day = 0; day < 365; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
      const fortune = buildDailyFortune('LEO', date);

      for (const dimension of fortune.dimensions) {
        counts.set(dimension.stars, (counts.get(dimension.stars) ?? 0) + 1);
      }
    }

    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);

    // 五档都出现过
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    // 三星占多数，两端（1 星与 5 星）合计不超过三成
    expect((counts.get(3) ?? 0) / total).toBeGreaterThan(0.25);
    expect(((counts.get(1) ?? 0) + (counts.get(5) ?? 0)) / total).toBeLessThan(0.3);
  });

  it('一年里每天的速配星座会轮换（不会永远指向同一个星座）', () => {
    const best = new Set<string>();

    for (let day = 0; day < 60; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
      best.add(buildDailyFortune('TAURUS', date).match.best.sign);
    }

    expect(best.size).toBeGreaterThan(3);
  });
});

describe('buildWeeklyFortune（周运）', () => {
  it('【关键】同一周内任何一天查看都是同一份（种子取该周周一）', () => {
    // 2026-10-12 是周一，10-18 是周日
    const monday = buildWeeklyFortune('VIRGO', '2026-10-12');
    const wednesday = buildWeeklyFortune('VIRGO', '2026-10-14');
    const sunday = buildWeeklyFortune('VIRGO', '2026-10-18');

    expect(wednesday).toEqual(monday);
    expect(sunday).toEqual(monday);
    expect(monday.startDate).toBe('2026-10-12');
    expect(monday.endDate).toBe('2026-10-18');
  });

  it('跨周会换一份', () => {
    const thisWeek = buildWeeklyFortune('VIRGO', '2026-10-14');
    const nextWeek = buildWeeklyFortune('VIRGO', '2026-10-21');

    expect(nextWeek.startDate).toBe('2026-10-19');
    expect(JSON.stringify(nextWeek)).not.toBe(JSON.stringify(thisWeek));
  });

  it('三个方向齐备且各带星级与解读', () => {
    const weekly = buildWeeklyFortune('GEMINI', '2026-10-16');

    expect(weekly.sections.map((item) => item.key)).toEqual(['CAREER', 'LOVE', 'SELF']);
    for (const section of weekly.sections) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.line.length).toBeGreaterThan(8);
      expect(section.stars).toBeGreaterThanOrEqual(1);
      expect(section.stars).toBeLessThanOrEqual(5);
    }
    expect(weekly.tip.length).toBeGreaterThan(8);
  });

  it('周日查看也归入**同一个**周（ISO 口径：周一为一周开始）', () => {
    // 2026-10-18 是周日 → 应归入 10-12 那一周，而不是 10-19 那一周
    expect(buildWeeklyFortune('LIBRA', '2026-10-18').startDate).toBe('2026-10-12');
  });
});

describe('buildMonthlyFortune（月运）', () => {
  it('同一个月内任何一天查看都是同一份', () => {
    expect(buildMonthlyFortune('CANCER', '2026-10-01')).toEqual(buildMonthlyFortune('CANCER', '2026-10-31'));
  });

  it('上旬/中旬/下旬齐备，带主题词与整体星级', () => {
    const monthly = buildMonthlyFortune('CANCER', '2026-10-16');

    expect(monthly.month).toBe('2026-10');
    expect(monthly.theme.length).toBeGreaterThan(2);
    expect(monthly.stars).toBeGreaterThanOrEqual(1);
    expect(monthly.stars).toBeLessThanOrEqual(5);
    expect(monthly.sections.map((item) => item.key)).toEqual(['EARLY', 'MIDDLE', 'LATE']);
  });
});

describe('buildZodiacMatch（星座配对）', () => {
  /**
   * ⚠ 这条断言第一版写成"两个方向的返回值完全相等"，判红了 —— 而实现是对的：
   * `a` / `b` 是**回显入参顺序**的（"你和 TA"本来就该按你传的顺序显示），
   * 顺序无关的是**内容**（分数、维度、建议）。把整对象相比会把"回显顺序"也算进去，
   * 那是把正确行为判成错误。
   */
  it('【关键】顺序无关：分数与解读完全一致，a/b 只回显入参顺序', () => {
    const forward = buildZodiacMatch('PISCES', 'VIRGO');
    const backward = buildZodiacMatch('VIRGO', 'PISCES');

    // 内容必须逐字段相同
    expect({
      score: backward.score,
      level: backward.level,
      levelLabel: backward.levelLabel,
      elementNote: backward.elementNote,
      dimensions: backward.dimensions,
      advice: backward.advice,
    }).toEqual({
      score: forward.score,
      level: forward.level,
      levelLabel: forward.levelLabel,
      elementNote: forward.elementNote,
      dimensions: forward.dimensions,
      advice: forward.advice,
    });

    // 而 a / b 各自回显入参
    expect(forward.a.sign).toBe('PISCES');
    expect(backward.a.sign).toBe('VIRGO');
  });

  it('同一对星座连算多次结果一致', () => {
    const first = JSON.stringify(buildZodiacMatch('ARIES', 'LIBRA'));

    for (let index = 0; index < 20; index += 1) {
      expect(JSON.stringify(buildZodiacMatch('ARIES', 'LIBRA'))).toBe(first);
    }
  });

  it('结构与取值区间正确', () => {
    const match = buildZodiacMatch('LEO', 'AQUARIUS');

    expect(match.a.sign).toBe('LEO');
    expect(match.b.sign).toBe('AQUARIUS');
    expect(match.score).toBeGreaterThanOrEqual(30);
    expect(match.score).toBeLessThanOrEqual(96);
    expect(['LOW', 'MID', 'HIGH']).toContain(match.level);
    expect(match.levelLabel.length).toBeGreaterThan(0);
    expect(match.elementNote.length).toBeGreaterThan(8);
    expect(match.advice.length).toBeGreaterThan(10);

    expect(match.dimensions.map((item) => item.key)).toEqual(['COMMUNICATION', 'SPARK', 'LONGTERM']);
    for (const dimension of match.dimensions) {
      expect(dimension.stars).toBeGreaterThanOrEqual(1);
      expect(dimension.stars).toBeLessThanOrEqual(5);
      expect(dimension.line.length).toBeGreaterThan(8);
    }
  });

  it('【关键】同元素组合的分数高于冲突组合（结论与常识一致，不是纯随机）', () => {
    // 火象 × 火象（白羊 × 狮子）vs 风象 × 水象（双子 × 巨蟹）
    const harmonious = buildZodiacMatch('ARIES', 'LEO').score;
    const conflicting = buildZodiacMatch('GEMINI', 'CANCER').score;

    expect(harmonious).toBeGreaterThan(conflicting);
  });

  it('同元素组合的档位不会是"差异明显"', () => {
    for (const [a, b] of [
      ['ARIES', 'SAGITTARIUS'],
      ['TAURUS', 'CAPRICORN'],
      ['GEMINI', 'LIBRA'],
      ['CANCER', 'PISCES'],
    ] as const) {
      expect(buildZodiacMatch(a, b).level).not.toBe('LOW');
    }
  });

  it('自己和自己配对也能给出结果（用户会点着玩）', () => {
    const same = buildZodiacMatch('SCORPIO', 'SCORPIO');

    expect(same.score).toBeGreaterThanOrEqual(30);
    expect(same.dimensions).toHaveLength(3);
  });
});
