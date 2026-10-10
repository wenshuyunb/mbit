/**
 * 测试流程状态
 *
 * 职责：
 *   · 维护当前测试会话（sessionId、试卷快照、作答进度）
 *   · 答案草稿本地持久化，支持断点续答（杀进程/切后台后可恢复）
 *   · 批量提交答案（服务端按 UNIQUE(sessionId, questionId) upsert，天然幂等）
 *
 * 设计要点：
 *   · 服务端才是会话状态的权威来源；本地草稿仅用于「离线/异常退出」恢复
 *   · 每次作答立即写本地（同步写，量小），按节流周期同步服务端
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { createSession, getSession, saveAnswers, submitSession } from '@/api/test';
import type { PaperQuestion, TestPaper, TestSessionResult } from '@/api/test';
import { STORAGE_KEYS } from '@/config/constants';
import { storage } from '@/utils/storage';

/**
 * 类型再导出
 *
 * 契约定义在 `api/test.ts`（服务端契约层），这里只做再导出：
 *   · 保证「契约只有一个来源」，避免两处结构漂移
 *   · 依赖方向严格单向（store → api），不产生循环依赖
 */
export type { PaperQuestion, QuestionType, TestPaper, TestSessionResult as SubmitResult } from '@/api/test';

/** 会话恢复数据（本地草稿） */
export interface TestDraft {
  sessionId: string;
  definitionCode: string;
  answers: Record<string, number>;
  currentIndex: number;
  updatedAt: number;
}

/** 草稿同步节流间隔（毫秒） */
const SYNC_THROTTLE_MS = 2000;

export const useTestStore = defineStore('test', () => {
  // -------------------------------------------------------------------- state
  const paper = ref<TestPaper | null>(null);
  /** questionId → 选项分值 */
  const answers = ref<Record<string, number>>({});
  const currentIndex = ref<number>(0);
  const submitting = ref<boolean>(false);
  const lastSyncAt = ref<number>(0);
  /** 是否存在待同步的本地改动 */
  const dirty = ref<boolean>(false);

  // -------------------------------------------------------------------- getter
  const total = computed(() => paper.value?.totalCount ?? 0);
  const answeredCount = computed(() => Object.keys(answers.value).length);
  const progress = computed(() => (total.value === 0 ? 0 : Math.round((answeredCount.value / total.value) * 100)));
  const isComplete = computed(() => total.value > 0 && answeredCount.value >= total.value);
  const currentQuestion = computed<PaperQuestion | null>(() => paper.value?.questions[currentIndex.value] ?? null);

  // -------------------------------------------------------------------- action

  /**
   * 拉取试卷的全部批次并合并
   *
   * 服务端为控制响应体大小而分批下发（默认 20 题/批），但答题页需要完整的
   * 题目数组与总数，因此在进入答题页前一次性合并。题量只有 32–50 题，
   * 通常 2–3 批即可完成。
   */
  const fetchFullPaper = async (sessionId: string): Promise<TestPaper> => {
    const first = await getSession(sessionId, 1);

    const questions: PaperQuestion[] = [...first.paper.questions];

    for (let batch = 2; batch <= first.paper.totalBatches; batch += 1) {
      const page = await getSession(sessionId, batch);
      questions.push(...page.paper.questions);
    }

    return {
      sessionId: first.sessionId,
      testCode: first.testCode,
      testVersion: first.testVersion,
      engineVersion: first.engineVersion,
      status: first.status,
      totalCount: first.paper.questionsTotal,
      questions,
      expiresAt: first.expiresAt,
      answeredQuestionIds: first.paper.answeredQuestionIds,
      answerScale: first.paper.answerScale,
    };
  };

  /** 开始测试：创建会话并拿到完整试卷快照 */
  const startTest = async (
    definitionCode: string,
    options: { resume?: boolean; forceNew?: boolean } = {},
  ): Promise<TestPaper> => {
    // 先尝试恢复本地草稿，避免用户来回切页丢答案
    if (options.resume !== false) {
      const draft = getLocalDraft(definitionCode);
      if (draft) {
        try {
          const resumed = await fetchFullPaper(draft.sessionId);
          paper.value = resumed;
          answers.value = draft.answers;
          currentIndex.value = Math.min(draft.currentIndex, Math.max(0, resumed.questions.length - 1));
          dirty.value = false;
          return resumed;
        } catch {
          // 草稿已失效（服务端会话过期/被清理），走新建流程
          clearDraft();
        }
      }
    }

    // 服务端在存在未过期会话时会直接复用（不会重置进度），因此这里无需先查询
    const session = await createSession(definitionCode, { forceNew: options.forceNew ?? false });
    const created = await fetchFullPaper(session.sessionId);

    paper.value = created;
    // 服务端可能已有作答记录（复用会话），以其为准回填
    answers.value = {};
    currentIndex.value = Math.min(created.answeredQuestionIds.length, Math.max(0, created.questions.length - 1));
    dirty.value = false;
    saveLocalDraft();
    return created;
  };

  /** 作答一题（本地立即生效，服务端按节流同步） */
  const answer = (questionId: string, value: number): void => {
    answers.value = { ...answers.value, [questionId]: value };
    dirty.value = true;
    saveLocalDraft();

    const now = Date.now();
    if (now - lastSyncAt.value >= SYNC_THROTTLE_MS) {
      void syncAnswers();
    }
  };

  /** 移动到下一题 */
  const next = (): void => {
    if (!paper.value) return;
    currentIndex.value = Math.min(currentIndex.value + 1, paper.value.questions.length - 1);
    saveLocalDraft();
  };

  /** 移动到上一题 */
  const prev = (): void => {
    currentIndex.value = Math.max(currentIndex.value - 1, 0);
    saveLocalDraft();
  };

  /** 跳转到指定题号 */
  const goTo = (index: number): void => {
    if (!paper.value) return;
    currentIndex.value = Math.max(0, Math.min(index, paper.value.questions.length - 1));
    saveLocalDraft();
  };

  /** 同步答案到服务端（幂等：服务端按 sessionId+questionId upsert） */
  const syncAnswers = async (): Promise<void> => {
    const sessionId = paper.value?.sessionId;
    if (!sessionId || !dirty.value) return;

    const payload = Object.entries(answers.value).map(([questionId, value]) => ({ questionId, value }));

    try {
      await saveAnswers(sessionId, payload);
      dirty.value = false;
      lastSyncAt.value = Date.now();
    } catch (error) {
      // 同步失败不打断答题：本地草稿仍在，下次作答或提交时会重试
      console.warn('[test] 答案同步失败，将在下次作答时重试：', error);
    }
  };

  /** 提交测试：先强制同步全部答案，再提交算分（服务端同步算分，< 10ms） */
  const submit = async (): Promise<TestSessionResult> => {
    const sessionId = paper.value?.sessionId;
    if (!sessionId) {
      throw new Error('测试会话不存在，请重新开始测试');
    }

    submitting.value = true;
    try {
      // 提交前把剩余答案补齐，避免服务端判定「题目未作答完」而拒绝算分
      dirty.value = true;
      await syncAnswers();

      const result = await submitSession(sessionId);
      clearDraft();
      return result;
    } finally {
      submitting.value = false;
    }
  };

  /** 放弃测试 */
  const abandon = (): void => {
    paper.value = null;
    answers.value = {};
    currentIndex.value = 0;
    dirty.value = false;
    clearDraft();
  };

  // ------------------------------------------------------------------ 本地草稿

  const saveLocalDraft = (): void => {
    if (!paper.value) return;
    const draft: TestDraft = {
      sessionId: paper.value.sessionId,
      definitionCode: paper.value.testCode,
      answers: answers.value,
      currentIndex: currentIndex.value,
      updatedAt: Date.now(),
    };
    const key = `${STORAGE_KEYS.testDraft}_${paper.value.testCode}`;
    storage.set(key, draft);
  };

  const getLocalDraft = (definitionCode: string): TestDraft | null =>
    storage.get<TestDraft>(`${STORAGE_KEYS.testDraft}_${definitionCode}`);

  const clearDraft = (definitionCode?: string): void => {
    if (definitionCode) {
      storage.remove(`${STORAGE_KEYS.testDraft}_${definitionCode}`);
      return;
    }
    // 清理所有测试草稿（不同测试定义各一份）
    paper.value = null;
    storage.removeAll([
      `${STORAGE_KEYS.testDraft}_MBTI_FULL`,
      `${STORAGE_KEYS.testDraft}_MBTI_LITE`,
      `${STORAGE_KEYS.testDraft}_BIG_FIVE_50`,
    ]);
  };

  return {
    // state
    paper,
    answers,
    currentIndex,
    submitting,
    dirty,
    // getter
    total,
    answeredCount,
    progress,
    isComplete,
    currentQuestion,
    // action
    startTest,
    answer,
    next,
    prev,
    goTo,
    syncAnswers,
    submit,
    abandon,
    clearDraft,
  };
});
