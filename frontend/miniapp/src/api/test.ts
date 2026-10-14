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

/** 试卷快照中的题目（与后端 `PaperQuestion` 对齐） */
export interface PaperQuestion {
  order: number;
  questionId: string;
  code: string;
  content: string;
  type: QuestionType;
  dimension: string;
  reverseScored: boolean;
  weight: number;
  tags: string[];
  options: Array<{ label: string; value: number }>;
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
export type TestSessionResult = PersonalitySessionResult | EmotionSessionResult;

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
