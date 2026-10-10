/**
 * 数据导出处理器（契约 §3.2.7 规则 1：`export.data` 队列，并发 2，重试 2 次）
 *
 * 这是项目**第一个队列处理器**，因此它同时承担「立模式」的职责：
 *   · 幂等：同一 taskId 重复投递不重复生成（生成两次会给用户两份链接，
 *     且旧对象无人清理）
 *   · 失败语义：可重试错误抛出交给 BullMQ；终态失败才释放「单任务」占用
 *   · 进度回报：每个阶段写回 Redis，前端轮询能看到阶段而非只有转圈
 *
 * 🚫 本处理器**不接收 HTTP 请求**，只消费队列；HTTP 进程不会加载它
 *   （见 `worker.module.ts`：处理器只在 `dist/worker.js` 的模块图里）。
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QUEUE_EXPORT_DATA } from '../../../infra/queue/queue.module';
import { StorageService } from '../../storage/storage.service';
import {
  EXPORT_COLLECTION_LIMIT,
  EXPORT_JSON_MIME,
  buildExportFileName,
  buildExportObjectKey,
  buildExportPayload,
  buildExportUser,
  buildExportWechat,
  scopeIncludes,
  serializeExportPayload,
  type ExportConsentEntry,
  type ExportScope,
} from '../data-export.builder';
import { DataExportService } from '../data-export.service';
import type { ExportTaskState } from '../dto/user.dto';

/** 队列任务载荷 */
export interface ExportJobData {
  taskId: string;
  userId: string;
  scope: ExportScope;
}

/** 队列并发（契约 §3.2.7 规则 1：并发 2） */
const EXPORT_CONCURRENCY = 2;

/** 签名下载 URL 有效期（契约 §3.2.7 规则 3：24h） */
const EXPORT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

@Processor(QUEUE_EXPORT_DATA, { concurrency: EXPORT_CONCURRENCY })
export class DataExportProcessor extends WorkerHost {
  private readonly logger = new Logger(DataExportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly exportService: DataExportService,
  ) {
    super();
  }

  async process(job: Job<ExportJobData>): Promise<void> {
    const { taskId, userId, scope } = job.data;

    const task = await this.exportService.loadTask(taskId);
    if (task === null) {
      // 任务状态已被 TTL 回收：不是错误，重试也不会变好
      this.logger.warn(`导出任务状态不存在，跳过 taskId=${taskId}`);
      return;
    }

    // 幂等：重复投递（jobId 相同一般不会，但重试与人工重放可能）不重复生成
    if (task.status === 'SUCCEEDED') {
      this.logger.log(`导出任务已完成，跳过重复生成 taskId=${taskId}`);
      return;
    }

    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    try {
      await this.advance(task, { status: 'PROCESSING', stage: 'COLLECTING', progress: 20 });

      const collected = await this.collect(userId, scope);

      await this.advance(task, { stage: 'RENDERING_JSON', progress: 50 });
      const body = serializeExportPayload(buildExportPayload({ scope, exportedAt: new Date(), ...collected }));

      await this.advance(task, { stage: 'UPLOADING', progress: 80 });

      const objectKey = buildExportObjectKey(userId, taskId, 'json');
      const fileName = buildExportFileName(taskId, 'json', new Date());
      const uploaded = await this.storage.uploadServerObject({
        objectKey,
        body,
        contentType: EXPORT_JSON_MIME,
      });

      const signed = this.storage.signServerObjectUrl(
        objectKey,
        EXPORT_SIGNED_URL_TTL_SECONDS,
        `attachment; filename="${fileName}"`,
      );

      const finishedAt = new Date();
      await this.advance(task, {
        status: 'SUCCEEDED',
        stage: 'DONE',
        progress: 100,
        finishedAt: finishedAt.toISOString(),
        files: [
          {
            format: 'JSON',
            fileName,
            sizeBytes: uploaded.sizeBytes,
            downloadUrl: signed.url,
            expiresAt: signed.expiresAt.toISOString(),
          },
        ],
      });

      // 成功后才释放「单任务」占用，让用户可以再次申请
      await this.exportService.releaseActiveSlot(userId);

      this.logger.log(
        `导出任务完成 taskId=${taskId} userId=${userId} bytes=${uploaded.sizeBytes} truncated=${collected.truncated.join(',') || 'none'}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.advance(task, {
        status: 'FAILED',
        stage: 'ERROR',
        errorMessage: message.slice(0, 500),
      });

      // 只有在**最后一次尝试**失败时才释放占用：
      // 提前释放会让用户在任务仍会重试时又建一个新任务，产生两份导出
      if (isFinalAttempt) {
        await this.exportService.releaseActiveSlot(userId);
      }

      this.logger.error(
        `导出任务失败 taskId=${taskId} attempt=${job.attemptsMade + 1} final=${isFinalAttempt}: ${message}`,
      );

      // 抛出让 BullMQ 记录失败并按策略重试
      throw error;
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 更新任务状态（只改传入字段，避免手写整对象时漏字段） */
  private async advance(task: ExportTaskState, patch: Partial<ExportTaskState>): Promise<ExportTaskState> {
    const next = { ...task, ...patch };
    await this.exportService.saveTask(next);
    return next;
  }

  /**
   * 聚合导出数据
   *
   * 每个集合多取 1 条用于判断「是否被截断」—— 静默截断会让用户以为
   * 拿到的是全部数据，而导出包的用途恰恰是「完整副本」，这点必须显式告知。
   */
  private async collect(
    userId: string,
    scope: ExportScope,
  ): Promise<{
    user: ReturnType<typeof buildExportUser>;
    wechat: ReturnType<typeof buildExportWechat>;
    consents: ExportConsentEntry[];
    testSessions: Array<Record<string, unknown>>;
    personalityProfiles: Array<Record<string, unknown>>;
    aiReports: Array<Record<string, unknown>>;
    aiConversations: Array<Record<string, unknown>>;
    truncated: string[];
  }> {
    const truncated: string[] = [];
    const wantsProfile = scopeIncludes(scope, 'PROFILE');
    const wantsReports = scopeIncludes(scope, 'REPORTS');
    const wantsConversations = scopeIncludes(scope, 'CONVERSATIONS');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        gender: true,
        birthday: true,
        ageVerified: true,
        // phoneEnc 解密后立即脱敏，明文不进入导出包
        phoneEnc: true,
        status: true,
        registerChannel: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    if (user === null) {
      throw new BusinessException(ErrorCode.USER_NOT_FOUND);
    }

    const wechatAccount = wantsProfile
      ? await this.prisma.wechatAccount.findUnique({
          where: { userId },
          select: { platform: true, openid: true, unionid: true, createdAt: true },
        })
      : null;

    const consentRows = wantsProfile
      ? await this.prisma.userConsent.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: EXPORT_COLLECTION_LIMIT + 1,
          select: {
            type: true,
            policyVersion: true,
            agreed: true,
            agreedAt: true,
            revokedAt: true,
          },
        })
      : [];

    const sessionRows = wantsReports
      ? await this.prisma.testSession.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: EXPORT_COLLECTION_LIMIT + 1,
          select: {
            id: true,
            definitionCode: true,
            status: true,
            questionCount: true,
            answeredCount: true,
            progress: true,
            startedAt: true,
            submittedAt: true,
            durationMs: true,
            consistencyScore: true,
            completionRate: true,
            createdAt: true,
          },
        })
      : [];

    const profileRows = wantsReports
      ? await this.prisma.personalityProfile.findMany({
          where: { userId },
          orderBy: { version: 'desc' },
          take: EXPORT_COLLECTION_LIMIT + 1,
        })
      : [];

    const reportRows = wantsReports
      ? await this.prisma.aiReport.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: EXPORT_COLLECTION_LIMIT + 1,
          select: {
            id: true,
            type: true,
            status: true,
            title: true,
            summary: true,
            content: true,
            provider: true,
            model: true,
            totalTokens: true,
            costAmount: true,
            createdAt: true,
            generationFinishedAt: true,
          },
        })
      : [];

    const conversationRows = wantsConversations
      ? await this.prisma.aiConversation.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: EXPORT_COLLECTION_LIMIT + 1,
          select: {
            id: true,
            title: true,
            scene: true,
            status: true,
            messageCount: true,
            memorySummary: true,
            lastMessageAt: true,
            createdAt: true,
          },
        })
      : [];

    const cap = <T>(rows: T[], name: string): T[] => {
      if (rows.length <= EXPORT_COLLECTION_LIMIT) return rows;
      truncated.push(name);
      return rows.slice(0, EXPORT_COLLECTION_LIMIT);
    };

    return {
      user: buildExportUser({
        ...user,
        phonePlain: this.crypto.tryDecrypt(user.phoneEnc),
      }),
      wechat: buildExportWechat(wechatAccount),
      consents: cap(
        // 显式映射（而非直接透传行对象）：导出包的形状是**对外契约**，
        // 显式列出字段可以让「新增隐私列时是否要进导出包」变成一次有意识的决定
        consentRows.map((row) => ({
          type: row.type,
          policyVersion: row.policyVersion,
          agreed: row.agreed,
          agreedAt: row.agreedAt === null ? null : row.agreedAt.toISOString(),
          revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
        })),
        'consents',
      ),
      testSessions: cap(sessionRows, 'testSessions'),
      personalityProfiles: cap(profileRows, 'personalityProfiles'),
      aiReports: cap(reportRows, 'aiReports'),
      aiConversations: cap(conversationRows, 'aiConversations'),
      truncated,
    };
  }
}
