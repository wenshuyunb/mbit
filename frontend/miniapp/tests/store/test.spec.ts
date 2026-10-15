/**
 * 测试流程 store 测试
 *
 * ## 首要目的：锁死 2026-10-15 真机踩到的两个缺陷
 *
 * 1. **题目被静默跳过**：用户在 52 题的情感测评里答到最后，提交被服务端拒绝
 *    「还有 4 道题未作答」，缺的是**散落**的第 10、34、37、49 题。
 *    根因在答题页（自动跳题的定时器取消不掉，见 `pkgTest/pages/quiz.vue`），
 *    但**补救入口在 store**：必须能算出"第一道未作答的题在哪"，
 *    否则用户只能对着「48 / 52」自己在一屏一题里找 —— 找不到。
 *
 * 2. **草稿清理漏题库**：`clearDraft()` 原先按一份写死的白名单删
 *    （只有 MBTI_FULL / MBTI_LITE / BIG_FIVE_50），阶段 3/4 新增的
 *    `EMOTION_LITE` / `MENTAL_HEALTH_LITE` 不在里面 ——
 *    做完情感测评后草稿永不清除，下次进入会复活一个**已提交过**的会话。
 *
 * 这两个缺陷都是"单测不写就永远发现不了"的类型：前者要跑完 52 题才出现，
 * 后者要跨两次进入同一个测评才出现。
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '@/config/constants';
import { useTestStore } from '@/store/test';
import { testHelpers } from '../setup';

/** 让下一次请求成功返回指定数据 */
const respondWith = (data: unknown): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    setTimeout(() => {
      (options['success'] as (res: unknown) => void)({
        statusCode: 200,
        data: { code: 0, message: 'ok', data, requestId: 'req_test', timestamp: '' },
      });
    }, 0);
  }) as unknown as typeof uni.request);
};

/** 造一份 6 题的试卷快照（题量小便于构造缺口） */
const buildPaper = (questionIds: readonly string[]) => ({
  sessionId: 'session-1',
  testCode: 'EMOTION_LITE',
  testVersion: '1.0.0',
  engineVersion: 'ee-v1.0.0',
  status: 'IN_PROGRESS',
  createdAt: '2026-10-15T02:00:00.000Z',
  expiresAt: '2026-10-15T04:00:00.000Z',
  remainingSeconds: 7200,
  isReused: false,
  progress: { totalQuestions: questionIds.length, answeredCount: 0, currentIndex: 0, completionRate: 0 },
  paper: {
    snapshotVersion: 'ps-1',
    questionsPerPage: 20,
    shuffled: false,
    optionShuffled: false,
    answerScale: { type: 'LIKERT_5', labels: [], values: [1, 2, 3, 4, 5] },
    questions: questionIds.map((questionId, index) => ({
      questionId,
      order: index,
      type: 'SINGLE_CHOICE',
      content: `第 ${index + 1} 题`,
      dimension: 'LOVE_WORDS',
      reverseScored: false,
      weight: 1,
      tags: [],
      options: [
        { label: '完全不符合', value: 1 },
        { label: '完全符合', value: 5 },
      ],
    })),
    questionsTotal: questionIds.length,
    questionsReturned: questionIds.length,
    answeredQuestionIds: [] as string[],
    batch: 1,
    totalBatches: 1,
    hasMore: false,
    nextBatch: null,
  },
});

const QUESTION_IDS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const;

/** 起一个已加载好试卷的 store */
const storeWithPaper = async (): Promise<ReturnType<typeof useTestStore>> => {
  respondWith(buildPaper(QUESTION_IDS));
  const store = useTestStore();
  await store.startTest('EMOTION_LITE', { resume: false });
  return store;
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(uni.request).mockReset();
});

describe('firstUnansweredIndex：漏答必须能被定位', () => {
  it('全部未作答时指向第 1 题', async () => {
    const store = await storeWithPaper();

    expect(store.firstUnansweredIndex).toBe(0);
    expect(store.unansweredCount).toBe(6);
  });

  it('【关键】中间缺题时指向**第一道缺题**，而不是"答了几题就跳到第几题"', async () => {
    const store = await storeWithPaper();

    // 模拟真实故障：第 3、5 题被跳过没答，其余都答了
    store.answer('q1', 5);
    store.answer('q2', 5);
    store.answer('q4', 5);
    store.answer('q6', 5);

    expect(store.answeredCount).toBe(4);
    // 按"答了几题"算会得到 4（第 5 题），而真正的第一道缺题是下标 2（第 3 题）
    expect(store.firstUnansweredIndex).toBe(2);
    expect(store.unansweredCount).toBe(2);
    expect(store.isComplete).toBe(false);
  });

  it('答完后返回 -1、isComplete 为 true', async () => {
    const store = await storeWithPaper();
    for (const id of QUESTION_IDS) store.answer(id, 3);

    expect(store.firstUnansweredIndex).toBe(-1);
    expect(store.unansweredCount).toBe(0);
    expect(store.isComplete).toBe(true);
    expect(store.progress).toBe(100);
  });

  it('没有试卷时不抛错（答题页可能先于试卷渲染）', () => {
    const store = useTestStore();

    expect(store.firstUnansweredIndex).toBe(-1);
    expect(store.unansweredCount).toBe(0);
  });
});

describe('断点续答的落点：第一道未作答的题', () => {
  it('复用服务端会话时按 answeredQuestionIds 找缺口，而不是按已答数量', async () => {
    const paper = buildPaper(QUESTION_IDS);
    // 服务端记录：第 2 题（下标 1）没答，其余都答了
    paper.paper.answeredQuestionIds = ['q1', 'q3', 'q4', 'q5', 'q6'];

    respondWith(paper);
    const store = useTestStore();
    await store.startTest('EMOTION_LITE', { resume: false });

    // 按"已答 5 题"落点会直接跳到最后一题（下标 5），把缺口留在身后
    expect(store.currentIndex).toBe(1);
  });

  it('【关键】本地草稿里有漏答时，回到第一道缺题（而不是用户上次停留的题）', async () => {
    // 第一次进入：答到第 4 题，其中第 2 题被跳过（模拟跳题竞态留下的缺口）
    respondWith(buildPaper(QUESTION_IDS));
    const first = useTestStore();
    await first.startTest('EMOTION_LITE', { resume: false });
    first.answer('q1', 5);
    first.answer('q3', 5);
    first.answer('q4', 5);
    first.goTo(3);

    // 重新进入（模拟杀进程后重开）：应当落到第 2 题（下标 1）而不是下标 3
    setActivePinia(createPinia());
    respondWith(buildPaper(QUESTION_IDS));
    const again = useTestStore();
    await again.startTest('EMOTION_LITE');

    expect(again.answeredCount).toBe(3);
    expect(again.currentIndex).toBe(1);
  });

  it('草稿没有缺口时，保持用户自己的位置不动（别打断正常的回头检查）', async () => {
    respondWith(buildPaper(QUESTION_IDS));
    const first = useTestStore();
    await first.startTest('EMOTION_LITE', { resume: false });
    for (const id of QUESTION_IDS) first.answer(id, 5);
    first.goTo(1);

    setActivePinia(createPinia());
    respondWith(buildPaper(QUESTION_IDS));
    const again = useTestStore();
    await again.startTest('EMOTION_LITE');

    expect(again.currentIndex).toBe(1);
  });
});

describe('clearDraft：按当前试卷的题库清，不再维护白名单', () => {
  it('【关键】清掉情感测评的草稿（旧白名单里没有 EMOTION_LITE）', async () => {
    const store = await storeWithPaper();
    store.answer('q1', 5);
    expect(testHelpers.memoryStore.has(`${STORAGE_KEYS.testDraft}_EMOTION_LITE`)).toBe(true);

    store.clearDraft();

    expect(testHelpers.memoryStore.has(`${STORAGE_KEYS.testDraft}_EMOTION_LITE`)).toBe(false);
  });

  it('显式传题库编码时也能清（草稿失效那条路径）', () => {
    const store = useTestStore();
    testHelpers.memoryStore.set(`${STORAGE_KEYS.testDraft}_MENTAL_HEALTH_LITE`, { sessionId: 'old' });

    store.clearDraft('MENTAL_HEALTH_LITE');

    expect(testHelpers.memoryStore.has(`${STORAGE_KEYS.testDraft}_MENTAL_HEALTH_LITE`)).toBe(false);
  });

  it('放弃测试时草稿被删掉（先删草稿再清内存，否则键就丢了）', async () => {
    const store = await storeWithPaper();
    store.answer('q1', 5);

    store.abandon();

    expect(testHelpers.memoryStore.has(`${STORAGE_KEYS.testDraft}_EMOTION_LITE`)).toBe(false);
    expect(store.paper).toBeNull();
    expect(store.answeredCount).toBe(0);
  });
});
