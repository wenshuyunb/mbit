/**
 * 测试服务 — 题库、会话生命周期、作答与算分
 *
 * 契约来源：docs/API_DESIGN.md §3.3
 *
 * 关键约束（逐条对应契约中的业务规则）：
 *   · ① 题量不足宁可报错也不下发残缺试卷（`40011`）
 *   · ② 快照一经写入永不修改 —— 题库后续改动不影响进行中的会话与历史结果
 *   · ③ 同一用户同一测试同时最多 1 个 `IN_PROGRESS` 会话；`forceNew` 会把旧的置为 `EXPIRED`
 *   · ④ 答案写入是**整批原子**的：任一题非法则整批回滚，避免客户端与服务端进度错位
 *   · ⑤ 仅 `CREATED`/`IN_PROGRESS` 可写答案 —— 提交后禁止篡改（算法可解释性的关键）
 *   · ⑥ 提交时**禁止服务端代填空值**（会污染算法结果），必须题量完整
 *   · ⑦ 算分是纯函数（< 10ms），因此**同步执行**，不引入轮询复杂度
 *   · ⑧ 重复提交幂等：已算分的会话直接返回既有结果，不重复递增画像版本
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TestModule } from '@prisma/client';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { PersonalityEngine } from '../personality/engine/personality-engine.service';
import { ModuleScoringService } from '../personality/engine/module-scoring.service';
import type { EngineAnswer, EngineQuestion } from '../personality/engine/personality-engine.types';
import { loadRelationshipStyleRules } from '../personality/relationship-style-rules.loader';
import { buildPaperSnapshot } from './paper-snapshot.builder';
import type {
  GetSessionQueryDto,
  ListSessionsQueryDto,
  ListTestsQueryDto,
  SaveAnswersDto,
  SubmitSessionDto,
} from './dto/test.dto';
import type { PaperQuestion, PaperSnapshot } from './test.types';

// ============================================================================
// 响应类型
// ============================================================================

/** 测试定义视图 */
export interface TestDefinitionView {
  code: string;
  name: string;
  category: string;
  description: string | null;
  version: string;
  questionCount: number;
  estimatedMinutes: number;
  coverUrl: string | null;
  /** 当前用户已完成次数（未登录/未查询时为 0） */
  completedCount: number;
  /** 是否存在进行中的会话 */
  hasInProgress: boolean;
}

/** 会话进度 */
export interface SessionProgressView {
  totalQuestions: number;
  answeredCount: number;
  currentIndex: number;
  completionRate: number;
}

/** 会话视图 */
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
  progress: SessionProgressView;
  paper: {
    snapshotVersion: string;
    questionsPerPage: number;
    shuffled: boolean;
    optionShuffled: boolean;
    answerScale: PaperSnapshot['answerScale'];
    /** 本次返回的题目（分批） */
    questions: PaperQuestion[];
    questionsTotal: number;
    questionsReturned: number;
    /** 已作答的题目 ID（断点续答时前端据此回填） */
    answeredQuestionIds: string[];
    batch: number;
    totalBatches: number;
    hasMore: boolean;
    nextBatch: number | null;
  };
}

/** 保存答案结果 */
export interface SaveAnswersResult {
  saved: number;
  progress: SessionProgressView;
  /** 服务端受理时间（前端可据此校正本地时钟） */
  serverAt: string;
}

/** 提交结果 */
export interface SubmitResultView {
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
  result: {
    mbtiType: string | null;
    dimensions: Record<string, { percent: number; pole: string; leftLabel: string; rightLabel: string }>;
    confidence: number;
    bigFive: Record<string, number>;
    quality: {
      consistencyScore: number;
      completionRate: number;
      avgResponseMs: number | null;
      rushRate: number;
      /** 置信度偏低时的提示文案（不阻断流程） */
      notice: string | null;
    };
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

// ============================================================================
// 常量
// ============================================================================

/** 会话有效期 2 小时（架构 §11.2） */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** 一致性 / 置信度偏低提示阈值（契约 §3.3.6 规则 4） */
const LOW_CONFIDENCE_THRESHOLD = 60;

/** 会话创建幂等键前缀 */
const SESSION_IDEMPOTENCY_PREFIX = 'idem:test-session';

/** 幂等记录保留时长（秒）—— 覆盖会话有效期即可 */
const SESSION_IDEMPOTENCY_TTL_SECONDS = 3 * 60 * 60;

/** MBTI 维度的正负极字母与展示标签（响应组装用） */
const MBTI_POLES: Record<string, { positive: string; negative: string; positiveLabel: string; negativeLabel: string }> =
  {
    EI: { positive: 'E', negative: 'I', positiveLabel: '外向 E', negativeLabel: '内向 I' },
    SN: { positive: 'S', negative: 'N', positiveLabel: '实感 S', negativeLabel: '直觉 N' },
    TF: { positive: 'T', negative: 'F', positiveLabel: '思考 T', negativeLabel: '情感 F' },
    JP: { positive: 'J', negative: 'P', positiveLabel: '判断 J', negativeLabel: '知觉 P' },
  };

/** 允许写答案的会话状态 */
const WRITABLE_STATUSES = new Set(['CREATED', 'IN_PROGRESS']);

@Injectable()
export class TestService {
  private readonly logger = new Logger(TestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly engine: PersonalityEngine,
    /**
     * 按模块分派算分（ADR-038）
     *
     * `engine` 仍然保留：结果视图组装（`buildResultView`）等地方按人格模块的结构取数，
     * 那些是**展示层**的需要，与"用哪个算分器"是两件事。
     */
    private readonly moduleScoring: ModuleScoringService,
  ) {}

  // ==========================================================================
  // 测试定义
  // ==========================================================================

  /** 测试定义列表（仅返回上架定义） */
  async listDefinitions(userId: string, query: ListTestsQueryDto = {}): Promise<TestDefinitionView[]> {
    const definitions = await this.prisma.testDefinition.findMany({
      where: {
        isActive: true,
        status: 'ACTIVE',
        deletedAt: null,
        ...(query.category ? { category: query.category } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        code: true,
        name: true,
        category: true,
        description: true,
        version: true,
        questionCount: true,
        estimatedMinutes: true,
        coverUrl: true,
      },
    });

    // 用一次 groupBy 拿到该用户在各定义下的完成次数与进行中会话数，
    // 避免「每个定义一次 count」的 N+1 查询
    const stats = await this.prisma.testSession.groupBy({
      by: ['definitionCode', 'status'],
      where: { userId, deletedAt: null },
      _count: { _all: true },
    });

    const completedByCode = new Map<string, number>();
    const inProgressByCode = new Map<string, number>();

    for (const row of stats) {
      if (row.status === 'SCORED' || row.status === 'REPORT_READY') {
        completedByCode.set(row.definitionCode, (completedByCode.get(row.definitionCode) ?? 0) + row._count._all);
      }
      if (row.status === 'IN_PROGRESS') {
        inProgressByCode.set(row.definitionCode, (inProgressByCode.get(row.definitionCode) ?? 0) + row._count._all);
      }
    }

    return definitions.map((definition) => ({
      code: definition.code,
      name: definition.name,
      category: definition.category,
      description: definition.description,
      version: definition.version,
      questionCount: definition.questionCount,
      estimatedMinutes: definition.estimatedMinutes,
      coverUrl: definition.coverUrl,
      completedCount: completedByCode.get(definition.code) ?? 0,
      hasInProgress: (inProgressByCode.get(definition.code) ?? 0) > 0,
    }));
  }

  /** 测试定义详情 */
  async getDefinition(userId: string, code: string): Promise<TestDefinitionView> {
    const definition = await this.prisma.testDefinition.findFirst({
      where: { code, deletedAt: null },
      select: {
        code: true,
        name: true,
        category: true,
        description: true,
        version: true,
        questionCount: true,
        estimatedMinutes: true,
        coverUrl: true,
        isActive: true,
        status: true,
      },
    });

    // 契约错误码 40001：定义不存在
    if (!definition) {
      throw BusinessException.notFound(ErrorCode.TEST_DEFINITION_NOT_FOUND);
    }

    // 契约错误码 40002：已下线
    if (!definition.isActive || definition.status !== 'ACTIVE') {
      throw BusinessException.conflict(ErrorCode.TEST_DEFINITION_INACTIVE);
    }

    const [completedCount, inProgress] = await Promise.all([
      this.prisma.testSession.count({
        where: { userId, definitionCode: code, status: { in: ['SCORED', 'REPORT_READY'] }, deletedAt: null },
      }),
      this.prisma.testSession.count({
        where: { userId, definitionCode: code, status: 'IN_PROGRESS', deletedAt: null },
      }),
    ]);

    return {
      code: definition.code,
      name: definition.name,
      category: definition.category,
      description: definition.description,
      version: definition.version,
      questionCount: definition.questionCount,
      estimatedMinutes: definition.estimatedMinutes,
      coverUrl: definition.coverUrl,
      completedCount,
      hasInProgress: inProgress > 0,
    };
  }

  // ==========================================================================
  // 创建会话
  // ==========================================================================

  async createSession(
    userId: string,
    code: string,
    dto: CreateSessionDtoInput,
    context: { idempotencyKey?: string; platform?: string; clientVersion?: string } = {},
  ): Promise<{ view: TestSessionView; created: boolean }> {
    await this.assertNotInDeletionGrace(userId);

    const definition = await this.prisma.testDefinition.findFirst({
      where: { code, isActive: true, status: 'ACTIVE', deletedAt: null },
      select: { id: true, code: true, version: true, questionCount: true },
    });

    if (!definition) {
      // 区分「不存在」与「已下线」：前者 404，后者 409（更利于前端给出不同文案）
      const exists = await this.prisma.testDefinition.findFirst({
        where: { code, deletedAt: null },
        select: { id: true },
      });

      if (!exists) throw BusinessException.notFound(ErrorCode.TEST_DEFINITION_NOT_FOUND);
      throw BusinessException.conflict(ErrorCode.TEST_DEFINITION_INACTIVE);
    }

    // --------------------------------------------------------- 幂等（防双击建双会话）
    const idempotencyRedisKey = context.idempotencyKey
      ? this.redis.key(SESSION_IDEMPOTENCY_PREFIX, userId, code, context.idempotencyKey)
      : null;

    if (idempotencyRedisKey) {
      const existingSessionId = await this.redis.get(idempotencyRedisKey);

      if (existingSessionId) {
        const existing = await this.prisma.testSession.findUnique({
          where: { id: existingSessionId },
          select: { id: true, userId: true, status: true, deletedAt: true },
        });

        if (existing && existing.userId === userId && existing.deletedAt === null) {
          this.logger.log(`会话创建幂等命中 userId=${userId} sessionId=${existing.id}`);
          const view = await this.getSession(userId, existing.id, { batch: 1 });
          return { view: { ...view, isReused: true }, created: false };
        }
      }
    }

    // --------------------------------------------------------------- 复用进行中会话
    // 契约规则 7：forceNew 优先于 reuseInProgress
    if (dto.forceNew !== true && dto.reuseInProgress !== false) {
      const inProgress = await this.prisma.testSession.findFirst({
        where: { userId, definitionCode: code, status: 'IN_PROGRESS', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, expiredAt: true },
      });

      if (inProgress && this.isNotExpired(inProgress.expiredAt)) {
        const view = await this.getSession(userId, inProgress.id, { batch: 1 });
        return { view: { ...view, isReused: true }, created: false };
      }
    }

    // --------------------------------------------------------------- 抽题与固化快照
    const questions = await this.prisma.question.findMany({
      where: { testDefinitionId: definition.id, isActive: true, deletedAt: null },
      orderBy: { order: 'asc' },
      select: {
        id: true,
        code: true,
        content: true,
        type: true,
        dimension: true,
        reverseScored: true,
        weight: true,
        tags: true,
        options: {
          where: { isActive: true },
          orderBy: { order: 'asc' },
          select: { label: true, value: true, isActive: true },
        },
      },
    });

    // 契约规则 1：宁可报错也不下发残缺试卷
    if (questions.length === 0) {
      this.logger.error(`测试定义 ${code} 没有可用题目，题库配置异常`);
      throw BusinessException.internal(ErrorCode.PERSONALITY_PROFILE_BUILDING, '测评暂时不可用，请稍后再试', {
        definitionCode: code,
        reason: 'EMPTY_QUESTION_BANK',
      });
    }

    if (questions.length < definition.questionCount) {
      this.logger.error(`测试定义 ${code} 期望 ${definition.questionCount} 题，实际可用 ${questions.length} 题`);
      throw BusinessException.internal(ErrorCode.PERSONALITY_PROFILE_BUILDING, '测评暂时不可用，请稍后再试', {
        definitionCode: code,
        expected: definition.questionCount,
        actual: questions.length,
      });
    }

    const paperSnapshot = buildPaperSnapshot(questions);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

    const session = await this.prisma.$transaction(async (tx) => {
      // forceNew：把旧的进行中会话置为 EXPIRED（保留已答数据用于分析，但不允许再提交）
      if (dto.forceNew === true) {
        const expired = await tx.testSession.updateMany({
          where: { userId, definitionCode: code, status: 'IN_PROGRESS', deletedAt: null },
          data: { status: 'EXPIRED' },
        });

        if (expired.count > 0) {
          this.logger.log(`forceNew 已终止旧的进行中会话 userId=${userId} count=${expired.count}`);
        }
      }

      return tx.testSession.create({
        data: {
          userId,
          testDefinitionId: definition.id,
          definitionCode: definition.code,
          definitionVersion: definition.version,
          status: 'IN_PROGRESS',
          paperSnapshot: paperSnapshot as unknown as Prisma.InputJsonValue,
          questionCount: paperSnapshot.questions.length,
          answeredCount: 0,
          progress: 0,
          startedAt: now,
          expiredAt: expiresAt,
          clientPlatform: context.platform ?? 'miniapp',
          clientVersion: context.clientVersion ?? null,
          idempotencyKey: context.idempotencyKey ?? null,
        },
        select: { id: true },
      });
    });

    if (idempotencyRedisKey) {
      await this.redis.set(idempotencyRedisKey, session.id, SESSION_IDEMPOTENCY_TTL_SECONDS);
    }

    this.logger.log(
      `创建测试会话 userId=${userId} code=${code} sessionId=${session.id} questions=${paperSnapshot.questions.length}`,
    );

    const view = await this.getSession(userId, session.id, { batch: 1 });

    return { view: { ...view, isReused: false }, created: true };
  }

  // ==========================================================================
  // 获取会话（断点续答 + 分批取卷）
  // ==========================================================================

  async getSession(userId: string, sessionId: string, query: GetSessionQueryDto = {}): Promise<TestSessionView> {
    const session = await this.loadOwnedSession(userId, sessionId);

    const snapshot = session.paperSnapshot as PaperSnapshot;
    const total = snapshot.questions.length;

    const batch = query.batch ?? 1;
    const pageSize = snapshot.questionsPerPage > 0 ? snapshot.questionsPerPage : total;
    const totalBatches = Math.max(1, Math.ceil(total / pageSize));

    if (batch > totalBatches) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `batch 超出范围（共 ${totalBatches} 批）`);
    }

    const start = (batch - 1) * pageSize;
    const questions = snapshot.questions.slice(start, start + pageSize);

    const answers = await this.prisma.testAnswer.findMany({
      where: { sessionId, isSkipped: false },
      select: { questionId: true },
    });
    const answeredQuestionIds = answers.map((answer) => answer.questionId);
    const answeredCount = answeredQuestionIds.length;
    const expiresAt = session.expiredAt ?? new Date(Date.now() + SESSION_TTL_MS);

    return {
      sessionId: session.id,
      userId: session.userId,
      testCode: session.definitionCode,
      testVersion: session.definitionVersion,
      engineVersion: this.engine.version,
      // 过期后对外统一呈现为 EXPIRED，不暴露内部仍为 IN_PROGRESS 的状态
      status: this.isNotExpired(expiresAt) ? session.status : 'EXPIRED',
      createdAt: session.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      remainingSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
      isReused: false,
      progress: {
        totalQuestions: total,
        answeredCount,
        currentIndex: Math.min(answeredCount, Math.max(0, total - 1)),
        completionRate: total === 0 ? 0 : Math.round((answeredCount / total) * 100),
      },
      paper: {
        snapshotVersion: snapshot.snapshotVersion,
        questionsPerPage: pageSize,
        shuffled: snapshot.shuffled,
        optionShuffled: snapshot.optionShuffled,
        answerScale: snapshot.answerScale,
        questions,
        questionsTotal: total,
        questionsReturned: questions.length,
        answeredQuestionIds,
        batch,
        totalBatches,
        hasMore: batch < totalBatches,
        nextBatch: batch < totalBatches ? batch + 1 : null,
      },
    };
  }

  // ==========================================================================
  // 批量保存答案
  // ==========================================================================

  async saveAnswers(userId: string, sessionId: string, dto: SaveAnswersDto): Promise<SaveAnswersResult> {
    const session = await this.loadOwnedSession(userId, sessionId);

    this.assertWritable(session.status, session.expiredAt);

    const snapshot = session.paperSnapshot as PaperSnapshot;
    const questionMap = new Map(snapshot.questions.map((question) => [question.questionId, question]));

    // ------------------------------------------------- 语义校验（整批原子：先全量校验）
    const normalized: Array<{
      questionId: string;
      questionType: PaperQuestion['type'];
      rawValue: number | number[];
      scoreValue: number | null;
      responseMs: number | null;
    }> = [];

    for (const answer of dto.answers) {
      const question = questionMap.get(answer.questionId);

      // 契约错误码 40007：题目不属于该试卷（防跨试卷注入）→ 整批拒绝
      if (!question) {
        throw BusinessException.badRequest(ErrorCode.QUESTION_NOT_IN_PAPER, '提交的题目不属于当前试卷', [
          { field: 'answers', issue: `题目 ${answer.questionId} 不在本试卷中` },
        ]);
      }

      const validation = this.validateAnswerValue(question, answer.value);

      // 契约错误码 40008：值域不符 → 整批拒绝
      if (!validation.ok) {
        throw BusinessException.badRequest(ErrorCode.TEST_ANSWER_INVALID, validation.message, [
          { field: 'answers', issue: `题目 ${question.code}：${validation.message}` },
        ]);
      }

      normalized.push({
        questionId: answer.questionId,
        questionType: question.type,
        rawValue: answer.value,
        scoreValue: null,
        responseMs: answer.responseMs ?? null,
      });
    }

    // ------------------------------------------------------------- 写入（单事务）
    await this.prisma.$transaction(async (tx) => {
      for (const item of normalized) {
        await tx.testAnswer.upsert({
          where: { sessionId_questionId: { sessionId, questionId: item.questionId } },
          create: {
            sessionId,
            questionId: item.questionId,
            userId,
            questionType: item.questionType,
            rawValue: item.rawValue,
            scoreValue: item.scoreValue,
            responseMs: item.responseMs,
            isSkipped: false,
          },
          update: {
            rawValue: item.rawValue,
            scoreValue: item.scoreValue,
            responseMs: item.responseMs,
            isSkipped: false,
          },
        });
      }

      const answeredCount = await tx.testAnswer.count({ where: { sessionId, isSkipped: false } });
      const total = snapshot.questions.length;

      await tx.testSession.update({
        where: { id: sessionId },
        data: {
          answeredCount,
          progress: total === 0 ? 0 : Math.round((answeredCount / total) * 100),
          // 首次写入答案时把状态从 CREATED 推进到 IN_PROGRESS
          ...(session.status === 'CREATED' ? { status: 'IN_PROGRESS' } : {}),
        },
      });
    });

    const answeredCount = await this.prisma.testAnswer.count({ where: { sessionId, isSkipped: false } });
    const total = snapshot.questions.length;

    return {
      saved: normalized.length,
      progress: {
        totalQuestions: total,
        answeredCount,
        currentIndex: Math.min(answeredCount, Math.max(0, total - 1)),
        completionRate: total === 0 ? 0 : Math.round((answeredCount / total) * 100),
      },
      serverAt: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // 提交并算分
  // ==========================================================================

  async submit(userId: string, sessionId: string, _dto: SubmitSessionDto): Promise<SubmitResultView> {
    const session = await this.loadOwnedSession(userId, sessionId);

    // ---------------------------------------------------- 幂等：已算分直接返回既有结果
    if (session.status === 'SCORED' || session.status === 'REPORT_READY') {
      this.logger.log(`重复提交，返回既有结果 userId=${userId} sessionId=${sessionId}`);
      return this.buildSubmitResultFromExisting(userId, sessionId);
    }

    this.assertWritable(session.status, session.expiredAt);

    const snapshot = session.paperSnapshot as PaperSnapshot;

    const answers = await this.prisma.testAnswer.findMany({
      where: { sessionId, isSkipped: false },
      select: { questionId: true, rawValue: true, responseMs: true },
    });

    // 契约规则 1 ①：题量完整（禁止服务端代填空值）
    if (answers.length !== snapshot.questions.length) {
      const answeredIds = new Set(answers.map((answer) => answer.questionId));
      const unansweredOrders = snapshot.questions
        .filter((question) => !answeredIds.has(question.questionId))
        .map((question) => question.order + 1)
        .slice(0, 20);

      throw BusinessException.badRequest(
        ErrorCode.TEST_ANSWER_INCOMPLETE,
        `还有 ${snapshot.questions.length - answers.length} 道题未作答`,
        [{ field: 'answers', issue: `未作答的题号：${unansweredOrders.join(', ')}` }],
      );
    }

    // --------------------------------------------------------------- 组装引擎输入
    // 规则读取走共用 loader（ADR-038）：匹配、关系报告、AI 人设都在读同一张表，
    // 各写一份 `findMany` 会让筛选条件悄悄漂移，导致"同一份数据不同页面结论不同"
    const relationshipRules = await loadRelationshipStyleRules(this.prisma);

    const engineQuestions: EngineQuestion[] = snapshot.questions.map((question) => ({
      id: question.questionId,
      type: question.type,
      dimension: question.dimension,
      weight: question.weight,
      reverseScored: question.reverseScored,
      options: question.options.map((option) => ({ value: option.value, scoreMap: null })),
    }));

    const engineAnswers: EngineAnswer[] = answers.map((answer) => ({
      questionId: answer.questionId,
      value: this.toEngineValue(answer.rawValue),
      responseMs: answer.responseMs,
    }));

    // ----------------------------------------------------------- 算分（纯函数，<10ms）
    const scoringStartedAt = Date.now();

    /**
     * 按**模块**分派算分（ADR-038）
     *
     * 此前这里直接调 `this.engine.compute(…)`，等于假设"所有测评都是人格测评" ——
     * 后果是新增任何一类测评都会走进下面那道 `mbti.type === null` 门禁，
     * 以 `40011`（HTTP 500）收场并**把用户已答的数据作废**。
     *
     * 调度器对**尚未接入**的模块显式抛错（同样 `40011`），而不是返回占位结果 ——
     * 见 `module-scoring.service.ts` 文件头。
     */
    const output = this.moduleScoring.score(session.testDefinition.module, {
      questions: engineQuestions,
      answers: engineAnswers,
      relationshipRules,
    });

    const scoringDurationMs = Date.now() - scoringStartedAt;

    /**
     * 契约规则 7：算分异常时**不产生半成品画像**
     *
     * ⚠ 这道门禁是**人格模块专属**的：人格画像以 MBTI 四字母为骨架，算不出类型就没有意义。
     * 情感与心理健康模块接入时（阶段 3 / 4）各自需要自己的完整性门禁 ——
     * 不要把它当成通用校验照搬过去（情绪量表本来就没有"类型"这个概念）。
     */
    if (output.mbti.type === null) {
      this.logger.error(
        `算分后 MBTI 类型为空，题库维度配置异常 sessionId=${sessionId} rawScores=${JSON.stringify(output.rawScores.dimensions)}`,
      );

      await this.prisma.testSession.update({
        where: { id: sessionId },
        data: { status: 'EXPIRED' },
      });

      throw BusinessException.internal(ErrorCode.PERSONALITY_PROFILE_BUILDING, '结果计算失败，请重新开始测评', {
        sessionId,
        reason: 'MBTI_TYPE_UNAVAILABLE',
      });
    }

    // 收窄为 string：TypeScript 无法把 `output.mbti.type !== null` 的收窄带进下面的
    // 事务闭包（跨函数边界不保留属性收窄），因此显式取出局部常量。
    const mbtiType: string = output.mbti.type;
    const mbtiConfidence = output.mbti.confidence;

    // ------------------------------------------------------------------ 落库
    const now = new Date();

    const persisted = await this.prisma.$transaction(async (tx) => {
      await tx.testSession.update({
        where: { id: sessionId },
        data: {
          status: 'SCORED',
          submittedAt: now,
          scoredAt: now,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          durationMs: session.startedAt ? now.getTime() - session.startedAt.getTime() : null,
        },
      });

      const result = await tx.testResult.upsert({
        where: { sessionId },
        create: {
          sessionId,
          userId,
          testDefinitionId: session.testDefinitionId,
          definitionCode: session.definitionCode,
          engineVersion: output.engineVersion,
          mbtiType,
          mbtiDimensions: output.mbti.dimensions,
          bigFiveScores: output.bigFive as unknown as Prisma.InputJsonValue,
          rawScores: output.rawScores,
          qualityMetrics: output.quality as unknown as Prisma.InputJsonValue,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          computedAt: now,
        },
        update: {
          engineVersion: output.engineVersion,
          mbtiType,
          mbtiDimensions: output.mbti.dimensions,
          bigFiveScores: output.bigFive as unknown as Prisma.InputJsonValue,
          rawScores: output.rawScores,
          qualityMetrics: output.quality as unknown as Prisma.InputJsonValue,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          computedAt: now,
        },
        select: { id: true },
      });

      // 画像版本：每次完成测试生成**新版本**，旧版本不重算（架构 §11.4 / ADR-018）
      /**
       * ADR-038 护栏：**只有人格模块的结果才写人格画像**
       *
       * 三个模块各自独立画像。把别的模块的结果写成人格画像、并翻转 `isCurrent`，
       * 会**顶掉用户真实的人格画像** —— 而报告链路读的正是 `isCurrent` 那一份，
       * 于是用户会看到一份归属错误的画像，且没有任何报错。
       *
       * 现阶段调度器只登记了 PERSONALITY，所以这是一道**防御性断言**：
       * 将来有人给新模块接入算分、却忘了给落库加分支时，这里会立刻失败。
       * 宁可让接入者当场看到错误，也不要静默写出一份归属错误的画像。
       */
      if (session.testDefinition.module !== 'PERSONALITY') {
        throw BusinessException.internal(
          ErrorCode.PERSONALITY_PROFILE_BUILDING,
          `模块「${session.testDefinition.module}」的结果不应写入人格画像（落库分支尚未接入）`,
          { sessionId, module: session.testDefinition.module },
        );
      }

      const latest = await tx.personalityProfile.findFirst({
        where: { userId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latest?.version ?? 0) + 1;

      // 旧画像取消 current 标记（同一时刻只应有一个当前画像）
      await tx.personalityProfile.updateMany({
        where: { userId, isCurrent: true },
        data: { isCurrent: false },
      });

      const profile = await tx.personalityProfile.create({
        data: {
          userId,
          testResultId: result.id,
          version: nextVersion,
          isCurrent: true,
          engineVersion: output.engineVersion,
          mbtiType,
          mbtiConfidence,
          eiPercent: output.mbti.dimensions.EI,
          snPercent: output.mbti.dimensions.SN,
          tfPercent: output.mbti.dimensions.TF,
          jpPercent: output.mbti.dimensions.JP,
          openness: output.bigFive.openness,
          conscientiousness: output.bigFive.conscientiousness,
          extraversion: output.bigFive.extraversion,
          agreeableness: output.bigFive.agreeableness,
          neuroticism: output.bigFive.neuroticism,
          traits: output.rawScores,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          computedAt: now,
        },
        select: { id: true, version: true },
      });

      // 时间序列快照：支撑「成长曲线」
      await tx.personalitySnapshot.upsert({
        where: { sourceSessionId: sessionId },
        create: {
          userId,
          profileId: profile.id,
          sourceSessionId: sessionId,
          capturedAt: now,
          mbtiType,
          bigFive: output.bigFive as unknown as Prisma.InputJsonValue,
          completenessScore: output.quality.completionRate,
        },
        update: {
          profileId: profile.id,
          mbtiType,
          bigFive: output.bigFive as unknown as Prisma.InputJsonValue,
          completenessScore: output.quality.completionRate,
        },
      });

      return { resultId: result.id, profileId: profile.id, profileVersion: profile.version };
    });

    this.logger.log(
      `算分完成 sessionId=${sessionId} mbti=${output.mbti.type} confidence=${output.mbti.confidence} profileVersion=${persisted.profileVersion} 耗时=${scoringDurationMs}ms`,
    );

    return {
      sessionId,
      status: 'SCORED',
      submittedAt: now.toISOString(),
      scoredAt: now.toISOString(),
      scoringDurationMs,
      resultId: persisted.resultId,
      profileId: persisted.profileId,
      profileVersion: persisted.profileVersion,
      engineVersion: output.engineVersion,
      isDuplicate: false,
      result: this.buildResultView(output),
    };
  }

  // ==========================================================================
  // 历史与结果
  // ==========================================================================

  async listSessions(
    userId: string,
    query: ListSessionsQueryDto,
  ): Promise<{
    items: SessionHistoryItem[];
    total: number;
    page: number;
    pageSize: number;
    hasNext: boolean;
  }> {
    const where = {
      userId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.definitionCode ? { definitionCode: query.definitionCode } : {}),
    };

    const [total, sessions] = await Promise.all([
      this.prisma.testSession.count({ where }),
      this.prisma.testSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          definitionCode: true,
          status: true,
          answeredCount: true,
          questionCount: true,
          createdAt: true,
          submittedAt: true,
          scoredAt: true,
          testDefinition: { select: { name: true } },
          result: { select: { mbtiType: true } },
        },
      }),
    ]);

    return {
      items: sessions.map((session) => ({
        sessionId: session.id,
        testCode: session.definitionCode,
        testName: session.testDefinition.name,
        status: session.status,
        mbtiType: session.result?.mbtiType ?? null,
        answeredCount: session.answeredCount,
        totalQuestions: session.questionCount,
        createdAt: session.createdAt.toISOString(),
        submittedAt: session.submittedAt ? session.submittedAt.toISOString() : null,
        scoredAt: session.scoredAt ? session.scoredAt.toISOString() : null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasNext: query.page * query.pageSize < total,
    };
  }

  /** 测试结果详情（未算分时返回 40011 语义的错误） */
  async getSessionResult(userId: string, sessionId: string): Promise<SubmitResultView> {
    const session = await this.loadOwnedSession(userId, sessionId);

    if (session.status !== 'SCORED' && session.status !== 'REPORT_READY') {
      // 未提交 / 已过期：不能返回半成品结果
      if (session.status === 'EXPIRED' || session.status === 'ABANDONED') {
        throw BusinessException.conflict(ErrorCode.TEST_SESSION_EXPIRED);
      }
      throw BusinessException.conflict(ErrorCode.TEST_SESSION_ALREADY_SUBMITTED, '该测评尚未提交，无法查看结果');
    }

    return this.buildSubmitResultFromExisting(userId, sessionId);
  }

  // ==========================================================================
  // 内部：结果组装
  // ==========================================================================

  /** 从既有落库结果组装提交响应（幂等返回路径） */
  private async buildSubmitResultFromExisting(userId: string, sessionId: string): Promise<SubmitResultView> {
    const session = await this.prisma.testSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        status: true,
        submittedAt: true,
        scoredAt: true,
        result: {
          select: {
            id: true,
            engineVersion: true,
            mbtiType: true,
            mbtiDimensions: true,
            bigFiveScores: true,
            qualityMetrics: true,
          },
        },
      },
    });

    if (!session?.result) {
      throw BusinessException.notFound(ErrorCode.TEST_SESSION_NOT_FOUND);
    }

    /**
     * 画像同时提供 `mbtiConfidence`
     *
     * ⚠ 此前置信度是**塞在 `test_results.relationship_style` 这个 Json 里**的
     * （写入时 `{ ...relationshipStyle, mbtiConfidence }`）。ADR-038 删掉该列后，
     * 置信度必须回到它本来该在的地方 —— 它是**人格**指标，`personality_profiles`
     * 本来就有 `mbti_confidence` 这一列，没必要借道一个情感结论的字段。
     */
    const profile = await this.prisma.personalityProfile.findFirst({
      where: { userId, testResultId: session.result.id },
      select: { id: true, version: true, mbtiConfidence: true },
    });

    const dimensions = (session.result.mbtiDimensions ?? {}) as Record<string, number>;
    const bigFive = (session.result.bigFiveScores ?? {}) as Record<string, number>;
    const quality = (session.result.qualityMetrics ?? {}) as Record<string, unknown>;

    return {
      sessionId,
      status: session.status,
      submittedAt: session.submittedAt ? session.submittedAt.toISOString() : new Date().toISOString(),
      scoredAt: session.scoredAt ? session.scoredAt.toISOString() : new Date().toISOString(),
      scoringDurationMs: 0,
      resultId: session.result.id,
      profileId: profile?.id ?? '',
      profileVersion: profile?.version ?? 0,
      engineVersion: session.result.engineVersion,
      isDuplicate: true,
      result: {
        mbtiType: session.result.mbtiType,
        dimensions: this.buildDimensionView(dimensions),
        confidence: profile?.mbtiConfidence ?? 0,
        bigFive,
        quality: {
          consistencyScore: Number(quality['consistencyScore'] ?? 0),
          completionRate: Number(quality['completionRate'] ?? 0),
          avgResponseMs: quality['avgResponseMs'] === null ? null : Number(quality['avgResponseMs'] ?? 0),
          rushRate: Number(quality['rushRate'] ?? 0),
          notice: this.buildQualityNotice(Number(quality['consistencyScore'] ?? 0)),
        },
      },
    };
  }

  /** 从引擎输出组装提交响应 */
  private buildResultView(output: ReturnType<PersonalityEngine['compute']>): SubmitResultView['result'] {
    return {
      mbtiType: output.mbti.type,
      dimensions: this.buildDimensionView(output.mbti.dimensions),
      confidence: output.mbti.confidence,
      bigFive: output.bigFive as unknown as Record<string, number>,
      quality: {
        consistencyScore: output.quality.consistencyScore,
        completionRate: output.quality.completionRate,
        avgResponseMs: output.quality.avgResponseMs,
        rushRate: output.quality.rushRate,
        notice: this.buildQualityNotice(output.quality.consistencyScore),
      },
    };
  }

  /** 维度视图：百分比 → 极性字母 + 展示标签 */
  private buildDimensionView(
    dimensions: Record<string, number>,
  ): Record<string, { percent: number; pole: string; leftLabel: string; rightLabel: string }> {
    const view: Record<string, { percent: number; pole: string; leftLabel: string; rightLabel: string }> = {};

    for (const [dimension, poles] of Object.entries(MBTI_POLES)) {
      const percent = dimensions[dimension] ?? 50;

      view[dimension] = {
        percent: Math.round(percent * 100) / 100,
        pole: percent >= 50 ? poles.positive : poles.negative,
        // 左端固定为负极（低分侧），与前端双向条的渲染方向一致
        leftLabel: poles.negativeLabel,
        rightLabel: poles.positiveLabel,
      };
    }

    return view;
  }

  /** 质量提示文案（不阻断流程，仅提示） */
  private buildQualityNotice(consistencyScore: number): string | null {
    if (consistencyScore >= LOW_CONFIDENCE_THRESHOLD) return null;
    return '本次作答速度较快或存在不一致，结果置信度偏低，建议在更放松的状态下重测。';
  }

  // ==========================================================================
  // 内部：校验与工具
  // ==========================================================================

  /**
   * 加载并校验会话归属（IDOR 防护）
   *
   * 契约错误码：40003 会话不存在 / 40004 会话归属他人。
   * 注意 404 与 403 的区分是刻意的：归属他人返回 403 而非 404，
   * 便于前端提示「无权访问」而不是「记录不存在」造成用户困惑；
   * 同时因为 sessionId 是 UUIDv7（不可枚举），泄露存在性的风险可接受。
   */
  private async loadOwnedSession(
    userId: string,
    sessionId: string,
  ): Promise<{
    id: string;
    userId: string;
    status: string;
    definitionCode: string;
    definitionVersion: string;
    testDefinitionId: string;
    /**
     * 所属模块（ADR-038）
     *
     * 随会话一起取出，是因为 `submit()` 必须**按模块**决定用哪个算分器、
     * 以及结果该写进哪份画像；单独再查一次会多一次往返，且容易漏。
     */
    testDefinition: { module: TestModule };
    paperSnapshot: unknown;
    startedAt: Date | null;
    expiredAt: Date | null;
    createdAt: Date;
  }> {
    const session = await this.prisma.testSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        status: true,
        definitionCode: true,
        definitionVersion: true,
        testDefinitionId: true,
        testDefinition: { select: { module: true } },
        paperSnapshot: true,
        startedAt: true,
        expiredAt: true,
        createdAt: true,
        deletedAt: true,
      },
    });

    if (!session || session.deletedAt !== null) {
      throw BusinessException.notFound(ErrorCode.TEST_SESSION_NOT_FOUND);
    }

    if (session.userId !== userId) {
      throw BusinessException.forbidden(ErrorCode.TEST_SESSION_NOT_OWNED);
    }

    return session;
  }

  /** 会话是否可写（状态 + 未过期） */
  private assertWritable(status: string, expiresAt: Date | null): void {
    if (status === 'SUBMITTED' || status === 'SCORED' || status === 'REPORT_READY') {
      // 契约规则 3：提交后禁止写答案（防止篡改影响已算分结果）
      throw BusinessException.conflict(ErrorCode.TEST_SESSION_ALREADY_SUBMITTED, '该测评已提交，无法再修改答案');
    }

    if (status === 'EXPIRED' || status === 'ABANDONED' || !this.isNotExpired(expiresAt)) {
      throw BusinessException.conflict(ErrorCode.TEST_SESSION_EXPIRED);
    }

    if (!WRITABLE_STATUSES.has(status)) {
      throw BusinessException.conflict(ErrorCode.TEST_ANSWER_INVALID, '当前会话状态不支持该操作');
    }
  }

  private isNotExpired(expiresAt: Date | null): boolean {
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now();
  }

  /** 会话处于注销冷静期时禁止开始新测评（与 user 模块的冷静期规则一致） */
  private async assertNotInDeletionGrace(userId: string): Promise<void> {
    const pending = await this.prisma.userDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
      select: { id: true },
    });

    if (pending) {
      throw BusinessException.forbidden(
        ErrorCode.PROFILE_EDIT_LOCKED,
        '账号注销冷静期内无法开始新的测评，如需继续使用请先撤销注销申请',
      );
    }
  }

  /** 答案值域校验（按题型） */
  private validateAnswerValue(
    question: PaperQuestion,
    value: number | number[],
  ): { ok: true } | { ok: false; message: string } {
    const optionValues = question.options.map((option) => option.value);

    switch (question.type) {
      case 'LIKERT5': {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          return { ok: false, message: '李克特量表答案必须是整数' };
        }
        // 以快照中的选项为准：题库可能使用自定义量表（如 0–10）
        if (!optionValues.includes(value)) {
          return { ok: false, message: `答案值必须为 ${optionValues.join('/')} 之一` };
        }
        return { ok: true };
      }

      case 'BINARY':
      case 'FORCED_CHOICE': {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          return { ok: false, message: '该题型答案必须是整数' };
        }
        if (!optionValues.includes(value)) {
          return { ok: false, message: `答案值必须为 ${optionValues.join('/')} 之一` };
        }
        return { ok: true };
      }

      case 'RANK': {
        if (!Array.isArray(value)) {
          return { ok: false, message: '排序题答案必须是数组' };
        }
        if (value.length !== optionValues.length) {
          return { ok: false, message: `排序题必须包含全部 ${optionValues.length} 个选项` };
        }
        const sorted = [...value].sort((a, b) => a - b);
        const expected = [...optionValues].sort((a, b) => a - b);
        if (sorted.some((item, index) => item !== expected[index])) {
          return { ok: false, message: '排序题答案必须是全部选项的一个排列（不可重复或缺失）' };
        }
        return { ok: true };
      }

      default:
        return { ok: false, message: '不支持的题型' };
    }
  }

  /** 数据库中的 `rawValue`（JSONB）→ 引擎答案值 */
  private toEngineValue(rawValue: unknown): number | number[] {
    if (Array.isArray(rawValue)) {
      return rawValue.filter((item): item is number => typeof item === 'number');
    }

    if (typeof rawValue === 'number') return rawValue;

    // 兼容 JSONB 中以 `{ value: n }` 形式存储的历史数据
    if (typeof rawValue === 'object' && rawValue !== null && 'value' in rawValue) {
      const inner = rawValue.value;
      if (typeof inner === 'number') return inner;
      if (Array.isArray(inner)) return inner.filter((item): item is number => typeof item === 'number');
    }

    return 0;
  }
}

/** createSession 的 DTO 输入（避免与 class-validator 装饰器耦合到 service 签名） */
export interface CreateSessionDtoInput {
  reuseInProgress?: boolean;
  forceNew?: boolean;
  clientTimezone?: string;
  source?: string;
}
