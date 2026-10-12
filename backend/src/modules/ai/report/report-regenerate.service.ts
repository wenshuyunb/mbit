/**
 * 报告重新生成服务（契约 §3.5.7）
 *
 * ## 复用而不是另写一套生成
 *
 * 本服务**只负责"决定生成什么"**，真正的生成仍然走
 * `ReportGenerationService.runGeneration`（同一个队列、同一段 Prompt、同一段落库逻辑）。
 * 理由：重新生成与原生成只差"是否忽略缓存"与"语气/侧重"两个变量，
 * 复制一份生成流水线必然会分叉出两套段落解析与落库行为 —— 那类分叉最后都表现为
 * "重生成的报告缺一段/多一段"。
 *
 * ## 幂等
 *
 * 契约标 ♻️ 且**必须**携带 `X-Idempotency-Key`（缺失由 `@IdempotencyKey()` 装饰器抛 `10009`）。
 * 重复提交同一次请求会命中 Redis 里的首次响应（同一个 `reportId`），
 * 因此**不会重复扣配额、也不会重复生成**。
 *
 * ## 数据模型缺口（必须在交付报告中如实转述）
 *
 * 契约规则 3 要求把原报告标记 `isSuperseded = true`、新报告带 `supersedesReportId`，
 * 但 `ai_reports` **没有这两列**（`schema.prisma` 本轮冻结）。当前实现：
 *   · `keepOriginal = true` → 原报告原样保留（不标记），新旧两条都在；
 *   · `keepOriginal = false` → 原报告 `deletedAt = now`（列表与详情不再返回它，记录仍在库中可审计）；
 *   · 响应里的 `supersedesReportId` 照契约返回（本次请求内已知）。
 * 其余行为（次数限制、反馈留存、强制绕过缓存）与契约一致。
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QUEUE_AI_REPORT } from '../../../infra/queue/queue.module';
import { RedisService } from '../../../infra/redis/redis.service';
import { EntitlementService } from '../../membership/entitlement.service';
import { SystemConfigService } from '../../system/system-config.service';
import {
  MAX_REGENERATE_FEEDBACK_LENGTH,
  REGENERATE_IDEMPOTENCY_TTL_SECONDS,
  REGENERATE_QUOTA_WINDOW,
  DEFAULT_REGENERATE_DAILY_LIMIT,
  DEFAULT_REGENERATE_REASON,
  DEFAULT_REGENERATE_TONE,
  assertFocusWithinLimit,
  describeFocus,
  describeTone,
  regenerationCacheKeySource,
  type RegenerateFocus,
  type RegenerateReason,
  type RegenerateTone,
} from './report-regenerate.util';
import { ReportGenerationOptionsService } from './report-generation-options.service';
import { ReportQuotaService } from './report-quota.service';
import { ReportStreamService } from './report-stream.service';

/** Redis 键前缀（幂等记录） */
const REGENERATE_IDEMPOTENCY_PREFIX = 'report:regenerate:idem';

/** 反馈留存的 outbox 事件类型（供后台质量抽检消费，契约规则 5） */
const FEEDBACK_EVENT_TYPE = 'report.regenerate.feedback';

/** 重新生成请求入参（DTO 校验后的值） */
export interface RegenerateRequestInput {
  readonly userId: string;
  readonly reportId: string;
  readonly idempotencyKey: string;
  readonly tone?: RegenerateTone;
  readonly focus?: readonly RegenerateFocus[];
  readonly reason?: RegenerateReason;
  readonly feedback?: string;
  readonly keepOriginal?: boolean;
}

/** 会员权益摘要（契约 §3.5.7 响应体的 `entitlement`） */
export interface RegenerateEntitlementView {
  readonly type: 'MEMBERSHIP_ACTIVE';
  readonly planCode: string | null;
  readonly expiresAt: string | null;
}

/** 重新生成响应（契约 §3.5.7 成功响应 202） */
export interface RegenerateView {
  readonly reportId: string;
  readonly taskId: string;
  readonly supersedesReportId: string;
  readonly status: string;
  readonly regenerationCount: number;
  readonly remainingCount: number;
  readonly dailyLimit: number;
  readonly resetAt: string;
  readonly entitlement: RegenerateEntitlementView;
  readonly tone: RegenerateTone;
  readonly focus: readonly RegenerateFocus[];
  readonly cacheHit: boolean;
  readonly estimatedSeconds: number;
  readonly createdAt: string;
  readonly pollUrl: string;
  readonly streamUrl: string;
}

@Injectable()
export class ReportRegenerateService {
  private readonly logger = new Logger(ReportRegenerateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly entitlements: EntitlementService,
    private readonly quota: ReportQuotaService,
    private readonly generationOptions: ReportGenerationOptionsService,
    private readonly streams: ReportStreamService,
    private readonly systemConfigs: SystemConfigService,
    @InjectQueue(QUEUE_AI_REPORT) private readonly reportQueue: Queue,
  ) {}

  async regenerate(input: RegenerateRequestInput): Promise<RegenerateView> {
    const tone: RegenerateTone = input.tone ?? DEFAULT_REGENERATE_TONE;
    const focus = input.focus ?? [];
    const reason: RegenerateReason = input.reason ?? DEFAULT_REGENERATE_REASON;
    const feedback = (input.feedback ?? '').slice(0, MAX_REGENERATE_FEEDBACK_LENGTH);
    const keepOriginal = input.keepOriginal ?? true;

    assertFocusWithinLimit(focus);

    // ---- ① 幂等重放：返回首次的 202 响应体（同一 reportId），不重复扣配额 ----
    const idempotencyRedisKey = this.redis.key(
      REGENERATE_IDEMPOTENCY_PREFIX,
      input.userId,
      this.crypto.sha256(input.idempotencyKey),
    );
    const replayedReportId = await this.redis.get(idempotencyRedisKey);
    if (replayedReportId !== null && replayedReportId.length > 0) {
      const replayed = await this.loadReplayedView(input.userId, replayedReportId);
      if (replayed !== null) {
        this.logger.log(`重新生成幂等重放 reportId=${replayedReportId}`);
        return replayed;
      }
      // 新报告已被删除（用户主动删/合并不一致）：清掉陈旧键，走正常流程
      await this.redis.del(idempotencyRedisKey);
    }

    // ---- ② 归属与状态 ----
    const original = await this.prisma.aiReport.findFirst({
      where: { id: input.reportId, userId: input.userId, deletedAt: null },
      select: {
        id: true,
        type: true,
        status: true,
        profileId: true,
        sessionId: true,
        relationshipId: true,
        promptTemplateKey: true,
        promptVersionId: true,
        cacheKey: true,
        version: true,
      },
    });

    if (original === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    if (original.status === 'QUEUED' || original.status === 'GENERATING') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATING, '原报告仍在生成中，暂时无法重新生成');
    }

    // 生成失败的报告也允许重生成：这正是用户遇到失败后的首选动作
    // ---- ③ 会员专属（契约规则 1：非会员一律拉起付费墙） ----
    const membership = await this.entitlements.getMembership(input.userId);
    if (!membership.isMember) {
      throw new BusinessException(ErrorCode.ENTITLEMENT_REQUIRED, '重新生成为会员权益，开通会员后可无限次重新生成', {
        httpStatus: 402,
      });
    }

    // ---- ④ 每日次数配额（先扣后做；失败时由调用方归还） ----
    const dailyLimit = await this.readDailyLimit();
    const quotaState = await this.quota.consumeWindowQuota({
      scope: 'report-regenerate',
      userId: input.userId,
      subject: input.reportId,
      limit: dailyLimit,
      window: REGENERATE_QUOTA_WINDOW,
      message: `今日重新生成次数已达上限（${dailyLimit} 次），请明日再试`,
    });

    try {
      // ---- ⑤ 新报告落库（强制绕过缓存） ----
      const version = original.version + 1;
      const cacheKey = this.crypto.sha256(
        regenerationCacheKeySource({
          originalCacheKey: original.cacheKey,
          version,
          tone,
          focus,
          // 随机数保证"同参数连续重生成"不会撞 cacheKey 唯一约束
          nonce: uuidv7(),
        }),
      );

      const created = await this.prisma.aiReport.create({
        data: {
          userId: input.userId,
          // 与原报告同源：同类型、同画像/会话/关系、同 Prompt 版本
          type: original.type,
          status: 'QUEUED',
          profileId: original.profileId,
          sessionId: original.sessionId,
          relationshipId: original.relationshipId,
          promptTemplateKey: original.promptTemplateKey,
          promptVersionId: original.promptVersionId,
          cacheKey,
          version,
        },
        select: { id: true, createdAt: true, status: true },
      });

      // 语气/侧重随任务带到 Worker（`ai_reports` 没有对应列，见文件头说明）
      await this.generationOptions.save(created.id, {
        tone: describeTone(tone),
        focus: describeFocus(focus),
      });

      // 反馈闭环：写入事务性发件箱（`report_feedback` 表不存在，见交付报告）
      await this.recordFeedback({
        userId: input.userId,
        reportId: created.id,
        supersedesReportId: original.id,
        reason,
        feedback,
        tone,
        focus,
      });

      await this.applyKeepOriginal(original.id, keepOriginal, created.createdAt);

      await this.enqueueGeneration(created.id);

      await this.redis.set(idempotencyRedisKey, created.id, REGENERATE_IDEMPOTENCY_TTL_SECONDS);

      const planCode = await this.readPlanCode(input.userId);

      this.logger.log(
        `报告已重新生成 newReportId=${created.id} supersedes=${original.id} version=${version} tone=${tone} focus=${focus.join(',') || 'none'}`,
      );

      return {
        reportId: created.id,
        taskId: created.id,
        supersedesReportId: original.id,
        status: created.status,
        regenerationCount: version,
        remainingCount: quotaState.remaining,
        dailyLimit,
        resetAt: quotaState.resetAt,
        entitlement: {
          type: 'MEMBERSHIP_ACTIVE',
          planCode,
          expiresAt: membership.expireAt,
        },
        tone,
        focus,
        // 强制绕过缓存（契约规则 4）：本次必然没有命中服务端缓存
        cacheHit: false,
        estimatedSeconds: await this.streams.estimateSeconds(input.userId, original.type),
        createdAt: created.createdAt.toISOString(),
        pollUrl: `/api/v1/reports/${created.id}/progress`,
        streamUrl: `/api/v1/reports/${created.id}/stream`,
      };
    } catch (error) {
      // 落库/入队失败 → 归还刚扣的次数，否则用户"什么都没拿到却少了一次"
      await this.quota.refundWindowQuota({
        scope: 'report-regenerate',
        userId: input.userId,
        subject: input.reportId,
        window: REGENERATE_QUOTA_WINDOW,
      });
      throw error;
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 幂等重放：按已创建的报告重建响应（配额余量按当前值返回） */
  private async loadReplayedView(userId: string, reportId: string): Promise<RegenerateView | null> {
    const report = await this.prisma.aiReport.findFirst({
      where: { id: reportId, userId, deletedAt: null },
      select: { id: true, type: true, status: true, version: true, createdAt: true },
    });

    if (report === null) return null;

    const membership = await this.entitlements.getMembership(userId);
    const dailyLimit = await this.readDailyLimit();
    const quotaState = await this.quota.readWindowQuota({
      scope: 'report-regenerate',
      userId,
      subject: report.id,
      limit: dailyLimit,
      window: REGENERATE_QUOTA_WINDOW,
    });

    return {
      reportId: report.id,
      taskId: report.id,
      supersedesReportId: report.id,
      status: report.status,
      regenerationCount: report.version,
      remainingCount: quotaState.remaining,
      dailyLimit,
      resetAt: quotaState.resetAt,
      entitlement: {
        type: 'MEMBERSHIP_ACTIVE',
        planCode: await this.readPlanCode(userId),
        expiresAt: membership.expireAt,
      },
      tone: DEFAULT_REGENERATE_TONE,
      focus: [],
      cacheHit: false,
      estimatedSeconds: await this.streams.estimateSeconds(userId, report.type),
      createdAt: report.createdAt.toISOString(),
      pollUrl: `/api/v1/reports/${report.id}/progress`,
      streamUrl: `/api/v1/reports/${report.id}/stream`,
    };
  }

  /**
   * 保留策略
   *
   * `keepOriginal = false`（覆盖）时把原报告软删除：列表与详情不再返回它，
   * 但行仍在库中（含分段与用量），后台审计与成本统计不受影响。
   * 见文件头"数据模型缺口"一节 —— 契约本意是标 `isSuperseded`，本项目没有该列。
   */
  private async applyKeepOriginal(originalId: string, keepOriginal: boolean, now: Date): Promise<void> {
    if (keepOriginal) return;

    await this.prisma.aiReport.update({
      where: { id: originalId },
      data: { deletedAt: now },
    });
  }

  /** 反馈写入发件箱（唯一键保证同一次重生成只留一条，重复重试不会污染抽检库） */
  private async recordFeedback(input: {
    userId: string;
    reportId: string;
    supersedesReportId: string;
    reason: RegenerateReason;
    feedback: string;
    tone: RegenerateTone;
    focus: readonly RegenerateFocus[];
  }): Promise<void> {
    try {
      await this.prisma.outboxEvent.create({
        data: {
          eventType: FEEDBACK_EVENT_TYPE,
          aggregateType: 'AiReport',
          aggregateId: input.reportId,
          payload: {
            userId: input.userId,
            reportId: input.reportId,
            supersedesReportId: input.supersedesReportId,
            reason: input.reason,
            feedback: input.feedback,
            tone: input.tone,
            focus: [...input.focus],
          },
          idempotencyKey: `${FEEDBACK_EVENT_TYPE}:${input.reportId}`,
        },
      });
    } catch (error) {
      // 反馈留存失败不应让"重新生成"失败：用户要的是报告，不是后台抽检
      this.logger.warn(`写入重生成反馈失败 reportId=${input.reportId}: ${(error as Error).message}`);
    }
  }

  /** 入队（`jobId = reportId` 天然去重；失败时把报告标记为 FAILED 并抛 503 语义） */
  private async enqueueGeneration(reportId: string): Promise<void> {
    try {
      await this.reportQueue.add('generate', { reportId }, { jobId: reportId });
    } catch (error) {
      this.logger.error(`重新生成入队失败 reportId=${reportId}: ${(error as Error).message}`);
      await this.prisma.aiReport
        .update({
          where: { id: reportId },
          data: { status: 'FAILED', errorCode: String(ErrorCode.QUEUE_ERROR), errorMessage: '入队失败' },
        })
        .catch(() => undefined);
      throw new BusinessException(ErrorCode.QUEUE_ERROR, '报告服务暂时不可用，请稍后重试', { httpStatus: 503 });
    }
  }

  /** 每日上限（来自 `system_configs.reportRegenerateDailyLimit`，不是硬编码） */
  private async readDailyLimit(): Promise<number> {
    try {
      const entry = await this.systemConfigs.getEntry('reportRegenerateDailyLimit');
      const value = entry?.value;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
    } catch (error) {
      this.logger.warn(`读取重生成每日上限失败，使用默认值: ${(error as Error).message}`);
    }

    return DEFAULT_REGENERATE_DAILY_LIMIT;
  }

  /**
   * 会员套餐码（仅用于响应展示）
   *
   * 「是否是会员」以 `EntitlementService` 为唯一依据；这里额外查一次 `memberships`
   * 只是为了拿到 `planCode`，**不参与任何判定** —— 两处各判一次权限迟早会不一致。
   */
  private async readPlanCode(userId: string): Promise<string | null> {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, deletedAt: null, status: 'ACTIVE', expireAt: { gt: new Date() } },
      orderBy: { expireAt: 'desc' },
      select: { plan: { select: { code: true } } },
    });

    return membership?.plan.code ?? null;
  }
}
