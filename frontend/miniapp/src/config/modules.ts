/**
 * 三个测评模块的前端展示配置（ADR-038）
 *
 * ## 为什么需要这个文件
 *
 * 后端把三个模块在数据层与接口层彻底分开了，但**用户看到的文案**必须在同一处定义：
 * 介绍页说"约 5 分钟了解你的人格轮廓"、结果页说"你的人格类型是"、
 * 生成报告时调 `MBTI_REPORT` —— 这三件事是同属"人格模块"的一组事实。
 * 散落在三个页面里各写一遍，改一处就会漏另一处，而漏了不会报错，
 * 只会让情感测评的介绍页继续写着"MBTI + 大五人格双模型测评"。
 *
 * ## 为什么不用后端的 `name` / `description`
 *
 * 后端的 `test_definitions.name/description` 是**运营可改**的（后台能编辑），
 * 它们描述的是"这份量表是什么"；而这里的文案是**界面骨架**的一部分
 * （标题怎么写、结果页有几块、按钮点了生成什么报告）。
 * 两者职责不同：运营改了量表名，界面结构不该跟着变。
 *
 * ⚠ 未知模块（后端将来新增）走 `FALLBACK_MODULE`：按人格形态渲染 + 中性标题。
 * 这是有意的降级 —— 让用户看到一个措辞中性的页面，好过整页报错。
 */

/** 模块标识（与后端 `TestModule` 枚举对齐） */
export type TestModuleKey = 'PERSONALITY' | 'EMOTION' | 'MENTAL_HEALTH';

/** 一个模块的界面配置 */
export interface ModulePresentation {
  /** 模块标识 */
  key: TestModuleKey;
  /** 入口卡片标题（首页 / 测评中心） */
  entranceTitle: string;
  /** 入口卡片一句话说明 */
  entranceDesc: string;
  /** 入口卡片图标 */
  icon: string;
  /** 介绍页主标题 */
  introTitle: string;
  /** 介绍页说明 */
  introDesc: string;
  /** 介绍页第三个统计项的标签（前两项固定是题量与时长） */
  introMetricLabel: string;
  /** 该模块的统计项数值（作为服务端未下发时的兜底展示） */
  introMetricValue: string;
  /** 结果页标题栏文案 */
  resultTitle: string;
  /** 结果页分享文案前缀 */
  shareTitlePrefix: string;
  /**
   * 该模块的深度报告类型
   *
   * ⚠ 必须与后端 `REPORT_TYPES` 里的取值逐字一致：写错会在 DTO 层被拒（`10001`），
   * 而报错文案是"type 取值不合法"，与"模块配错了"毫无关联，排查成本很高。
   */
  reportType: 'MBTI_REPORT' | 'EMOTION_REPORT';
  /** 是否已上线（未上线的模块不在入口列表展示） */
  available: boolean;
}

const MODULES: Readonly<Record<TestModuleKey, ModulePresentation>> = {
  PERSONALITY: {
    key: 'PERSONALITY',
    entranceTitle: '人格测试',
    entranceDesc: '约 8 分钟，看清你的性格轮廓',
    icon: '🧭',
    introTitle: 'MBTI + 大五人格双模型测评',
    introDesc: '基于荣格类型学与五因素人格理论，从四个维度与五个特质描绘你的人格轮廓，再由 AI 生成个性化解读。',
    introMetricLabel: '个分析维度',
    introMetricValue: '15',
    resultTitle: '人格测试结果',
    shareTitlePrefix: '我的人格类型是',
    reportType: 'MBTI_REPORT',
    available: true,
  },
  EMOTION: {
    key: 'EMOTION',
    entranceTitle: '情感测评',
    entranceDesc: '约 8 分钟，看懂你在关系里的模式',
    icon: '💞',
    /**
     * ⚠ 文案刻意**不写"心理"与"诊断"**：情感测评谈的是亲密关系里的相处倾向，
     * 与人格测评是两回事。用户要能一眼分辨自己在做哪个模块，
     * 这也是 ADR-038「三个模块互不干扰」在界面上的要求。
     */
    introTitle: '情感测评｜你在亲密关系里的样子',
    introDesc:
      '基于依恋理论、爱的语言与冲突处理风格三个成熟模型，从 52 道题看清你在关系里的依恋倾向、最在意的被爱方式，以及有分歧时的反应。',
    introMetricLabel: '个关系维度',
    introMetricValue: '12',
    resultTitle: '情感测评结果',
    shareTitlePrefix: '我的依恋风格是',
    reportType: 'EMOTION_REPORT',
    available: true,
  },
  MENTAL_HEALTH: {
    key: 'MENTAL_HEALTH',
    entranceTitle: '心理健康测评',
    entranceDesc: '了解近期的状态',
    icon: '🌱',
    introTitle: '心理健康测评',
    introDesc: '从多个维度了解你近期的状态，并给出文字结论。本结果仅供参考，不构成任何专业建议。',
    introMetricLabel: '个维度',
    introMetricValue: '—',
    resultTitle: '心理健康测评结果',
    shareTitlePrefix: '我的测评结果',
    // 心理健康模块尚未落地（阶段 4）：先沿用个人报告类型，
    // `available: false` 保证它不会被渲染出来
    reportType: 'MBTI_REPORT',
    available: false,
  },
};

/** 未知模块的降级展示（后端新增模块时前端不至于整页报错） */
const FALLBACK_MODULE: ModulePresentation = {
  key: 'PERSONALITY',
  entranceTitle: '测评',
  entranceDesc: '完成测评，了解自己',
  icon: '📝',
  introTitle: '测评',
  introDesc: '完成下面的题目，获取属于你的解读。',
  introMetricLabel: '个维度',
  introMetricValue: '—',
  resultTitle: '测评结果',
  shareTitlePrefix: '我的测评结果是',
  reportType: 'MBTI_REPORT',
  available: true,
};

/** 取某模块的展示配置（未知模块走降级配置，不抛错） */
export const modulePresentation = (module: string | undefined | null): ModulePresentation =>
  MODULES[module as TestModuleKey] ?? FALLBACK_MODULE;

/** 已上线、可展示在入口列表里的模块 */
export const availableModules = (): ModulePresentation[] => Object.values(MODULES).filter((item) => item.available);

/** 依恋类型中文名（结果页展示用；未知编码原样输出，不猜） */
export const ATTACHMENT_STYLE_LABELS: Readonly<Record<string, string>> = {
  SECURE: '安全型',
  ANXIOUS: '焦虑型',
  AVOIDANT: '回避型',
  FEARFUL: '恐惧型',
};

/**
 * 爱的语言中文名（**情感模块自己的编码**）
 *
 * ⚠ 与 `relationship_style_rules` 规则表用的旧编码（`WORDS_OF_AFFIRMATION` 等）
 * 不是同一套，不要互相翻译 —— 前者是测量维度，后者是运营配置的产物。
 */
export const LOVE_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  LOVE_WORDS: '肯定的言辞',
  LOVE_TIME: '精心的时刻',
  LOVE_GIFTS: '接受礼物',
  LOVE_SERVICE: '服务的行动',
  LOVE_TOUCH: '身体的接触',
};

/** 冲突风格中文名（TKI 五种） */
export const CONFLICT_STYLE_LABELS: Readonly<Record<string, string>> = {
  CONFLICT_COLLABORATING: '协作型',
  CONFLICT_COMPROMISING: '妥协型',
  CONFLICT_ACCOMMODATING: '迁就型',
  CONFLICT_AVOIDING: '回避型',
  CONFLICT_COMPETING: '竞争型',
};

/** 各家的展示顺序（固定，保证同一份结果每次渲染顺序一致） */
export const LOVE_LANGUAGE_ORDER = ['LOVE_WORDS', 'LOVE_TIME', 'LOVE_GIFTS', 'LOVE_SERVICE', 'LOVE_TOUCH'] as const;

export const CONFLICT_STYLE_ORDER = [
  'CONFLICT_COLLABORATING',
  'CONFLICT_COMPROMISING',
  'CONFLICT_ACCOMMODATING',
  'CONFLICT_AVOIDING',
  'CONFLICT_COMPETING',
] as const;
