/**
 * 场景题库的**覆盖率**约束（ADR-039）
 *
 * ## 为什么必须有这组断言
 *
 * 量表题是"一题一个维度"：52 道题里每个维度都有 4 题，覆盖是**结构上**保证的。
 * 场景题不是：一题两三个维度、一个选择只贡献一次数据，于是
 *
 *   · 某个维度可能**一个选项都没命中** → 它的分数恒为占位的 50，
 *     而引擎不会报错（`usable = false` 只是不出结论，报告里表现为"这项没有数据"）；
 *   · 某个维度只被**一个场景**命中 → 用户在那道题上的一次选择就决定了整条轴，
 *     分数会随一道题的措辞剧烈摆动。
 *
 * 两种都不会让任何测试变红、也不会在页面上报错，只会在报告里悄悄变差。
 * 因此把"每个维度至少被 4 个选项、3 个不同场景命中"写成断言 ——
 * 题库是可以由运营在后台改的，这条约束必须能自动复核。
 */

import type { SeedDimension, SeedScenarioQuestion } from '../types';
import { ALL_EMOTION_SCENARIOS, EMOTION_SCENARIO_SETS, PENDING_AUDIENCES } from './questions.emotion-scenarios';

/** 情感模块的 12 个计分维度（三个族） */
const EMOTION_DIMENSIONS: SeedDimension[] = [
  'ATTACH_ANXIETY',
  'ATTACH_AVOIDANCE',
  'LOVE_WORDS',
  'LOVE_TIME',
  'LOVE_GIFTS',
  'LOVE_SERVICE',
  'LOVE_TOUCH',
  'CONFLICT_COLLABORATING',
  'CONFLICT_COMPROMISING',
  'CONFLICT_ACCOMMODATING',
  'CONFLICT_AVOIDING',
  'CONFLICT_COMPETING',
];

/** 每个维度至少被多少个**选项**命中 */
const MIN_OPTION_HITS = 4;

/** 每个维度至少出现在多少个**不同场景**里 */
const MIN_SCENARIOS = 3;

/** 统计某一套题里每个维度的覆盖情况 */
const coverageOf = (
  questions: readonly SeedScenarioQuestion[],
): Map<SeedDimension, { optionHits: number; scenarios: Set<string> }> => {
  const coverage = new Map<SeedDimension, { optionHits: number; scenarios: Set<string> }>();

  for (const question of questions) {
    for (const option of question.options) {
      for (const [dimension, score] of Object.entries(option.scores)) {
        if (score === undefined) continue;

        const entry = coverage.get(dimension as SeedDimension) ?? { optionHits: 0, scenarios: new Set<string>() };
        entry.optionHits += 1;
        entry.scenarios.add(question.code);
        coverage.set(dimension as SeedDimension, entry);
      }
    }
  }

  return coverage;
};

describe('场景题库的结构约束', () => {
  it('已交付的每一套都是 24 个场景（题量决定数据密度，少一个维度就少一份数据）', () => {
    for (const [audience, questions] of Object.entries(EMOTION_SCENARIO_SETS)) {
      expect(`${audience}:${questions?.length}`).toBe(`${audience}:24`);
    }
  });

  it('题目编码全局唯一（跨套也不能撞：编码是 upsert 的键）', () => {
    const codes = ALL_EMOTION_SCENARIOS.map((question) => question.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('每个场景都有 3 个做法、都有提问句、叙述足够具体', () => {
    for (const question of ALL_EMOTION_SCENARIOS) {
      expect(`${question.code} options=${question.options.length}`).toBe(`${question.code} options=3`);
      expect(question.prompt.length).toBeGreaterThan(0);
      // 叙述太短就不成其为"处境"，用户会退回成做选择题
      expect({
        code: question.code,
        longEnough: question.content.length >= 25,
      }).toEqual({ code: question.code, longEnough: true });
    }
  });

  it('【关键】同一场景内所有选项的维度键**完全一致**', () => {
    /**
     * 两个原因都很硬（见题库文件头）：
     *   ① `resolveScale` 只在"全部选项都带该维度"时才用选项分值推导量程，
     *      部分覆盖会退回默认量程 `0–1`，而分值可能是 4 → `clamp` 后直接顶满分；
     *   ② 引擎按**所选选项**里出现的维度累加，键集合不一致会让不同的人
     *      拿到不同维度的数据，画像之间无法比较。
     */
    for (const question of ALL_EMOTION_SCENARIOS) {
      const keySets = question.options.map((option) => Object.keys(option.scores).sort().join(','));

      expect({ code: question.code, uniform: new Set(keySets).size === 1, keySets }).toEqual({
        code: question.code,
        uniform: true,
        keySets,
      });
    }
  });

  it('每个做法都带维度分与即时反馈，且分值在 0–5', () => {
    for (const question of ALL_EMOTION_SCENARIOS) {
      for (const option of question.options) {
        expect(Object.keys(option.scores).length).toBeGreaterThan(0);
        expect(option.feedback.length).toBeGreaterThanOrEqual(8);

        for (const score of Object.values(option.scores)) {
          expect(typeof score).toBe('number');
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it('同一场景内，每个维度至少有一个选项与其它选项**取值不同**（否则该维度零信息）', () => {
    for (const question of ALL_EMOTION_SCENARIOS) {
      const byDimension = new Map<string, Set<number>>();

      for (const option of question.options) {
        for (const [dimension, score] of Object.entries(option.scores)) {
          const values = byDimension.get(dimension) ?? new Set<number>();
          if (score !== undefined) values.add(score);
          byDimension.set(dimension, values);
        }
      }

      for (const [dimension, values] of byDimension) {
        expect(`${question.code} ${dimension} distinct=${values.size > 1}`).toBe(
          `${question.code} ${dimension} distinct=true`,
        );
      }
    }
  });
});

describe.each(Object.entries(EMOTION_SCENARIO_SETS))('场景题库覆盖率：%s', (audience, questions) => {
  const coverage = coverageOf(questions ?? []);

  it.each(EMOTION_DIMENSIONS)('【关键】%s 至少被 %i 个选项命中', (dimension) => {
    const entry = coverage.get(dimension);

    expect({
      dimension,
      optionHits: entry?.optionHits ?? 0,
      enough: (entry?.optionHits ?? 0) >= MIN_OPTION_HITS,
    }).toEqual({ dimension, optionHits: entry?.optionHits ?? 0, enough: true });
  });

  it.each(EMOTION_DIMENSIONS)('【关键】%s 至少出现在 %i 个不同场景里', (dimension) => {
    const scenarios = coverage.get(dimension)?.scenarios.size ?? 0;

    expect({ dimension, scenarios, enough: scenarios >= MIN_SCENARIOS }).toEqual({
      dimension,
      scenarios,
      enough: true,
    });
  });

  it(`${audience} 套的题目 audience 字段与所属集合一致（seed 按它分套抽题）`, () => {
    for (const question of questions ?? []) {
      expect(question.audience).toBe(audience);
    }
  });
});

describe('交付进度（未交付的套数会被显式记录，而不是静默跳过）', () => {
  it('已交付的套数 + 待交付的套数 = 3', () => {
    const delivered = Object.keys(EMOTION_SCENARIO_SETS).length;

    expect(delivered + PENDING_AUDIENCES.length).toBe(3);
  });
});
