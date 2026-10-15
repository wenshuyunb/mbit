/**
 * 报告上下文组装测试
 *
 * 核心主张是**确定性**与**不失败**：
 *   · 同一份画像重复调用必须产出逐字节相同的变量（ADR-005 的可复现要求）
 *   · 数据残缺时**不抛错**，而是给出显式占位文案，并完整列出缺项
 *   · 变量集合固定（模板不必知道哪些数据必有），因此模板永不因缺项渲染失败
 */

import { renderPromptVersion } from '../prompt/prompt-renderer';
import {
  BIG_FIVE_LABELS,
  buildReportContext,
  UNAVAILABLE_PLACEHOLDER,
  type ReportContextInput,
} from './report-context.builder';

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
      // 顺序必须是「开放 → 尽责 → 外向 → 宜人 → 神经质」
      const order = ['开放性', '尽责性', '外向性', '宜人性', '神经质'];
      const positions = order.map((label) => summary.indexOf(label));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('【关键】neuroticism 的中文名必须是「神经质」而不是「情绪稳定性」', () => {
      // 这条断言守的是一个**会静默把结论说反**的缺陷：
      // 数值语义是"神经质原始分（越高 = 情绪越容易波动）"，若标签写成「情绪稳定性」，
      // 提示词里那行 `… 90（高）` 就会被模型读成"情绪很稳定" —— 结论正好相反，
      // 而且报告读起来毫无破绽（这正是它危险的地方）。
      // 小程序端（`config/constants.ts`）用的也是「神经质」，两端必须同名同向。
      expect(BIG_FIVE_LABELS['neuroticism']).toBe('神经质');
      // 防"换个近义词改回去"：任何带"稳定"的叫法都意味着方向被读反
      expect(BIG_FIVE_LABELS['neuroticism']).not.toContain('稳定');
    });

    /**
     * ⚠ 原先这里有一条「依恋风格与爱的语言转为中文标签」的用例
     *
     * 随 ADR-038 删除：这两个变量已不属于人格报告上下文（情感结论归情感模块）。
     * 中文标签映射本身仍保留在 `ATTACHMENT_LABELS` / `LOVE_LANGUAGE_LABELS`，
     * 关系（匹配）报告与将来的情感模块继续用它们。
     */
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

    /**
     * 性别语境（ADR-039）
     *
     * ⚠ 它**永远可用**：未提供性别时给出的是一句明确指令（"一律使用中性措辞"），
     * 而不是"（本次测评未包含此项）"那种占位 —— 后者会让模型自行脑补一个性别。
     */
    describe('性别语境', () => {
      it('未提供性别 → 中性措辞指令，且不算缺项', () => {
        const built = buildReportContext({ ...fullInput(), gender: null });

        expect(built.variables['genderContext']).toContain('未提供性别');
        expect(built.unavailable).not.toContain('genderContext');
      });

      it('提供性别 → 按该视角展开，并禁止刻板印象', () => {
        const built = buildReportContext({ ...fullInput(), gender: 'FEMALE' });

        expect(built.variables['genderContext']).toContain('女生');
        expect(built.variables['genderContext']).toContain('严禁性别刻板印象');
      });

      it('【关键】性别不参与任何**结论性**变量', () => {
        const male = buildReportContext({ ...fullInput(), gender: 'MALE' }).variables;
        const female = buildReportContext({ ...fullInput(), gender: 'FEMALE' }).variables;

        for (const key of ['mbtiType', 'mbtiTypeName', 'dimensionEI', 'bigFiveSummary', 'mbtiConfidence']) {
          expect(male[key]).toBe(female[key]);
        }
      });
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
        profile: { ...input.profile, avgResponseMs: null },
      });

      expect(unavailable).toEqual(['avgResponseSeconds']);
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

    /**
     * ⚠ 原先这里还有两条用例：「未知依恋编码原样输出」「未知爱的语言编码原样输出」
     *
     * 它们随 ADR-038 一并删除 —— 断言的对象（`attachmentStyle` / `loveLanguages`）
     * 已经不属于人格报告上下文。**这两条用例本身就是"模块互相干扰"的化石**：
     * 它们的存在说明当时的组装器确实在为情感结论服务。
     */
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
