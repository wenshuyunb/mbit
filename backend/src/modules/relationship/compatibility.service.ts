/**
 * 匹配报告服务（契约 §3.6.8 / §3.6.9；架构 §12.2）
 *
 * ## 两阶段管道（与 Prisma 枚举一致）
 *
 * ```
 * QUEUED ──worker──► COMPUTING ──算分落库──► SUCCEEDED
 *                       │
 *                       └─ 失败 ──► FAILED
 * ```
 *
 * `CompatibilityReportStatus` 里的 `GENERATING` 是为**第二阶段（AI 解读）**预留的：
 * 本期只落确定性算分结果，AI 解读复用 `ai.report` 管道（`RELATIONSHIP_REPORT`），
 * 落地后算分成功会停在 `GENERATING` 而非 `SUCCEEDED`。
 *
 * ## 为什么算分要进队列而不是同步做
 *
 * 算分本身很快（纯数学），但契约 §3.6.8 把它设计成异步是为了**统一形态**：
 * 后续的 AI 解读必然异步（要调外部 LLM，秒级到十几秒）。若算分同步、解读异步，
 * 客户端就要处理两种截然不同的返回语义；统一成"提交 → 轮询"后，
 * 前端只有一条路径。
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { QUEUE_COMPATIBILITY_CALC } from '../../infra/queue/queue.module';
import { ReportService } from '../ai/report/report.service';
import {
  COMPATIBILITY_ENGINE_VERSION,
  computeCompatibility,
  type CompatibilityProfile,
  type CompatibilityWeights,
} from '../personality/engine/compatibility-engine.service';
import {
  ACTIVE_COMPATIBILITY_STATUSES,
  buildCompatibilityCacheKey,
  resolveCompatibilityBlocker,
  type CompatibilityBlockedReason,
} from './compatibility.util';
import {
  compatibilityScoreLabel,
  compatibilityScoreLevel,
  type CompatibilityScoreLevel,
} from './relationship-view.util';

/** 触发算分的结果 */
export interface CompatibilityRequestView {
  readonly reportId: string;
  readonly status: string;
  readonly queue: string;
  readonly isReused: boolean;
  readonly estimatedSeconds: number;
}

/** 匹配报告视图（契约 §3.6.9） */
export interface CompatibilityReportView {
  readonly reportId: string;
  readonly relationshipId: string;
  readonly status: string;
  readonly totalScore: number | null;
  readonly mbtiScore: number | null;
  readonly bigFiveScore: number | null;
  readonly attachmentScore: number | null;
  readonly communicationScore: number | null;
  readonly scoreLevel: CompatibilityScoreLevel | null;
  readonly scoreLabel: string | null;
  readonly scoreBreakdown: Record<string, unknown> | null;
  readonly engineVersion: string;
  readonly weightsVersion: string;
  readonly computedAt: string | null;
  readonly createdAt: string;
  /** 失败时的友好文案（**不透出上游错误原文**） */
  readonly failureReason?: string;
  /** AI 解读部分的落库状态（本期恒为未生成） */
  readonly aiInterpretation: {
    readonly available: boolean;
    readonly aiReportId: string | null;
  };
}

/** 算分耗时的预估（契约 §3.6.6 的 `estimatedSeconds`） */
const ESTIMATED_SECONDS = 5;

/** 无可用权重矩阵时的错误码（属配置事故，不是用户问题） */
const MISSING_WEIGHTS_MESSAGE = '匹配权重矩阵未配置，请稍后重试';

@Injectable()
export class CompatibilityService {
  private readonly logger = new Logger(CompatibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_COMPATIBILITY_CALC) private readonly calcQueue: Queue,
    // 用普通 import 而非 `import type`：Nest 的构造参数注入依赖
    // `design:paramtypes` 元数据里的运行时类引用，`import type` 会被编译期擦除
    private readonly reports: ReportService,
  ) {}

  /**
   * 触发匹配算分（契约 §3.6.8）
   *
   * 幂等：同一组（双方画像 + 权重版本 + 引擎版本）只会有一份报告，重复触发返回
   * 既有报告而非新建 —— 否则用户连点两次就会消耗两次 AI 配额。
   */
  async requestCompatibility(userId: string, relationshipId: string): Promise<CompatibilityRequestView> {
    const relationship = await this.prisma.relationship.findFirst({
      where: {
        id: relationshipId,
        deletedAt: null,
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      select: { id: true, status: true, userAId: true, userBId: true },
    });

    // 非双方一律按"不存在"处理（与关系详情同一口径，避免 IDOR 枚举）
    if (relationship === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    const profiles = await this.prisma.personalityProfile.findMany({
      where: { userId: { in: [relationship.userAId, relationship.userBId] }, isCurrent: true },
      select: { id: true, userId: true, version: true },
    });

    const profileA = profiles.find((profile) => profile.userId === relationship.userAId);
    const profileB = profiles.find((profile) => profile.userId === relationship.userBId);

    const inProgress = await this.prisma.compatibilityReport.findFirst({
      where: {
        relationshipId,
        deletedAt: null,
        // 复用同一份常量而不是重抄字面量：`resolveCompatibilityBlocker` 的
        // "是否已在生成"判断与这里的查询条件必须一致，否则会出现
        // "查不到进行中的报告所以允许触发，但 blocker 又说在生成"的矛盾
        status: { in: [...ACTIVE_COMPATIBILITY_STATUSES] },
      },
      select: { id: true, status: true },
    });

    const blocker = resolveCompatibilityBlocker({
      status: relationship.status,
      // 契约的 `MY_NO_PROFILE` 指向当前请求者（可能是 A 也可能是 B）
      iHaveProfile: profiles.some((profile) => profile.userId === userId),
      partnerHasProfile: profiles.length === 2,
      isGenerating: inProgress !== null,
    });

    if (blocker !== null) {
      return this.throwForBlocker(blocker, relationshipId, inProgress?.id ?? null);
    }

    // 到这里 profileA/profileB 必然存在（blocker 已覆盖缺失情况）
    if (profileA === undefined || profileB === undefined) {
      throw new BusinessException(ErrorCode.COMPATIBILITY_PEER_NOT_READY, '双方画像不完整，无法算分');
    }

    const weights = await this.loadActiveWeights();
    const cacheKey = buildCompatibilityCacheKey({
      engineVersion: COMPATIBILITY_ENGINE_VERSION,
      weightsVersion: weights.version,
      profileAId: profileA.id,
      profileAVersion: profileA.version,
      profileBId: profileB.id,
      profileBVersion: profileB.version,
    });

    const existing = await this.prisma.compatibilityReport.findUnique({
      where: { cacheKey },
      select: { id: true, status: true },
    });

    // 命中缓存：报告已算过且输入完全相同，直接复用（用户不会为同一结果付两次费）
    if (existing !== null && existing.status === 'SUCCEEDED') {
      this.logger.log(`匹配报告命中缓存 reportId=${existing.id}`);

      return {
        reportId: existing.id,
        status: existing.status,
        queue: QUEUE_COMPATIBILITY_CALC,
        isReused: true,
        estimatedSeconds: 0,
      };
    }

    const report =
      existing ??
      (await this.prisma.compatibilityReport.create({
        data: {
          relationshipId,
          profileAId: profileA.id,
          profileBId: profileB.id,
          weightsId: weights.id,
          weightsVersion: weights.version,
          engineVersion: COMPATIBILITY_ENGINE_VERSION,
          status: 'QUEUED',
          cacheKey,
        },
        select: { id: true, status: true },
      }));

    // `jobId` 用 reportId：BullMQ 会用 jobId 去重，重复入队不会产生第二个任务
    await this.calcQueue.add(
      'compute',
      { reportId: report.id },
      { jobId: report.id, attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
    );

    this.logger.log(`匹配算分已入队 reportId=${report.id} relationshipId=${relationshipId}`);

    return {
      reportId: report.id,
      status: 'QUEUED',
      queue: QUEUE_COMPATIBILITY_CALC,
      isReused: false,
      estimatedSeconds: ESTIMATED_SECONDS,
    };
  }

  /**
   * 由 worker 调用：算分并落库
   *
   * 全部计算走 `computeCompatibility`（纯函数，已单测），本方法只负责取数与落库。
   */
  async computeAndPersist(reportId: string): Promise<void> {
    const report = await this.prisma.compatibilityReport.findFirst({
      where: { id: reportId, deletedAt: null },
      select: {
        id: true,
        status: true,
        relationshipId: true,
        profileAId: true,
        profileBId: true,
        weightsId: true,
      },
    });

    if (report === null) {
      this.logger.warn(`匹配报告不存在，跳过算分 reportId=${reportId}`);
      return;
    }

    // 已成功则直接返回：重试投递、重复消费都不应重算
    if (report.status === 'SUCCEEDED') {
      this.logger.log(`匹配报告已算分，跳过重复调用 reportId=${reportId}`);
      return;
    }

    await this.prisma.compatibilityReport.update({
      where: { id: report.id },
      data: { status: 'COMPUTING' },
    });

    try {
      const [profileA, profileB, weights] = await Promise.all([
        this.loadProfile(report.profileAId),
        this.loadProfile(report.profileBId),
        this.loadWeightsById(report.weightsId),
      ]);

      const result = computeCompatibility(profileA, profileB, weights);

      await this.prisma.$transaction([
        this.prisma.compatibilityReport.update({
          where: { id: report.id },
          data: {
            status: 'SUCCEEDED',
            totalScore: result.totalScore,
            mbtiScore: result.mbtiScore,
            bigFiveScore: result.bigFiveScore,
            attachmentScore: result.attachmentScore,
            communicationScore: result.communicationScore,
            scoreBreakdown: result.scoreBreakdown as never,
            computedAt: new Date(),
          },
        }),
        this.prisma.relationship.update({
          where: { id: report.relationshipId },
          data: { lastReportAt: new Date(), reportCount: { increment: 1 } },
        }),
      ]);

      this.logger.log(
        `匹配报告已生成 reportId=${report.id} score=${result.totalScore} skipped=${result.skippedDimensions.join(',') || '无'}`,
      );

      // 算分成功后接着触发 **AI 解读**（第二阶段）。失败不影响算分结果 ——
      // 分数是确定性事实且已落库；解读只是它的叙述层，可以稍后补
      await this.triggerInterpretation(report.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // 失败必须落库：只打日志的话用户永远停在"生成中"，
      // 而列表页也无法告诉他"这份报告失败了、可以重试"
      await this.prisma.compatibilityReport
        .update({
          where: { id: report.id },
          data: {
            status: 'FAILED',
            errorCode: ErrorCode.INTERNAL_ERROR.toString(),
            errorMessage: message.slice(0, 1024),
          },
        })
        .catch((updateError: Error) => {
          this.logger.error(`匹配报告失败状态写入失败 reportId=${report.id}: ${updateError.message}`);
        });

      throw error;
    }
  }

  /**
   * 查询匹配报告（契约 §3.6.9）
   *
   * 没有报告时返回 `null` 而不是抛错：列表与详情页都要展示"尚未生成"这个正常状态，
   * 用异常表达正常状态会让调用方不得不用 `try/catch` 当控制流。
   */
  async getCompatibility(userId: string, relationshipId: string): Promise<CompatibilityReportView | null> {
    const relationship = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, deletedAt: null, OR: [{ userAId: userId }, { userBId: userId }] },
      select: { id: true },
    });

    if (relationship === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    const report = await this.prisma.compatibilityReport.findFirst({
      where: { relationshipId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        totalScore: true,
        mbtiScore: true,
        bigFiveScore: true,
        attachmentScore: true,
        communicationScore: true,
        scoreBreakdown: true,
        engineVersion: true,
        weightsVersion: true,
        computedAt: true,
        createdAt: true,
        aiReportId: true,
      },
    });

    if (report === null) return null;

    const level = report.totalScore === null ? null : compatibilityScoreLevel(report.totalScore);

    return {
      reportId: report.id,
      relationshipId,
      status: report.status,
      totalScore: report.totalScore,
      mbtiScore: report.mbtiScore,
      bigFiveScore: report.bigFiveScore,
      attachmentScore: report.attachmentScore,
      communicationScore: report.communicationScore,
      scoreLevel: level,
      scoreLabel: level === null ? null : compatibilityScoreLabel(level),
      scoreBreakdown: (report.scoreBreakdown as Record<string, unknown> | null) ?? null,
      engineVersion: report.engineVersion,
      weightsVersion: report.weightsVersion,
      computedAt: report.computedAt?.toISOString() ?? null,
      createdAt: report.createdAt.toISOString(),
      // 友好文案：`errorMessage` 是内部原文（可能含 Prisma/引擎细节），不透出
      ...(report.status === 'FAILED' ? { failureReason: '匹配分析暂时不可用，请稍后重试' } : {}),
      aiInterpretation: {
        // 本期只落确定性算分，AI 解读未接入
        available: false,
        aiReportId: report.aiReportId,
      },
    };
  }

  /**
   * 触发 AI 解读（第二阶段）
   *
   * 用关系双方中的**任一方**作为 `userId` 创建报告：报告内容对双方相同
   * （上下文按阅读者视角分别渲染，但都由同一份算分结果决定），
   * 而 `ai_reports.userId` 只是归属与用量归集字段。
   *
   * 失败只记日志：算分已经成功落库，解读没排上不该把整份报告标记为失败 ——
   * 否则用户会看到"匹配失败"，而分数其实已经算好了。
   */
  private async triggerInterpretation(compatibilityReportId: string): Promise<void> {
    try {
      const report = await this.prisma.compatibilityReport.findUnique({
        where: { id: compatibilityReportId },
        select: { relationshipId: true, relationship: { select: { userAId: true } } },
      });

      if (report === null) return;

      await this.reports.createReport({
        userId: report.relationship.userAId,
        type: 'RELATIONSHIP_REPORT',
        relationshipId: report.relationshipId,
      });

      this.logger.log(`匹配解读已入队 compatibilityReportId=${compatibilityReportId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`匹配解读入队失败（算分结果已保留，可稍后重试）id=${compatibilityReportId}: ${message}`);
    }
  }

  /**
   * 把 blocker 翻译成对应的 HTTP 语义
   */
  private throwForBlocker(blocker: CompatibilityBlockedReason, relationshipId: string, reportId: string | null): never {
    switch (blocker) {
      case 'RELATIONSHIP_NOT_ACTIVE':
        throw new BusinessException(ErrorCode.RELATIONSHIP_STATUS_INVALID, '关系尚未生效，无法生成匹配报告');
      case 'MY_NO_PROFILE':
        throw new BusinessException(ErrorCode.PERSONALITY_PROFILE_NOT_FOUND, '请先完成人格测评');
      case 'PARTNER_NO_PROFILE':
        throw new BusinessException(ErrorCode.COMPATIBILITY_PEER_NOT_READY, '对方尚未完成人格测评');
      case 'ALREADY_GENERATING':
        throw new BusinessException(ErrorCode.COMPATIBILITY_GENERATING, '匹配报告正在生成中，请稍候', {
          logContext: { relationshipId, reportId },
        });
      case 'RELATIONSHIP_NOT_FOUND':
      default:
        throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }
  }

  /** 读取当前生效的权重矩阵（取最新的 `ACTIVE` 版本） */
  private async loadActiveWeights(): Promise<{
    id: string;
    version: string;
    mbtiMatrix: unknown;
    bigFiveConfig: unknown;
    attachmentMatrix: unknown;
    communicationConfig: unknown;
    dimensionWeights: unknown;
  }> {
    const weights = await this.prisma.compatibilityWeight.findFirst({
      where: { isActive: true, deletedAt: null },
      orderBy: { effectiveFrom: 'desc' },
      select: {
        id: true,
        version: true,
        mbtiMatrix: true,
        bigFiveConfig: true,
        attachmentMatrix: true,
        communicationConfig: true,
        dimensionWeights: true,
      },
    });

    if (weights === null) {
      // 配置事故：数据库里没有可用的权重矩阵（种子未跑）。
      // 这属于服务端问题，不能伪装成用户错误
      this.logger.error(MISSING_WEIGHTS_MESSAGE);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, MISSING_WEIGHTS_MESSAGE);
    }

    return weights;
  }

  private async loadWeightsById(weightsId: string): Promise<CompatibilityWeights> {
    const weights = await this.prisma.compatibilityWeight.findUnique({
      where: { id: weightsId },
      select: {
        version: true,
        mbtiMatrix: true,
        bigFiveConfig: true,
        attachmentMatrix: true,
        communicationConfig: true,
        dimensionWeights: true,
      },
    });

    if (weights === null) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, MISSING_WEIGHTS_MESSAGE);
    }

    return weights as unknown as CompatibilityWeights;
  }

  /** 读取画像（`Json` 字段需要断言成引擎的类型） */
  private async loadProfile(profileId: string): Promise<CompatibilityProfile> {
    const profile = await this.prisma.personalityProfile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        version: true,
        eiPercent: true,
        snPercent: true,
        tfPercent: true,
        jpPercent: true,
        openness: true,
        conscientiousness: true,
        extraversion: true,
        agreeableness: true,
        neuroticism: true,
        attachmentStyle: true,
        loveLanguages: true,
        conflictStyle: true,
      },
    });

    if (profile === null) {
      throw new BusinessException(ErrorCode.PERSONALITY_PROFILE_NOT_FOUND, '人格画像不存在');
    }

    return {
      ...profile,
      // `Json?` 列进来的类型已是 `JsonValue | null`，直接兜空数组即可 ——
      // 引擎要的是 `readonly string[]`，而空数组表示"未采集"，与 `null` 等价
      loveLanguages: profile.loveLanguages ?? [],
    };
  }
}
