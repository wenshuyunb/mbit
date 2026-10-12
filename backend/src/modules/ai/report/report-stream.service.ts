/**
 * 报告进度 SSE 流服务（契约 §3.5.6）
 *
 * 本服务负责**内容侧**：鉴权/归属、状态快照组装、分段事件素材、并发连接计数。
 * 传输侧（写头、写帧、心跳、断连与超时）在 `report-engagement.controller.ts`，
 * 因为那里才拿得到 `res` 与 `req`。
 *
 * ## 断连为什么**不能**取消生成任务（契约规则 2）
 *
 * 用户切后台、网络抖动都会断开 SSE，而报告生成要花 10–60s、已经消耗了真实 token。
 * 断连就取消会让"看一眼进度就把报告弄丢"变成常见事故；任务照常跑完并落库，
 * 重连时重新读到最新进度即可 —— 这也是把任务状态放在数据库/Redis 而不是
 * 放在连接里的原因。
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { EntitlementService } from '../../membership/entitlement.service';
import { ReportLiveProgressService } from './report-live-progress.service';
import { computeFreePreviewRatio } from './report-list.util';
import {
  REPORT_JOB_MAX_ATTEMPTS,
  STREAM_MAX_CONNECTIONS_PER_USER,
  deriveStageFromStatus,
  estimateRemainingSeconds,
  estimateSecondsFromHistory,
  isTerminalStatus,
  previewTextOf,
  type ReportGenerationSnapshot,
  type StreamSectionInput,
} from './report-stream.util';
import { buildSectionViews } from './report-visibility';

/** 并发连接计数键前缀 */
const STREAM_CONNECTION_PREFIX = 'report:stream:conn';

/**
 * 连接计数成员的有效期（秒）
 *
 * 单连接上限 10 分钟，这里给 11 分钟：进程被强杀时来不及 `sRem`，
 * 成员只能靠 TTL 自然消失；TTL 必须**大于**最大连接时长，否则正常的长连接
 * 会在中途失效，导致第 4 个连接被判为"未超限"而放进来。
 */
const STREAM_CONNECTION_TTL_SECONDS = 11 * 60;

/**
 * 实时进度的陈旧阈值（毫秒）
 *
 * Worker 在真实代码位置上发布阶段，两次发布之间的最长间隔是"一次模型调用"（最长约 60s）。
 * 超过 5 分钟没更新说明这个键是**上一轮生成的残留**（例如任务被强杀、Redis 未清理），
 * 此时必须忽略它，否则用户会看到一份已经结束的报告仍在"调用模型"。
 */
const LIVE_PROGRESS_STALE_MS = 5 * 60 * 1000;

/** 历史耗时取样条数 */
const HISTORY_SAMPLE_SIZE = 20;

/** 流打开时的报告种子（控制器据此决定是否需要订阅） */
export interface ReportStreamSeed {
  readonly reportId: string;
  readonly userId: string;
  readonly type: string;
  readonly status: string;
  /** 是否已处于终态（终态下立即发 start + usage + done 并关闭，契约规则 1） */
  readonly isTerminal: boolean;
}

/** 流快照（生成状态 + 报告规模 + 解锁状态，一次读齐） */
export interface ReportStreamSnapshot {
  readonly generation: ReportGenerationSnapshot;
  readonly reportType: string;
  readonly wordCount: number;
  readonly sectionCount: number;
  readonly isUnlocked: boolean;
  readonly freePreviewRatio: number;
  /** 预计总耗时（秒），仅用于 `start` 事件 */
  readonly estimatedSeconds: number;
  readonly unlock: { allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> };
}

@Injectable()
export class ReportStreamService {
  private readonly logger = new Logger(ReportStreamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly liveProgress: ReportLiveProgressService,
    private readonly entitlements: EntitlementService,
  ) {}

  /**
   * 校验归属并返回流种子
   *
   * 「不存在」与「不属于当前用户」同码（404 `50016`）：区分二者等于确认该 reportId 存在。
   *
   * ⚠ 契约 §3.5.6 的错误表把"报告已完成（SUCCEEDED）"列为 `50013`/409，而同一节的
   * 业务规则 1 又要求"已完成的报告连接后立即发 `start` + `usage` + `done` 三条事件并关闭
   * （**不报错**）"。两者直接冲突，这里按**业务规则 1** 实现（理由：前端在报告刚好生成完
   * 的瞬间打开流，返回 409 会把正常时序变成错误弹窗），并已在交付报告中标注该矛盾。
   */
  async openStream(userId: string, reportId: string): Promise<ReportStreamSeed> {
    const report = await this.prisma.aiReport.findFirst({
      where: { id: reportId, userId, deletedAt: null },
      select: { id: true, userId: true, type: true, status: true },
    });

    if (report === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    return {
      reportId: report.id,
      userId: report.userId,
      type: report.type,
      status: report.status,
      isTerminal: isTerminalStatus(report.status),
    };
  }

  /**
   * 读一次快照
   *
   * 数据来源的优先级：
   *   ① 报告已是终态 → **完全以数据库为准**（实时通道可能残留上一轮阶段）
   *   ② 实时进度新鲜（5 分钟内更新）→ 用它的 stage/progress/段落计数
   *   ③ 否则 → 由 `status + progress` 兜底推导阶段
   *
   * 解锁状态每次都重新读权益（而不是在连接建立时读一次）：用户在浏览报告页时
   * 完成支付是常见路径，流里若不重读，解锁后要等 10 分钟连接超时才会看到"已解锁"。
   */
  async readSnapshot(userId: string, reportId: string, estimatedSeconds?: number): Promise<ReportStreamSnapshot> {
    const report = await this.prisma.aiReport.findFirst({
      where: { id: reportId, userId, deletedAt: null },
      select: {
        id: true,
        type: true,
        status: true,
        progress: true,
        sectionCount: true,
        contentLength: true,
        freePreviewLength: true,
        provider: true,
        model: true,
        retryCount: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        costAmount: true,
        generationStartedAt: true,
        generationFinishedAt: true,
        errorCode: true,
      },
    });

    if (report === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    const live = isTerminalStatus(report.status) ? null : await this.readFreshLiveProgress(reportId);

    const stage = live?.stage ?? deriveStageFromStatus(report.status, report.progress);
    // 终态的 progress 由生成侧写为 100（成功与失败都是），因此这里直接用列值即可，
    // 不需要为终态做特殊赋值 —— 少一处"状态与进度各自推导"就少一处不一致
    const progress = live?.progress ?? report.progress;

    const startedAt = report.generationStartedAt?.toISOString() ?? null;
    const finishedAt = report.generationFinishedAt?.toISOString() ?? null;

    const elapsedSeconds = computeElapsedSeconds(startedAt, finishedAt);
    const isSucceeded = report.status === 'SUCCEEDED';

    const generation: ReportGenerationSnapshot = {
      reportId: report.id,
      status: report.status,
      stage,
      progress: Math.max(0, Math.min(100, progress)),
      // 生成期间**没有**字数级数据：现有流水线是"一次完整调用"而非流式补全，
      // Worker 落库前拿不到增量字数。因此生成期间为 0（如实表达），完成时等于最终字数。
      generatedWordCount: live?.generatedWordCount ?? (isSucceeded ? report.contentLength : 0),
      targetWordCount: live?.targetWordCount ?? (isSucceeded ? report.contentLength : 0),
      generatedSectionCount: live?.generatedSectionCount ?? (isSucceeded ? report.sectionCount : 0),
      targetSectionCount: live?.targetSectionCount ?? report.sectionCount,
      currentSectionKey: live?.currentSectionKey ?? null,
      provider: report.provider,
      model: report.model,
      attempt: Math.min(report.retryCount + 1, REPORT_JOB_MAX_ATTEMPTS),
      elapsedSeconds,
      estimatedRemainingSeconds: estimateRemainingSeconds(elapsedSeconds, progress),
      startedAt,
      finishedAt,
      usage: isSucceeded
        ? {
            promptTokens: report.promptTokens,
            completionTokens: report.completionTokens,
            totalTokens: report.totalTokens,
            estimatedCostCents: report.costAmount,
          }
        : null,
      failureCode: report.status === 'FAILED' && report.errorCode !== null ? Number(report.errorCode) : null,
    };

    const unlock = await this.resolveUnlock(userId, reportId);

    return {
      generation,
      reportType: report.type,
      wordCount: report.contentLength,
      sectionCount: report.sectionCount,
      isUnlocked: unlock.allUnlocked,
      freePreviewRatio: computeFreePreviewRatio(report.freePreviewLength, report.contentLength),
      estimatedSeconds: estimatedSeconds ?? (await this.estimateSeconds(userId, report.type)),
      unlock,
    };
  }

  /**
   * 取该报告的分段事件素材
   *
   * 正文只经过 `buildSectionViews` 产出：未解锁段落的 `content` 恒为 `null`（类型层面保证），
   * 所以这里**不可能**把付费正文放进 `previewText` —— 这正是契约规则 3 的落点。
   */
  async loadSectionInputs(
    reportId: string,
    unlock: { allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> },
  ): Promise<readonly StreamSectionInput[]> {
    const rows = await this.prisma.reportSection.findMany({
      where: { reportId },
      orderBy: { order: 'asc' },
      select: { sectionKey: true, title: true, content: true, order: true, isFreePreview: true },
    });

    return buildSectionViews(rows, {
      allUnlocked: unlock.allUnlocked,
      unlockedSectionKeys: unlock.unlockedSectionKeys,
    }).map((visibility) => ({
      sectionKey: visibility.sectionKey,
      order: visibility.order,
      title: visibility.title,
      isFreePreview: visibility.isFreePreview,
      wordCount: visibility.contentLength,
      previewText: previewTextOf(visibility),
    }));
  }

  /**
   * 占用一个并发连接名额（契约 §3.5.6：每用户 3 条）
   *
   * 用 Redis 集合而不是计数器：集合能记住"是谁占着"，连接异常结束时可精确移除自己那一个，
   * 不会出现"计数只增不减"。返回的 token 必须在释放时回传，避免误删他人的名额。
   */
  async acquireConnectionSlot(userId: string): Promise<string> {
    const key = this.redis.key(STREAM_CONNECTION_PREFIX, userId);
    const token = randomUUID();

    await this.redis.sAdd(key, token, STREAM_CONNECTION_TTL_SECONDS);

    const active = await this.redis.sCard(key);
    if (active > STREAM_MAX_CONNECTIONS_PER_USER) {
      await this.redis.sRem(key, token);
      // 契约 §3.5.6 的 50017 语义为"并发 SSE 连接超限"，HTTP 429；
      // 本项目 50017 是「报告正在生成中」，语义不符，故用 10007 RATE_LIMITED（同为 429）
      throw BusinessException.tooManyRequests(
        ErrorCode.RATE_LIMITED,
        `同时订阅的报告进度流已达上限（${STREAM_MAX_CONNECTIONS_PER_USER} 条），请关闭其他页面后重试`,
      );
    }

    return token;
  }

  /** 释放并发名额（连接关闭/超时/异常都必须在 finally 中调用） */
  async releaseConnectionSlot(userId: string, token: string): Promise<void> {
    try {
      await this.redis.sRem(this.redis.key(STREAM_CONNECTION_PREFIX, userId), token);
    } catch (error) {
      // 释放失败最多让该用户 11 分钟内少一个名额（TTL 兜底），不值得让请求失败
      this.logger.warn(`释放 SSE 连接名额失败 userId=${userId}: ${(error as Error).message}`);
    }
  }

  /**
   * 预计总耗时（秒）
   *
   * 取该用户同类型**已成功**报告的历史耗时中位数近似值（见 `estimateSecondsFromHistory`）。
   * 完全没有历史时用兜底值 —— 这只是一个展示用估计，不影响任何业务判断。
   */
  async estimateSeconds(userId: string, reportType: string): Promise<number> {
    const history = await this.prisma.aiReport.findMany({
      where: { userId, type: reportType as never, status: 'SUCCEEDED', deletedAt: null, latencyMs: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_SAMPLE_SIZE,
      select: { latencyMs: true },
    });

    return estimateSecondsFromHistory(history.map((row) => row.latencyMs ?? 0));
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 读实时进度；过旧（疑似上一轮残留）或读取失败时返回 null，调用方回落读库推导 */
  private async readFreshLiveProgress(
    reportId: string,
  ): Promise<Awaited<ReturnType<ReportLiveProgressService['read']>>> {
    const live = await this.liveProgress.read(reportId);
    if (live === null) return null;

    const age = Date.now() - Date.parse(live.updatedAt);
    if (!Number.isFinite(age) || age > LIVE_PROGRESS_STALE_MS) return null;

    return live;
  }

  /**
   * 解锁状态（每次快照都重读，见 `readSnapshot` 说明）
   *
   * 直接复用 `EntitlementService.resolveReportUnlock`：与详情/分段接口是**同一个**判定入口。
   * 任何"为了 SSE 单独写一套解锁判断"的做法都会引入第二个事实来源。
   */
  private async resolveUnlock(
    userId: string,
    reportId: string,
  ): Promise<{ allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> }> {
    const state = await this.entitlements.resolveReportUnlock(userId, reportId);

    return { allUnlocked: state.allUnlocked, unlockedSectionKeys: state.unlockedSectionKeys };
  }
}

/** 已经过的秒数（未开始为 0） */
const computeElapsedSeconds = (startedAt: string | null, finishedAt: string | null): number => {
  if (startedAt === null) return 0;

  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 0;

  const end = finishedAt === null ? Date.now() : Date.parse(finishedAt);
  if (!Number.isFinite(end)) return 0;

  return Math.max(0, Math.round((end - start) / 1000));
};
