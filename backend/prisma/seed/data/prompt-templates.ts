/**
 * Prompt 模板种子数据（ADR-014：Prompt 存数据库 + 版本化）
 *
 * 为什么模板必须是种子数据而不是代码常量：
 *   · 文案需要**不重启热更**（运营改一句话不该走发版流程）
 *   · 需要做 AB 测试（同一模板多版本按 `trafficWeight` 分流）
 *   · 需要留痕（`changeNote` / `publishedAt` / `publishedBy`，出问题能追溯是谁改的）
 *
 * ⚠ **占位符必须与 `buildReportContext` 产出的变量名完全一致**。
 *    两边任何一处笔误都会在运行时表现为 `50012 缺少必需变量`，
 *    而那时已经消耗了用户的一次生成请求。`prompt-templates.spec.ts` 用
 *    「逐模板提取占位符 → 与实际产出的变量名比对」把这条跨模块约束变成可执行测试。
 */

/** 模板类型（与 Prisma `PromptType` 对齐） */
export type SeedPromptType = 'REPORT' | 'COMPANION' | 'ANALYSIS' | 'EXTRACTION' | 'SAFETY';

/** 段落声明（写入 `PromptVersion.outputSchema.sections`，供分段解析器使用） */
export interface SeedPromptSection {
  /** 稳定段落键（被付费权益引用，一经发布不可更改） */
  key: string;
  /** 段落标题（以模板为准，保证跨次生成稳定） */
  title: string;
  /** 是否免费预览段 */
  freePreview: boolean;
}

/** Prompt 模板种子 */
export interface SeedPromptTemplate {
  /** 业务键，代码通过它取模板（如 `report.mbti`） */
  key: string;
  name: string;
  type: SeedPromptType;
  description: string;
  /** 初始版本号 */
  version: number;
  systemPrompt: string;
  userPromptTemplate: string;
  sections: SeedPromptSection[];
  /** 默认模型参数 */
  temperature: number;
  maxTokens: number;
  /** 变更说明 */
  changeNote: string;
}

/**
 * 系统提示词中的**合规与质量底线**
 *
 * 抽成常量是因为这些要求会出现在每一个报告模板里，
 * 复制粘贴时极易漏掉某一条（漏掉「不得重新算分」就等于让 AI 改写了算法结论）。
 */
const REPORT_SYSTEM_GUARDRAILS = [
  '你是一位资深的人格特质解读顾问，服务对象是普通用户，不是临床场景。',
  '',
  '必须遵守：',
  '1. 下面给出的人格分数是**既定的客观结果**，你只做解读，绝不重新计算、修正或质疑分数。',
  '2. 不做任何医疗、心理疾病的诊断或暗示；不出现「症状」「障碍」「治疗」等临床用语。',
  '3. 不使用绝对化断言（如「你一定会」「注定」），一律用倾向性表述（如「你可能倾向于」）。',
  '4. 不给出投资、医疗、法律等专业领域的具体建议。',
  '5. 语气温和、具体、可操作；避免空泛的赞美，也避免给人贴标签。',
  '6. 若某项数据标注为「本次测评未包含此项」，请明确说明该项本次无法解读，不要凭空推测。',
].join('\n');

/**
 * 分段格式约定（**由段落声明派生**）
 *
 * 关键：标题清单不能手写。之前手写过一版，结果提示词里写着
 * 「严格使用下面给定的三个标题」却没真的列出标题 —— 模型只能自己编，
 * 而分段解析器按模板声明的键去对齐，于是内容被塞进 `extra-{n}` 兜底键。
 * 从 `sections` 派生后，两者在结构上不可能分叉。
 */
const buildSectionFormatInstruction = (sections: readonly SeedPromptSection[]): string =>
  [
    '输出格式要求：',
    '- 用 Markdown 的二级标题（`## 标题`）分隔段落。标题必须**严格使用**下面给定的标题，顺序也保持一致：',
    ...sections.map((section) => `  - ${section.title}`),
    '- 不要输出任何其他级别的标题，也不要在正文里再嵌套小标题。',
    '- 第一个标题之前先写一句 30 字以内的全文概括（不带头部标记）。',
    '- 每个段落正文 150–300 字，分段清晰，不使用列表以外的复杂排版。',
  ].join('\n');

/** MBTI 报告的段落声明（首段免费预览） */
const MBTI_REPORT_SECTIONS: SeedPromptSection[] = [
  { key: 'overview', title: '整体印象', freePreview: true },
  { key: 'strengths', title: '核心优势', freePreview: false },
  { key: 'growth', title: '成长建议', freePreview: false },
];

/**
 * 关系（匹配）报告的段落声明
 *
 * 段落键与 `compatibility_reports` 表的列**一一对应**
 * （`advantages` / `conflicts` / `suggestions`），解析后可直接落库 ——
 * 键名对不上就只能靠位置猜，而位置在模型少写一段时必然错位。
 *
 * ⚠ **只能是三段**：表里恰好只有这三个 JsonB 列。曾设计过第四段「沟通话术示例」，
 * 但没有任何列能承载它 —— 结果是那段内容生成出来后**静默丢失**。
 * 因此把话术要求并入「相处建议」段（见模板末尾的补充说明），
 * 而不是加一段无处落库的声明。
 *
 * 首段免费预览：让用户先看到"你们合拍在哪"，再决定是否付费看分歧与建议。
 */
const RELATIONSHIP_REPORT_SECTIONS: SeedPromptSection[] = [
  { key: 'advantages', title: '契合优势', freePreview: true },
  { key: 'conflicts', title: '潜在分歧', freePreview: false },
  { key: 'suggestions', title: '相处建议', freePreview: false },
];

export const PROMPT_TEMPLATES: SeedPromptTemplate[] = [
  {
    key: 'report.mbti',
    name: 'MBTI 人格深度报告',
    type: 'REPORT',
    description: '基于 MBTI 四维倾向与大五特质生成个人深度解读报告（3 段：整体印象 / 核心优势 / 成长建议）',
    version: 1,
    systemPrompt: REPORT_SYSTEM_GUARDRAILS,
    userPromptTemplate: [
      '请为下面这位用户撰写人格深度解读报告。',
      '',
      '## 用户的人格数据',
      '- 类型：{{mbtiType}}（{{mbtiTypeName}}，{{mbtiGroup}}）',
      '- 类型标语：{{mbtiTagline}}',
      '- 四维倾向：{{dimensionEI}}；{{dimensionSN}}；{{dimensionTF}}；{{dimensionJP}}',
      '- 大五特质：{{bigFiveSummary}}',
      '- 依恋风格：{{attachmentStyle}}',
      '- 偏好的爱的语言：{{loveLanguages}}',
      '- 冲突处理风格：{{conflictStyle}}',
      '',
      '## 参考已知特征（仅供措辞参考，不要照抄）',
      '- 该类型的常见优势：{{mbtiStrengths}}',
      '- 该类型需要留意的地方：{{mbtiWatchouts}}',
      '',
      '## 数据质量（影响你解读时的确信程度）',
      '- 结果置信度：{{mbtiConfidence}}',
      '- 作答一致性：{{consistencyScore}}',
      '- 完成率：{{completionRate}}%',
      '- 平均作答耗时：{{avgResponseSeconds}} 秒/题',
      '- 作答题数：{{answeredRatio}}',
      '',
      buildSectionFormatInstruction(MBTI_REPORT_SECTIONS),
    ].join('\n'),
    sections: MBTI_REPORT_SECTIONS,
    temperature: 0.6,
    maxTokens: 2048,
    changeNote: '首个版本：3 段式个人报告，首段免费预览',
  },
  {
    key: 'report.relationship',
    name: '关系匹配解读报告',
    type: 'REPORT',
    description:
      '基于双方的 MBTI 与大五数据、以及 CompatibilityEngine 的确定性算分结果，生成 4 段关系解读（契合优势 / 潜在分歧 / 相处建议 / 沟通话术）',
    version: 1,
    systemPrompt: [
      REPORT_SYSTEM_GUARDRAILS,
      '',
      '本次任务补充要求：',
      '7. 契合度分数由确定性算法给出，是**既定事实**；你的职责是解释"这个分数从何而来、意味着什么"，不是评分。',
      '8. 不评判这段关系的价值，不建议分手或继续；只描述相处中的具体现象与可尝试的做法。',
      '9. 双方都是独立的个体，描述分歧时用"你们在某些方面节奏不同"，而不是"他不合适你"。',
    ].join('\n'),
    userPromptTemplate: [
      '请为下面这段{{relationTypeName}}关系撰写匹配解读报告。',
      '',
      '## 关系背景',
      '- 关系类型：{{relationTypeName}}（对对方的称呼：{{counterpartLabel}}）',
      '- 已建立：{{daysTogether}} 天',
      '',
      '## 契合度算分结果（确定性算法产出，不得重新计算）',
      '- 综合契合度：{{totalScore}} 分（{{scoreLevel}}）',
      '- 分项得分：{{subScores}}',
      '- 分项明细：{{scoreBreakdown}}',
      '- 未参与算分的维度：{{skippedDimensions}}',
      '',
      '## 你的用户（报告读者）',
      '- 类型：{{myMbtiType}}（{{myMbtiTypeName}}）',
      '- 四维倾向：{{myDimensions}}',
      '- 大五特质：{{myBigFive}}',
      '- 依恋风格：{{myAttachmentStyle}}',
      '- 偏好的爱的语言：{{myLoveLanguages}}',
      '- 冲突处理风格：{{myConflictStyle}}',
      '',
      '## 对方',
      '- 类型：{{partnerMbtiType}}（{{partnerMbtiTypeName}}）',
      '- 四维倾向：{{partnerDimensions}}',
      '- 大五特质：{{partnerBigFive}}',
      '- 依恋风格：{{partnerAttachmentStyle}}',
      '- 偏好的爱的语言：{{partnerLoveLanguages}}',
      '- 冲突处理风格：{{partnerConflictStyle}}',
      '',
      '## 参考已知特征（仅供措辞参考，不要照抄）',
      '- 读者所属类型的常见优势：{{myTypeStrengths}}',
      '- 读者所属类型需要留意的地方：{{myTypeWatchouts}}',
      '- 对方所属类型的常见优势：{{partnerTypeStrengths}}',
      '- 对方所属类型需要留意的地方：{{partnerTypeWatchouts}}',
      '',
      buildSectionFormatInstruction(RELATIONSHIP_REPORT_SECTIONS),
      '',
      '「相处建议」这一段请在结尾附上 2–3 组沟通对照：先写一句常见的无效表达，再写一句更可能被接受的表达。',
      '（不要把话术单独另起一段 —— 本报告的段落数是固定的。）',
    ].join('\n'),
    sections: RELATIONSHIP_REPORT_SECTIONS,
    // 比个人报告略低：关系解读容易被写成"星座配对"式的空泛套话，
    // 降低随机性可以让输出更贴着给定的分项数据
    temperature: 0.5,
    maxTokens: 2560,
    changeNote: '首个版本：4 段式关系解读，首段免费预览',
  },
];
