/**
 * 「写时计算 == 读时推导」等价性测试（ADR-038 步骤 ① 的核心断言）
 *
 * ## 这条不变量为什么必须被测试锁住
 *
 * 整改前：依恋 / 爱的语言 / 冲突处理在**提交那一刻**由 `PersonalityEngine.compute`
 * 算好、写进 `personality_profiles` 的四列，之后所有消费方（匹配、关系报告、AI 人设）
 * 都读那四列。
 *
 * 整改后：四列被删，消费方改用 `deriveRelationshipStyleFromBigFive(画像的大五, 规则)`
 * **在读取时现算**。
 *
 * 于是出现一条**没有编译期保障**的隐含约定：
 *
 *      compute(试卷, 答案).relationshipStyle  ≡  derive(compute(...).bigFive, 规则)
 *
 * 只要它是真的，"改存储为计算"就是无损重构；一旦它被破坏（比如有人给推导路径
 * 换了取值口径、改了 null 兜底、或让 `compute` 与 `derive` 走不同的规则排序），
 * 用户会看到**同一个人的关系风格在不同页面不一样**，而且不会报任何错。
 *
 * 因此这里用**引擎自己做对照物**：引擎的输出是唯一权威（它是历史落库值的来源），
 * 任何推导实现都必须与它逐字段一致 —— 包括 `matchedRuleCode`，
 * 因为"命中了哪条规则"决定了运营调规则时的可解释性。
 *
 * 这条测试还顺手覆盖了推导路径的 `null → 50` 兜底：
 * 引擎在某个维度没有有效作答时就用中位数 50，推导必须用同一个口径。
 */

import { PersonalityEngine } from './personality-engine.service';
import { resolveRelationshipStyle, deriveRelationshipStyleFromBigFive } from './relationship-style.evaluator';
import {
  BIG_FIVE_DIMENSIONS,
  MBTI_DIMENSIONS,
  type BigFiveDimension,
  type EngineAnswer,
  type EngineQuestion,
  type MbtiDimension,
  type RelationshipStyleRule,
} from './personality-engine.types';

const engine = new PersonalityEngine();

/** 造一道 5 点李克特题（与回归锁相同的造法，保证两个 spec 面对同一种输入） */
const likert = (id: string, dimension: string, reverseScored: boolean): EngineQuestion => ({
  id,
  type: 'LIKERT5',
  dimension,
  weight: 1,
  reverseScored,
  minValue: 1,
  maxValue: 5,
  options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
});

/** MBTI 四维 + 大五五维，每维正反向各一 */
const QUESTIONS: EngineQuestion[] = [
  ...MBTI_DIMENSIONS.flatMap((dimension: MbtiDimension) => [
    likert(`q-${dimension}-f`, dimension, false),
    likert(`q-${dimension}-r`, dimension, true),
  ]),
  ...BIG_FIVE_DIMENSIONS.flatMap((dimension: BigFiveDimension) => [
    likert(`q-${dimension}-f`, dimension, false),
    likert(`q-${dimension}-r`, dimension, true),
  ]),
];

/**
 * 答案：正向题给 4/5、反向题给 1/2
 *
 * 刻意**不**全填中位 3 —— 那样各维度百分比恒为 50，会让"推导口径写错"也照样对上。
 * 正反向给不同值（4 与 5、1 与 2）还能覆盖"反向计分后仍偏离中位"的情形。
 */
const ANSWERS: EngineAnswer[] = QUESTIONS.map((question, index) => ({
  questionId: question.id,
  value: question.reverseScored ? 1 + (index % 2) : 4 + (index % 2),
  responseMs: 3000,
}));

/** 只作答一部分题目，用于制造"部分维度没有数据"的场景 */
const partialAnswers = (keep: number): EngineAnswer[] => ANSWERS.slice(0, keep);

/** 一条规则（门槛由调用方给，便于构造命中 / 不命中） */
const rule = (
  code: string,
  priority: number,
  overrides: Partial<RelationshipStyleRule> = {},
): RelationshipStyleRule => ({
  code,
  name: code,
  priority,
  conditions: { all: [{ field: 'openness', op: 'gte', value: 0 }] },
  resultAttachment: 'SECURE',
  resultLoveLanguages: ['QUALITY_TIME'],
  resultConflictStyle: 'COLLABORATING',
  ...overrides,
});

/** 永远不可能命中的条件：阈值超出 0–100 */
const neverMatches = { all: [{ field: 'openness' as const, op: 'gte' as const, value: 999 }] };

describe('deriveRelationshipStyleFromBigFive：与引擎输出等价', () => {
  it.each([
    ['命中一条规则', [rule('HIT', 10)]],
    ['无规则（空数组）', []],
    ['规则全部不命中', [rule('MISS', 10, { conditions: neverMatches })]],
    [
      '多条规则按 priority 竞争',
      [rule('LATE', 90, { resultAttachment: 'AVOIDANT' }), rule('EARLY', 10, { resultAttachment: 'ANXIOUS' })],
    ],
    [
      '同 priority 按 code 字典序',
      [rule('B_SECOND', 50, { resultAttachment: 'FEARFUL' }), rule('A_FIRST', 50, { resultAttachment: 'SECURE' })],
    ],
    [
      '规则结果字段缺失',
      [rule('EMPTY', 10, { resultLoveLanguages: undefined as unknown as string[], resultConflictStyle: null })],
    ],
  ])('%s：逐字段一致（含 matchedRuleCode）', (_label, rules) => {
    const computed = engine.compute({ questions: QUESTIONS, answers: ANSWERS, relationshipRules: rules });
    const derived = deriveRelationshipStyleFromBigFive(computed.bigFive, rules);

    expect(derived).toEqual(computed.relationshipStyle);
  });

  it('维度缺少作答（引擎按中位 50 兜底）时推导口径一致', () => {
    const rules = [rule('NEED_OPENNESS', 10, { conditions: { all: [{ field: 'openness', op: 'gte', value: 50 }] } })];
    const computed = engine.compute({ questions: QUESTIONS, answers: partialAnswers(4), relationshipRules: rules });

    expect(deriveRelationshipStyleFromBigFive(computed.bigFive, rules)).toEqual(computed.relationshipStyle);
  });

  it('大五五列全为 null 时按中位 50 处理，与引擎"无数据"口径一致', () => {
    const rules = [rule('OPENNESS_50', 10, { conditions: { all: [{ field: 'openness', op: 'eq', value: 50 }] } })];

    const derived = deriveRelationshipStyleFromBigFive(
      { openness: null, conscientiousness: null, extraversion: null, agreeableness: null, neuroticism: null },
      rules,
    );

    // 引擎对"无数据维度"取 50，因此 eq 50 应当命中；若推导写成 null → 0 就会落空
    expect(derived.matchedRuleCode).toBe('OPENNESS_50');
  });

  it('真实规则表（seed 的 6 条）下推导与引擎一致', () => {
    const seeded: RelationshipStyleRule[] = [
      {
        code: 'ATTACH_FEARFUL',
        name: '恐惧型依恋',
        priority: 10,
        conditions: { all: [{ field: 'neuroticism', op: 'gte', value: 70 }] },
        resultAttachment: 'FEARFUL',
        resultLoveLanguages: ['WORDS_OF_AFFIRMATION', 'QUALITY_TIME'],
        resultConflictStyle: 'COMPETING',
      },
      {
        code: 'ATTACH_SECURE',
        name: '安全型依恋',
        priority: 40,
        conditions: { all: [{ field: 'neuroticism', op: 'lte', value: 40 }] },
        resultAttachment: 'SECURE',
        resultLoveLanguages: ['QUALITY_TIME', 'ACTS_OF_SERVICE'],
        resultConflictStyle: 'COLLABORATING',
      },
    ];

    const computed = engine.compute({ questions: QUESTIONS, answers: ANSWERS, relationshipRules: seeded });

    expect(deriveRelationshipStyleFromBigFive(computed.bigFive, seeded)).toEqual(computed.relationshipStyle);
  });

  it('返回的爱的语言不与规则对象共享引用', () => {
    const rules = [rule('SHARED', 10, { resultLoveLanguages: ['QUALITY_TIME'] })];

    const first = deriveRelationshipStyleFromBigFive(
      { openness: 60, conscientiousness: 60, extraversion: 60, agreeableness: 60, neuroticism: 60 },
      rules,
    );

    first.loveLanguage.push('PHYSICAL_TOUCH');

    // 规则表是进程内长期共享的对象：结果数组若与它同引用，一次 push 就会把规则改脏，
    // 表现为"后来某个用户的爱的语言莫名多了一项"，且没有任何报错
    expect(rules[0].resultLoveLanguages).toEqual(['QUALITY_TIME']);
    expect(
      deriveRelationshipStyleFromBigFive(
        { openness: 60, conscientiousness: 60, extraversion: 60, agreeableness: 60, neuroticism: 60 },
        rules,
      ).loveLanguage,
    ).toEqual(['QUALITY_TIME']);
  });

  it('默认风格不共享模块级空数组', () => {
    const a = resolveRelationshipStyle(
      { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 },
      [],
    );

    a.loveLanguage.push('PHYSICAL_TOUCH');

    const b = resolveRelationshipStyle(
      { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 },
      [],
    );

    expect(b.loveLanguage).toEqual([]);
  });
});
