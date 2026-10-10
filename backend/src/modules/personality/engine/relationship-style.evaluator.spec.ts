/**
 * 关系风格规则求值器测试
 *
 * 单独测试的价值：规则求值器是**运营可配置**的部分（后台改动规则表即生效），
 * 因此必须把「配置写错时会怎样」测清楚 —— 错误配置不能静默变成「命中所有人」。
 */

import {
  DEFAULT_RELATIONSHIP_STYLE,
  evaluateConditions,
  evaluatePredicate,
  resolveRelationshipStyle,
} from './relationship-style.evaluator';
import type { BigFiveResult, RelationshipStyleRule } from './personality-engine.types';

const bigFive = (overrides: Partial<BigFiveResult> = {}): BigFiveResult => ({
  openness: 50,
  conscientiousness: 50,
  extraversion: 50,
  agreeableness: 50,
  neuroticism: 50,
  ...overrides,
});

const rule = (overrides: Partial<RelationshipStyleRule> = {}): RelationshipStyleRule => ({
  code: 'R1',
  name: '规则 1',
  priority: 100,
  conditions: { all: [{ field: 'openness', op: 'gte', value: 50 }] },
  resultAttachment: 'SECURE',
  resultLoveLanguages: [],
  resultConflictStyle: null,
  ...overrides,
});

describe('evaluatePredicate', () => {
  const fields = { openness: 80, neuroticism: 20 };

  it.each([
    ['gte', 80, true],
    ['gte', 81, false],
    ['gt', 79, true],
    ['gt', 80, false],
    ['lte', 80, true],
    ['lte', 79, false],
    ['lt', 81, true],
    ['lt', 80, false],
    ['eq', 80, true],
    ['eq', 79, false],
  ] as const)('%s %i → %s', (op, value, expected) => {
    expect(evaluatePredicate({ field: 'openness', op, value }, fields)).toBe(expected);
  });

  it('between 为闭区间', () => {
    expect(evaluatePredicate({ field: 'openness', op: 'between', range: [80, 90] }, fields)).toBe(true);
    expect(evaluatePredicate({ field: 'openness', op: 'between', range: [70, 80] }, fields)).toBe(true);
    expect(evaluatePredicate({ field: 'openness', op: 'between', range: [81, 90] }, fields)).toBe(false);
  });

  it('between 区间写反时自动纠正（不因配置失误导致规则失效）', () => {
    expect(evaluatePredicate({ field: 'openness', op: 'between', range: [90, 80] }, fields)).toBe(true);
  });

  it('between 缺少 range 或长度不为 2 → 不满足', () => {
    expect(evaluatePredicate({ field: 'openness', op: 'between' }, fields)).toBe(false);
    expect(
      evaluatePredicate({ field: 'openness', op: 'between', range: [80] as unknown as [number, number] }, fields),
    ).toBe(false);
  });

  it('gte/lt 等缺少 value → 不满足', () => {
    expect(evaluatePredicate({ field: 'openness', op: 'gte' }, fields)).toBe(false);
  });

  it('维度名大小写不敏感', () => {
    expect(evaluatePredicate({ field: 'OPENNESS', op: 'gte', value: 80 }, fields)).toBe(true);
    expect(evaluatePredicate({ field: '  Openness  ', op: 'gte', value: 80 }, fields)).toBe(true);
  });

  it('【fail-closed】未知维度视为不满足（错别字不会静默命中）', () => {
    expect(evaluatePredicate({ field: 'extravertion', op: 'gte', value: 0 }, fields)).toBe(false);
  });

  it('字段值为非有限数 → 不满足', () => {
    expect(evaluatePredicate({ field: 'openness', op: 'gte', value: 0 }, { openness: Number.NaN })).toBe(false);
    expect(evaluatePredicate({ field: 'openness', op: 'gte', value: 0 }, { openness: Number.POSITIVE_INFINITY })).toBe(
      false,
    );
  });

  it('未知操作符 → 不满足（不抛异常）', () => {
    expect(evaluatePredicate({ field: 'openness', op: 'regex' as unknown as 'gte', value: 50 }, fields)).toBe(false);
  });
});

describe('evaluateConditions', () => {
  const fields = { openness: 80, extraversion: 20 };

  it('all 全部满足才成立', () => {
    expect(
      evaluateConditions(
        {
          all: [
            { field: 'openness', op: 'gte', value: 80 },
            { field: 'extraversion', op: 'lte', value: 20 },
          ],
        },
        fields,
      ),
    ).toBe(true);

    expect(
      evaluateConditions(
        {
          all: [
            { field: 'openness', op: 'gte', value: 80 },
            { field: 'extraversion', op: 'gte', value: 50 },
          ],
        },
        fields,
      ),
    ).toBe(false);
  });

  it('any 任一满足即成立', () => {
    expect(
      evaluateConditions(
        {
          any: [
            { field: 'openness', op: 'gte', value: 200 },
            { field: 'extraversion', op: 'lte', value: 20 },
          ],
        },
        fields,
      ),
    ).toBe(true);

    expect(
      evaluateConditions(
        {
          any: [
            { field: 'openness', op: 'gte', value: 200 },
            { field: 'extraversion', op: 'gte', value: 200 },
          ],
        },
        fields,
      ),
    ).toBe(false);
  });

  it('all 与 any 同时存在时二者都要满足', () => {
    expect(
      evaluateConditions(
        {
          all: [{ field: 'openness', op: 'gte', value: 80 }],
          any: [{ field: 'extraversion', op: 'lte', value: 20 }],
        },
        fields,
      ),
    ).toBe(true);

    expect(
      evaluateConditions(
        {
          all: [{ field: 'openness', op: 'gte', value: 80 }],
          any: [{ field: 'extraversion', op: 'gte', value: 90 }],
        },
        fields,
      ),
    ).toBe(false);
  });

  it('【配置防护】空条件不匹配任何用户（否则一条空规则会命中所有人）', () => {
    expect(evaluateConditions({}, fields)).toBe(false);
    expect(evaluateConditions({ all: [], any: [] }, fields)).toBe(false);
    expect(evaluateConditions(null, fields)).toBe(false);
    expect(evaluateConditions(undefined, fields)).toBe(false);
  });
});

describe('resolveRelationshipStyle', () => {
  it('无规则时返回默认风格', () => {
    expect(resolveRelationshipStyle(bigFive())).toEqual(DEFAULT_RELATIONSHIP_STYLE);
    expect(resolveRelationshipStyle(bigFive(), [])).toEqual(DEFAULT_RELATIONSHIP_STYLE);
  });

  it('命中规则时返回其结果集', () => {
    const result = resolveRelationshipStyle(bigFive({ neuroticism: 90 }), [
      rule({ resultAttachment: 'ANXIOUS', resultLoveLanguages: ['WORDS'], resultConflictStyle: 'AVOIDING' }),
    ]);

    expect(result.attachment).toBe('ANXIOUS');
    expect(result.loveLanguage).toEqual(['WORDS']);
    expect(result.conflictStyle).toBe('AVOIDING');
    expect(result.matchedRuleCode).toBe('R1');
  });

  it('按 priority 升序匹配，首个命中即采用', () => {
    const result = resolveRelationshipStyle(bigFive(), [
      rule({ code: 'LATE', priority: 200, resultAttachment: 'SECURE' }),
      rule({ code: 'EARLY', priority: 1, resultAttachment: 'FEARFUL' }),
    ]);

    expect(result.matchedRuleCode).toBe('EARLY');
    expect(result.attachment).toBe('FEARFUL');
  });

  it('同 priority 时按 code 字典序，保证结果稳定可复现', () => {
    const result = resolveRelationshipStyle(bigFive(), [
      rule({ code: 'ZEBRA', priority: 10, resultAttachment: 'SECURE' }),
      rule({ code: 'ALPHA', priority: 10, resultAttachment: 'AVOIDANT' }),
    ]);

    expect(result.matchedRuleCode).toBe('ALPHA');
  });

  it('高优先级规则条件不满足时会继续尝试后续规则', () => {
    const result = resolveRelationshipStyle(bigFive({ neuroticism: 10 }), [
      rule({
        code: 'NEEDS_HIGH_N',
        priority: 1,
        conditions: { all: [{ field: 'neuroticism', op: 'gte', value: 90 }] },
        resultAttachment: 'FEARFUL',
      }),
      rule({
        code: 'FALLBACK',
        priority: 50,
        conditions: { all: [{ field: 'neuroticism', op: 'lte', value: 50 }] },
        resultAttachment: 'SECURE',
      }),
    ]);

    expect(result.matchedRuleCode).toBe('FALLBACK');
  });

  it('无任何规则命中时返回默认风格', () => {
    const result = resolveRelationshipStyle(bigFive(), [
      rule({ conditions: { all: [{ field: 'neuroticism', op: 'gte', value: 999 }] } }),
    ]);

    expect(result).toEqual(DEFAULT_RELATIONSHIP_STYLE);
  });

  it('规则结果为缺失字段时给出安全的默认值', () => {
    const result = resolveRelationshipStyle(bigFive(), [
      rule({
        resultLoveLanguages: undefined as unknown as string[],
        resultConflictStyle: null,
      }),
    ]);

    expect(result.loveLanguage).toEqual([]);
    expect(result.conflictStyle).toBeNull();
  });

  it('不修改传入的规则数组（纯函数无副作用）', () => {
    const rules = [rule({ code: 'B', priority: 2 }), rule({ code: 'A', priority: 1 })];
    const snapshot = rules.map((item) => item.code);

    resolveRelationshipStyle(bigFive(), rules);

    expect(rules.map((item) => item.code)).toEqual(snapshot);
  });

  it('相同输入多次求值结果一致', () => {
    const rules = [rule({ code: 'X', priority: 5 }), rule({ code: 'Y', priority: 5 })];
    const first = resolveRelationshipStyle(bigFive({ openness: 70 }), rules);
    const second = resolveRelationshipStyle(bigFive({ openness: 70 }), rules);

    expect(second).toEqual(first);
  });
});
