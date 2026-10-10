/**
 * 关系报告上下文构建器测试
 *
 * 一条铁律 + 一个高风险点：
 *   · 所有变量**无条件存在**（不可用时填占位文案）。少一个就是运行时的
 *     `50012 缺少必需变量`，而那时用户的一次生成请求已经消耗掉了。
 *   · **视角映射**：报告是给当前用户看的，而算分输入是 A（邀请方）/ B（接受方）。
 *     若 `my*` 变量填了 A 的数据，那么当 B 阅读时，报告会把对方说成"你"。
 */

import {
  buildRelationshipReportContext,
  counterpartLabelOf,
  type RelationshipReportContextInput,
  type RelationshipReportSide,
  type RelationshipReportScores,
} from './relationship-report-context.builder';
import { UNAVAILABLE_PLACEHOLDER } from './report-context.builder';

/** 造一侧数据，`mbtiType` 为 null 时视为该侧数据全缺 */
const side = (mbtiType: string | null, overrides: Partial<RelationshipReportSide> = {}): RelationshipReportSide => {
  const missing = mbtiType === null;

  return {
    mbtiType,
    eiPercent: missing ? null : 72,
    snPercent: missing ? null : 68,
    tfPercent: missing ? null : 61,
    jpPercent: missing ? null : 78,
    openness: missing ? null : 84,
    conscientiousness: missing ? null : 67,
    extraversion: missing ? null : 32,
    agreeableness: missing ? null : 72,
    neuroticism: missing ? null : 49,
    attachmentStyle: missing ? null : 'ATTACH_SECURE',
    loveLanguages: missing ? [] : ['WORDS_OF_AFFIRMATION'],
    conflictStyle: missing ? null : 'COLLABORATING',
    ...overrides,
  };
};

const scores = (overrides: Partial<RelationshipReportScores> = {}): RelationshipReportScores => ({
  totalScore: 78,
  mbtiScore: 82,
  bigFiveScore: 74,
  attachmentScore: 80,
  communicationScore: 71,
  scoreBreakdown: {
    mbti: { score: 82, counted: true, breakdown: { note: '内部细节不应进 Prompt' } },
    bigFive: { score: 74, counted: true, breakdown: {} },
    attachment: { score: 80, counted: false, breakdown: {} },
    appliedWeights: { mbti: 30, bigFive: 30 },
    skippedDimensions: ['attachment'],
  },
  skippedDimensions: ['attachment'],
  scoreLevelLabel: '契合良好',
  ...overrides,
});

const input = (overrides: Partial<RelationshipReportContextInput> = {}): RelationshipReportContextInput => ({
  relationTypeName: '伴侣关系',
  counterpartLabel: '伴侣',
  me: side('INFJ'),
  partner: side('ENFP'),
  scores: scores(),
  daysTogether: 120,
  ...overrides,
});

describe('buildRelationshipReportContext', () => {
  it('【关键】所有变量无条件存在（数据齐全时没有任何占位文案）', () => {
    const { variables, unavailable } = buildRelationshipReportContext(input());

    expect(unavailable).toEqual([]);
    for (const [name, value] of Object.entries(variables)) {
      expect({ name, value }).not.toEqual({ name, value: UNAVAILABLE_PLACEHOLDER });
    }
  });

  it('【关键】数据全缺时变量依然齐全，且逐项登记进 unavailable', () => {
    const { variables, unavailable } = buildRelationshipReportContext(input({ me: side(null), partner: side(null) }));

    // 变量名集合与数据齐全时完全一致 —— 模板不会因缺数据渲染失败
    const complete = Object.keys(buildRelationshipReportContext(input()).variables).sort();
    expect(Object.keys(variables).sort()).toEqual(complete);

    // 双方各自的缺失项都被登记（而不是只记一处）
    expect(unavailable).toContain('myMbtiType');
    expect(unavailable).toContain('partnerMbtiType');
    expect(unavailable).toContain('myLoveLanguages');
    expect(unavailable).toContain('partnerLoveLanguages');
  });

  it('【关键】`my*` 填的是传进来的 me，而不是固定取 A', () => {
    // 视角搞反的表现：B 阅读时报告把对方说成"你"。这里用两个不同类型断言
    const { variables } = buildRelationshipReportContext(input());

    expect(variables.myMbtiType).toBe('INFJ');
    expect(variables.partnerMbtiType).toBe('ENFP');
    expect(variables.myMbtiTypeName).toBe('提倡者');
    expect(variables.partnerMbtiTypeName).toBe('竞选者');
  });

  it('【关键】交换 me/partner 后视角整体对调（证明没有写死一侧）', () => {
    const swapped = buildRelationshipReportContext(input({ me: side('ENFP'), partner: side('INFJ') })).variables;

    expect(swapped.myMbtiType).toBe('ENFP');
    expect(swapped.partnerMbtiType).toBe('INFJ');
    expect(swapped.partnerMbtiTypeName).toBe('提倡者');
  });

  it('分数原样透传，不做任何再计算（ADR-005：AI 只解读）', () => {
    const { variables } = buildRelationshipReportContext(input());

    expect(variables.totalScore).toBe('78');
    expect(variables.scoreLevel).toBe('契合良好');
    expect(variables.subScores).toContain('MBTI 互补度 82');
  });

  it('【关键】分项得分里 null 的项直接跳过，不写成"0 分"', () => {
    const { variables } = buildRelationshipReportContext(
      input({
        scores: scores({
          mbtiScore: null,
          bigFiveScore: 74,
          attachmentScore: null,
          communicationScore: null,
        }),
      }),
    );

    expect(variables.subScores).toBe('大五契合度 74');
    expect(variables.subScores).not.toContain('0');
  });

  it('【关键】分项明细只含有分数且参与了算分的维度，并带上权重', () => {
    const { variables } = buildRelationshipReportContext(input());

    // counted: false 的维度不进 Prompt（它没有真正影响总分）
    expect(variables.scoreBreakdown).toContain('mbti 82');
    expect(variables.scoreBreakdown).toContain('权重 30%');
    expect(variables.scoreBreakdown).not.toContain('attachment');
    // 内层 breakdown 的结构细节不该进 Prompt（浪费 token 且是噪声）
    expect(variables.scoreBreakdown).not.toContain('内部细节');
    // appliedWeights / skippedDimensions 是元数据，不作为维度输出
    expect(variables.scoreBreakdown).not.toContain('appliedWeights');
  });

  it('明细全空时落到占位文案', () => {
    const { variables, unavailable } = buildRelationshipReportContext(
      input({ scores: scores({ scoreBreakdown: {} }) }),
    );

    expect(variables.scoreBreakdown).toBe(UNAVAILABLE_PLACEHOLDER);
    expect(unavailable).toContain('scoreBreakdown');
  });

  it('【关键】被跳过的维度用「无」而非空串表达（空串会被模型当成"没这项数据"）', () => {
    const none = buildRelationshipReportContext(input({ scores: scores({ skippedDimensions: [] }) })).variables;
    expect(none.skippedDimensions).toContain('无');

    const some = buildRelationshipReportContext(input()).variables;
    expect(some.skippedDimensions).toBe('attachment');
  });

  it('未生效关系（无在一起天数）落到占位文案', () => {
    const { variables, unavailable } = buildRelationshipReportContext(input({ daysTogether: null }));

    expect(variables.daysTogether).toBe(UNAVAILABLE_PLACEHOLDER);
    expect(unavailable).toContain('daysTogether');
  });

  it('依恋风格与爱的语言转成中文标签', () => {
    const { variables } = buildRelationshipReportContext(input());

    expect(variables.myAttachmentStyle).toBe('安全型依恋');
    expect(variables.myLoveLanguages).toBe('肯定的言辞');
  });

  it('未知的依恋风格取值回落到原始值（让新增枚举没登记这件事被看见）', () => {
    const { variables } = buildRelationshipReportContext(
      input({ me: side('INFJ', { attachmentStyle: 'ATTACH_NEW_KIND' }) }),
    );

    expect(variables.myAttachmentStyle).toBe('ATTACH_NEW_KIND');
  });

  it('维度行与类型百科文案都产出了内容', () => {
    const { variables } = buildRelationshipReportContext(input());

    expect(variables.myDimensions).toContain('%');
    expect(variables.myBigFive).toContain('开放性');
    expect(variables.myTypeStrengths?.length).toBeGreaterThan(0);
    expect(variables.partnerTypeWatchouts?.length).toBeGreaterThan(0);
  });

  it('关系类型与称呼原样透传', () => {
    const { variables } = buildRelationshipReportContext(input());

    expect(variables.relationTypeName).toBe('伴侣关系');
    expect(variables.counterpartLabel).toBe('伴侣');
  });
});

describe('counterpartLabelOf', () => {
  it('三种关系类型都有称呼', () => {
    expect(counterpartLabelOf('COUPLE')).toBe('伴侣');
    expect(counterpartLabelOf('FRIEND')).toBe('朋友');
    expect(counterpartLabelOf('FAMILY')).toBe('家人');
  });

  it('未知类型回落到「对方」而不是空串（空串会让模板出现"请为这段关系…"的断句）', () => {
    expect(counterpartLabelOf('PARTNER')).toBe('对方');
  });
});
