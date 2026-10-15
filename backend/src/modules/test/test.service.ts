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
import type { QuestionAudience, TestModule } from '@prisma/client';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { parseScoreMap } from '../../common/engine/score-map.util';
import { buildEmotionConclusion, type EmotionConclusion } from '../emotion/emotion-conclusion.util';
import { ATTACHMENT_THRESHOLD_CONFIG_KEYS, parseAttachmentThreshold } from '../emotion/attachment-threshold.util';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import type { EmotionEngineOutput } from '../emotion/engine/emotion-engine.types';
import {
  MENTAL_HEALTH_BAND_LABELS,
  MENTAL_HEALTH_DIMENSION_LABELS,
  MENTAL_HEALTH_DIMENSIONS,
  MENTAL_HEALTH_OVERALL_LABELS,
  type MentalHealthEngineOutput,
  type MentalHealthLevelThresholds,
} from '../mental-health/engine/mental-health-engine.types';
import { PersonalityEngine } from '../personality/engine/personality-engine.service';
import type { EngineAnswer, EngineQuestion } from '../personality/engine/personality-engine.types';
import { loadRelationshipStyleRules } from '../personality/relationship-style-rules.loader';
import { ModuleScoringService } from './module-scoring.service';
import { buildPaperSnapshot } from './paper-snapshot.builder';
import type {
  GetSessionQueryDto,
  ListSessionsQueryDto,
  ListTestsQueryDto,
  SaveAnswersDto,
  SubmitSessionDto,
} from './dto/test.dto';
import type { PaperAudience, PaperQuestion, PaperSnapshot } from './test.types';

// ============================================================================
// 响应类型
// ============================================================================

/** 测试定义视图 */
export interface TestDefinitionView {
  code: string;
  name: string;
  category: string;
  /**
   * 所属模块（ADR-038）
   *
   * 前端**必须**靠它决定三件事，因此不能省：
   *   ① 介绍页的文案（人格测评与情感测评讲的完全不是一回事）；
   *   ② 做完之后跳哪个结果页（人格结果是四维 + 大五，情感结果是依恋 + 爱的语言）；
   *   ③ 生成哪种报告（`MBTI_REPORT` vs `EMOTION_REPORT`）。
   *
   * 只给 `category` 是不够的：`category` 是模块内的算分口径细分
   * （如 `RELATIONSHIP_STYLE`），而"这是哪个模块"是更高一层的概念。
   */
  module: string;
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
    /**
     * 本次取用的题目适用人群（ADR-039）
     *
     * 情感场景题按性别分三套独立内容（男 / 女 / 中性），量表题统一为 `ALL`。
     * 下发给客户端是为了让界面能标注"这是哪一套"，也便于排障时一眼对上。
     */
    audience: PaperAudience;
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

/**
 * 提交结果的**公共外壳**
 *
 * 两个模块的提交响应共享这些字段（会话、版本、耗时、幂等标记），
 * 差异全部收在 `result` 里，并用 `module` 做判别键。
 */
interface SubmitResultEnvelope {
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

/** 质量块（两个模块共用同一份定义与算法，见 `common/engine/assessment-quality.util.ts`） */
export interface SubmitQualityView {
  consistencyScore: number;
  completionRate: number;
  avgResponseMs: number | null;
  rushRate: number;
  /** 置信度偏低时的提示文案（不阻断流程） */
  notice: string | null;
}

/** 人格模块的提交结果 */
export interface PersonalitySubmitResultView extends SubmitResultEnvelope {
  module: 'PERSONALITY';
  result: {
    mbtiType: string | null;
    dimensions: Record<string, { percent: number; pole: string; leftLabel: string; rightLabel: string }>;
    confidence: number;
    bigFive: Record<string, number>;
    quality: SubmitQualityView;
  };
}

/**
 * 情感模块的提交结果（ADR-038 阶段 3）
 *
 * ⚠ 响应里**只有情感数据**：不含 `mbtiType` / `bigFive`。
 * 情感测评没有测人格，给出这些字段等于暗示"这份情感测评也测了人格"。
 */
export interface EmotionSubmitResultView extends SubmitResultEnvelope {
  module: 'EMOTION';
  result: {
    attachment: {
      style: string;
      /** 依恋焦虑轴 0–100（结论来自两轴求交，因此两轴一起给，供报告解释） */
      anxiety: number;
      /** 依恋回避轴 0–100 */
      avoidance: number;
      thresholds: { anxiety: number; avoidance: number };
    };
    loveLanguage: {
      /** 五项得分（0–100） */
      scores: Record<string, number>;
      /** 主导项（按分数降序，最多两项） */
      primary: string[];
    };
    conflict: {
      /** 五种得分（0–100） */
      scores: Record<string, number>;
      style: string;
    };
    /**
     * 结果页的**确定性结论**（ADR-039 补）
     *
     * ⚠ 它不是 AI 写的，也不落库：由画像按固定规则算出，同一份画像任何时候
     * 都得到同一段话。结果页原先只有"标签 + 分数"，用户的原话是
     * 「看完不知道想表达什么，也没有告诉我我属于什么、需要什么、建议是什么」。
     *
     * 与 AI 报告的分工：这一段保证**做完题立刻有结论**（不必等十几秒的报告生成），
     * 深度解读与个性化建议由用户主动生成的报告承担。
     */
    conclusion: EmotionConclusion;
    quality: SubmitQualityView;
  };
}

/**
 * 心理健康模块的提交结果（ADR-038 阶段 4）
 *
 * ⚠ 这个响应里有**两样别处没有的东西**，都是产品要求而非实现细节：
 *   · `conclusion` —— 文字结论，由**确定性规则**生成（不是 AI 现编的），
 *     且**只描述、不建议**；
 *   · `disclaimer` —— 合规声明，**必须**含「本结果仅供参考」，由服务端下发，
 *     前端不得硬编码。
 */
export interface MentalHealthSubmitResultView extends SubmitResultEnvelope {
  module: 'MENTAL_HEALTH';
  result: {
    dimensions: Array<{
      key: string;
      label: string;
      /** 0–100，越高越值得留意 */
      score: number;
      /** 档位编码与中文名（与结论文本里的措辞一致，同属一份快照） */
      band: string;
      bandLabel: string;
      isHighlighted: boolean;
    }>;
    overallScore: number;
    overallLevel: string;
    overallLabel: string;
    conclusion: string;
    quality: SubmitQualityView;
    disclaimer: string;
  };
}

/**
 * 提交结果
 *
 * 用 `module` 判别的联合类型而不是"一个包含全部可选字段的大对象"：
 * 后者会让前端必须靠"这个字段在不在"来猜模块，而且人格接口会莫名其妙地
 * 暴露情感字段（正是 ADR-038 阶段 2 刚清掉的那类问题）。
 */
export type SubmitResultView = PersonalitySubmitResultView | EmotionSubmitResultView | MentalHealthSubmitResultView;

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

/**
 * 心理健康模块的合规声明（**服务端唯一真相**）
 *
 * 用户对该模块的要求是「要写好提示，**本结果仅供参考**的字样，
 * 不涉及专业建议以及心理干预，只做结论」。这段文案就是那句话的落点，
 * 它被**落库**而不是在读取时拼出来：合规文案要能独立迭代，且同一份画像
 * 在任何端看到的必须是同一段话。
 *
 * ⚠ 三条边界都写在文案里，缺一条都会让这个模块越界：
 *   ① 仅供参考、不是诊断；
 *   ② 不给建议、不做干预 —— 明说"本结果不提供建议或干预方案"，
 *      这样即使有人后来想往结论里加建议，也会先撞上这段声明；
 *   ③ 状态是变化的 —— 避免用户把一次作答当成对自己的定性。
 *
 * ## 关于最后一句（要留意）⚠
 *
 * 「如果这种状态持续了一段时间，可以告诉信任的人」这句是**安全网**，
 * 不是建议：它不针对用户的分数、不给行动方案、不指向任何机构，
 * 只是在"心理健康"这个主题上保留一个最低限度的出口。
 * 产品方若认为它也算"建议"，删掉这一句即可（它不影响任何分数与结论逻辑），
 * 但**不建议**在没有任何出口的情况下向用户呈现"值得留意"的判断。
 */
const MENTAL_HEALTH_DISCLAIMER =
  '本结果仅供参考，不构成心理诊断或医疗建议，也不提供建议或干预方案。它反映的是你本次作答时的状态，而状态是会变化的。如果这种状态已经持续了一段时间，可以告诉一个你信任的人。';

/**
 * 数组是否严格递增
 *
 * 用于校验档位阈值配置（如 `mh_band_thresholds = "30,50,70"`）。
 * 不校验的话，配置成 `"50,30,70"` 会让某一段区间**永远不可达**
 * （分数先撞上更小的上界），而档位只是显示得"有点怪"，没有任何报错 ——
 * 结论正文里的档位措辞会跟着一起错，且读起来完全通顺。
 */
const isStrictlyAscending = (values: readonly number[]): boolean =>
  values.every((value, index) => index === 0 || value > values[index - 1]);

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

/**
 * 把快照里的题目投影成**下发给客户端**的形状（ADR-039）
 *
 * 唯一的差别是**去掉 `scoreMap`**，原因有两条：
 *
 *   1. **它是算分依据**（答案键）：场景题的每个选项带维度分值，下发等于把
 *      "选哪个能得高分"直接交给客户端。即使本项目没有"正确答案"，
 *      把评分键暴露出去也会让人去凑分，而画像一旦被凑出来就不再是测量结果；
 *   2. **体积**：一题 4 个选项各带一个 2–4 键的映射，52 题就是几百个键，
 *      而这个字段客户端一次都用不到（前端只需要题干、选项文案与即时反馈）。
 *
 * ⚠ 快照（数据库里那份）**必须保留** `scoreMap` —— 提交算分是从快照重建引擎输入的，
 * 少了它场景题会被算成全 0。因此是"下发时投影"，不是"存的时候不存"。
 */
const toClientQuestion = (question: PaperQuestion): PaperQuestion => ({
  ...question,
  options: question.options.map(({ label, value, feedback }) => ({ label, value, feedback: feedback ?? null })),
});

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
        module: true,
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
      module: definition.module,
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
        module: true,
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
      module: definition.module,
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
    /**
     * 按用户性别决定抽哪一套题（ADR-039）
     *
     * 情感场景题分男 / 女 / 中性三套独立内容；量表题（MBTI、大五、状态自评）
     * 一律 `audience = 'ALL'`，不受性别影响 —— 标准化量表男女共用一套题才可比。
     *
     * ⚠ 取不到性别（`UNKNOWN` / `OTHER` / 记录缺失）时取**中性套**，
     * 而不是"随机挑一套"或"全都发"：前者会让用户拿到不属于自己的处境，
     * 后者会让同一份试卷里出现三套场景（题量直接翻三倍）。
     */
    const audience = await this.resolveQuestionAudience(userId);

    const questions = await this.prisma.question.findMany({
      where: {
        testDefinitionId: definition.id,
        isActive: true,
        deletedAt: null,
        audience: { in: ['ALL', audience] },
      },
      orderBy: { order: 'asc' },
      select: {
        id: true,
        code: true,
        content: true,
        scenarioPrompt: true,
        type: true,
        dimension: true,
        reverseScored: true,
        weight: true,
        tags: true,
        options: {
          where: { isActive: true },
          orderBy: { order: 'asc' },
          // ⚠ `scoreMap`（场景题的算分依据）与 `feedback`（即时反馈）必须一起取：
          // 快照是算分时**唯一**的题目来源，这里少取一个字段，场景题就会静默算成 0 分
          select: { label: true, value: true, isActive: true, scoreMap: true, feedback: true },
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

    const paperSnapshot = buildPaperSnapshot(
      questions.map((question) => ({
        id: question.id,
        code: question.code,
        content: question.content,
        scenarioPrompt: question.scenarioPrompt,
        type: question.type,
        dimension: question.dimension,
        reverseScored: question.reverseScored,
        weight: question.weight,
        tags: question.tags,
        /**
         * ⚠ `scoreMap` 是 JSONB，必须**收窄**而不是断言
         *
         * 后台能往这一列写进任何 JSON；直接断言成 `Record<string, number>`
         * 会让字符串/数组值一路混进算分，最后以 NaN 的形式在落库时才炸。
         * 收窄规则与后台写路径共用同一份实现（`parseScoreMap`）。
         */
        options: question.options.map((option) => ({
          label: option.label,
          value: option.value,
          isActive: option.isActive,
          scoreMap: parseScoreMap(option.scoreMap),
          feedback: option.feedback,
        })),
      })),
      { audience },
    );
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
    const questions = snapshot.questions.slice(start, start + pageSize).map(toClientQuestion);

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
        /**
         * 本次取用的题目适用人群（ADR-039）
         *
         * 情感场景题按性别分三套；把它下发给客户端有两个用处：
         * 界面可以标注"男生版 / 女生版 / 通用版"，以及排障时一眼看出这份试卷是哪一套。
         * `ps-v1` 旧快照没有这个字段，按 `ALL`（那时只有一套题）回落。
         */
        audience: snapshot.audience ?? 'ALL',
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
    const engineQuestions: EngineQuestion[] = snapshot.questions.map((question) => ({
      id: question.questionId,
      type: question.type,
      dimension: question.dimension,
      weight: question.weight,
      reverseScored: question.reverseScored,
      /**
       * 选项分值**取自快照**（ADR-039）
       *
       * ⚠ 这里曾经硬编码 `scoreMap: null`，等于把场景题的算分依据整条丢掉：
       * 沉浸式场景题的每个选项都带维度分值（一个选择同时透露依恋、冲突风格、
       * 爱的语言），丢掉之后所有作答都会被算成"该维度 0 分"，而且**不报任何错**。
       *
       * `?? null` 是给 `ps-v1` 旧快照用的：那个格式的选项里根本没有这个键，
       * 归一为 `null`（= 按选项值计分的量表语义），**不能**当成 0。
       */
      options: question.options.map((option) => ({
        value: option.value,
        scoreMap: option.scoreMap ?? null,
      })),
    }));

    const engineAnswers: EngineAnswer[] = answers.map((answer) => ({
      questionId: answer.questionId,
      value: this.toEngineValue(answer.rawValue),
      responseMs: answer.responseMs,
    }));

    // ----------------------------------------------------------- 算分（纯函数，<10ms）
    const scoringStartedAt = Date.now();

    /**
     * 情感模块走**自己的分支**（ADR-038 阶段 3）
     *
     * 为什么是提前 return 而不是在同一条流程里加判断：两个模块的落库形状**完全不同** ——
     * 人格落 MBTI 四维 + 大五五维 + 时间序列快照，情感落依恋双轴 + 五+五种分数分布、
     * 且**没有**快照表。硬合成一个函数会让"哪一列属于哪个模块"埋在条件里，
     * 而这类错误不会报错，只会写出归属混乱的数据。
     *
     * ⚠ 分支必须放在人格那套门禁**之前**：下面的 `mbti.type === null` 门禁是
     * **人格模块专属**的（情绪量表本来就没有"类型"这个概念），
     * 情感结果走进去必然被判成"算分失败"，并把用户已答的数据置为 EXPIRED。
     */
    if (session.testDefinition.module === 'EMOTION') {
      return this.submitEmotion({
        sessionId,
        userId,
        testDefinitionId: session.testDefinitionId,
        definitionCode: session.definitionCode,
        engineQuestions,
        engineAnswers,
        startedAt: scoringStartedAt,
      });
    }

    /**
     * 心理健康模块同样走**自己的分支**（ADR-038 阶段 4）
     *
     * 与情感分支的三点不同：
     *   · 落库多两样东西 —— `conclusion`（确定性规则生成的结论文本）与
     *     `disclaimer`（合规声明，**必须**含「本结果仅供参考」）；
     *   · 完整性门禁按**六个维度**分别判定（缺哪维报哪维），错误码 `40019`；
     *   · **没有 AI 报告** —— 本模块的红线是不给建议，而 AI 解读几乎必然会滑向建议
     *     （见 `mental-health.module.ts` 的说明）。
     */
    if (session.testDefinition.module === 'MENTAL_HEALTH') {
      return this.submitMentalHealth({
        sessionId,
        userId,
        testDefinitionId: session.testDefinitionId,
        definitionCode: session.definitionCode,
        engineQuestions,
        engineAnswers,
        startedAt: scoringStartedAt,
      });
    }

    /**
     * 按**模块**分派算分（ADR-038）
     *
     * 此前这里直接调 `this.engine.compute(…)`，等于假设"所有测评都是人格测评" ——
     * 后果是新增任何一类测评都会走进下面那道 `mbti.type === null` 门禁，
     * 以 `40011`（HTTP 500）收场并**把用户已答的数据作废**。
     *
     * 调度器对**尚未接入**的模块显式抛错，而不是返回占位结果 ——
     * 见 `module-scoring.service.ts` 文件头。
     *
     * 规则表只在这里读：情感分支在上面已经 return 了，而情感算分**不用**关系风格规则
     * （它是直接测量，不是从大五推导）—— 放在更前面就等于每提交一次情感测评
     * 都白读一次配置表。
     */
    const relationshipRules = await loadRelationshipStyleRules(this.prisma);

    const output = this.moduleScoring.scorePersonality(session.testDefinition.module, {
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
          rawScores: output.rawScores as unknown as Prisma.InputJsonValue,
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
          rawScores: output.rawScores as unknown as Prisma.InputJsonValue,
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
          // `traits` 是 `Json?` 列：`RawScores` 是具名接口（无索引签名），
          // Prisma 的 `InputJsonValue` 要求索引签名，故显式转换 —— 值本身是合法 JSON
          traits: output.rawScores as unknown as Prisma.InputJsonValue,
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
      module: 'PERSONALITY',
      result: this.buildResultView(output),
    };
  }

  /**
   * 情感模块的提交落库（ADR-038 阶段 3）
   *
   * ## 与人格分支的三处关键差异
   *
   * 1. **完整性门禁不同**：人格以 MBTI 四字母为骨架，算不出类型就整份作废；
   *    情感没有"类型"这个概念，它的门禁是**三个族各自有没有有效数据** ——
   *    借用引擎的 `unresolved` 列出来，缺哪个族就说哪个族。
   *    ⚠ 不能照搬人格那道门禁（见 `compute()` 里的注释），
   *    否则每次情感提交都会被判"算分失败"并把用户答案置为 EXPIRED。
   *
   * 2. **落库形状不同**：`test_results` 的 MBTI / 大五列**留空**（它们是 `nullable`，
   *    而 `definition_code` 已经说明了这是什么测评）。把情感分数塞进
   *    `bigFiveScores` 之类的列是典型的"借用别的模块的字段"，
   *    日后的统计与成长曲线会把它们当人格分数读。
   *
   * 3. **画像表不同**：写 `emotion_profiles`，**不碰** `personality_profiles` ——
   *    两者零外键往来，各自版本化、各自 `isCurrent`。
   *
   * 与人格分支一致的做法：同事务里"旧画像取消 current → 插入新版本"，
   * 并由 `emotion_profiles` 上的部分唯一索引兜底并发（见迁移
   * `20261016000000_add_emotion_module`）。
   */
  private async submitEmotion(params: {
    sessionId: string;
    userId: string;
    testDefinitionId: string;
    definitionCode: string;
    engineQuestions: EngineQuestion[];
    engineAnswers: EngineAnswer[];
    startedAt: number;
  }): Promise<SubmitResultView> {
    const { sessionId, userId, testDefinitionId, definitionCode, engineQuestions, engineAnswers, startedAt } = params;

    const output = this.moduleScoring.scoreEmotion('EMOTION', {
      questions: engineQuestions,
      answers: engineAnswers,
      // 阈值走系统配置（运营可调，不需要发版）：`attachment_threshold_anxiety` /
      // `attachment_threshold_avoidance`，读不到时用引擎默认的中位切分
      attachmentThreshold: await this.loadAttachmentThreshold(),
    });

    const scoringDurationMs = Date.now() - startedAt;

    // 三个族里任何一个给不出结论 → **不落库、明确报错**。
    // 落一份"看起来正常"的画像是这个项目里最危险的一类错误：
    // 它会顶掉用户真实的情感画像（`isCurrent` 翻转），而报告链路读的正是那一份
    if (output.unresolved.length > 0) {
      this.logger.error(
        `情感算分结果不完整，拒绝落库 sessionId=${sessionId} unresolved=${output.unresolved.join(',')}`,
      );

      throw BusinessException.internal(
        ErrorCode.EMOTION_RESULT_INCOMPLETE,
        `本次测评的结果不完整（${output.unresolved.join('、')} 缺少有效作答），无法生成画像`,
        { sessionId, unresolved: output.unresolved },
      );
    }

    // 收窄为 string：`unresolved` 为空 ⇒ 三个结论都非 null。但 TypeScript 无法把
    // "数组为空"转成属性收窄，因此这里**显式再挡一次** —— 既让类型收窄成立，
    // 也保证 `null` 绝不会落进 `NOT NULL` 列（那样 Prisma 会抛一个与业务无关的错）
    const attachmentStyle = output.attachment.style;
    const conflictStyle = output.conflict.style;

    if (attachmentStyle === null || conflictStyle === null) {
      throw BusinessException.internal(
        ErrorCode.EMOTION_RESULT_INCOMPLETE,
        '情感结果缺少必要的类型结论，无法生成画像',
        {
          sessionId,
          attachmentStyle,
          conflictStyle,
        },
      );
    }

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
        },
      });

      const result = await tx.testResult.upsert({
        where: { sessionId },
        create: {
          sessionId,
          userId,
          testDefinitionId,
          definitionCode,
          engineVersion: output.engineVersion,
          // MBTI / 大五列留空：它们不属于情感模块
          rawScores: output.rawScores as unknown as Prisma.InputJsonValue,
          qualityMetrics: output.quality as unknown as Prisma.InputJsonValue,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          computedAt: now,
        },
        update: {
          engineVersion: output.engineVersion,
          rawScores: output.rawScores as unknown as Prisma.InputJsonValue,
          qualityMetrics: output.quality as unknown as Prisma.InputJsonValue,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          computedAt: now,
        },
        select: { id: true },
      });

      const latest = await tx.emotionProfile.findFirst({
        where: { userId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latest?.version ?? 0) + 1;

      await tx.emotionProfile.updateMany({
        where: { userId, isCurrent: true },
        data: { isCurrent: false },
      });

      const profile = await tx.emotionProfile.create({
        data: {
          userId,
          testResultId: result.id,
          version: nextVersion,
          isCurrent: true,
          engineVersion: output.engineVersion,
          attachmentStyle,
          attachmentAnxiety: output.attachment.anxiety,
          attachmentAvoidance: output.attachment.avoidance,
          loveLanguageScores: output.loveLanguage.scores,
          primaryLoveLanguages: output.loveLanguage.primary,
          conflictStyle,
          conflictScores: output.conflict.scores,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          computedAt: now,
        },
        select: { id: true, version: true },
      });

      return { resultId: result.id, profileId: profile.id, profileVersion: profile.version };
    });

    this.logger.log(
      `情感算分完成 sessionId=${sessionId} 依恋=${attachmentStyle} 主导爱的语言=${output.loveLanguage.primary.join(',')} 冲突=${conflictStyle} profileVersion=${persisted.profileVersion} 耗时=${scoringDurationMs}ms`,
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
      module: 'EMOTION',
      result: this.buildEmotionResultView(output),
    };
  }

  /**
   * 心理健康模块的提交落库（ADR-038 阶段 4）
   *
   * ## 与另两个分支最本质的差异：这个模块的交付物是**一段文字**
   *
   * 人格模块给的是类型与分数分布，情感模块给的是依恋/爱的语言/冲突风格。
   * 本模块给的是「多维度得分 + 文字结论」，因此 `conclusion` 与 `disclaimer`
   * 必须**由服务端生成并落库**：
   *
   *   · `conclusion` 由引擎的确定性规则产出，**只描述、不建议**。
   *     不交给模型：一份 AI 解读几乎不可能只陈述结论而不加建议，
   *     而"不给建议、不做干预"是这个模块的红线（用户原话）。
   *   · `disclaimer` 含「本结果仅供参考」等合规文案，同样落库 ——
   *     前端不得硬编码，合规文案要能独立迭代而不发版。
   *
   * ## 完整性门禁按**六个维度**逐一判定
   *
   * 与情感模块同形（缺哪维报哪维），但语义不同：情感模块的三族各自是一个结论，
   * 而本模块的六维共同支撑**一段结论**。因此任一维缺数据都会让那段文字不完整 ——
   * 与其写一段"少了一个维度"的结论，不如明确报错让运营去补题库（`40019`）。
   */
  private async submitMentalHealth(params: {
    sessionId: string;
    userId: string;
    testDefinitionId: string;
    definitionCode: string;
    engineQuestions: EngineQuestion[];
    engineAnswers: EngineAnswer[];
    startedAt: number;
  }): Promise<SubmitResultView> {
    const { sessionId, userId, testDefinitionId, definitionCode, engineQuestions, engineAnswers, startedAt } = params;

    const output = this.moduleScoring.scoreMentalHealth('MENTAL_HEALTH', {
      questions: engineQuestions,
      answers: engineAnswers,
      // 档位阈值走系统配置（运营可调，不需要发版）：读不到时用引擎默认值
      levelThresholds: await this.loadMentalHealthThresholds(),
    });

    const scoringDurationMs = Date.now() - startedAt;

    if (output.unresolved.length > 0) {
      this.logger.error(
        `心理健康结果不完整，拒绝落库 sessionId=${sessionId} unresolved=${output.unresolved.join(',')}`,
      );

      throw BusinessException.internal(
        ErrorCode.MENTAL_HEALTH_RESULT_INCOMPLETE,
        `本次测评的结果不完整（缺少 ${output.unresolved.join('、')} 的有效作答），无法给出结论`,
        { sessionId, unresolved: output.unresolved },
      );
    }

    const now = new Date();
    const disclaimer = MENTAL_HEALTH_DISCLAIMER;

    /**
     * 六维结果按**对象**落库（分数 + 档位 + 是否有数据）
     *
     * 档位与分数一起快照：`conclusion` 里嵌着档位措辞，若档位在读取时按当前阈值
     * 重算，阈值一改就会出现"页面标签说平稳、结论正文说比较突出"的自相矛盾。
     */
    const dimensionScores = Object.fromEntries(
      MENTAL_HEALTH_DIMENSIONS.map((dimension) => [
        dimension,
        {
          score: output.dimensions[dimension].score,
          band: output.dimensions[dimension].band,
          usable: output.dimensions[dimension].usable,
        },
      ]),
    );

    const persisted = await this.prisma.$transaction(async (tx) => {
      await tx.testSession.update({
        where: { id: sessionId },
        data: {
          status: 'SCORED',
          submittedAt: now,
          scoredAt: now,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
        },
      });

      const result = await tx.testResult.upsert({
        where: { sessionId },
        create: {
          sessionId,
          userId,
          testDefinitionId,
          definitionCode,
          engineVersion: output.engineVersion,
          // MBTI / 大五列留空：它们不属于本模块
          rawScores: output.rawScores as unknown as Prisma.InputJsonValue,
          qualityMetrics: output.quality as unknown as Prisma.InputJsonValue,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          computedAt: now,
        },
        update: {
          engineVersion: output.engineVersion,
          rawScores: output.rawScores as unknown as Prisma.InputJsonValue,
          qualityMetrics: output.quality as unknown as Prisma.InputJsonValue,
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          computedAt: now,
        },
        select: { id: true },
      });

      const latest = await tx.mentalHealthProfile.findFirst({
        where: { userId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latest?.version ?? 0) + 1;

      await tx.mentalHealthProfile.updateMany({
        where: { userId, isCurrent: true },
        data: { isCurrent: false },
      });

      const profile = await tx.mentalHealthProfile.create({
        data: {
          userId,
          testResultId: result.id,
          version: nextVersion,
          isCurrent: true,
          engineVersion: output.engineVersion,
          dimensionScores: dimensionScores,
          overallLevel: output.overallLevel,
          overallScore: output.overallScore,
          conclusion: output.conclusion,
          highlightedDimensions: [...output.highlightedDimensions],
          consistencyScore: output.quality.consistencyScore,
          completionRate: output.quality.completionRate,
          avgResponseMs: output.quality.avgResponseMs,
          disclaimer,
          computedAt: now,
        },
        select: { id: true, version: true },
      });

      return { resultId: result.id, profileId: profile.id, profileVersion: profile.version };
    });

    this.logger.log(
      `心理健康算分完成 sessionId=${sessionId} 整体=${output.overallLevel}(${output.overallScore}) 高亮=${output.highlightedDimensions.join(',')} profileVersion=${persisted.profileVersion} 耗时=${scoringDurationMs}ms`,
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
      module: 'MENTAL_HEALTH',
      result: this.buildMentalHealthResultView(output, disclaimer),
    };
  }

  /**
   * 档位阈值（系统配置，运营可调）
   *
   * 三段式配置：单维三个分界 + 整体两个分界。任何一段缺失或非法就整组回落默认值 ——
   * **不部分采用**：单维用新阈值、整体用旧阈值会让两者不自洽，
   * 而用户看到的结论正是两者拼起来的。
   */
  private async loadMentalHealthThresholds(): Promise<MentalHealthLevelThresholds | undefined> {
    const keys = ['mh_band_thresholds', 'mh_overall_thresholds'];
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: keys }, deletedAt: null },
      select: { key: true, value: true },
    });

    const parseList = (key: string): number[] | undefined => {
      const raw = rows.find((row) => row.key === key)?.value;
      if (raw === undefined) return undefined;

      const values = raw
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);

      return values.length > 0 ? values : undefined;
    };

    const band = parseList('mh_band_thresholds');
    const overall = parseList('mh_overall_thresholds');

    // 必须恰好是三段与两段，且严格递增 —— 否则档位判定会出现不可达或重叠的区间
    if (band === undefined || band.length !== 3 || !isStrictlyAscending(band)) return undefined;
    if (overall === undefined || overall.length !== 2 || !isStrictlyAscending(overall)) return undefined;

    return { band: [band[0], band[1], band[2]], overall: [overall[0], overall[1]] };
  }

  /** 从引擎输出组装心理健康提交响应 */
  private buildMentalHealthResultView(
    output: MentalHealthEngineOutput,
    disclaimer: string,
  ): MentalHealthSubmitResultView['result'] {
    const highlighted = new Set(output.highlightedDimensions);

    return {
      dimensions: MENTAL_HEALTH_DIMENSIONS.map((dimension) => ({
        key: dimension,
        label: MENTAL_HEALTH_DIMENSION_LABELS[dimension],
        score: output.dimensions[dimension].score,
        band: output.dimensions[dimension].band,
        bandLabel: MENTAL_HEALTH_BAND_LABELS[output.dimensions[dimension].band],
        isHighlighted: highlighted.has(dimension),
      })),
      overallScore: output.overallScore,
      overallLevel: output.overallLevel,
      overallLabel: MENTAL_HEALTH_OVERALL_LABELS[output.overallLevel],
      conclusion: output.conclusion,
      quality: {
        consistencyScore: output.quality.consistencyScore,
        completionRate: output.quality.completionRate,
        avgResponseMs: output.quality.avgResponseMs,
        rushRate: output.quality.rushRate,
        notice: this.buildQualityNotice(output.quality.consistencyScore),
      },
      disclaimer,
    };
  }

  /**
   * 依恋两轴的判定阈值（系统配置，运营可调）
   *
   * 读不到或值非法时返回 `undefined`，由引擎回落到 ECR 惯例的中位切分 50。
   * **不抛错**：一个可选的产品口径配置缺失，不该让用户提交不了测评。
   *
   * ⚠ **解析与校验在 `attachment-threshold.util.ts`**，不在这里：报告详情页
   * 也要用同一份阈值画条形图，两处各写一遍迟早会出现"结果页说 52 是中等、
   * 报告页说 52 是偏高"。本方法只负责查配置表。
   */
  private async loadAttachmentThreshold(): Promise<{ anxiety: number; avoidance: number } | undefined> {
    const rows = await this.prisma.systemConfig.findMany({
      where: {
        key: { in: [...ATTACHMENT_THRESHOLD_CONFIG_KEYS] },
        deletedAt: null,
      },
      select: { key: true, value: true },
    });

    return parseAttachmentThreshold(rows);
  }

  /**
   * 该用户应抽哪一套题（ADR-039）
   *
   * 情感场景题分男 / 女 / 中性三套独立内容；量表题一律 `audience = 'ALL'`，
   * 不受性别影响（标准化量表男女共用一套题才有可比性）。
   *
   * ⚠ 缺省取**中性套**：用户没填过、选了"不想说"，或记录读不到，都走中性套。
   * 🚫 不要"随机挑一套"（用户会拿到不属于自己的处境），
   * 也不要"三套全发"（同一份试卷里出现三套场景，题量直接翻三倍）。
   */
  private async resolveQuestionAudience(userId: string): Promise<QuestionAudience> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { gender: true },
    });

    if (user?.gender === 'MALE') return 'MALE';
    if (user?.gender === 'FEMALE') return 'FEMALE';

    return 'NEUTRAL';
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
        testDefinition: { select: { module: true } },
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

    // 情感模块的结果不在 `test_results` 的 MBTI / 大五列里（那些列对它**留空**），
    // 而是落在 `emotion_profiles`。按模块分流读取，
    // 否则情感会话会返回一份 mbtiType=null、bigFive={} 的"人格结果"
    if (session.testDefinition.module === 'EMOTION') {
      return this.buildEmotionResultFromExisting({ userId, sessionId, session });
    }

    // 心理健康模块同理：结果落在 `mental_health_profiles`，
    // 而不是 `test_results` 的 MBTI / 大五列（那些列对它留空）
    if (session.testDefinition.module === 'MENTAL_HEALTH') {
      return this.buildMentalHealthResultFromExisting({ userId, sessionId, session });
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
      module: 'PERSONALITY',
      result: {
        mbtiType: session.result.mbtiType,
        dimensions: this.buildDimensionView(dimensions),
        confidence: profile?.mbtiConfidence ?? 0,
        bigFive,
        quality: this.buildQualityViewFromJson(session.result.qualityMetrics),
      },
    };
  }

  /**
   * 情感会话的既有结果
   *
   * 数据来源是 `emotion_profiles` 那一行 —— 它比 `test_results.qualityMetrics`
   * 更完整（两个轴、五+五种分数分布都在那里），因此质量指标也从它读，
   * 保证"同一份画像怎么读都是同一组数字"。
   */
  private async buildEmotionResultFromExisting(params: {
    userId: string;
    sessionId: string;
    session: {
      status: string;
      submittedAt: Date | null;
      scoredAt: Date | null;
      result: { id: string; engineVersion: string } | null;
    };
  }): Promise<EmotionSubmitResultView> {
    const { userId, sessionId, session } = params;

    if (session.result === null) {
      throw BusinessException.notFound(ErrorCode.TEST_SESSION_NOT_FOUND);
    }

    const profile = await this.prisma.emotionProfile.findFirst({
      where: { userId, testResultId: session.result.id, deletedAt: null },
      select: {
        id: true,
        version: true,
        attachmentStyle: true,
        attachmentAnxiety: true,
        attachmentAvoidance: true,
        loveLanguageScores: true,
        primaryLoveLanguages: true,
        conflictStyle: true,
        conflictScores: true,
        consistencyScore: true,
        completionRate: true,
        avgResponseMs: true,
      },
    });

    if (profile === null) {
      // 画像被清理后结果仍在：明确告知"结果不存在"，而不是回一份空壳
      throw BusinessException.notFound(ErrorCode.EMOTION_PROFILE_NOT_FOUND);
    }

    return {
      sessionId,
      status: session.status,
      submittedAt: session.submittedAt ? session.submittedAt.toISOString() : new Date().toISOString(),
      scoredAt: session.scoredAt ? session.scoredAt.toISOString() : new Date().toISOString(),
      scoringDurationMs: 0,
      resultId: session.result.id,
      profileId: profile.id,
      profileVersion: profile.version,
      engineVersion: session.result.engineVersion,
      isDuplicate: true,
      module: 'EMOTION',
      result: {
        attachment: {
          style: profile.attachmentStyle,
          anxiety: profile.attachmentAnxiety,
          avoidance: profile.attachmentAvoidance,
          // 阈值不落库（它是当时的配置，不是测量值）—— 重复读取时给当前的生效值，
          // 并明确它是"用于解释类型判定的口径"，不参与任何分数
          thresholds: (await this.loadAttachmentThreshold()) ?? { anxiety: 50, avoidance: 50 },
        },
        loveLanguage: {
          scores: (profile.loveLanguageScores ?? {}) as Record<string, number>,
          primary: profile.primaryLoveLanguages,
        },
        conflict: {
          scores: (profile.conflictScores ?? {}) as Record<string, number>,
          style: profile.conflictStyle,
        },
        /**
         * 结论（ADR-039 补）：结果页要能直接回答"我是什么样、我需要什么、我该做什么"
         *
         * 纯函数、不落库 —— 它是**由画像按固定规则推出来的描述**，
         * 同一份画像任何时候都得到同一段话（ADR-005 的可复现要求）。
         * 与 AI 报告的分工：这一段保证"做完题立刻有结论"，
         * 深度解读与个性化建议仍由用户主动生成的报告承担。
         */
        conclusion: buildEmotionConclusion({
          attachmentStyle: profile.attachmentStyle,
          attachmentAnxiety: profile.attachmentAnxiety,
          attachmentAvoidance: profile.attachmentAvoidance,
          loveLanguageScores: (profile.loveLanguageScores ?? null) as Record<string, number> | null,
          primaryLoveLanguages: profile.primaryLoveLanguages,
          conflictStyle: profile.conflictStyle,
          conflictScores: (profile.conflictScores ?? null) as Record<string, number> | null,
        }),
        quality: {
          consistencyScore: profile.consistencyScore ?? 0,
          completionRate: profile.completionRate ?? 0,
          avgResponseMs: profile.avgResponseMs,
          // `emotion_profiles` 没有存 rushRate（它是质量指标的派生值，不是画像数据）；
          // 从 `test_results.qualityMetrics` 里读，读不到给 0 ——
          // 它是提示性指标，不值得为它给画像表加一列
          rushRate: await this.readRushRate(session.result.id),
          notice: this.buildQualityNotice(profile.consistencyScore ?? 0),
        },
      },
    };
  }

  /**
   * 心理健康会话的既有结果（幂等返回路径）
   *
   * 数据来源是 `mental_health_profiles` 那一行 —— 六维分数、档位、**结论文本**与
   * 免责声明都在那里。结论从落库值读而不是现算：它是用户当时看到的那段话，
   * 属于历史快照，算法或阈值升级都不该改写它。
   */
  private async buildMentalHealthResultFromExisting(params: {
    userId: string;
    sessionId: string;
    session: {
      status: string;
      submittedAt: Date | null;
      scoredAt: Date | null;
      result: { id: string; engineVersion: string } | null;
    };
  }): Promise<MentalHealthSubmitResultView> {
    const { userId, sessionId, session } = params;

    if (session.result === null) {
      throw BusinessException.notFound(ErrorCode.TEST_SESSION_NOT_FOUND);
    }

    const profile = await this.prisma.mentalHealthProfile.findFirst({
      where: { userId, testResultId: session.result.id, deletedAt: null },
      select: {
        id: true,
        version: true,
        dimensionScores: true,
        overallLevel: true,
        overallScore: true,
        conclusion: true,
        highlightedDimensions: true,
        consistencyScore: true,
        completionRate: true,
        avgResponseMs: true,
        disclaimer: true,
      },
    });

    if (profile === null) {
      throw BusinessException.notFound(ErrorCode.MENTAL_HEALTH_PROFILE_NOT_FOUND);
    }

    const stored = (profile.dimensionScores ?? {}) as Record<string, unknown>;
    const highlighted = new Set(profile.highlightedDimensions);
    const overallLevel = profile.overallLevel as keyof typeof MENTAL_HEALTH_OVERALL_LABELS;

    return {
      sessionId,
      status: session.status,
      submittedAt: session.submittedAt ? session.submittedAt.toISOString() : new Date().toISOString(),
      scoredAt: session.scoredAt ? session.scoredAt.toISOString() : new Date().toISOString(),
      scoringDurationMs: 0,
      resultId: session.result.id,
      profileId: profile.id,
      profileVersion: profile.version,
      engineVersion: session.result.engineVersion,
      isDuplicate: true,
      module: 'MENTAL_HEALTH',
      result: {
        dimensions: MENTAL_HEALTH_DIMENSIONS.map((dimension) => {
          // 分数与档位都读**落库快照**：结论文本里嵌着档位措辞，
          // 在此按当前阈值重算会出现"标签与正文不一致"
          const item = (stored[dimension] ?? {}) as { score?: unknown; band?: unknown };
          const band = typeof item.band === 'string' ? item.band : 'MILD';

          return {
            key: dimension,
            label: MENTAL_HEALTH_DIMENSION_LABELS[dimension],
            score: typeof item.score === 'number' ? item.score : 0,
            band,
            bandLabel: MENTAL_HEALTH_BAND_LABELS[band as keyof typeof MENTAL_HEALTH_BAND_LABELS] ?? band,
            isHighlighted: highlighted.has(dimension),
          };
        }),
        overallScore: profile.overallScore,
        overallLevel: profile.overallLevel,
        overallLabel: MENTAL_HEALTH_OVERALL_LABELS[overallLevel] ?? profile.overallLevel,
        conclusion: profile.conclusion,
        quality: {
          consistencyScore: profile.consistencyScore ?? 0,
          completionRate: profile.completionRate ?? 0,
          avgResponseMs: profile.avgResponseMs,
          rushRate: await this.readRushRate(session.result.id),
          notice: this.buildQualityNotice(profile.consistencyScore ?? 0),
        },
        disclaimer: profile.disclaimer,
      },
    };
  }

  /** 从 `test_results.qualityMetrics` 读过快作答比例（读不到给 0） */
  private async readRushRate(testResultId: string): Promise<number> {
    const row = await this.prisma.testResult.findUnique({
      where: { id: testResultId },
      select: { qualityMetrics: true },
    });

    const quality = (row?.qualityMetrics ?? {}) as Record<string, unknown>;

    return Number(quality['rushRate'] ?? 0);
  }

  /** 从 JSONB 质量块组装视图（类型守卫，避免把对象 String 化成 '[object Object]'） */
  private buildQualityViewFromJson(value: unknown): SubmitQualityView {
    const quality = (value ?? {}) as Record<string, unknown>;
    const consistencyScore = Number(quality['consistencyScore'] ?? 0);

    return {
      consistencyScore,
      completionRate: Number(quality['completionRate'] ?? 0),
      avgResponseMs: quality['avgResponseMs'] === null ? null : Number(quality['avgResponseMs'] ?? 0),
      rushRate: Number(quality['rushRate'] ?? 0),
      notice: this.buildQualityNotice(consistencyScore),
    };
  }

  /** 从情感引擎输出组装提交响应 */
  private buildEmotionResultView(output: EmotionEngineOutput): EmotionSubmitResultView['result'] {
    return {
      attachment: {
        // `submitEmotion` 已在落库前拦下 `style === null` 的情况，因此这里必然有值
        style: output.attachment.style ?? '',
        anxiety: output.attachment.anxiety,
        avoidance: output.attachment.avoidance,
        thresholds: output.attachment.thresholds,
      },
      loveLanguage: {
        scores: output.loveLanguage.scores,
        primary: [...output.loveLanguage.primary],
      },
      conflict: {
        scores: output.conflict.scores,
        style: output.conflict.style ?? '',
      },
      // 见 `buildEmotionResultFromExisting` 里的说明：结果页的结论是**算出来的**，
      // 与 AI 报告分工 —— 用户做完题立刻有结论，不必等报告生成
      conclusion: buildEmotionConclusion({
        attachmentStyle: output.attachment.style ?? '',
        attachmentAnxiety: output.attachment.anxiety,
        attachmentAvoidance: output.attachment.avoidance,
        loveLanguageScores: output.loveLanguage.scores,
        primaryLoveLanguages: output.loveLanguage.primary,
        conflictStyle: output.conflict.style ?? '',
        conflictScores: output.conflict.scores,
      }),
      quality: {
        consistencyScore: output.quality.consistencyScore,
        completionRate: output.quality.completionRate,
        avgResponseMs: output.quality.avgResponseMs,
        rushRate: output.quality.rushRate,
        notice: this.buildQualityNotice(output.quality.consistencyScore),
      },
    };
  }

  /** 从引擎输出组装提交响应 */
  private buildResultView(output: ReturnType<PersonalityEngine['compute']>): PersonalitySubmitResultView['result'] {
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
