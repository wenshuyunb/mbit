/**
 * MBTI 类型百科数据契约测试
 *
 * 与题库数据契约测试同理：百科内容是**前端直接展示的内容**，
 * 若某类型缺字段、维度极性与类型码不一致（例如 `INFJ` 却写 `pole: 'E'`），
 * 用户会看到自相矛盾的画像解释，且这类问题不会在任何代码检查中暴露。
 */

import { MBTI_TYPE_PROFILES } from './mbti-types';

/** 16 个标准类型 */
const ALL_TYPES = [
  'INTJ',
  'INTP',
  'ENTJ',
  'ENTP',
  'INFJ',
  'INFP',
  'ENFJ',
  'ENFP',
  'ISTJ',
  'ISFJ',
  'ESTJ',
  'ESFJ',
  'ISTP',
  'ISFP',
  'ESTP',
  'ESFP',
] as const;

/** 四大分组与配色（前端主题色由此决定，不得随意变动） */
const GROUPS: Record<string, { name: string; color: string; members: string[] }> = {
  ANALYST: { name: '分析家', color: '#88619A', members: ['INTJ', 'INTP', 'ENTJ', 'ENTP'] },
  DIPLOMAT: { name: '外交家', color: '#33A474', members: ['INFJ', 'INFP', 'ENFJ', 'ENFP'] },
  SENTINEL: { name: '守护者', color: '#4298B4', members: ['ISTJ', 'ISFJ', 'ESTJ', 'ESFJ'] },
  EXPLORER: { name: '探险家', color: '#E4AE3A', members: ['ISTP', 'ISFP', 'ESTP', 'ESFP'] },
};

/** 维度位置 → 该位置字母对应的中文标签 */
const POLE_LABELS: Record<string, string> = {
  E: '外向',
  I: '内向',
  S: '实感',
  N: '直觉',
  T: '思考',
  F: '情感',
  J: '判断',
  P: '知觉',
};

const DIMENSION_ORDER = ['EI', 'SN', 'TF', 'JP'] as const;

describe('MBTI 类型百科数据契约', () => {
  it('恰好覆盖 16 个标准类型，无重复无遗漏', () => {
    const types = MBTI_TYPE_PROFILES.map((profile) => profile.type);

    expect(MBTI_TYPE_PROFILES).toHaveLength(16);
    expect(new Set(types).size).toBe(16);
    expect([...types].sort()).toEqual([...ALL_TYPES].sort());
  });

  it.each(Object.entries(GROUPS))('分组 %s 的成员与配色正确', (group, expected) => {
    const members = MBTI_TYPE_PROFILES.filter((profile) => profile.group === group);

    expect(members.map((profile) => profile.type).sort()).toEqual([...expected.members].sort());

    for (const profile of members) {
      expect(profile.groupName).toBe(expected.name);
      expect(profile.groupColor).toBe(expected.color);
    }
  });

  it('所有 typeName / typeNameEn / tagline 非空', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      expect(profile.typeName.length).toBeGreaterThan(0);
      expect(profile.typeNameEn.length).toBeGreaterThan(0);
      expect(profile.tagline.length).toBeGreaterThanOrEqual(10);
    }
  });

  it('类型描述长度在 80–140 个字符之间', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      expect(profile.description.length).toBeGreaterThanOrEqual(80);
      expect(profile.description.length).toBeLessThanOrEqual(140);
    }
  });

  it('【关键】维度画像的顺序固定为 EI → SN → TF → JP', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      expect(profile.dimensionProfile.map((item) => item.dimension)).toEqual([...DIMENSION_ORDER]);
    }
  });

  it('【关键】维度极性与类型码逐位一致（防止出现 INFJ 却标 E 的矛盾）', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      const letters = profile.type.split('');

      profile.dimensionProfile.forEach((item, index) => {
        expect(item.pole).toBe(letters[index]);
        expect(item.label).toBe(POLE_LABELS[letters[index]]);
      });
    }
  });

  it('维度倾向百分比在 55–85 之间（超出范围会让强度条显得失真）', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      for (const item of profile.dimensionProfile) {
        expect(Number.isInteger(item.percent)).toBe(true);
        expect(item.percent).toBeGreaterThanOrEqual(55);
        expect(item.percent).toBeLessThanOrEqual(85);
      }
    }
  });

  it('每类型恰好 4 条优势、3 条盲点、3 条关系建议', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      expect(profile.strengths).toHaveLength(4);
      expect(profile.blindSpots).toHaveLength(3);
      expect(profile.relationshipTips).toHaveLength(3);
    }
  });

  it('所有条目的标题与说明非空且长度合理', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      const items = [...profile.strengths, ...profile.blindSpots, ...profile.relationshipTips];

      for (const item of items) {
        expect(item.title.length).toBeGreaterThanOrEqual(2);
        expect(item.title.length).toBeLessThanOrEqual(12);
        expect(item.description.length).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('画像摘要的 headline 与关键词齐全', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      expect(profile.summary.headline.length).toBeGreaterThanOrEqual(8);
      expect(profile.summary.strengths).toHaveLength(3);
      expect(profile.summary.watchouts).toHaveLength(3);
    }
  });

  it('类型之间描述不重复', () => {
    const descriptions = MBTI_TYPE_PROFILES.map((profile) => profile.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('关键词之间不重复（同一类型内的 strengths 与 watchouts 不得重叠）', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      const keywords = [...profile.summary.strengths, ...profile.summary.watchouts];
      expect(new Set(keywords).size).toBe(keywords.length);
    }
  });

  it('【合规底线】不出现医疗、诊断与夸大科学性的表述', () => {
    const forbidden = [
      '诊断',
      '症状',
      '疾病',
      '障碍',
      '治疗',
      '患者',
      '临床',
      '心理疾病',
      'MBTI 官方',
      '科学证明',
      '心理学证明',
    ];

    for (const profile of MBTI_TYPE_PROFILES) {
      const text = [
        profile.description,
        profile.tagline,
        ...profile.strengths.map((item) => `${item.title}${item.description}`),
        ...profile.blindSpots.map((item) => `${item.title}${item.description}`),
        ...profile.relationshipTips.map((item) => `${item.title}${item.description}`),
      ].join('');

      for (const word of forbidden) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('【合规底线】不使用绝对化断言（改用倾向性表述）', () => {
    const forbidden = ['一定会', '永远无法', '必然', '注定'];

    for (const profile of MBTI_TYPE_PROFILES) {
      const text = [...profile.blindSpots, ...profile.relationshipTips].map((item) => item.description).join('');

      for (const word of forbidden) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('盲点数量少于优势数量（避免把类型描述成「问题集合」）', () => {
    for (const profile of MBTI_TYPE_PROFILES) {
      expect(profile.blindSpots.length).toBeLessThan(profile.strengths.length);
    }
  });
});
