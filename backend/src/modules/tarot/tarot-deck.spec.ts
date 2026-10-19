/**
 * 塔罗牌的内容与抽卡测试
 *
 * ## 这一层必须测的三件事
 *
 *   ① **确定性**：同一个用户同一天永远是同一张牌 ——
 *      这是"今日之牌"这件事的全部意义。测不出来就等于每次刷新都在换；
 *   ② **用户相关性**：种子必须含 `userId`。只用日期的话，同一天所有用户抽到同一张牌 ——
 *      小范围自测完全看不出来，上线后用户一晒就露馅；
 *   ③ **合规**：78 张牌的正逆位文案里都不能出现决策引导、医疗暗示、承诺式预测与占卜词汇。
 */

import { TAROT_DECK, TAROT_MAJOR, TAROT_MINOR } from './tarot-deck';
import { drawDailyCard } from './tarot-draw.util';
import { drawSpread } from './tarot-spread.util';
import { findSpread, TAROT_SPREADS } from './tarot-spreads';
import { TAROT_RANKS, TAROT_SUITS } from './tarot.types';

const USER_A = 'user-0001-aaaa';
const DAY = '2026-10-19';

describe('牌组：78 张齐全且结构正确', () => {
  it('共 78 张（22 大阿卡纳 + 56 小阿卡纳）', () => {
    expect(TAROT_DECK).toHaveLength(78);
    expect(TAROT_MAJOR).toHaveLength(22);
    expect(TAROT_MINOR).toHaveLength(56);
  });

  it('编码唯一（重复会让"抽到第几张"变得不可解释）', () => {
    expect(new Set(TAROT_DECK.map((card) => card.id)).size).toBe(78);
  });

  it('大阿卡纳有罗马数字与符号，小阿卡纳有花色与位阶', () => {
    for (const card of TAROT_MAJOR) {
      expect(card.numeral).not.toBeNull();
      expect(card.symbol.length).toBeGreaterThan(0);
      expect(card.suit).toBeNull();
    }

    for (const card of TAROT_MINOR) {
      expect(card.suit).not.toBeNull();
      expect(card.rank).not.toBeNull();
      expect(TAROT_RANKS).toContain(card.rank);
    }
  });

  it('四种花色 × 十四个位阶都在', () => {
    for (const suit of TAROT_SUITS) {
      expect(TAROT_MINOR.filter((card) => card.suit === suit)).toHaveLength(14);
    }
  });

  it('每张牌的正逆位文案都足够具体（不是一句话敷衍）', () => {
    for (const card of TAROT_DECK) {
      expect(`${card.id}:${card.upright.length > 40}`).toBe(`${card.id}:true`);
      expect(`${card.id}:${card.reversed.length > 40}`).toBe(`${card.id}:true`);
      expect(card.keywords.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('小阿卡纳的正文由「花色领域 × 位阶阶段」组合，彼此不同', () => {
    // 同花色不同位阶的正文必须不同（否则等于 14 张牌共用一段文案）
    for (const suit of TAROT_SUITS) {
      const bodies = TAROT_MINOR.filter((card) => card.suit === suit).map((card) => card.upright);

      expect(new Set(bodies).size).toBe(14);
    }
  });
});

describe('今日抽卡：确定性', () => {
  it('【关键】同一用户同一天连抽 100 次完全一致', () => {
    const first = JSON.stringify(drawDailyCard(TAROT_DECK, USER_A, DAY));

    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(drawDailyCard(TAROT_DECK, USER_A, DAY))).toBe(first);
    }
  });

  it('隔天会换一张（否则用户不会有"今天抽了什么"的感觉）', () => {
    const cards = new Set<string>();

    for (let day = 1; day <= 20; day += 1) {
      const draw = drawDailyCard(TAROT_DECK, USER_A, `2026-11-${String(day).padStart(2, '0')}`);

      cards.add(draw.card.id);
    }

    expect(cards.size).toBeGreaterThan(10);
  });

  it('【关键】不同用户同一天抽到的牌不同（种子必须含 userId）', () => {
    // 只用日期做种子时，这条断言会失败 —— 而小范围自测根本看不出来
    const draws = new Set<string>();

    for (let index = 0; index < 30; index += 1) {
      draws.add(drawDailyCard(TAROT_DECK, `user-${index}`, DAY).card.id);
    }

    expect(draws.size).toBeGreaterThan(15);
  });

  it('朝向只有正位与逆位两种，且文案随之切换', () => {
    const orientations = new Set<string>();

    for (let index = 0; index < 60; index += 1) {
      const draw = drawDailyCard(TAROT_DECK, `user-${index}`, DAY);

      orientations.add(draw.orientation);
      expect(['UPRIGHT', 'REVERSED']).toContain(draw.orientation);
      expect(draw.orientationLabel).toBe(draw.orientation === 'UPRIGHT' ? '正位' : '逆位');
    }

    // 60 次里两种朝向都该出现（逆位概率 1/3，出现一次的概率极高）
    expect(orientations.size).toBe(2);
  });

  it('逆位比例明显低于正位（逆位文案偏"受阻"，太频繁会让每日解读显得灰暗）', () => {
    let reversed = 0;

    for (let index = 0; index < 300; index += 1) {
      if (drawDailyCard(TAROT_DECK, `user-${index}`, DAY).orientation === 'REVERSED') reversed += 1;
    }

    // 期望约 1/3（100 次左右），给足够宽的区间以免偶发抖动误报
    expect(reversed).toBeGreaterThan(60);
    expect(reversed).toBeLessThan(150);
  });

  it('每张牌都有机会被抽到（不会因为取模偏斜而永远抽不到某几张）', () => {
    const seen = new Set<string>();

    for (let index = 0; index < 4000; index += 1) {
      seen.add(drawDailyCard(TAROT_DECK, `u-${index}`, DAY).card.id);
    }

    expect(seen.size).toBe(78);
  });

  it('当日提示非空，且不回显"该不该做"的结论', () => {
    const draw = drawDailyCard(TAROT_DECK, USER_A, DAY);

    expect(draw.advice.length).toBeGreaterThan(10);
    expect(draw.advice).not.toContain('应该辞');
    expect(draw.advice).not.toContain('必须');
  });
});

describe('塔罗文案的合规红线', () => {
  const FORBIDDEN = [
    '投资',
    '买房',
    '签约',
    '辞职',
    '离婚',
    '就医',
    '疾病',
    '症状',
    '诊断',
    '必定',
    '一定会',
    '准确率',
    '保证',
    '算命',
    '风水',
    '转运',
    '消灾',
    '改命',
    '凶兆',
    '不吉',
  ];

  it('全部 78 张 × 正逆位都不出现决策引导 / 医疗 / 承诺 / 占卜词汇', () => {
    const offenders: string[] = [];

    for (const card of TAROT_DECK) {
      for (const [label, text] of [
        ['正位', card.upright],
        ['逆位', card.reversed],
      ] as const) {
        for (const word of FORBIDDEN) {
          if (text.includes(word)) offenders.push(`${card.name}${label}:${word}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('逆位不用"凶""不吉"这类措辞描述（逆位是受阻/内化/过量，不是坏）', () => {
    for (const card of TAROT_DECK) {
      expect(`${card.name}:${card.reversed.includes('凶')}`).toBe(`${card.name}:false`);
      expect(`${card.name}:${card.reversed.includes('不吉')}`).toBe(`${card.name}:false`);
    }
  });
});

describe('牌阵：规则与解读', () => {
  const USER = 'user-0001-aaaa';
  const DATE = '2026-10-19';

  it('五种牌阵齐全，张数与位置数量一致', () => {
    expect(TAROT_SPREADS).toHaveLength(5);

    for (const spread of TAROT_SPREADS) {
      expect(`${spread.id}:${spread.positions.length}`).toBe(`${spread.id}:${spread.cardCount}`);
      expect(spread.intro.length).toBeGreaterThan(40);
      expect(spread.tagline.length).toBeGreaterThan(8);
    }
  });

  it('【关键】同一牌阵内抽到的牌互不重复（一副牌不会出现两张愚者）', () => {
    for (const spread of TAROT_SPREADS) {
      const reading = drawSpread(TAROT_DECK, spread, USER, DATE);
      const ids = reading.draws.map((draw) => draw.card.id);

      expect(new Set(ids).size).toBe(spread.cardCount);
    }
  });

  it('【关键】同一用户同一天同一牌阵，连抽 30 次完全一致', () => {
    const spread = findSpread('THREE_TIME');

    expect(spread).not.toBeNull();

    const first = JSON.stringify(drawSpread(TAROT_DECK, spread as never, USER, DATE));

    for (let index = 0; index < 30; index += 1) {
      expect(JSON.stringify(drawSpread(TAROT_DECK, spread as never, USER, DATE))).toBe(first);
    }
  });

  it('换牌阵就是另一套牌（不是同一套牌的前 N 张）', () => {
    const three = drawSpread(TAROT_DECK, findSpread('THREE_TIME') as never, USER, DATE);
    const choice = drawSpread(TAROT_DECK, findSpread('CHOICE') as never, USER, DATE);

    expect(three.draws.map((draw) => draw.card.id)).not.toEqual(choice.draws.map((draw) => draw.card.id));
  });

  it('不同用户同一天同一牌阵，抽到的牌不同', () => {
    const mine = drawSpread(TAROT_DECK, findSpread('RELATIONSHIP') as never, USER, DATE);
    const other = drawSpread(TAROT_DECK, findSpread('RELATIONSHIP') as never, 'user-9999', DATE);

    expect(mine.draws.map((draw) => draw.card.id)).not.toEqual(other.draws.map((draw) => draw.card.id));
  });

  it('每个位置都有解读，且解读里带位置名与该位置的提问', () => {
    const reading = drawSpread(TAROT_DECK, findSpread('WEEK') as never, USER, DATE);

    for (const draw of reading.draws) {
      expect(draw.reading).toContain(draw.position.label);
      expect(draw.reading).toContain(draw.position.question);
      expect(draw.reading).toContain(draw.card.name);
    }
  });

  it('整体解读四段齐全，且统计与实际牌面一致', () => {
    const reading = drawSpread(TAROT_DECK, findSpread('WEEK') as never, USER, DATE);
    const majors = reading.draws.filter((draw) => draw.card.arcana === 'MAJOR').length;
    const reversed = reading.draws.filter((draw) => draw.orientation === 'REVERSED').length;

    expect(reading.summary.headline.length).toBeGreaterThan(20);
    expect(reading.summary.structure.length).toBeGreaterThan(40);
    expect(reading.summary.narrative.length).toBeGreaterThan(40);
    expect(reading.summary.advice.length).toBeGreaterThan(20);

    expect(reading.summary.stats.majorCount).toBe(majors);
    expect(reading.summary.stats.reversedCount).toBe(reversed);
    expect(reading.summary.stats.total).toBe(7);
  });

  it('整体解读的结论与牌面一致（大阿卡纳多就说"底层模式"，逆位多就说"受阻"）', () => {
    // 用大量牌阵扫一遍，确保结论与数据没有互相矛盾
    for (let day = 1; day <= 28; day += 1) {
      const reading = drawSpread(
        TAROT_DECK,
        findSpread('WEEK') as never,
        USER,
        `2026-11-${String(day).padStart(2, '0')}`,
      );
      const { majorCount, reversedCount, total } = reading.summary.stats;

      if (majorCount / total >= 0.5) {
        expect(reading.summary.headline).toContain('大阿卡纳偏多');
      } else {
        expect(reading.summary.headline).toContain('小阿卡纳偏多');
      }

      if (reversedCount / total >= 0.5) {
        expect(reading.summary.headline).toContain('受阻');
      }
    }
  });

  it('牌阵不存在时返回 null（由服务层给 400，不回退默认牌阵）', () => {
    expect(findSpread('NOT_A_SPREAD')).toBeNull();
  });
});
