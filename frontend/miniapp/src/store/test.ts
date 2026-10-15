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

  /**
   * 第一道**未作答**的题在试卷里的下标；全部答完时为 `-1`
   *
   * ## 为什么必须有它（2026-10-15 真实故障）
   *
   * 用户在 52 题的情感测评里做到了最后，提交却被服务端拒：「还有 4 道题未作答」。
   * 库里那 4 道是**散落**的（第 10、34、37、49 题），不是末尾 4 题 ——
   * 说明它们在答题过程中被**静默跳过**了：选项点击后有 180ms 的自动跳题延时，
   * 用户在这 180ms 内又点了一次「下一题」，两次 `next()` 叠加就跳过一题，
   * 而界面上除了计数器没有别的地方能发现。用户以为自己答完了。
   *
   * 所以光修跳题竞态不够 —— **必须让"漏答"变成可见、可操作的状态**：
   * 未答完时底部提示 + 一键跳到这道题。靠计数器让用户自己找是找不到的。
   */
  const firstUnansweredIndex = computed(() => {
    const questions = paper.value?.questions ?? [];
    return questions.findIndex((question) => answers.value[question.questionId] === undefined);
  });

  /** 还差几题没答 */
  const unansweredCount = computed(() => Math.max(0, total.value - answeredCount.value));

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

          /**
           * 落点：**有漏答就先补漏**，否则回到用户上次停留的题
           *
           * 漏答只可能来自异常路径（跳题竞态、跨设备续答），
           * 这时把用户直接送到第一道缺题，比让他自己从「48 / 52」里找要靠谱得多。
           * 没有缺口时保持用户自己的位置不动 —— 正常的回头检查不该被打断。
           */
          const gap = gapIndexOf(resumed.questions, new Set(Object.keys(draft.answers)));
          currentIndex.value = gap >= 0 ? gap : Math.min(draft.currentIndex, Math.max(0, resumed.questions.length - 1));

          dirty.value = false;
          return resumed;
        } catch {
          // 草稿已失效（服务端会话过期/被清理），走新建流程
          //
          // ⚠ 必须**显式传 definitionCode**：此刻 `paper.value` 可能还是上一场测试的试卷，
          // 不传参就会按那份旧试卷的 testCode 去删草稿（删错一份，当前这份永远留着）。
          clearDraft(definitionCode);
        }
      }
    }

    // 服务端在存在未过期会话时会直接复用（不会重置进度），因此这里无需先查询
    const session = await createSession(definitionCode, { forceNew: options.forceNew ?? false });
    const created = await fetchFullPaper(session.sessionId);

    paper.value = created;
    // 服务端可能已有作答记录（复用会话），以其为准回填
    answers.value = {};
    currentIndex.value = firstGapIndex(created);
    dirty.value = false;
    saveLocalDraft();
    return created;
  };

  /**
   * 断点续答时的落点：**第一道未作答的题**，而不是"答了几题就跳到第几题"
   *
   * 两者在"中间有跳过的题"时完全不同：`answeredIds.length` 是 48 而最后一题是第 52 题时，
   * 按长度落点会直接跳到最后一题，把缺口留在身后 —— 用户看不出还有题没答。
   *
   * ⚠ 复用服务端会话时只拿到**已答 ID**，拿不到已答的**分值**（试卷接口不下发答案），
   * 因此界面会把历史作答显示为"未作答"（值取不到，编一个假值去渲染选中态是更坏的选择 ——
   * 用户会看到错误的选项被高亮）。用户重新点一遍即可覆盖，不会有数据损失。
   *
   * @returns 第一道未作答的题的下标；**全部答完时返回 `-1`**（落点由调用方决定）
   */
  const gapIndexOf = (questions: readonly PaperQuestion[], answeredIds: ReadonlySet<string>): number =>
    questions.findIndex((question) => !answeredIds.has(question.questionId));

  /** 服务端已答 ID 版本的落点（没有缺口时停在最后一题，等待提交） */
  const firstGapIndex = (target: TestPaper): number => {
    const gap = gapIndexOf(target.questions, new Set(target.answeredQuestionIds));
    return gap >= 0 ? gap : Math.max(0, target.questions.length - 1);
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
    // ⚠ 先删草稿再清内存：`clearDraft()` 靠 `paper.testCode` 定位草稿键，
    // 先把 `paper` 置空就再也删不掉了（留下一份"幽灵草稿"，下次进入直接复活旧进度）
    clearDraft();
    paper.value = null;
    answers.value = {};
    currentIndex.value = 0;
    dirty.value = false;
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

  /**
   * 清空本地草稿
   *
   * ⚠ 这里**原先是一份写死的题库白名单**（只列了 MBTI_FULL / MBTI_LITE / BIG_FIVE_50），
   * 阶段 3/4 新增的情感与心理状态题库漏在外面 —— 结果做完情感测评后草稿**永不清除**：
   * 下次进入"情感测评"会复活一个**已经提交过**的会话（题目、作答、进度全是旧的），
   * 用户看到的是"我明明做完了，怎么又要做一遍"。
   *
   * 现在改成按**当前试卷的 testCode** 清，不再维护白名单：
   * 新加测评定义时不会再忘（忘一个就是一条沉默的数据残留）。
   */
  const clearDraft = (definitionCode?: string): void => {
    const target = definitionCode ?? paper.value?.testCode;
    if (target) {
      storage.remove(`${STORAGE_KEYS.testDraft}_${target}`);
    }

    // 无参调用还表示"放弃当前测试"，顺带把内存态清掉
    if (!definitionCode) {
      paper.value = null;
      answers.value = {};
      currentIndex.value = 0;
      dirty.value = false;
    }
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
    unansweredCount,
    firstUnansweredIndex,
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
