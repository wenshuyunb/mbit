/**
 * 分享卡片服务（契约 §3.5.9）
 *
 * ## 同步返回（而不是走队列）
 *
 * 契约写明"渲染 < 2s，同步返回；若渲染超时则降级为 202 + taskId"。当前渲染库未接入
 * （见 `report-render.util.ts`），因此本服务同步调用渲染入口并在失败时直接返回错误 ——
 * **不做 202 降级**：降级的前提是"有一个能跑但慢的渲染器"，没有渲染器时把错误包装成
 * "任务已受理"只会让前端轮询一个永远不会成功的任务。契约的超时降级分支留待接入渲染库后启用。
 *
 * ## 防付费内容外泄（契约规则 1，本接口最容易出事的地方）
 *
 * `QUOTE_CARD` 的金句来自报告正文，因此：
 *   ① 金句来源段必须通过 `quoteSectionKey` 显式指定（不允许"随便取一段"）；
 *   ② 该段的可见性由 `buildSectionViews`（**与详情/分段接口同一个函数**）判定，
 *      未解锁的段直接拒绝（`10001`，契约原文为 `60020`）；
 *   ③ 取金句时只能从 `visibility.content` 里取 —— 未解锁时该字段恒为 `null`，
 *      即使某天有人绕过 ① ② 的判断，也**没有正文可写进卡片**。
 *
 * ## 缓存
 *
 * 同一报告 + 同一模板 + 同参数 → 复用已有图（契约规则 2，TTL 30 天），
 * 除非 `forceRefresh = true`。指纹覆盖所有影响画面的参数（见 `shareCardFingerprint`）。
 */

import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { EntitlementService } from '../../membership/entitlement.service';
import { StorageService } from '../../storage/storage.service';
import { SystemConfigService } from '../../system/system-config.service';
import { ReportQuotaService } from './report-quota.service';
import {
  SHARE_CARD_CACHE_TTL_SECONDS,
  SHARE_CARD_CONTENT_TYPE,
  SHARE_CARD_HOURLY_LIMIT,
  SHARE_CARD_IDEMPOTENCY_TTL_SECONDS,
  SHARE_CARD_QUOTA_WINDOW,
  SHARE_CARD_VALID_DAYS,
  buildQrCodeScene,
  buildShareCardObjectKey,
  buildThumbUrl,
  maskDisplayName,
  resolveShareTemplate,
  shareCardFingerprint,
  shareVariablesOf,
  type ShareCardScene,
  type ShareCardState,
  type ShareCardTemplate,
  type ShareTemplates,
} from './report-share-card.util';
import {
  SHARE_CARD_COMPLIANCE_TEXT,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  generateMiniAppCode,
  renderShareCardImage,
} from './report-render.util';
import { buildSectionViews } from './report-visibility';

/** Redis 键前缀 */
const SHARE_CARD_CACHE_PREFIX = 'report:sharecard';
const SHARE_CARD_IDEMPOTENCY_PREFIX = 'report:sharecard:idem';

/** 小程序码重试事件类型（契约规则 6：写 `outbox_event` 重试） */
const QRCODE_RETRY_EVENT = 'share.qrcode.retry';

/** 分享卡生成入参（DTO 校验后的值） */
export interface ShareCardRequestInput {
  readonly userId: string;
  readonly reportId: string;
  readonly idempotencyKey: string;
  readonly template?: ShareCardTemplate;
  readonly quoteSectionKey?: string;
  readonly showQrCode?: boolean;
  readonly showNickname?: boolean;
  readonly scene?: ShareCardScene;
  readonly forceRefresh?: boolean;
}

/** 分享卡视图（契约 §3.5.9 成功响应 201） */
export interface ShareCardView {
  readonly shareCardId: string;
  readonly reportId: string;
  readonly template: ShareCardTemplate;
  readonly imageUrl: string;
  readonly thumbUrl: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly showQrCode: boolean;
  readonly qrCodeScene: string;
  readonly scene: ShareCardScene;
  readonly renderDurationMs: number;
  readonly expiresAt: string;
  readonly shareText: string;
  readonly shareTitle: string;
  readonly createdAt: string;
  /** 降级信息（如小程序码生成失败）；契约没有该字段，仅在需要时附加，便于前端提示 */
  readonly warnings?: readonly string[];
}

@Injectable()
export class ReportShareCardService {
  private readonly logger = new Logger(ReportShareCardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly entitlements: EntitlementService,
    private readonly quota: ReportQuotaService,
    private readonly systemConfigs: SystemConfigService,
  ) {}

  async generateShareCard(input: ShareCardRequestInput): Promise<ShareCardView> {
    const template: ShareCardTemplate = input.template ?? 'TYPE_CARD';
    const scene: ShareCardScene = input.scene ?? 'REPORT';
    const showQrCode = input.showQrCode ?? true;
    const showNickname = input.showNickname ?? true;
    const quoteSectionKey = input.quoteSectionKey ?? null;

    // ---- 条件必填：QUOTE_CARD 必须有金句来源段（契约错误 10002） ----
    if (template === 'QUOTE_CARD' && quoteSectionKey === null) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'template = QUOTE_CARD 时必须提供 quoteSectionKey', [
        { field: 'quoteSectionKey', issue: 'required' },
      ]);
    }

    const idempotencyRedisKey = this.idempotencyKeyOf(input.userId, input.idempotencyKey);
    const replayed = await this.loadCardByKey(idempotencyRedisKey, input.userId, input.reportId);
    if (replayed !== null) {
      this.logger.log(`分享卡幂等重放 shareCardId=${replayed.shareCardId}`);
      return this.toView(replayed);
    }

    // ---- 归属与状态（未生成完成的报告没有可分享的内容） ----
    await this.assertReportShareable(input.userId, input.reportId);

    const fingerprint = shareCardFingerprint({
      reportId: input.reportId,
      template,
      quoteSectionKey,
      showQrCode,
      showNickname,
      scene,
    });

    // ---- 缓存复用（契约规则 2）；forceRefresh 时跳过 ----
    if (input.forceRefresh !== true) {
      const cached = await this.loadCardByKey(this.cacheKeyOf(fingerprint), input.userId, input.reportId);
      if (cached !== null) {
        await this.redis.set(idempotencyRedisKey, cached.shareCardId, SHARE_CARD_IDEMPOTENCY_TTL_SECONDS);
        this.logger.log(`分享卡命中缓存 shareCardId=${cached.shareCardId}`);
        return this.toView(cached);
      }
    }

    // ---- 金句来源校验（**必须在渲染之前**：付费段落一次都不能被渲染进去） ----
    const quote =
      template === 'QUOTE_CARD' ? await this.loadQuote(input.userId, input.reportId, quoteSectionKey) : null;

    // ---- 配额（10 次/60min），失败时归还 ----
    await this.quota.consumeWindowQuota({
      scope: 'share-card',
      userId: input.userId,
      subject: input.reportId,
      limit: SHARE_CARD_HOURLY_LIMIT,
      window: SHARE_CARD_QUOTA_WINDOW,
      message: `1 小时内生成分享图次数已达上限（${SHARE_CARD_HOURLY_LIMIT} 次），请稍后再试`,
    });

    const renderStartedAt = Date.now();
    const shareCardId = uuidv7();
    const warnings: string[] = [];
    const qrCodeScene = buildQrCodeScene(input.reportId);

    try {
      const data = await this.loadCardData(input.userId, input.reportId, scene);

      // ---- 小程序码（失败降级，契约规则 6） ----
      let qrCodeImage: Buffer | null = null;
      let effectiveShowQrCode = showQrCode;
      if (showQrCode) {
        qrCodeImage = await generateMiniAppCode({ scene: qrCodeScene, pagePath: await this.sharePath() });
        if (qrCodeImage === null) {
          warnings.push('小程序码生成失败，本次分享图不含小程序码');
          effectiveShowQrCode = false;
          await this.enqueueQrCodeRetry(input.userId, input.reportId, qrCodeScene, fingerprint);
        }
      }

      const artifact = await renderShareCardImage({
        reportId: input.reportId,
        template,
        mbtiType: data.mbtiType,
        mbtiTypeName: data.mbtiTypeName,
        // showNickname=false 时**在这一步就替换为脱敏文案**：渲染实现拿到的是最终要画的文本，
        // 不存在"渲染时忘了脱敏"的可能
        displayName: showNickname
          ? maskDisplayName(data.nickname, data.mbtiType)
          : maskDisplayName(null, data.mbtiType),
        quote,
        dimensions: data.dimensions,
        bigFive: data.bigFive,
        qrCodeImage,
        complianceText: SHARE_CARD_COMPLIANCE_TEXT,
      });

      const objectKey = buildShareCardObjectKey(input.userId, input.reportId, template, shareCardId.slice(0, 8));
      await this.storage.uploadServerObject({
        objectKey,
        body: artifact.body,
        contentType: artifact.contentType ?? SHARE_CARD_CONTENT_TYPE,
      });

      // 分享图要能被小程序直接引用 → 置为公开可读；失败则退化为签名 URL（仍可分享，只是带签名参数）
      const isPublic = await this.storage.makeServerObjectPublic(objectKey);
      const imageUrl = isPublic
        ? this.storage.publicUrlOf(objectKey)
        : this.storage.signServerObjectUrl(objectKey, SHARE_CARD_CACHE_TTL_SECONDS).url;
      if (!isPublic) {
        warnings.push('分享图已生成，但公开访问地址配置失败，当前返回临时地址');
      }

      const createdAt = new Date();
      const card: ShareCardState = {
        shareCardId,
        reportId: input.reportId,
        userId: input.userId,
        template,
        fingerprint,
        scene,
        showQrCode: effectiveShowQrCode,
        showNickname,
        quoteSectionKey,
        objectKey,
        imageUrl,
        thumbUrl: buildThumbUrl(imageUrl),
        width: artifact.width ?? SHARE_CARD_WIDTH,
        height: artifact.height ?? SHARE_CARD_HEIGHT,
        sizeBytes: artifact.sizeBytes,
        qrCodeScene,
        shareText: data.shareText,
        shareTitle: data.shareTitle,
        renderDurationMs: Date.now() - renderStartedAt,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + SHARE_CARD_VALID_DAYS * 24 * 3600 * 1000).toISOString(),
        warnings,
      };

      await this.saveCard(card);
      await this.redis.set(this.cacheKeyOf(fingerprint), card.shareCardId, SHARE_CARD_CACHE_TTL_SECONDS);
      await this.redis.set(idempotencyRedisKey, card.shareCardId, SHARE_CARD_IDEMPOTENCY_TTL_SECONDS);

      this.logger.log(
        `分享卡生成完成 shareCardId=${shareCardId} template=${template} renderMs=${card.renderDurationMs} showQr=${String(effectiveShowQrCode)}`,
      );

      return this.toView(card);
    } catch (error) {
      // 失败即归还配额：用户没拿到图就不该被扣次数
      await this.quota.refundWindowQuota({
        scope: 'share-card',
        userId: input.userId,
        subject: input.reportId,
        window: SHARE_CARD_QUOTA_WINDOW,
      });

      this.logger.error(`分享卡生成失败 reportId=${input.reportId}: ${(error as Error).message}`);
      throw error;
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 归属 + 状态校验 */
  private async assertReportShareable(userId: string, reportId: string): Promise<void> {
    const report = await this.prisma.aiReport.findFirst({
      where: { id: reportId, userId, deletedAt: null },
      select: { status: true },
    });

    if (report === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    if (report.status === 'QUEUED' || report.status === 'GENERATING') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATING, '报告正在生成中，请稍后再生成分享图');
    }

    if (report.status !== 'SUCCEEDED') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATION_FAILED, '报告生成失败，无法生成分享图');
    }
  }

  /**
   * 读取金句并校验其来源段**可读**
   *
   * 拒绝条件（任一）：
   *   · 该 `sectionKey` 在报告里不存在 → 参数错误（不是"内容不存在"，避免暴露报告结构）；
   *   · 该段未通过可见性判定（未解锁）→ 参数错误，契约原文 `60020`。
   *
   * 本项目 `error-code.ts` 的 `60020` 未定义（600 段是关系匹配域），
   * 因此用 `10001 PARAM_INVALID`（同样 HTTP 400）承接该语义，已在交付报告中标注。
   */
  private async loadQuote(userId: string, reportId: string, quoteSectionKey: string | null): Promise<string | null> {
    if (quoteSectionKey === null) return null;

    const [rows, unlock] = await Promise.all([
      this.prisma.reportSection.findMany({
        where: { reportId },
        orderBy: { order: 'asc' },
        select: { sectionKey: true, title: true, content: true, order: true, isFreePreview: true },
      }),
      this.entitlements.resolveReportUnlock(userId, reportId),
    ]);

    const visibility = buildSectionViews(rows, {
      allUnlocked: unlock.allUnlocked,
      unlockedSectionKeys: unlock.unlockedSectionKeys,
    }).find((section) => section.sectionKey === quoteSectionKey);

    if (visibility === undefined) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'quoteSectionKey 指向的段落不存在', [
        { field: 'quoteSectionKey', issue: 'not_found' },
      ]);
    }

    // `content === null` 即"未解锁"（类型层面保证），此时**没有任何正文可用于金句**
    if (visibility.content === null) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        '该段落为付费内容，不能用于分享卡片，请改选免费预览段落',
        [{ field: 'quoteSectionKey', issue: 'locked' }],
      );
    }

    const trimmed = visibility.content.trim();

    return trimmed.length === 0 ? null : trimmed.slice(0, 120);
  }

  /** 读取卡片渲染素材 */
  private async loadCardData(
    userId: string,
    reportId: string,
    scene: ShareCardScene,
  ): Promise<{
    nickname: string | null;
    mbtiType: string | null;
    mbtiTypeName: string | null;
    dimensions: { EI: number | null; SN: number | null; TF: number | null; JP: number | null } | null;
    bigFive: {
      openness: number | null;
      conscientiousness: number | null;
      extraversion: number | null;
      agreeableness: number | null;
      neuroticism: number | null;
    } | null;
    shareText: string;
    shareTitle: string;
  }> {
    const [report, user] = await Promise.all([
      this.prisma.aiReport.findFirst({
        where: { id: reportId, userId, deletedAt: null },
        select: {
          profile: {
            select: {
              mbtiType: true,
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
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true } }),
    ]);

    if (report === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    const mbtiType = report.profile?.mbtiType ?? null;
    const nickname = user?.nickname ?? null;
    const variables = shareVariablesOf(mbtiType, nickname);
    const templates = await this.loadShareTemplates();

    // 场景文案：本接口的 `scene` 同时也是分享归因场景；契约规则 4 要求文案来自
    // `system_config.shareTemplates`，因此按场景键取模板，缺失时回落到 DEFAULT
    const resolved = resolveShareTemplate(templates, scene, variables);

    return {
      nickname,
      mbtiType,
      mbtiTypeName: variables.typeName ?? null,
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
      shareText: resolved.text,
      shareTitle: resolved.title,
    };
  }

  /** 分享文案模板（来自 `system_configs`，读不到时用目录里的默认模板兜底） */
  private async loadShareTemplates(): Promise<ShareTemplates> {
    try {
      const entry = await this.systemConfigs.getEntry('share.templates');
      if (entry !== undefined && entry.value !== null && typeof entry.value === 'object') {
        return entry.value as ShareTemplates;
      }
    } catch (error) {
      this.logger.warn(`读取分享文案模板失败，使用默认文案: ${(error as Error).message}`);
    }

    return {};
  }

  /** 分享落地页路径（同样来自配置，不硬编码；读不到时用配置目录里的默认值） */
  private async sharePath(): Promise<string> {
    try {
      const entry = await this.systemConfigs.getEntry('share.path');
      if (entry !== undefined && typeof entry.value === 'string' && entry.value.length > 0) {
        return entry.value;
      }
    } catch (error) {
      this.logger.warn(`读取分享落地页路径失败: ${(error as Error).message}`);
    }

    return '/pages/index/index';
  }

  /** 写小程序码重试事件（`outbox_event` 唯一约束保证同一张卡片只留一条待重试记录） */
  private async enqueueQrCodeRetry(
    userId: string,
    reportId: string,
    qrCodeScene: string,
    fingerprint: string,
  ): Promise<void> {
    try {
      await this.prisma.outboxEvent.create({
        data: {
          eventType: QRCODE_RETRY_EVENT,
          aggregateType: 'AiReport',
          aggregateId: reportId,
          payload: { userId, reportId, scene: qrCodeScene, cardFingerprint: fingerprint },
          idempotencyKey: `${QRCODE_RETRY_EVENT}:${reportId}:${this.crypto.sha256(fingerprint).slice(0, 16)}`,
        },
      });
    } catch (error) {
      // 唯一约束冲突=已有待重试记录，属正常；其它错误只记日志（不阻断分享）
      this.logger.warn(`写入小程序码重试事件失败 reportId=${reportId}: ${(error as Error).message}`);
    }
  }

  private async saveCard(card: ShareCardState): Promise<void> {
    await this.redis.setJson(this.cardKeyOf(card.shareCardId), card, SHARE_CARD_CACHE_TTL_SECONDS);
  }

  private async loadCardByKey(key: string, userId: string, reportId: string): Promise<ShareCardState | null> {
    const cardId = await this.redis.get(key);
    if (cardId === null || cardId.length === 0) return null;

    const card = await this.redis.getJson<ShareCardState>(this.cardKeyOf(cardId));
    if (card === null || card.userId !== userId || card.reportId !== reportId) {
      await this.redis.del(key);
      return null;
    }

    return card;
  }

  private toView(card: ShareCardState): ShareCardView {
    return {
      shareCardId: card.shareCardId,
      reportId: card.reportId,
      template: card.template,
      imageUrl: card.imageUrl,
      thumbUrl: card.thumbUrl,
      width: card.width,
      height: card.height,
      sizeBytes: card.sizeBytes,
      showQrCode: card.showQrCode,
      qrCodeScene: card.qrCodeScene,
      scene: card.scene,
      renderDurationMs: card.renderDurationMs,
      expiresAt: card.expiresAt,
      shareText: card.shareText,
      shareTitle: card.shareTitle,
      createdAt: card.createdAt,
      ...(card.warnings.length > 0 ? { warnings: card.warnings } : {}),
    };
  }

  private cardKeyOf(shareCardId: string): string {
    return this.redis.key(SHARE_CARD_CACHE_PREFIX, 'card', shareCardId);
  }

  private cacheKeyOf(fingerprint: string): string {
    return this.redis.key(SHARE_CARD_CACHE_PREFIX, 'fp', this.crypto.sha256(fingerprint).slice(0, 32));
  }

  private idempotencyKeyOf(userId: string, idempotencyKey: string): string {
    return this.redis.key(SHARE_CARD_IDEMPOTENCY_PREFIX, userId, this.crypto.sha256(idempotencyKey));
  }
}
