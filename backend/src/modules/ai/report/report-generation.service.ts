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

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { buildGrowthReportContext, type GrowthProfileSnapshot } from '../context/growth-report-context.builder';
import { EMOTION_ATTACHMENT_LABELS, buildEmotionReportContext } from '../context/emotion-report-context.builder';
import {
  buildReportContext,
  UNAVAILABLE_PLACEHOLDER,
  type ReportContextInput,
} from '../context/report-context.builder';
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
import { deriveRelationshipStyleFromBigFive } from '../../personality/engine/relationship-style.evaluator';
import { loadRelationshipStyleRules } from '../../personality/relationship-style-rules.loader';
import { estimateCostCents } from '../provider/llm-pricing';
import { LlmProviderFactory } from '../provider/llm-provider.factory';
import type { LlmCompletionResult } from '../provider/llm-provider.types';
import { PromptService, type ResolvedPrompt } from '../prompt/prompt.service';
import { ReportGenerationOptionsService, type ReportGenerationOptions } from './report-generation-options.service';
import { ReportLiveProgressService } from './report-live-progress.service';
import { reportTypeName, GROWTH_MAX_PROFILES } from './report-list.util';
import { STAGE_PROGRESS } from './report-stream.util';
import { parseReportSections, readExpectedSections } from './report-section.parser';

/** 生成请求 */
export interface ReportGenerationRequest {
  readonly userId: string;
  /** 人格画像 id（报告绑定到具体画像版本，画像更新不会改变历史报告的内容） */
  readonly profileId: string;
  readonly templateKey: string;
  /** 任务类型（写入 `ai_usage_logs.task_type`，用于成本归集） */
  readonly taskType: 'MBTI_REPORT' | 'BIG_FIVE_REPORT' | 'RELATIONSHIP_REPORT' | 'GROWTH_SUMMARY' | 'EMOTION_REPORT';
  /** 报告类型（写入 `ai_reports.type`） */
  readonly reportType: 'MBTI_REPORT' | 'BIG_FIVE_REPORT' | 'RELATIONSHIP_REPORT' | 'GROWTH_SUMMARY' | 'EMOTION_REPORT';
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
  /** 成长回顾报告要按版本排时间线，缺它就只能写"未知日期" */
  createdAt: true,
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
    /**
     * 实时进度通道（可选注入）
     *
     * `@Optional()` 有两个作用：
     *   ① 现有单测用 `new ReportGenerationService(prisma, prompts, providers)` 直接构造，
     *      不必为了进度上报而引入 Redis 替身；
     *   ② 本服务在**没有**实时通道时行为完全不变（所有上报都经 `publishLiveProgress` 判空）。
     * 注意它只上报"真实发生的阶段"，不制造进度数字（见各调用点注释）。
     */
    @Optional() private readonly liveProgress?: ReportLiveProgressService,
    /** 生成选项（`tone` / `focus`），仅"重新生成"会写入；同样可选注入 */
    @Optional() private readonly generationOptions?: ReportGenerationOptionsService,
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
        emotionProfileId: true,
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

    /**
     * 是否为成长回顾报告
     *
     * 它的上下文是**画像版本序列**（锚定画像及其之前的各版），与个人报告的
     * "单份画像"不同源，因此必须走单独的组装路径。
     * `ai_reports` 只存得下**一个** `profileId`（没有版本列表列），所以序列
     * 由"锚定画像的 version 及其之前"在生成时**确定性推导**出来 ——
     * 历史画像行是不可变的，锚定画像的版本号又是固定的上界，
     * 因此同一份报告无论生成几次、隔多久生成，取到的序列都一样。
     */
    const isGrowthReport = report.type === 'GROWTH_SUMMARY';

    /**
     * 是否为情感报告（ADR-038 阶段 3）
     *
     * 同样用 `typeof === 'string'` 判"有没有值"（理由见上面 `isRelationshipReport` 的注释）。
     * 情感报告的上下文来自 `emotion_profiles`，与人格画像**完全无关** ——
     * 因此它既不校验 `profileId`，也不读任何人格表。
     */
    const isEmotionReport = report.type === 'EMOTION_REPORT';

    // 情感报告挂的是 `emotionProfileId`，人格类报告挂的是 `profileId`。
    // 两类报告各自校验自己的关联列：把"缺少关联画像"写成一句通用错误，
    // 排查时无法区分是数据缺失还是挂错了列
    if (isEmotionReport) {
      if (typeof report.emotionProfileId !== 'string') {
        throw new BusinessException(ErrorCode.EMOTION_PROFILE_NOT_FOUND, '情感报告缺少关联的情感画像');
      }
    } else if (!isRelationshipReport && report.profileId === null) {
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

    // 阶段①：装配上下文（下面两次 `prepare*` 正是在做这件事）
    await this.publishLiveProgress(reportId, report.userId, {
      status: 'GENERATING',
      stage: 'BUILDING_CONTEXT',
      progress: STAGE_PROGRESS.BUILDING_CONTEXT,
      startedAt: new Date().toISOString(),
      provider: null,
      model: null,
    });

    // 「重新生成」写入的语气/侧重：`ai_reports` 没有对应列，从这里取（见 OptionsService 说明）
    const options = (await this.generationOptions?.read(reportId)) ?? null;

    // 重新推导上下文与 Prompt：3c 的确定性让"重新推导"必然等于首次推导，
    // 因此无需把变量快照落库（少一份可能与画像脱节的数据）
    //
    // 四条取数路径**刻意分开写**而不是塞进一个函数：关系报告读"关系 + 双方画像 +
    // 算分报告"，成长报告读"画像版本序列"，情感报告读"情感画像"，个人报告读
    // "单份人格画像 + 最近会话" —— 合成一个函数后"这次到底读了哪些表"就会埋在
    // 条件里，读代码时看不出来。
    const prepared = isRelationshipReport
      ? await this.prepareForRelationship(
          report.userId,
          report.relationshipId as string,
          report.promptTemplateKey,
          options ?? {},
        )
      : isEmotionReport
        ? await this.prepareForEmotion(
            report.userId,
            report.emotionProfileId as string,
            report.promptTemplateKey,
            options ?? {},
          )
        : isGrowthReport
          ? await this.prepareForGrowth(
              report.userId,
              report.profileId as string,
              report.promptTemplateKey,
              options ?? {},
            )
          : await this.prepare(
              report.userId,
              report.profileId as string,
              report.promptTemplateKey,
              report.type,
              options ?? {},
            );

    // 阶段②：Prompt 已渲染完成（`prepare*` 内部已调用模板渲染）
    await this.publishLiveProgress(reportId, report.userId, {
      stage: 'RENDERING_PROMPT',
      progress: STAGE_PROGRESS.RENDERING_PROMPT,
      // 目标段数由模板的 `outputSchema` 声明，这是"生成中"唯一能确定的规模信息
      targetSectionCount: readExpectedSections(prepared.prompt.outputSchema).length,
      provider: prepared.prompt.provider,
      model: prepared.prompt.model,
    });

    const provider = this.providers.resolveAvailable(prepared.prompt.provider ?? undefined);

    let completion: LlmCompletionResult | null = null;

    try {
      // 阶段③：开始调用模型（真实位置，不是估算）
      await this.publishLiveProgress(reportId, report.userId, {
        stage: 'CALLING_MODEL',
        progress: STAGE_PROGRESS.CALLING_MODEL,
      });

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

      // 阶段④：模型已返回，正在切分段落并落库
      await this.publishLiveProgress(reportId, report.userId, {
        stage: 'GENERATING_SECTIONS',
        progress: STAGE_PROGRESS.GENERATING_SECTIONS,
        generatedSectionCount: parsed.sections.length,
        targetSectionCount: parsed.sections.length,
        provider: completion.provider,
        model: completion.model,
      });

      const costCents = estimateCostCents(completion.provider, completion.model, completion.usage);

      await this.publishLiveProgress(reportId, report.userId, {
        stage: 'PERSISTING',
        progress: STAGE_PROGRESS.PERSISTING,
      });

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

      // 任务终结：清掉实时进度，避免订阅方读到"上一轮生成的残留阶段"。
      // 此后以 `ai_reports` 的行状态为准（SUCCEEDED → 派生出 DONE）
      await this.clearLiveProgress(reportId);
      await this.generationOptions?.clear(reportId);

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

      // 失败同样要清实时进度：否则订阅方会看到"已经 FAILED 却还在调用模型"
      await this.clearLiveProgress(reportId);
      await this.generationOptions?.clear(reportId);

      this.logger.error(`报告生成失败 reportId=${reportId} code=${code}: ${message}`);
      throw error;
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /**
   * 上报一次实时进度
   *
   * 三个刻意的约束：
   *   ① **只在真实代码位置调用**（进入某阶段、拿到模型结果、开始落库），
   *      不按时间推算"现在大概到 60% 了" —— 假进度会掩盖真实的卡顿；
   *   ② 失败只记日志，**绝不影响生成**：进度是展示数据，报告才是交付物；
   *   ③ 用 `?.` 与 try/catch 包住，未注入时（单测、无 Redis 环境）完全静默。
   */
  private async publishLiveProgress(
    reportId: string,
    userId: string,
    patch: Parameters<ReportLiveProgressService['publish']>[2],
  ): Promise<void> {
    if (this.liveProgress === undefined) return;

    try {
      await this.liveProgress.publish(reportId, userId, patch);
    } catch (error) {
      this.logger.warn(`上报报告实时进度失败 reportId=${reportId}: ${(error as Error).message}`);
    }
  }

  /** 清理实时进度（任务终结后调用） */
  private async clearLiveProgress(reportId: string): Promise<void> {
    if (this.liveProgress === undefined) return;

    await this.liveProgress.clear(reportId);
  }

  /** 读取画像并渲染 Prompt（返回 `prompt` 便于调用方复用） */
  private async prepare(
    userId: string,
    profileId: string,
    templateKey: string,
    reportType: string,
    options: ReportGenerationOptions = {},
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
    const prompt = await this.prompts.getPrompt(templateKey, mergeGenerationOptions(variables, options));

    return { prompt, title: buildPersonalReportTitle(reportType, variables).slice(0, 128) };
  }

  /**
   * 读取**情感画像**并渲染 Prompt（情感测评报告，ADR-038 阶段 3）
   *
   * ## 为什么是独立方法而不是给 `prepare` 加一个分支
   *
   * 两条路径读的是**两张不同的表**（`emotion_profiles` / `personality_profiles`），
   * 而且读者必须一眼看出"情感报告绝不读人格数据"。合成一个函数后，
   * 这个不变量就只剩下条件语句，而它一旦被破坏，表现是情感报告里出现
   * MBTI 结论 —— 读起来毫无破绽，正是 ADR-038 阶段 2 刚清掉的那类问题。
   *
   * ## 为什么质量指标从**情感画像**读而不是从最近会话读
   *
   * 人格报告的 `prepare` 取"该用户最近一次会话"来补 `answeredCount/questionCount`，
   * 那是个人报告的便利做法。情感报告不加这一层：会话可能属于另一个模块
   * （用户先做了人格测评），拿它来填情感报告的完成率会得到一份
   * "人格测评的答题数"配"情感测评的分数"的上下文。
   * 因此这里只读情感画像自带的三个质量列。
   */
  private async prepareForEmotion(
    userId: string,
    emotionProfileId: string,
    templateKey: string,
    options: ReportGenerationOptions = {},
  ): Promise<{ prompt: ResolvedPrompt; title: string }> {
    const profile = await this.prisma.emotionProfile.findFirst({
      where: { id: emotionProfileId, userId, deletedAt: null },
      select: {
        attachmentStyle: true,
        attachmentAnxiety: true,
        attachmentAvoidance: true,
        loveLanguageScores: true,
        primaryLoveLanguages: true,
        conflictStyle: true,
        conflictScores: true,
        consistencyScore: true,
        completionRate: true,
        avgResponseMs: true,
        engineVersion: true,
        testResult: { select: { definitionCode: true, qualityMetrics: true } },
      },
    });

    if (profile === null) {
      throw new BusinessException(ErrorCode.EMOTION_PROFILE_NOT_FOUND);
    }

    // 作答题数从**这次测评自己的** qualityMetrics 里取。
    // 取不到时给 null → 组装器用占位文案（而不是回落成某个别的会话的数字）
    const quality = (profile.testResult?.qualityMetrics ?? {}) as Record<string, unknown>;
    const answeredCount = typeof quality['answeredCount'] === 'number' ? quality['answeredCount'] : null;
    const questionCount = typeof quality['totalCount'] === 'number' ? quality['totalCount'] : null;

    const { variables } = buildEmotionReportContext({
      profile: {
        attachmentStyle: profile.attachmentStyle,
        attachmentAnxiety: profile.attachmentAnxiety,
        attachmentAvoidance: profile.attachmentAvoidance,
        loveLanguageScores: (profile.loveLanguageScores ?? null) as Record<string, number> | null,
        primaryLoveLanguages: profile.primaryLoveLanguages,
        conflictStyle: profile.conflictStyle,
        conflictScores: (profile.conflictScores ?? null) as Record<string, number> | null,
        consistencyScore: profile.consistencyScore,
        completionRate: profile.completionRate,
        avgResponseMs: profile.avgResponseMs,
        engineVersion: profile.engineVersion,
      },
      testDefinitionCode: profile.testResult?.definitionCode ?? null,
      answeredCount,
      questionCount,
    });

    const prompt = await this.prompts.getPrompt(templateKey, mergeGenerationOptions(variables, options));

    /**
     * 标题带依恋类型
     *
     * 报告列表里会同时躺着人格报告与情感报告，标题必须让用户一眼分辨 ——
     * 一个"情感测评报告"的通用标题会让人以为它是人格报告的另一版。
     */
    const attachment = EMOTION_ATTACHMENT_LABELS[profile.attachmentStyle] ?? profile.attachmentStyle;

    return { prompt, title: `情感测评报告｜${attachment}依恋`.slice(0, 128) };
  }

  /**
   * 读取画像**版本序列**并渲染 Prompt（成长回顾报告）
   *
   * ## 序列是怎么定出来的（`ai_reports` 存不下版本列表）
   *
   * 表上只有一个 `profileId`，没有"这次报告用了哪几版"的列。因此序列由**锚定画像**
   * 确定性推导：**锚定版本及其之前的最近 N 版**（升序）。
   * 之所以可靠：① 历史画像行是不可变的（每版一行，`version` 单调递增）；
   * ② 锚定画像的版本号是固定的上界，之后新增的版本都 > 它，不会被卷进来。
   * 于是同一份报告无论何时重算，取到的序列都一样（ADR-005 的可复现要求）。
   *
   * ## 为什么不改成"再用一次最新画像"
   *
   * 那会让报告内容随用户后续测评而变 —— 同一份报告读两次不同，
   * 而"重新生成"路径正是靠"重新推导必然等于首次推导"才敢不落变量快照。
   */
  private async prepareForGrowth(
    userId: string,
    anchorProfileId: string,
    templateKey: string,
    options: ReportGenerationOptions = {},
  ): Promise<{ prompt: ResolvedPrompt; title: string }> {
    const anchor = await this.prisma.personalityProfile.findFirst({
      where: { id: anchorProfileId, userId, deletedAt: null },
      select: { version: true },
    });

    if (anchor === null) {
      throw new BusinessException(ErrorCode.PERSONALITY_PROFILE_NOT_FOUND, '报告绑定的画像已不存在');
    }

    // `desc + take` 取"锚定版本及之前"的最近 N 版，再反转成升序交给 builder
    // （builder 明确要求升序并取最后一版为"最新"，排序职责不分散到两处）
    const rows = await this.prisma.personalityProfile.findMany({
      where: { userId, deletedAt: null, version: { lte: anchor.version } },
      orderBy: { version: 'desc' },
      take: GROWTH_MAX_PROFILES,
      select: PROFILE_SELECT,
    });

    const profiles = [...rows].reverse().map(toGrowthSnapshot);
    const { variables } = buildGrowthReportContext({ profiles });
    const prompt = await this.prompts.getPrompt(templateKey, mergeGenerationOptions(variables, options));

    return {
      prompt,
      // 带上版本数：用户在列表页一眼能看出"这份报告基于几次测评"
      title: `${reportTypeName('GROWTH_SUMMARY')}（近 ${profiles.length} 次测评）`.slice(0, 128),
    };
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
    options: ReportGenerationOptions = {},
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

    const [profiles, compatibility, relationshipRules] = await Promise.all([
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
      loadRelationshipStyleRules(this.prisma),
    ]);

    if (compatibility === null || compatibility.totalScore === null) {
      // 没有算分结果就没有可解读的内容。此处**不能**退化成"随便编一个分数" ——
      // 那违反 ADR-005（算分确定、AI 只解读）
      throw new BusinessException(ErrorCode.COMPATIBILITY_PEER_NOT_READY, '匹配算分尚未完成，无法生成解读');
    }

    const sideOf = (sideUserId: string): RelationshipReportSide | null => {
      const profile = profiles.find((item) => item.userId === sideUserId);
      if (profile === undefined) return null;

      // 关系风格三项在 ADR-038 后不再落库（情感结论不属于人格画像），改为用
      // 同一份大五数据现算 —— 与匹配算分走同一个 `resolveRelationshipStyle`，
      // 因此"报告里写的依恋风格"与"匹配分用的依恋风格"必然一致
      const style = deriveRelationshipStyleFromBigFive(profile, relationshipRules);

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
        attachmentStyle: style.attachment,
        loveLanguages: style.loveLanguage,
        conflictStyle: style.conflictStyle,
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

    const prompt = await this.prompts.getPrompt(templateKey, mergeGenerationOptions(variables, options));

    // 标题用双方类型 + 分数：用户一眼能认出是哪段关系的哪一份报告
    return { prompt, title: buildRelationshipReportTitle(variables).slice(0, 128) };
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
 * 把语气/侧重并入 Prompt 变量
 *
 * 只有显式传入的键才覆盖上下文变量 —— 不能整体替换，否则一次"换语气"的小操作
 * 会把画像数据全部丢掉（模板里 `{{mbtiType}}` 之类会立刻渲染失败）。
 *
 * 模板若未声明 `{{tone}}` / `{{focus}}`，多传这两个键**不会**产生任何影响
 * （`renderTemplate` 只对"模板里出现但变量缺失"报错），因此对既有模板完全向后兼容；
 * 而一旦后台按契约 §3.14 的模板（含 `内容侧重：{{focus}}`）发布版本，这两个变量即生效。
 */
const mergeGenerationOptions = (
  variables: Readonly<Record<string, string>>,
  options: ReportGenerationOptions,
): Record<string, string> => ({
  ...variables,
  ...(options.tone !== undefined ? { tone: options.tone } : {}),
  ...(options.focus !== undefined ? { focus: options.focus } : {}),
});

/**
 * 画像行 → 成长报告的一版快照
 *
 * `testDefinitionCode` / `answeredCount` / `questionCount` 逐版**取不到**：
 * 它们属于该版画像对应的那次测评会话，而 `personality_profiles` 与 `test_sessions`
 * 之间没有能按版本 join 的外键（现有单画像路径取的是"最近一次会话"，把它复用到每一版
 * 会让所有版本都显示同一个量表 —— 那是**编造**）。
 * 因此这里逐版传 `null`：builder 会把它记成字段级缺项、`dataQualityText` 相应变短，
 * 提示词里也明确告诉模型"这项本次没有"，而不是让它看见一个假的量表名。
 */
const toGrowthSnapshot = (row: {
  version: number;
  createdAt: Date;
  mbtiType: string | null;
  openness: number | null;
  conscientiousness: number | null;
  extraversion: number | null;
  agreeableness: number | null;
  neuroticism: number | null;
  consistencyScore: number | null;
  completionRate: number | null;
  avgResponseMs: number | null;
}): GrowthProfileSnapshot => ({
  version: row.version,
  // builder 只做字符串切片取日期，不做时区换算（见其文件头），因此这里给 UTC ISO
  createdAt: row.createdAt.toISOString(),
  mbtiType: row.mbtiType,
  openness: row.openness,
  conscientiousness: row.conscientiousness,
  extraversion: row.extraversion,
  agreeableness: row.agreeableness,
  neuroticism: row.neuroticism,
  consistencyScore: row.consistencyScore,
  completionRate: row.completionRate,
  avgResponseMs: row.avgResponseMs,
  answeredCount: null,
  questionCount: null,
  testDefinitionCode: null,
});

/**
 * 变量值是否**真的可用**
 *
 * `buildReportContext` / `buildRelationshipReportContext` 保证变量**永远存在**：
 * 数据缺失时填 `UNAVAILABLE_PLACEHOLDER`（两个 builder 的硬性约束③，目的是让模板
 * 永远能渲染成功）。因此判断"这项数据有没有"**必须看值**，不能看 key 在不在 ——
 * 按 key 判空的写法会永远走不出兜底分支。
 */
const isVariableUsable = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0 && value !== UNAVAILABLE_PLACEHOLDER;

/**
 * 个人报告的标题（按**报告类型**分派）
 *
 * 原实现只判断 `mbtiType` / `mbtiTypeName` 两个变量"存不存在"，而它们永远存在，
 * 于是兜底分支从不命中，实测会产出两种荒谬标题：
 *   · 纯大五画像（引擎因维度无有效作答而返回 `mbtiType = null`）：
 *     「（本次测评未包含此项） （本次测评未包含此项） 深度解读」
 *   · 做过 MBTI 的用户去生成大五报告：「INFJ 提倡者 深度解读」（内容却全是大五）
 * 所以这里既按类型分派，又按**值**判断 MBTI 是否真的可用。
 */
const buildPersonalReportTitle = (reportType: string, variables: Readonly<Record<string, string>>): string => {
  if (reportType === 'MBTI_REPORT') {
    const mbtiType = variables['mbtiType'];
    const mbtiTypeName = variables['mbtiTypeName'];

    if (isVariableUsable(mbtiType) && isVariableUsable(mbtiTypeName)) {
      return `${mbtiType} ${mbtiTypeName} 深度解读`;
    }
  }

  // 其余类型（大五 / 成长回顾）用类型中文名：它们的变量里没有 MBTI 类型，
  // 拼上 MBTI 只会得到与正文不符的标题
  return reportTypeName(reportType);
};

/**
 * 关系报告的标题（双方类型 + 分数）
 *
 * 与个人报告同一个坑：`myMbtiType` / `partnerMbtiType` 缺失时是占位文案而非
 * `undefined`，按 key 判空会拼出
 * 「（本次测评未包含此项） × （本次测评未包含此项） 匹配解读（72 分）」。
 * 分数同理（虽然关系报告要求已有成功的算分报告，但读不到分数时宁可不写）。
 */
const buildRelationshipReportTitle = (variables: Readonly<Record<string, string>>): string => {
  const myType = variables['myMbtiType'];
  const partnerType = variables['partnerMbtiType'];
  const totalScore = variables['totalScore'];

  if (!isVariableUsable(myType) || !isVariableUsable(partnerType)) return '关系匹配解读';

  return `${myType} × ${partnerType} 匹配解读${isVariableUsable(totalScore) ? `（${totalScore} 分）` : ''}`;
};

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
 * `AiTaskType` 枚举只有 `MBTI_REPORT` / `RELATIONSHIP_REPORT` / `EMOTION_ANALYSIS`
 * 三个报告相关类目，没有 `BIG_FIVE_REPORT` 与 `GROWTH_SUMMARY`。为了不给一个
 * 成本归集字段动数据库枚举（= 迁移 + 发版），把这两个归入 `MBTI_REPORT`（个人报告桶）。
 * 若将来成本需要按报告类型细分，应先扩展枚举再改这里。
 *
 * ⚠ 情感报告归到 **`EMOTION_ANALYSIS`** 而不是 `MBTI_REPORT`：
 * 那个枚举值此前是个"有取值、无模板、无代码路径"的空位（`CONTRACT_DRIFT_AUDIT.md` §9.3
 * 记录过），现在它终于有了真实用途。把情感报告记成 MBTI 报告会让后台的
 * **成本按任务类型拆分**把两个模块混在一起 —— 而模块隔离正是这次整改的目的。
 */
const reportUsageTaskType = (reportType: string): AiUsageTaskType => {
  if (reportType === 'RELATIONSHIP_REPORT') return 'RELATIONSHIP_REPORT';
  if (reportType === 'EMOTION_REPORT') return 'EMOTION_ANALYSIS';

  return 'MBTI_REPORT';
};

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
