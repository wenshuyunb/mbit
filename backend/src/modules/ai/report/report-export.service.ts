/**
 * 报告 PDF 导出服务（契约 §3.5.8）
 *
 * ## 一次导出请求的完整链路
 *
 * ```
 * 幂等重放 → 归属/状态校验 → 未解锁拦截 → 24h 复用 → 权益判定（会员 / PDF_EXPORT）
 *   → 每日次数配额 → 建任务（Redis）→ 入队 export.pdf → 202
 *                                   ↓ Worker
 *   LOADING_REPORT（按可见性裁剪地读报告）→ RENDERING_PDF → UPLOADING → SIGNING → SUCCEEDED
 * ```
 *
 * ## 几个刻意的顺序决定
 *
 * ① **复用检查在扣配额之前**：24h 内已导出过就直接把旧文件还给他，不能因为"再点一次"
 *    就吃掉一次额度（契约规则 3 的目的正是省渲染资源，而不是多收一次费）。
 * ② **未解锁在一切之前**：`isUnlocked = false` 时绝不能导出 —— 契约规则 2 说得很直接，
 *    "不允许把付费内容导出为 PDF 绕过付费墙"。**复用路径同样要过这一关**：
 *    用户退款/权益被撤销后，缓存里那份 PDF 也不能再签发新链接。
 * ③ **先扣配额再入队**：反过来的话，任务已经在跑而额度检查失败，就会白渲染一份。
 *    扣减与入队之间用 `try/catch` 配对：入队失败立即归还（见 `releaseQuota`）。
 *
 * ## 任务状态存 Redis 而不落库
 *
 * 与 `DataExportService` 同一决策（ADR-024）：导出任务是短生命周期对象，
 * 源文件 7 天后清理，任务记录与之同寿。**但报告与文件的关联仍落库**
 * （`ai_reports.pdfUrl` / `pdfGeneratedAt`）：那是业务事实，不是临时状态。
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { EntitlementService } from '../../membership/entitlement.service';
import { StorageService } from '../../storage/storage.service';
import { SystemConfigService } from '../../system/system-config.service';
import {
  PDF_ESTIMATED_SECONDS,
  PDF_EXPORT_DAILY_LIMIT,
  PDF_EXPORT_QUOTA_WINDOW,
  PDF_IDEMPOTENCY_TTL_SECONDS,
  PDF_SIGNED_URL_TTL_SECONDS,
  PDF_TASK_TTL_SECONDS,
  REPORT_EXPORT_JOB_NAME,
  REPORT_EXPORT_QUEUE_NAME,
  REPORT_EXPORT_STAGE_PROGRESS,
  buildPdfFileName,
  buildPdfObjectKey,
  buildWatermarkText,
  isExportTaskExpired,
  isReusableTask,
  isRetryableExportError,
  pdfReuseFingerprint,
  queuePositionOf,
  readBusinessErrorCode,
  type PdfExportTemplate,
  type ReportExportStage,
  type ReportExportTaskState,
} from './report-export.util';
import { ReportQuotaService } from './report-quota.service';
import { renderReportPdf, type PdfRenderInput } from './report-render.util';
import { buildSectionViews } from './report-visibility';

/** Redis 键前缀 */
const PDF_TASK_PREFIX = 'report:pdf:task';
const PDF_IDEMPOTENCY_PREFIX = 'report:pdf:idem';
const PDF_REUSE_PREFIX = 'report:pdf:latest';

/** 导出请求入参（DTO 校验后的值） */
export interface PdfExportRequestInput {
  readonly userId: string;
  readonly reportId: string;
  readonly idempotencyKey: string;
  readonly template?: PdfExportTemplate;
  readonly includeCharts?: boolean;
  readonly includeAnswers?: boolean;
  readonly watermark?: boolean;
}

/** 202 响应（新建任务，契约 §3.5.8 成功响应 202） */
export interface PdfExportAcceptedView {
  readonly taskId: string;
  readonly reportId: string;
  readonly status: string;
  readonly stage: ReportExportStage;
  readonly queue: string;
  readonly queuePosition: number;
  readonly template: PdfExportTemplate;
  readonly includeCharts: boolean;
  readonly includeAnswers: boolean;
  readonly watermark: boolean;
  readonly estimatedSeconds: number;
  readonly pageCount: number | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly pollUrl: string;
}

/** 200 响应（24h 内复用既有 PDF，契约 §3.5.8 成功响应 200） */
export interface PdfExportReusedView {
  readonly taskId: string;
  readonly reportId: string;
  readonly status: string;
  readonly isReused: true;
  readonly fileName: string;
  readonly sizeBytes: number | null;
  readonly pageCount: number | null;
  readonly template: PdfExportTemplate;
  readonly downloadUrl: string;
  readonly watermark: boolean;
  readonly generatedAt: string | null;
  readonly expiresAt: string;
}

/** 请求结果：HTTP 状态随复用与否变化（契约同时定义 202 与 200） */
export interface PdfExportResult {
  readonly httpStatus: number;
  readonly view: PdfExportAcceptedView | PdfExportReusedView;
}

/** 报告导出所需的画像与分段（读取时即完成裁剪） */
interface ExportReportData {
  readonly reportId: string;
  readonly userId: string;
  readonly title: string | null;
  readonly contentLength: number;
  readonly mbtiType: string | null;
  readonly engineVersion: string | null;
  readonly nickname: string | null;
  readonly sections: PdfRenderInput['sections'];
  readonly dimensions: PdfRenderInput['dimensions'];
  readonly bigFive: PdfRenderInput['bigFive'];
}

@Injectable()
export class ReportExportService {
  private readonly logger = new Logger(ReportExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly entitlements: EntitlementService,
    private readonly quota: ReportQuotaService,
    private readonly systemConfigs: SystemConfigService,
    @InjectQueue(REPORT_EXPORT_QUEUE_NAME) private readonly exportQueue: Queue,
  ) {}

  // ==========================================================================
  // 请求侧（HTTP 进程）
  // ==========================================================================

  async requestExport(input: PdfExportRequestInput): Promise<PdfExportResult> {
    const template: PdfExportTemplate = input.template ?? 'CLASSIC';
    const includeCharts = input.includeCharts ?? true;
    const includeAnswers = input.includeAnswers ?? false;
    const watermark = input.watermark ?? true;
    const now = new Date();

    const idempotencyRedisKey = this.idempotencyKeyOf(input.userId, input.idempotencyKey);

    // ---- ① 幂等重放：返回同一 taskId 的当前状态（♻️ 防重复扣配额） ----
    const replayed = await this.loadTaskByKey(idempotencyRedisKey, input.userId);
    if (replayed !== null) {
      this.logger.log(`PDF 导出幂等重放 taskId=${replayed.taskId} status=${replayed.status}`);
      return this.toReplayResult(replayed, now);
    }

    // ---- ② 归属与状态（404 / 409），此时尚未消耗任何资源 ----
    await this.assertReportExportable(input.userId, input.reportId);

    // ---- ③ 未解锁不可导出（付费墙，契约规则 2） ----
    const unlock = await this.entitlements.resolveReportUnlock(input.userId, input.reportId);
    if (!unlock.allUnlocked) {
      throw new BusinessException(
        ErrorCode.ENTITLEMENT_REQUIRED,
        // 双语文案只说事实：无论"没解锁"还是"没会员"，用户的下一步都是去解锁/开通
        '报告完整内容尚未解锁，解锁后才能导出 PDF',
        { httpStatus: 402 },
      );
    }

    // ---- ④ 24h 复用（必须先于配额扣减：复用不该吃额度） ----
    const fingerprint = pdfReuseFingerprint({
      reportId: input.reportId,
      template,
      includeCharts,
      includeAnswers,
      watermark,
    });
    const reuseKey = this.reuseKeyOf(fingerprint);
    const cachedTask = await this.loadTaskByKey(reuseKey, input.userId);
    if (cachedTask !== null && isReusableTask(cachedTask, now)) {
      await this.redis.set(idempotencyRedisKey, cachedTask.taskId, PDF_IDEMPOTENCY_TTL_SECONDS);
      this.logger.log(`PDF 导出命中 24h 缓存，复用 taskId=${cachedTask.taskId}`);
      return { httpStatus: 200, view: this.toReusedView(cachedTask) };
    }

    // ---- ⑤ 权益判定 + 配额扣减（失败必须成对归还） ----
    const consumed = await this.consumeQuota(input.userId);

    // ---- ⑥ 建任务并入队 ----
    // taskId 用 UUIDv7（契约示例即 v7）：时间有序、可直接作为 BullMQ 的 jobId，
    // 且不必像哈希前缀那样担心"两个用户在同一毫秒内导出同一报告"而撞键
    const taskId = uuidv7();
    const expiresAt = new Date(now.getTime() + PDF_TASK_TTL_SECONDS * 1000);

    const task: ReportExportTaskState = {
      taskId,
      reportId: input.reportId,
      userId: input.userId,
      queue: REPORT_EXPORT_QUEUE_NAME,
      status: 'PENDING',
      stage: 'QUEUED',
      progress: REPORT_EXPORT_STAGE_PROGRESS.QUEUED,
      template,
      includeCharts,
      includeAnswers,
      watermark,
      objectKey: buildPdfObjectKey(input.userId, input.reportId, template),
      fileName: '',
      sizeBytes: null,
      pageCount: null,
      generatedAt: null,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      consumed,
    };

    // 先写状态再入队：反过来的话 Worker 可能先于状态写入开始处理并读不到任务
    await this.saveTask(task);
    await this.redis.set(idempotencyRedisKey, taskId, PDF_IDEMPOTENCY_TTL_SECONDS);
    await this.redis.set(reuseKey, taskId, PDF_TASK_TTL_SECONDS);

    try {
      // jobId = taskId：同名 job 天然去重，重试不会变成两份任务
      await this.exportQueue.add(REPORT_EXPORT_JOB_NAME, { taskId }, { jobId: taskId });
    } catch (error) {
      // 入队失败必须回收状态并**归还刚刚扣掉的额度** —— 否则用户被扣了次数却什么都没拿到
      await this.redis.del(idempotencyRedisKey, reuseKey, this.taskKeyOf(taskId));
      await this.releaseQuota(task);
      this.logger.error(`PDF 导出入队失败，已回收任务并归还配额 taskId=${taskId}: ${(error as Error).message}`);
      throw new BusinessException(ErrorCode.QUEUE_ERROR, '导出服务暂时不可用，请稍后重试', {
        httpStatus: 503,
      });
    }

    this.logger.log(`PDF 导出任务已创建 taskId=${taskId} reportId=${input.reportId} template=${template}`);

    return {
      httpStatus: 202,
      view: {
        taskId,
        reportId: input.reportId,
        status: task.status,
        stage: task.stage,
        queue: task.queue,
        queuePosition: queuePositionOf(await this.waitingCount()),
        template,
        includeCharts,
        includeAnswers,
        watermark,
        estimatedSeconds: PDF_ESTIMATED_SECONDS,
        pageCount: null,
        createdAt: task.createdAt,
        expiresAt: task.expiresAt,
        // ⚠ 契约规则 6 要求用 `GET /reports/{id}/progress` 查询导出进度，但该接口（§3.5.5）
        //    本轮被冻结，它只读 `ai_reports` 的行、看不到本模块的导出任务。
        //    因此**本接口的幂等重放**（同 `X-Idempotency-Key` 再 POST 一次）才是当前可用的
        //    状态查询路径：重放会返回任务的当前状态与下载链接。已在交付报告中标注。
        pollUrl: `/api/v1/reports/${input.reportId}/progress`,
      },
    };
  }

  // ==========================================================================
  // 任务状态（Worker 与本服务共用）
  // ==========================================================================

  async loadTask(taskId: string): Promise<ReportExportTaskState | null> {
    return this.redis.getJson<ReportExportTaskState>(this.taskKeyOf(taskId));
  }

  async saveTask(task: ReportExportTaskState): Promise<void> {
    await this.redis.setJson(this.taskKeyOf(task.taskId), task, PDF_TASK_TTL_SECONDS);
  }

  /**
   * 执行一次导出（由队列处理器调用）
   *
   * 幂等：已成功的任务直接返回（重复投递/人工重放都不会重复渲染、重复上传）。
   * 终态失败时**归还配额**：用户没拿到文件就不该被扣次数。
   */
  async runExportTask(taskId: string, context: { isFinalAttempt: boolean }): Promise<void> {
    const task = await this.loadTask(taskId);
    if (task === null) {
      // 状态已被 TTL 回收：不是错误，重试也不会变好
      this.logger.warn(`PDF 导出任务状态不存在，跳过 taskId=${taskId}`);
      return;
    }

    if (task.status === 'SUCCEEDED') {
      this.logger.log(`PDF 导出任务已完成，跳过重复执行 taskId=${taskId}`);
      return;
    }

    let current = await this.advance(task, {
      status: 'PROCESSING',
      stage: 'LOADING_REPORT',
      progress: REPORT_EXPORT_STAGE_PROGRESS.LOADING_REPORT,
      startedAt: new Date().toISOString(),
      // 重试前清掉上一次的错误，避免"重试中却显示上次的错误"
      errorCode: null,
      errorMessage: null,
    });

    try {
      const data = await this.loadExportData(current.userId, current.reportId);

      current = await this.advance(current, {
        stage: 'RENDERING_PDF',
        progress: REPORT_EXPORT_STAGE_PROGRESS.RENDERING_PDF,
        fileName: buildPdfFileName(data.mbtiType, current.reportId, new Date()),
      });

      const artifact = await renderReportPdf({
        reportId: current.reportId,
        title: data.title ?? '人格深度报告',
        mbtiType: data.mbtiType,
        mbtiTypeName: null,
        engineVersion: data.engineVersion,
        template: current.template,
        includeCharts: current.includeCharts,
        includeAnswers: current.includeAnswers,
        watermark: current.watermark,
        watermarkText: buildWatermarkText(data.nickname, new Date()),
        generatedAt: new Date(),
        disclaimer: await this.readDisclaimer(),
        sections: data.sections,
        dimensions: data.dimensions,
        bigFive: data.bigFive,
      });

      current = await this.advance(current, {
        stage: 'UPLOADING',
        progress: REPORT_EXPORT_STAGE_PROGRESS.UPLOADING,
      });

      await this.storage.uploadServerObject({
        objectKey: current.objectKey,
        body: artifact.body,
        contentType: artifact.contentType,
      });

      current = await this.advance(current, {
        stage: 'SIGNING',
        progress: REPORT_EXPORT_STAGE_PROGRESS.SIGNING,
      });

      const generatedAt = new Date();
      const signed = this.storage.signServerObjectUrl(
        current.objectKey,
        PDF_SIGNED_URL_TTL_SECONDS,
        `attachment; filename="${current.fileName}"`,
      );

      // 业务事实落库：列表页的 `hasPdf` 与详情页的 PDF 入口都读这两列
      await this.prisma.aiReport.update({
        where: { id: current.reportId },
        data: { pdfUrl: signed.url, pdfGeneratedAt: generatedAt },
      });

      await this.advance(current, {
        status: 'SUCCEEDED',
        stage: 'DONE',
        progress: REPORT_EXPORT_STAGE_PROGRESS.DONE,
        sizeBytes: artifact.sizeBytes,
        pageCount: artifact.pageCount,
        generatedAt: generatedAt.toISOString(),
        finishedAt: generatedAt.toISOString(),
      });

      this.logger.log(`PDF 导出完成 taskId=${taskId} bytes=${artifact.sizeBytes} pages=${artifact.pageCount ?? 0}`);
    } catch (error) {
      const code = readBusinessErrorCode(error);
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = new Date();

      await this.advance(current, {
        status: 'FAILED',
        stage: 'ERROR',
        progress: REPORT_EXPORT_STAGE_PROGRESS.ERROR,
        errorCode: code,
        errorMessage: message.slice(0, 500),
        finishedAt: finishedAt.toISOString(),
      });

      const retryable = isRetryableExportError(code) && !context.isFinalAttempt;

      // 不重试 → 把配额还给用户；还要重试 → 先留着（成功时才算真正消耗）
      if (!retryable) {
        await this.releaseQuota(task);
      }

      this.logger.error(
        `PDF 导出失败 taskId=${taskId} code=${code} retryable=${retryable} final=${context.isFinalAttempt}: ${message}`,
      );

      if (retryable) {
        // 抛出让 BullMQ 记录失败并按退避策略重试
        throw error;
      }
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /**
   * 扣减一次导出额度
   *
   * 会员走时间窗配额；非会员必须先有可扣的 `PDF_EXPORT` 权益（单次购买）。
   * 两步都做了"失败即归还"的配对：先扣权益再扣窗口，窗口超限时立刻把权益还回去。
   */
  private async consumeQuota(userId: string): Promise<ReportExportTaskState['consumed']> {
    const membership = await this.entitlements.getMembership(userId);
    let entitlementId: string | null = null;

    if (!membership.isMember) {
      entitlementId = await this.quota.consumePdfExportEntitlement(userId);

      if (entitlementId === null) {
        // 契约 §3.5.8 规则 1：非会员可单次购买 PDF_EXPORT；两者都没有 → 拉起付费墙
        throw new BusinessException(ErrorCode.ENTITLEMENT_REQUIRED, 'PDF 导出为会员权益，或可单独购买导出次数', {
          httpStatus: 402,
        });
      }
    }

    try {
      await this.quota.consumeWindowQuota({
        scope: 'pdf-export',
        userId,
        limit: PDF_EXPORT_DAILY_LIMIT,
        window: PDF_EXPORT_QUOTA_WINDOW,
        message: `24 小时内导出次数已达上限（${PDF_EXPORT_DAILY_LIMIT} 次），请稍后再试`,
      });
    } catch (error) {
      // 窗口超限：把刚扣的权益还回去，再抛 429
      if (entitlementId !== null) {
        await this.quota.refundPdfExportEntitlement(entitlementId);
      }
      throw error;
    }

    return { entitlementId, windowQuota: true };
  }

  /** 归还任务消耗的额度（入队失败、终态失败时调用） */
  private async releaseQuota(task: ReportExportTaskState): Promise<void> {
    if (task.consumed.entitlementId !== null) {
      await this.quota.refundPdfExportEntitlement(task.consumed.entitlementId);
    }

    if (task.consumed.windowQuota) {
      await this.quota.refundWindowQuota({
        scope: 'pdf-export',
        userId: task.userId,
        window: PDF_EXPORT_QUOTA_WINDOW,
      });
    }
  }

  /** 归属 + 状态校验（未完成/失败的报告没有内容可导出） */
  private async assertReportExportable(userId: string, reportId: string): Promise<void> {
    const report = await this.prisma.aiReport.findFirst({
      where: { id: reportId, userId, deletedAt: null },
      select: { status: true },
    });

    if (report === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    if (report.status === 'QUEUED' || report.status === 'GENERATING') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATING, '报告正在生成中，请稍后再导出');
    }

    if (report.status !== 'SUCCEEDED') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATION_FAILED, '报告生成失败，请重新生成后再导出');
    }
  }

  /**
   * 读取渲染素材（**在此完成付费内容裁剪**）
   *
   * 传给渲染器的是 `buildSectionViews` 的产物：未解锁段落的 `content` 为 `null`。
   * 即便将来接入的渲染库"想把内容画得更完整"，它拿到的素材里也没有付费正文 ——
   * 把安全边界放在**数据形状**上，而不是放在渲染实现的自觉上。
   */
  private async loadExportData(userId: string, reportId: string): Promise<ExportReportData> {
    const report = await this.prisma.aiReport.findFirst({
      where: { id: reportId, userId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        title: true,
        contentLength: true,
        profile: {
          select: {
            mbtiType: true,
            engineVersion: true,
            eiPercent: true,
            snPercent: true,
            tfPercent: true,
            jpPercent: true,
            openness: true,
            conscientiousness: true,
            extraversion: true,
            agreeableness: true,
            neuroticism: true,
          },
        },
      },
    });

    if (report === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    const [sections, user, unlock] = await Promise.all([
      this.prisma.reportSection.findMany({
        where: { reportId },
        orderBy: { order: 'asc' },
        select: { sectionKey: true, title: true, content: true, order: true, isFreePreview: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true } }),
      this.entitlements.resolveReportUnlock(userId, reportId),
    ]);

    const visibility = buildSectionViews(sections, {
      allUnlocked: unlock.allUnlocked,
      unlockedSectionKeys: unlock.unlockedSectionKeys,
    });

    return {
      reportId: report.id,
      userId: report.userId,
      title: report.title,
      contentLength: report.contentLength,
      mbtiType: report.profile?.mbtiType ?? null,
      engineVersion: report.profile?.engineVersion ?? null,
      nickname: user?.nickname ?? null,
      sections: visibility.map((section) => ({
        title: section.title,
        // 未解锁 → null（类型层面保证），渲染实现必须跳过正文
        content: section.content,
        order: section.order,
      })),
      dimensions:
        report.profile === null
          ? null
          : {
              EI: report.profile.eiPercent,
              SN: report.profile.snPercent,
              TF: report.profile.tfPercent,
              JP: report.profile.jpPercent,
            },
      bigFive:
        report.profile === null
          ? null
          : {
              openness: report.profile.openness,
              conscientiousness: report.profile.conscientiousness,
              extraversion: report.profile.extraversion,
              agreeableness: report.profile.agreeableness,
              neuroticism: report.profile.neuroticism,
            },
    };
  }

  /** 读取合规声明（来自 `system_configs`，不硬编码；读不到时用契约里的保底文案） */
  private async readDisclaimer(): Promise<string> {
    try {
      const entry = await this.systemConfigs.getEntry('disclaimer.aiContent');
      if (entry !== undefined && typeof entry.value === 'string' && entry.value.length > 0) {
        return entry.value;
      }
    } catch (error) {
      // 配置读不到不应让导出失败：合规文案有保底值，而"导出不了"是用户可感知的损失
      this.logger.warn(`读取免责声明失败，使用保底文案: ${(error as Error).message}`);
    }

    return 'AI 内容由模型生成，仅供自我探索参考，不构成心理诊断或医疗建议。';
  }

  /** 更新任务状态（只合并传入字段，避免手写整对象时漏字段） */
  private async advance(
    task: ReportExportTaskState,
    patch: Partial<ReportExportTaskState>,
  ): Promise<ReportExportTaskState> {
    const next = { ...task, ...patch };
    await this.saveTask(next);

    return next;
  }

  /** 按幂等/复用键读取任务，并校验归属（同键不同用户时视为未命中） */
  private async loadTaskByKey(key: string, userId: string): Promise<ReportExportTaskState | null> {
    const taskId = await this.redis.get(key);
    if (taskId === null || taskId.length === 0) return null;

    const task = await this.loadTask(taskId);
    if (task === null || task.userId !== userId) {
      // 任务已被 TTL 回收（或键被他人占用）：清掉陈旧键，走正常流程
      await this.redis.del(key);
      return null;
    }

    return task;
  }

  /** 幂等重放的响应：已完成 → 200 复用视图；进行中/失败 → 202 当前状态 */
  private toReplayResult(task: ReportExportTaskState, now: Date): PdfExportResult {
    if (task.status === 'SUCCEEDED' && !isExportTaskExpired(task, now)) {
      return { httpStatus: 200, view: this.toReusedView(task) };
    }

    return {
      httpStatus: 202,
      view: {
        taskId: task.taskId,
        reportId: task.reportId,
        status: task.status,
        stage: task.stage,
        queue: task.queue,
        queuePosition: 1,
        template: task.template,
        includeCharts: task.includeCharts,
        includeAnswers: task.includeAnswers,
        watermark: task.watermark,
        estimatedSeconds: PDF_ESTIMATED_SECONDS,
        pageCount: task.pageCount,
        createdAt: task.createdAt,
        expiresAt: task.expiresAt,
        pollUrl: `/api/v1/reports/${task.reportId}/progress`,
      },
    };
  }

  /**
   * 复用视图
   *
   * **每次现签**下载 URL：任务状态里只存对象键。存下签名 URL 的后果是"24h 后
   * 复用窗口还没过、链接却已经失效"，用户会在复用路径上拿到一个打不开的地址。
   */
  private toReusedView(task: ReportExportTaskState): PdfExportReusedView {
    const signed = this.storage.signServerObjectUrl(
      task.objectKey,
      PDF_SIGNED_URL_TTL_SECONDS,
      `attachment; filename="${task.fileName}"`,
    );

    return {
      taskId: task.taskId,
      reportId: task.reportId,
      status: task.status,
      isReused: true,
      fileName: task.fileName,
      sizeBytes: task.sizeBytes,
      pageCount: task.pageCount,
      template: task.template,
      downloadUrl: signed.url,
      watermark: task.watermark,
      generatedAt: task.generatedAt,
      expiresAt: task.expiresAt,
    };
  }

  private async waitingCount(): Promise<number> {
    try {
      return await this.exportQueue.getWaitingCount();
    } catch (error) {
      // 队列信息拿不到不影响任务本身，队列位置只是展示用
      this.logger.warn(`读取导出队列长度失败: ${(error as Error).message}`);
      return 0;
    }
  }

  private taskKeyOf(taskId: string): string {
    return this.redis.key(PDF_TASK_PREFIX, taskId);
  }

  private idempotencyKeyOf(userId: string, idempotencyKey: string): string {
    return this.redis.key(PDF_IDEMPOTENCY_PREFIX, userId, this.crypto.sha256(idempotencyKey));
  }

  private reuseKeyOf(fingerprint: string): string {
    return this.redis.key(PDF_REUSE_PREFIX, this.crypto.sha256(fingerprint).slice(0, 32));
  }
}
