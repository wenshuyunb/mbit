/**
 * Prompt 模板种子数据契约测试
 *
 * 本文件守住一条**跨模块不变量**：模板里写的占位符，必须是上下文组装代码
 * 真的会产出的变量名。
 *
 * 两边任何一处笔误（`{{mbtiType}}` 写成 `{{mbtitype}}`）都不会在编译期被发现，
 * 而会在运行时表现为「50012 缺少必需变量」—— 那时用户已经消耗了一次生成请求，
 * 且错误出现在 AI 链路深处，排查成本高。因此这里逐个模板提取占位符并比对。
 *
 * ## 变量族（按模板路由，不合并成一个大集合）
 *
 * | 模板族 | 变量来源 |
 * | --- | --- |
 * | `report.*`（报告） | `buildReportContext` / `buildRelationshipReportContext` |
 * | `report.growth`（成长回顾：**多画像时间序列**） | `buildGrowthReportContext` |
 * | `ai.companion`（AI 情感助手对话） | `buildPromptVariables`（`chat-prompt.ts`） |
 *
 * 各族之间的变量集合**没有交集**，因此必须按模板键路由到对应的生产函数：
 * 统一用单画像报告变量校验会让对话模板的 `{{myPersona}}`、关系模板的 `{{partnerMbtiType}}`、
 * 成长模板的 `{{growthTimeline}}` 被判为"不存在的变量"；
 * 反过来把三族并集成一个大集合，笔误就再也测不出来了 ——
 * 那正是这个契约测试存在的意义。
 */

import { PROMPT_TEMPLATES } from './prompt-templates';
import { PromptType } from '@prisma/client';
import {
  BIG_FIVE_LABELS,
  buildReportContext,
  type ReportContextInput,
} from '../../../src/modules/ai/context/report-context.builder';
import {
  buildGrowthReportContext,
  type GrowthProfileSnapshot,
  type GrowthReportContextInput,
} from '../../../src/modules/ai/context/growth-report-context.builder';
import {
  buildRelationshipReportContext,
  type RelationshipReportContextInput,
  type RelationshipReportSide,
} from '../../../src/modules/ai/context/relationship-report-context.builder';
import { assembleChatContext, type ChatContextAssembly } from '../../../src/modules/ai/chat/chat-context.util';
import { buildPromptVariables, templateKeyCandidatesOf } from '../../../src/modules/ai/chat/chat-prompt';
import { extractPlaceholders, renderPromptVersion } from '../../../src/modules/ai/prompt/prompt-renderer';
import { parseReportSections, readExpectedSections } from '../../../src/modules/ai/report/report-section.parser';
import { REPORT_SECTION_KEYS } from '../../../src/modules/ai/report/report-section.util';

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

/**
 * 成长回顾模板的近似判定
 *
 * 成长报告的取数路径与前两者都不同：喂给模型的是**同一用户多个历史画像的时间序列**。
 * 用前缀判定（与 `report.relationship` 同一写法），日后新增同类模板会自然落进这一族。
 */
const isGrowthTemplate = (key: string): boolean => key.startsWith('report.growth');

/**
 * 对话模板的近似判定
 *
 * 用前缀而不是白名单常量：`ai.companion` 是 `chat-prompt.ts` 候选链里的**库内键名**
 * （契约键名 `AI_COMPANION` 落库时按 spec 的 `域.用途` 规则写成点号小写），
 * 日后若新增 `ai.*` 对话类模板（例如另一种模式），会自然落进这一族。
 */
const isCompanionTemplate = (key: string): boolean => key.startsWith('ai.companion');

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

// ---------------------------------------------------------------------------
// 成长回顾报告上下文（多画像时间序列）
// ---------------------------------------------------------------------------

/** 构造一版画像；默认全字段缺失，只写测试关心的字段 */
const growthSnapshot = (
  overrides: Partial<GrowthProfileSnapshot> & { readonly version: number },
): GrowthProfileSnapshot => ({
  createdAt: '2026-01-05T09:12:00.000Z',
  mbtiType: null,
  openness: null,
  conscientiousness: null,
  extraversion: null,
  agreeableness: null,
  neuroticism: null,
  consistencyScore: null,
  completionRate: null,
  answeredCount: null,
  questionCount: null,
  avgResponseMs: null,
  testDefinitionCode: null,
  ...overrides,
});

/**
 * 数据齐全的三版序列
 *
 * 刻意包含一类"变了"和一类"没变"：开放性 +16、神经质 -15（明显变化），
 * 尽责性 +1、外向性 +2、宜人性 +1（基本稳定），类型从 INFJ 变为 ENFP ——
 * 这样模板若只引用最新一版，就必然漏掉"轨迹"与"变化量"这两块。
 */
const fullGrowthContext = (): GrowthReportContextInput => ({
  profiles: [
    growthSnapshot({
      version: 1,
      createdAt: '2026-01-05T09:12:00.000Z',
      mbtiType: 'INFJ',
      openness: 62,
      conscientiousness: 70,
      extraversion: 30,
      agreeableness: 65,
      neuroticism: 55,
      consistencyScore: 82,
      completionRate: 95,
      answeredCount: 30,
      questionCount: 32,
      avgResponseMs: 12_000,
      testDefinitionCode: 'MBTI_LITE',
    }),
    growthSnapshot({
      version: 2,
      createdAt: '2026-03-18T21:40:00.000Z',
      mbtiType: 'INFJ',
      openness: 70,
      conscientiousness: 72,
      extraversion: 31,
      agreeableness: 66,
      neuroticism: 50,
      consistencyScore: 88,
      completionRate: 100,
      answeredCount: 32,
      questionCount: 32,
      avgResponseMs: 11_000,
      testDefinitionCode: 'MBTI_LITE',
    }),
    growthSnapshot({
      version: 3,
      createdAt: '2026-06-20T11:05:00.000Z',
      mbtiType: 'ENFP',
      openness: 78,
      conscientiousness: 71,
      extraversion: 32,
      agreeableness: 66,
      neuroticism: 40,
      consistencyScore: 95,
      completionRate: 100,
      answeredCount: 32,
      questionCount: 32,
      avgResponseMs: 10_000,
      testDefinitionCode: 'MBTI_LITE',
    }),
  ],
});

/** 数据全缺的两版序列（模板在数据残缺时同样必须可渲染） */
const emptyGrowthContext = (): GrowthReportContextInput => ({
  profiles: [growthSnapshot({ version: 1, createdAt: '' }), growthSnapshot({ version: 2, createdAt: '' })],
});

// ---------------------------------------------------------------------------
// 对话上下文（AI 情感助手）
// ---------------------------------------------------------------------------

/**
 * 对话变量**必须从 `buildPromptVariables()` 取**，不能手写一份清单：
 * 手写的清单会在 `chat-prompt.ts` 增删变量时静默过期，而它一旦过期，
 * 这个契约测试就从"守住跨模块不变量"退化成"守住我自己抄的那份名单"。
 */
const fullChatContext = (): ChatContextAssembly =>
  assembleChatContext({
    includePersona: true,
    myPersona: '我：MBTI INFJ（内向 72%、直觉 68%）\n依恋风格：安全型依恋',
    partnerPersona: '我的伴侣（阿哲）：MBTI ENFP\n依恋风格：焦虑型依恋',
    memorySummary: '用户在开头提到最近工作压力大，聊到过两次和伴侣的沟通冲突。',
    recentMessages: [
      { role: 'USER', content: '他昨天又说我想太多' },
      { role: 'ASSISTANT', content: '听起来那句话让你挺难受的。' },
    ],
    hintSnippets: [{ label: 'MBTI 报告', text: '倾向于先处理感受再处理事情。' }],
  });

/** 数据全缺（首次倾诉：无画像、无对方、无历史、无摘要），模板同样必须可渲染 */
const emptyChatContext = (): ChatContextAssembly =>
  assembleChatContext({
    includePersona: true,
    myPersona: null,
    partnerPersona: null,
    memorySummary: null,
    recentMessages: [],
  });

/** 数据齐全时的对话变量 */
const fullChatVariables = (): Record<string, string> =>
  buildPromptVariables({
    mode: 'COMPANION',
    tone: 'WARM',
    includePersona: true,
    userInput: '他昨天又说我想太多，我一句话都不想说了。',
    context: fullChatContext(),
    userName: '小满',
    partnerName: '阿哲',
  });

/** 数据全缺时的对话变量（`includePersona: false` 会走"画像未启用"分支，此处覆盖该分支） */
const emptyChatVariables = (): Record<string, string> =>
  buildPromptVariables({
    mode: 'COMPANION',
    tone: 'NEUTRAL',
    includePersona: false,
    userInput: '在吗',
    context: emptyChatContext(),
    userName: '小满',
    partnerName: null,
  });

// ---------------------------------------------------------------------------
// 变量集合路由
// ---------------------------------------------------------------------------

/** 某模板在「数据齐全」与「数据全缺」两种情形下可用的变量名 */
const availableVariables = (templateKey: string, dataComplete: boolean): Set<string> => {
  if (isRelationshipTemplate(templateKey)) {
    const context = dataComplete ? fullRelationshipContext() : emptyRelationshipContext();
    return new Set(Object.keys(buildRelationshipReportContext(context).variables));
  }

  // 成长回顾：**多画像序列**，必须走自己的组装器（用单画像变量校验会把它判成引用了不存在的变量）
  if (isGrowthTemplate(templateKey)) {
    const context = dataComplete ? fullGrowthContext() : emptyGrowthContext();
    return new Set(Object.keys(buildGrowthReportContext(context).variables));
  }

  if (isCompanionTemplate(templateKey)) {
    return new Set(Object.keys(dataComplete ? fullChatVariables() : emptyChatVariables()));
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

  it('模板类型必须是 Prisma `PromptType` 的合法取值（多一个取值就会写到不存在的枚举上）', () => {
    // `PromptTemplate.type` 是 PG 枚举 `prompt_type`：写一个枚举里没有的值，
    // 落库会被数据库直接拒绝，而失败发生在**整个种子脚本**层面（不是少一个模板）。
    // 枚举值来自生成的 Prisma Client，不手抄清单。
    for (const template of PROMPT_TEMPLATES) {
      expect(Object.values(PromptType)).toContain(template.type);
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

    /**
     * ⚠ 这条断言原先写的是 `key` 必须匹配 `/^[a-z][a-z0-9_]*$/`（小写下划线），
     * 而**那个约定是错的、并且正是它把漂移固化了下来**：
     *
     *   · `report-section.util.ts` 的 `REPORT_SECTION_KEYS`（契约 §3.5.4 白名单）
     *     用的是**大写下划线**（`CORE_PORTRAIT` / `ACTION_PLAN` …），且那份文件的注释
     *     明确要求"取值与生成模板的段落键一致"；
     *   · `quoteSectionKey` 由 `@IsIn(REPORT_SECTION_KEYS)` 校验，客户端只能传那 6 个键；
     *   · 于是模板产出 `overview` / `strengths` / `growth` 时，
     *     分享卡的「金句卡」在真实报告上**永远返回 10001「段落不存在」**。
     *
     * 现在改成断言"格式合法 + 不重复"（大小写都允许），
     * 并把**"与 §3.5.4 白名单一致"**交给下面那条专门的用例去守。
     */
    it('段落键唯一、非空且符合标识符形式（大小写均可）', () => {
      for (const template of PROMPT_TEMPLATES) {
        const keys = template.sections.map((section) => section.key);

        expect(new Set(keys).size).toBe(keys.length);
        for (const key of keys) {
          expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
        }
      }
    });

    /**
     * 【关键】契约白名单绑定 —— 这是此前**缺失**的那道安全网
     *
     * `report-section.util.ts` 的注释写得很清楚：「顺序即报告内的自然段序，
     * **取值与生成模板（Prompt 输出 schema）的段落键一致**；让『模板加了新段落、
     * 接口忘了登记』变成编译期问题而不是线上 400」。
     *
     * 但模板是种子数据、白名单是 TS 常量，两者**从未被连起来**，那道网也就从未触发 ——
     * 直到 `quoteSectionKey` 在真实报告上取不到段落才暴露出来。
     *
     * ⚠ 这里只对 `report.mbti` 做「逐字相等（含顺序）」断言：契约 §3.5.4 的白名单
     * 就是为**个人报告**定义的。大五 / 关系 / 成长报告用的是各自的小写键
     *（`trait_overview` 等），**不在**该白名单里 —— 也就是说这些报告类型上的
     * `quoteSectionKey` 目前同样取不到段落。修它需要一次契约决策
     *（为各自定义键集合并扩展枚举，或做键映射），已登记在
     * `docs/CONTRACT_DRIFT_AUDIT.md`，不在本次改动里擅自决定。
     */
    it('【关键】个人报告（report.mbti）的段落键必须与契约 §3.5.4 白名单逐字一致（含顺序）', () => {
      const mbti = PROMPT_TEMPLATES.find((template) => template.key === 'report.mbti');

      expect(mbti).toBeDefined();
      expect(mbti?.sections.map((section) => section.key)).toEqual([...REPORT_SECTION_KEYS]);
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

  /**
   * 大五报告模板
   *
   * `BIG_FIVE_REPORT` 是 `report.dto.ts` 明示支持的请求类型，`report.service.ts` 的
   * `TEMPLATE_KEY_BY_TYPE` 也把它指向 `report.bigfive` —— 模板一旦缺失，用户请求就会
   * 在 `getTemplateMeta('report.bigfive')` 处报 `50011`。
   *
   * 上面那批通用断言只能证明"模板们彼此自洽"，证明不了**这个键真的存在**，
   * 也证明不了它的内容真的是大五而不是 MBTI 文案换个标题，因此单独钉住。
   */
  describe('大五报告模板（BIG_FIVE_REPORT）', () => {
    const bigFive = (): (typeof PROMPT_TEMPLATES)[number] | undefined =>
      PROMPT_TEMPLATES.find((template) => template.key === 'report.bigfive');

    it('【关键】键名与 report.service.ts 的 TEMPLATE_KEY_BY_TYPE 一致（否则该报告类型开箱即 50011）', () => {
      // `TEMPLATE_KEY_BY_TYPE` 未导出，这里按它当前的字面值断言：改动任一侧都会让这条断红
      expect(bigFive()?.key).toBe('report.bigfive');
      // 用真实类型：`prompt_type` 已补 BIG_FIVE_REPORT（迁移 20261013000000），
      // 后台按类型筛选时不会再与 MBTI 模板混在一起
      expect(bigFive()?.type).toBe('BIG_FIVE_REPORT');
      expect(Object.values(PromptType)).toContain('BIG_FIVE_REPORT');
    });

    it('【关键】能用真实上下文渲染成功（占位符全有值、无残留）', () => {
      const template = bigFive();
      expect(template).toBeDefined();
      if (template === undefined) return;

      const rendered = renderPromptVersion(
        { systemPrompt: template.systemPrompt, userPromptTemplate: template.userPromptTemplate },
        buildReportContext(fullProfile()).variables,
      );

      expect(rendered.user).not.toContain('{{');
      expect(rendered.system).not.toContain('{{');
      expect(rendered.usedVariables.length).toBeGreaterThan(3);
      // 五项的真实分数与档位确实进了 Prompt（不是只写了一句"请解读大五"就完事）
      expect(rendered.user).toContain('开放性 84（高）');
    });

    it('【关键】内容真的围绕大五五个特质（不能是 MBTI 文案换个标题）', () => {
      const template = bigFive();
      expect(template).toBeDefined();
      if (template === undefined) return;

      // 中文名直接取自上下文组装代码：改名会顶红这条断言，逼模板同步
      // （与"占位符必须真实存在"是同一种跨模块约束）
      for (const label of Object.values(BIG_FIVE_LABELS)) {
        expect(template.systemPrompt).toContain(label);
      }

      // 且不引用任何 MBTI 专属变量：一旦引用，就说明这份报告是 MBTI 版换了个标题
      const placeholders = placeholdersOf(template);
      for (const mbtiOnly of ['mbtiType', 'mbtiTypeName', 'mbtiGroup', 'mbtiTagline', 'dimensionEI', 'mbtiStrengths']) {
        expect(placeholders).not.toContain(mbtiOnly);
      }
      // 大五数据必须真的被引用（拿 MBTI 变量充数会在这里失败）
      expect(placeholders).toContain('bigFiveSummary');
    });

    it('首段免费预览（用户先看到五项档位再决定付费）', () => {
      expect(bigFive()?.sections[0]?.freePreview).toBe(true);
    });

    it('【关键】按提示词要求的标题生成的正文，能被分段解析器切回声明的段落键', () => {
      const template = bigFive();
      expect(template).toBeDefined();
      if (template === undefined) return;

      // 模拟"模型严格按提示词里给定的标题输出"：标题取自模板声明，
      // 而那批标题正是提示词里要求逐字使用的（两者由 buildSectionFormatInstruction 派生，不可能分叉）
      const modelOutput = [
        '这五项特质共同勾勒出一个稳健而好奇的你。',
        ...template.sections.map((section) => `## ${section.title}\n这是「${section.title}」的正文。`),
      ].join('\n');

      const parsed = parseReportSections(modelOutput, readExpectedSections({ sections: template.sections }));

      // 段落键必须逐个对上：对不上就会被塞进 `extra-{n}` 兜底键、付费段位与权益随之错位
      expect(parsed.sections.map((section) => section.sectionKey)).toEqual(
        template.sections.map((section) => section.key),
      );
      expect(parsed.extraSectionKeys).toEqual([]);
      expect(parsed.droppedSectionKeys).toEqual([]);
      // 免费预览长度必须 > 0，否则打开报告就是空的免费段
      expect(parsed.freePreviewLength).toBeGreaterThan(0);
    });
  });

  /**
   * 成长回顾报告模板
   *
   * `GROWTH_SUMMARY` 是 `report.dto.ts` 明示支持的类型，`report.service.ts` 的
   * `TEMPLATE_KEY_BY_TYPE` 把它指向 `report.growth` —— 模板一旦缺失，用户请求就会
   * 在 `getTemplateMeta('report.growth')` 处报 `50011`。
   *
   * 但"模板存在"还不够。这个类型最危险的失败形态是：**拿单画像上下文渲染出一份
   * 标题写着"成长回顾"的报告** —— 内容读起来毫无破绽，实际与"成长"毫无关系
   * （用户会付费，且察觉不到任何异常，比明确报错更伤用户）。
   * 因此这一组除了键名，还专门钉住"真的用到了多版本对比变量"。
   */
  describe('成长回顾报告模板（GROWTH_SUMMARY）', () => {
    const growth = (): (typeof PROMPT_TEMPLATES)[number] | undefined =>
      PROMPT_TEMPLATES.find((template) => template.key === 'report.growth');

    const growthVariables = (dataComplete: boolean): Readonly<Record<string, string>> =>
      buildGrowthReportContext(dataComplete ? fullGrowthContext() : emptyGrowthContext()).variables;

    it('【关键】键名与 report.service.ts 的 TEMPLATE_KEY_BY_TYPE 一致（否则该报告类型开箱即 50011）', () => {
      // `TEMPLATE_KEY_BY_TYPE` 未导出，这里按它当前的字面值断言：改动任一侧都会让这条断红
      expect(growth()?.key).toBe('report.growth');
      // 用真实类型：`prompt_type` 已补 GROWTH_SUMMARY（迁移 20261013000000），
      // 后台按类型筛选时不会再与 MBTI / 大五模板混在一起
      expect(growth()?.type).toBe('GROWTH_SUMMARY');
      expect(Object.values(PromptType)).toContain('GROWTH_SUMMARY');
    });

    it('【关键】能用真实的多画像上下文渲染成功（占位符全有值、无残留）', () => {
      const template = growth();
      expect(template).toBeDefined();
      if (template === undefined) return;

      const rendered = renderPromptVersion(
        { systemPrompt: template.systemPrompt, userPromptTemplate: template.userPromptTemplate },
        growthVariables(true),
      );

      expect(rendered.user).not.toContain('{{');
      expect(rendered.system).not.toContain('{{');
      expect(rendered.usedVariables.length).toBeGreaterThan(3);
    });

    it('【关键】数据全缺时同样能渲染成功（占位文案保证模板不会因缺数据而 50012）', () => {
      const template = growth();
      expect(template).toBeDefined();
      if (template === undefined) return;

      const rendered = renderPromptVersion(
        { systemPrompt: template.systemPrompt, userPromptTemplate: template.userPromptTemplate },
        growthVariables(false),
      );

      expect(rendered.user).not.toContain('{{');
      expect(rendered.system).not.toContain('{{');
      expect(rendered.user).toContain('（本次测评未包含此项）');
    });

    it('【关键】真的用到了"跨版本"变量，而不是只用最新一版（否则就是个人报告换个标题）', () => {
      const template = growth();
      expect(template).toBeDefined();
      if (template === undefined) return;

      const placeholders = placeholdersOf(template);

      // 时间线 / 变化量 / 变了什么 / 没变什么 —— 这四条是"成长报告"与"个人报告"的分界线
      for (const name of [
        'profileCount',
        'periodText',
        'growthTimeline',
        'scoreDeltas',
        'changedTraits',
        'stableTraits',
      ]) {
        expect(placeholders).toContain(name);
      }

      // 渲染后必须真的出现**两版以上**的轨迹，以及基于同维度真实数值的变化量
      const rendered = renderPromptVersion(
        { systemPrompt: '', userPromptTemplate: template.userPromptTemplate },
        growthVariables(true),
      );

      expect(rendered.user).toContain('2026-01-05');
      expect(rendered.user).toContain('2026-03-18');
      expect(rendered.user).toContain('2026-06-20');
      expect(rendered.user).toContain('开放性 62 → 78（+16）');
      expect(rendered.user).toContain('神经质 55 → 40（-15）');
      // 最新一版的信息也在（"现在是什么样"是轨迹的终点，不是全部）
      expect(rendered.user).toContain('ENFP');
      expect(rendered.user).toContain('竞选者');
    });

    it('【关键】不引用单画像专属变量（引用它就意味着这份报告已经退化成个人报告）', () => {
      const template = growth();
      expect(template).toBeDefined();
      if (template === undefined) return;

      const placeholders = placeholdersOf(template);

      for (const singleProfileOnly of [
        'mbtiType',
        'mbtiTypeName',
        'mbtiGroup',
        'dimensionEI',
        'mbtiStrengths',
        'bigFiveSummary',
        'attachmentStyle',
      ]) {
        expect(placeholders).not.toContain(singleProfileOnly);
      }
      // 变体变量必须来自成长族（`latest*` 前缀）
      expect(placeholders).toContain('latestBigFiveSummary');
      expect(placeholders).toContain('latestMbtiType');
    });

    it('【关键】写清了"变化量方向"的含义：大五没有好坏、上升不等于成长', () => {
      const template = growth();

      expect(template?.systemPrompt).toContain('没有好坏');
      // 神经质的方向必须写死（否则模型会把"数值越高"读成"越稳定"）
      expect(template?.systemPrompt).toContain('神经质');
      expect(template?.systemPrompt).toContain('越高');
      // 只依据给出的时间线，不得编造未提供的版本/数据
      expect(template?.systemPrompt).toContain('编造');
      expect(template?.systemPrompt).toContain('时间线');
      // ADR-005 底线（与其它报告模板同源，但再钉一次）
      expect(template?.systemPrompt).toContain('绝不重新计算');
      expect(template?.systemPrompt).toContain('不得重新计算');
    });

    it('首段免费预览（用户先看到自己的轨迹再决定付费）', () => {
      const template = growth();

      expect(template?.sections[0]?.key).toBe('growth_timeline');
      expect(template?.sections[0]?.freePreview).toBe(true);
      // 段落键是自由标识符（落 `report_sections.section_key`），不是 compatibility_reports 的列
      expect(template?.sections).toHaveLength(4);
      expect(template?.sections.map((section) => section.key)).toEqual([
        'growth_timeline',
        'trait_changes',
        'stable_patterns',
        'next_steps',
      ]);
    });

    it('【关键】按提示词要求的标题生成的正文，能被分段解析器切回声明的段落键', () => {
      const template = growth();
      expect(template).toBeDefined();
      if (template === undefined) return;

      const modelOutput = [
        '这半年你在开放性上明显打开，神经质则明显回落。',
        ...template.sections.map((section) => `## ${section.title}\n这是「${section.title}」的正文。`),
      ].join('\n');

      const parsed = parseReportSections(modelOutput, readExpectedSections({ sections: template.sections }));

      expect(parsed.sections.map((section) => section.sectionKey)).toEqual(
        template.sections.map((section) => section.key),
      );
      expect(parsed.extraSectionKeys).toEqual([]);
      expect(parsed.droppedSectionKeys).toEqual([]);
      expect(parsed.freePreviewLength).toBeGreaterThan(0);
    });
  });

  /**
   * 对话模板（AI 情感助手）
   *
   * 上面那批断言已经覆盖了"占位符名对得上"，但**对不上的一半**仍然可能出问题：
   * 键名不在候选链里（模板建了却不生效，线上照样 50011），
   * 或者模板自己又包了一层定界符（定界结构被拆成两段）。
   * 这两条都不会被占位符比对发现，因此单独钉住。
   */
  describe('对话模板（AI 情感助手）', () => {
    const companion = (): (typeof PROMPT_TEMPLATES)[number] | undefined =>
      PROMPT_TEMPLATES.find((template) => template.key === 'ai.companion');

    it('【关键】对话模板的键在 chat-prompt.ts 的候选链里（否则建了也不生效，仍报 50011）', () => {
      const template = companion();

      expect(template).toBeDefined();
      expect(templateKeyCandidatesOf('AI_COMPANION')).toContain(template?.key);
    });

    it('【关键】对话模板能用 buildPromptVariables() 真实渲染（无残留占位符）', () => {
      const template = companion();
      expect(template).toBeDefined();

      const rendered = renderPromptVersion(
        { systemPrompt: template?.systemPrompt ?? '', userPromptTemplate: template?.userPromptTemplate ?? '' },
        fullChatVariables(),
      );

      expect(rendered.system.length).toBeGreaterThan(0);
      expect(rendered.user.length).toBeGreaterThan(0);
      // 渲染器对"模板写了占位符但没给值"是硬失败，能走到这里就说明变量全给了；
      // 再确认没有残留（`{{` 只会来自没被识别成占位符的错误写法）
      expect(rendered.user).not.toContain('{{');
      expect(rendered.system).not.toContain('{{');
      expect(rendered.usedVariables.length).toBeGreaterThan(3);
    });

    it('【关键】定界符由代码包裹，模板不得自己再包一层', () => {
      const template = companion();
      const rendered = renderPromptVersion(
        { systemPrompt: '', userPromptTemplate: template?.userPromptTemplate ?? '' },
        fullChatVariables(),
      );

      // `wrapUserInput` 恰好产出 1 组定界符（见 chat-context.util.ts）；
      // 模板若自己再写一次 `<user_data>`，注入面会被拆成两段
      expect(rendered.user.match(/<user_data>/g) ?? []).toHaveLength(1);
      expect(rendered.user.match(/<\/user_data>/g) ?? []).toHaveLength(1);
      expect(rendered.user).toContain('他昨天又说我想太多，我一句话都不想说了。');
    });
  });
});
