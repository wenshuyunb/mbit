/**
 * 报告上下文组装测试
 *
 * 核心主张是**确定性**与**不失败**：
 *   · 同一份画像重复调用必须产出逐字节相同的变量（ADR-005 的可复现要求）
 *   · 数据残缺时**不抛错**，而是给出显式占位文案，并完整列出缺项
 *   · 变量集合固定（模板不必知道哪些数据必有），因此模板永不因缺项渲染失败
 */

import { renderPromptVersion } from '../prompt/prompt-renderer';
import { buildReportContext, UNAVAILABLE_PLACEHOLDER, type ReportContextInput } from './report-context.builder';

const fullInput = (): ReportContextInput => ({
  profile: {
    mbtiType: 'INFJ',
    mbtiConfidence: 82.4,
    eiPercent: 72.2,
    snPercent: 68.5,
    tfPercent: 61.1,
    jpPercent: 77.9,
    openness: 84.2,
    conscientiousness: 66.7,
    extraversion: 31.5,
    agreeableness: 72.1,
    neuroticism: 48.9,
    attachmentStyle: 'ATTACH_SECURE',
    loveLanguages: ['WORDS_OF_AFFIRMATION', 'QUALITY_TIME'],
    conflictStyle: 'COLLABORATING',
    consistencyScore: 88.6,
    completionRate: 100,
    avgResponseMs: 12_400,
    engineVersion: '1.0.0',
  },
  testDefinitionCode: 'MBTI_LITE',
  answeredCount: 32,
  questionCount: 32,
});

/** 全字段缺失的输入 */
const emptyInput = (): ReportContextInput => ({
  profile: {
    mbtiType: null,
    mbtiConfidence: null,
    eiPercent: null,
    snPercent: null,
    tfPercent: null,
    jpPercent: null,
    openness: null,
    conscientiousness: null,
    extraversion: null,
    agreeableness: null,
    neuroticism: null,
    attachmentStyle: null,
    loveLanguages: [],
    conflictStyle: null,
    consistencyScore: null,
    completionRate: null,
    avgResponseMs: null,
    engineVersion: null,
  },
  testDefinitionCode: null,
  answeredCount: null,
  questionCount: null,
});

describe('buildReportContext', () => {
  describe('完整数据', () => {
    it('产出类型、百科与四维倾向', () => {
      const { variables } = buildReportContext(fullInput());

      expect(variables['mbtiType']).toBe('INFJ');
      expect(variables['mbtiTypeName']).toBe('提倡者');
      expect(variables['mbtiGroup']).toBe('外交家');
      expect(variables['mbtiTagline']).not.toBe(UNAVAILABLE_PLACEHOLDER);
      expect(variables['dimensionEI']).toBe('内向 72%');
      expect(variables['dimensionSN']).toBe('直觉 69%');
      expect(variables['dimensionTF']).toBe('情感 61%');
      expect(variables['dimensionJP']).toBe('判断 78%');
    });

    it('数值统一取整（同一分数永远同一种写法）', () => {
      const { variables } = buildReportContext(fullInput());

      // 82.4 → 82、66.7 → 67
      expect(variables['mbtiConfidence']).toBe('82');
      expect(variables['bigFiveSummary']).toContain('尽责性 67');
    });

    it('大五带档位描述且顺序固定', () => {
      const { variables } = buildReportContext(fullInput());
      const summary = variables['bigFiveSummary'];

      expect(summary).toContain('开放性 84（高）');
      expect(summary).toContain('外向性 32（偏低）');
      // 顺序必须是「开放 → 尽责 → 外向 → 宜人 → 情绪稳定」
      const order = ['开放性', '尽责性', '外向性', '宜人性', '情绪稳定性'];
      const positions = order.map((label) => summary.indexOf(label));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('依恋风格与爱的语言转为中文标签', () => {
      const { variables } = buildReportContext(fullInput());

      expect(variables['attachmentStyle']).toBe('安全型依恋');
      expect(variables['loveLanguages']).toBe('肯定的言辞、精心的时刻');
    });

    it('元信息齐备', () => {
      const { variables } = buildReportContext(fullInput());

      expect(variables['testDefinitionCode']).toBe('MBTI_LITE');
      expect(variables['answeredRatio']).toBe('32/32');
      expect(variables['avgResponseSeconds']).toBe('12');
      expect(variables['engineVersion']).toBe('1.0.0');
    });

    it('【关键】完全没有缺项', () => {
      expect(buildReportContext(fullInput()).unavailable).toEqual([]);
    });
  });

  describe('确定性', () => {
    it('【关键】同一输入重复调用产出逐字节相同的变量', () => {
      const first = buildReportContext(fullInput());
      const second = buildReportContext(fullInput());

      expect(JSON.stringify(first.variables)).toBe(JSON.stringify(second.variables));
    });

    it('【关键】变量键集合固定（模板不必知道哪些数据必有）', () => {
      const full = Object.keys(buildReportContext(fullInput()).variables).sort();
      const empty = Object.keys(buildReportContext(emptyInput()).variables).sort();

      expect(empty).toEqual(full);
    });

    it('每次返回全新对象（调用方修改结果不会污染后续调用）', () => {
      const first = buildReportContext(fullInput());
      const second = buildReportContext(fullInput());

      expect(first.variables).not.toBe(second.variables);
      expect(first.unavailable).not.toBe(second.unavailable);
    });
  });

  describe('数据残缺', () => {
    it('【关键】不抛错，缺失项以显式占位文案呈现', () => {
      const { variables, unavailable } = buildReportContext(emptyInput());

      expect(variables['mbtiType']).toBe(UNAVAILABLE_PLACEHOLDER);
      expect(variables['bigFiveSummary']).toBe(UNAVAILABLE_PLACEHOLDER);
      expect(unavailable.length).toBeGreaterThan(0);
    });

    it('【关键】缺项清单完整（后台据此提示数据不全）', () => {
      const { unavailable } = buildReportContext(emptyInput());

      for (const name of [
        'mbtiType',
        'dimensionEI',
        'dimensionSN',
        'dimensionTF',
        'dimensionJP',
        'bigFiveSummary',
        'mbtiConfidence',
        'attachmentStyle',
        'loveLanguages',
        'conflictStyle',
        'avgResponseSeconds',
        'answeredRatio',
      ]) {
        expect(unavailable).toContain(name);
      }
    });

    it('部分缺失时仅记录该部分', () => {
      const input = fullInput();
      const { unavailable } = buildReportContext({
        ...input,
        profile: { ...input.profile, conflictStyle: null, avgResponseMs: null },
      });

      expect(unavailable).toEqual(['conflictStyle', 'avgResponseSeconds']);
    });

    it('未知类型码时类型字段保留原值，百科字段缺项（不猜百科内容）', () => {
      const input = fullInput();
      const { variables, unavailable } = buildReportContext({
        ...input,
        profile: { ...input.profile, mbtiType: 'XXXX' },
      });

      expect(variables['mbtiType']).toBe('XXXX');
      expect(variables['mbtiTypeName']).toBe(UNAVAILABLE_PLACEHOLDER);
      expect(unavailable).toContain('mbtiTypeName');
    });

    it('未知依恋编码原样输出（不猜成默认值）', () => {
      const input = fullInput();
      const { variables } = buildReportContext({
        ...input,
        profile: { ...input.profile, attachmentStyle: 'SOMETHING_NEW' },
      });

      expect(variables['attachmentStyle']).toBe('SOMETHING_NEW');
    });

    it('未知爱的语言编码原样输出', () => {
      const input = fullInput();
      const { variables } = buildReportContext({
        ...input,
        profile: { ...input.profile, loveLanguages: ['UNKNOWN_LANG'] },
      });

      expect(variables['loveLanguages']).toBe('UNKNOWN_LANG');
    });

    it('问题数为 0 时 answeredRatio 记为缺失（不产生 32/0 这种误导值）', () => {
      const { variables } = buildReportContext({
        ...fullInput(),
        answeredCount: 32,
        questionCount: 0,
      });

      expect(variables['answeredRatio']).toBe(UNAVAILABLE_PLACEHOLDER);
    });

    it('非有限数值按缺失处理（不产出 NaN）', () => {
      const input = fullInput();
      const { variables } = buildReportContext({
        ...input,
        profile: { ...input.profile, mbtiConfidence: Number.NaN },
      });

      expect(variables['mbtiConfidence']).toBe(UNAVAILABLE_PLACEHOLDER);
    });
  });

  describe('与模板渲染的衔接', () => {
    it('产出的变量可直接渲染一个引用全部字段的模板', () => {
      const { variables } = buildReportContext(fullInput());

      const template = Object.keys(variables)
        .map((name) => `{{${name}}}`)
        .join(' | ');

      const rendered = renderPromptVersion({ systemPrompt: '你是分析师', userPromptTemplate: template }, variables);

      expect(rendered.user).not.toContain('{{');
      expect(rendered.user).toContain('INFJ');
      expect(rendered.usedVariables.length).toBe(Object.keys(variables).length);
    });

    it('【关键】数据全缺时模板仍能渲染成功（占位文案保证了这一点）', () => {
      const { variables } = buildReportContext(emptyInput());

      const template = Object.keys(variables)
        .map((name) => `{{${name}}}`)
        .join(' ');
      const rendered = renderPromptVersion({ systemPrompt: 's', userPromptTemplate: template }, variables);

      expect(rendered.user).toContain(UNAVAILABLE_PLACEHOLDER);
    });
  });
});
