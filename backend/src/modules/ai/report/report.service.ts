/**
 * 报告服务（契约 §3.5）
 *
 * 三条职责：
 *   · **创建**：解析请求 → 绑定画像 → 计算 `cacheKey` → 命中则复用，否则落库并入队
 *   · **进度**：轮询接口返回 status/progress/stage
 *   · **详情**：读取分段后**按段裁剪**（未解锁段落不下发正文，见 `report-visibility.ts`）
 *
 * `cacheKey` 是唯一的幂等点：同一份画像 + 同一 Prompt 版本 + 同一模型产出的报告必然相同，
 * 因此重复请求直接复用既有报告 —— 用户不会为同一内容付两次费，队列重试也不会重复生成。
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QUEUE_AI_REPORT } from '../../../infra/queue/queue.module';
import {
  ATTACHMENT_THRESHOLD_CONFIG_KEYS,
  DEFAULT_ATTACHMENT_THRESHOLD,
  parseAttachmentThreshold,
} from '../../emotion/attachment-threshold.util';
import { PromptService } from '../prompt/prompt.service';
import type { SectionVisibility, VisibilitySummary } from './report-visibility';
import { assertHasReadableSection, buildSectionViews, summarizeVisibility } from './report-visibility';
import {
  buildEmotionProfileSnapshot,
  buildPersonalityProfileSnapshot,
  type AttachmentThresholdView,
  type EmotionSnapshotSource,
  type PersonalitySnapshotSource,
  type ReportProfileSnapshotView,
} from './report-profile-snapshot.util';
import {
  ACTIVE_REPORT_STATUSES,
  DEFAULT_PAGE_SIZE,
  GROWTH_MAX_PROFILES,
  GROWTH_MIN_PROFILES,
  buildListSummary,
  buildPreviewText,
  computeFreePreviewRatio,
  computeGenerationDurationMs,
  friendlyFailureReason,
  planPinnedPagination,
  reportTypeName,
  type ReportListSummary,
  type ReportSortField,
  type ReportSortOrder,
  type ReportStatusFilter,
} from './report-list.util';

/** 报告类型 → 默认 Prompt 模板键（模板入库后可由后台调整版本，但键名稳定） */
const TEMPLATE_KEY_BY_TYPE: Readonly<Record<string, string>> = {
  MBTI_REPORT: 'report.mbti',
  BIG_FIVE_REPORT: 'report.bigfive',
  RELATIONSHIP_REPORT: 'report.relationship',
  GROWTH_SUMMARY: 'report.growth',
  // 情感报告走**自己的**组装器与模板（ADR-038）：人格报告不掺情感结论，
  // 情感报告也不掺人格结论 —— 两条路径刻意不共用上下文
  EMOTION_REPORT: 'report.emotion',
};

/** 创建请求 */
export interface CreateReportInput {
  readonly userId: string;
  readonly type: 'MBTI_REPORT' | 'BIG_FIVE_REPORT' | 'RELATIONSHIP_REPORT' | 'GROWTH_SUMMARY' | 'EMOTION_REPORT';
  /** 指定测评会话；不传则取该用户最新一次已算分的会话 */
  readonly sessionId?: string;
  /** 关系报告必填：上下文来自这段关系（契约 §3.6.9） */
  readonly relationshipId?: string;
}

/** 创建结果 */
export interface ReportCreatedView {
  readonly reportId: string;
  readonly status: string;
  readonly isReused: boolean;
  readonly pollUrl: string;
}

/** 进度视图 */
export interface ReportProgressView {
  readonly reportId: string;
  readonly status: string;
  readonly progress: number;
  readonly errorCode: number | null;
  readonly errorMessage: string | null;
  readonly requestedAt: string;
  readonly finishedAt: string | null;
}

/** 详情视图（含裁剪后的分段） */
export interface ReportDetailView {
  readonly reportId: string;
  readonly type: string;
  readonly typeName: string;
  readonly status: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly sectionCount: number;
  readonly sections: readonly SectionVisibility[];
  readonly visibility: VisibilitySummary;
  /**
   * 以下四个字段与**列表项**保持一致
   *
   * 详情页头部要展示「INFJ · deepseek-chat」，分享标题也要用 MBTI；
   * 列表接口早就返回了它们，详情却没有 —— 前端只能要么再查一次列表，
   * 要么把 MBTI 硬编码。同一份数据在两个接口里不一致是接口设计缺陷，
   * 不是前端的问题。
   */
  readonly mbtiType: string | null;
  readonly engineVersion: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /**
   * 生成这份报告时用的**画像数值**（详情页画条形图用；无画像时为 `null`）
   *
   * ⚠ 它**不参与付费墙判定**：这里放的是"你的画像"（用户自己在结果页已经看过的
   * 那些数字），不是"报告写了什么"。真正被锁的始终是段落正文。
   * 类型与边界见 `report-profile-snapshot.util.ts`。
   */
  readonly profileSnapshot: ReportProfileSnapshotView | null;
}

/** 列表解锁上下文（由 `EntitlementService` 提供） */
export interface ReportUnlockContextInput {
  readonly isUnlocked: (reportId: string) => boolean;
  readonly countUnlocked: (reportIds: readonly string[]) => number;
}

/** 列表查询入参（已由 DTO 校验过白名单，此处不再重复判断） */
export interface ListReportsInput {
  readonly userId: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly type?: readonly string[];
  readonly status?: readonly ReportStatusFilter[];
  readonly sortBy?: ReportSortField;
  readonly order?: ReportSortOrder;
  /**
   * 解锁上下文
   *
   * 由调用方注入而不是在本服务内查权益：`ai/report` 不该知道"会员怎么算"，
   * 且列表页需要的是**一批**报告的解锁判定，交给权益侧一次算完更省往返。
   * 缺省时按"全部未解锁"处理 —— 保守方向，宁可少给内容也不能白送。
   */
  readonly unlockContext?: ReportUnlockContextInput;
}

/** 列表项（契约 §3.5.2） */
export interface ReportListItemView {
  readonly reportId: string;
  readonly type: string;
  readonly typeName: string;
  readonly title: string | null;
  readonly status: string;
  /** 该报告绑定画像的 MBTI（无画像时为 null） */
  readonly mbtiType: string | null;
  readonly engineVersion: string | null;
  /** 正文字数（契约字段名 `wordCount`，中文语境下即字符数） */
  readonly wordCount: number;
  readonly sectionCount: number;
  readonly freePreviewRatio: number;
  readonly isUnlocked: boolean;
  readonly unlockType: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly totalTokens: number;
  readonly generationDurationMs: number;
  readonly createdAt: string;
  readonly generatedAt: string | null;
  readonly previewText: string | null;
  readonly hasPdf: boolean;
  readonly shareCardUrl: string | null;
  /** 仅失败的报告返回，且为**友好文案**（不含上游错误原文） */
  readonly failureReason?: string;
}

/** 列表响应（契约 §3.5.2） */
export interface ReportListView {
  readonly items: readonly ReportListItemView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly summary: ReportListSummary;
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly prompts: PromptService,
    @InjectQueue(QUEUE_AI_REPORT) private readonly reportQueue: Queue,
  ) {}

  /**
   * 创建报告（契约 §3.5.1）
   *
   * 顺序：定位画像 → 渲染 Prompt（据此确定模板版本与模型）→ 计算 cacheKey
   * → 命中成功报告则直接复用 → 否则落库并入队。
   */
  async createReport(input: CreateReportInput): Promise<ReportCreatedView> {
    const templateKey = TEMPLATE_KEY_BY_TYPE[input.type];
    if (templateKey === undefined) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '不支持的报告类型');
    }

    // 关系报告走**另一条取数路径**：它的上下文是"关系双方画像 + 算分报告"，
    // 不挂单一画像。因此 `profileId` 为 null、`relationshipId` 必填
    if (input.type === 'RELATIONSHIP_REPORT') {
      return this.createRelationshipReport(input, templateKey);
    }

    /**
     * 情感报告挂**情感画像**，人格类报告挂人格画像（ADR-038）
     *
     * 两条取数路径刻意分开：`ai_reports.profile_id` 是外键指向
     * `personality_profiles`，拿它指向情感画像在数据库层就做不到；
     * 而"读哪张画像表"这件事一旦写成条件，漏看一处就是静默取错数据。
     */
    if (input.type === 'EMOTION_REPORT') {
      return this.createEmotionReport(input, templateKey);
    }

    const profile = await this.prisma.personalityProfile.findFirst({
      where: { userId: input.userId, deletedAt: null, isCurrent: true },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, engineVersion: true },
    });

    if (profile === null) {
      // 没有画像就无法生成报告：引导用户先完成测评（而不是抛一个含糊的系统错误）
      throw new BusinessException(ErrorCode.PERSONALITY_PROFILE_NOT_FOUND, '请先完成一次人格测评，再生成报告');
    }

    // 只取模板版本与模型元信息（不渲染，因此无需变量）—— 二者都是 cacheKey 的组成部分
    const meta = await this.prompts.getTemplateMeta(templateKey);

    /**
     * 成长回顾报告的上下文是**画像版本序列**，不是单份画像
     *
     * 取一次序列有两个用途：① 校验"至少两版" —— 一版没有"变化"可言，
     * 契约给的下限也是 2，与其让模型对着一版画像编出成长轨迹，不如明确报错；
     * ② 把**整个序列**纳入 `cacheKey` —— 只哈希锚定画像的话，两个不同的序列
     * 会算出同一个 key，于是"输入变了却复用旧报告"，幂等复用反而变成错误复用。
     */
    const growthSequenceIds =
      input.type === 'GROWTH_SUMMARY' ? await this.loadGrowthSequenceIds(input.userId, profile.version) : null;

    if (growthSequenceIds !== null && growthSequenceIds.length < GROWTH_MIN_PROFILES) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `成长回顾报告需要至少 ${GROWTH_MIN_PROFILES} 次测评记录，当前只有 ${growthSequenceIds.length} 次`,
      );
    }

    const cacheKey = this.crypto.sha256(
      [
        input.userId,
        // 非成长报告的分段**逐字保持不变**：改动它会让已存在报告的 cacheKey 全部失效，
        // 那些用户会凭空多出一份"新"报告（并且要再扣一次配额）
        ...(growthSequenceIds === null
          ? [profile.id, String(profile.version)]
          : [`growth:${growthSequenceIds.join(',')}`]),
        templateKey,
        meta.versionId,
        meta.provider ?? '',
        meta.model ?? '',
      ].join('|'),
    );

    const existing = await this.prisma.aiReport.findUnique({
      where: { cacheKey },
      select: { id: true, status: true },
    });

    if (existing !== null && existing.status === 'SUCCEEDED') {
      this.logger.log(`报告缓存命中，直接复用 reportId=${existing.id}`);
      return {
        reportId: existing.id,
        status: existing.status,
        isReused: true,
        pollUrl: `/api/v1/reports/${existing.id}/progress`,
      };
    }

    const report =
      existing === null
        ? await this.prisma.aiReport.create({
            data: {
              userId: input.userId,
              type: input.type,
              status: 'QUEUED',
              profileId: profile.id,
              sessionId: input.sessionId ?? null,
              promptTemplateKey: templateKey,
              promptVersionId: meta.versionId,
              cacheKey,
            },
            select: { id: true },
          })
        : await this.prisma.aiReport.update({
            where: { cacheKey },
            // 失败的报告允许重试：重置状态而不是新建一条（cacheKey 唯一）
            data: { status: 'QUEUED', progress: 0, errorCode: null, errorMessage: null },
            select: { id: true },
          });

    await this.enqueueGeneration(report.id);

    this.logger.log(`报告已创建并入队 reportId=${report.id} type=${input.type}`);

    return {
      reportId: report.id,
      status: 'QUEUED',
      isReused: false,
      pollUrl: `/api/v1/reports/${report.id}/progress`,
    };
  }

  /**
   * 成长回顾报告的画像序列（锚定版本及其之前的最近 N 版，按版本升序）
   *
   * `ai_reports` 只存得下**一个** `profileId`（没有版本列表列），因此序列由锚定画像
   * **确定性推导**而不是存下来：历史画像行不可变，锚定版本号又是固定上界，
   * 所以创建时算 `cacheKey` 用的序列与生成时喂给模型的序列必然一致 ——
   * 两边都调用本方法的同一套条件，不另写一份查询。
   */
  private async loadGrowthSequenceIds(userId: string, anchorVersion: number): Promise<string[]> {
    const rows = await this.prisma.personalityProfile.findMany({
      where: { userId, deletedAt: null, version: { lte: anchorVersion } },
      // 先按降序取"最近的 N 版"，再反转成升序
      orderBy: { version: 'desc' },
      take: GROWTH_MAX_PROFILES,
      select: { id: true },
    });

    return rows.map((row) => row.id).reverse();
  }

  /**
   * 创建关系（匹配）解读报告（契约 §3.6.9）
   *
   * 与个人报告的三处差异：
   *   ① **不挂画像**（`profileId` 为 null），改挂 `relationshipId`；生成时由
   *      `prepareForRelationship` 读取双方画像 + 算分报告
   *   ② `cacheKey` 用**算分报告 ID** 而不是画像 ID：算分报告本身已经由
   *      「双方画像版本 + 权重版本 + 引擎版本」决定（见 `buildCompatibilityCacheKey`），
   *      复用它就自动获得了同样的确定性，不必再拼一遍
   *   ③ 必须有**已成功的算分报告**：没有分数就没有可解读的内容，
   *      此时退化成让 AI 自己编一个分数会违反 ADR-005
   */
  private async createRelationshipReport(input: CreateReportInput, templateKey: string): Promise<ReportCreatedView> {
    const relationshipId = input.relationshipId;
    if (relationshipId === undefined) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '关系报告必须提供 relationshipId');
    }

    const relationship = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, deletedAt: null, OR: [{ userAId: input.userId }, { userBId: input.userId }] },
      select: { id: true, status: true },
    });

    if (relationship === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    if (relationship.status !== 'ACTIVE') {
      throw new BusinessException(ErrorCode.RELATIONSHIP_STATUS_INVALID, '关系尚未生效，无法生成匹配解读');
    }

    const compatibility = await this.prisma.compatibilityReport.findFirst({
      where: { relationshipId, status: 'SUCCEEDED', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (compatibility === null) {
      throw new BusinessException(ErrorCode.COMPATIBILITY_PEER_NOT_READY, '匹配算分尚未完成，无法生成解读');
    }

    const meta = await this.prompts.getTemplateMeta(templateKey);

    const cacheKey = this.crypto.sha256(
      [
        input.userId,
        `compat:${compatibility.id}`,
        templateKey,
        meta.versionId,
        meta.provider ?? '',
        meta.model ?? '',
      ].join('|'),
    );

    const existing = await this.prisma.aiReport.findUnique({
      where: { cacheKey },
      select: { id: true, status: true },
    });

    if (existing !== null && existing.status === 'SUCCEEDED') {
      this.logger.log(`关系报告缓存命中，直接复用 reportId=${existing.id}`);
      return {
        reportId: existing.id,
        status: existing.status,
        isReused: true,
        pollUrl: `/api/v1/reports/${existing.id}/progress`,
      };
    }

    const report =
      existing === null
        ? await this.prisma.aiReport.create({
            data: {
              userId: input.userId,
              type: 'RELATIONSHIP_REPORT',
              status: 'QUEUED',
              profileId: null,
              relationshipId,
              promptTemplateKey: templateKey,
              promptVersionId: meta.versionId,
              cacheKey,
            },
            select: { id: true },
          })
        : await this.prisma.aiReport.update({
            where: { cacheKey },
            data: { status: 'QUEUED', progress: 0, errorCode: null, errorMessage: null },
            select: { id: true },
          });

    await this.enqueueGeneration(report.id);

    // 反向关联：`CompatibilityReport.aiReportId` 让匹配报告能直接找到自己的解读，
    // 生成完成后 `ReportGenerationService` 正是凭这个关系回写三个 JsonB 列
    await this.prisma.compatibilityReport.update({
      where: { id: compatibility.id },
      data: { aiReportId: report.id },
    });

    this.logger.log(`关系报告已创建并入队 reportId=${report.id} compatibilityReportId=${compatibility.id}`);

    return {
      reportId: report.id,
      status: 'QUEUED',
      isReused: false,
      pollUrl: `/api/v1/reports/${report.id}/progress`,
    };
  }

  /**
   * 创建情感测评报告（ADR-038 阶段 3）
   *
   * 与人格报告的差异集中在"挂哪份画像"：
   *   · 取 `emotion_profiles` 的当前版本，写 `emotionProfileId`（**不是** `profileId`，
   *     后者是外键指向 `personality_profiles`）；
   *   · `cacheKey` 里用情感画像自己的 id+version，与人格报告完全隔离 ——
   *     两份画像各有各的幂等空间，互不影响；
   *   · 没有情感画像时明确引导"先做情感测评"，而不是抛一个含糊的系统错误
   *     （错误码用**情感模块自己的** `40014`，前端据此跳不同的引导页）。
   */
  private async createEmotionReport(input: CreateReportInput, templateKey: string): Promise<ReportCreatedView> {
    const profile = await this.prisma.emotionProfile.findFirst({
      where: { userId: input.userId, deletedAt: null, isCurrent: true },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    });

    if (profile === null) {
      throw new BusinessException(ErrorCode.EMOTION_PROFILE_NOT_FOUND, '请先完成一次情感测评，再生成报告');
    }

    const meta = await this.prompts.getTemplateMeta(templateKey);

    const cacheKey = this.crypto.sha256(
      [
        input.userId,
        // 前缀 `emotion:` 让这份 key 与人格报告（裸 profileId）在**字面上**就是不同空间，
        // 即使将来两者的 UUID 恰好撞车也不会互相复用
        `emotion:${profile.id}`,
        String(profile.version),
        templateKey,
        meta.versionId,
        meta.provider ?? '',
        meta.model ?? '',
      ].join('|'),
    );

    const existing = await this.prisma.aiReport.findUnique({
      where: { cacheKey },
      select: { id: true, status: true },
    });

    if (existing !== null && existing.status === 'SUCCEEDED') {
      this.logger.log(`情感报告缓存命中，直接复用 reportId=${existing.id}`);
      return {
        reportId: existing.id,
        status: existing.status,
        isReused: true,
        pollUrl: `/api/v1/reports/${existing.id}/progress`,
      };
    }

    const report =
      existing === null
        ? await this.prisma.aiReport.create({
            data: {
              userId: input.userId,
              type: 'EMOTION_REPORT',
              status: 'QUEUED',
              // ⚠ 人格画像列为 null：这份报告与人格画像无关
              profileId: null,
              emotionProfileId: profile.id,
              sessionId: input.sessionId ?? null,
              promptTemplateKey: templateKey,
              promptVersionId: meta.versionId,
              cacheKey,
            },
            select: { id: true },
          })
        : await this.prisma.aiReport.update({
            where: { cacheKey },
            data: { status: 'QUEUED', progress: 0, errorCode: null, errorMessage: null },
            select: { id: true },
          });

    await this.enqueueGeneration(report.id);

    this.logger.log(`情感报告已创建并入队 reportId=${report.id} emotionProfileId=${profile.id}`);

    return {
      reportId: report.id,
      status: 'QUEUED',
      isReused: false,
      pollUrl: `/api/v1/reports/${report.id}/progress`,
    };
  }

  /** 入队并把入队失败落库为 FAILED（`jobId = reportId` 天然去重） */
  private async enqueueGeneration(reportId: string): Promise<void> {
    try {
      await this.reportQueue.add('generate', { reportId }, { jobId: reportId });
    } catch (error) {
      this.logger.error(`报告入队失败 reportId=${reportId}: ${(error as Error).message}`);
      await this.prisma.aiReport
        .update({
          where: { id: reportId },
          data: { status: 'FAILED', errorCode: String(ErrorCode.QUEUE_ERROR), errorMessage: '入队失败' },
        })
        .catch(() => undefined);
      throw new BusinessException(ErrorCode.QUEUE_ERROR, '报告服务暂时不可用，请稍后重试');
    }
  }

  /** 查询生成进度（契约 §3.5.5） */
  async getProgress(userId: string, reportId: string): Promise<ReportProgressView> {
    const report = await this.prisma.aiReport.findFirst({
      where: { id: reportId, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        progress: true,
        errorCode: true,
        errorMessage: true,
        createdAt: true,
        generationFinishedAt: true,
      },
    });

    if (report === null) {
      // 「不存在」与「不属于你」同码：区分两者等于确认该 id 存在
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    return {
      reportId: report.id,
      status: report.status,
      progress: report.progress,
      errorCode: report.errorCode === null ? null : Number(report.errorCode),
      errorMessage: report.errorMessage,
      requestedAt: report.createdAt.toISOString(),
      finishedAt: report.generationFinishedAt?.toISOString() ?? null,
    };
  }

  /**
   * 报告详情（契约 §3.5.3：**服务端裁剪免费预览**）
   *
   * 未解锁段落**不下发正文**（见 `report-visibility.ts`）——
   * 这是付费墙能否成立的关键：抓包看到的响应里不能有付费内容。
   */
  async getDetail(
    userId: string,
    reportId: string,
    options: { allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> },
  ): Promise<ReportDetailView> {
    const report = await this.prisma.aiReport.findFirst({
      where: { id: reportId, userId, deletedAt: null },
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        summary: true,
        sectionCount: true,
        provider: true,
        model: true,
        createdAt: true,
        generationFinishedAt: true,
        profile: {
          select: {
            mbtiType: true,
            engineVersion: true,
            // 详情页画"四维倾向 + 大五"要用的全部数值
            mbtiConfidence: true,
            eiPercent: true,
            snPercent: true,
            tfPercent: true,
            jpPercent: true,
            openness: true,
            conscientiousness: true,
            extraversion: true,
            agreeableness: true,
            neuroticism: true,
            consistencyScore: true,
          },
        },
        emotionProfile: {
          select: {
            attachmentStyle: true,
            attachmentAnxiety: true,
            attachmentAvoidance: true,
            loveLanguageScores: true,
            primaryLoveLanguages: true,
            conflictStyle: true,
            conflictScores: true,
            completionRate: true,
            consistencyScore: true,
          },
        },
      },
    });

    if (report === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    if (report.status === 'QUEUED' || report.status === 'GENERATING') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATING, '报告正在生成中，请稍候');
    }

    if (report.status !== 'SUCCEEDED') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATION_FAILED, '报告生成失败，请尝试重新生成');
    }

    const sectionRows = await this.prisma.reportSection.findMany({
      where: { reportId },
      orderBy: { order: 'asc' },
      select: {
        sectionKey: true,
        title: true,
        content: true,
        order: true,
        isFreePreview: true,
      },
    });

    const sections = buildSectionViews(sectionRows, options);
    const visibility = summarizeVisibility(sections);

    // 一段都不可读属配置事故：显式失败，不下发空壳报告
    assertHasReadableSection(visibility);

    const profileSnapshot = await this.buildProfileSnapshot(report);

    return {
      reportId: report.id,
      type: report.type,
      typeName: reportTypeName(report.type),
      status: report.status,
      title: report.title,
      summary: report.summary,
      sectionCount: report.sectionCount,
      sections,
      visibility,
      mbtiType: report.profile?.mbtiType ?? null,
      engineVersion: report.profile?.engineVersion ?? null,
      provider: report.provider,
      model: report.model,
      createdAt: report.createdAt.toISOString(),
      finishedAt: report.generationFinishedAt?.toISOString() ?? null,
      profileSnapshot,
    };
  }

  /**
   * 组装详情页要用的画像快照
   *
   * 三条设计取舍：
   *
   * ① **按挂载的画像取，不按用户取当前画像**：报告是"某一份画像的产物"，
   *    用户后来又测了一次、画像换了版本之后，这份报告仍应展示**当初那份**数值
   *    （否则报告正文写着"焦虑 52"，页面上的条形图却是新画像的 71）。
   *    报告的 `emotionProfileId` / `profileId` 就是为此存在的。
   * ② **报告类型决定取哪一份**：`EMOTION_REPORT` 读情感画像，人格类报告读人格画像。
   *    两者都为空时返回 `null`，由前端降级（关系/成长报告本来就没有单一画像）。
   * ③ **阈值读不到就用兜底**：`system_configs` 缺那两行时回落 50/50，
   *    与引擎的口径一致（引擎同样以 50 为默认切分）。
   */
  private async buildProfileSnapshot(report: {
    type: string;
    profile: PersonalitySnapshotSource | null;
    emotionProfile: EmotionSnapshotSource | null;
  }): Promise<ReportProfileSnapshotView | null> {
    if (report.type === 'EMOTION_REPORT') {
      if (report.emotionProfile === null) return null;

      const thresholds = await this.loadAttachmentThreshold();

      return buildEmotionProfileSnapshot(report.emotionProfile, thresholds);
    }

    if (report.profile === null) return null;

    return buildPersonalityProfileSnapshot(report.profile);
  }

  /**
   * 依恋两轴阈值（系统配置）
   *
   * 解析与校验在 `attachment-threshold.util.ts`（与测评模块共用同一份规则），
   * 这里只负责查配置表；读不到就用兜底值 —— 一个可选的产品口径配置缺失，
   * 不该让报告详情打不开。
   */
  private async loadAttachmentThreshold(): Promise<AttachmentThresholdView> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: [...ATTACHMENT_THRESHOLD_CONFIG_KEYS] }, deletedAt: null },
      select: { key: true, value: true },
    });

    return parseAttachmentThreshold(rows) ?? DEFAULT_ATTACHMENT_THRESHOLD;
  }

  /**
   * 报告列表（契约 §3.5.2）
   *
   * 三处不显眼但有后果的处理：
   *
   * ① **进行中的报告置顶，且参与分页计算**。只在当前页内重排的话，一条在第 2 页的
   *    进行中报告永远不会浮到第 1 页，而"让用户立刻看到正在生成的任务"正是这条规则
   *    的目的。因此构造 `[进行中..., 其余...]` 的虚拟列表再落回两次查询
   *    （`planPinnedPagination` 负责这段算术，已单测）。
   *
   * ② **摘要统计走独立 count，不数当前页**。否则翻到第 2 页时"共 3 份报告"会变成
   *    "共 1 份"，用户会以为数据丢了。
   *
   * ③ **预览文本一次查完，不做 N+1**。列表最多 100 条，逐条查预览段就是 100 次
   *    往返；这里用一次 `in` 查询取回全部免费预览段再在内存里归组。
   */
  async listReports(input: ListReportsInput): Promise<ReportListView> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;

    // 强归属过滤（架构 §14.1）：无论如何都必须带上 userId，其余条件只是收窄
    const baseWhere = {
      userId: input.userId,
      deletedAt: null,
      ...(input.type !== undefined && input.type.length > 0 ? { type: { in: [...input.type] as never } } : {}),
      ...(input.status !== undefined && input.status.length > 0 ? { status: { in: [...input.status] } } : {}),
    };

    // 状态筛选已显式指定时不再置顶：用户要的就是那批，置顶无意义且会让分页更难解释
    const pinActive = input.status === undefined || input.status.length === 0;

    const orderBy = {
      [input.sortBy ?? 'createdAt']: input.order ?? 'desc',
    } as Record<string, 'asc' | 'desc'>;

    const select = {
      id: true,
      type: true,
      status: true,
      title: true,
      contentLength: true,
      freePreviewLength: true,
      sectionCount: true,
      provider: true,
      model: true,
      totalTokens: true,
      latencyMs: true,
      pdfUrl: true,
      shareImageUrl: true,
      generationStartedAt: true,
      generationFinishedAt: true,
      createdAt: true,
      profile: { select: { mbtiType: true, engineVersion: true } },
    } as const;

    const [activeCount, inactiveCount, totalReports, generatingReports, failedReports, latestReport] =
      await Promise.all([
        pinActive
          ? this.prisma.aiReport.count({ where: { ...baseWhere, status: { in: [...ACTIVE_REPORT_STATUSES] } } })
          : Promise.resolve(0),
        pinActive
          ? this.prisma.aiReport.count({ where: { ...baseWhere, status: { notIn: [...ACTIVE_REPORT_STATUSES] } } })
          : Promise.resolve(0),
        this.prisma.aiReport.count({ where: { userId: input.userId, deletedAt: null } }),
        this.prisma.aiReport.count({
          where: { userId: input.userId, deletedAt: null, status: { in: [...ACTIVE_REPORT_STATUSES] } },
        }),
        this.prisma.aiReport.count({ where: { userId: input.userId, deletedAt: null, status: 'FAILED' } }),
        this.prisma.aiReport.findFirst({
          where: { userId: input.userId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }),
      ]);

    const plan = pinActive
      ? planPinnedPagination(activeCount, inactiveCount, page, pageSize)
      : {
          activeSkip: 0,
          activeTake: 0,
          inactiveSkip: (page - 1) * pageSize,
          inactiveTake: pageSize,
        };

    const [activeRows, inactiveRows] = await Promise.all([
      plan.activeTake > 0
        ? this.prisma.aiReport.findMany({
            where: { ...baseWhere, status: { in: [...ACTIVE_REPORT_STATUSES] } },
            orderBy,
            skip: plan.activeSkip,
            take: plan.activeTake,
            select,
          })
        : Promise.resolve([]),
      plan.inactiveTake > 0
        ? this.prisma.aiReport.findMany({
            where: { ...baseWhere, status: { notIn: [...ACTIVE_REPORT_STATUSES] } },
            orderBy,
            skip: plan.inactiveSkip,
            take: plan.inactiveTake,
            select,
          })
        : Promise.resolve([]),
    ]);

    const rows = [...activeRows, ...inactiveRows];
    const previewByReportId = await this.loadPreviewTexts(rows.map((row) => row.id));

    const total = pinActive ? activeCount + inactiveCount : inactiveCount;

    // 逐条判定解锁（会员或已购买）；未提供上下文时一律按未解锁处理
    const unlockContext = input.unlockContext;
    const items = rows.map((row) =>
      this.toListItemView(row, previewByReportId.get(row.id) ?? null, unlockContext?.isUnlocked(row.id) ?? false),
    );

    return {
      items,
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary: buildListSummary({
        // 摘要口径是"该用户全部报告"，与筛选条件无关：用户想知道的是总量，
        // 因筛选而变化的数字会让人误以为报告被删了
        totalReports,
        // 已解锁数按**当前页**的判定结果外推是不对的，所以这里用权益侧的
        // 批量统计（会员时即全部），保证与列表项的 `isUnlocked` 口径一致
        unlockedReports: unlockContext?.countUnlocked(rows.map((row) => row.id)) ?? 0,
        generatingReports,
        failedReports,
        latestReportId: latestReport?.id ?? null,
      }),
    };
  }

  /** 一次取回本页报告的免费预览段，避免逐条查询（N+1） */
  private async loadPreviewTexts(reportIds: readonly string[]): Promise<Map<string, string | null>> {
    if (reportIds.length === 0) return new Map();

    const sections = await this.prisma.reportSection.findMany({
      where: { reportId: { in: [...reportIds] }, isFreePreview: true },
      orderBy: { order: 'asc' },
      select: { reportId: true, content: true },
    });

    const result = new Map<string, string | null>();
    for (const section of sections) {
      // 只取该报告的第一段免费预览（order 已升序），后续段忽略：
      // 列表页展示的是"摘要"，拼接多段会让每行高度差异过大
      if (!result.has(section.reportId)) {
        result.set(section.reportId, buildPreviewText(section.content));
      }
    }

    return result;
  }

  /** 行 → 列表项视图（纯映射，字段推导逻辑在 `report-list.util.ts`） */
  private toListItemView(
    row: {
      id: string;
      type: string;
      status: string;
      title: string | null;
      contentLength: number;
      freePreviewLength: number;
      sectionCount: number;
      provider: string | null;
      model: string | null;
      totalTokens: number;
      latencyMs: number | null;
      pdfUrl: string | null;
      shareImageUrl: string | null;
      generationStartedAt: Date | null;
      generationFinishedAt: Date | null;
      createdAt: Date;
      profile: { mbtiType: string | null; engineVersion: string } | null;
    },
    previewText: string | null,
    isUnlocked: boolean,
  ): ReportListItemView {
    const isFailed = row.status === 'FAILED';

    return {
      reportId: row.id,
      type: row.type,
      typeName: reportTypeName(row.type),
      title: row.title,
      status: row.status,
      mbtiType: row.profile?.mbtiType ?? null,
      engineVersion: row.profile?.engineVersion ?? null,
      wordCount: row.contentLength,
      sectionCount: row.sectionCount,
      freePreviewRatio: computeFreePreviewRatio(row.freePreviewLength, row.contentLength),
      isUnlocked,
      // 解锁来源（会员 / 单份购买）由前端在会员页与报告页分别展示，
      // 列表项这里只给出"是否解锁"。理由见 `buildListUnlockContext`：
      // 为 100 条报告各建一个 source 对象得不偿失
      unlockType: isUnlocked ? 'MEMBERSHIP_ACTIVE' : null,
      provider: row.provider,
      model: row.model,
      totalTokens: row.totalTokens,
      generationDurationMs: computeGenerationDurationMs(
        row.generationStartedAt,
        row.generationFinishedAt,
        row.latencyMs,
      ),
      createdAt: row.createdAt.toISOString(),
      generatedAt: row.generationFinishedAt?.toISOString() ?? null,
      previewText,
      hasPdf: row.pdfUrl !== null,
      shareCardUrl: row.shareImageUrl,
      // 只有失败项带原因，且用友好文案：上游错误原文可能含 Provider 名、HTTP 状态，
      // 回给客户端等于泄露技术栈（契约 §3.5.2 规则 6）
      ...(isFailed ? { failureReason: friendlyFailureReason() } : {}),
    };
  }
}
