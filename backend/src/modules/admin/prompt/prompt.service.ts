/**
 * AdminPromptService — 管理端 Prompt 管理服务
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.5（7 个接口）+ ADR-014（Prompt 存数据库 + 版本化）
 *
 * ## 与运行期的衔接（本文件最重要的约束）
 *
 * 运行期取版本的逻辑在 `ai/prompt/prompt.service.ts` 的 `resolveVersion`：
 *
 * ```
 * ① template.activeVersionId 非空 → **钉住**该版本，直接使用（不看 trafficWeight）
 * ② activeVersionId 为空        → 在 status = ACTIVE 的版本里按 trafficWeight 加权随机
 * ```
 *
 * 由此推出两条本服务必须遵守的规则，否则会出现「后台显示已发布、线上仍用旧版本」：
 *
 * 1. **`FULL` 发布必须把 `activeVersionId` 指向新版本**，并把其他 `ACTIVE` 版本归档
 *    （否则钉住指针仍指旧版本，权重改了也不会生效）。
 * 2. **`AB_TEST` 发布必须把 `activeVersionId` 置为 `null`** —— 只要指针非空，
 *    运行期就走「钉住」分支，权重分流形同虚设。契约示例里 `activeVersionId` 非空
 *    却同时展示 AB 变体，那是契约与运行期不一致之处（已在交付说明中标注）。
 *
 * ## 缓存失效
 *
 * 运行期只缓存**版本内容**，键为 `{keyPrefix}:prompt:version:{versionId}`（TTL 1h），
 * 且「哪个版本生效」的指针查询**不缓存**（见 `ai/prompt/prompt.service.ts` 头注释）。
 * 因此发布/回滚后需要失效的不是「模板」而是**受影响的版本内容**，
 * 这里通过 `PromptService.invalidateVersion()` 完成 —— 复用运行期自己的键构造，
 * 不在这里重复拼 key（拼错就会静默失效失败）。
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PromptType } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { estimateCostCents } from '../../ai/provider/llm-pricing';
import type { LlmProviderName, LlmUsage } from '../../ai/provider/llm-provider.types';
import { PromptService } from '../../ai/prompt/prompt.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import type {
  CreatePromptTemplateDto,
  CreatePromptVersionDto,
  ListPromptsQueryDto,
  PromptDetailQueryDto,
  PromptModelValue,
  PromptTypeValue,
  PublishPromptVersionDto,
  PublishMode,
  RenderMode,
  RevertWindow,
  RollbackPromptVersionDto,
  TestRenderPromptDto,
} from './dto/prompt.dto';
import {
  CONDITIONAL_LIMITATION,
  estimateTokens,
  extractVariableReferences,
  inspectBoundaryRules,
  inspectInjectionGuard,
  parseDeclaredVariables,
  renderPromptPreview,
  type ConditionalBlockResult,
} from './prompt-preview';
import {
  buildVersionStatusLabel,
  CANARY_TRAFFIC_WEIGHT,
  planAbTestPublish,
  planFullPublish,
  TOTAL_TRAFFIC_WEIGHT,
  type PromptVersionStatusValue,
} from './prompt-version-planner';

/** 版本内容缓存键前缀（与运行期 `ai/prompt/prompt.service.ts` 的常量保持一致） */
const VERSION_CACHE_PREFIX = 'prompt:version';

/** 版本内容缓存时长（秒）；取值与运行期常量一致，用于 `cacheStatus.ttlSeconds` 的回退值 */
const VERSION_CACHE_TTL_SECONDS = 3600;

/**
 * 分流方式
 *
 * ⚠ 契约写的是 `CONSISTENT_HASH_USER_ID`，但运行期的加权选择用的是 `Math.random`
 * （`selectWeightedVersion` 的随机源）—— **没有按 userId 做一致性哈希**。
 * 这里如实返回实际行为：若按契约回显，运营会以为「同一用户始终看到同一版本」，
 * 从而用错误的假设去解读 AB 结果。
 */
const BUCKETING_METHOD = 'RANDOM_WEIGHTED';

/** 统计窗口（契约字段名即 `*7d`） */
const STATS_WINDOW_DAYS = 7;

/** 版本号自增的并发重试次数 */
const VERSION_CREATE_MAX_ATTEMPTS = 3;

/** 模型 → Provider（运行期据 `provider` 决定厂商，缺省则由配置兜底） */
const MODEL_PROVIDER: Readonly<Record<PromptModelValue, LlmProviderName>> = {
  'deepseek-chat': 'DEEPSEEK',
  'deepseek-reasoner': 'DEEPSEEK',
  'gpt-4o-mini': 'OPENAI',
  'qwen-plus': 'QWEN',
  'qwen-turbo': 'QWEN',
};

/** 模板类型中文名（契约 `typeName`） */
const PROMPT_TYPE_NAMES: Readonly<Record<PromptTypeValue, string>> = {
  MBTI_REPORT: 'MBTI 深度报告',
  RELATIONSHIP_REPORT: '关系匹配报告',
  AI_COMPANION: 'AI 情感助手',
  EMOTION_ANALYSIS: '情绪与成长分析',
  SYSTEM_SAFETY: '系统安全护栏',
};

/** 管理端操作者 */
export interface AdminActor {
  adminId: string;
  username: string;
  displayName: string;
}

/** 版本统计（列表与详情共用） */
export interface PromptVersionStatsView {
  callCount7d: number;
  successRate7d: number | null;
  avgLatencyMs: number | null;
  avgCompletionTokens: number | null;
  avgCostCents: number | null;
}

/** 版本详情统计（在基础统计上追加两个质量信号） */
export interface PromptVersionDetailStatsView extends PromptVersionStatsView {
  schemaValidationFailureRate: number | null;
  userRegenerateRate: number | null;
}

/** 模板统计（契约列表项的 `stats`） */
export interface PromptTemplateStatsView extends PromptVersionStatsView {
  userSatisfactionRate: number | null;
}

/** 版本摘要（`POST /prompts` 的 `versions[]`） */
export interface PromptVersionSummaryView {
  versionId: string;
  version: number;
  status: PromptVersionStatusValue;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  trafficWeight: number;
  hasOutputSchema: boolean;
  createdAt: string;
  createdBy: string;
}

/** 版本详情（`GET /prompts/{key}` 的 `versions[]`） */
export interface PromptVersionDetailView {
  versionId: string;
  version: number;
  status: PromptVersionStatusValue;
  statusLabel: string;
  systemPrompt: string | null;
  userPromptTemplate: string | null;
  variables: unknown;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  outputSchema: unknown;
  trafficWeight: number;
  publishedAt: string | null;
  publishedBy: string | null;
  publishedByName: string | null;
  changeNote: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  stats: PromptVersionDetailStatsView | null;
}

/** AB 变体 */
export interface AbTestVariantView {
  versionId: string;
  version: number;
  trafficWeight: number;
  isActive: boolean;
  callCount7d?: number;
  successRate7d?: number | null;
}

/** 列表项 */
export interface PromptTemplateListItem {
  templateId: string;
  key: string;
  type: PromptTypeValue;
  typeName: string;
  description: string | null;
  activeVersionId: string | null;
  activeVersion: number | null;
  activeVersionStatus: PromptVersionStatusValue | null;
  versionCount: number;
  draftVersionCount: number;
  abTest: { enabled: boolean; variants: AbTestVariantView[]; bucketingMethod: string | null };
  defaultModel: string | null;
  defaultTemperature: number | null;
  defaultMaxTokens: number | null;
  hasOutputSchema: boolean;
  variables: string[];
  stats: PromptTemplateStatsView;
  updatedAt: string;
  updatedBy: string | null;
  lastPublishedAt: string | null;
  lastPublishedBy: string | null;
}

/** 列表结果 */
export interface PromptListResult {
  items: PromptTemplateListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: {
    totalTemplates: number;
    templatesWithAbTest: number;
    templatesWithoutActiveVersion: number;
    cacheTtlSeconds: number;
  };
}

/** 变量校验视图（新增模板时使用数组形态，契约示例如此） */
export interface VariableValidationView {
  variableSchemaValid: boolean;
  declaredVariables: string[];
  usedVariables: string[];
  undeclaredVariablesUsed: string[];
  unusedDeclaredVariables: string[];
  warning: string | null;
}

/** 变量校验视图（新增版本时使用计数形态，契约示例如此） */
export interface VariableValidationCountView {
  variableSchemaValid: boolean;
  declaredVariables: number;
  usedVariables: number;
  undeclaredVariablesUsed: string[];
  unusedDeclaredVariables: string[];
  injectionGuardPresent: boolean;
  injectionGuardDetail: string | null;
  boundaryRulesPresent: boolean;
  boundaryRulesDetail: string | null;
  estimatedPromptTokens: number;
  warning: string | null;
}

/** 新建模板结果 */
export interface CreatePromptTemplateResult {
  templateId: string;
  key: string;
  type: PromptTypeValue;
  typeName: string;
  description: string;
  activeVersionId: string | null;
  activeVersion: number | null;
  versionCount: number;
  draftVersionCount: number;
  versions: PromptVersionSummaryView[];
  validation: VariableValidationView;
  readiness: { isReady: boolean; blockers: string[]; note: string };
  createdAt: string;
  createdBy: string;
  auditLogId: string | null;
  cacheInvalidated: boolean;
}

/** 新建版本结果 */
export interface CreatePromptVersionResult {
  templateKey: string;
  versionId: string;
  version: number;
  status: PromptVersionStatusValue;
  statusLabel: string;
  clonedFromVersionId: string | null;
  clonedFromVersion: number | null;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  trafficWeight: number;
  hasOutputSchema: boolean;
  changeNote: string;
  validation: VariableValidationCountView;
  createdAt: string;
  createdBy: string;
  auditLogId: string | null;
  nextStep: string;
}

/** 发布结果 */
export interface PublishPromptVersionResult {
  templateKey: string;
  templateId: string;
  previousActiveVersionId: string | null;
  previousActiveVersion: number | null;
  newActiveVersionId: string;
  newActiveVersion: number;
  mode: PublishMode;
  trafficWeight: number;
  abTest: { enabled: boolean; variants: { versionId: string; version: number; trafficWeight: number }[] };
  archivedVersions: { versionId: string; version: number; status: PromptVersionStatusValue }[];
  cacheInvalidation: { invalidatedKeys: string[]; mode: 'ACTIVE_DEL'; note: string };
  publishedAt: string;
  publishedBy: { adminId: string; displayName: string };
  impactAssessment: {
    affectsNewCallsOnly: boolean;
    inFlightCallsUnaffected: boolean;
    cachedReportsUnaffected: boolean;
    cacheKeyImpact: string;
    monitoringSuggestion: string;
  };
  auditLogId: string | null;
  nextStep: string;
}

/** 回滚结果 */
export interface RollbackPromptVersionResult {
  templateKey: string;
  templateId: string;
  rolledBackFromVersionId: string | null;
  rolledBackFromVersion: number | null;
  restoredVersionId: string;
  restoredVersion: number;
  currentActiveVersionId: string | null;
  currentActiveVersion: number | null;
  revertWindow: RevertWindow;
  reason: string;
  versionStatusChanges: {
    versionId: string;
    version: number;
    from: PromptVersionStatusValue;
    to: PromptVersionStatusValue;
    note?: string;
  }[];
  cacheInvalidation: { invalidatedKeys: string[]; note: string };
  metricsSnapshot: {
    [versionKey: string]: unknown;
    regressionDetected: boolean | null;
    regressionDetail: string;
  };
  alertScheduled: boolean;
  alertWindowMinutes: number;
  rolledBackAt: string;
  rolledBackBy: { adminId: string; displayName: string };
  auditLogId: string | null;
}

/** 版本详情视图 */
export interface PromptDetailResult {
  templateId: string;
  key: string;
  type: PromptTypeValue;
  typeName: string;
  description: string | null;
  activeVersionId: string | null;
  activeVersion: number | null;
  cacheKeyPattern: string;
  abTest: { enabled: boolean; bucketingMethod: string | null; variants: AbTestVariantView[] };
  versions: PromptVersionDetailView[];
  totalVersions: number;
  activeVersionCount: number;
  draftVersionCount: number;
  archivedVersionCount: number;
  cacheStatus: { cachedKeys: string[]; ttlSeconds: number; lastInvalidatedAt: string | null };
  updatedAt: string;
}

/** 预览结果 */
export interface TestRenderResult {
  templateKey: string;
  versionId: string;
  version: number;
  versionStatus: PromptVersionStatusValue;
  mode: RenderMode;
  renderedAt: string;
  rendered: {
    systemPrompt: string;
    userPrompt: string;
    model: string | null;
    temperature: number | null;
    maxTokens: number | null;
    jsonMode: boolean;
  };
  validation: {
    isValid: boolean;
    missingRequiredVariables: string[];
    extraVariables: string[];
    conditionalBlocks: ConditionalBlockResult[];
    typeCheckResults: { variable: string; expected: string; actual: string; passed: boolean }[];
    errors: { code: string; message: string; severity: string }[];
    warnings: { code: string; message: string; severity: string }[];
  };
  injectionGuard: {
    delimitersPresent: boolean;
    delimiterPairs: string[];
    instructionGuardPresent: boolean;
    guardText: string | null;
    freeTextEscaped: boolean;
    note: string;
  };
  tokenEstimate: {
    systemPromptTokens: number;
    userPromptTokens: number;
    totalInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostCents: number;
    note: string;
  };
  actualCallResult: null;
  note: string;
}

/** 版本行（落库后回读时的列集合） */
const VERSION_SELECT = {
  id: true,
  templateId: true,
  version: true,
  systemPrompt: true,
  userPromptTemplate: true,
  variables: true,
  outputSchema: true,
  model: true,
  provider: true,
  temperature: true,
  maxTokens: true,
  status: true,
  trafficWeight: true,
  changeNote: true,
  publishedAt: true,
  publishedById: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PromptVersionSelect;

type VersionRow = Prisma.PromptVersionGetPayload<{ select: typeof VERSION_SELECT }>;

/** 模板 + 版本（详情与校验的常用输入） */
const TEMPLATE_SELECT = {
  id: true,
  key: true,
  name: true,
  type: true,
  description: true,
  activeVersionId: true,
  isActive: true,
  createdByAdminId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PromptTemplateSelect;

type TemplateRow = Prisma.PromptTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>;

/** 是否为「普通对象」 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 把 `Prisma.JsonValue` 原样透传为响应字段（形状由调用方解释） */
const asJson = (value: Prisma.JsonValue | null): unknown => value;

/** 类型检查用的 JSON Schema 基础类型 */
const CHECKABLE_TYPES = ['string', 'number', 'integer', 'boolean'] as const;

/** JS 值 → JSON Schema 类型名（用于 `typeCheckResults.actual`） */
const actualTypeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};

@Injectable()
export class AdminPromptService {
  private readonly logger = new Logger(AdminPromptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AdminAuditService,
    /**
     * 运行期的 Prompt 服务
     *
     * 只为 `invalidateVersion()` 而注入：缓存键的构造与 TTL 都在运行期实现里，
     * 后台自己拼一遍 key 等于把「同一个约定」写了两份，任何一次改动都会让它静默失配。
     */
    private readonly prompts: PromptService,
  ) {}

  // ==========================================================================
  // GET /api/v1/admin/prompts
  // ==========================================================================

  async list(query: ListPromptsQueryDto): Promise<PromptListResult> {
    const keyword = query.keyword?.trim();
    const abTemplateIds = query.hasAbTest === true ? await this.findAbTestTemplateIds() : null;

    const where: Prisma.PromptTemplateWhereInput = {
      deletedAt: null,
      ...(query.type === undefined ? {} : { type: { in: query.type as PromptType[] } }),
      ...(keyword === undefined || keyword.length === 0
        ? {}
        : {
            OR: [
              { key: { contains: keyword, mode: 'insensitive' } },
              { description: { contains: keyword, mode: 'insensitive' } },
            ],
          }),
      ...(abTemplateIds === null ? {} : { id: { in: abTemplateIds } }),
    };

    const [total, templates, summary] = await Promise.all([
      this.prisma.promptTemplate.count({ where }),
      this.prisma.promptTemplate.findMany({
        where,
        // 最近改动优先：后台列表的第一诉求是「我刚改的那个」而不是字典序
        orderBy: [{ updatedAt: 'desc' }, { key: 'asc' }],
        skip: query.skip,
        take: query.take,
        select: TEMPLATE_SELECT,
      }),
      this.buildSummary(),
    ]);

    const versionsByTemplate = await this.loadVersions(templates.map((template) => template.id));
    const adminNames = await this.loadAdminNames(this.collectAdminIds(templates, versionsByTemplate));
    const versionStats = await this.loadVersionStats(
      [...versionsByTemplate.values()].flat().map((version) => version.id),
    );

    const items = templates.map((template) =>
      this.toListItem(template, versionsByTemplate.get(template.id) ?? [], versionStats, adminNames),
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
  // POST /api/v1/admin/prompts
  // ==========================================================================

  async createTemplate(
    dto: CreatePromptTemplateDto,
    principalUserId: string,
    context: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<CreatePromptTemplateResult> {
    const admin = await this.loadAdminActor(principalUserId);

    // 唯一约束覆盖软删除行，因此这里不加 deletedAt 过滤
    const duplicated = await this.prisma.promptTemplate.findFirst({ where: { key: dto.key }, select: { id: true } });

    if (duplicated !== null) {
      // 契约错误码 10012（409）；现有码表无 10012，用语义一致的 RESOURCE_CONFLICT
      throw BusinessException.conflict(ErrorCode.RESOURCE_CONFLICT, `Prompt 模板 key「${dto.key}」已存在`);
    }

    const initial = dto.initialVersion;
    const initialValidation = initial === undefined ? null : this.validateVariables(initial);

    if (initialValidation !== null && initialValidation.undeclaredVariablesUsed.length > 0) {
      throw this.variableMismatchError(initialValidation.undeclaredVariablesUsed);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const template = await tx.promptTemplate.create({
        data: {
          key: dto.key,
          // 契约没有 `name` 字段，但数据模型该列 NOT NULL —— 用「类型中文名（key）」派生，
          // 至少让列表里不出现空名称，且运营一眼能看出它属于哪一类
          name: this.deriveTemplateName(dto),
          type: dto.type,
          description: dto.description,
          isActive: true,
          createdByAdminId: admin.adminId,
        },
        select: TEMPLATE_SELECT,
      });

      /**
       * 首个版本与模板**在同一事务**内创建：
       * 分两次写会出现「模板建好了、版本没建成」的中间态，而模板没有版本时
       * 运行期调用会直接失败（`50011`），运营还得回来手工补一个版本。
       * 版本号固定为 1（新模板不存在并发取号问题）。
       */
      const version =
        initial === undefined
          ? null
          : await tx.promptVersion.create({
              data: { ...this.buildVersionFields(initial), templateId: template.id, version: 1 },
              select: VERSION_SELECT,
            });

      return { template, version };
    });

    const versions = created.version === null ? [] : [created.version];
    const validation: VariableValidationView =
      initialValidation === null
        ? {
            variableSchemaValid: true,
            declaredVariables: [],
            usedVariables: [],
            undeclaredVariablesUsed: [],
            unusedDeclaredVariables: [],
            warning: null,
          }
        : {
            variableSchemaValid: initialValidation.variableSchemaValid,
            declaredVariables: initialValidation.declaredVariables,
            usedVariables: initialValidation.usedVariables,
            undeclaredVariablesUsed: initialValidation.undeclaredVariablesUsed,
            unusedDeclaredVariables: initialValidation.unusedDeclaredVariables,
            warning: initialValidation.warning,
          };

    const auditLogId = await this.writeAudit({
      admin,
      action: 'CREATE',
      resourceId: created.template.id,
      beforeData: null,
      afterData: {
        key: created.template.key,
        type: created.template.type,
        description: created.template.description,
        versionCount: versions.length,
      },
      diffSummary: `新建 Prompt 模板 ${created.template.key}（含首个 DRAFT 版本：${versions.length > 0}）`,
      context,
    });

    return {
      templateId: created.template.id,
      key: created.template.key,
      type: created.template.type,
      typeName: PROMPT_TYPE_NAMES[created.template.type],
      description: created.template.description ?? dto.description,
      activeVersionId: created.template.activeVersionId,
      activeVersion: versions.length > 0 ? versions[0].version : null,
      versionCount: versions.length,
      draftVersionCount: versions.filter((version) => version.status === 'DRAFT').length,
      versions: versions.map((version) => this.toVersionSummary(version, admin.displayName)),
      validation,
      readiness: {
        // 模板本身创建成功，但**尚未生效**：需要显式 publish（防误发布）
        isReady: validation.undeclaredVariablesUsed.length === 0,
        blockers: validation.undeclaredVariablesUsed.map((name) => `模板使用了未声明的变量：${name}`),
        note: '模板已创建，首个版本为 DRAFT 状态；需通过 publish 接口发布后才会生效。',
      },
      createdAt: created.template.createdAt.toISOString(),
      createdBy: admin.displayName,
      auditLogId,
      /**
       * 新建模板不涉及任何缓存：运行期只按 `versionId` 缓存**版本内容**，
       * 而此刻没有任何版本被发布，也就不存在需要失效的键 —— 返回 `false` 是事实。
       */
      cacheInvalidated: false,
    };
  }

  // ==========================================================================
  // GET /api/v1/admin/prompts/{key}
  // ==========================================================================

  async getDetail(key: string, query: PromptDetailQueryDto): Promise<PromptDetailResult> {
    const template = await this.loadTemplate(key);
    const allVersions = await this.loadVersions([template.id]).then((map) => map.get(template.id) ?? []);

    const versions =
      query.version === undefined ? allVersions : allVersions.filter((version) => version.version === query.version);

    if (query.version !== undefined && versions.length === 0) {
      throw this.versionNotFound(key, query.version);
    }

    const includeContent = query.includeContent !== false;
    const adminNames = await this.loadAdminNames(this.collectAdminIds([template], new Map([[template.id, versions]])));
    const stats = await this.loadVersionStats(versions.map((version) => version.id));
    const cacheStatus = await this.buildCacheStatus(versions);

    const activeVersion = allVersions.find((version) => version.id === template.activeVersionId) ?? null;
    const abEnabled = this.isAbTestEnabled(template.activeVersionId, allVersions);

    return {
      templateId: template.id,
      key: template.key,
      type: template.type,
      typeName: PROMPT_TYPE_NAMES[template.type],
      description: template.description,
      activeVersionId: template.activeVersionId,
      activeVersion: activeVersion?.version ?? null,
      // 真实缓存键形状（运行期按版本内容缓存），不是契约示例里的 `prompt:{key}:{version}`
      cacheKeyPattern: `${this.redis.key(VERSION_CACHE_PREFIX)}:{versionId}`,
      abTest: {
        enabled: abEnabled,
        bucketingMethod: abEnabled ? BUCKETING_METHOD : null,
        variants: abEnabled ? this.buildAbVariants(allVersions, stats, true) : [],
      },
      versions: versions.map((version) =>
        this.toVersionDetail(version, stats.get(version.id), adminNames, includeContent),
      ),
      totalVersions: allVersions.length,
      activeVersionCount: allVersions.filter((version) => version.status === 'ACTIVE').length,
      draftVersionCount: allVersions.filter((version) => version.status === 'DRAFT').length,
      archivedVersionCount: allVersions.filter((version) => version.status === 'ARCHIVED').length,
      cacheStatus,
      updatedAt: this.latestActivityAt(template, allVersions).toISOString(),
    };
  }

  // ==========================================================================
  // POST /api/v1/admin/prompts/{key}/versions
  // ==========================================================================

  async createVersion(
    key: string,
    dto: CreatePromptVersionDto,
    principalUserId: string,
    context: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<CreatePromptVersionResult> {
    const template = await this.loadTemplate(key);
    const admin = await this.loadAdminActor(principalUserId);

    // 校验必须在落库**之前**：带病版本一旦入库，后续只会在发布时被拦，
    // 而库里会留下一堆无法发布的版本，运营难以分辨
    const validation = this.validateVariables(dto);

    if (validation.undeclaredVariablesUsed.length > 0) {
      throw this.variableMismatchError(validation.undeclaredVariablesUsed);
    }

    const clone =
      dto.cloneFromVersionId === undefined
        ? null
        : await this.prisma.promptVersion.findFirst({
            where: { id: dto.cloneFromVersionId, templateId: template.id },
            select: VERSION_SELECT,
          });

    if (dto.cloneFromVersionId !== undefined && clone === null) {
      // 契约：`cloneFromVersionId` 不属于该模板同样按「不存在」处理（不泄露其他模板的版本是否存在）
      throw BusinessException.notFound(
        ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND,
        `版本 ${dto.cloneFromVersionId} 不存在于模板 ${key}`,
      );
    }

    const created = await this.createVersionWithRetry(template.id, {
      ...this.mergeClone(dto, clone),
      status: 'DRAFT',
      // 契约：新版本默认不参与流量（schema 默认值是 100，必须显式覆盖）
      trafficWeight: dto.trafficWeight ?? 0,
    });
    const auditLogId = await this.writeAudit({
      admin,
      action: 'CREATE',
      resourceId: created.id,
      beforeData: clone === null ? null : this.versionSnapshot(clone),
      afterData: this.versionSnapshot(created),
      diffSummary: `新建 Prompt 版本 ${key} v${created.version}（${dto.changeNote}）`,
      context,
    });

    this.logger.log(
      `新建 Prompt 版本 key=${key} v=${created.version} 变量校验=${validation.variableSchemaValid} admin=${admin.username}`,
    );

    return {
      templateKey: template.key,
      versionId: created.id,
      version: created.version,
      status: 'DRAFT',
      statusLabel: buildVersionStatusLabel('DRAFT', created.trafficWeight),
      clonedFromVersionId: clone?.id ?? null,
      clonedFromVersion: clone?.version ?? null,
      model: created.model,
      temperature: created.temperature,
      maxTokens: created.maxTokens,
      trafficWeight: created.trafficWeight,
      hasOutputSchema: created.outputSchema !== null,
      changeNote: dto.changeNote,
      validation: {
        variableSchemaValid: validation.variableSchemaValid,
        declaredVariables: validation.declaredVariables.length,
        usedVariables: validation.usedVariables.length,
        undeclaredVariablesUsed: validation.undeclaredVariablesUsed,
        unusedDeclaredVariables: validation.unusedDeclaredVariables,
        injectionGuardPresent: validation.injectionGuardPresent,
        injectionGuardDetail: validation.injectionGuardDetail,
        boundaryRulesPresent: validation.boundaryRulesPresent,
        boundaryRulesDetail: validation.boundaryRulesDetail,
        estimatedPromptTokens: validation.estimatedPromptTokens,
        warning: validation.warning,
      },
      createdAt: created.createdAt.toISOString(),
      createdBy: admin.displayName,
      auditLogId,
      nextStep: `可在发布前通过 POST /api/v1/admin/prompts/${template.key}/test-render 预演渲染效果。`,
    };
  }

  // ==========================================================================
  // POST /api/v1/admin/prompts/{key}/versions/{versionId}/publish
  // ==========================================================================

  async publish(
    key: string,
    versionId: string,
    dto: PublishPromptVersionDto,
    principalUserId: string,
    context: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<PublishPromptVersionResult> {
    const admin = await this.loadAdminActor(principalUserId);
    const mode: PublishMode = dto.mode ?? 'FULL';
    const target = await this.loadVersionOfTemplate(key, versionId);

    // 带病版本禁止发布：变量声明与模板占位符不一致时，线上会在渲染阶段直接失败
    const validation = this.validateVariables({
      systemPrompt: target.systemPrompt,
      userPromptTemplate: target.userPromptTemplate,
      variables: isRecord(target.variables) ? target.variables : null,
    });

    if (validation.undeclaredVariablesUsed.length > 0) {
      throw BusinessException.internal(
        ErrorCode.AI_PROMPT_VARIABLE_MISSING,
        `版本 v${target.version} 使用了未声明的变量，禁止发布：${validation.undeclaredVariablesUsed.join(', ')}`,
      );
    }

    if (mode === 'AB_TEST' && dto.trafficWeight === undefined) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'AB_TEST 模式必须提供 trafficWeight（1–100）');
    }

    const publishedAt = new Date();

    const outcome = await this.prisma.$transaction(async (tx) => {
      // 串行化同一模板的并发发布：先读后写如果没有行锁，两次并发发布可能各自归档对方，
      // 最终留下两个权重 100 的 ACTIVE 版本（运行期就只能靠随机挑一个了）
      await this.lockTemplate(tx, target.templateId);

      const template = await tx.promptTemplate.findUniqueOrThrow({
        where: { id: target.templateId },
        select: { key: true, activeVersionId: true },
      });

      const versions = await tx.promptVersion.findMany({
        where: { templateId: target.templateId },
        select: { id: true, version: true, status: true, trafficWeight: true, publishedAt: true },
      });

      const previousActive = versions.find((version) => version.id === template.activeVersionId) ?? null;
      const otherActive = versions.filter((version) => version.status === 'ACTIVE' && version.id !== target.id);

      if (mode === 'AB_TEST' && otherActive.length === 0) {
        // 权重合计必须为 100；没有其他 ACTIVE 版本时无法构成 AB —— 明确拒绝，
        // 而不是把权重悄悄抬到 100（那样「AB 测试」名不副实，运营会以为在做实验）
        throw BusinessException.badRequest(
          ErrorCode.PARAM_INVALID,
          'AB_TEST 模式需要至少一个其他 ACTIVE 版本参与分流；只有一个候选时请使用 FULL 模式',
        );
      }

      const plan =
        mode === 'FULL'
          ? planFullPublish({
              targetVersionId: target.id,
              otherActiveVersionIds: otherActive.map((version) => version.id),
              archiveOtherActive: dto.archiveOtherActive !== false,
            })
          : planAbTestPublish({
              targetVersionId: target.id,
              trafficWeight: dto.trafficWeight ?? 0,
              others: otherActive.map((version) => ({ versionId: version.id, trafficWeight: version.trafficWeight })),
            });

      await tx.promptVersion.update({
        where: { id: target.id },
        data: {
          status: 'ACTIVE',
          trafficWeight: plan.activate.trafficWeight,
          publishedAt,
          publishedById: admin.adminId,
          archivedAt: null,
          ...(dto.changeNote === undefined ? {} : { changeNote: dto.changeNote }),
        },
      });

      const archived: { versionId: string; version: number; status: PromptVersionStatusValue }[] = [];

      for (const other of plan.others) {
        const archive = 'archived' in other && other.archived === true;

        await tx.promptVersion.update({
          where: { id: other.versionId },
          data: {
            trafficWeight: other.trafficWeight,
            ...(archive ? { status: 'ARCHIVED' as const, archivedAt: publishedAt } : {}),
          },
        });

        if (archive) {
          const info = versions.find((version) => version.id === other.versionId);
          if (info !== undefined) {
            archived.push({ versionId: info.id, version: info.version, status: 'ARCHIVED' });
          }
        }
      }

      /**
       * 生效指针：
       *   · FULL     → 指向新版本（运行期「钉住」分支，保证全量切换）
       *   · AB_TEST  → 置 null，让运行期走「按 ACTIVE 版本加权」分支
       *     （指针非空时权重分流不生效，这是运行期 `resolveVersion` 的既定行为）
       */
      await tx.promptTemplate.update({
        where: { id: target.templateId },
        data: { activeVersionId: mode === 'FULL' ? target.id : null },
      });

      return {
        templateKey: template.key,
        previousActiveVersionId: previousActive?.id ?? null,
        previousActiveVersion: previousActive?.version ?? null,
        archived,
        affectedVersionIds: [target.id, previousActive?.id, ...plan.others.map((other) => other.versionId)].filter(
          (id): id is string => typeof id === 'string',
        ),
        trafficWeight: plan.activate.trafficWeight,
        abVariants:
          mode === 'FULL'
            ? [{ versionId: target.id, version: target.version, trafficWeight: TOTAL_TRAFFIC_WEIGHT }]
            : [
                { versionId: target.id, version: target.version, trafficWeight: plan.activate.trafficWeight },
                ...plan.others.map((other) => ({
                  versionId: other.versionId,
                  version: versions.find((version) => version.id === other.versionId)?.version ?? 0,
                  trafficWeight: other.trafficWeight,
                })),
              ],
      };
    });

    const invalidatedKeys = await this.invalidateVersions(outcome.affectedVersionIds);

    const auditLogId = await this.writeAudit({
      admin,
      action: 'PUBLISH',
      resourceId: target.templateId,
      beforeData: {
        activeVersionId: outcome.previousActiveVersionId,
        activeVersion: outcome.previousActiveVersion,
      },
      afterData: {
        activeVersionId: mode === 'FULL' ? target.id : null,
        activeVersion: target.version,
        mode,
        trafficWeight: outcome.trafficWeight,
        archived: outcome.archived,
      },
      diffSummary:
        `发布 Prompt 版本 ${outcome.templateKey} v${target.version}（${mode}，权重 ${outcome.trafficWeight}%）` +
        (dto.changeNote === undefined ? '' : `：${dto.changeNote}`),
      reason: dto.changeNote ?? null,
      context,
    });

    if (dto.notifyOnCall === true) {
      /**
       * 契约的 `notifyOnCall` 语义是「下次调用时把发布事件写进日志」。
       * 这需要在运行期调用链上加挂钩（`ai/prompt` 或 `ai/report`），而那两个目录
       * 本次为只读范围，因此只能在后台侧留下显式日志，供排障时对齐时间线。
       */
      this.logger.warn(
        `notifyOnCall=true：请关注随后 AI 调用的日志（模板 ${outcome.templateKey} v${target.version}，发布于 ${publishedAt.toISOString()}）`,
      );
    }

    return {
      templateKey: outcome.templateKey,
      templateId: target.templateId,
      previousActiveVersionId: outcome.previousActiveVersionId,
      previousActiveVersion: outcome.previousActiveVersion,
      newActiveVersionId: target.id,
      newActiveVersion: target.version,
      mode,
      trafficWeight: outcome.trafficWeight,
      abTest: {
        // FULL 模式下指针钉住新版本 → AB 不生效（即便保留了其他 ACTIVE 版本，其权重也是 0）
        enabled: mode === 'AB_TEST',
        variants: mode === 'AB_TEST' ? outcome.abVariants : [],
      },
      archivedVersions: outcome.archived,
      cacheInvalidation: {
        invalidatedKeys,
        mode: 'ACTIVE_DEL',
        note: '缓存已主动失效，后续调用将读取新版本（无需重启服务，架构 10.3）',
      },
      publishedAt: publishedAt.toISOString(),
      publishedBy: { adminId: admin.adminId, displayName: admin.displayName },
      impactAssessment: {
        // 版本在「创建报告」时解析一次并随请求传递，因此进行中的生成不受影响
        affectsNewCallsOnly: true,
        inFlightCallsUnaffected: true,
        cachedReportsUnaffected: true,
        cacheKeyImpact:
          `报告 cacheKey = sha256(userId|profileId|profileVersion|templateKey|versionId|provider|model)，` +
          `因此新生成的报告将使用版本 ${target.id}，历史报告继续命中旧 cacheKey（不会重复生成）；` +
          '⚠ 已入队但尚未开始生成的报告会在**生成时**重新解析生效版本（运行期 `getPrompt` 行为），' +
          '其记录在案的报告版本可能与实际使用的版本不一致，发布后请留意这一窗口内的生成结果',
        monitoringSuggestion: '建议观察 24 小时内 successRate 与用户重新生成率的变化',
      },
      auditLogId,
      nextStep: '可通过 GET /api/v1/admin/ai/stats/usage 观察新版本效果；如需回退请调用 rollback 接口。',
    };
  }

  // ==========================================================================
  // POST /api/v1/admin/prompts/{key}/versions/{versionId}/rollback
  // ==========================================================================

  async rollback(
    key: string,
    versionId: string,
    dto: RollbackPromptVersionDto,
    principalUserId: string,
    context: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<RollbackPromptVersionResult> {
    const admin = await this.loadAdminActor(principalUserId);
    const revertWindow: RevertWindow = dto.revertWindow ?? 'ALL';
    const target = await this.loadVersionOfTemplate(key, versionId);

    if (target.status === 'DRAFT') {
      // 契约错误码 50021（500）：草稿不可作为回滚目标。现有 50021 = AI_REQUEST_REJECTED，
      // 语义即「请求不被接受」，与契约编号一致，故复用该码并覆盖文案
      throw new BusinessException(ErrorCode.AI_REQUEST_REJECTED, '草稿版本不可作为回滚目标，请先发布或改选其他版本', {
        httpStatus: 500,
      });
    }

    const rolledBackAt = new Date();

    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.lockTemplate(tx, target.templateId);

      const template = await tx.promptTemplate.findUniqueOrThrow({
        where: { id: target.templateId },
        select: { key: true, activeVersionId: true },
      });

      const versions = await tx.promptVersion.findMany({
        where: { templateId: target.templateId },
        select: { id: true, version: true, status: true, trafficWeight: true },
      });

      const currentActive = versions.find((version) => version.id === template.activeVersionId) ?? null;
      const statusChanges: RollbackPromptVersionResult['versionStatusChanges'] = [];

      if (currentActive !== null && currentActive.id !== target.id) {
        if (revertWindow === 'ALL') {
          await tx.promptVersion.update({
            where: { id: currentActive.id },
            data: { status: 'ARCHIVED', trafficWeight: 0, archivedAt: rolledBackAt },
          });
          statusChanges.push({
            versionId: currentActive.id,
            version: currentActive.version,
            from: 'ACTIVE',
            to: 'ARCHIVED',
            note: '保留为归档，便于复盘',
          });
        } else {
          // 灰度回滚：被回滚版本保留少量流量做对照，避免「一刀切」错判
          await tx.promptVersion.update({
            where: { id: currentActive.id },
            data: { status: 'ACTIVE', trafficWeight: CANARY_TRAFFIC_WEIGHT },
          });
          statusChanges.push({
            versionId: currentActive.id,
            version: currentActive.version,
            from: currentActive.status,
            to: 'ACTIVE',
            note: `灰度回滚：保留 ${CANARY_TRAFFIC_WEIGHT}% 流量用于对照`,
          });
        }
      }

      await tx.promptVersion.update({
        where: { id: target.id },
        data: {
          status: 'ACTIVE',
          trafficWeight: revertWindow === 'ALL' ? TOTAL_TRAFFIC_WEIGHT : TOTAL_TRAFFIC_WEIGHT - CANARY_TRAFFIC_WEIGHT,
          publishedAt: rolledBackAt,
          publishedById: admin.adminId,
          archivedAt: null,
        },
      });

      if (target.status !== 'ACTIVE') {
        statusChanges.push({
          versionId: target.id,
          version: target.version,
          from: target.status,
          to: 'ACTIVE',
        });
      }

      /**
       * 与发布同理：`ALL` 全量回滚用指针钉住目标版本；`CANARY` 必须让指针为空，
       * 否则运行期的「钉住」分支会忽略权重，灰度那 10% 永远不会生效。
       */
      await tx.promptTemplate.update({
        where: { id: target.templateId },
        data: { activeVersionId: revertWindow === 'ALL' ? target.id : null },
      });

      return {
        templateKey: template.key,
        previousActiveVersionId: currentActive?.id ?? null,
        previousActiveVersion: currentActive?.version ?? null,
        currentActiveVersionId: revertWindow === 'ALL' ? target.id : null,
        currentActiveVersion: revertWindow === 'ALL' ? target.version : null,
        statusChanges,
        affectedVersionIds: [target.id, currentActive?.id].filter((id): id is string => typeof id === 'string'),
      };
    });

    const invalidatedKeys = await this.invalidateVersions(outcome.affectedVersionIds);

    // 指标快照：回滚决策的证据链（架构 R4：质量抽检 + AB 测试）
    const metricsSnapshot = await this.buildRollbackMetrics(target, outcome.previousActiveVersionId);

    const auditLogId = await this.writeAudit({
      admin,
      action: 'ROLLBACK',
      resourceId: target.templateId,
      beforeData: { activeVersionId: outcome.previousActiveVersionId, activeVersion: outcome.previousActiveVersion },
      afterData: {
        activeVersionId: outcome.currentActiveVersionId,
        activeVersion: target.version,
        revertWindow,
        versionStatusChanges: outcome.statusChanges,
      },
      diffSummary: `回滚 Prompt 模板 ${outcome.templateKey} 至 v${target.version}（${revertWindow}）`,
      reason: dto.reason,
      context,
    });

    if (dto.alertOnRegression !== false) {
      /**
       * 契约要求「回滚后 1 小时内加强指标监控」。本项目当前**没有独立的告警调度链路**
       * （Worker 尚未接入 monitoring 处理器），因此这里把告警意图写进审计与日志，
       * 由监控侧按窗口消费 —— 响应里的 `alertScheduled` 即该意图的回执。
       */
      this.logger.warn(
        `回滚后已请求加强监控 ${outcome.templateKey}（窗口 60min，成功率为观察指标），admin=${admin.username}`,
      );
    }

    return {
      templateKey: outcome.templateKey,
      templateId: target.templateId,
      rolledBackFromVersionId: outcome.previousActiveVersionId,
      rolledBackFromVersion: outcome.previousActiveVersion,
      restoredVersionId: target.id,
      restoredVersion: target.version,
      currentActiveVersionId: outcome.currentActiveVersionId,
      currentActiveVersion: outcome.currentActiveVersion,
      revertWindow,
      reason: dto.reason,
      versionStatusChanges: outcome.statusChanges,
      cacheInvalidation: {
        invalidatedKeys,
        note: `缓存已失效，后续调用立即回到 v${target.version}`,
      },
      metricsSnapshot,
      alertScheduled: dto.alertOnRegression !== false,
      alertWindowMinutes: 60,
      rolledBackAt: rolledBackAt.toISOString(),
      rolledBackBy: { adminId: admin.adminId, displayName: admin.displayName },
      auditLogId,
    };
  }

  // ==========================================================================
  // POST /api/v1/admin/prompts/{key}/test-render
  // ==========================================================================

  /**
   * 变量渲染预览（**纯预览**）
   *
   * 三条硬约束：不调用 LLM、不写库、不产生成本。它只做变量替换与静态检查，
   * 因此可以被安全地反复调用（运营发布前会改十几次提示词）。
   */
  async testRender(key: string, dto: TestRenderPromptDto): Promise<TestRenderResult> {
    const mode: RenderMode = dto.mode ?? 'PREVIEW';

    if (mode === 'ACTUAL_CALL') {
      /**
       * 契约允许 `ACTUAL_CALL`（真实调用并计入用量），但本次交付明确要求
       * 「test-render 必须是纯预览，不得调用真实 LLM、不得写库」——两者不可同时满足。
       * 这里选择**显式拒绝**而不是返回一份预览冒充真实结果：
       * 后者会让调用方按「已真实调用了模型」去做成本与质量判断。
       */
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        '本接口当前仅支持 PREVIEW 模式（真实调用模式尚未接入，避免产生未受控的成本与用量记录）',
      );
    }

    const template = await this.loadTemplate(key);
    const versions = await this.loadVersions([template.id]).then((map) => map.get(template.id) ?? []);
    const version =
      dto.versionId === undefined
        ? (versions.find((item) => item.id === template.activeVersionId) ??
          versions.find((item) => item.status === 'ACTIVE') ??
          null)
        : (versions.find((item) => item.id === dto.versionId) ?? null);

    if (version === null) {
      throw dto.versionId === undefined
        ? BusinessException.notFound(ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND, `模板 ${key} 没有可用的生效版本`)
        : BusinessException.notFound(
            ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND,
            `版本 ${dto.versionId} 不存在于模板 ${key}`,
          );
    }

    const declared = parseDeclaredVariables(version.variables);
    const provided = dto.variables;
    const strict = dto.strictValidation !== false;

    const missingRequired = declared.required.filter((name) => !this.hasProvidedValue(provided[name]));
    const missingUsed = extractVariableReferences(version.systemPrompt, version.userPromptTemplate).filter(
      (name) => !this.hasProvidedValue(provided[name]),
    );

    /** 严格模式：缺失必填变量直接失败（契约 §3.14.5.7 错误码 50021） */
    if (strict && missingRequired.length > 0) {
      throw BusinessException.internal(
        ErrorCode.AI_PROMPT_VARIABLE_MISSING,
        `缺少必填变量：${missingRequired.join(', ')}（strictValidation=true；如需快速预览可传 false）`,
      );
    }

    const rendered = renderPromptPreview(
      { systemPrompt: version.systemPrompt, userPromptTemplate: version.userPromptTemplate },
      provided,
    );

    const declaredNames = [...declared.properties.keys()];
    const usedNames = extractVariableReferences(version.systemPrompt, version.userPromptTemplate);
    const extraVariables = Object.keys(provided).filter(
      (name) => !declared.properties.has(name) && !usedNames.includes(name),
    );

    // 类型检查只覆盖「有提供值 + 声明了基础类型」的变量：其余情形（对象/数组/未提供）
    // 无法用单值比较判断，硬判会产生假告警
    const typeCheckResults = declaredNames
      .filter((name) => this.hasProvidedValue(provided[name]) && declared.properties.get(name) !== 'unknown')
      .map((name) => {
        const expected = declared.properties.get(name) ?? 'unknown';
        const actual = actualTypeOf(provided[name]);
        const passed =
          !(CHECKABLE_TYPES as readonly string[]).includes(expected) ||
          expected === actual ||
          (expected === 'number' && actual === 'integer');

        return { variable: name, expected, actual, passed };
      });

    const errors: { code: string; message: string; severity: string }[] = typeCheckResults
      .filter((result) => !result.passed)
      .map((result) => ({
        code: 'TYPE_MISMATCH',
        message: `变量 ${result.variable} 声明为 ${result.expected}，实际传入 ${result.actual}`,
        severity: 'ERROR',
      }));

    const warnings: { code: string; message: string; severity: string }[] = [];

    for (const block of rendered.conditionalBlocks) {
      if (!block.rendered) {
        warnings.push({
          code: 'MISSING_OPTIONAL_VARIABLE',
          message: `未提供可选变量 ${block.variable}，条件块 {{#if ${block.variable}}} 已跳过`,
          severity: 'INFO',
        });
      }
    }

    if (!strict && missingRequired.length > 0) {
      warnings.push({
        code: 'MISSING_REQUIRED_VARIABLE',
        message: `严格校验已关闭：必填变量 ${missingRequired.join(', ')} 被渲染为空串`,
        severity: 'WARN',
      });
    }

    // 声明缺失：模板里引用了变量但 JSON Schema 未声明（发布时会拦住，这里提前暴露）
    const undeclared = usedNames.filter((name) => !declared.properties.has(name));

    if (undeclared.length > 0) {
      warnings.push({
        code: 'UNDECLARED_VARIABLE_USED',
        message: `模板使用了未声明的变量：${undeclared.join(', ')}（发布时会被拒绝）`,
        severity: 'WARN',
      });
    }

    if (rendered.conditionalBlocks.length > 0) {
      // 重要：当前运行期渲染器不识别条件块，这里必须明确提示，否则运营会以为分支已生效
      warnings.push({
        code: 'CONDITIONAL_NOT_SUPPORTED_AT_RUNTIME',
        message: `本预览支持条件块，但运行期渲染器尚未实现；${CONDITIONAL_LIMITATION}`,
        severity: 'WARN',
      });
    }

    if (missingUsed.length > 0 && strict) {
      warnings.push({
        code: 'MISSING_VARIABLE_RENDERED_EMPTY',
        message: `以下变量未提供，已在预览中渲染为空串：${missingUsed.join(', ')}`,
        severity: 'WARN',
      });
    }

    const guard = inspectInjectionGuard(`${version.systemPrompt}\n${version.userPromptTemplate}`);
    const boundary = inspectBoundaryRules(`${version.systemPrompt}\n${version.userPromptTemplate}`);

    if (!boundary.present) {
      // 边界声明缺失是合规风险（架构 §1.2），预览阶段就提示，避免发布后才被发现
      warnings.push({
        code: 'BOUNDARY_RULES_MISSING',
        message: '未检测到禁止诊断/用药/危机干预的边界声明（合规要求，架构 1.2）',
        severity: 'WARN',
      });
    }

    if (!guard.delimitersPresent) {
      warnings.push({
        code: 'INJECTION_GUARD_MISSING',
        message: '未检测到用户数据定界符（如 <user_data>）：用户自由文本缺少注入防护边界（架构 10.3）',
        severity: 'WARN',
      });
    }

    const systemTokens = estimateTokens(rendered.system);
    const userTokens = estimateTokens(rendered.user);
    const outputTokens = version.maxTokens ?? 4000;
    const provider = this.providerOf(version.model);

    return {
      templateKey: template.key,
      versionId: version.id,
      version: version.version,
      versionStatus: version.status,
      mode: 'PREVIEW',
      renderedAt: new Date().toISOString(),
      rendered: {
        systemPrompt: rendered.system,
        userPrompt: rendered.user,
        model: version.model,
        temperature: version.temperature,
        maxTokens: version.maxTokens,
        // 结构化输出约束存在即按 jsonMode 调用（与运行期 `outputSchema !== null` 的判据一致）
        jsonMode: version.outputSchema !== null,
      },
      validation: {
        isValid: errors.length === 0,
        missingRequiredVariables: strict ? [] : missingRequired,
        extraVariables,
        conditionalBlocks: rendered.conditionalBlocks,
        typeCheckResults,
        errors,
        warnings,
      },
      injectionGuard: {
        delimitersPresent: guard.delimitersPresent,
        delimiterPairs: guard.delimiterPairs,
        instructionGuardPresent: guard.instructionGuardPresent,
        guardText: guard.guardText,
        /**
         * 自由文本转义由**变量组装方**负责（架构 10.3），模板只能声明定界符。
         * 这里返回的是「模板是否具备定界符保护」——本仓库尚未看到组装侧的转义实现，
         * 因此该字段只代表模板侧的准备情况，不能当作运行时保证。
         */
        freeTextEscaped: guard.delimitersPresent,
        note: '用户自由文本（如昵称、状态签名）应在变量组装时转义并包裹定界符（架构 10.3）；本字段反映模板侧的定界符声明',
      },
      tokenEstimate: {
        systemPromptTokens: systemTokens,
        userPromptTokens: userTokens,
        totalInputTokens: systemTokens + userTokens,
        estimatedOutputTokens: outputTokens,
        estimatedCostCents: estimateCostCents(
          provider,
          version.model ?? 'deepseek-chat',
          this.usageOf(systemTokens + userTokens, outputTokens),
        ),
        note: `按 ${version.model ?? 'deepseek-chat'} 价目表估算（分），仅供参考`,
      },
      actualCallResult: null,
      note: 'PREVIEW 模式不调用 LLM，不产生成本，也不会写入 ai_usage_logs。',
    };
  }

  // ==========================================================================
  // 内部 — 模板与版本加载
  // ==========================================================================

  private async loadTemplate(key: string): Promise<TemplateRow> {
    const template = await this.prisma.promptTemplate.findFirst({
      where: { key, deletedAt: null },
      select: TEMPLATE_SELECT,
    });

    if (template === null) {
      // 契约错误码 50020（404）；现有码表中语义最近的是 AI_PROMPT_TEMPLATE_NOT_FOUND（50011），
      // 为保持契约的 HTTP 语义用 notFound 覆盖状态码
      throw BusinessException.notFound(ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND, `Prompt 模板「${key}」不存在`);
    }

    return template;
  }

  private async loadVersionOfTemplate(key: string, versionId: string): Promise<VersionRow> {
    const template = await this.loadTemplate(key);
    const version = await this.prisma.promptVersion.findFirst({
      where: { id: versionId, templateId: template.id },
      select: VERSION_SELECT,
    });

    if (version === null) {
      throw BusinessException.notFound(
        ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND,
        `版本 ${versionId} 不存在或不属于模板「${key}」`,
      );
    }

    return version;
  }

  /** 批量载入版本（按版本号降序，列表/详情共用） */
  private async loadVersions(templateIds: readonly string[]): Promise<Map<string, VersionRow[]>> {
    const result = new Map<string, VersionRow[]>();

    if (templateIds.length === 0) return result;

    const rows = await this.prisma.promptVersion.findMany({
      where: { templateId: { in: [...templateIds] } },
      orderBy: [{ version: 'desc' }],
      select: VERSION_SELECT,
    });

    for (const row of rows) {
      const list = result.get(row.templateId) ?? [];
      list.push(row);
      result.set(row.templateId, list);
    }

    return result;
  }

  /** 版本统计（7 天窗口，按版本聚合后用一次查询覆盖整页） */
  private async loadVersionStats(versionIds: readonly string[]): Promise<Map<string, PromptVersionDetailStatsView>> {
    const result = new Map<string, PromptVersionDetailStatsView>();

    if (versionIds.length === 0) return result;

    const since = new Date(Date.now() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const window = { promptVersionId: { in: [...versionIds] }, createdAt: { gte: since }, deletedAt: null };

    const [statusRows, averageRows, schemaFailureRows] = await Promise.all([
      this.prisma.aiReport.groupBy({
        by: ['promptVersionId', 'status'],
        where: window,
        _count: { _all: true },
      }),
      this.prisma.aiReport.groupBy({
        by: ['promptVersionId'],
        where: window,
        _avg: { latencyMs: true, completionTokens: true, costAmount: true },
      }),
      this.prisma.aiReport.groupBy({
        by: ['promptVersionId'],
        where: { ...window, status: 'FAILED', errorCode: String(ErrorCode.AI_OUTPUT_INVALID) },
        _count: { _all: true },
      }),
    ]);

    const counts = new Map<string, { total: number; succeeded: number }>();

    for (const row of statusRows) {
      if (row.promptVersionId === null) continue;

      const bucket = counts.get(row.promptVersionId) ?? { total: 0, succeeded: 0 };
      bucket.total += row._count._all;
      if (row.status === 'SUCCEEDED') bucket.succeeded += row._count._all;
      counts.set(row.promptVersionId, bucket);
    }

    const averages = new Map<
      string,
      { latencyMs: number | null; completionTokens: number | null; costAmount: number | null }
    >();

    for (const row of averageRows) {
      if (row.promptVersionId === null) continue;

      averages.set(row.promptVersionId, {
        latencyMs: row._avg.latencyMs,
        completionTokens: row._avg.completionTokens,
        costAmount: row._avg.costAmount,
      });
    }

    const schemaFailures = new Map<string, number>();

    for (const row of schemaFailureRows) {
      if (row.promptVersionId === null) continue;
      schemaFailures.set(row.promptVersionId, row._count._all);
    }

    for (const versionId of versionIds) {
      const bucket = counts.get(versionId) ?? { total: 0, succeeded: 0 };
      const average = averages.get(versionId) ?? { latencyMs: null, completionTokens: null, costAmount: null };

      result.set(versionId, {
        callCount7d: bucket.total,
        // 无调用时返回 null（而不是 0）：0% 成功率会被误读成「质量事故」
        successRate7d: bucket.total === 0 ? null : round(bucket.succeeded / bucket.total, 4),
        avgLatencyMs: average.latencyMs === null ? null : round(average.latencyMs, 0),
        avgCompletionTokens: average.completionTokens === null ? null : round(average.completionTokens, 0),
        avgCostCents: average.costAmount === null ? null : round(average.costAmount, 2),
        // 结构化输出校验失败率：以「报告失败且错误码为 AI_OUTPUT_INVALID」为判据
        schemaValidationFailureRate:
          bucket.total === 0 ? null : round((schemaFailures.get(versionId) ?? 0) / bucket.total, 4),
        // 无数据源：当前仓库没有「用户主动重新生成」的埋点，如实返回 null
        userRegenerateRate: null,
      });
    }

    return result;
  }

  /** 模板级统计：把各版本统计按调用量加权汇总（简单平均会被低量版本带偏） */
  private aggregateTemplateStats(
    versions: readonly VersionRow[],
    stats: Map<string, PromptVersionStatsView>,
  ): PromptTemplateStatsView {
    let calls = 0;
    let succeeded = 0;
    let latencyWeighted = 0;
    let latencyWeight = 0;
    let tokensWeighted = 0;
    let tokensWeight = 0;
    let costWeighted = 0;
    let costWeight = 0;

    for (const version of versions) {
      const item = stats.get(version.id);
      if (item === undefined || item.callCount7d === 0) continue;

      calls += item.callCount7d;
      succeeded += (item.successRate7d ?? 0) * item.callCount7d;

      if (item.avgLatencyMs !== null) {
        latencyWeighted += item.avgLatencyMs * item.callCount7d;
        latencyWeight += item.callCount7d;
      }

      if (item.avgCompletionTokens !== null) {
        tokensWeighted += item.avgCompletionTokens * item.callCount7d;
        tokensWeight += item.callCount7d;
      }

      if (item.avgCostCents !== null) {
        costWeighted += item.avgCostCents * item.callCount7d;
        costWeight += item.callCount7d;
      }
    }

    return {
      callCount7d: calls,
      successRate7d: calls === 0 ? null : round(succeeded / calls, 4),
      avgLatencyMs: latencyWeight === 0 ? null : round(latencyWeighted / latencyWeight, 0),
      avgCompletionTokens: tokensWeight === 0 ? null : round(tokensWeighted / tokensWeight, 0),
      avgCostCents: costWeight === 0 ? null : round(costWeighted / costWeight, 2),
      // 满意度没有数据源（当前仓库无用户反馈表/字段），如实返回 null 而不是编一个数字
      userSatisfactionRate: null,
    };
  }

  // ==========================================================================
  // 内部 — 视图组装
  // ==========================================================================

  private toListItem(
    template: TemplateRow,
    versions: readonly VersionRow[],
    stats: Map<string, PromptVersionDetailStatsView>,
    adminNames: Map<string, string>,
  ): PromptTemplateListItem {
    const activeVersion = versions.find((version) => version.id === template.activeVersionId) ?? null;
    const defaultVersion = activeVersion ?? versions[0] ?? null;
    const lastPublished = this.lastPublishedOf(versions);
    const abEnabled = this.isAbTestEnabled(template.activeVersionId, versions);

    // 「最后修改人」= 最近一次发布的人；从未发布过则回落到模板创建人
    const updatedBy =
      lastPublished === null
        ? (adminNames.get(template.createdByAdminId ?? '') ?? null)
        : (adminNames.get(lastPublished.publishedById ?? '') ?? null);

    return {
      templateId: template.id,
      key: template.key,
      type: template.type,
      typeName: PROMPT_TYPE_NAMES[template.type],
      description: template.description,
      activeVersionId: template.activeVersionId,
      activeVersion: activeVersion?.version ?? null,
      activeVersionStatus: activeVersion?.status ?? null,
      versionCount: versions.length,
      draftVersionCount: versions.filter((version) => version.status === 'DRAFT').length,
      abTest: {
        enabled: abEnabled,
        // 契约示例里 `enabled=false` 时 `variants` 为空数组：AB 未生效时不展示「参与分流的版本」，
        // 否则运营会以为它们真的在分流量（实际上权重 0 / 指针钉住都不参与选择）
        variants: abEnabled ? this.buildAbVariants(versions, stats, false) : [],
        bucketingMethod: abEnabled ? BUCKETING_METHOD : null,
      },
      // 默认模型参数取自「生效版本」，没有生效版本时退到最新版本，保证字段始终有参考值
      defaultModel: defaultVersion?.model ?? null,
      defaultTemperature: defaultVersion?.temperature ?? null,
      defaultMaxTokens: defaultVersion?.maxTokens ?? null,
      hasOutputSchema: defaultVersion !== null && defaultVersion.outputSchema !== null,
      variables: this.collectVariables(versions),
      stats: this.aggregateTemplateStats(versions, stats),
      updatedAt: this.latestActivityAt(template, versions).toISOString(),
      updatedBy,
      lastPublishedAt: lastPublished?.publishedAt?.toISOString() ?? null,
      lastPublishedBy: lastPublished === null ? null : (adminNames.get(lastPublished.publishedById ?? '') ?? null),
    };
  }

  private toVersionSummary(version: VersionRow, createdBy: string): PromptVersionSummaryView {
    return {
      versionId: version.id,
      version: version.version,
      status: version.status,
      model: version.model,
      temperature: version.temperature,
      maxTokens: version.maxTokens,
      trafficWeight: version.trafficWeight,
      hasOutputSchema: version.outputSchema !== null,
      createdAt: version.createdAt.toISOString(),
      /**
       * 数据模型没有「版本创建人」列（只有 `publishedById`），因此：
       *   · 已发布的版本 → 发布人；
       *   · 刚创建的 DRAFT → 本次操作者（就是调用方自己）。
       * 这一点在交付说明中标注为字段缺口。
       */
      createdBy,
    };
  }

  private toVersionDetail(
    version: VersionRow,
    stats: PromptVersionDetailStatsView | undefined,
    adminNames: Map<string, string>,
    includeContent: boolean,
  ): PromptVersionDetailView {
    const publisherName = version.publishedById === null ? null : (adminNames.get(version.publishedById) ?? null);

    return {
      versionId: version.id,
      version: version.version,
      status: version.status,
      statusLabel: buildVersionStatusLabel(version.status, version.trafficWeight),
      // 全文可被 `includeContent=false` 隐去（列表页只看元数据，避免响应膨胀到几 MB）
      systemPrompt: includeContent ? version.systemPrompt : null,
      userPromptTemplate: includeContent ? version.userPromptTemplate : null,
      variables: asJson(version.variables),
      model: version.model,
      temperature: version.temperature,
      maxTokens: version.maxTokens,
      outputSchema: asJson(version.outputSchema),
      trafficWeight: version.trafficWeight,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      publishedBy: version.publishedById,
      publishedByName: publisherName,
      changeNote: version.changeNote,
      createdAt: version.createdAt.toISOString(),
      createdBy: version.publishedById,
      createdByName: publisherName,
      // 无调用量的版本（如刚建的 DRAFT）返回 null：与 0 值区分开，前者是「没数据」
      stats: stats === undefined || stats.callCount7d === 0 ? null : stats,
    };
  }

  /** AB 变体（仅统计口径不同：列表不带调用量，详情带） */
  private buildAbVariants(
    versions: readonly VersionRow[],
    stats: Map<string, PromptVersionStatsView>,
    withStats: boolean,
  ): AbTestVariantView[] {
    return versions
      .filter((version) => version.status === 'ACTIVE' && version.trafficWeight > 0)
      .map((version) => {
        const item = stats.get(version.id);

        return {
          versionId: version.id,
          version: version.version,
          trafficWeight: version.trafficWeight,
          isActive: true,
          ...(withStats ? { callCount7d: item?.callCount7d ?? 0, successRate7d: item?.successRate7d ?? null } : {}),
        };
      });
  }

  /**
   * AB 测试是否**实际生效**
   *
   * 判据必须包含「模板没有钉住版本」：运行期的 `resolveVersion` 在 `activeVersionId`
   * 非空时直接使用该版本，权重完全不参与选择。若只数 ACTIVE 版本个数，
   * 后台会显示「AB 测试中」而线上其实是单版本全量。
   */
  private isAbTestEnabled(activeVersionId: string | null, versions: readonly VersionRow[]): boolean {
    if (activeVersionId !== null) return false;

    return versions.filter((version) => version.status === 'ACTIVE' && version.trafficWeight > 0).length > 1;
  }

  /** 版本声明的变量并集（含模板占位符兜底：种子/历史版本的 `variables` 为 null） */
  private collectVariables(versions: readonly VersionRow[]): string[] {
    const names = new Set<string>();

    for (const version of versions) {
      for (const name of parseDeclaredVariables(version.variables).properties.keys()) names.add(name);

      /**
       * 兜底：`prompt_versions.variables` 允许为空（种子数据就没写），
       * 此时「变量清单」只能从模板文本里提取 —— 返回空数组会让前端编辑器失去提示，
       * 而模板实际依赖的变量一个都不显示。
       */
      if (version.variables === null) {
        for (const name of extractVariableReferences(version.systemPrompt, version.userPromptTemplate)) {
          names.add(name);
        }
      }
    }

    return [...names].sort();
  }

  private lastPublishedOf(versions: readonly VersionRow[]): VersionRow | null {
    let latest: VersionRow | null = null;

    for (const version of versions) {
      if (version.publishedAt === null) continue;
      if (latest === null || version.publishedAt.getTime() > (latest.publishedAt?.getTime() ?? 0)) latest = version;
    }

    return latest;
  }

  private latestActivityAt(template: TemplateRow, versions: readonly VersionRow[]): Date {
    let latest = template.updatedAt;

    for (const version of versions) {
      if (version.updatedAt.getTime() > latest.getTime()) latest = version.updatedAt;
    }

    return latest;
  }

  private collectAdminIds(
    templates: readonly TemplateRow[],
    versionsByTemplate: Map<string, readonly VersionRow[]>,
  ): string[] {
    const ids = new Set<string>();

    for (const template of templates) {
      if (template.createdByAdminId !== null) ids.add(template.createdByAdminId);
    }

    for (const versions of versionsByTemplate.values()) {
      for (const version of versions) {
        if (version.publishedById !== null) ids.add(version.publishedById);
      }
    }

    return [...ids];
  }

  private async loadAdminNames(adminIds: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    if (adminIds.length === 0) return result;

    const admins = await this.prisma.adminUser.findMany({
      where: { id: { in: [...adminIds] } },
      select: { id: true, username: true, nickname: true, realName: true },
    });

    for (const admin of admins) {
      result.set(admin.id, admin.nickname ?? admin.realName ?? admin.username);
    }

    return result;
  }

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

  /** 缓存状态（命中判断基于运行期真实键，因此不会出现「后台说已缓存、线上其实没缓存」） */
  private async buildCacheStatus(versions: readonly VersionRow[]): Promise<PromptDetailResult['cacheStatus']> {
    const cachedKeys: string[] = [];
    let maxTtl = 0;

    for (const version of versions) {
      const key = this.redis.key(VERSION_CACHE_PREFIX, version.id);

      if (await this.redis.exists(key)) {
        cachedKeys.push(key);
        const ttl = await this.redis.ttl(key);
        if (ttl > maxTtl) maxTtl = ttl;
      }
    }

    return {
      cachedKeys,
      ttlSeconds: maxTtl > 0 ? maxTtl : VERSION_CACHE_TTL_SECONDS,
      // 当前没有「最近一次失效时间」的持久化记录（只是 DEL 一个键），如实返回 null
      lastInvalidatedAt: null,
    };
  }

  private async buildSummary(): Promise<PromptListResult['summary']> {
    const [totalTemplates, abTemplateIds, templatesWithoutActiveVersion] = await Promise.all([
      this.prisma.promptTemplate.count({ where: { deletedAt: null } }),
      this.findAbTestTemplateIds(),
      this.prisma.promptTemplate.count({
        where: { deletedAt: null, activeVersionId: null, versions: { none: { status: 'ACTIVE' } } },
      }),
    ]);

    return {
      totalTemplates,
      templatesWithAbTest: abTemplateIds.length,
      templatesWithoutActiveVersion,
      cacheTtlSeconds: VERSION_CACHE_TTL_SECONDS,
    };
  }

  /**
   * 存在多个「参与分流」ACTIVE 版本的模板（即 AB 测试模板）
   *
   * 判据与列表项的 `abTest.enabled` **保持一致**：还必须「模板未钉住版本」
   * （`activeVersionId` 为空），否则运行期走钉住分支，权重不参与选择，
   * 只数版本个数会让「AB 模板数」这个监控指标虚高。
   *
   * 实现上用一次 `findMany` 取回后在内存里归并，而不是 `groupBy + having`：
   * 一是 `having` 对计数条件的写法在不同 Prisma 版本上有差异（写错要到运行期才暴露），
   * 二是 **ACTIVE 版本天然是少数**（只有发布过的版本），全量读取的成本可以忽略。
   */
  private async findAbTestTemplateIds(): Promise<string[]> {
    const rows = await this.prisma.promptVersion.findMany({
      where: { status: 'ACTIVE', trafficWeight: { gt: 0 } },
      select: { templateId: true },
    });

    const counter = new Map<string, number>();

    for (const row of rows) {
      counter.set(row.templateId, (counter.get(row.templateId) ?? 0) + 1);
    }

    const candidates = [...counter.entries()].filter(([, count]) => count > 1).map(([templateId]) => templateId);

    if (candidates.length === 0) return [];

    const templates = await this.prisma.promptTemplate.findMany({
      where: { id: { in: candidates }, deletedAt: null, activeVersionId: null },
      select: { id: true },
    });

    return templates.map((template) => template.id);
  }

  // ==========================================================================
  // 内部 — 版本校验与落库
  // ==========================================================================

  /**
   * 变量声明 ↔ 模板占位符一致性校验
   *
   * 判据（契约 §3.14.5.4 业务规则 1）：**使用了但未声明** → 硬失败；
   * 声明了但未使用 → 仅警告（模板可能正在改，提前声明是正常做法）。
   *
   * ⚠ **声明完全缺失（`variables` 为 null）时不判定为「未声明」**：
   * 现网由 `prisma/seed` 建立的模板（`report.mbti` / `report.relationship`）
   * 就没有写 `variables`，若按违规处理，它们将永远无法再次发布 ——
   * 而运行期渲染只看占位符、不看声明，即这类版本实际是可用的。
   * 因此对「没有声明」只给警告；对「声明了但不全」才硬失败（那是真的配置错误）。
   */
  private validateVariables(input: {
    systemPrompt: string;
    userPromptTemplate: string;
    variables: Record<string, unknown> | null;
  }): {
    variableSchemaValid: boolean;
    declaredVariables: string[];
    usedVariables: string[];
    undeclaredVariablesUsed: string[];
    unusedDeclaredVariables: string[];
    injectionGuardPresent: boolean;
    injectionGuardDetail: string | null;
    boundaryRulesPresent: boolean;
    boundaryRulesDetail: string | null;
    estimatedPromptTokens: number;
    warning: string | null;
  } {
    const declared = parseDeclaredVariables(input.variables);
    const used = extractVariableReferences(input.systemPrompt, input.userPromptTemplate);
    const declaredNames = [...declared.properties.keys()].sort();
    const hasDeclaration = input.variables !== null && input.variables !== undefined;

    // 声明缺失时不做「未声明」判定（见方法头注释）；声明存在但未覆盖用到的变量才是配置错误
    const undeclaredVariablesUsed = hasDeclaration ? used.filter((name) => !declared.properties.has(name)) : [];
    const unusedDeclaredVariables = declaredNames.filter((name) => !used.includes(name));

    const guard = inspectInjectionGuard(`${input.systemPrompt}\n${input.userPromptTemplate}`);
    const boundary = inspectBoundaryRules(`${input.systemPrompt}\n${input.userPromptTemplate}`);

    const warnings: string[] = [];

    if (!hasDeclaration) {
      /**
       * 历史/种子版本没有 `variables` 声明。这里**不视为「未声明即违规」**（理由见方法头），
       * 但代价是这类版本缺乏「渲染前校验」的保护，因此以警告形式回传。
       */
      warnings.push('该版本没有 variables 声明（JSON Schema），渲染前校验退化为「以占位符为准」');
    }

    if (unusedDeclaredVariables.length > 0) {
      warnings.push(`已声明但未使用的变量：${unusedDeclaredVariables.join(', ')}`);
    }

    if (!guard.instructionGuardPresent) {
      warnings.push('未检测到「数据而非指令」类注入防护约束（建议补充，架构 10.3）');
    }

    if (!boundary.present) {
      warnings.push('未检测到禁止诊断/用药/危机干预的边界声明（合规要求，架构 1.2）');
    }

    return {
      variableSchemaValid: undeclaredVariablesUsed.length === 0,
      declaredVariables: declaredNames,
      usedVariables: used,
      undeclaredVariablesUsed,
      unusedDeclaredVariables,
      injectionGuardPresent: guard.instructionGuardPresent && guard.delimitersPresent,
      injectionGuardDetail:
        guard.delimitersPresent && guard.instructionGuardPresent
          ? `检测到定界符 ${guard.delimiterPairs.join('、')} 与「数据而非指令」约束`
          : null,
      boundaryRulesPresent: boundary.present,
      boundaryRulesDetail: boundary.detail,
      estimatedPromptTokens: estimateTokens(input.systemPrompt) + estimateTokens(input.userPromptTemplate),
      warning: warnings.length === 0 ? null : warnings.join('；'),
    };
  }

  /** 变量不一致的统一错误（契约错误码 50021/500；现有码表中 50012 语义完全对应） */
  private variableMismatchError(names: readonly string[]): BusinessException {
    return BusinessException.internal(
      ErrorCode.AI_PROMPT_VARIABLE_MISSING,
      `模板使用了未声明的变量：${names.join(', ')}（请同步补充 variables 声明）`,
    );
  }

  /** 版本落库字段（默认值按契约，而不是按 schema 默认值 —— 两者不一致） */
  private buildVersionFields(
    dto: CreatePromptVersionDto,
  ): Omit<Prisma.PromptVersionUncheckedCreateInput, 'templateId' | 'version'> {
    return {
      systemPrompt: dto.systemPrompt,
      userPromptTemplate: dto.userPromptTemplate,
      variables: dto.variables as Prisma.InputJsonValue,
      outputSchema:
        dto.outputSchema === null || dto.outputSchema === undefined
          ? undefined
          : (dto.outputSchema as Prisma.InputJsonValue),
      model: dto.model ?? null,
      provider: dto.model === undefined ? null : MODEL_PROVIDER[dto.model],
      // 契约默认 0.7 / 4000；schema 默认是 0.7 / 2048，因此必须显式写 maxTokens
      temperature: dto.temperature ?? 0.7,
      maxTokens: dto.maxTokens ?? 4000,
      trafficWeight: dto.trafficWeight ?? 0,
      status: 'DRAFT',
      changeNote: dto.changeNote,
    };
  }

  /** 克隆源版本的可继承字段（请求体未提供时继承，提供则覆盖） */
  private mergeClone(
    dto: CreatePromptVersionDto,
    clone: VersionRow | null,
  ): Omit<Prisma.PromptVersionUncheckedCreateInput, 'templateId' | 'version'> {
    const base = this.buildVersionFields(dto);

    if (clone === null) return base;

    return {
      ...base,
      model: dto.model ?? clone.model,
      provider: dto.model === undefined ? clone.provider : base.provider,
      temperature: dto.temperature ?? clone.temperature,
      maxTokens: dto.maxTokens ?? clone.maxTokens,
      outputSchema:
        dto.outputSchema === undefined
          ? clone.outputSchema === null
            ? undefined
            : clone.outputSchema
          : base.outputSchema,
      variables: dto.variables as Prisma.InputJsonValue,
    };
  }

  /**
   * 版本号自增 `max(version) + 1` 并落库
   *
   * 唯一约束 `(templateId, version)` 是最后一道防线：两个运营同时新建版本时，
   * 后写入的一方会拿到 P2002，这里重试取号而不是把 500 抛给用户。
   */
  private async createVersionWithRetry(
    templateId: string,
    data: Omit<Prisma.PromptVersionUncheckedCreateInput, 'templateId' | 'version'>,
  ): Promise<VersionRow> {
    for (let attempt = 1; attempt <= VERSION_CREATE_MAX_ATTEMPTS; attempt += 1) {
      const max = await this.prisma.promptVersion.aggregate({
        where: { templateId },
        _max: { version: true },
      });
      const version = (max._max.version ?? 0) + 1;

      try {
        return await this.prisma.promptVersion.create({
          data: { ...data, templateId, version },
          select: VERSION_SELECT,
        });
      } catch (error) {
        if (!this.isUniqueViolation(error)) throw error;

        this.logger.warn(`版本号冲突，重试取号 templateId=${templateId} version=${version} attempt=${attempt}`);
      }
    }

    throw BusinessException.conflict(ErrorCode.RESOURCE_CONFLICT, '并发创建版本冲突，请稍后重试');
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private deriveTemplateName(dto: CreatePromptTemplateDto): string {
    const typeName = PROMPT_TYPE_NAMES[dto.type];
    const name = `${typeName}（${dto.key}）`;

    // `prompt_templates.name` 是 VarChar(64)，超长会在写库时直接报错
    return name.length > 64 ? name.slice(0, 64) : name;
  }

  // ==========================================================================
  // 内部 — 缓存失效、指标与审计
  // ==========================================================================

  /**
   * 失效受影响的版本内容缓存
   *
   * 通过运行期的 `PromptService.invalidateVersion()` 删除键 ——
   * 后台不自己拼 key，避免「键格式改了但后台不知道」导致的静默失效失败。
   */
  private async invalidateVersions(versionIds: readonly string[]): Promise<string[]> {
    const unique = [...new Set(versionIds.filter((id) => id.length > 0))];

    for (const versionId of unique) {
      await this.prompts.invalidateVersion(versionId);
    }

    return unique.map((versionId) => this.redis.key(VERSION_CACHE_PREFIX, versionId));
  }

  /** 回滚决策所需的指标快照（目标版本 vs 被回滚版本） */
  private async buildRollbackMetrics(
    target: VersionRow,
    previousActiveVersionId: string | null,
  ): Promise<RollbackPromptVersionResult['metricsSnapshot']> {
    const ids = [target.id, previousActiveVersionId].filter((id): id is string => typeof id === 'string');
    const stats = await this.loadVersionStats(ids);

    const toView = (
      versionId: string | null,
    ): {
      callCount: number;
      successRate: number | null;
      userRegenerateRate: null;
      avgLatencyMs: number | null;
      avgCostCents: number | null;
    } | null => {
      if (versionId === null) return null;
      const item = stats.get(versionId);

      return {
        callCount: item?.callCount7d ?? 0,
        successRate: item?.successRate7d ?? null,
        // 无数据源：当前仓库没有「用户主动重新生成」的埋点，如实返回 null
        userRegenerateRate: null,
        avgLatencyMs: item?.avgLatencyMs ?? null,
        avgCostCents: item?.avgCostCents ?? null,
      };
    };

    const targetView = toView(target.id);
    const previousView = toView(previousActiveVersionId);
    const targetRate = targetView?.successRate ?? null;
    const previousRate = previousView?.successRate ?? null;

    /**
     * 回归判定：契约示例用的是 `userRegenerateRate`，而该指标在当前数据模型里**无来源**。
     * 退而用 `successRate` 的下降（≥ 1 个百分点）作为判据，并把判据写进 detail，
     * 避免运营误以为系统真的比较了「重新生成率」。
     */
    const regressionDetected = targetRate === null || previousRate === null ? null : targetRate < previousRate - 0.01;

    const regressionDetail = ((): string => {
      if (regressionDetected === null) {
        return '缺少可比较的成功率数据（7 天窗口内无调用或数据缺失），未做回归判定';
      }

      if (regressionDetected && previousRate !== null && targetRate !== null) {
        return `目标版本 7 天成功率低于被回滚版本：${(previousRate * 100).toFixed(2)}% → ${(targetRate * 100).toFixed(2)}%`;
      }

      return '未检测到成功率回退（userRegenerateRate 无数据源，未参与判定）';
    })();

    return {
      [`version${target.version}`]: targetView,
      ...(previousActiveVersionId === null ? {} : { previousActive: previousView }),
      regressionDetected,
      regressionDetail,
    };
  }

  private async writeAudit(input: {
    admin: AdminActor;
    action: 'CREATE' | 'PUBLISH' | 'ROLLBACK';
    resourceId: string;
    beforeData: Record<string, unknown> | null;
    afterData: Record<string, unknown> | null;
    diffSummary: string;
    reason?: string | null;
    context: { ip?: string; userAgent?: string; requestId?: string };
  }): Promise<string | null> {
    const ok = await this.audit.log({
      adminUserId: input.admin.adminId,
      adminUsername: input.admin.username,
      action: input.action,
      resourceType: 'prompt',
      resourceId: input.resourceId,
      beforeData: input.beforeData as unknown as Prisma.InputJsonValue,
      afterData: input.afterData as unknown as Prisma.InputJsonValue,
      diffSummary: input.diffSummary,
      reason: input.reason ?? null,
      ip: input.context.ip ?? null,
      userAgent: input.context.userAgent ?? null,
      requestId: input.context.requestId ?? null,
      success: true,
    });

    if (!ok) return null;

    /**
     * `AdminAuditService.log` 只返回布尔值（共享文件，不在本次改动范围内），
     * 而契约要求响应里带 `auditLogId`，因此按「管理员 + 资源」回查最近一条。
     */
    const row = await this.prisma.adminAuditLog.findFirst({
      where: { adminUserId: input.admin.adminId, resourceType: 'prompt', resourceId: input.resourceId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row?.id ?? null;
  }

  private versionSnapshot(version: VersionRow): Record<string, unknown> {
    return {
      versionId: version.id,
      version: version.version,
      status: version.status,
      trafficWeight: version.trafficWeight,
      model: version.model,
      temperature: version.temperature,
      maxTokens: version.maxTokens,
      changeNote: version.changeNote,
      systemPromptLength: version.systemPrompt.length,
      userPromptTemplateLength: version.userPromptTemplate.length,
    };
  }

  /**
   * 行锁：串行化同一模板的发布/回滚
   *
   * `SELECT ... FOR UPDATE` 是这里唯一能防住「先读后写」竞态的可靠手段：
   * 两个管理员同时发布同一模板时，没有锁就会出现「双方各自读到对方尚未归档的状态」，
   * 最终可能留下两个权重 100 的 ACTIVE 版本。
   */
  private async lockTemplate(tx: Prisma.TransactionClient, templateId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM prompt_templates WHERE id = ${templateId}::uuid FOR UPDATE`;
  }

  // ==========================================================================
  // 内部 — 小工具
  // ==========================================================================

  private hasProvidedValue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.length > 0;
    return true;
  }

  /** 模型 → Provider（未知/未声明模型按平台默认 deepseek-chat 估算成本） */
  private providerOf(model: string | null): LlmProviderName {
    if (model !== null && model in MODEL_PROVIDER) return MODEL_PROVIDER[model as PromptModelValue];
    return 'DEEPSEEK';
  }

  private usageOf(promptTokens: number, completionTokens: number): LlmUsage {
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  private versionNotFound(key: string, version: number): BusinessException {
    return BusinessException.notFound(ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND, `模板「${key}」不存在版本 ${version}`);
  }
}
