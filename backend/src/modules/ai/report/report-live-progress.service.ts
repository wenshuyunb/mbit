/**
 * 报告生成的**实时进度通道**（Redis）
 *
 * ## 为什么需要这一层
 *
 * `ai_reports` 只有 `status` + `progress` 两列，而生成过程中真正的阶段（装配上下文、
 * 调用模型、解析落库）**没有任何列可以承载**。SSE 订阅方若只能读库，就只能在
 * "progress 从 10 跳到 100"之间显示一个几乎不动的进度条 —— 契约 §3.5.6 要求的
 * `stage` / `progress` / `section` 事件根本无从产生。
 *
 * 不加数据库列（`schema.prisma` 冻结）而用 Redis 的理由：
 *   · 进度是**短生命周期状态**，任务结束即无意义，与 Redis TTL 语义天然契合（ADR-024 同思路）；
 *   · 它是**可丢的**：丢了只会让流退化到读库兜底，不会影响报告内容本身；
 *   · 写它的是 Worker、读它的是 HTTP 进程，Redis 是两者已经共用的通道（队列也走它）。
 *
 * ## 写入方与"不伪造进度"
 *
 * 只有 `ReportGenerationService` 在自己**真实的代码位置**上发布阶段
 * （见该文件里的 `publishLiveProgress` 调用点）。当前流水线里不存在独立的
 * `SAFETY_CHECK` 步骤，因此该阶段不会被发布 —— 保留枚举但不假装已实现。
 */

import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../../../infra/redis/redis.service';
import type { ReportStage } from './report-stream.util';

/** 实时进度键前缀 */
const LIVE_PROGRESS_PREFIX = 'report:live';

/**
 * 实时进度保留时长（秒）
 *
 * 30 分钟：远大于单次生成的正常耗时（10–60s）与队列排队时间，
 * 又远小于"用户第二天打开旧页面"的时间尺度 —— 陈旧进度绝不能盖住真实的报告状态。
 */
const LIVE_PROGRESS_TTL_SECONDS = 30 * 60;

/** 实时进度状态（可增量更新） */
export interface ReportLiveProgressState {
  readonly reportId: string;
  readonly userId: string;
  readonly status: string;
  readonly stage: ReportStage;
  readonly progress: number;
  readonly generatedWordCount: number;
  readonly generatedSectionCount: number;
  readonly targetSectionCount: number;
  readonly targetWordCount: number;
  readonly currentSectionKey: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

/** 增量更新（只覆盖显式给出的字段） */
export type ReportLiveProgressPatch = Partial<Omit<ReportLiveProgressState, 'reportId' | 'userId' | 'updatedAt'>>;

@Injectable()
export class ReportLiveProgressService {
  private readonly logger = new Logger(ReportLiveProgressService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * 发布/合并一次进度
   *
   * 读-改-写而非整体覆盖：每次只更新自己负责的字段，避免"后写的把先写的字段抹成默认值"。
   * 同一报告的写入方只有一个（该报告的生成任务），因此不存在并发合并的竞态。
   */
  async publish(reportId: string, userId: string, patch: ReportLiveProgressPatch): Promise<void> {
    const key = this.keyOf(reportId);
    const previous = await this.read(reportId);

    const next: ReportLiveProgressState = {
      reportId,
      userId,
      status: patch.status ?? previous?.status ?? 'GENERATING',
      stage: patch.stage ?? previous?.stage ?? 'QUEUED',
      progress: patch.progress ?? previous?.progress ?? 0,
      generatedWordCount: patch.generatedWordCount ?? previous?.generatedWordCount ?? 0,
      generatedSectionCount: patch.generatedSectionCount ?? previous?.generatedSectionCount ?? 0,
      targetSectionCount: patch.targetSectionCount ?? previous?.targetSectionCount ?? 0,
      targetWordCount: patch.targetWordCount ?? previous?.targetWordCount ?? 0,
      currentSectionKey: patch.currentSectionKey ?? previous?.currentSectionKey ?? null,
      provider: patch.provider ?? previous?.provider ?? null,
      model: patch.model ?? previous?.model ?? null,
      attempt: patch.attempt ?? previous?.attempt ?? 1,
      startedAt: patch.startedAt ?? previous?.startedAt ?? null,
      finishedAt: patch.finishedAt ?? previous?.finishedAt ?? null,
      updatedAt: new Date().toISOString(),
    };

    await this.redis.setJson(key, next, LIVE_PROGRESS_TTL_SECONDS);
  }

  /** 读取实时进度（不存在返回 null，调用方应回落到读库推导） */
  async read(reportId: string): Promise<ReportLiveProgressState | null> {
    try {
      return await this.redis.getJson<ReportLiveProgressState>(this.keyOf(reportId));
    } catch (error) {
      // 实时通道故障不能影响报告本身：读不到就当作没有实时数据
      this.logger.warn(`读取报告实时进度失败 reportId=${reportId}: ${(error as Error).message}`);
      return null;
    }
  }

  /** 主动清理（任务终结后调用，避免下一次生成读到上一轮的残留阶段） */
  async clear(reportId: string): Promise<void> {
    try {
      await this.redis.del(this.keyOf(reportId));
    } catch (error) {
      this.logger.warn(`清理报告实时进度失败 reportId=${reportId}: ${(error as Error).message}`);
    }
  }

  private keyOf(reportId: string): string {
    return this.redis.key(LIVE_PROGRESS_PREFIX, reportId);
  }
}
