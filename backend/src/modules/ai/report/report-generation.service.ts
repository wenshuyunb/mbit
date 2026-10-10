/**
 * 报告生成编排（Phase 3d-2）
 *
 * 把 Phase 3 的三块基础设施串成流水线：
 *   上下文组装（3c，确定性）→ Prompt 模板（3b，DB 版本化）→ Provider（3a，协议归一）
 *   → 分段解析（3d-1，ADR-004）→ 落库
 *
 * 两个贯穿全局的设计点：
 *
 * ① **`ai_reports.cacheKey` 唯一约束即幂等点**
 *    cacheKey = hash(userId | profileId | profileVersion | templateKey | versionId | provider | model)。
 *    同一份画像 + 同一 Prompt 版本 + 同一模型，产出的报告必然相同，因此：
 *    · 用户连点两次不会付两次费
 *    · 队列重试不会重复生成
 *    · 已成功的报告直接复用，不再调用模型
 *
 * ② **失败也要写用量日志**
 *    失败的调用同样消耗了 token（例如输出格式非法、内容被截断）。
 *    只在成功时记账会让成本看板系统性低估，而成本看板的用途正是发现异常。
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { buildReportContext, type ReportContextInput } from '../context/report-context.builder';
import {
  buildRelationshipReportContext,
  counterpartLabelOf,
  type RelationshipReportSide,
} from '../context/relationship-report-context.builder';
import {
  compatibilityScoreLabel,
  compatibilityScoreLevel,
  daysTogether,
  relationTypeName,
} from '../../relationship/relationship-view.util';
import { estimateCostCents } from '../provider/llm-pricing';
import { LlmProviderFactory } from '../provider/llm-provider.factory';
import type { LlmCompletionResult } from '../provider/llm-provider.types';
import { PromptService, type ResolvedPrompt } from '../prompt/prompt.service';
import { parseReportSections, readExpectedSections } from './report-section.parser';

/** 生成请求 */
export interface ReportGenerationRequest {
  readonly userId: string;
  /** 人格画像 id（报告绑定到具体画像版本，画像更新不会改变历史报告的内容） */
  readonly profileId: string;
  readonly templateKey: string;
  /** 任务类型（写入 `ai_usage_logs.task_type`，用于成本归集） */
  readonly taskType: 'MBTI_REPORT' | 'BIG_FIVE_REPORT' | 'RELATIONSHIP_REPORT' | 'GROWTH_SUMMARY';
  /** 报告类型（写入 `ai_reports.type`） */
  readonly reportType: 'MBTI_REPORT' | 'BIG_FIVE_REPORT' | 'RELATIONSHIP_REPORT' | 'GROWTH_SUMMARY';
  readonly sessionId: string | null;
}

/** 生成结果 */
export interface GeneratedReport {
  readonly reportId: string;
  readonly isReused: boolean;
}

/** 数据库读取出的画像（只取编排需要的字段） */
const PROFILE_SELECT = {
  id: true,
  version: true,
  engineVersion: true,
  mbtiType: true,
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
  attachmentStyle: true,
  loveLanguages: true,
  conflictStyle: true,
  consistencyScore: true,
  completionRate: true,
  avgResponseMs: true,
} as const;

@Injectable()
export class ReportGenerationService {
  private readonly logger = new Logger(ReportGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptService,
    private readonly providers: LlmProviderFactory,
  ) {}

  /**
   * 执行一次生成（由队列处理器调用）
   *
   * 已成功的报告直接返回 —— 幂等在此处生效，而不是靠调用方自觉。
   */
  async runGeneration(reportId: string): Promise<GeneratedReport> {
    const report = await this.prisma.aiReport.findUnique({
      where: { id: reportId },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        profileId: true,
        sessionId: true,
        relationshipId: true,
        promptTemplateKey: true,
        promptVersionId: true,
      },
    });

    if (report === null) {
      throw new BusinessException(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    if (report.status === 'SUCCEEDED') {
      this.logger.log(`报告已生成，跳过重复调用 reportId=${reportId}`);
      return { reportId, isReused: true };
    }

    /**
     * 是否为关系报告
     *
     * ⚠ 用 `typeof === 'string'` 而不是 `!== null`：`undefined !== null` 为**真**，
     * 于是任何没有该字段的对象（测试替身、旧数据、手工构造的调用）都会被误判成
     * 关系报告，进而去查 `relationship` 表并抛出难以理解的错误。
     * 判定"有没有值"时用真值判断，不要用 `!== null`。
     */
    const isRelationshipReport = typeof report.relationshipId === 'string';

    if (!isRelationshipReport && report.profileId === null) {
      throw new BusinessException(ErrorCode.PERSONALITY_PROFILE_NOT_FOUND, '报告缺少关联画像');
    }

    const startedAt = Date.now();

    await this.prisma.aiReport.update({
      where: { id: reportId },
      data: {
        status: 'GENERATING',
        progress: 10,
        generationStartedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });

    // 重新推导上下文与 Prompt：3c 的确定性让"重新推导"必然等于首次推导，
    // 因此无需把变量快照落库（少一份可能与画像脱节的数据）
    const prepared = isRelationshipReport
      ? await this.prepareForRelationship(report.userId, report.relationshipId as string, report.promptTemplateKey)
      : await this.prepare(report.userId, report.profileId as string, report.promptTemplateKey);

    const provider = this.providers.resolveAvailable(prepared.prompt.provider ?? undefined);

    let completion: LlmCompletionResult | null = null;

    try {
      completion = await provider.complete({
        messages: [
          { role: 'system', content: prepared.prompt.system },
          { role: 'user', content: prepared.prompt.user },
        ],
        ...(prepared.prompt.model !== null ? { model: prepared.prompt.model } : {}),
        ...(prepared.prompt.temperature !== null ? { temperature: prepared.prompt.temperature } : {}),
        ...(prepared.prompt.maxTokens !== null ? { maxTokens: prepared.prompt.maxTokens } : {}),
        // 报告以 Markdown 小标题分段，不用 JSON 模式（分段解析器依赖标题结构）
        responseFormat: 'text',
      });

      const expected = readExpectedSections(prepared.prompt.outputSchema);
      const parsed = parseReportSections(completion.content, expected);

      if (parsed.sections.length === 0) {
        throw new BusinessException(ErrorCode.AI_OUTPUT_INVALID, 'AI 生成的报告没有任何有效段落');
      }

      const costCents = estimateCostCents(completion.provider, completion.model, completion.usage);

      await this.persistSuccess({
        reportId,
        raw: completion.content,
        parsed,
        completion,
        costCents,
        latencyMs: Date.now() - startedAt,
        title: prepared.title,
      });

      await this.writeUsageLog({
        userId: report.userId,
        reportId,
        taskType: reportUsageTaskType(report.type),
        completion,
        costCents,
        success: true,
      });

      this.logger.log(
        `报告生成完成 reportId=${reportId} sections=${parsed.sections.length} tokens=${completion.usage.totalTokens} cost=${costCents}分 耗时=${Date.now() - startedAt}ms`,
      );

      return { reportId, isReused: false };
    } catch (error) {
      const code = readErrorCode(error);
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.aiReport.update({
        where: { id: reportId },
        data: {
          status: 'FAILED',
          progress: 100,
          errorCode: String(code),
          errorMessage: message.slice(0, 1000),
          generationFinishedAt: new Date(),
        },
      });

      // 失败也记账：失败的调用同样消耗 token，漏记会让成本看板系统性低估
      if (completion !== null) {
        await this.writeUsageLog({
          userId: report.userId,
          reportId,
          taskType: reportUsageTaskType(report.type),
          completion,
          costCents: estimateCostCents(completion.provider, completion.model, completion.usage),
          success: false,
        });
      }

      this.logger.error(`报告生成失败 reportId=${reportId} code=${code}: ${message}`);
      throw error;
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 读取画像并渲染 Prompt（返回 `prompt` 便于调用方复用） */
  private async prepare(
    userId: string,
    profileId: string,
    templateKey: string,
  ): Promise<{ prompt: ResolvedPrompt; title: string }> {
    const profile = await this.prisma.personalityProfile.findFirst({
      where: { id: profileId, userId, deletedAt: null },
      select: PROFILE_SELECT,
    });

    if (profile === null) {
      throw new BusinessException(ErrorCode.PERSONALITY_PROFILE_NOT_FOUND);
    }

    const session = await this.prisma.testSession.findFirst({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { definitionCode: true, answeredCount: true, questionCount: true },
    });

    const input: ReportContextInput = {
      profile,
      testDefinitionCode: session?.definitionCode ?? null,
      answeredCount: session?.answeredCount ?? null,
      questionCount: session?.questionCount ?? null,
    };

    const { variables } = buildReportContext(input);
    const prompt = await this.prompts.getPrompt(templateKey, variables);

    const title =
      variables['mbtiType'] === undefined || variables['mbtiTypeName'] === undefined
        ? `${templateKey} 报告`
        : `${variables['mbtiType']} ${variables['mbtiTypeName']} 深度解读`;

    return { prompt, title: title.slice(0, 128) };
  }

  /**
   * 读取关系双方画像与算分结果并渲染 Prompt（契约 §3.6.9）
   *
   * 与单画像的 `prepare` 是**两条路径**而不是一个带分支的函数：关系报告的
   * 上下文来自"关系 + 双方画像 + 算分报告"三处，与单画像的"画像 + 会话"完全
   * 不同源。写成一个函数后，"另一半数据从哪来"会埋在条件里，读代码时很难看出
   * 一次关系报告到底读了哪些表。
   */
  private async prepareForRelationship(
    userId: string,
    relationshipId: string,
    templateKey: string,
  ): Promise<{ prompt: ResolvedPrompt; title: string }> {
    const relationship = await this.prisma.relationship.findFirst({
      where: {
        id: relationshipId,
        deletedAt: null,
        // 归属校验：只有关系双方能生成这段关系的报告
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      select: { id: true, type: true, status: true, userAId: true, userBId: true, confirmedAt: true },
    });

    if (relationship === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    const [profiles, compatibility] = await Promise.all([
      this.prisma.personalityProfile.findMany({
        where: { userId: { in: [relationship.userAId, relationship.userBId] }, isCurrent: true, deletedAt: null },
        select: { userId: true, ...PROFILE_SELECT },
      }),
      this.prisma.compatibilityReport.findFirst({
        where: { relationshipId, status: 'SUCCEEDED', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          totalScore: true,
          mbtiScore: true,
          bigFiveScore: true,
          attachmentScore: true,
          communicationScore: true,
          scoreBreakdown: true,
        },
      }),
    ]);

    if (compatibility === null || compatibility.totalScore === null) {
      // 没有算分结果就没有可解读的内容。此处**不能**退化成"随便编一个分数" ——
      // 那违反 ADR-005（算分确定、AI 只解读）
      throw new BusinessException(ErrorCode.COMPATIBILITY_PEER_NOT_READY, '匹配算分尚未完成，无法生成解读');
    }

    const sideOf = (sideUserId: string): RelationshipReportSide | null => {
      const profile = profiles.find((item) => item.userId === sideUserId);
      if (profile === undefined) return null;

      return {
        mbtiType: profile.mbtiType,
        eiPercent: profile.eiPercent,
        snPercent: profile.snPercent,
        tfPercent: profile.tfPercent,
        jpPercent: profile.jpPercent,
        openness: profile.openness,
        conscientiousness: profile.conscientiousness,
        extraversion: profile.extraversion,
        agreeableness: profile.agreeableness,
        neuroticism: profile.neuroticism,
        attachmentStyle: profile.attachmentStyle,
        loveLanguages: profile.loveLanguages ?? [],
        conflictStyle: profile.conflictStyle,
      };
    };

    const me = sideOf(userId);
    const partnerId = relationship.userAId === userId ? relationship.userBId : relationship.userAId;
    const partner = sideOf(partnerId);

    if (me === null || partner === null) {
      throw new BusinessException(ErrorCode.COMPATIBILITY_PEER_NOT_READY, '双方画像不完整，无法生成解读');
    }

    const skippedDimensions = readSkippedDimensions(compatibility.scoreBreakdown);

    const { variables } = buildRelationshipReportContext({
      relationTypeName: relationTypeName(relationship.type),
      counterpartLabel: counterpartLabelOf(relationship.type),
      me,
      partner,
      scores: {
        totalScore: compatibility.totalScore,
        mbtiScore: compatibility.mbtiScore,
        bigFiveScore: compatibility.bigFiveScore,
        attachmentScore: compatibility.attachmentScore,
        communicationScore: compatibility.communicationScore,
        scoreBreakdown: (compatibility.scoreBreakdown as Record<string, unknown> | null) ?? {},
        skippedDimensions,
        scoreLevelLabel: compatibilityScoreLabel(compatibilityScoreLevel(compatibility.totalScore)),
      },
      daysTogether: daysTogether(relationship.confirmedAt, new Date()),
    });

    const prompt = await this.prompts.getPrompt(templateKey, variables);

    // 标题用双方类型 + 分数：用户一眼能认出是哪段关系的哪一份报告
    const title =
      variables['myMbtiType'] === undefined || variables['partnerMbtiType'] === undefined
        ? '关系匹配解读'
        : `${variables['myMbtiType']} × ${variables['partnerMbtiType']} 匹配解读（${variables['totalScore']} 分）`;

    return { prompt, title: title.slice(0, 128) };
  }

  /** 事务内落库：正文 + 分段 + 报告状态 */
  private async persistSuccess(params: {
    reportId: string;
    raw: string;
    parsed: ReturnType<typeof parseReportSections>;
    completion: LlmCompletionResult;
    costCents: number;
    latencyMs: number;
    title: string;
  }): Promise<void> {
    const { reportId, raw, parsed, completion, costCents, latencyMs, title } = params;

    await this.prisma.$transaction(async (tx) => {
      // 重新生成时先清空旧分段：段落键虽稳定，但「本次生成没有产出的段落」
      // 必须消失，否则用户会看到上一版的残留内容混在报告里
      await tx.reportSection.deleteMany({ where: { reportId } });

      await tx.reportSection.createMany({
        data: parsed.sections.map((section) => ({
          reportId,
          sectionKey: section.sectionKey,
          title: section.title,
          content: section.content,
          order: section.order,
          isFreePreview: section.isFreePreview,
          model: completion.model,
          generatedAt: new Date(),
        })),
      });

      await tx.aiReport.update({
        where: { id: reportId },
        data: {
          status: 'SUCCEEDED',
          progress: 100,
          title,
          // 列表页用引言作摘要；没有引言时退回首段开头
          summary: (parsed.preamble.length > 0 ? parsed.preamble : (parsed.sections[0]?.content ?? '')).slice(0, 1024),
          content: raw,
          contentLength: parsed.contentLength,
          freePreviewLength: parsed.freePreviewLength,
          sectionCount: parsed.sections.length,
          provider: completion.provider,
          model: completion.model,
          promptTokens: completion.usage.promptTokens,
          completionTokens: completion.usage.completionTokens,
          totalTokens: completion.usage.totalTokens,
          costAmount: costCents,
          latencyMs,
          generationFinishedAt: new Date(),
        },
      });

      // 关系报告：把分段内容按**段落键**写回 `compatibility_reports` 的 JsonB 列。
      // 段落键与列名一一对应（见 `RELATIONSHIP_REPORT_SECTIONS`），
      // 因此这里用一次映射而不是靠段序猜 —— 模型少写一段时段序必然错位。
      const compatibility = await tx.compatibilityReport.findFirst({
        where: { aiReportId: reportId, deletedAt: null },
        select: { id: true },
      });

      if (compatibility !== null) {
        const sectionText = new Map(parsed.sections.map((section) => [section.sectionKey, section.content]));

        await tx.compatibilityReport.update({
          where: { id: compatibility.id },
          data: {
            // 三个 JsonB 列与模板的三段一一对应。`JsonB` 里存 `{ content }`
            // 而不是裸字符串：日后要给每段加结构化字段（如条目列表、置信度）
            // 时可以直接加键，不必迁移已有数据的形态。
            advantages: toJsonContent(sectionText.get('advantages')),
            conflicts: toJsonContent(sectionText.get('conflicts')),
            suggestions: toJsonContent(sectionText.get('suggestions')),
            generatedAt: new Date(),
            status: 'SUCCEEDED',
            provider: completion.provider,
            model: completion.model,
            totalTokens: completion.usage.totalTokens,
            costAmount: costCents,
          },
        });
      }
    });
  }

  /** 写入用量日志（成功与失败都写） */
  private async writeUsageLog(params: {
    userId: string;
    reportId: string;
    taskType: AiUsageTaskType;
    completion: LlmCompletionResult;
    costCents: number;
    success: boolean;
  }): Promise<void> {
    const { userId, reportId, taskType, completion, costCents, success } = params;

    try {
      await this.prisma.aiUsageLog.create({
        data: {
          userId,
          reportId,
          taskType,
          provider: completion.provider as never,
          model: completion.model,
          promptTokens: completion.usage.promptTokens,
          completionTokens: completion.usage.completionTokens,
          totalTokens: completion.usage.totalTokens,
          costAmount: costCents,
          success,
          latencyMs: completion.latencyMs,
          ...(completion.providerRequestId !== null ? { requestId: completion.providerRequestId.slice(0, 64) } : {}),
          usageDate: new Date(),
        },
      });
    } catch (error) {
      // 记账失败不应让已成功的报告变成失败：报告已落库，日志事后可补
      this.logger.warn(`写入 AI 用量日志失败 reportId=${reportId}: ${(error as Error).message}`);
    }
  }
}

/**
 * 从任意异常中取出可用的错误码（取不到则回退「AI 服务不可用」）
 *
 * 不只用 `instanceof BusinessException` 判断：Provider 层抛的确实是业务异常，
 * 但中间任何一层（拦截器、SDK 适配、日志包装）都可能把它包成普通 Error。
 * 只认 `instanceof` 会让真实的限流码 50002 在报告里退化成 50000 ——
 * 用户看到的提示、监控的告警维度都会因此失真。
 *
 * 与 `isUniqueConstraintError` 同一思路：结构判断优先，类型判断兜底。
 */
const readErrorCode = (error: unknown): number => {
  if (error instanceof BusinessException) return error.code;

  if (typeof error === 'object' && error !== null) {
    const raw = (error as { code?: unknown }).code;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
    // 部分 SDK 把错误码编码成字符串
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }

  return ErrorCode.AI_PROVIDER_UNAVAILABLE;
};

/**
 * 用量日志的任务类型（Prisma `AiTaskType` 的合法取值）
 *
 * 显式列出而非引用 Prisma 类型：本文件在测试中用替身，引用生成类型会把
 * Prisma Client 拽进单测依赖里。
 */
export type AiUsageTaskType =
  | 'MBTI_REPORT'
  | 'RELATIONSHIP_REPORT'
  | 'AI_COMPANION'
  | 'EMOTION_ANALYSIS'
  | 'MEMORY_SUMMARY'
  | 'STRUCTURED_EXTRACT'
  | 'SAFETY_CHECK';

/**
 * 报告类型 → 用量日志任务类型
 *
 * `AiTaskType` 枚举只有 `MBTI_REPORT` / `RELATIONSHIP_REPORT` 两个报告类目，
 * 没有 `BIG_FIVE_REPORT` 与 `GROWTH_SUMMARY`。为了不给一个成本归集字段
 * 动数据库枚举（= 迁移 + 发版），把这两个归入 `MBTI_REPORT`（个人报告桶）。
 * 若将来成本需要按报告类型细分，应先扩展枚举再改这里。
 */
const reportUsageTaskType = (reportType: string): AiUsageTaskType =>
  reportType === 'RELATIONSHIP_REPORT' ? 'RELATIONSHIP_REPORT' : 'MBTI_REPORT';

/**
 * 段落正文 → `JsonB` 值
 *
 * 段落缺失时返回 **`Prisma.DbNull`** 而不是 `{}`，也不能用裸 `null`
 * （Prisma 的可空 Json 字段用 `DbNull` 区分"数据库 NULL"与"JSON 里的 null"，
 * 传裸 `null` 会直接编译不过）。
 *
 * 为什么必须显式置 NULL 而不是"缺失就不更新该字段"：重新生成时若某段这次没产出，
 * 保留旧值会让用户看到**上一版的内容混在新报告里**。
 */
const toJsonContent = (content: string | undefined): { content: string } | typeof Prisma.DbNull =>
  content === undefined ? Prisma.DbNull : { content };

/**
 * 从算分明细里读出被跳过的维度
 *
 * 引擎把 `skippedDimensions` 写在 `scoreBreakdown` 里（而不是单独的列）。
 * 这里做类型收窄并把非字符串项过滤掉：该字段来自 `JsonB`，历史数据或手工修数
 * 都可能让它不是字符串数组，而下游只是拼进 Prompt —— 一旦混进对象就会渲染成
 * `[object Object]` 出现在给用户看的报告里。
 */
const readSkippedDimensions = (breakdown: unknown): readonly string[] => {
  if (typeof breakdown !== 'object' || breakdown === null) return [];

  const raw = (breakdown as Record<string, unknown>).skippedDimensions;
  if (!Array.isArray(raw)) return [];

  return raw.filter((item): item is string => typeof item === 'string');
};
