/**
 * AdminTestDefinitionService — 管理端测试定义服务
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.4（2 个接口）
 *
 * ## 契约字段 ↔ 数据模型的映射（本文件最需要理解的部分）
 *
 * 契约里的测试定义有 16 个字段，而 `test_definitions` 表只有其中一部分对应列。
 * 这里**不新增迁移**（超出本次改动范围），而是把多出来的字段落到既有的 JsonB 列上，
 * 并在此处集中说明，避免「字段写进去了、没人知道它在哪」：
 *
 * | 契约字段                                | 落库位置                                     |
 * | --------------------------------------- | -------------------------------------------- |
 * | `scoringModel` / `engineVersion`        | `scoring_config`（算分相关，语义吻合）        |
 * | `subtitle` / `isFree` / `requiredEntitlement` | `result_template`（面向用户展示与准入的元数据） |
 * | `quotaConfig[].quota`                   | `dimension_quotas`（`{维度: 配额}` 映射）     |
 * | 其余字段                                | 同名/近义列（`category` 除外，见下）          |
 *
 * ## 两处必须知道的差异（已在代码注释处再次标注）
 *
 * 1. **`category` 取值域不重合**：契约只有 `PERSONALITY` / `RELATIONSHIP`，
 *    而 `TestCategory` 有 4 个取值。以 `scoringModel` 为唯一事实源双向映射 ——
 *    只有它能同时决定「算分分支」与「大类」，因此不可能映射出互相矛盾的组合。
 * 2. **抽题规则**：契约允许「显式集合 + 维度配额」二者并存，而当前**运行期**（`TestService.createSession`）
 *    实际按 `questions.test_definition_id = 该定义` 取**全部启用题目**下发试卷，
 *    维度配额尚未参与抽题。因此 `readiness` 里以「定义名下启用题目数 ≥ questionCount」
 *    为硬性就绪条件 —— 这正是运行期会不会报 `40011` 的判据。
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TestCategory, TestDefinition } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  BIG_FIVE_DIMENSIONS,
  ENGINE_VERSION,
  MBTI_DIMENSIONS,
} from '../../personality/engine/personality-engine.types';
import { AdminAuditService } from '../audit/admin-audit.service';
import type {
  CreateTestDefinitionDto,
  ListTestDefinitionsQueryDto,
  TestDefinitionCategory,
  TestScoringModel,
} from './dto/test-definition.dto';

/** 关系风格类计分模型允许的维度（`Dimension` 枚举里非 MBTI / 非大五的三项） */
const RELATIONSHIP_STYLE_DIMENSIONS = ['ATTACHMENT', 'LOVE_LANGUAGE', 'CONFLICT_STYLE'] as const;

/** 计分模型 → 允许的维度集合 */
const ALLOWED_DIMENSIONS: Readonly<Record<TestScoringModel, readonly string[]>> = {
  MBTI_DIMENSION: MBTI_DIMENSIONS,
  BIG_FIVE_SUM: BIG_FIVE_DIMENSIONS,
  RELATIONSHIP_STYLE: RELATIONSHIP_STYLE_DIMENSIONS,
};

/** 计分模型 → 数据模型 `TestCategory`（写入方向） */
const DB_CATEGORY_OF_MODEL: Readonly<Record<TestScoringModel, TestCategory>> = {
  MBTI_DIMENSION: 'MBTI',
  BIG_FIVE_SUM: 'BIG_FIVE',
  RELATIONSHIP_STYLE: 'RELATIONSHIP_STYLE',
};

/** 契约 `category` → 数据模型 `TestCategory` 候选集合（查询方向） */
const DB_CATEGORIES_OF_CONTRACT: Readonly<Record<TestDefinitionCategory, readonly TestCategory[]>> = {
  // COMPREHENSIVE（MBTI + 大五联合评估）在契约里没有独立取值，归入 PERSONALITY
  PERSONALITY: ['MBTI', 'BIG_FIVE', 'COMPREHENSIVE'],
  RELATIONSHIP: ['RELATIONSHIP_STYLE'],
};

/** 记为「已完成」的会话状态（契约 `sessionStats.completedSessions`） */
const COMPLETED_SESSION_STATUSES = ['SUBMITTED', 'SCORED', 'REPORT_READY'] as const;

/** 管理端操作者（审计与响应里的 `createdBy`） */
export interface AdminActor {
  adminId: string;
  username: string;
  displayName: string;
}

/** 维度配额（含可用题量与是否充足） */
export interface QuotaConfigView {
  dimension: string;
  quota: number;
  availableCount: number;
  isSufficient: boolean;
}

/** 会话统计（评估测试体验质量，架构 §1.4「完成率 ≥ 65%」） */
export interface SessionStatsView {
  totalSessions: number;
  completedSessions: number;
  completionRate: number;
  averageMinutes: number | null;
}

/** 就绪检查 */
export interface ReadinessView {
  isReady: boolean;
  blockers: string[];
  warnings: string[];
}

/** 列表项（契约 §3.14.4.1 `data.items[]`） */
export interface TestDefinitionListItem {
  testDefinitionId: string;
  code: string;
  name: string;
  subtitle: string | null;
  category: TestDefinitionCategory;
  version: string;
  questionCount: number;
  estimatedMinutes: number;
  scoringModel: TestScoringModel | null;
  engineVersion: string;
  isActive: boolean;
  isFree: boolean;
  requiredEntitlement: string | null;
  sortOrder: number;
  quotaConfig: QuotaConfigView[];
  questionIds?: string[];
  sessionStats: SessionStatsView;
  createdAt: string;
  updatedAt: string;
}

/** 列表结果 */
export interface TestDefinitionListResult {
  items: TestDefinitionListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: {
    totalDefinitions: number;
    activeDefinitions: number;
    insufficientQuotaDefinitions: number;
  };
}

/** 新建结果（契约 §3.14.4.2 成功响应） */
export interface CreateTestDefinitionResult {
  testDefinitionId: string;
  code: string;
  name: string;
  version: string;
  category: TestDefinitionCategory;
  questionCount: number;
  estimatedMinutes: number;
  scoringModel: TestScoringModel;
  engineVersion: string;
  isFree: boolean;
  isActive: boolean;
  statusLabel: string;
  quotaConfig: QuotaConfigView[];
  readiness: ReadinessView;
  createdAt: string;
  createdBy: string;
  auditLogId: string | null;
  cacheInvalidated: boolean;
  nextStep: string;
}

/** 落库时使用的列集合（列表与详情一致，避免两处 select 漂移） */
const DEFINITION_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  version: true,
  questionCount: true,
  estimatedMinutes: true,
  sortOrder: true,
  isActive: true,
  status: true,
  category: true,
  dimensionQuotas: true,
  scoringConfig: true,
  resultTemplate: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TestDefinitionSelect;

type DefinitionRow = Pick<TestDefinition, keyof typeof DEFINITION_SELECT>;

/** 是否为「普通对象」（JsonB 读出的值需要先收窄再取字段） */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 读取 JsonB 配置对象；非对象（null / 数组 / 脏值）统一按「未配置」处理 */
const readConfig = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  isRecord(value) ? value : {};

/** 读取 `scoringConfig.scoringModel`（历史数据可能没有该字段） */
const readScoringModel = (value: Prisma.JsonValue | null | undefined): TestScoringModel | null => {
  const model = readConfig(value)['scoringModel'];
  return typeof model === 'string' && model in DB_CATEGORY_OF_MODEL ? (model as TestScoringModel) : null;
};

/** 读取 `scoringConfig.engineVersion` */
const readEngineVersion = (value: Prisma.JsonValue | null | undefined): string => {
  const version = readConfig(value)['engineVersion'];
  return typeof version === 'string' && version.length > 0 ? version : ENGINE_VERSION;
};

/** 读取 `resultTemplate` 里的展示与准入元数据 */
const readResultTemplate = (
  value: Prisma.JsonValue | null | undefined,
): { subtitle: string | null; isFree: boolean; requiredEntitlement: string | null } => {
  const config = readConfig(value);

  return {
    subtitle: typeof config['subtitle'] === 'string' && config['subtitle'].length > 0 ? config['subtitle'] : null,
    // 历史数据没有该字段时按「免费」处理：免费的默认值比付费更安全（不会把免费用户挡在门外）
    isFree: typeof config['isFree'] === 'boolean' ? config['isFree'] : true,
    requiredEntitlement:
      typeof config['requiredEntitlement'] === 'string' && config['requiredEntitlement'].length > 0
        ? config['requiredEntitlement']
        : null,
  };
};

/** 读取 `dimensionQuotas`（形如 `{ EI: 9, SN: 9 }`） */
const readQuotaEntries = (value: Prisma.JsonValue | null | undefined): { dimension: string; quota: number }[] => {
  const config = readConfig(value);
  const entries: { dimension: string; quota: number }[] = [];

  for (const [dimension, quota] of Object.entries(config)) {
    if (typeof quota === 'number' && Number.isInteger(quota) && quota > 0) {
      entries.push({ dimension, quota });
    }
  }

  return entries;
};

/**
 * 契约 `category` ← 数据模型
 *
 * 优先看 `scoringConfig.scoringModel`（唯一事实源），缺失时（历史数据）回落到 `category` 列。
 */
const toContractCategory = (category: TestCategory, scoringModel: TestScoringModel | null): TestDefinitionCategory => {
  if (scoringModel !== null) {
    return scoringModel === 'RELATIONSHIP_STYLE' ? 'RELATIONSHIP' : 'PERSONALITY';
  }

  return category === 'RELATIONSHIP_STYLE' ? 'RELATIONSHIP' : 'PERSONALITY';
};

/** 未提供 subtitle 时按「题量 · 时长」派生（与契约示例的文案格式一致） */
const deriveSubtitle = (questionCount: number, estimatedMinutes: number): string =>
  `${questionCount} 题 · 约 ${estimatedMinutes} 分钟`;

/** 保留指定小数位的四舍五入（避免 0.30000000000000004 这类浮点尾巴进入响应） */
const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

@Injectable()
export class AdminTestDefinitionService {
  private readonly logger = new Logger(AdminTestDefinitionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  // ==========================================================================
  // GET /api/v1/admin/test-definitions
  // ==========================================================================

  async list(query: ListTestDefinitionsQueryDto): Promise<TestDefinitionListResult> {
    const where: Prisma.TestDefinitionWhereInput = {
      // 软删除的定义对后台也应不可见：它们只是「删除留痕」，不是可运营数据
      deletedAt: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.category === undefined ? {} : { category: { in: [...DB_CATEGORIES_OF_CONTRACT[query.category]] } }),
    };

    const [total, definitions, summary] = await Promise.all([
      this.prisma.testDefinition.count({ where }),
      this.prisma.testDefinition.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        skip: query.skip,
        take: query.take,
        select: DEFINITION_SELECT,
      }),
      this.buildSummary(),
    ]);

    const ids = definitions.map((definition) => definition.id);
    const includeQuestionIds = query.includeQuestionIds === true;

    const [dimensionCounts, questionIdsByDefinition, sessionStats] = await Promise.all([
      this.countQuestionsByDimension(ids),
      includeQuestionIds ? this.loadQuestionIds(ids) : Promise.resolve(new Map<string, string[]>()),
      this.loadSessionStats(ids),
    ]);

    const items = definitions.map((definition) =>
      this.toListItem(definition, {
        dimensionCounts: dimensionCounts.get(definition.id) ?? new Map<string, number>(),
        questionIds: questionIdsByDefinition.get(definition.id),
        sessionStats: sessionStats.get(definition.id) ?? {
          totalSessions: 0,
          completedSessions: 0,
          completionRate: 0,
          averageMinutes: null,
        },
      }),
    );

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasNext: query.page * query.pageSize < total,
      summary,
    };
  }

  // ==========================================================================
  // POST /api/v1/admin/test-definitions
  // ==========================================================================

  /**
   * 新建测试定义
   *
   * 顺序刻意是「先校验 → 再落库 → 最后算就绪」：
   * 校验失败时不应留下任何痕迹（半成品定义会出现在后台列表里，且 `code` 唯一约束
   * 会让运营无法用同一个编码重试）。
   */
  async create(
    dto: CreateTestDefinitionDto,
    principalUserId: string,
    context: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<CreateTestDefinitionResult> {
    const admin = await this.loadAdminActor(principalUserId);
    const quotaEntries: { dimension: string; quota: number }[] =
      dto.quotaConfig?.map((item) => ({ dimension: item.dimension, quota: item.quota })) ?? [];

    // ------------------------------------------------- 语义校验
    this.assertScoringModelMatchesDimensions(
      dto.scoringModel,
      quotaEntries.map((entry) => entry.dimension),
    );

    const quotaTotal = quotaEntries.reduce((sum, entry) => sum + entry.quota, 0);
    if (quotaEntries.length > 0 && quotaTotal !== dto.questionCount) {
      // 契约把该情形记为 40011（500）；此处按「请求参数不合法」返回 400/10001 ——
      // 现有码表里 40011 已被 PERSONALITY_PROFILE_BUILDING（画像生成中）占用，复用它会串语义
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `quotaConfig 配额合计（${quotaTotal}）必须等于 questionCount（${dto.questionCount}）`,
        [{ field: 'quotaConfig', issue: `配额合计 ${quotaTotal} ≠ questionCount ${dto.questionCount}` }],
      );
    }

    const isFree = dto.isFree ?? true;

    if (!isFree && dto.requiredEntitlement === undefined) {
      // 契约错误码 40002（付费定义未声明权益）：现有码表 40002 = TEST_SESSION_NOT_FOUND，
      // 复用会串语义，因此用 10001 承载「参数组合不合法」
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        'isFree=false 时必须提供 requiredEntitlement（否则该定义无人可进入）',
        [{ field: 'requiredEntitlement', issue: '付费定义缺少所需权益' }],
      );
    }

    // 注意：不加 deletedAt 过滤 —— `code` 的唯一约束覆盖软删除行，软删除的编码同样不可复用
    const duplicated = await this.prisma.testDefinition.findFirst({
      where: { code: dto.code },
      select: { id: true },
    });

    if (duplicated !== null) {
      // 契约错误码 10012（409）；现有码表 10012 不存在，用语义一致的 RESOURCE_CONFLICT
      throw BusinessException.conflict(ErrorCode.RESOURCE_CONFLICT, `测试定义编码 ${dto.code} 已存在`);
    }

    const questions = await this.resolveQuestions(dto.questionIds);

    // ------------------------------------------------- 落库（含题目转移）
    const engineVersion = dto.engineVersion ?? ENGINE_VERSION;
    const subtitle = dto.subtitle !== undefined && dto.subtitle.length > 0 ? dto.subtitle : null;
    const isActive = dto.isActive === true;

    const created = await this.prisma.$transaction(async (tx) => {
      const definition = await tx.testDefinition.create({
        data: {
          code: dto.code,
          name: dto.name,
          category: DB_CATEGORY_OF_MODEL[dto.scoringModel],
          description: dto.description,
          version: dto.version,
          // 与 isActive 同步维护 status：运行期（TestService）用 `status = ACTIVE` 过滤，
          // 只写 isActive 会让「已启用」的定义在用户端仍然不可见
          status: isActive ? 'ACTIVE' : 'DRAFT',
          isActive,
          questionCount: dto.questionCount,
          estimatedMinutes: dto.estimatedMinutes,
          selectionMode: quotaEntries.length > 0 ? 'DIMENSION_QUOTA' : 'STATIC_SET',
          dimensionQuotas: quotaEntries.length > 0 ? this.toQuotaRecord(quotaEntries) : undefined,
          scoringConfig: { scoringModel: dto.scoringModel, engineVersion },
          resultTemplate: {
            subtitle,
            isFree,
            requiredEntitlement: isFree ? null : (dto.requiredEntitlement ?? null),
          },
          sortOrder: dto.sortOrder ?? 0,
          createdByAdminId: admin.adminId,
        },
        select: DEFINITION_SELECT,
      });

      /**
       * 显式题目集合在本数据模型里只有一个可表达的位置：`questions.test_definition_id`。
       * 没有「题目-定义」多对多表，因此只能**转移**这些题目到新定义名下 ——
       * 若改成「只校验不落库」，运营会看到「已配置 questionIds」而线上试卷里一道都没有，
       * 这类静默不生效比报错危险得多。
       */
      if (questions.length > 0) {
        await tx.question.updateMany({
          where: { id: { in: questions.map((question) => question.id) } },
          data: { testDefinitionId: definition.id },
        });
      }

      return definition;
    });

    const dimensionCounts = await this.countQuestionsByDimension([created.id]);
    // 新定义刚创建时可能还没有任何题目，此时按「空计数表」计算配额充足性（而非跳过校验）
    const createdCounts = dimensionCounts.get(created.id) ?? new Map<string, number>();
    const quotaConfig = this.buildQuotaConfig(created.dimensionQuotas, createdCounts);
    const readiness = this.buildReadiness({
      definition: created,
      quotaEntries,
      availableCount: this.sumCounts(createdCounts),
      isFree,
      requiredEntitlement: dto.requiredEntitlement ?? null,
      transferredFrom: this.describeTransferSources(questions),
    });

    const auditLogId = await this.writeCreateAudit(admin, created, quotaConfig, dto, context);

    this.logger.log(
      `新建测试定义 code=${created.code} admin=${admin.username} 题量=${created.questionCount} 就绪=${readiness.isReady}`,
    );

    return {
      testDefinitionId: created.id,
      code: created.code,
      name: created.name,
      version: created.version,
      category: toContractCategory(created.category, dto.scoringModel),
      questionCount: created.questionCount,
      estimatedMinutes: created.estimatedMinutes,
      scoringModel: dto.scoringModel,
      engineVersion,
      isFree,
      isActive: created.isActive,
      statusLabel: this.statusLabelOf(created.isActive),
      quotaConfig,
      readiness,
      createdAt: created.createdAt.toISOString(),
      createdBy: admin.displayName,
      auditLogId,
      /**
       * 用户端测试定义列表（`TestService.listDefinitions`）**没有缓存层**，
       * 每次请求直接查库，因此这里没有任何键需要失效 —— 返回 `false` 是事实，
       * 而不是「没做」。详情见交付说明中的契约差异清单。
       */
      cacheInvalidated: false,
      // 契约原文的下一步指引（PATCH 启用接口属于 §3.14.4 之外的接口，本次未实现）
      nextStep: '配置完成并确认 readiness.isReady 为 true 后，可调用 PATCH 将其启用（isActive=true）。',
    };
  }

  // ==========================================================================
  // 内部 — 查询辅助
  // ==========================================================================

  /** 统计各定义名下的启用题目数（按维度拆分，用于配额充足性判断） */
  private async countQuestionsByDimension(definitionIds: readonly string[]): Promise<Map<string, Map<string, number>>> {
    const result = new Map<string, Map<string, number>>();

    if (definitionIds.length === 0) return result;

    const rows = await this.prisma.question.groupBy({
      by: ['testDefinitionId', 'dimension'],
      where: { testDefinitionId: { in: [...definitionIds] }, isActive: true, deletedAt: null },
      _count: { _all: true },
    });

    for (const row of rows) {
      const byDimension = result.get(row.testDefinitionId) ?? new Map<string, number>();
      byDimension.set(row.dimension, row._count._all);
      result.set(row.testDefinitionId, byDimension);
    }

    return result;
  }

  /** 各定义的显式题目集合（仅 `includeQuestionIds=true` 时调用，避免无谓的大结果集） */
  private async loadQuestionIds(definitionIds: readonly string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();

    if (definitionIds.length === 0) return result;

    const rows = await this.prisma.question.findMany({
      where: { testDefinitionId: { in: [...definitionIds] }, isActive: true, deletedAt: null },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, testDefinitionId: true },
    });

    for (const row of rows) {
      const ids = result.get(row.testDefinitionId) ?? [];
      ids.push(row.id);
      result.set(row.testDefinitionId, ids);
    }

    return result;
  }

  /** 会话统计（两次聚合查询覆盖整页，避免每个定义两次 count 的 N+1） */
  private async loadSessionStats(definitionIds: readonly string[]): Promise<Map<string, SessionStatsView>> {
    const result = new Map<string, SessionStatsView>();

    if (definitionIds.length === 0) return result;

    const [statusRows, durationRows] = await Promise.all([
      this.prisma.testSession.groupBy({
        by: ['testDefinitionId', 'status'],
        where: { testDefinitionId: { in: [...definitionIds] }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.testSession.groupBy({
        by: ['testDefinitionId'],
        where: {
          testDefinitionId: { in: [...definitionIds] },
          deletedAt: null,
          status: { in: [...COMPLETED_SESSION_STATUSES] },
        },
        _avg: { durationMs: true },
      }),
    ]);

    const totalByDefinition = new Map<string, number>();
    const completedByDefinition = new Map<string, number>();

    for (const row of statusRows) {
      totalByDefinition.set(row.testDefinitionId, (totalByDefinition.get(row.testDefinitionId) ?? 0) + row._count._all);

      if ((COMPLETED_SESSION_STATUSES as readonly string[]).includes(row.status)) {
        completedByDefinition.set(
          row.testDefinitionId,
          (completedByDefinition.get(row.testDefinitionId) ?? 0) + row._count._all,
        );
      }
    }

    const avgDurationByDefinition = new Map<string, number | null>();
    for (const row of durationRows) {
      avgDurationByDefinition.set(row.testDefinitionId, row._avg.durationMs ?? null);
    }

    for (const definitionId of definitionIds) {
      const totalSessions = totalByDefinition.get(definitionId) ?? 0;
      const completedSessions = completedByDefinition.get(definitionId) ?? 0;
      const avgDurationMs = avgDurationByDefinition.get(definitionId) ?? null;

      result.set(definitionId, {
        totalSessions,
        completedSessions,
        // 无会话时完成率为 0（而不是 null）：该字段用于看板均值，null 会让前端求和变成 NaN
        completionRate: totalSessions === 0 ? 0 : round(completedSessions / totalSessions, 3),
        averageMinutes: avgDurationMs === null ? null : round(avgDurationMs / 60_000, 1),
      });
    }

    return result;
  }

  /** 全局汇总（与分页无关：契约示例中 `total=4` 而当前页只有 2 条） */
  private async buildSummary(): Promise<TestDefinitionListResult['summary']> {
    const [totalDefinitions, activeDefinitions, withQuota] = await Promise.all([
      this.prisma.testDefinition.count({ where: { deletedAt: null } }),
      this.prisma.testDefinition.count({ where: { deletedAt: null, isActive: true } }),
      this.prisma.testDefinition.findMany({
        where: { deletedAt: null, NOT: { dimensionQuotas: { equals: Prisma.DbNull } } },
        select: { id: true, dimensionQuotas: true },
      }),
    ]);

    if (withQuota.length === 0) {
      return { totalDefinitions, activeDefinitions, insufficientQuotaDefinitions: 0 };
    }

    const dimensionCounts = await this.countQuestionsByDimension(withQuota.map((row) => row.id));
    let insufficient = 0;

    for (const row of withQuota) {
      const byDimension = dimensionCounts.get(row.id) ?? new Map<string, number>();
      const entries = readQuotaEntries(row.dimensionQuotas);

      if (entries.some((entry) => (byDimension.get(entry.dimension) ?? 0) < entry.quota)) {
        insufficient += 1;
      }
    }

    return { totalDefinitions, activeDefinitions, insufficientQuotaDefinitions: insufficient };
  }

  /** 组装列表项 */
  private toListItem(
    definition: DefinitionRow,
    deps: {
      dimensionCounts: Map<string, number>;
      questionIds: string[] | undefined;
      sessionStats: SessionStatsView;
    },
  ): TestDefinitionListItem {
    const scoringModel = readScoringModel(definition.scoringConfig);
    const display = readResultTemplate(definition.resultTemplate);
    const quotaConfig = this.buildQuotaConfig(definition.dimensionQuotas, deps.dimensionCounts);

    return {
      testDefinitionId: definition.id,
      code: definition.code,
      name: definition.name,
      // 未显式配置副标题时按「题量 · 时长」派生：这两个数字是列表页最有用的信息，
      // 而空字符串会让前端卡片出现一块空白
      subtitle: display.subtitle ?? deriveSubtitle(definition.questionCount, definition.estimatedMinutes),
      category: toContractCategory(definition.category, scoringModel),
      version: definition.version,
      questionCount: definition.questionCount,
      estimatedMinutes: definition.estimatedMinutes,
      scoringModel,
      engineVersion: readEngineVersion(definition.scoringConfig),
      isActive: definition.isActive,
      isFree: display.isFree,
      requiredEntitlement: display.requiredEntitlement,
      sortOrder: definition.sortOrder,
      quotaConfig,
      // 字段仅在被显式要求时出现：它是「可能很长的 ID 数组」，默认不返回可显著减小响应体积
      ...(deps.questionIds === undefined ? {} : { questionIds: deps.questionIds }),
      sessionStats: deps.sessionStats,
      createdAt: definition.createdAt.toISOString(),
      updatedAt: definition.updatedAt.toISOString(),
    };
  }

  /** 组装维度配额视图（配额来自配置，可用题量来自题库实际统计） */
  private buildQuotaConfig(
    dimensionQuotas: Prisma.JsonValue | null | undefined,
    dimensionCounts: Map<string, number>,
  ): QuotaConfigView[] {
    return readQuotaEntries(dimensionQuotas).map((entry) => {
      const availableCount = dimensionCounts.get(entry.dimension) ?? 0;

      return {
        dimension: entry.dimension,
        quota: entry.quota,
        availableCount,
        // 契约业务规则 2：可用题量 ≥ 配额才算充足，任一维度不足即有抽题风险
        isSufficient: availableCount >= entry.quota,
      };
    });
  }

  // ==========================================================================
  // 内部 — 校验与推导
  // ==========================================================================

  /** 计分模型与维度必须匹配（契约业务规则 3），否则引擎会在算分阶段产出无意义结果 */
  private assertScoringModelMatchesDimensions(scoringModel: TestScoringModel, dimensions: readonly string[]): void {
    const allowed = ALLOWED_DIMENSIONS[scoringModel];
    const illegal = dimensions.filter((dimension) => !allowed.includes(dimension));

    if (illegal.length > 0) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `计分模型 ${scoringModel} 不支持维度 ${illegal.join(', ')}（允许：${allowed.join(', ')}）`,
        illegal.map((dimension) => ({
          field: 'quotaConfig.dimension',
          issue: `${dimension} 与 ${scoringModel} 不匹配`,
        })),
      );
    }
  }

  /**
   * 校验显式题目集合
   *
   * 两道门槛：① 必须存在且启用中；② 转移后不得让来源定义「题量不足」——
   * 后者是**跨定义的破坏性影响**，若不加判断，一次新建就能让另一个上架中的测试
   * 在运行期直接报 `40011`（用户侧表现为「测评暂时不可用」）。
   */
  private async resolveQuestions(
    questionIds: string[] | undefined,
  ): Promise<{ id: string; sourceCode: string | null }[]> {
    if (questionIds === undefined || questionIds.length === 0) return [];

    const uniqueIds = [...new Set(questionIds)];
    const rows = await this.prisma.question.findMany({
      where: { id: { in: uniqueIds }, isActive: true, deletedAt: null },
      select: { id: true, testDefinitionId: true },
    });

    if (rows.length !== uniqueIds.length) {
      const found = new Set(rows.map((row) => row.id));
      const missing = uniqueIds.filter((id) => !found.has(id));

      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `questionIds 中存在不存在或已停用的题目：${missing.join(', ')}`,
        missing.map((id) => ({ field: 'questionIds', issue: `${id} 不存在或已停用` })),
      );
    }

    const sourceIds = [...new Set(rows.map((row) => row.testDefinitionId))];
    const sources = await this.prisma.testDefinition.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, code: true, questionCount: true },
    });
    const sourceById = new Map(sources.map((source) => [source.id, source]));

    const movedBySource = new Map<string, number>();
    for (const row of rows) {
      movedBySource.set(row.testDefinitionId, (movedBySource.get(row.testDefinitionId) ?? 0) + 1);
    }

    const poolCounts = await this.countQuestionsByDimension(sourceIds);
    const broken: string[] = [];

    for (const [sourceId, moved] of movedBySource) {
      const source = sourceById.get(sourceId);
      if (source === undefined) continue;

      const remaining = this.sumCounts(poolCounts.get(sourceId) ?? new Map<string, number>()) - moved;

      if (remaining < source.questionCount) {
        broken.push(`${source.code}（剩余 ${remaining} 题 < 要求 ${source.questionCount} 题）`);
      }
    }

    if (broken.length > 0) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `抽取这些题目会使其他定义题量不足：${broken.join('；')}。请先补充题库或改用该定义已有题目。`,
        broken.map((detail) => ({ field: 'questionIds', issue: detail })),
      );
    }

    return rows.map((row) => ({ id: row.id, sourceCode: sourceById.get(row.testDefinitionId)?.code ?? null }));
  }

  /**
   * 组装就绪检查
   *
   * `blockers` 非空时**不允许启用**（契约业务规则 2）；`warnings` 只提示不拦截。
   * 判据取自**运行期实际行为**（`TestService.createSession` 按定义名下启用题目数下发试卷），
   * 而不是契约里尚未落地的维度配额抽题 —— 否则会出现「后台显示就绪、用户一点就报错」。
   */
  private buildReadiness(input: {
    definition: DefinitionRow;
    quotaEntries: { dimension: string; quota: number }[];
    availableCount: number;
    isFree: boolean;
    requiredEntitlement: string | null;
    transferredFrom: string[];
  }): ReadinessView {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const { definition, quotaEntries, availableCount } = input;

    if (availableCount < definition.questionCount) {
      blockers.push(
        `题目池可用 ${availableCount} 题，少于 questionCount=${definition.questionCount}（不足时用户创建会话会失败）`,
      );
    }

    if (quotaEntries.length > 0) {
      const total = quotaEntries.reduce((sum, entry) => sum + entry.quota, 0);

      if (total !== definition.questionCount) {
        blockers.push(`维度配额合计 ${total} 与 questionCount=${definition.questionCount} 不一致`);
      }

      if (total < definition.questionCount) {
        warnings.push('维度配额合计小于题量要求：按当前抽题实现会下发题量不足的试卷');
      }
    } else {
      warnings.push('未配置维度配额（STATIC_SET 模式）：试卷由该定义名下全部启用题目组成');
    }

    if (!input.isFree && input.requiredEntitlement === null) {
      blockers.push('付费定义缺少 requiredEntitlement：没有任何用户能满足准入条件');
    }

    if (input.transferredFrom.length > 0) {
      warnings.push(`显式题目集合已从其他定义转移：${input.transferredFrom.join('、')}（原定义题量已相应减少）`);
    }

    if (readEngineVersion(definition.scoringConfig) !== ENGINE_VERSION) {
      warnings.push(
        `engineVersion=${readEngineVersion(definition.scoringConfig)} 与当前引擎版本 ${ENGINE_VERSION} 不一致，历史结果解释需按该版本处理`,
      );
    }

    return { isReady: blockers.length === 0, blockers, warnings };
  }

  // ==========================================================================
  // 内部 — 审计与通用工具
  // ==========================================================================

  /** 读取管理员展示名（`nickname → realName → username`，与 AdminAuthService 的展示口径一致） */
  private async loadAdminActor(adminUserId: string): Promise<AdminActor> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
      select: { id: true, username: true, nickname: true, realName: true },
    });

    if (admin === null) {
      throw BusinessException.notFound(ErrorCode.ADMIN_NOT_FOUND, '管理员不存在');
    }

    return {
      adminId: admin.id,
      username: admin.username,
      displayName: admin.nickname ?? admin.realName ?? admin.username,
    };
  }

  /** 写审计并把审计记录 ID 回填给响应 */
  private async writeCreateAudit(
    admin: AdminActor,
    definition: DefinitionRow,
    quotaConfig: QuotaConfigView[],
    dto: CreateTestDefinitionDto,
    context: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<string | null> {
    const afterData = {
      code: definition.code,
      name: definition.name,
      version: definition.version,
      category: definition.category,
      questionCount: definition.questionCount,
      estimatedMinutes: definition.estimatedMinutes,
      scoringModel: dto.scoringModel,
      engineVersion: dto.engineVersion ?? ENGINE_VERSION,
      isFree: dto.isFree ?? true,
      requiredEntitlement: dto.requiredEntitlement ?? null,
      isActive: definition.isActive,
      quotaConfig,
      questionIds: dto.questionIds ?? [],
    };

    const ok = await this.audit.log({
      adminUserId: admin.adminId,
      adminUsername: admin.username,
      action: 'CREATE',
      resourceType: 'test_definition',
      resourceId: definition.id,
      beforeData: null,
      afterData: afterData as unknown as Prisma.InputJsonValue,
      diffSummary: `新建测试定义 ${definition.code}（${definition.name}）题量 ${definition.questionCount}`,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
      success: true,
    });

    return ok ? this.findLatestAuditLogId(admin.adminId, 'test_definition', definition.id) : null;
  }

  /**
   * 取最近一条审计记录 ID
   *
   * `AdminAuditService.log` 只返回「是否写入成功」，不返回主键；而契约要求响应里带
   * `auditLogId`。审计服务属于共享文件（本次改动范围之外，不可修改），
   * 因此这里按「管理员 + 资源」回查最近一条 —— 同一管理员对同一资源的写操作
   * 请求级串行，回查结果即本次写入的那条。
   */
  private async findLatestAuditLogId(
    adminUserId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<string | null> {
    const row = await this.prisma.adminAuditLog.findFirst({
      where: { adminUserId, resourceType, resourceId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row?.id ?? null;
  }

  /** 配额项 → `dimension_quotas` 的存储形态（`{ 维度: 配额 }`） */
  private toQuotaRecord(entries: readonly { dimension: string; quota: number }[]): Record<string, number> {
    const record: Record<string, number> = {};

    for (const entry of entries) {
      record[entry.dimension] = entry.quota;
    }

    return record;
  }

  /** 维度计数求和 */
  private sumCounts(counts: Map<string, number>): number {
    let sum = 0;
    for (const count of counts.values()) sum += count;
    return sum;
  }

  /** 题目来源定义编码（去重，用于就绪提示） */
  private describeTransferSources(questions: readonly { sourceCode: string | null }[]): string[] {
    const codes = new Set<string>();

    for (const question of questions) {
      if (question.sourceCode !== null) codes.add(question.sourceCode);
    }

    return [...codes];
  }

  /** 启用状态文案（契约 §3.14.4.2 `statusLabel`） */
  private statusLabelOf(isActive: boolean): string {
    return isActive ? '已启用' : '未启用（草稿）';
  }
}
