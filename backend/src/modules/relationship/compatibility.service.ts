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
import { EntitlementService } from '../membership/entitlement.service';
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
  AI_MAX_ATTEMPTS,
  AI_TARGET_ITEM_COUNT,
  POLLING_ADVICE,
  buildAiInsights,
  buildFreePreview,
  buildProfileComparison,
  buildRelatedActions,
  buildScoreBreakdownDimensions,
  buildStageTimeline,
  countGeneratedItems,
  PROGRESS_STATUS_LABELS,
  resolveOverallStatus,
  resolveProgressPercent,
  resolveRetryAdvice,
  scoreRingColor,
  type CompatibilityAiInsightsView,
  type CompatibilityProgressStatus,
  type CompatibilityStageView,
  type ProfileComparisonView,
  type ScoreBreakdownDimensionView,
} from './compatibility-report.util';
import {
  compatibilityScoreLabel,
  compatibilityScoreLevel,
  relationTypeName,
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

/** 免责声明（合规要求由服务端下发，前端不得硬编码） */
const COMPATIBILITY_DISCLAIMER =
  '匹配结果基于人格测评框架与确定性算法计算，仅供关系自我探索参考，不构成情感诊断、心理咨询或医疗建议。';

/** AI 生成内容提示（合规） */
const AI_GENERATED_NOTICE = '本报告的解读部分由人工智能生成，算分部分由确定性算法计算，已通过内容安全检测。';

/** 解锁来源（契约 §3.6.10 的 `unlockType`） */
export type CompatibilityUnlockType = 'MEMBERSHIP_ACTIVE' | 'REPORT_UNLOCK';

/** 免费预览说明（未解锁时下发） */
export interface FreePreviewView {
  readonly ratio: number;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
}

/** 报告详情视图（契约 §3.6.10） */
export interface CompatibilityReportDetailView extends CompatibilityReportView {
  /** 契约 §3.6.10 的字段名（`CompatibilityReportView` 沿用 §3.6.9 的 `reportId`，两者同值） */
  readonly compatibilityReportId: string;
  readonly relationType: string;
  readonly relationTypeName: string;
  readonly isUnlocked: boolean;
  readonly unlockType: CompatibilityUnlockType | null;
  /**
   * 解锁时间
   *
   * `entitlements` 表没有「何时被判为解锁」的列（`startAt` 是权益生效时间，
   * 与"这份报告何时被解锁"不是一回事）。因此如实返回 `null`。
   */
  readonly unlockedAt: string | null;
  /** 契约 §3.6.10 的字段名（= `totalScore`） */
  readonly overallScore: number | null;
  /** 契约 §3.6.10 的字段名（= `engineVersion`） */
  readonly algorithmVersion: string;
  /** AI 报告摘要；未解锁或解读未生成时为 `null` */
  readonly summary: string | null;
  readonly scoreRingColor: string | null;
  /** 算分明细的**数组形态**（既有 `scoreBreakdown` 仍透传引擎 JSONB，见 util 注释） */
  readonly scoreBreakdownDimensions: readonly ScoreBreakdownDimensionView[];
  /** AI 解读全文；未解锁或未生成时为 `null`（契约规则 2：绝不下发 AI 全文） */
  readonly aiInsights: CompatibilityAiInsightsView | null;
  /** 双方画像对比；**未解锁时为 `null`**（大五明细属付费内容） */
  readonly profileComparison: ProfileComparisonView | null;
  readonly freePreview: FreePreviewView | null;
  readonly generatedAt: string | null;
  readonly aiGeneratedAt: string | null;
  readonly disclaimer: string;
  readonly aiGeneratedNotice: string;
  readonly relatedActions: {
    readonly canStartChat: boolean;
    readonly chatUrl: string | null;
    readonly canExportPdf: boolean;
    readonly canShare: boolean;
  };
}

/** 进度视图（契约 §3.6.11） */
export interface CompatibilityProgressView {
  readonly compatibilityReportId: string;
  readonly relationshipId: string;
  readonly status: CompatibilityProgressStatus;
  readonly statusLabel: string;
  readonly progress: number;
  readonly stage: CompatibilityProgressStatus;
  readonly stageLabel: string;
  readonly stages: readonly CompatibilityStageView[];
  readonly scoring: {
    readonly isDone: boolean;
    /**
     * 算分耗时
     *
     * **无列可查** → `null`。刻意不用 `computedAt - createdAt` 冒充：那个差值里
     * 还包含排队等待时间，会显示成"算分用了 3 秒"，而算分实际是毫秒级。
     */
    readonly durationMs: number | null;
    readonly overallScore: number | null;
    readonly scoreLevel: CompatibilityScoreLevel | null;
    readonly algorithmVersion: string;
    readonly weightsVersion: string;
    readonly computedAt: string | null;
    readonly partialAvailable: boolean;
  };
  readonly ai: {
    readonly isDone: boolean;
    readonly provider: string | null;
    readonly model: string | null;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly isRetrying: boolean;
    readonly generatedItemCount: number;
    readonly targetItemCount: number;
    readonly estimatedRemainingSeconds: number | null;
  };
  readonly elapsedSeconds: number;
  readonly estimatedRemainingSeconds: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly canRetry: boolean;
  readonly retryScope: 'AI_ONLY' | 'FULL' | null;
  /** 失败时的友好文案（**不透出上游错误原文**） */
  readonly failureReason?: string;
  readonly pollingAdvice: { readonly intervalMs: number; readonly maxPolls: number };
}

@Injectable()
export class CompatibilityService {
  private readonly logger = new Logger(CompatibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_COMPATIBILITY_CALC) private readonly calcQueue: Queue,
    // 用普通 import 而非 `import type`：Nest 的构造参数注入依赖
    // `design:paramtypes` 元数据里的运行时类引用，`import type` 会被编译期擦除
    private readonly reports: ReportService,
    // 报告详情的**付费裁剪**需要它（契约 §3.6.10 规则 2：未解锁时不下发 AI 全文）。
    // 复用 `EntitlementService` 而不是自己查 `entitlements` 表：解锁判定必须与
    // 个人报告、AI 报告用的是**同一套规则**，否则同一份权益在不同页面结论不同
    private readonly entitlements: EntitlementService,
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

  // ==========================================================================
  // 按报告 ID 查询（契约 §3.6.10 / §3.6.11）
  // ==========================================================================

  /**
   * 匹配报告详情（契约 §3.6.10）
   *
   * ## 归属校验链
   *
   * `compatibilityReport → relationship → (userAId === me || userBId === me)`
   *
   * 任一层不满足都返回 `60010`（404），**包括非双方本人的情况** ——
   * 契约规则 1 明确要求「不泄露报告是否存在」。返回 403 会让攻击者知道
   * 这个报告 ID 是真实的，可以据此枚举。
   *
   * ## 服务端裁剪（契约规则 2）
   *
   * `isUnlocked = false` 时只下发**确定性算分结果**（总分、等级、四维拆解），
   * `aiInsights` 与 `profileComparison` 置 `null`，并在 `freePreview.excludes`
   * 中列出被隐藏的板块。**绝不下发 AI 解读全文** —— 付费内容的裁剪必须在
   * 服务端完成，靠前端"不渲染"等于把内容白送。
   */
  async getReportById(
    userId: string,
    reportId: string,
    options: { readonly includeScoreBreakdown: boolean; readonly previewOnly: boolean },
  ): Promise<CompatibilityReportDetailView> {
    const report = await this.loadOwnedReport(userId, reportId);

    // 报告仍在生成中：契约 §3.6.10 要求 409 并引导前端改订阅进度接口。
    // 若这里返回 200 + 半成品，前端会渲染出一份"总分 null"的报告
    if ((ACTIVE_COMPATIBILITY_STATUSES as readonly string[]).includes(report.status)) {
      throw new BusinessException(ErrorCode.COMPATIBILITY_GENERATING, '匹配报告正在生成中，请稍候', {
        logContext: { reportId, relationshipId: report.relationshipId },
      });
    }

    const unlock = await this.resolveUnlock(userId, report.id, report.aiReportId);
    // `previewOnly` 强制裁剪：运营/客服预览、以及"看看买了能得到什么"的落地页
    const isUnlocked = unlock.isUnlocked && !options.previewOnly;

    const level = report.totalScore === null ? null : compatibilityScoreLevel(report.totalScore);
    const aiInsights = isUnlocked
      ? buildAiInsights({
          advantages: report.advantages,
          conflicts: report.conflicts,
          suggestions: report.suggestions,
          communicationScripts: null,
          provider: report.provider,
          model: report.model,
          generatedAt: report.aiGeneratedAt,
        })
      : null;

    return {
      reportId: report.id,
      compatibilityReportId: report.id,
      relationshipId: report.relationshipId,
      relationType: report.relationshipType,
      relationTypeName: relationTypeName(report.relationshipType),
      status: report.status,
      isUnlocked,
      unlockType: isUnlocked ? unlock.unlockType : null,
      unlockedAt: null,
      totalScore: report.totalScore,
      overallScore: report.totalScore,
      mbtiScore: report.mbtiScore,
      bigFiveScore: report.bigFiveScore,
      attachmentScore: report.attachmentScore,
      communicationScore: report.communicationScore,
      scoreLevel: level,
      scoreLabel: level === null ? null : compatibilityScoreLabel(level),
      scoreRingColor: scoreRingColor(level),
      scoreBreakdown: options.includeScoreBreakdown
        ? ((report.scoreBreakdown as Record<string, unknown> | null) ?? null)
        : null,
      scoreBreakdownDimensions: options.includeScoreBreakdown
        ? buildScoreBreakdownDimensions({
            scoreBreakdown: report.scoreBreakdown,
            scores: {
              mbti: report.mbtiScore,
              bigFive: report.bigFiveScore,
              attachment: report.attachmentScore,
              communication: report.communicationScore,
            },
          })
        : [],
      summary: isUnlocked ? report.aiSummary : null,
      aiInsights,
      profileComparison: isUnlocked ? report.profileComparison : null,
      freePreview: isUnlocked ? null : buildFreePreview(),
      engineVersion: report.engineVersion,
      algorithmVersion: report.engineVersion,
      weightsVersion: report.weightsVersion,
      computedAt: report.computedAt?.toISOString() ?? null,
      generatedAt: report.generatedAt?.toISOString() ?? null,
      aiGeneratedAt: report.aiGeneratedAt?.toISOString() ?? null,
      createdAt: report.createdAt.toISOString(),
      ...(report.status === 'FAILED' ? { failureReason: '匹配分析暂时不可用，请稍后重试' } : {}),
      aiInterpretation: { available: aiInsights !== null, aiReportId: report.aiReportId },
      disclaimer: COMPATIBILITY_DISCLAIMER,
      aiGeneratedNotice: AI_GENERATED_NOTICE,
      relatedActions: buildRelatedActions(report.relationshipId, {
        isUnlocked,
        isActiveRelationship: report.relationshipStatus === 'ACTIVE',
      }),
    };
  }

  /**
   * 匹配报告生成进度（契约 §3.6.11）
   *
   * `status = ERROR / PARTIAL` 同样以 **200** 返回（契约规则 4：失败不返回 5xx），
   * 并附 `canRetry` 与 `retryScope`。用 5xx 表达"这份报告生成失败了"会让前端
   * 把它当成网络故障去重试请求，而真正该重试的是**生成任务**。
   *
   * 归属校验与 §3.6.10 完全一致（契约规则 5）。
   */
  async getReportProgress(userId: string, reportId: string): Promise<CompatibilityProgressView> {
    const report = await this.loadOwnedReport(userId, reportId);

    const now = new Date();
    const status = resolveOverallStatus({ reportStatus: report.status, aiStatus: report.aiStatus });
    const progress = resolveProgressPercent({ status, aiProgress: report.aiProgress });
    const retry = resolveRetryAdvice(status);

    const scoringDone = report.computedAt !== null || report.status === 'SUCCEEDED';
    const level = report.totalScore === null ? null : compatibilityScoreLevel(report.totalScore);
    const isDone = status === 'DONE' || status === 'PARTIAL';
    const canReportPartial = scoringDone && report.totalScore !== null;

    // 收尾时间里 `generatedAt` 是报告生成完成、`computedAt` 是算分完成；
    // 失败时没有这两个时间，用 `updatedAt` 表示"最后一次状态变更"
    const finishedAt =
      status === 'DONE'
        ? (report.generatedAt ?? report.computedAt)
        : status === 'PARTIAL' || status === 'ERROR'
          ? report.updatedAt
          : null;

    return {
      compatibilityReportId: report.id,
      relationshipId: report.relationshipId,
      status,
      statusLabel: PROGRESS_STATUS_LABELS[status],
      progress,
      stage: status,
      stageLabel: PROGRESS_STATUS_LABELS[status],
      stages: buildStageTimeline({
        status,
        hasScoring: report.computedAt !== null,
        aiStatus: report.aiStatus,
        createdAt: report.createdAt,
        computedAt: report.computedAt,
        aiStartedAt: report.aiStartedAt,
        aiFinishedAt: report.aiFinishedAt,
      }),
      scoring: {
        isDone: scoringDone,
        durationMs: null,
        overallScore: report.totalScore,
        scoreLevel: level,
        algorithmVersion: report.engineVersion,
        weightsVersion: report.weightsVersion,
        computedAt: report.computedAt?.toISOString() ?? null,
        // 算分已完成即可先展示总分与拆解（契约规则 1 的 PARTIAL 语义）
        partialAvailable: canReportPartial,
      },
      ai: {
        isDone: report.aiStatus === 'SUCCEEDED',
        provider: report.provider,
        model: report.model,
        // 契约的 `attempt` 从 1 开始计数，库里存的是**已重试次数**
        attempt: report.aiRetryCount + 1,
        maxAttempts: AI_MAX_ATTEMPTS,
        isRetrying: report.aiRetryCount > 0,
        generatedItemCount: report.generatedItemCount,
        targetItemCount: AI_TARGET_ITEM_COUNT,
        estimatedRemainingSeconds: estimateAiRemainingSeconds(report.generatedItemCount, isDone),
      },
      elapsedSeconds: Math.max(0, Math.floor((now.getTime() - report.createdAt.getTime()) / 1000)),
      estimatedRemainingSeconds: estimateAiRemainingSeconds(report.generatedItemCount, isDone),
      startedAt: report.createdAt.toISOString(),
      finishedAt: finishedAt?.toISOString() ?? null,
      canRetry: retry.canRetry,
      retryScope: retry.retryScope,
      ...(status === 'ERROR' || status === 'PARTIAL'
        ? {
            // 友好文案：`errorMessage` 是内部原文（可能含 Prisma/引擎细节），不透出
            failureReason: status === 'PARTIAL' ? '关系解读生成失败，可单独重试解读' : '匹配分析暂时不可用，请稍后重试',
          }
        : {}),
      pollingAdvice: POLLING_ADVICE,
    };
  }

  /**
   * 读取报告并校验归属
   *
   * 把三段校验（报告存在 → 关系存在 → 我是双方之一）压在一个查询里：
   * `compatibilityReport.findFirst` 带 `relationship: { OR: [userAId, userBId] }`
   * 条件。分三次查会多两次往返，且中间的失败分支容易漏掉一个（漏掉就是越权）。
   */
  private async loadOwnedReport(userId: string, reportId: string): Promise<OwnedReportRow> {
    const report = await this.prisma.compatibilityReport.findFirst({
      where: {
        id: reportId,
        deletedAt: null,
        relationship: { deletedAt: null, OR: [{ userAId: userId }, { userBId: userId }] },
      },
      select: {
        id: true,
        relationshipId: true,
        status: true,
        totalScore: true,
        mbtiScore: true,
        bigFiveScore: true,
        attachmentScore: true,
        communicationScore: true,
        scoreBreakdown: true,
        advantages: true,
        conflicts: true,
        suggestions: true,
        engineVersion: true,
        weightsVersion: true,
        aiReportId: true,
        provider: true,
        model: true,
        totalTokens: true,
        retryCount: true,
        computedAt: true,
        generatedAt: true,
        createdAt: true,
        updatedAt: true,
        // ⚠ `profileAId` / `profileBId` / `weights` 属于 **CompatibilityReport**，
        // 不属于 `Relationship` —— 放到 relationship.select 里会让 Prisma 直接编译报错
        // （Relationship 只有 userAId/userBId，没有画像外键）
        profileAId: true,
        profileBId: true,
        weights: { select: { attachmentMatrix: true } },
        relationship: {
          select: {
            type: true,
            status: true,
            userAId: true,
            userBId: true,
          },
        },
        aiReport: {
          select: {
            status: true,
            summary: true,
            provider: true,
            model: true,
            progress: true,
            retryCount: true,
            generationStartedAt: true,
            generationFinishedAt: true,
          },
        },
      },
    });

    if (report === null) {
      // 不存在与无权访问返回**同一个码**：不泄露报告是否存在（契约规则 1）
      throw BusinessException.notFound(ErrorCode.COMPATIBILITY_REPORT_NOT_FOUND);
    }

    const { relationship, aiReport, profileAId, profileBId, weights, ...rest } = report;

    const profileComparison =
      // 画像对比需要双方画像；关系已解除时画像仍可读（历史报告要能看），
      // 因此这里不额外限制关系状态 —— 限制在调用方（未解锁不下发）
      await this.loadProfileComparison(profileAId, profileBId, weights?.attachmentMatrix);

    return {
      ...rest,
      relationshipType: relationship.type,
      relationshipStatus: relationship.status,
      // 优先用匹配报告自己的 `provider` / `model`（AI 解读阶段写入）；
      // 为空时回落到 `ai_reports` 的同名字段
      provider: rest.provider ?? aiReport?.provider ?? null,
      model: rest.model ?? aiReport?.model ?? null,
      aiStatus: aiReport?.status ?? null,
      aiSummary: aiReport?.summary ?? null,
      aiProgress: aiReport?.progress ?? null,
      aiRetryCount: aiReport?.retryCount ?? 0,
      aiStartedAt: aiReport?.generationStartedAt ?? null,
      aiFinishedAt: aiReport?.generationFinishedAt ?? null,
      // 契约的 `aiGeneratedAt` = AI 解读完成时间；匹配报告用 `generatedAt` 表达
      aiGeneratedAt: rest.generatedAt,
      generatedItemCount: countGeneratedItems(rest),
      profileComparison,
    };
  }

  /** 读取双方画像并组装对比（任一画像缺失则返回 `null`，不抛错） */
  private async loadProfileComparison(
    profileAId: string,
    profileBId: string,
    attachmentMatrix: unknown,
  ): Promise<ProfileComparisonView | null> {
    const profiles = await this.prisma.personalityProfile.findMany({
      where: { id: { in: [profileAId, profileBId] }, deletedAt: null },
      select: {
        id: true,
        mbtiType: true,
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
      },
    });

    const profileA = profiles.find((profile) => profile.id === profileAId);
    const profileB = profiles.find((profile) => profile.id === profileBId);

    // 画像被硬删/清理后报告仍要能打开：对比块缺失而不是整页 500
    if (profileA === undefined || profileB === undefined) return null;

    return buildProfileComparison({
      profileA: { ...profileA, loveLanguages: profileA.loveLanguages ?? [] },
      profileB: { ...profileB, loveLanguages: profileB.loveLanguages ?? [] },
      attachmentMatrix,
    });
  }

  /**
   * 报告是否已解锁（契约 §3.6.10 的 💎）
   *
   * 两个 ID 都要认：`REPORT_UNLOCK` 权益既可能指向**匹配报告**（契约 §3.6.9 的
   * `entitlementRequired.resourceId` 就是 `latestReportId`），也可能指向 AI 解读
   * 生成的那份 `ai_reports`（`entitlements.report_id` 是它的外键）。
   * 只认其中一个会让另一条购买路径的用户被付费墙挡住 —— 付了钱却看不到。
   */
  private async resolveUnlock(
    userId: string,
    compatibilityReportId: string,
    aiReportId: string | null,
  ): Promise<{ isUnlocked: boolean; unlockType: CompatibilityUnlockType | null }> {
    const byCompatibility = await this.entitlements.resolveReportUnlock(userId, compatibilityReportId);

    if (byCompatibility.allUnlocked) {
      return { isUnlocked: true, unlockType: toUnlockType(byCompatibility.source) };
    }

    if (aiReportId !== null) {
      const byAiReport = await this.entitlements.resolveReportUnlock(userId, aiReportId);

      if (byAiReport.allUnlocked) {
        return { isUnlocked: true, unlockType: toUnlockType(byAiReport.source) };
      }
    }

    return { isUnlocked: false, unlockType: null };
  }

  /**
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

// ============================================================================
// 模块级工具
// ============================================================================

/**
 * `loadOwnedReport` 的返回行
 *
 * 单独命名而不是 `Awaited<ReturnType<...>>`：它同时被详情与进度两个接口消费，
 * 字段含义（尤其 `aiStatus` / `generatedItemCount` 这类派生字段）写成显式接口
 * 才能在改动时看出「谁依赖它」。
 */
interface OwnedReportRow {
  readonly id: string;
  readonly relationshipId: string;
  readonly relationshipType: string;
  readonly relationshipStatus: string;
  readonly status: string;
  readonly totalScore: number | null;
  readonly mbtiScore: number | null;
  readonly bigFiveScore: number | null;
  readonly attachmentScore: number | null;
  readonly communicationScore: number | null;
  readonly scoreBreakdown: unknown;
  readonly advantages: unknown;
  readonly conflicts: unknown;
  readonly suggestions: unknown;
  readonly engineVersion: string;
  readonly weightsVersion: string;
  readonly aiReportId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly computedAt: Date | null;
  readonly generatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** AI 解读报告的状态（无 AI 报告时为 `null`） */
  readonly aiStatus: string | null;
  /** AI 报告摘要（付费内容，未解锁不下发） */
  readonly aiSummary: string | null;
  /** AI 阶段自身进度（`ai_reports.progress`，0–100）；无 AI 报告时为 `null` */
  readonly aiProgress: number | null;
  readonly aiRetryCount: number;
  readonly aiStartedAt: Date | null;
  readonly aiFinishedAt: Date | null;
  readonly aiGeneratedAt: Date | null;
  /** 已完成条目数（优势 + 冲突 + 建议） */
  readonly generatedItemCount: number;
  readonly profileComparison: ProfileComparisonView | null;
}

/** 权益解锁来源 → 契约的 `unlockType` */
const toUnlockType = (source: string): CompatibilityUnlockType => {
  if (source === 'MEMBERSHIP') return 'MEMBERSHIP_ACTIVE';

  return 'REPORT_UNLOCK';
};

/**
 * AI 解读剩余耗时估算
 *
 * 按**未完成条目数**估算（契约 §3.6.11 规则 3 的 `targetItemCount = 13`）：
 * 契约示例里「2/13 完成、剩余 11 秒」正好是 `13 - 2 = 11`，即每个条目约 1 秒。
 *
 * 这是一个**粗略提示**而不是承诺，所以它只用于进度条文案；
 * 已完成（`isDone`）时返回 `null`，避免展示"还剩 0 秒"。
 */
const estimateAiRemainingSeconds = (generatedItemCount: number, isDone: boolean): number | null => {
  if (isDone) return null;

  return Math.max(0, AI_TARGET_ITEM_COUNT - generatedItemCount);
};
