/**
 * Prompt 模板种子数据契约测试
 *
 * 本文件守住一条**跨模块不变量**：模板里写的占位符，必须是
 * `buildReportContext` 真的会产出的变量名。
 *
 * 两边任何一处笔误（`{{mbtiType}}` 写成 `{{mbtitype}}`）都不会在编译期被发现，
 * 而会在运行时表现为「50012 缺少必需变量」—— 那时用户已经消耗了一次生成请求，
 * 且错误出现在 AI 链路深处，排查成本高。因此这里逐个模板提取占位符并比对。
 */

import { PROMPT_TEMPLATES } from './prompt-templates';
import { buildReportContext, type ReportContextInput } from '../../../src/modules/ai/context/report-context.builder';
import {
  buildRelationshipReportContext,
  type RelationshipReportContextInput,
  type RelationshipReportSide,
} from '../../../src/modules/ai/context/relationship-report-context.builder';
import { extractPlaceholders } from '../../../src/modules/ai/prompt/prompt-renderer';
import { readExpectedSections } from '../../../src/modules/ai/report/report-section.parser';

/** 数据齐全的画像 */
const fullProfile = (): ReportContextInput => ({
  profile: {
    mbtiType: 'INFJ',
    mbtiConfidence: 82,
    eiPercent: 72,
    snPercent: 68,
    tfPercent: 61,
    jpPercent: 78,
    openness: 84,
    conscientiousness: 67,
    extraversion: 32,
    agreeableness: 72,
    neuroticism: 49,
    attachmentStyle: 'ATTACH_SECURE',
    loveLanguages: ['WORDS_OF_AFFIRMATION'],
    conflictStyle: 'COLLABORATING',
    consistencyScore: 88,
    completionRate: 100,
    avgResponseMs: 12_000,
    engineVersion: '1.0.0',
  },
  testDefinitionCode: 'MBTI_LITE',
  answeredCount: 32,
  questionCount: 32,
});

/** 全部字段缺失的画像（模板在数据残缺时同样必须可渲染） */
const emptyProfile = (): ReportContextInput => ({
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

/** 收集模板用到的全部占位符 */
const placeholdersOf = (template: (typeof PROMPT_TEMPLATES)[number]): string[] =>
  extractPlaceholders(`${template.systemPrompt}\n${template.userPromptTemplate}`);

// ---------------------------------------------------------------------------
// 关系报告上下文
// ---------------------------------------------------------------------------

/**
 * 模板键 → 上下文构建器
 *
 * **必须按模板路由**：关系报告喂给模型的是"两个人 + 他们之间的算分结果"，
 * 与单画像报告是两套变量。若统一用单画像构建器校验，关系模板里的
 * `{{partnerMbtiType}}` 会被判为"不存在的变量"而测试失败；
 * 反过来若把两套变量并集成一个大集合，笔误就再也测不出来了 ——
 * 那正是这个契约测试存在的意义。
 */
const isRelationshipTemplate = (key: string): boolean => key.startsWith('report.relationship');

const fullRelationshipContext = (): RelationshipReportContextInput => ({
  relationTypeName: '伴侣关系',
  counterpartLabel: '伴侣',
  me: relationshipSide('INFJ'),
  partner: relationshipSide('ENFP'),
  scores: {
    totalScore: 78,
    mbtiScore: 82,
    bigFiveScore: 74,
    attachmentScore: 80,
    communicationScore: 71,
    scoreBreakdown: {
      mbti: { score: 82, counted: true, breakdown: {} },
      bigFive: { score: 74, counted: true, breakdown: {} },
      attachment: { score: 80, counted: true, breakdown: {} },
      communication: { score: 71, counted: true, breakdown: {} },
      appliedWeights: { mbti: 30, bigFive: 30, attachment: 20, communication: 20 },
      skippedDimensions: [],
    },
    skippedDimensions: [],
    scoreLevelLabel: '契合良好',
  },
  daysTogether: 120,
});

/** 双方数据全缺（模板在数据残缺时同样必须可渲染） */
const emptyRelationshipContext = (): RelationshipReportContextInput => ({
  relationTypeName: '伴侣关系',
  counterpartLabel: '伴侣',
  me: relationshipSide(null, true),
  partner: relationshipSide(null, true),
  scores: {
    totalScore: 65,
    mbtiScore: null,
    bigFiveScore: null,
    attachmentScore: null,
    communicationScore: null,
    scoreBreakdown: {},
    skippedDimensions: ['mbti', 'bigFive', 'attachment', 'communication'],
    scoreLevelLabel: '契合良好',
  },
  daysTogether: null,
});

/** 构造一侧数据；`null` 类型或 `allMissing` 时全部字段为空 */
const relationshipSide = (mbtiType: string | null, allMissing = false): RelationshipReportSide => ({
  mbtiType: allMissing ? null : mbtiType,
  eiPercent: allMissing ? null : 72,
  snPercent: allMissing ? null : 68,
  tfPercent: allMissing ? null : 61,
  jpPercent: allMissing ? null : 78,
  openness: allMissing ? null : 84,
  conscientiousness: allMissing ? null : 67,
  extraversion: allMissing ? null : 32,
  agreeableness: allMissing ? null : 72,
  neuroticism: allMissing ? null : 49,
  attachmentStyle: allMissing ? null : 'ATTACH_SECURE',
  loveLanguages: allMissing ? [] : ['WORDS_OF_AFFIRMATION'],
  conflictStyle: allMissing ? null : 'COLLABORATING',
});

/** 某模板在「数据齐全」与「数据全缺」两种情形下可用的变量名 */
const availableVariables = (templateKey: string, dataComplete: boolean): Set<string> => {
  if (isRelationshipTemplate(templateKey)) {
    const context = dataComplete ? fullRelationshipContext() : emptyRelationshipContext();
    return new Set(Object.keys(buildRelationshipReportContext(context).variables));
  }

  return new Set(Object.keys(buildReportContext(dataComplete ? fullProfile() : emptyProfile()).variables));
};

describe('Prompt 模板种子数据契约', () => {
  it('至少有一个模板（否则 Phase 3 流水线全线返回 50011）', () => {
    expect(PROMPT_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('模板键唯一且为 `域.用途` 形式', () => {
    const keys = PROMPT_TEMPLATES.map((template) => template.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z]+\.[a-z0-9]+$/);
    }
  });

  it('【关键】所有占位符都是上下文组装真实产出的变量（数据齐全时）', () => {
    for (const template of PROMPT_TEMPLATES) {
      const available = availableVariables(template.key, true);
      const missing = placeholdersOf(template).filter((name) => !available.has(name));

      expect({ template: template.key, missing }).toEqual({ template: template.key, missing: [] });
    }
  });

  it('【关键】数据全缺时占位符同样全部可得（模板不会因缺数据渲染失败）', () => {
    for (const template of PROMPT_TEMPLATES) {
      const available = availableVariables(template.key, false);
      const missing = placeholdersOf(template).filter((name) => !available.has(name));

      expect({ template: template.key, missing }).toEqual({ template: template.key, missing: [] });
    }
  });

  it('每个模板都真的使用了变量（否则模板与数据脱节）', () => {
    for (const template of PROMPT_TEMPLATES) {
      expect(placeholdersOf(template).length).toBeGreaterThan(3);
    }
  });

  describe('段落声明', () => {
    it('【关键】每个模板至少一个免费预览段（否则用户打开就报 50019）', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.sections.some((section) => section.freePreview)).toBe(true);
      }
    });

    it('段落键唯一、非空且符合标识符形式', () => {
      for (const template of PROMPT_TEMPLATES) {
        const keys = template.sections.map((section) => section.key);

        expect(new Set(keys).size).toBe(keys.length);
        for (const key of keys) {
          expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      }
    });

    it('段落标题非空且会被分段解析器的声明读取识别', () => {
      for (const template of PROMPT_TEMPLATES) {
        const declared = readExpectedSections({ sections: template.sections });

        expect(declared).toHaveLength(template.sections.length);
        for (const section of declared) {
          expect(section.title.length).toBeGreaterThan(1);
        }
      }
    });

    it('【关键】提示词里给出的标题与段落声明一致（否则模型按 A 写、解析器按 B 切）', () => {
      for (const template of PROMPT_TEMPLATES) {
        // 只对明确要求「严格使用给定标题」的模板做校验
        if (!template.userPromptTemplate.includes('严格使用')) continue;

        for (const section of template.sections) {
          expect(template.userPromptTemplate).toContain(section.title);
        }
      }
    });

    it('【关键】关系报告的段落键必须是 `compatibility_reports` 真实存在的列', () => {
      // 段落解析后按 `sectionKey` 落库。键名写错时内容会被塞进兜底键
      // （`extra-{n}`），而对应的列永远是 NULL —— 表现为"报告生成了但优势/冲突是空的"，
      // 且不报任何错。因此把键名与列名钉在一起。
      //
      // 表里**恰好只有这三个** JsonB 列，所以段落也只能有三段：
      // 曾经设计过第四段「沟通话术示例」，没有任何列能承载它，那段内容会静默丢失
      const relationship = PROMPT_TEMPLATES.find((template) => template.key === 'report.relationship');

      expect(relationship).toBeDefined();
      expect(relationship?.sections.map((section) => section.key)).toEqual(['advantages', 'conflicts', 'suggestions']);
    });

    it('【关键】关系报告的首段免费（用户先看到"合拍在哪"再决定付费）', () => {
      const relationship = PROMPT_TEMPLATES.find((template) => template.key === 'report.relationship');

      expect(relationship?.sections[0]?.key).toBe('advantages');
      expect(relationship?.sections[0]?.freePreview).toBe(true);
    });
  });

  describe('合规与质量底线', () => {
    it('【关键】系统提示词要求「不得重新计算分数」（ADR-005 底线）', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.systemPrompt).toContain('绝不重新计算');
      }
    });

    it('【关键】禁止医疗与诊断表述', () => {
      for (const template of PROMPT_TEMPLATES) {
        for (const word of ['诊断', '症状', '疾病', '障碍', '治疗', '临床']) {
          expect(template.systemPrompt).toContain(word); // 以否定形式出现在约束里
        }
        // 且整份提示词不得把医学术语当作描述语使用
        expect(template.systemPrompt).toMatch(/不做任何医疗/);
      }
    });

    it('要求使用倾向性表述而非绝对化断言', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.systemPrompt).toContain('绝对化');
      }
    });

    it('要求对「未包含此项」的数据不凭空推测', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.systemPrompt).toContain('未包含此项');
      }
    });

    it('规定了 Markdown 二级标题的分段格式（分段解析器依赖它）', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.userPromptTemplate).toContain('## ');
        expect(template.userPromptTemplate).toContain('二级标题');
      }
    });
  });

  describe('版本与参数', () => {
    it('初始版本为正整数且从 1 开始', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(Number.isInteger(template.version)).toBe(true);
        expect(template.version).toBeGreaterThanOrEqual(1);
      }
    });

    it('温度偏保守（报告解读要求稳定输出，不应鼓励发散）', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.temperature).toBeGreaterThan(0);
        expect(template.temperature).toBeLessThanOrEqual(1);
      }
    });

    it('maxTokens 足以容纳多段报告，但不超过模型上限', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.maxTokens).toBeGreaterThanOrEqual(1024);
        expect(template.maxTokens).toBeLessThanOrEqual(8192);
      }
    });

    it('变更说明非空（后台需要知道这一版改了什么）', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.changeNote.length).toBeGreaterThan(4);
      }
    });

    it('名称与描述非空', () => {
      for (const template of PROMPT_TEMPLATES) {
        expect(template.name.length).toBeGreaterThan(2);
        expect(template.description.length).toBeGreaterThan(10);
      }
    });
  });
});
