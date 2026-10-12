/**
 * 报告扩展控制器（契约 §3.5.4 / §3.5.6 / §3.5.7 / §3.5.8 / §3.5.9）
 *
 * ## 为什么与 `report.controller.ts` 分开成两个控制器
 *
 * `report.controller.spec.ts` 有一条**刻意**的断言：「已实现的路由恰好四个」——
 * 它的作用是"有人误加路由时测试会红"。把新路由塞进同一个控制器会让那条断言失效
 * （要么删掉它，要么改成列举 9 个方法，防护作用随之消失）。
 * 因此新增路由落在第二个控制器上，共用同一个 `@Controller('reports')` 基础路径
 * （Nest 允许同一路径由多个控制器分担，路由段数不同，不会互相吃掉）。
 *
 * ## 五个接口的分层
 *
 * | 接口 | 落点 |
 * | ---- | ---- |
 * | `GET /sections`   | `ReportSectionsService`（复用 `buildSectionViews` 裁剪） |
 * | `GET /stream`     | `ReportStreamService` + 本文件的手写 SSE 传输层 |
 * | `POST /regenerate`| `ReportRegenerateService`（复用 `ai.report` 队列与既有生成流水线） |
 * | `POST /export-pdf`| `ReportExportService`（`export.pdf` 队列 + Redis 任务状态） |
 * | `POST /share-card`| `ReportShareCardService`（同步渲染 + 30 天缓存） |
 */

import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { CurrentUser, IDEMPOTENCY_KEY_HEADER, IdempotencyKey, RawResponse } from '../../../common/decorators';
import { ErrorCode } from '../../../common/errors/error-code';
import type { RequestWithContext } from '../../../common/types/request.type';
import { EntitlementService } from '../../membership/entitlement.service';
import {
  ExportReportPdfDto,
  GenerateShareCardDto,
  RegenerateReportDto,
  ReportIdPathDto,
  ReportSectionsQueryDto,
  ReportStreamQueryDto,
} from './report-engagement.dto';
import { ReportExportService, type PdfExportResult } from './report-export.service';
import { ReportRegenerateService, type RegenerateView } from './report-regenerate.service';
import type { ReportSectionsView } from './report-section.util';
import { ReportSectionsService } from './report-sections.service';
import { ReportShareCardService, type ShareCardView } from './report-share-card.service';
import { ReportStreamService, type ReportStreamSnapshot } from './report-stream.service';
import {
  SSE_HEARTBEAT_FRAME,
  STREAM_DEFAULT_HEARTBEAT_MS,
  STREAM_MAX_CONNECTIONS_PER_USER,
  STREAM_MAX_DURATION_MS,
  STREAM_POLL_INTERVAL_MS,
  buildDoneEvent,
  buildErrorEvent,
  buildProgressEvent,
  buildSectionEvent,
  buildStageEvent,
  buildStartEvent,
  buildUsageEvent,
  failureInfoOf,
  formatSseFrame,
  isTerminalStatus,
  type StreamEventBase,
} from './report-stream.util';

/** 心跳兜底下限（防止极端配置下刷屏） */
const MIN_HEARTBEAT_GUARD_MS = 1000;

/** 幂等键请求头（Swagger 展示用） */
const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_KEY_HEADER,
  required: true,
  description: '幂等键（8–64 位字母/数字/下划线/连字符）；重复提交返回首次结果，不重复扣配额',
} as const;

/** 可中断的等待（断连时不必等满一个轮询周期） */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

@ApiTags('报告')
@ApiBearerAuth('user-token')
@Controller('reports')
export class ReportEngagementController {
  constructor(
    private readonly sections: ReportSectionsService,
    private readonly streams: ReportStreamService,
    private readonly regenerateService: ReportRegenerateService,
    private readonly exportService: ReportExportService,
    private readonly shareCards: ReportShareCardService,
    private readonly entitlements: EntitlementService,
  ) {}

  // ==========================================================================
  // §3.5.4 报告分段列表
  // ==========================================================================

  @Get(':reportId/sections')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '报告分段列表（按段加载 / 渐进式解锁）',
    description: [
      '只返回分段内容，不含报告元数据，用于报告页的目录导航与「按段解锁」渐进渲染。',
      '',
      '**裁剪与详情接口完全一致**：两处都走 `report-visibility.ts` 的同一份可见性判定。',
      '未解锁段落的 `content` 为 `null` —— 正文根本不出现在响应体里，而不是发给前端再隐藏。',
      '',
      '`includeContent: false` 时返回目录结构（不含 `content` 字段）；带 `sectionKey` 时',
      '只返回该段，但 `lockedCount` / `unlockedCount` 仍按**全报告**统计。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（`items` + 全报告口径的锁定统计）' })
  @ApiResponse({ status: 400, description: '报告 ID 非 UUID（`10001`）或 `sectionKey` 非枚举（`10001`）' })
  @ApiResponse({ status: 404, description: '报告不存在或不属于当前用户（`50016`）' })
  @ApiResponse({ status: 409, description: '报告仍在生成中或无分段数据（`50017`）' })
  @ApiResponse({ status: 502, description: '报告生成失败（`50018`）' })
  async getSections(
    @CurrentUser('userId') userId: string,
    @Param() params: ReportIdPathDto,
    @Query() query: ReportSectionsQueryDto,
  ): Promise<ReportSectionsView> {
    const unlock = await this.entitlements.resolveReportUnlock(userId, params.reportId);

    return this.sections.getSections({
      userId,
      reportId: params.reportId,
      unlock: { allUnlocked: unlock.allUnlocked, unlockedSectionKeys: unlock.unlockedSectionKeys },
      // 契约默认 `true`（不带参数时返回正文）
      includeContent: query.includeContent ?? true,
      ...(query.sectionKey !== undefined ? { sectionKey: query.sectionKey } : {}),
    });
  }

  // ==========================================================================
  // §3.5.6 生成进度 SSE 流
  // ==========================================================================

  @Get(':reportId/stream')
  @RawResponse()
  // SSE 是长连接：限流只用于挡住"反复重连刷接口"，正常一次连接只算一次
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({
    summary: '生成进度 SSE 流',
    description: [
      '以 `text/event-stream` 推送阶段、进度与分段元数据；事件类型见契约 §3.5.6。',
      '',
      '**绝不推送付费正文**：`section` 事件只带元数据，`includeSectionPreview=true` 时',
      '额外带**免费预览片段**（取自与详情接口同一份可见性判定的产物）。',
      '',
      '**断连不取消生成**：客户端断开后任务照常跑完并落库，重连会重新收到当前进度。',
      '',
      `**并发上限 ${STREAM_MAX_CONNECTIONS_PER_USER} 条**、单连接最长 10 分钟（超时下发 \`error\` 事件后关闭）。`,
      '',
      '**已完成/失败的报告**：连接后立即下发 `start`（+ `usage`）+ `done`／`error` 并关闭，不报错。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: 'SSE 流（`text/event-stream`，不套统一响应包络）' })
  @ApiResponse({ status: 400, description: '报告 ID 非 UUID（`10001`）或 `heartbeatMs` 越界（`10001`）' })
  @ApiResponse({ status: 404, description: '报告不存在或不属于当前用户（`50016`）' })
  @ApiResponse({
    status: 429,
    description: `并发订阅超过 ${STREAM_MAX_CONNECTIONS_PER_USER} 条（契约 §3.5.6 的 50017 语义，本项目用 10007）`,
  })
  async streamProgress(
    @CurrentUser('userId') userId: string,
    @Param() params: ReportIdPathDto,
    @Query() query: ReportStreamQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const requestContext = req as RequestWithContext;
    const requestId = requestContext.requestId ?? 'unknown';
    const heartbeatMs = Math.max(query.heartbeatMs ?? STREAM_DEFAULT_HEARTBEAT_MS, MIN_HEARTBEAT_GUARD_MS);
    const includeSectionPreview = query.includeSectionPreview ?? false;

    /**
     * ① 连接建立前的校验
     *
     * 归属校验与并发名额都在**写入响应头之前**完成 —— 契约要求这两类错误以
     * "普通 JSON 包络"返回。一旦调用了 `flushHeaders()`，全局异常过滤器就再也不能
     * 改状态码（它检测到 `headersSent` 会直接返回），客户端只会看到一个断掉的流。
     */
    await this.streams.openStream(userId, params.reportId);
    const connectionToken = await this.streams.acquireConnectionSlot(userId);

    // 断连标记：只用于停止推送，**绝不取消生成任务**（契约规则 2）
    let clientGone = false;
    const onClientClose = (): void => {
      clientGone = true;
    };
    req.on('close', onClientClose);

    try {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Nginx 需要在 `proxy_buffering off` 之外再看这个头才会逐帧下发（契约规则 6）
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let seq = 0;
      let lastWriteAt = Date.now();
      const sentSections = new Set<string>();
      let sentStage: string | null = null;
      let sentProgress = -1;

      const base = (): StreamEventBase => ({
        requestId,
        seq: (seq += 1),
        ts: new Date().toISOString(),
        reportId: params.reportId,
      });

      const write = (frame: string): void => {
        if (clientGone || res.writableEnded) return;
        res.write(frame);
        lastWriteAt = Date.now();
      };

      const writeEvent = (event: string, data: Record<string, unknown>): void => {
        write(formatSseFrame(event, data));
      };

      /** 下发尚未推送过的分段事件（含"正文只可能是免费预览片段"的保证） */
      const flushSections = async (snapshot: ReportStreamSnapshot): Promise<void> => {
        const rows = await this.streams.loadSectionInputs(params.reportId, snapshot.unlock);
        for (const row of rows) {
          if (sentSections.has(row.sectionKey)) continue;
          sentSections.add(row.sectionKey);
          writeEvent(
            'section',
            buildSectionEvent(
              base(),
              // 不带 `includeSectionPreview` 时**不带 previewText 字段**（而不是给 null）
              includeSectionPreview ? row : { ...row, previewText: null },
            ),
          );
        }
      };

      let snapshot = await this.streams.readSnapshot(userId, params.reportId);

      writeEvent('start', buildStartEvent(base(), snapshot.generation, snapshot.estimatedSeconds));
      sentStage = snapshot.generation.stage;
      sentProgress = snapshot.generation.progress;

      const deadline = Date.now() + STREAM_MAX_DURATION_MS;

      // 已经在终态：按契约规则 1 立即收尾（start →（usage）→ done / error）
      while (!clientGone) {
        if (isTerminalStatus(snapshot.generation.status)) {
          if (snapshot.generation.status === 'SUCCEEDED') {
            await flushSections(snapshot);
            const usage = buildUsageEvent(base(), snapshot.generation);
            if (usage !== null) writeEvent('usage', usage);
            writeEvent(
              'done',
              buildDoneEvent(base(), snapshot.generation, {
                wordCount: snapshot.wordCount,
                sectionCount: snapshot.sectionCount,
                isUnlocked: snapshot.isUnlocked,
                freePreviewRatio: snapshot.freePreviewRatio,
              }),
            );
          } else {
            const failure = failureInfoOf(snapshot.generation.failureCode);
            writeEvent(
              'error',
              buildErrorEvent(base(), {
                code: failure.code,
                message: failure.message,
                canRetry: failure.canRetry,
                attempt: snapshot.generation.attempt,
              }),
            );
          }
          break;
        }

        // 超时（契约规则 5：单连接最长 10 分钟）
        if (Date.now() >= deadline) {
          writeEvent(
            'error',
            buildErrorEvent(base(), {
              // 契约该分支用 50010（生成超时）；本项目对应码为 50001 AI_PROVIDER_TIMEOUT（504）
              code: ErrorCode.AI_PROVIDER_TIMEOUT,
              message: '订阅时间已达上限（10 分钟），请重新打开进度流',
              canRetry: true,
              attempt: snapshot.generation.attempt,
            }),
          );
          break;
        }

        // 心跳：只在"距上次写入超过心跳间隔"时发，避免与真实事件互相挤占
        if (Date.now() - lastWriteAt >= heartbeatMs) {
          write(SSE_HEARTBEAT_FRAME);
        }

        await delay(STREAM_POLL_INTERVAL_MS);
        if (clientGone) break;

        snapshot = await this.streams.readSnapshot(userId, params.reportId);

        if (snapshot.generation.stage !== sentStage) {
          sentStage = snapshot.generation.stage;
          writeEvent('stage', buildStageEvent(base(), snapshot.generation));
        }

        if (snapshot.generation.progress !== sentProgress) {
          sentProgress = snapshot.generation.progress;
          writeEvent('progress', buildProgressEvent(base(), snapshot.generation));
        }
      }
    } finally {
      // 清理必须无条件执行：断连、异常、正常收尾三条路径都不能漏掉名额释放
      req.off('close', onClientClose);
      await this.streams.releaseConnectionSlot(userId, connectionToken);

      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  // ==========================================================================
  // §3.5.7 重新生成报告
  // ==========================================================================

  @Post(':reportId/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiOperation({
    summary: '重新生成报告（会员专属，异步）',
    description: [
      '基于同一画像重新生成报告，可换语气、换侧重；返回 `202` 与新 `reportId`。',
      '',
      '**会员专属**：非会员返回 `70016`（契约原文 `70014`；HTTP 402），前端应拉起付费墙。',
      '**次数限制**：每日上限来自 `system_config.reportRegenerateDailyLimit`（默认 5），',
      '响应返回 `remainingCount` 与 `resetAt`（次日 UTC 零点）。',
      '',
      '**强制绕过缓存**：重生成必然生成新内容（`cacheKey` 与旧报告不同），`cacheHit` 恒为 false。',
      '**不额外消耗报告配额**：只消耗会员的重生成次数（契约规则 6）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 202, description: '已受理，返回新 `reportId`、`taskId` 与轮询/订阅地址' })
  @ApiResponse({ status: 400, description: '`tone`/`reason` 非枚举、`focus` 超数量（`10001`）、缺少幂等键（`10009`）' })
  @ApiResponse({ status: 402, description: '非会员或次数用尽（`70016`，契约原文 `70014`）' })
  @ApiResponse({ status: 404, description: '报告不存在或不属于当前用户（`50016`）' })
  @ApiResponse({ status: 409, description: '原报告仍在生成中（`50017`）' })
  @ApiResponse({ status: 429, description: '触发限流（`10007`）' })
  @ApiResponse({ status: 503, description: '队列不可用（`90004`，契约原文 `90005`）' })
  async regenerateReport(
    @CurrentUser('userId') userId: string,
    @Param() params: ReportIdPathDto,
    @Body() dto: RegenerateReportDto,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<RegenerateView> {
    return this.regenerateService.regenerate({
      userId,
      reportId: params.reportId,
      idempotencyKey,
      ...(dto.tone !== undefined ? { tone: dto.tone } : {}),
      ...(dto.focus !== undefined ? { focus: dto.focus } : {}),
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
      ...(dto.feedback !== undefined ? { feedback: dto.feedback } : {}),
      ...(dto.keepOriginal !== undefined ? { keepOriginal: dto.keepOriginal } : {}),
    });
  }

  // ==========================================================================
  // §3.5.8 导出报告 PDF
  // ==========================================================================

  @Post(':reportId/export-pdf')
  // 状态码随"新建任务 / 复用既有 PDF"变化（202 / 200），因此不能只写 @HttpCode：
  // 处理器里用 `res.status(...)` 显式设置，Nest 在 `@Res()` 场景下不会覆盖它
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiOperation({
    summary: '导出报告 PDF（异步，会员或单次购买）',
    description: [
      '渲染 PDF 并上传 OSS，返回签名下载 URL；`202` + `taskId` 表示已受理，',
      '`200` + `isReused: true` 表示 24h 内已导出过同参数 PDF（直接复用，**不扣配额**）。',
      '',
      '**未解锁不可导出**（契约规则 2）：`isUnlocked = false` 时返回 `70016`（HTTP 402），',
      '避免把付费内容导出成 PDF 绕过付费墙。',
      '**配额原子扣减**：会员用每日 5 次的时间窗配额；非会员扣一次 `PDF_EXPORT` 权益',
      '（条件更新保证并发下不会超扣）；任务终态失败时会**自动归还**。',
      '',
      '⚠ 渲染器尚未接入（项目未安装 PDF 渲染库）：任务会以 `FAILED` + `90008` 结束并归还配额。',
    ].join('\n'),
  })
  @ApiResponse({ status: 202, description: '已受理，返回 `taskId` 与队列位置' })
  @ApiResponse({ status: 200, description: '24h 内已有同参数 PDF，直接复用（`isReused: true`）' })
  @ApiResponse({ status: 400, description: '`template` 非枚举或布尔参数非法（`10001`）、缺少幂等键（`10009`）' })
  @ApiResponse({ status: 402, description: '无会员权益且无 `PDF_EXPORT` 权益，或报告未解锁（`70016`）' })
  @ApiResponse({ status: 404, description: '报告不存在或不属于当前用户（`50016`）' })
  @ApiResponse({ status: 409, description: '报告未生成完成（`50017` / `50018`）' })
  @ApiResponse({ status: 429, description: '24h 内导出超过 5 次（`10007`，契约原文 `10010`）' })
  @ApiResponse({ status: 503, description: '队列不可用（`90004`，契约原文 `90005`）' })
  async exportPdf(
    @CurrentUser('userId') userId: string,
    @Param() params: ReportIdPathDto,
    @Body() dto: ExportReportPdfDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PdfExportResult['view']> {
    const result: PdfExportResult = await this.exportService.requestExport({
      userId,
      reportId: params.reportId,
      idempotencyKey,
      ...(dto.template !== undefined ? { template: dto.template } : {}),
      ...(dto.includeCharts !== undefined ? { includeCharts: dto.includeCharts } : {}),
      ...(dto.includeAnswers !== undefined ? { includeAnswers: dto.includeAnswers } : {}),
      ...(dto.watermark !== undefined ? { watermark: dto.watermark } : {}),
    });

    res.status(result.httpStatus);

    return result.view;
  }

  // ==========================================================================
  // §3.5.9 生成分享卡片图
  // ==========================================================================

  @Post(':reportId/share-card')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { limit: 20, ttl: 60_000 } })
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiOperation({
    summary: '生成分享卡片图（同步）',
    description: [
      '服务端渲染分享图（750×1334 WebP）并上传 OSS，返回可对外分享的图片地址。',
      '',
      '**付费内容防泄漏（规则 1）**：`QUOTE_CARD` 的金句只允许来自**免费预览段落**，',
      '`quoteSectionKey` 指向付费段落时返回 `10001`（契约原文 `60020`）。',
      '**缓存**：同报告 + 同模板 + 同参数复用已有图（TTL 30 天），`forceRefresh: true` 强制重渲染。',
      '**降级**：小程序码生成失败时仍返回卡片，`showQrCode` 置 `false` 并附 `warnings`（规则 6）。',
      '',
      '⚠ 渲染器尚未接入（项目未安装图片渲染库）：当前返回 `90008`，不会返回占位图。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '生成成功，返回图片地址、缩略图与分享文案' })
  @ApiResponse({ status: 400, description: '枚举非法、`QUOTE_CARD` 缺金句来源（`10001`）、缺少幂等键（`10009`）' })
  @ApiResponse({ status: 404, description: '报告不存在或不属于当前用户（`50016`）' })
  @ApiResponse({ status: 409, description: '报告未生成完成（`50017` / `50018`）' })
  @ApiResponse({ status: 429, description: '60min 内生成超过 10 次（`10007`，契约原文 `10010`）' })
  @ApiResponse({ status: 500, description: '渲染器未接入（`90008`）或渲染失败' })
  async generateShareCard(
    @CurrentUser('userId') userId: string,
    @Param() params: ReportIdPathDto,
    @Body() dto: GenerateShareCardDto,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<ShareCardView> {
    return this.shareCards.generateShareCard({
      userId,
      reportId: params.reportId,
      idempotencyKey,
      ...(dto.template !== undefined ? { template: dto.template } : {}),
      ...(dto.quoteSectionKey !== undefined ? { quoteSectionKey: dto.quoteSectionKey } : {}),
      ...(dto.showQrCode !== undefined ? { showQrCode: dto.showQrCode } : {}),
      ...(dto.showNickname !== undefined ? { showNickname: dto.showNickname } : {}),
      ...(dto.scene !== undefined ? { scene: dto.scene } : {}),
      ...(dto.forceRefresh !== undefined ? { forceRefresh: dto.forceRefresh } : {}),
    });
  }
}
