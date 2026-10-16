/**
 * 测试与题库接口
 *
 * 对应后端模块：test（题库不写死在代码里，全部由服务端下发）
 *
 * 契约对齐说明：算分结果的类型定义在本文件（而不是 `store/test.ts`），
 * 因为它是**服务端契约**；store 只负责流程状态，不应持有契约定义。
 * 若后端调整响应结构，只需改这里并让 vue-tsc 报出所有受影响的使用点。
 */

import { createIdempotencyKey } from '@/utils/request-id';

import { http, httpPage } from './request';
import type { PaginatedData } from './types';

/** 题型（与后端 `QuestionType` 对齐） */
export type QuestionType = 'LIKERT5' | 'BINARY' | 'FORCED_CHOICE' | 'RANK';

/** 进入来源埋点（与后端 `TEST_SOURCES` 对齐，避免编译期放行非法值） */
export type TestSource = 'HOME' | 'TEST_CENTER' | 'SHARE' | 'INVITE' | 'REPORT';

/** 测试定义（列表项） */
export interface TestDefinition {
  code: string;
  name: string;
  category: string;
  /**
   * 所属模块（ADR-038）：`PERSONALITY` / `EMOTION` / `MENTAL_HEALTH`
   *
   * 前端靠它决定介绍页文案、结果页形态与报告类型。
   * 用 `string` 而不是联合类型：后端将来加模块时，前端应当**优雅降级**
   * （按人格模板渲染 + 一个中性标题），而不是编译失败导致整个 H5 构建挂掉。
   */
  module: string;
  description: string | null;
  version: string;
  questionCount: number;
  estimatedMinutes: number;
  coverUrl: string | null;
  /** 当前用户已完成（已算分）次数 */
  completedCount: number;
  /** 是否存在进行中的会话 */
  hasInProgress: boolean;
}

/** 批量提交答案的元素 */
export interface AnswerItem {
  questionId: string;
  /** 选项分值（选择题）或数组（排序题） */
  value: number | number[];
  /** 作答耗时（毫秒），用于答题质量分析 */
  responseMs?: number;
}

/** 会话进度 */
export interface SessionProgress {
  totalQuestions: number;
  answeredCount: number;
  currentIndex: number;
  completionRate: number;
}

/**
 * 试卷快照中的题目（与后端 `PaperQuestion` 对齐）
 *
 * ## 两种题型共用这一个结构（ADR-039）
 *
 * | 字段              | 量表题（MBTI / 大五 / 状态自评） | 沉浸式场景题（情感测评） |
 * | ----------------- | ------------------------------- | ------------------------ |
 * | `content`         | 一句陈述句                      | **情境叙述**（一段处境） |
 * | `scenarioPrompt`  | `null`                          | 提问句（"你会怎么做？"） |
 * | `options[].label` | 五级同意程度                    | 一个具体做法             |
 * | `options[].feedback` | `null`                       | 该做法的即时反馈         |
 *
 * ⚠ 选项的 `scoreMap`（算分依据）**不下发** —— 那是评分键，客户端不需要。
 */
export interface PaperQuestion {
  order: number;
  questionId: string;
  code: string;
  content: string;
  /** 场景题的提问句；量表题为 `null`（题干本身即陈述） */
  scenarioPrompt?: string | null;
  type: QuestionType;
  dimension: string;
  reverseScored: boolean;
  weight: number;
  tags: string[];
  options: Array<{
    label: string;
    value: number;
    /** 选中该做法后的即时反馈；量表题为 `null` */
    feedback?: string | null;
  }>;
}

/** 会话视图（创建 / 断点续答返回） */
export interface TestSessionView {
  sessionId: string;
  userId: string;
  testCode: string;
  testVersion: string;
  engineVersion: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  remainingSeconds: number;
  isReused: boolean;
  progress: SessionProgress;
  paper: {
    snapshotVersion: string;
    /**
     * 本次取用的题目适用人群（ADR-039）
     *
     * 情感场景题按性别分男 / 女 / 中性三套独立内容，这个字段说明"手上这份试卷
     * 是哪一套"（界面可据此标注，排障时也一眼能对上）。量表题为 `ALL`。
     */
    audience?: 'ALL' | 'MALE' | 'FEMALE' | 'NEUTRAL';
    questionsPerPage: number;
    shuffled: boolean;
    optionShuffled: boolean;
    answerScale: { type: string; labels: string[]; values: number[] };
    questions: PaperQuestion[];
    questionsTotal: number;
    questionsReturned: number;
    /** 已作答题目 ID（前端据此回填答案与定位到第一道未答题） */
    answeredQuestionIds: string[];
    batch: number;
    totalBatches: number;
    hasMore: boolean;
    nextBatch: number | null;
  };
}

/** 批量保存答案结果 */
export interface SaveAnswersResult {
  saved: number;
  progress: SessionProgress;
  serverAt: string;
}

/** MBTI 维度视图 */
export interface MbtiDimensionResult {
  /** 0–100；≥ 50 偏向 `rightLabel` 对应字母（正极） */
  percent: number;
  pole: string;
  leftLabel: string;
  rightLabel: string;
}

/**
 * 算分结果（与后端 `SubmitResultView` 严格对齐）
 *
 * ⚠ **按 `module` 判别的联合类型**（ADR-038 阶段 3）。不是"一个包含全部可选字段的
 * 大对象"：那样人格结果页会莫名其妙地暴露情感字段，而情感结果页也会看到
 * `mbtiType: null` —— 前端只能靠"字段在不在"去猜自己在渲染哪个模块，
 * 猜错的表现是页面出现一堆 `undefined`，而不是一个明确的类型错误。
 */
export type TestSessionResult = PersonalitySessionResult | EmotionSessionResult | MentalHealthSessionResult;

/**
 * 心理状态自评的**解读层**（2026-10-16 补）
 *
 * 用户的实测反馈是「心理评测报告没有特色，没有建设性建议，我看不出个所以然来」。
 * 改版前那一屏只有档位一句话 + 六条分数 + 一段结论：**分数有了，含义没有；
 * 结论有了，下一步没有**。这一块补的就是这两件事，全部由服务端**确定性规则**生成
 * （不是 AI 写的，同一份作答任何时候都得到同一份内容）：
 *
 *   · `readings`    每维一句人话 + 一句"偏高时通常是什么体验"（让用户对号入座）
 *   · `highlights`  最值得留意的 1–2 项（前端做成大卡片，一屏先给重点）
 *   · `endorsement` 去污名化的一句（"这很常见，不是你的性格问题"）
 *   · `suggestions` 三条**当天就能做**的小事，每条含 做什么 / 为什么 / 什么时候做
 *   · `support`     分档的求助指引 + 官方心理援助热线（**三档都给**）
 *   · `retestHint`  两周后再测一次（把单次分数变成趋势）
 */
export interface MentalHealthReportExtras {
  readings: Array<{
    key: string;
    label: string;
    score: number;
    band: string;
    bandLabel: string;
    usable: boolean;
    /** 这一维在测什么 */
    meaning: string;
    /** 这一维偏高时，通常是什么体验 */
    commonExperience: string;
  }>;
  highlights: MentalHealthReportExtras['readings'];
  endorsement: string;
  suggestions: Array<{
    /** 做什么（当天可做的动作） */
    action: string;
    /** 为什么有用（扣回这一维的测量含义） */
    reason: string;
    /** 什么时候做（可自检的时机） */
    when: string;
    /** 它针对哪一维 */
    dimension: string;
    dimensionLabel: string;
  }>;
  support: {
    title: string;
    text: string;
    hotline: { name: string; number: string; note: string };
  };
  retestHint: string;
}

/**
 * 心理健康测评的算分结果（ADR-038 阶段 4 → 2026-10-16 加厚）
 *
 * ⚠ 这个结果里有**三样别处没有的东西**，都是产品要求：
 *   · `conclusion` —— 文字结论，服务端用**确定性规则**生成（不是 AI 现编的）；
 *   · `report` —— 解读层（每维人话 / 重点项 / 可执行建议 / 求助指引 / 复测引导），
 *     同样由确定性规则生成；
 *   · `disclaimer` —— 合规声明（含「本结果仅供参考」），由服务端下发，
 *     前端**不得**硬编码。
 *
 * 本模块**没有** AI 报告（见 `config/modules.ts` 里 `reportType: null` 的说明）：
 * 一份"AI 深度解读"几乎不可能只陈述而不越界，因此它的解读是**规则生成**的。
 */
export interface MentalHealthSessionResult extends SessionResultEnvelope {
  module: 'MENTAL_HEALTH';
  result: {
    /** 六维（按固定顺序，服务端已排好） */
    dimensions: Array<{
      key: string;
      label: string;
      /** 0–100，越高越值得留意 */
      score: number;
      band: string;
      bandLabel: string;
      /** 是否为"最值得留意"的项 */
      isHighlighted: boolean;
    }>;
    overallScore: number;
    overallLevel: string;
    overallLabel: string;
    /** 文字结论 */
    conclusion: string;
    /** 解读层（每维人话 / 重点项 / 三条建议 / 求助指引 / 复测引导） */
    report: MentalHealthReportExtras;
    quality: SessionQuality;
    /** 合规声明（含「本结果仅供参考」） */
    disclaimer: string;
  };
}

/** 提交结果的外壳（两个模块共用） */
interface SessionResultEnvelope {
  sessionId: string;
  status: string;
  submittedAt: string;
  scoredAt: string;
  scoringDurationMs: number;
  resultId: string;
  profileId: string;
  profileVersion: number;
  engineVersion: string;
  /** true 表示本次是重复提交，返回的是既有结果（未重新算分） */
  isDuplicate: boolean;
}

/** 两个模块共用的质量块 */
export interface SessionQuality {
  consistencyScore: number;
  completionRate: number;
  avgResponseMs: number | null;
  rushRate: number;
  /** 置信度偏低时的提示文案；达标时为 null */
  notice: string | null;
}

/** 人格测评的算分结果 */
export interface PersonalitySessionResult extends SessionResultEnvelope {
  module: 'PERSONALITY';
  result: {
    /** 题量不足等异常情况下可能为 null（正常流程不会出现） */
    mbtiType: string | null;
    dimensions: Record<string, MbtiDimensionResult>;
    /** 结果置信度 0–100（各维度偏离中位的程度） */
    confidence: number;
    bigFive: Record<string, number>;
    quality: SessionQuality;
  };
}

/**
 * 情感测评的**确定性结论**（结果页直接展示，ADR-039 补）
 *
 * ⚠ 它**不是 AI 生成**的：由服务端按固定规则从画像算出，同一份画像任何时候
 * 都得到同一段话。之所以要有它，是因为结果页原先只有"标签 + 分数" ——
 * 用户看完不知道这意味着什么、自己需要什么、该做什么。
 *
 * 深度解读（更细的举例与个性化建议）仍由用户主动生成的 AI 报告承担。
 */
export interface EmotionConclusion {
  /** 一句话画像（最先看到的那句） */
  headline: string;
  /** 依恋姿态的人话解读（含两轴分数与档位） */
  portrait: string;
  /** 你在关系里最需要什么 */
  needs: string;
  /** 有分歧时的你 */
  conflict: string;
  /** 你在关系里的优势 */
  strengths: string[];
  /** 可以立刻开始做的三件事 */
  suggestions: string[];
  /** 合规提示（服务端下发，前端原样展示） */
  note: string;
}

/** 情感测评的算分结果（依恋双轴 + 爱的语言 + 冲突风格） */
export interface EmotionSessionResult extends SessionResultEnvelope {
  module: 'EMOTION';
  result: {
    attachment: {
      style: string;
      /** 依恋焦虑轴 0–100 */
      anxiety: number;
      /** 依恋回避轴 0–100 */
      avoidance: number;
      thresholds: { anxiety: number; avoidance: number };
    };
    loveLanguage: {
      /** 五项得分（键为 `LOVE_*`） */
      scores: Record<string, number>;
      /** 主导项（按分数降序，最多两项） */
      primary: string[];
    };
    conflict: {
      scores: Record<string, number>;
      style: string;
    };
    /** 见 `EmotionConclusion` 的说明 */
    conclusion: EmotionConclusion;
    quality: SessionQuality;
  };
}

/** 历史会话列表项 */
export interface SessionHistoryItem {
  sessionId: string;
  testCode: string;
  testName: string;
  status: string;
  mbtiType: string | null;
  answeredCount: number;
  totalQuestions: number;
  createdAt: string;
  submittedAt: string | null;
  scoredAt: string | null;
}

/**
 * 合并全部批次后的试卷视图
 *
 * 服务端把试卷**分批**下发（默认 20 题/批）以控制响应体大小，
 * 但答题页需要「一次拿到全部题目与总数」，因此由调用方拉取各批后合并成此结构。
 * 字段名与后端保持一致，避免两套命名互转。
 */
export interface TestPaper {
  sessionId: string;
  testCode: string;
  testVersion: string;
  engineVersion: string;
  status: string;
  totalCount: number;
  questions: PaperQuestion[];
  /** 会话过期时间（ISO 8601 UTC） */
  expiresAt: string;
  /** 服务端已记录的作答题目 ID（断点续答时回填） */
  answeredQuestionIds: string[];
  /** 量表说明（前端渲染李克特刻度用） */
  answerScale: { type: string; labels: string[]; values: number[] };
}

/** 获取全部测试定义 */
export const listTests = (): Promise<TestDefinition[]> => http.get<TestDefinition[]>('/tests');

/** 获取测试定义详情 */
export const getTest = (code: string): Promise<TestDefinition> => http.get<TestDefinition>(`/tests/${code}`);

/**
 * 开始测试：创建会话并返回第一批试卷
 *
 * 服务端会固化试卷快照；若已存在未过期的进行中会话则直接复用（`isReused = true`），
 * 因此重复调用是安全的（不会重置进度）。
 *
 * ⚠ **幂等键是必填的**：后端 `@IdempotencyKey()` 默认 required，缺 `X-Idempotency-Key`
 * 头会直接抛 `400 / 10009`（`IDEMPOTENCY_KEY_MISSING`）—— 本函数此前没有传，
 * 导致「开始测试」对**所有客户端 100% 失败**（实测：带上该头才返回 201）。
 * 现在由本函数自动生成，从根上避免「忘记传」再次发生；
 * 若要重试同一个「开始测试」意图（例如网络失败后由用户点重试），
 * 应复用同一个 key：`createSession(code, { idempotencyKey: 上次的 key })`。
 */
export const createSession = (
  definitionCode: string,
  options: {
    forceNew?: boolean;
    reuseInProgress?: boolean;
    source?: TestSource;
    /** 重试同一意图时传入与首次相同的 key；不传则自动生成 */
    idempotencyKey?: string;
  } = {},
): Promise<TestSessionView> =>
  http.post<TestSessionView>(
    `/tests/${definitionCode}/sessions`,
    { reuseInProgress: options.reuseInProgress ?? true, forceNew: options.forceNew ?? false, source: options.source },
    { timeout: 20_000, idempotencyKey: options.idempotencyKey ?? createIdempotencyKey() },
  );

/** 获取会话（断点续答 / 分批取卷） */
export const getSession = (sessionId: string, batch = 1): Promise<TestSessionView> =>
  http.get<TestSessionView>(`/tests/sessions/${sessionId}`, { batch });

/** 批量提交/更新答案（服务端按 sessionId+questionId upsert，天然幂等） */
export const saveAnswers = (
  sessionId: string,
  answers: AnswerItem[],
  clientRevision?: number,
): Promise<SaveAnswersResult> =>
  http.put<SaveAnswersResult>(
    `/tests/sessions/${sessionId}/answers`,
    { answers, ...(clientRevision === undefined ? {} : { clientRevision }) },
    { showError: false },
  );

/** 提交并算分（同步返回画像；AI 报告在 Phase 3 异步生成） */
export const submitSession = (sessionId: string): Promise<TestSessionResult> =>
  http.post<TestSessionResult>(`/tests/sessions/${sessionId}/submit`, { confirm: true }, { timeout: 30_000 });

/** 历史测试会话列表 */
export const listSessions = (
  query: { page?: number; pageSize?: number; status?: string; definitionCode?: string } = {},
): Promise<PaginatedData<SessionHistoryItem>> => httpPage('/tests/sessions', query);

/** 某次会话的算分结果（未提交时返回 409） */
export const getSessionResult = (sessionId: string): Promise<TestSessionResult> =>
  http.get<TestSessionResult>(`/tests/sessions/${sessionId}/result`);
