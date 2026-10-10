/**
 * 测试服务测试
 *
 * 聚焦「错了会造成数据污染或安全问题」的分支：
 *   · IDOR 防护：他人会话返回 403、不存在的会话返回 404
 *   · 状态机：提交/过期后禁止写答案（防止篡改已算分结果）
 *   · 答案校验：四种题型的值域 + 跨试卷注入 + 排序题必须完整排列
 *   · 提交完整性：题量不足时**拒绝算分**（禁止服务端代填空值污染算法结果）
 *   · 提交幂等：重复提交返回既有结果，**不重复递增画像版本**
 *   · 快照固化：复用会话不重新抽题
 */

import type { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PersonalityEngine } from '../personality/engine/personality-engine.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import { TestService, type SaveAnswersResult } from './test.service';
import type { PaperQuestion, PaperSnapshot } from './test.types';

// ============================================================================
// 夹具
// ============================================================================

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OTHER_USER_ID = '0195f3a2-0000-7000-8000-000000000000';
const SESSION_ID = '0195f3a2-91a7-7d53-b8c9-4a7b1e2f3c12';
const DEFINITION_ID = '0195f3a2-1111-7111-8111-111111111111';

const question = (overrides: Partial<PaperQuestion> = {}): PaperQuestion => ({
  order: 0,
  questionId: '0195f3a2-29cf-7bfd-9c68-e4bf1c2d3a1c',
  code: 'Q_EI_001',
  content: '在聚会上我通常会主动与陌生人交谈',
  type: 'LIKERT5',
  dimension: 'EI',
  reverseScored: false,
  weight: 1,
  tags: ['社交'],
  options: [1, 2, 3, 4, 5].map((value) => ({ label: `选项${value}`, value })),
  ...overrides,
});

/** 构造覆盖四个 MBTI 维度的快照（每维度 1 题） */
const buildSnapshot = (): PaperSnapshot => ({
  snapshotVersion: 'ps-v1',
  questionsPerPage: 2,
  shuffled: true,
  optionShuffled: false,
  answerScale: {
    type: 'LIKERT5',
    labels: ['非常不同意', '不同意', '中立', '同意', '非常同意'],
    values: [1, 2, 3, 4, 5],
  },
  questions: [
    question({ order: 0, questionId: 'q-ei', code: 'Q_EI_001', dimension: 'EI' }),
    question({ order: 1, questionId: 'q-sn', code: 'Q_SN_001', dimension: 'SN' }),
    question({ order: 2, questionId: 'q-tf', code: 'Q_TF_001', dimension: 'TF' }),
    question({ order: 3, questionId: 'q-jp', code: 'Q_JP_001', dimension: 'JP' }),
  ],
});

interface PrismaStub {
  testDefinition: { findFirst: jest.Mock; findMany: jest.Mock; update: jest.Mock };
  question: { findMany: jest.Mock };
  testSession: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
  };
  testAnswer: { findMany: jest.Mock; upsert: jest.Mock; count: jest.Mock };
  testResult: { upsert: jest.Mock };
  personalityProfile: { findFirst: jest.Mock; findMany: jest.Mock; updateMany: jest.Mock; create: jest.Mock };
  personalitySnapshot: { upsert: jest.Mock };
  relationshipStyleRule: { findMany: jest.Mock };
  userDeletionRequest: { findFirst: jest.Mock };
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    testDefinition: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    question: { findMany: jest.fn() },
    testSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    testAnswer: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    testResult: { upsert: jest.fn().mockResolvedValue({ id: 'result-1' }) },
    personalityProfile: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'profile-1', version: 1 }),
    },
    personalitySnapshot: { upsert: jest.fn() },
    relationshipStyleRule: { findMany: jest.fn().mockResolvedValue([]) },
    userDeletionRequest: { findFirst: jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaStub;

  stub.$transaction = jest.fn(async (callback: (tx: PrismaStub) => Promise<unknown>) => callback(stub));

  return stub;
};

const createRedisStub = (): RedisService & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    key: (...parts: (string | number)[]) => ['sm', ...parts].join(':'),
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as RedisService & { store: Map<string, string> };
};

/** 数据库中的会话行（字段齐全，避免 `!== null` 判断因缺字段而误判） */
const sessionRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SESSION_ID,
  userId: USER_ID,
  status: 'IN_PROGRESS',
  definitionCode: 'MBTI_LITE',
  definitionVersion: '1.0.0',
  testDefinitionId: DEFINITION_ID,
  paperSnapshot: buildSnapshot(),
  startedAt: new Date(Date.now() - 60_000),
  expiredAt: new Date(Date.now() + 3_600_000),
  createdAt: new Date(Date.now() - 60_000),
  deletedAt: null,
  ...overrides,
});

// ============================================================================
// 测试
// ============================================================================

describe('TestService', () => {
  let prisma: PrismaStub;
  let redis: ReturnType<typeof createRedisStub>;
  let service: TestService;

  beforeEach(() => {
    prisma = createPrismaStub();
    redis = createRedisStub();
    service = new TestService(prisma as unknown as PrismaService, redis, new PersonalityEngine());

    prisma.testSession.findUnique.mockResolvedValue(sessionRow());
  });

  // ==========================================================================
  // 归属与状态（安全边界）
  // ==========================================================================

  describe('会话归属与状态', () => {
    it('会话不存在 → 404（40002）', async () => {
      prisma.testSession.findUnique.mockResolvedValue(null);

      await expect(service.getSession(USER_ID, SESSION_ID)).rejects.toMatchObject({
        code: ErrorCode.TEST_SESSION_NOT_FOUND,
      });
    });

    it('【IDOR 防护】会话归属他人 → 403（40003）', async () => {
      prisma.testSession.findUnique.mockResolvedValue(sessionRow({ userId: OTHER_USER_ID }));

      await expect(service.getSession(USER_ID, SESSION_ID)).rejects.toMatchObject({
        code: ErrorCode.TEST_SESSION_NOT_OWNED,
      });
    });

    it('已软删除的会话视为不存在', async () => {
      prisma.testSession.findUnique.mockResolvedValue(sessionRow({ deletedAt: new Date() }));

      await expect(service.getSession(USER_ID, SESSION_ID)).rejects.toMatchObject({
        code: ErrorCode.TEST_SESSION_NOT_FOUND,
      });
    });

    it.each(['SUBMITTED', 'SCORED', 'REPORT_READY'])('状态 %s 时禁止写答案（防篡改已算分结果）', async (status) => {
      prisma.testSession.findUnique.mockResolvedValue(sessionRow({ status }));

      await expect(
        service.saveAnswers(USER_ID, SESSION_ID, { answers: [{ questionId: 'q-ei', value: 5 }] }),
      ).rejects.toMatchObject({ code: ErrorCode.TEST_SESSION_ALREADY_SUBMITTED });

      expect(prisma.testAnswer.upsert).not.toHaveBeenCalled();
    });

    it('内部状态为 IN_PROGRESS 但已过期 → 禁止写答案（40004）', async () => {
      prisma.testSession.findUnique.mockResolvedValue(sessionRow({ expiredAt: new Date(Date.now() - 1000) }));

      await expect(
        service.saveAnswers(USER_ID, SESSION_ID, { answers: [{ questionId: 'q-ei', value: 5 }] }),
      ).rejects.toMatchObject({ code: ErrorCode.TEST_SESSION_EXPIRED });
    });

    it('过期会话对外呈现为 EXPIRED（不暴露内部状态）', async () => {
      prisma.testSession.findUnique.mockResolvedValue(sessionRow({ expiredAt: new Date(Date.now() - 1000) }));

      const view = await service.getSession(USER_ID, SESSION_ID);

      expect(view.status).toBe('EXPIRED');
      expect(view.remainingSeconds).toBe(0);
    });
  });

  // ==========================================================================
  // 答案校验
  // ==========================================================================

  describe('答案值域校验', () => {
    const save = (questionId: string, value: number | number[]): Promise<SaveAnswersResult> =>
      service.saveAnswers(USER_ID, SESSION_ID, { answers: [{ questionId, value }] });

    it('LIKERT5 合法值通过', async () => {
      prisma.testAnswer.count.mockResolvedValue(1);

      await expect(save('q-ei', 5)).resolves.toMatchObject({ saved: 1 });
    });

    it.each([
      ['超出范围', 6],
      ['非整数', 3.5],
    ])('LIKERT5 %s → 拒绝（40007）', async (_label, value) => {
      await expect(save('q-ei', value)).rejects.toMatchObject({ code: ErrorCode.TEST_ANSWER_INVALID });
      expect(prisma.testAnswer.upsert).not.toHaveBeenCalled();
    });

    it('BINARY 合法值为选项值之一', async () => {
      prisma.testSession.findUnique.mockResolvedValue(
        sessionRow({
          paperSnapshot: {
            ...buildSnapshot(),
            questions: [
              question({
                questionId: 'q-bin',
                type: 'BINARY',
                options: [
                  { label: 'A', value: 0 },
                  { label: 'B', value: 1 },
                ],
              }),
            ],
          },
        }),
      );
      prisma.testAnswer.count.mockResolvedValue(1);

      await expect(save('q-bin', 1)).resolves.toMatchObject({ saved: 1 });
      await expect(save('q-bin', 2)).rejects.toMatchObject({ code: ErrorCode.TEST_ANSWER_INVALID });
    });

    it('迫选题必须选择已有选项值', async () => {
      prisma.testSession.findUnique.mockResolvedValue(
        sessionRow({
          paperSnapshot: {
            ...buildSnapshot(),
            questions: [
              question({
                questionId: 'q-fc',
                type: 'FORCED_CHOICE',
                options: [
                  { label: 'A', value: 10 },
                  { label: 'B', value: 20 },
                ],
              }),
            ],
          },
        }),
      );
      prisma.testAnswer.count.mockResolvedValue(1);

      await expect(save('q-fc', 20)).resolves.toMatchObject({ saved: 1 });
      await expect(save('q-fc', 30)).rejects.toMatchObject({ code: ErrorCode.TEST_ANSWER_INVALID });
    });

    describe('排序题（RANK）', () => {
      const rankSnapshot = {
        ...buildSnapshot(),
        questions: [
          question({
            questionId: 'q-rank',
            type: 'RANK',
            options: [
              { label: 'A', value: 1 },
              { label: 'B', value: 2 },
              { label: 'C', value: 3 },
            ],
          }),
        ],
      };

      beforeEach(() => {
        prisma.testSession.findUnique.mockResolvedValue(sessionRow({ paperSnapshot: rankSnapshot }));
        prisma.testAnswer.count.mockResolvedValue(1);
      });

      it('完整排列通过', async () => {
        await expect(save('q-rank', [3, 1, 2])).resolves.toMatchObject({ saved: 1 });
      });

      it('传入标量 → 拒绝（必须是数组）', async () => {
        await expect(save('q-rank', 1)).rejects.toMatchObject({ code: ErrorCode.TEST_ANSWER_INVALID });
      });

      it('缺项 → 拒绝', async () => {
        await expect(save('q-rank', [1, 2])).rejects.toMatchObject({ code: ErrorCode.TEST_ANSWER_INVALID });
      });

      it('重复项 → 拒绝', async () => {
        await expect(save('q-rank', [1, 1, 2])).rejects.toMatchObject({ code: ErrorCode.TEST_ANSWER_INVALID });
      });

      it('含非法选项值 → 拒绝', async () => {
        await expect(save('q-rank', [1, 2, 9])).rejects.toMatchObject({ code: ErrorCode.TEST_ANSWER_INVALID });
      });
    });

    it('【防跨试卷注入】题目不属于本试卷 → 整批拒绝（40008）', async () => {
      await expect(save('not-in-this-paper', 5)).rejects.toMatchObject({
        code: ErrorCode.QUESTION_NOT_IN_PAPER,
      });

      expect(prisma.testAnswer.upsert).not.toHaveBeenCalled();
    });

    it('【整批原子】一批中任一题非法 → 整批都不写入', async () => {
      await expect(
        service.saveAnswers(USER_ID, SESSION_ID, {
          answers: [
            { questionId: 'q-ei', value: 5 }, // 合法
            { questionId: 'q-sn', value: 99 }, // 非法
          ],
        }),
      ).rejects.toMatchObject({ code: ErrorCode.TEST_ANSWER_INVALID });

      // 关键：合法的那一题也不能落库，否则前端与服务端进度会错位
      expect(prisma.testAnswer.upsert).not.toHaveBeenCalled();
    });

    it('写入成功时推进进度与状态', async () => {
      prisma.testAnswer.count.mockResolvedValue(2);

      const result = await service.saveAnswers(USER_ID, SESSION_ID, {
        answers: [
          { questionId: 'q-ei', value: 5 },
          { questionId: 'q-sn', value: 4 },
        ],
      });

      expect(result.saved).toBe(2);
      expect(result.progress).toEqual({
        totalQuestions: 4,
        answeredCount: 2,
        currentIndex: 2,
        completionRate: 50,
      });

      const updateArgs = prisma.testSession.update.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(updateArgs.data['answeredCount']).toBe(2);
      expect(updateArgs.data['progress']).toBe(50);
    });

    it('CREATED 状态写入答案后推进为 IN_PROGRESS', async () => {
      prisma.testSession.findUnique.mockResolvedValue(sessionRow({ status: 'CREATED' }));
      prisma.testAnswer.count.mockResolvedValue(1);

      await service.saveAnswers(USER_ID, SESSION_ID, { answers: [{ questionId: 'q-ei', value: 5 }] });

      const updateArgs = prisma.testSession.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(updateArgs.data['status']).toBe('IN_PROGRESS');
    });
  });

  // ==========================================================================
  // 断点续答与分批
  // ==========================================================================

  describe('断点续答与批次', () => {
    it('返回已作答题目 ID 列表供前端回填', async () => {
      prisma.testAnswer.findMany.mockResolvedValue([{ questionId: 'q-ei' }, { questionId: 'q-sn' }]);

      const view = await service.getSession(USER_ID, SESSION_ID);

      expect(view.paper.answeredQuestionIds).toEqual(['q-ei', 'q-sn']);
      expect(view.progress.answeredCount).toBe(2);
    });

    it('分批返回：默认第 1 批，并给出总批次与下一批', async () => {
      const view = await service.getSession(USER_ID, SESSION_ID, { batch: 1 });

      expect(view.paper.questions).toHaveLength(2); // questionsPerPage = 2
      expect(view.paper.questionsTotal).toBe(4);
      expect(view.paper.questionsReturned).toBe(2);
      expect(view.paper.totalBatches).toBe(2);
      expect(view.paper.hasMore).toBe(true);
      expect(view.paper.nextBatch).toBe(2);
    });

    it('第 2 批返回剩余题目且 hasMore 为 false', async () => {
      const view = await service.getSession(USER_ID, SESSION_ID, { batch: 2 });

      expect(view.paper.questions).toHaveLength(2);
      expect(view.paper.batch).toBe(2);
      expect(view.paper.hasMore).toBe(false);
      expect(view.paper.nextBatch).toBeNull();
    });

    it('批次超出范围 → 400', async () => {
      await expect(service.getSession(USER_ID, SESSION_ID, { batch: 99 })).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('分批返回的题目顺序与快照一致（同快照同顺序）', async () => {
      const first = await service.getSession(USER_ID, SESSION_ID, { batch: 1 });
      const second = await service.getSession(USER_ID, SESSION_ID, { batch: 2 });

      expect([...first.paper.questions, ...second.paper.questions].map((item) => item.questionId)).toEqual([
        'q-ei',
        'q-sn',
        'q-tf',
        'q-jp',
      ]);
    });
  });

  // ==========================================================================
  // 提交与算分
  // ==========================================================================

  describe('提交与算分', () => {
    /** 构造「四题全部作答」的答案行 */
    const fullAnswers = [
      { questionId: 'q-ei', rawValue: 5, responseMs: 3000 },
      { questionId: 'q-sn', rawValue: 5, responseMs: 3000 },
      { questionId: 'q-tf', rawValue: 5, responseMs: 3000 },
      { questionId: 'q-jp', rawValue: 5, responseMs: 3000 },
    ];

    it('【禁止代填空值】题量不足 → 拒绝算分（40006）并给出未答题号', async () => {
      prisma.testAnswer.findMany.mockResolvedValue(fullAnswers.slice(0, 2));

      await expect(service.submit(USER_ID, SESSION_ID, { confirm: true })).rejects.toMatchObject({
        code: ErrorCode.TEST_ANSWER_INCOMPLETE,
      });

      // 关键：一道题都不能落库、不能算分
      expect(prisma.testSession.update).not.toHaveBeenCalled();
      expect(prisma.testResult.upsert).not.toHaveBeenCalled();
    });

    it('未答题号以 1 为起点（用户可读）', async () => {
      prisma.testAnswer.findMany.mockResolvedValue([fullAnswers[0]]);

      try {
        await service.submit(USER_ID, SESSION_ID, { confirm: true });
      } catch (error) {
        const details = (error as BusinessException).details ?? [];
        // 第 2、3、4 题未作答（order 1,2,3 → 题号 2,3,4）
        expect(details[0]?.issue).toContain('2, 3, 4');
      }
    });

    it('成功算分：落库结果、画像、快照，并把会话置为 SCORED', async () => {
      prisma.testAnswer.findMany.mockResolvedValue(fullAnswers);

      const result = await service.submit(USER_ID, SESSION_ID, { confirm: true });

      expect(result.status).toBe('SCORED');
      expect(result.engineVersion).toBe('pe-v1.0.0');
      expect(result.result.mbtiType).toBe('ESTJ'); // 全选最高分
      expect(result.isDuplicate).toBe(false);

      expect(prisma.testSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SESSION_ID },
          data: expect.objectContaining({ status: 'SCORED' }),
        }),
      );
      expect(prisma.testResult.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.personalityProfile.create).toHaveBeenCalledTimes(1);
      expect(prisma.personalitySnapshot.upsert).toHaveBeenCalledTimes(1);
    });

    it('画像版本从既有最大值递增（旧版本不重算）', async () => {
      prisma.testAnswer.findMany.mockResolvedValue(fullAnswers);
      prisma.personalityProfile.findFirst.mockResolvedValue({ version: 7 });
      prisma.personalityProfile.create.mockResolvedValue({ id: 'profile-8', version: 8 });

      const result = await service.submit(USER_ID, SESSION_ID, { confirm: true });

      expect(result.profileVersion).toBe(8);
      const createArgs = prisma.personalityProfile.create.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data['version']).toBe(8);
      expect(createArgs.data['isCurrent']).toBe(true);
    });

    it('新画像落库前先取消旧画像的 current 标记（同一时刻只有一个当前画像）', async () => {
      prisma.testAnswer.findMany.mockResolvedValue(fullAnswers);

      await service.submit(USER_ID, SESSION_ID, { confirm: true });

      expect(prisma.personalityProfile.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, isCurrent: true },
        data: { isCurrent: false },
      });
    });

    it('质量指标与关系风格一并落库', async () => {
      prisma.testAnswer.findMany.mockResolvedValue(fullAnswers);

      await service.submit(USER_ID, SESSION_ID, { confirm: true });

      const createArgs = prisma.personalityProfile.create.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };

      expect(createArgs.data['consistencyScore']).toBeGreaterThanOrEqual(0);
      expect(createArgs.data['completionRate']).toBe(100);
      expect(typeof createArgs.data['attachmentStyle']).toBe('string');
    });

    it('关系风格规则从数据库读入并参与推导', async () => {
      prisma.testAnswer.findMany.mockResolvedValue(fullAnswers);
      prisma.relationshipStyleRule.findMany.mockResolvedValue([
        {
          code: 'ALWAYS_MATCH',
          name: '总是命中',
          priority: 1,
          conditions: { all: [{ field: 'openness', op: 'gte', value: 0 }] },
          resultAttachment: 'SECURE',
          resultLoveLanguages: ['QUALITY_TIME'],
          resultConflictStyle: 'COLLABORATING',
        },
      ]);

      const result = await service.submit(USER_ID, SESSION_ID, { confirm: true });

      expect(result.result.relationshipStyle.attachment).toBe('SECURE');
      expect(result.result.relationshipStyle.loveLanguage).toEqual(['QUALITY_TIME']);
    });

    it('【幂等】重复提交返回既有结果且不重复递增画像版本', async () => {
      // loadOwnedSession 读会话行；buildSubmitResultFromExisting 再读一次并带出 result
      prisma.testSession.findUnique.mockResolvedValueOnce(sessionRow({ status: 'SCORED' })).mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        status: 'SCORED',
        submittedAt: new Date(),
        scoredAt: new Date(),
        result: {
          id: 'result-1',
          engineVersion: 'pe-v1.0.0',
          mbtiType: 'ESTJ',
          mbtiDimensions: { EI: 100, SN: 100, TF: 100, JP: 100 },
          bigFiveScores: { openness: 50 },
          relationshipStyle: { attachment: 'SECURE', loveLanguage: [], conflictStyle: null },
          qualityMetrics: { consistencyScore: 100, completionRate: 100, avgResponseMs: 3000, rushRate: 0 },
        },
      });
      prisma.personalityProfile.findFirst.mockResolvedValue({ id: 'profile-1', version: 1 });

      const result = await service.submit(USER_ID, SESSION_ID, { confirm: true });

      expect(result.isDuplicate).toBe(true);
      expect(result.resultId).toBe('result-1');
      // 关键：没有再次算分与建画像
      expect(prisma.testResult.upsert).not.toHaveBeenCalled();
      expect(prisma.personalityProfile.create).not.toHaveBeenCalled();
    });

    it('一致性偏低时返回提示文案（不阻断流程）', async () => {
      // 四个维度各有 1 道正向题 + 1 道反向题，全部选 5：
      // 反向修正后正向为 1、反向为 0 ⇒ 每个维度偏差均为 1 ⇒ 一致性 0。
      // （必须覆盖全部四个 MBTI 维度，否则类型不可判定会被拒绝）
      const inconsistentQuestions: PaperQuestion[] = ['EI', 'SN', 'TF', 'JP'].flatMap((dimension, index) => [
        question({ order: index * 2, questionId: `q-${dimension}-f`, code: `Q_${dimension}_001`, dimension }),
        question({
          order: index * 2 + 1,
          questionId: `q-${dimension}-r`,
          code: `Q_${dimension}_002`,
          dimension,
          reverseScored: true,
        }),
      ]);

      prisma.testSession.findUnique.mockResolvedValue(
        sessionRow({ paperSnapshot: { ...buildSnapshot(), questions: inconsistentQuestions } }),
      );
      prisma.testAnswer.findMany.mockResolvedValue(
        inconsistentQuestions.map((item) => ({ questionId: item.questionId, rawValue: 5, responseMs: 3000 })),
      );

      const result = await service.submit(USER_ID, SESSION_ID, { confirm: true });

      expect(result.result.quality.consistencyScore).toBe(0);
      expect(result.result.quality.notice).toContain('置信度偏低');
    });

    it('一致性达标时不返回提示文案', async () => {
      prisma.testAnswer.findMany.mockResolvedValue([
        { questionId: 'q-ei', rawValue: 5, responseMs: 3000 },
        { questionId: 'q-sn', rawValue: 5, responseMs: 3000 },
        { questionId: 'q-tf', rawValue: 5, responseMs: 3000 },
        { questionId: 'q-jp', rawValue: 5, responseMs: 3000 },
      ]);

      const result = await service.submit(USER_ID, SESSION_ID, { confirm: true });

      expect(result.result.quality.notice).toBeNull();
    });

    it('【题库异常兜底】算分后类型为空 → 会话置 EXPIRED 且不产生半成品画像', async () => {
      // 快照只有 EI 一个维度 → 其余维度无数据 → MBTI 类型为 null
      prisma.testSession.findUnique.mockResolvedValue(
        sessionRow({
          paperSnapshot: {
            ...buildSnapshot(),
            questions: [question({ order: 0, questionId: 'q-ei', dimension: 'EI' })],
          },
        }),
      );
      prisma.testAnswer.findMany.mockResolvedValue([{ questionId: 'q-ei', rawValue: 5, responseMs: 3000 }]);

      await expect(service.submit(USER_ID, SESSION_ID, { confirm: true })).rejects.toMatchObject({
        code: ErrorCode.PERSONALITY_PROFILE_BUILDING,
      });

      expect(prisma.personalityProfile.create).not.toHaveBeenCalled();
      expect(prisma.testSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'EXPIRED' } }));
    });
  });

  // ==========================================================================
  // 结果查询
  // ==========================================================================

  describe('结果查询', () => {
    it('未提交的会话查询结果 → 409', async () => {
      await expect(service.getSessionResult(USER_ID, SESSION_ID)).rejects.toMatchObject({
        code: ErrorCode.TEST_SESSION_ALREADY_SUBMITTED,
      });
    });

    it('已过期的会话查询结果 → 409（40004）', async () => {
      prisma.testSession.findUnique.mockResolvedValue(sessionRow({ status: 'EXPIRED' }));

      await expect(service.getSessionResult(USER_ID, SESSION_ID)).rejects.toMatchObject({
        code: ErrorCode.TEST_SESSION_EXPIRED,
      });
    });

    it('已算分的会话返回结果（含维度极性视图）', async () => {
      // 第一次读会话行（loadOwnedSession），第二次读结果（buildSubmitResultFromExisting）
      prisma.testSession.findUnique.mockResolvedValueOnce(sessionRow({ status: 'SCORED' })).mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        status: 'SCORED',
        submittedAt: new Date(),
        scoredAt: new Date(),
        result: {
          id: 'result-1',
          engineVersion: 'pe-v1.0.0',
          // 与下面的维度百分比保持自洽：EI 34.5→I、SN 68.2→S、TF 61.4→T、JP 72.8→J ⇒ ISTJ
          mbtiType: 'ISTJ',
          mbtiDimensions: { EI: 34.5, SN: 68.2, TF: 61.4, JP: 72.8 },
          bigFiveScores: { openness: 82.5 },
          relationshipStyle: {
            attachment: 'ANXIOUS',
            loveLanguage: ['QUALITY_TIME'],
            conflictStyle: 'ACCOMMODATING',
            mbtiConfidence: 78.4,
          },
          qualityMetrics: { consistencyScore: 82.1, completionRate: 100, avgResponseMs: 10132, rushRate: 0 },
        },
      });
      prisma.personalityProfile.findFirst.mockResolvedValue({ id: 'profile-3', version: 3 });

      const result = await service.getSessionResult(USER_ID, SESSION_ID);

      expect(result.result.mbtiType).toBe('ISTJ');
      expect(result.result.dimensions['EI']).toEqual({
        percent: 34.5,
        pole: 'I',
        leftLabel: '内向 I',
        rightLabel: '外向 E',
      });
      // percent ≥ 50 → 取正极字母（SN 维度的正极是 S）
      expect(result.result.dimensions['SN']?.pole).toBe('S');
      expect(result.result.confidence).toBe(78.4);
      expect(result.profileVersion).toBe(3);
      expect(result.isDuplicate).toBe(true);
    });
  });

  // ==========================================================================
  // 创建会话
  // ==========================================================================

  describe('创建会话', () => {
    const seedDefinition = (): void => {
      prisma.testDefinition.findFirst.mockResolvedValue({
        id: DEFINITION_ID,
        code: 'MBTI_LITE',
        version: '1.0.0',
        questionCount: 1,
      });
      prisma.question.findMany.mockResolvedValue([
        {
          id: 'q-ei',
          code: 'Q_EI_001',
          content: '题干',
          type: 'LIKERT5',
          dimension: 'EI',
          reverseScored: false,
          weight: 1,
          tags: [],
          options: [1, 2, 3, 4, 5].map((value) => ({ label: `选项${value}`, value, isActive: true })),
        },
      ]);
      prisma.testSession.create.mockResolvedValue({ id: SESSION_ID });
    };

    it('创建会话并固化试卷快照', async () => {
      seedDefinition();

      const { created } = await service.createSession(USER_ID, 'MBTI_LITE', {});

      expect(created).toBe(true);
      const createArgs = prisma.testSession.create.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data['status']).toBe('IN_PROGRESS');
      expect(createArgs.data['questionCount']).toBe(1);
      expect(createArgs.data['definitionCode']).toBe('MBTI_LITE');
      expect(createArgs.data['expiredAt']).toBeInstanceOf(Date);
    });

    it('【题库不足】可用题量为 0 → 报错且不创建会话（40011 语义）', async () => {
      prisma.testDefinition.findFirst.mockResolvedValue({
        id: DEFINITION_ID,
        code: 'MBTI_LITE',
        version: '1.0.0',
        questionCount: 0,
      });
      prisma.question.findMany.mockResolvedValue([]);

      await expect(service.createSession(USER_ID, 'MBTI_LITE', {})).rejects.toMatchObject({
        code: ErrorCode.PERSONALITY_PROFILE_BUILDING,
      });

      expect(prisma.testSession.create).not.toHaveBeenCalled();
    });

    it('【题库不足】可用题量少于定义要求 → 报错（宁可报错也不下发残缺试卷）', async () => {
      prisma.testDefinition.findFirst.mockResolvedValue({
        id: DEFINITION_ID,
        code: 'MBTI_LITE',
        version: '1.0.0',
        questionCount: 32,
      });
      prisma.question.findMany.mockResolvedValue([
        {
          id: 'q1',
          code: 'Q_EI_001',
          content: '题干',
          type: 'LIKERT5',
          dimension: 'EI',
          reverseScored: false,
          weight: 1,
          tags: [],
          options: [],
        },
      ]);

      await expect(service.createSession(USER_ID, 'MBTI_LITE', {})).rejects.toMatchObject({
        code: ErrorCode.PERSONALITY_PROFILE_BUILDING,
      });
    });

    it('定义不存在 → 404（40000）', async () => {
      prisma.testDefinition.findFirst.mockResolvedValue(null);

      await expect(service.createSession(USER_ID, 'NOPE', {})).rejects.toMatchObject({
        code: ErrorCode.TEST_DEFINITION_NOT_FOUND,
      });
    });

    it('【冷静期限制】注销冷静期内禁止开始新测评', async () => {
      prisma.userDeletionRequest.findFirst.mockResolvedValue({ id: 'del-1' });

      await expect(service.createSession(USER_ID, 'MBTI_LITE', {})).rejects.toMatchObject({
        code: ErrorCode.PROFILE_EDIT_LOCKED,
      });

      expect(prisma.testSession.create).not.toHaveBeenCalled();
    });

    it('存在未过期的进行中会话时复用（不重新抽题、返回 isReused）', async () => {
      prisma.testDefinition.findFirst.mockResolvedValue({
        id: DEFINITION_ID,
        code: 'MBTI_LITE',
        version: '1.0.0',
        questionCount: 4,
      });
      prisma.testSession.findFirst.mockResolvedValue({
        id: SESSION_ID,
        expiredAt: new Date(Date.now() + 3_600_000),
      });

      const { created, view } = await service.createSession(USER_ID, 'MBTI_LITE', {});

      expect(created).toBe(false);
      expect(view.isReused).toBe(true);
      // 关键：没有重新抽题
      expect(prisma.question.findMany).not.toHaveBeenCalled();
      expect(prisma.testSession.create).not.toHaveBeenCalled();
    });

    it('forceNew 优先于 reuseInProgress，并终止旧的进行中会话', async () => {
      seedDefinition();
      prisma.testSession.updateMany.mockResolvedValue({ count: 1 });

      const { created } = await service.createSession(USER_ID, 'MBTI_LITE', {
        forceNew: true,
        reuseInProgress: true,
      });

      expect(created).toBe(true);
      expect(prisma.testSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_ID, status: 'IN_PROGRESS' }),
          data: { status: 'EXPIRED' },
        }),
      );
      expect(prisma.testSession.create).toHaveBeenCalled();
    });

    it('reuseInProgress = false 时直接新建', async () => {
      seedDefinition();

      const { created } = await service.createSession(USER_ID, 'MBTI_LITE', { reuseInProgress: false });

      expect(created).toBe(true);
      expect(prisma.testSession.findFirst).not.toHaveBeenCalled();
    });

    it('过期时间与会话有效期 2 小时一致', async () => {
      seedDefinition();

      await service.createSession(USER_ID, 'MBTI_LITE', {});

      const createArgs = prisma.testSession.create.mock.calls[0]?.[0] as {
        data: { expiredAt: Date; startedAt: Date };
      };
      const hours = (createArgs.data.expiredAt.getTime() - createArgs.data.startedAt.getTime()) / 3_600_000;
      expect(Math.round(hours)).toBe(2);
    });

    it('【幂等键】相同幂等键重复创建返回同一会话', async () => {
      seedDefinition();

      const first = await service.createSession(USER_ID, 'MBTI_LITE', {}, { idempotencyKey: 'idem-12345678' });
      expect(first.created).toBe(true);
      expect(redis.store.size).toBe(1);

      // 第二次：模拟已无进行中会话（例如已被终止），但幂等键命中
      prisma.testSession.findFirst.mockResolvedValue(null);
      prisma.testSession.findUnique.mockResolvedValue(sessionRow({ id: SESSION_ID }));

      const second = await service.createSession(USER_ID, 'MBTI_LITE', {}, { idempotencyKey: 'idem-12345678' });

      expect(second.created).toBe(false);
      expect(second.view.isReused).toBe(true);
      // 关键：只创建了一次会话
      expect(prisma.testSession.create).toHaveBeenCalledTimes(1);
    });
  });
});
