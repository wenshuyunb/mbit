/**
 * 管理端题库服务
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.3（7 个接口）。本文件是该域的全部业务实现。
 *
 * ## 三条贯穿全局的约束
 *
 * ① **软删除优先**（架构 P9、契约 §3.14.3.5 规则 1）：`deletedAt` 置位 + `isActive = false`。
 *    `test_answers.question_id` 的外键是 `onDelete: Restrict`，物理删除会直接破坏历史答卷；
 *    物理删除只在「从未被任何会话快照引用**且**没有任何答题记录」时放行。
 *
 * ② **`questionCount` 始终等于「可用题量」**（`isActive = true AND deletedAt IS NULL`）。
 *    用户端 `test.service.createSession` 的判据是「可用题数 < definition.questionCount → 40011」
 *    —— 若后台删/停一道题而 `questionCount` 不跟着降，用户端会**立刻无法开始测试**。
 *    因此本服务在每次写操作后重算受影响定义的 `questionCount`（见 `syncDefinitionQuestionCounts`）。
 *    契约把 `questionCount` 当作「题量要求」（§3.14.4.2），两者语义并不等同：
 *    「要求」用**操作前基线**（或 `dimensionQuotas` 之和）参与 `sufficientQuota` 预警，
 *    落库值则始终是可用题量。
 *
 * ③ **写操作一律审计**（架构 14.1、契约 §3.14「核心契约」第 4 条）：
 *    审计带 `beforeData` / `afterData`；算分口径相关字段（`dimension` / `weight` /
 *    `reverseScored`）的变更必须可回溯。
 *
 * ## 契约与数据模型的已知差异（逐条在代码处标注，汇总见实现简报）
 *
 * · 多归属（`testCodes`）→ 数据模型只有必填的 `testDefinitionId`，故只接受 1 个；
 * · `usageCount` 的「会话快照引用计数」用 `paper_snapshot` 的 JSONB 包含关系直接统计；
 * · 全文检索契约要求 `tsvector`，数据模型没有该列 → 退化为 `ILIKE`（`contains`）；
 * · 重复度检测契约要求 tsvector + embedding，数据模型没有 → 退化为字符二元组相似度；
 * · 选项分布 / 均值 / 标准差 / 区分度用原生 SQL 聚合（Prisma 的 `aggregate` 不支持
 *   `STDDEV` / `CORR`，也不支持对 JSONB 值分组）。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { AdminAuditAction, Dimension, Prisma, QuestionType } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import type {
  CreateAdminQuestionDto,
  DeleteAdminQuestionDto,
  ImportAdminQuestionsDto,
  ImportFormat,
  ImportMode,
  ImportOnError,
  ListAdminQuestionsQueryDto,
  QuestionSortField,
  SortDirection,
  TestCodeValue,
  ToggleAdminQuestionDto,
  UpdateAdminQuestionDto,
} from './dto/admin-question.dto';
import {
  IMPORT_CSV_COLUMNS,
  LIKERT5_VALUES,
  MAX_CONTENT_LENGTH,
  MAX_EXPLANATION_LENGTH,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  MAX_OPTION_COUNT,
  MAX_QUESTION_ORDER,
  MAX_TAGS,
  MAX_TAG_FILTERS,
  MAX_TAG_LENGTH,
  MAX_WEIGHT,
  MIN_CONTENT_LENGTH,
  MIN_OPTION_COUNT,
  MIN_QUESTION_ORDER,
  MIN_WEIGHT,
  QUESTION_CODE_MAX_LENGTH,
  QUESTION_CODE_PATTERN,
  QUESTION_DIMENSIONS,
  QUESTION_TYPES,
  SCORE_MAP_MAX,
  SCORE_MAP_MIN,
  TEST_CODE_WHITELIST,
} from './dto/admin-question.dto';

// ============================================================================
// 阈值常量
// ============================================================================

/** 维度均衡告警阈值（契约 §3.14.3.2 规则 1：偏离配额 ±20%） */
const DIMENSION_BALANCE_TOLERANCE = 0.2;

/** 正/反向题比例建议区间（契约 §3.14.3.2 规则 2） */
const REVERSE_RATIO_MIN = 0.3;
const REVERSE_RATIO_MAX = 0.7;

/** 重复度告警阈值（契约 §3.14.3.2 规则 3：> 0.85 只告警、不阻断） */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

/** 相似度候选集上限（同维度最近 N 题）—— 避免每次写题都全表比对题干 */
const SIMILARITY_CANDIDATE_LIMIT = 200;

/** 区分度的样本下限：低于此值不下结论（否则 3 条作答就能判定一道题该下线） */
const MIN_DISCRIMINATION_SAMPLE = 30;

/** 详情页变更历史条数上限（「保留 1 年」是审计表的保留策略，不由查询实现） */
const CHANGE_HISTORY_LIMIT = 50;

/** 导入预览条数上限（契约样例的 `preview` 是给人工确认用的片段，不是全量回显） */
const IMPORT_PREVIEW_LIMIT = 20;

/** 导入幂等记录保留时长：覆盖「大批量导入后重试」的时间窗 */
const IMPORT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** LIKERT5 默认选项文案（与 `paper-snapshot.builder` 的 `answerScale`、seed 保持一致） */
const LIKERT5_DEFAULT_LABELS = ['非常不同意', '不同意', '中立', '同意', '非常同意'];

/** 审计 / 变更历史里的资源类型标识 */
const AUDIT_RESOURCE_TYPE = 'question';

// ============================================================================
// 响应视图（逐字段对应契约 §3.14.3 的响应示例）
// ============================================================================

/** 请求上下文（控制器收集，Service 只做透传，避免 Service 依赖 express 类型） */
export interface AdminQuestionRequestContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** 幂等键（`X-Idempotency-Key`），仅批量导入的实际写入路径使用 */
  idempotencyKey?: string | null;
}

/** 选项视图（新建 / 修改 / 详情响应共用） */
export interface AdminQuestionOptionView {
  optionId: string;
  label: string;
  value: number;
  scoreMap: Record<string, number>;
}

/** 带选项分布统计的选项视图（详情响应） */
export interface AdminQuestionOptionStatView extends AdminQuestionOptionView {
  selectedCount: number;
  selectedRatio: number;
}

/** 列表项 */
export interface AdminQuestionListItem {
  questionId: string;
  code: string;
  content: string;
  type: QuestionType;
  dimension: Dimension;
  weight: number;
  reverseScored: boolean;
  order: number;
  isActive: boolean;
  tags: string[];
  testCodes: string[];
  optionCount: number;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

/** 题库总览（不受筛选条件影响，供内容运营看整体态势） */
export interface AdminQuestionSummary {
  totalQuestions: number;
  activeQuestions: number;
  inactiveQuestions: number;
  byDimension: Record<string, number>;
  byType: Record<string, number>;
}

export interface AdminQuestionListResult {
  items: AdminQuestionListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: AdminQuestionSummary;
}

/** 维度均衡校验结果 */
export interface AdminQuestionDimensionBalance {
  dimension: string;
  activeCountBefore: number;
  activeCountAfter: number;
  balanceWarning: string | null;
}

/** 正/反向题比例校验结果 */
export interface AdminQuestionReverseRatio {
  dimension: string;
  forwardCount: number;
  reverseCount: number;
  ratio: number;
  isBalanced: boolean;
  hint: string;
}

/** 重复度检测结果 */
export interface AdminQuestionDuplicateSimilarity {
  checked: boolean;
  highestSimilarity: number;
  similarQuestionCode: string | null;
  warning: string | null;
}

export interface AdminQuestionValidation {
  dimensionBalance: AdminQuestionDimensionBalance;
  reverseRatio: AdminQuestionReverseRatio;
  duplicateSimilarity: AdminQuestionDuplicateSimilarity;
}

export interface AdminQuestionCreateResult {
  questionId: string;
  code: string;
  content: string;
  type: QuestionType;
  dimension: Dimension;
  weight: number;
  reverseScored: boolean;
  order: number;
  isActive: boolean;
  tags: string[];
  testCodes: string[];
  options: AdminQuestionOptionView[];
  validation: AdminQuestionValidation;
  createdAt: string;
  createdBy: string;
  auditLogId: string | null;
  cacheInvalidated: boolean;
}

/** 题目统计（详情响应） */
export interface AdminQuestionStatistics {
  usageCount: number;
  answerCount: number;
  averageValue: number | null;
  standardDeviation: number | null;
  discriminationIndex: number | null;
  skipRate: number;
  qualityLevel: 'POOR' | 'ACCEPTABLE' | 'GOOD' | 'INSUFFICIENT_DATA';
  qualityHint: string;
}

/** 使用范围（详情响应） */
export interface AdminQuestionUsageScope {
  testCode: string;
  sessionCount: number;
}

/** 变更历史条目（详情响应，来自审计日志） */
export interface AdminQuestionChangeEntry {
  at: string;
  action: string;
  operatorName: string;
  changes: Record<string, { before: unknown; after: unknown }> | null;
}

export interface AdminQuestionDetailResult {
  questionId: string;
  code: string;
  content: string;
  type: QuestionType;
  dimension: Dimension;
  weight: number;
  reverseScored: boolean;
  order: number;
  isActive: boolean;
  tags: string[];
  testCodes: string[];
  explanation: string | null;
  options: AdminQuestionOptionStatView[];
  statistics: AdminQuestionStatistics;
  usageScopes: AdminQuestionUsageScope[];
  changeHistory: AdminQuestionChangeEntry[];
  createdAt: string;
  updatedAt: string;
}

/** 影响评估（修改题目响应） */
export interface AdminQuestionImpactAssessment {
  affectsNewSessionsOnly: boolean;
  existingSessionsUnaffected: boolean;
  note: string;
  scoringImpact: string | null;
}

export interface AdminQuestionUpdateResult {
  questionId: string;
  code: string;
  content: string;
  type: QuestionType;
  dimension: Dimension;
  weight: number;
  reverseScored: boolean;
  order: number;
  isActive: boolean;
  tags: string[];
  testCodes: string[];
  options: AdminQuestionOptionView[];
  changedFields: string[];
  impactAssessment: AdminQuestionImpactAssessment;
  cacheInvalidated: boolean;
  auditLogId: string | null;
  updatedAt: string;
  updatedBy: string;
}

/** 题量充足性（删除 / 停用 / 导入响应）：`{ [testCode]: boolean }` + 可选提示 */
export type AdminQuestionSufficientQuota = Record<string, boolean> & { note?: string };

export interface AdminQuestionDeleteImpact {
  existingSessionsUnaffected: boolean;
  futureSessionsWithoutThisQuestion: boolean;
  questionCountAfterDelete: Record<string, number>;
  sufficientQuota: AdminQuestionSufficientQuota;
}

export interface AdminQuestionDeleteResult {
  questionId: string;
  code: string;
  deleted: boolean;
  hardDelete: boolean;
  previousIsActive: boolean;
  usageCount: number;
  affectedTestCodes: string[];
  impactAssessment: AdminQuestionDeleteImpact;
  cacheInvalidated: boolean;
  auditLogId: string | null;
  deletedAt: string;
  deletedBy: string;
}

export interface AdminQuestionToggleImpact {
  existingSessionsUnaffected: boolean;
  questionCountAfterToggle: Record<string, number>;
  sufficientQuota: AdminQuestionSufficientQuota;
}

export interface AdminQuestionToggleResult {
  questionId: string;
  code: string;
  previousIsActive: boolean;
  isActive: boolean;
  reason: string | null;
  affectedTestCodes: string[];
  impactAssessment: AdminQuestionToggleImpact;
  cacheInvalidated: boolean;
  auditLogId: string | null;
  updatedAt: string;
}

/** 批量导入的逐行问题（错误与告警共用结构，契约 §3.14.3.6） */
export interface AdminQuestionImportIssue {
  row: number;
  code: string | null;
  field: string;
  issue: string;
  message: string;
}

/** 试运行响应（200） */
export interface AdminQuestionImportDryRunResult {
  dryRun: true;
  format: ImportFormat;
  mode: ImportMode;
  testCode: string | null;
  totalParsed: number;
  validCount: number;
  invalidCount: number;
  wouldCreate: number;
  wouldUpdate: number;
  wouldDelete: number;
  errors: AdminQuestionImportIssue[];
  warnings: AdminQuestionImportIssue[];
  preview: Array<{
    row: number;
    code: string;
    content: string;
    dimension: string;
    type: string;
    action: 'CREATE' | 'UPDATE';
  }>;
  affectedTestCodes: string[];
  cacheInvalidated: false;
  nextStep: string;
  auditLogId: string | null;
}

/** 实际写入响应（201） */
export interface AdminQuestionImportWriteResult {
  dryRun: false;
  format: ImportFormat;
  mode: ImportMode;
  testCode: string | null;
  totalParsed: number;
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  skippedCount: number;
  errors: AdminQuestionImportIssue[];
  warnings: AdminQuestionImportIssue[];
  createdQuestionIds: string[];
  testDefinitionImpact: Record<
    string,
    {
      activeQuestionCountBefore: number;
      activeQuestionCountAfter: number;
      requiredCount: number;
      isSufficient: boolean;
    }
  >;
  cacheInvalidated: boolean;
  auditLogId: string | null;
  importedAt: string;
  importedBy: string;
}

export type AdminQuestionImportResult = AdminQuestionImportDryRunResult | AdminQuestionImportWriteResult;

// ============================================================================
// 内部类型
// ============================================================================

/** 归一化后的选项输入 */
interface NormalizedOption {
  label: string;
  value: number;
  scoreMap: Record<string, number>;
}

/** 测试定义的轻量引用 */
interface DefinitionRef {
  id: string;
  code: string;
  questionCount: number;
  dimensionQuotas: Record<string, number>;
}

/** 单一维度的题量统计 */
interface DimensionStat {
  active: number;
  forward: number;
  reverse: number;
}

/** 校验结果（供「抛业务异常」与「逐行收集问题」两条路径复用） */
type ValidationResult<T> = { ok: true; value: T } | { ok: false; field: string; issue: string; message: string };

/** 导入分析的产物：试运行与真实写入共用 */
interface PreparedImportRow {
  row: number;
  code: string;
  content: string;
  type: QuestionType;
  dimension: Dimension;
  weight: number;
  reverseScored: boolean;
  order: number;
  isActive: boolean;
  tags: string[];
  explanation: string | null;
  options: NormalizedOption[];
  testCode: string;
  testDefinitionId: string;
  /** 非空表示该 code 已存在 → 走更新 */
  existingId: string | null;
  action: 'CREATE' | 'UPDATE';
}

interface ImportAnalysis {
  totalParsed: number;
  rows: PreparedImportRow[];
  errors: AdminQuestionImportIssue[];
  warnings: AdminQuestionImportIssue[];
  wouldDelete: Array<{ id: string; code: string; testCode: string; dimension: Dimension }>;
  definitions: Map<string, DefinitionRef>;
  affectedTestCodes: string[];
}

/** 审计快照：只允许可 JSON 序列化的值（嵌套对象限定为「字符串 → 数值」的统计映射） */
type AuditSnapshot = Record<string, string | number | boolean | string[] | number[] | Record<string, number> | null>;

@Injectable()
export class AdminQuestionService {
  private readonly logger = new Logger(AdminQuestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AdminAuditService,
  ) {}

  // ==========================================================================
  // 3.14.3.1 GET /admin/questions — 题目列表
  // ==========================================================================

  async list(query: ListAdminQuestionsQueryDto): Promise<AdminQuestionListResult> {
    const dimensions = this.splitCsv(query.dimension) as Dimension[];
    const tags = this.splitCsv(query.tags);

    if (tags.length > MAX_TAG_FILTERS) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `tags 最多 ${MAX_TAG_FILTERS} 个`, [
        { field: 'tags', issue: `收到 ${tags.length} 个标签` },
      ]);
    }

    /**
     * 查询条件：`deletedAt: null` 是硬性的 —— 软删除的题不应再出现在运营视图中
     * （需要看已删除的题请走审计日志，那里保留了完整快照）。
     */
    const where: Prisma.QuestionWhereInput = {
      deletedAt: null,
      ...(query.keyword ? { content: { contains: query.keyword, mode: 'insensitive' } } : {}),
      ...(query.testCode ? { testDefinition: { code: query.testCode, deletedAt: null } } : {}),
      ...(dimensions.length > 0 ? { dimension: { in: dimensions } } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.reverseScored === undefined ? {} : { reverseScored: query.reverseScored }),
      ...(tags.length > 0 ? { tags: { hasSome: tags } } : {}),
    };

    const orderBy = this.buildOrderBy(query.sortBy ?? 'order', query.order ?? 'asc');

    const [total, rows, summary] = await Promise.all([
      this.prisma.question.count({ where }),
      this.prisma.question.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          code: true,
          content: true,
          type: true,
          dimension: true,
          weight: true,
          reverseScored: true,
          order: true,
          isActive: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
          testDefinition: { select: { code: true } },
          _count: { select: { options: true } },
        },
      }),
      this.buildSummary(),
    ]);

    const questionIds = rows.map((row) => row.id);

    // usageCount（会话快照引用）与 updatedBy（最后修改人）各一条批量查询，
    // 避免「列表 20 条 → 40 次查询」的 N+1
    const [usageMap, updatedByMap] = await Promise.all([
      this.loadSnapshotUsage(questionIds),
      this.loadLastOperatorNames(questionIds),
    ]);

    return {
      items: rows.map((row) => ({
        questionId: row.id,
        code: row.code,
        content: row.content,
        type: row.type,
        dimension: row.dimension,
        weight: row.weight,
        reverseScored: row.reverseScored,
        order: row.order,
        isActive: row.isActive,
        tags: row.tags,
        // 数据模型里一道题只能归属一个定义（见文件头说明），故这里是 0/1 个元素
        testCodes: row.testDefinition ? [row.testDefinition.code] : [],
        optionCount: row._count.options,
        usageCount: usageMap.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: updatedByMap.get(row.id) ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasNext: query.page * query.pageSize < total,
      summary,
    };
  }

  // ==========================================================================
  // 3.14.3.2 POST /admin/questions — 新建题目
  // ==========================================================================

  async create(
    adminUserId: string,
    dto: CreateAdminQuestionDto,
    context: AdminQuestionRequestContext,
  ): Promise<AdminQuestionCreateResult> {
    const identity = await this.loadAdminIdentity(adminUserId);
    const definition = await this.resolveSingleDefinition(dto.testCodes);

    const content = this.normalizeContent(dto.content);
    if (content.length < MIN_CONTENT_LENGTH) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `清洗后题干长度不足 ${MIN_CONTENT_LENGTH} 个字符`, [
        { field: 'content', issue: '剥离 HTML 标签与多余空白后题干过短' },
      ]);
    }

    const reverseScored = dto.reverseScored ?? false;
    const options = this.resolveOptions(dto.options, dto.type, dto.dimension, reverseScored);

    /**
     * 编码冲突预检：唯一约束对**软删除的题**同样生效（行还在表里），
     * 因此这里要连软删除的一起查，否则运维会拿到一个来自数据库层的 P2002，
     * 既看不出「编码被谁占用」，也不知道该走「修改」还是「恢复」。
     */
    const occupied = await this.prisma.question.findFirst({
      where: { code: dto.code },
      select: { id: true, deletedAt: true },
    });

    if (occupied) {
      throw BusinessException.conflict(
        ErrorCode.RESOURCE_CONFLICT,
        occupied.deletedAt
          ? `题目编码 ${dto.code} 已被一道已删除的题目占用，请改用其它编码`
          : `题目编码 ${dto.code} 已存在`,
        [{ field: 'code', issue: `占用的题目：${occupied.id}` }],
      );
    }

    const statsBefore = await this.loadDimensionStats(definition.id);
    const duplicate = await this.findMostSimilarContent(content, dto.dimension);

    const created = await this.prisma.$transaction(async (tx) => {
      const question = await tx.question.create({
        data: {
          testDefinitionId: definition.id,
          code: dto.code,
          content,
          type: dto.type,
          dimension: dto.dimension,
          weight: dto.weight ?? 1,
          reverseScored,
          order: dto.order ?? 0,
          isActive: dto.isActive ?? true,
          tags: dto.tags ?? [],
          // 与 seed 保持一致：显式声明量表范围，供引擎（minValue/maxValue 分支）使用
          minValue: Math.min(...options.map((option) => option.value)),
          maxValue: Math.max(...options.map((option) => option.value)),
          explanation: dto.explanation === undefined ? null : this.normalizeOptionalText(dto.explanation),
          createdByAdminId: adminUserId,
        },
        select: { id: true, createdAt: true },
      });

      await this.replaceOptions(tx, question.id, options, []);
      // 题量回填：用户端按 questionCount 判定「题量是否充足」，必须与实际可用题量一致
      await this.syncDefinitionQuestionCounts(tx, [definition.id]);

      return question;
    });

    const statsAfter = await this.loadDimensionStats(definition.id);
    const cacheInvalidated = await this.invalidateTestCaches([definition.code]);

    const snapshot = this.buildQuestionSnapshot({
      code: dto.code,
      content,
      type: dto.type,
      dimension: dto.dimension,
      weight: dto.weight ?? 1,
      reverseScored,
      order: dto.order ?? 0,
      isActive: dto.isActive ?? true,
      tags: dto.tags ?? [],
      explanation: dto.explanation === undefined ? null : this.normalizeOptionalText(dto.explanation),
      testCode: definition.code,
      options,
    });

    const auditLogId = await this.writeAudit({
      adminUserId,
      adminUsername: identity.username,
      action: 'CREATE',
      resourceId: created.id,
      beforeData: null,
      afterData: snapshot,
      diffSummary: `新建题目 ${dto.code}`,
      context,
    });

    /**
     * 选项以**落库结果**回读：`optionId` 由数据库生成（uuid7），
     * 不能拿请求体或临时拼接的字符串充数 —— 前端后续要用它做统计与局部编辑。
     */
    const persistedOptions = await this.prisma.questionOption.findMany({
      where: { questionId: created.id },
      orderBy: { order: 'asc' },
      select: { id: true, label: true, value: true, scoreMap: true },
    });

    return {
      questionId: created.id,
      code: dto.code,
      content,
      type: dto.type,
      dimension: dto.dimension,
      weight: dto.weight ?? 1,
      reverseScored,
      order: dto.order ?? 0,
      isActive: dto.isActive ?? true,
      tags: dto.tags ?? [],
      testCodes: [definition.code],
      options: persistedOptions.map((option) => ({
        optionId: option.id,
        label: option.label,
        value: option.value,
        scoreMap: this.readScoreMap(option.scoreMap),
      })),
      validation: this.buildValidation({
        dimension: dto.dimension,
        definition,
        statsBefore,
        statsAfter,
        duplicate,
      }),
      createdAt: created.createdAt.toISOString(),
      createdBy: identity.displayName,
      auditLogId,
      cacheInvalidated,
    };
  }

  // ==========================================================================
  // 3.14.3.3 GET /admin/questions/{id} — 题目详情
  // ==========================================================================

  async detail(questionId: string): Promise<AdminQuestionDetailResult> {
    const question = await this.prisma.question.findUnique({
      where: { id: questionId },
      select: {
        id: true,
        code: true,
        content: true,
        type: true,
        dimension: true,
        weight: true,
        reverseScored: true,
        order: true,
        isActive: true,
        tags: true,
        explanation: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
        testDefinition: { select: { code: true } },
        options: {
          orderBy: { order: 'asc' },
          select: { id: true, label: true, value: true, scoreMap: true },
        },
      },
    });

    // 软删除的题对运营而言等同「不存在」：详情页没有可操作的动作
    if (!question || question.deletedAt !== null) {
      throw BusinessException.notFound(ErrorCode.QUESTION_NOT_FOUND, '题目不存在或已被删除');
    }

    const [statistics, distribution, usageScopes, changeHistory] = await Promise.all([
      this.loadStatistics(question.id),
      this.loadOptionDistribution(question.id),
      this.loadUsageScopes(question.id),
      this.loadChangeHistory(question.id),
    ]);

    const answerCount = statistics.answerCount;

    return {
      questionId: question.id,
      code: question.code,
      content: question.content,
      type: question.type,
      dimension: question.dimension,
      weight: question.weight,
      reverseScored: question.reverseScored,
      order: question.order,
      isActive: question.isActive,
      tags: question.tags,
      testCodes: question.testDefinition ? [question.testDefinition.code] : [],
      explanation: question.explanation,
      options: question.options.map((option) => {
        const selectedCount = distribution.get(option.value) ?? 0;
        return {
          optionId: option.id,
          label: option.label,
          value: option.value,
          scoreMap: this.readScoreMap(option.scoreMap),
          selectedCount,
          selectedRatio: answerCount === 0 ? 0 : this.round(selectedCount / answerCount, 3),
        };
      }),
      statistics,
      usageScopes,
      changeHistory,
      createdAt: question.createdAt.toISOString(),
      updatedAt: question.updatedAt.toISOString(),
    };
  }

  // ==========================================================================
  // 3.14.3.4 PATCH /admin/questions/{id} — 修改题目
  // ==========================================================================

  async update(
    adminUserId: string,
    questionId: string,
    dto: UpdateAdminQuestionDto,
    context: AdminQuestionRequestContext,
  ): Promise<AdminQuestionUpdateResult> {
    const identity = await this.loadAdminIdentity(adminUserId);
    const existing = await this.loadQuestionForWrite(questionId);

    /**
     * 软删除的题对运营等同「不存在」（与详情接口一致）：PATCH 不应「顺手复活」一道已删除的题
     * —— 那会让删除操作失去可预期性。需要恢复请走批量导入的 UPSERT（会显式清空 deletedAt）。
     */
    if (!existing || existing.deletedAt !== null) {
      throw BusinessException.notFound(ErrorCode.QUESTION_NOT_FOUND, '题目不存在或已被删除');
    }

    const nextDimension = dto.dimension ?? existing.dimension;
    const nextReverseScored = dto.reverseScored ?? existing.reverseScored;
    const nextTags = dto.tags ?? existing.tags;
    const nextContent = dto.content === undefined ? existing.content : this.normalizeContent(dto.content);

    if (nextContent.length < MIN_CONTENT_LENGTH) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `清洗后题干长度不足 ${MIN_CONTENT_LENGTH} 个字符`, [
        { field: 'content', issue: '剥离 HTML 标签与多余空白后题干过短' },
      ]);
    }

    // testCodes 传了才动；`[]` 无法表达（数据模型要求必填归属），显式拒绝而不是静默忽略
    const nextDefinition =
      dto.testCodes === undefined
        ? { id: existing.testDefinitionId, code: existing.testDefinitionCode }
        : await this.resolveSingleDefinition(dto.testCodes);

    const nextOptions =
      dto.options === undefined
        ? null
        : this.resolveOptions(dto.options, existing.type, nextDimension, nextReverseScored);

    const nextExplanation =
      dto.explanation === undefined ? existing.explanation : this.normalizeOptionalText(dto.explanation);

    const changedFields = this.diffFields(existing, {
      content: nextContent,
      dimension: nextDimension,
      weight: dto.weight ?? existing.weight,
      reverseScored: nextReverseScored,
      order: dto.order ?? existing.order,
      isActive: dto.isActive ?? existing.isActive,
      tags: nextTags,
      testDefinitionId: nextDefinition.id,
      explanation: nextExplanation,
      options: nextOptions,
    });

    const updatedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.question.update({
        where: { id: questionId },
        data: {
          content: nextContent,
          dimension: nextDimension,
          weight: dto.weight ?? existing.weight,
          reverseScored: nextReverseScored,
          order: dto.order ?? existing.order,
          isActive: dto.isActive ?? existing.isActive,
          tags: nextTags,
          testDefinitionId: nextDefinition.id,
          explanation: nextExplanation,
          ...(nextOptions
            ? {
                minValue: Math.min(...nextOptions.map((option) => option.value)),
                maxValue: Math.max(...nextOptions.map((option) => option.value)),
              }
            : {}),
        },
      });

      if (nextOptions) {
        await this.replaceOptions(tx, questionId, nextOptions, existing.options);
      }

      // 归属变更会同时影响新旧两个定义的题量，必须一起回填
      await this.syncDefinitionQuestionCounts(tx, [existing.testDefinitionId, nextDefinition.id]);
    });

    const cacheInvalidated = await this.invalidateTestCaches([existing.testDefinitionCode, nextDefinition.code]);

    const beforeSnapshot = this.buildQuestionSnapshot({
      code: existing.code,
      content: existing.content,
      type: existing.type,
      dimension: existing.dimension,
      weight: existing.weight,
      reverseScored: existing.reverseScored,
      order: existing.order,
      isActive: existing.isActive,
      tags: existing.tags,
      explanation: existing.explanation,
      testCode: existing.testDefinitionCode,
      options: existing.options.map((option) => ({
        label: option.label,
        value: option.value,
        scoreMap: this.readScoreMap(option.scoreMap),
      })),
    });

    const afterSnapshot = this.buildQuestionSnapshot({
      code: existing.code,
      content: nextContent,
      type: existing.type,
      dimension: nextDimension,
      weight: dto.weight ?? existing.weight,
      reverseScored: nextReverseScored,
      order: dto.order ?? existing.order,
      isActive: dto.isActive ?? existing.isActive,
      tags: nextTags,
      explanation: nextExplanation,
      testCode: nextDefinition.code,
      options: (nextOptions ?? existing.options).map((option) => ({
        label: option.label,
        value: option.value,
        scoreMap: this.readScoreMap(option.scoreMap),
      })),
    });

    const auditLogId = await this.writeAudit({
      adminUserId,
      adminUsername: identity.username,
      action: 'UPDATE',
      resourceId: questionId,
      beforeData: beforeSnapshot,
      afterData: afterSnapshot,
      diffSummary:
        changedFields.length > 0
          ? `修改字段：${changedFields.join(', ')}`
          : `未检测到字段变更（幂等提交），变更说明：${dto.changeNote ?? '无'}`,
      reason: dto.changeNote ?? null,
      context,
    });

    /**
     * 响应的选项以**落库结果**为准：全量替换时 optionId 可能被复用（value 集合不变）
     * 或新建，只有回读才能给出真实 ID —— 直接回显请求体里的结构会漏掉 optionId。
     */
    const persistedOptions = await this.prisma.questionOption.findMany({
      where: { questionId },
      orderBy: { order: 'asc' },
      select: { id: true, label: true, value: true, scoreMap: true },
    });

    return {
      questionId,
      code: existing.code,
      content: nextContent,
      type: existing.type,
      dimension: nextDimension,
      weight: dto.weight ?? existing.weight,
      reverseScored: nextReverseScored,
      order: dto.order ?? existing.order,
      isActive: dto.isActive ?? existing.isActive,
      tags: nextTags,
      testCodes: [nextDefinition.code],
      options: persistedOptions.map((option) => ({
        optionId: option.id,
        label: option.label,
        value: option.value,
        scoreMap: this.readScoreMap(option.scoreMap),
      })),
      changedFields,
      impactAssessment: this.buildImpactAssessment(existing, {
        dimension: nextDimension,
        weight: dto.weight ?? existing.weight,
        reverseScored: nextReverseScored,
      }),
      cacheInvalidated,
      auditLogId,
      updatedAt: updatedAt.toISOString(),
      updatedBy: identity.displayName,
    };
  }

  // ==========================================================================
  // 3.14.3.5 DELETE /admin/questions/{id} — 删除题目（软删除优先）
  // ==========================================================================

  async remove(
    adminUserId: string,
    questionId: string,
    dto: DeleteAdminQuestionDto,
    context: AdminQuestionRequestContext,
  ): Promise<AdminQuestionDeleteResult> {
    const identity = await this.loadAdminIdentity(adminUserId);
    const existing = await this.loadQuestionForWrite(questionId);

    if (!existing) {
      throw BusinessException.notFound(ErrorCode.QUESTION_NOT_FOUND, '题目不存在');
    }

    const definition = await this.loadDefinitionById(existing.testDefinitionId);
    const hardDelete = dto.hardDelete === true;

    // 会话快照引用数（契约口径）与答题记录数（外键口径）都要看：
    // 前者决定「是否影响历史可解释性」，后者决定物理删除会不会撞上 onDelete: Restrict
    const [usageCount, answerCount] = await Promise.all([
      this.loadSnapshotUsage([questionId]).then((map) => map.get(questionId) ?? 0),
      this.prisma.testAnswer.count({ where: { questionId } }),
    ]);

    // 幂等：已删除再删仍返回成功（契约 §3.14.3.5「幂等：是」）
    if (existing.deletedAt !== null) {
      const auditLogId = await this.writeAudit({
        adminUserId,
        adminUsername: identity.username,
        action: 'DELETE',
        resourceId: questionId,
        beforeData: null,
        afterData: null,
        diffSummary: '重复删除（幂等命中，未再次变更数据）',
        reason: dto.reason,
        context,
      });

      return {
        questionId,
        code: existing.code,
        deleted: true,
        hardDelete: false,
        previousIsActive: existing.isActive,
        usageCount,
        affectedTestCodes: [existing.testDefinitionCode],
        impactAssessment: {
          existingSessionsUnaffected: true,
          futureSessionsWithoutThisQuestion: true,
          questionCountAfterDelete: { [existing.testDefinitionCode]: definition?.questionCount ?? 0 },
          sufficientQuota: this.buildSufficientQuota(
            [existing.testDefinitionCode],
            { [existing.testDefinitionCode]: definition?.questionCount ?? 0 },
            this.buildRequiredByCode([definition]),
          ),
        },
        cacheInvalidated: false,
        auditLogId,
        deletedAt: existing.deletedAt.toISOString(),
        deletedBy: identity.displayName,
      };
    }

    if (hardDelete && (usageCount > 0 || answerCount > 0)) {
      /**
       * 契约错误码 `40011`（HTTP 500）在本仓库已被 `PERSONALITY_PROFILE_BUILDING` 占用
       * 且语义完全不同，故按「不得自行新增错误码」的约定退回最接近的
       * `10008 OPERATION_FORBIDDEN`（403）—— 语义（当前操作不被允许）一致，HTTP 码不同。
       * 详见实现简报的契约矛盾清单。
       */
      throw BusinessException.forbidden(
        ErrorCode.OPERATION_FORBIDDEN,
        `该题已被使用（会话快照引用 ${usageCount} 次、答题记录 ${answerCount} 条），禁止物理删除；请改用软删除`,
      );
    }

    const deletedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      if (hardDelete) {
        // 选项由 QuestionOption 的 onDelete: Cascade 一并清理；
        // test_answers 的 Restrict 已在上方用 answerCount 拦截
        await tx.question.delete({ where: { id: questionId } });
      } else {
        await tx.question.update({
          where: { id: questionId },
          data: { isActive: false, deletedAt },
        });
      }

      await this.syncDefinitionQuestionCounts(tx, [existing.testDefinitionId]);
    });

    const cacheInvalidated = await this.invalidateTestCaches([existing.testDefinitionCode]);
    const countsAfter = await this.loadActiveQuestionCounts([existing.testDefinitionId]);
    const countAfter = definition === null ? 0 : (countsAfter.get(definition.id) ?? 0);

    const auditLogId = await this.writeAudit({
      adminUserId,
      adminUsername: identity.username,
      action: 'DELETE',
      resourceId: questionId,
      beforeData: this.buildQuestionSnapshot({
        code: existing.code,
        content: existing.content,
        type: existing.type,
        dimension: existing.dimension,
        weight: existing.weight,
        reverseScored: existing.reverseScored,
        order: existing.order,
        isActive: existing.isActive,
        tags: existing.tags,
        explanation: existing.explanation,
        testCode: existing.testDefinitionCode,
        options: existing.options.map((option) => ({
          label: option.label,
          value: option.value,
          scoreMap: this.readScoreMap(option.scoreMap),
        })),
      }),
      afterData: { deleted: true, hardDelete, deletedAt: hardDelete ? null : deletedAt.toISOString() },
      diffSummary: hardDelete ? `物理删除题目 ${existing.code}` : `软删除题目 ${existing.code}`,
      reason: dto.reason,
      context,
    });

    return {
      questionId,
      code: existing.code,
      deleted: true,
      hardDelete,
      previousIsActive: existing.isActive,
      usageCount,
      affectedTestCodes: [existing.testDefinitionCode],
      impactAssessment: {
        existingSessionsUnaffected: true,
        futureSessionsWithoutThisQuestion: true,
        questionCountAfterDelete: { [existing.testDefinitionCode]: countAfter },
        sufficientQuota: this.buildSufficientQuota(
          [existing.testDefinitionCode],
          { [existing.testDefinitionCode]: countAfter },
          this.buildRequiredByCode([definition]),
        ),
      },
      cacheInvalidated,
      auditLogId,
      deletedAt: deletedAt.toISOString(),
      deletedBy: identity.displayName,
    };
  }

  // ==========================================================================
  // 3.14.3.6 POST /admin/questions/import — 批量导入题目
  // ==========================================================================

  async importQuestions(
    adminUserId: string,
    dto: ImportAdminQuestionsDto,
    context: AdminQuestionRequestContext,
  ): Promise<AdminQuestionImportResult> {
    const identity = await this.loadAdminIdentity(adminUserId);
    const dryRun = dto.dryRun !== false;
    const mode: ImportMode = dto.mode ?? 'APPEND';
    const onError: ImportOnError = dto.onError ?? 'ABORT';

    // 契约错误码 10011（缺 X-Idempotency-Key，当 dryRun = false）；
    // 本仓库该语义的既有码是 10009 IDEMPOTENCY_KEY_MISSING
    if (!dryRun && !context.idempotencyKey) {
      throw BusinessException.badRequest(
        ErrorCode.IDEMPOTENCY_KEY_MISSING,
        '实际写入（dryRun = false）必须携带 X-Idempotency-Key，防止重复导入',
      );
    }

    const idempotencyRedisKey =
      !dryRun && context.idempotencyKey
        ? this.redis.key('idem', 'admin', 'question-import', adminUserId, context.idempotencyKey)
        : null;

    // 幂等重放：直接回放首次写入的响应体（不重复写库，也不再写审计）
    if (idempotencyRedisKey) {
      const replay = await this.safeGetJson<AdminQuestionImportWriteResult>(idempotencyRedisKey);
      if (replay) {
        this.logger.log(`批量导入幂等命中 adminUserId=${adminUserId} key=${context.idempotencyKey ?? ''}`);
        return replay;
      }
    }

    const byteLength = Buffer.byteLength(dto.data, 'utf8');
    if (byteLength > MAX_IMPORT_BYTES) {
      // 契约错误码 10006/413 在本仓库映射为 415（UNSUPPORTED_MEDIA_TYPE），
      // 因此改用同为「体积超限」语义的 10005 PAYLOAD_TOO_LARGE（413），HTTP 码与契约一致
      throw new BusinessException(ErrorCode.PAYLOAD_TOO_LARGE, `导入数据超过 ${MAX_IMPORT_BYTES} 字节上限`, {
        httpStatus: 413,
      });
    }

    if (mode === 'REPLACE' && !dto.testCode) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        'REPLACE 模式必须指定 testCode（该模式会删除该测试下未出现在导入数据中的题目，作用域不能含糊）',
      );
    }

    const analysis = await this.analyzeImport(dto, mode);

    if (analysis.totalParsed > MAX_IMPORT_ROWS) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `单批最多 ${MAX_IMPORT_ROWS} 题（当前 ${analysis.totalParsed} 题），请分批导入`,
        [{ field: 'data', issue: `超出同步导入上限 ${MAX_IMPORT_ROWS}` }],
      );
    }

    // ---------------------------------------------------------------- 试运行
    if (dryRun) {
      const auditLogId = await this.writeAudit({
        adminUserId,
        adminUsername: identity.username,
        action: 'IMPORT',
        resourceId: null,
        beforeData: null,
        afterData: { dryRun: true, mode, totalParsed: analysis.totalParsed, errors: analysis.errors.length },
        diffSummary: `批量导入试运行（${dto.format} / ${mode}）：解析 ${analysis.totalParsed} 行，问题 ${analysis.errors.length} 处`,
        context,
      });

      const wouldCreate = analysis.rows.filter((row) => row.action === 'CREATE').length;
      const wouldUpdate = analysis.rows.filter((row) => row.action === 'UPDATE').length;

      return {
        dryRun: true,
        format: dto.format,
        mode,
        testCode: dto.testCode ?? null,
        totalParsed: analysis.totalParsed,
        validCount: analysis.rows.length,
        invalidCount: analysis.errors.length,
        wouldCreate,
        wouldUpdate,
        wouldDelete: analysis.wouldDelete.length,
        errors: analysis.errors,
        warnings: analysis.warnings,
        preview: analysis.rows.slice(0, IMPORT_PREVIEW_LIMIT).map((row) => ({
          row: row.row,
          code: row.code,
          content: row.content,
          dimension: row.dimension,
          type: row.type,
          action: row.action,
        })),
        affectedTestCodes: analysis.affectedTestCodes,
        cacheInvalidated: false,
        nextStep: '确认无误后，请以 dryRun=false 重新提交以实际写入（需携带 X-Idempotency-Key）。',
        auditLogId,
      };
    }

    // ------------------------------------------------------- 写入前的整体拒绝
    if (analysis.errors.length > 0 && onError === 'ABORT') {
      await this.writeAudit({
        adminUserId,
        adminUsername: identity.username,
        action: 'IMPORT',
        resourceId: null,
        beforeData: null,
        afterData: null,
        diffSummary: `批量导入被拒绝（ABORT）：${analysis.errors.length} 行不合法，整批未写入`,
        success: false,
        errorCode: String(ErrorCode.PARAM_INVALID),
        context,
      });

      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `导入数据存在 ${analysis.errors.length} 处问题，已整体回滚（onError = ABORT）`,
        analysis.errors.slice(0, 20).map((error) => ({
          field: `row[${error.row}].${error.field}`,
          issue: `${error.issue}：${error.message}`,
        })),
      );
    }

    const definitionList = [...analysis.definitions.values()];
    const countsBefore = await this.loadActiveQuestionCounts(definitionList.map((definition) => definition.id));
    const requiredBefore = this.loadRequiredCounts(analysis.definitions);

    const written = await this.prisma.$transaction(async (tx) => {
      let createdCount = 0;
      let updatedCount = 0;
      const createdQuestionIds: string[] = [];

      for (const row of analysis.rows) {
        const data = {
          content: row.content,
          dimension: row.dimension,
          weight: row.weight,
          reverseScored: row.reverseScored,
          order: row.order,
          isActive: row.isActive,
          tags: row.tags,
          explanation: row.explanation,
          testDefinitionId: row.testDefinitionId,
          minValue: Math.min(...row.options.map((option) => option.value)),
          maxValue: Math.max(...row.options.map((option) => option.value)),
        };

        if (row.existingId) {
          await tx.question.update({
            where: { id: row.existingId },
            data: {
              ...data,
              // UPSERT 命中软删除的题时一并恢复（否则「更新成功」但运营在列表里看不到）
              deletedAt: null,
            },
          });

          const existingOptions = await tx.questionOption.findMany({
            where: { questionId: row.existingId },
            select: { id: true, value: true, order: true },
          });

          await this.replaceOptions(tx, row.existingId, row.options, existingOptions);
          updatedCount += 1;
          continue;
        }

        const created = await tx.question.create({
          data: { code: row.code, type: row.type, createdByAdminId: adminUserId, ...data },
          select: { id: true },
        });

        await this.replaceOptions(tx, created.id, row.options, []);
        createdQuestionIds.push(created.id);
        createdCount += 1;
      }

      // REPLACE：软删除该测试下未出现在本次导入数据中的题（快照不受影响，未来会话不再抽到）
      for (const target of analysis.wouldDelete) {
        await tx.question.update({
          where: { id: target.id },
          data: { isActive: false, deletedAt: new Date() },
        });
      }

      await this.syncDefinitionQuestionCounts(
        tx,
        definitionList.map((definition) => definition.id),
      );

      return { createdCount, updatedCount, createdQuestionIds, deletedCount: analysis.wouldDelete.length };
    });

    const countsAfter = await this.loadActiveQuestionCounts(definitionList.map((definition) => definition.id));
    const cacheInvalidated = await this.invalidateTestCaches(analysis.affectedTestCodes);

    // 写入后按**实际**题量重算维度均衡告警（试运行阶段是估算值）
    const actualWarnings = await this.buildDimensionWarnings(analysis.definitions);

    const auditLogId = await this.writeAudit({
      adminUserId,
      adminUsername: identity.username,
      action: 'IMPORT',
      resourceId: null,
      // Map 不是 JSON，审计前统一转成普通对象（否则 JSONB 写入会丢值）
      beforeData: {
        questionCounts: Object.fromEntries(countsBefore),
        requiredCounts: Object.fromEntries(requiredBefore),
      },
      afterData: {
        createdCount: written.createdCount,
        updatedCount: written.updatedCount,
        deletedCount: written.deletedCount,
        questionCounts: Object.fromEntries(countsAfter),
      },
      diffSummary: `批量导入（${dto.format} / ${mode}）：新增 ${written.createdCount}、更新 ${written.updatedCount}、删除 ${written.deletedCount}、跳过 ${analysis.errors.length}`,
      context,
    });

    const testDefinitionImpact: AdminQuestionImportWriteResult['testDefinitionImpact'] = {};

    for (const definition of definitionList) {
      const before = countsBefore.get(definition.id) ?? 0;
      const after = countsAfter.get(definition.id) ?? 0;
      const required = requiredBefore.get(definition.code) ?? before;

      testDefinitionImpact[definition.code] = {
        activeQuestionCountBefore: before,
        activeQuestionCountAfter: after,
        requiredCount: required,
        isSufficient: after >= required,
      };
    }

    const result: AdminQuestionImportWriteResult = {
      dryRun: false,
      format: dto.format,
      mode,
      testCode: dto.testCode ?? null,
      totalParsed: analysis.totalParsed,
      createdCount: written.createdCount,
      updatedCount: written.updatedCount,
      deletedCount: written.deletedCount,
      skippedCount: analysis.errors.length,
      errors: analysis.errors,
      warnings: actualWarnings,
      createdQuestionIds: written.createdQuestionIds,
      testDefinitionImpact,
      cacheInvalidated,
      auditLogId,
      importedAt: new Date().toISOString(),
      importedBy: identity.displayName,
    };

    await this.safeSetJson(idempotencyRedisKey, result, IMPORT_IDEMPOTENCY_TTL_SECONDS);

    this.logger.log(
      `批量导入完成 adminUserId=${adminUserId} format=${dto.format} mode=${mode} 新增=${written.createdCount} 更新=${written.updatedCount} 删除=${written.deletedCount} 跳过=${analysis.errors.length}`,
    );

    return result;
  }

  // ==========================================================================
  // 3.14.3.7 POST /admin/questions/{id}/toggle — 启用/停用
  // ==========================================================================

  async toggle(
    adminUserId: string,
    questionId: string,
    dto: ToggleAdminQuestionDto,
    context: AdminQuestionRequestContext,
  ): Promise<AdminQuestionToggleResult> {
    const identity = await this.loadAdminIdentity(adminUserId);
    const existing = await this.loadQuestionForWrite(questionId);

    // 与详情/PATCH 一致：已软删除的题不可通过 toggle 复活（恢复走导入 UPSERT）
    if (!existing || existing.deletedAt !== null) {
      throw BusinessException.notFound(ErrorCode.QUESTION_NOT_FOUND, '题目不存在或已被删除');
    }

    const definition = await this.loadDefinitionById(existing.testDefinitionId);
    const previousIsActive = existing.isActive;

    // 幂等：目标状态与当前一致时**不写库**（避免无意义的 updatedAt 抖动与缓存失效）
    const changed = previousIsActive !== dto.isActive;
    let updatedAt = existing.updatedAt;
    let cacheInvalidated = false;

    if (changed) {
      updatedAt = new Date();

      await this.prisma.$transaction(async (tx) => {
        await tx.question.update({
          where: { id: questionId },
          data: { isActive: dto.isActive },
        });
        // 停用会直接减少可用题量，必须同步 questionCount，否则用户端可能 40011
        await this.syncDefinitionQuestionCounts(tx, [existing.testDefinitionId]);
      });

      cacheInvalidated = await this.invalidateTestCaches([existing.testDefinitionCode]);
    }

    const countsAfter = await this.loadActiveQuestionCounts([existing.testDefinitionId]);
    const countAfter = definition === null ? 0 : (countsAfter.get(definition.id) ?? 0);

    const auditLogId = await this.writeAudit({
      adminUserId,
      adminUsername: identity.username,
      action: dto.isActive ? 'UPDATE' : 'UNPUBLISH',
      resourceId: questionId,
      beforeData: { isActive: previousIsActive },
      afterData: { isActive: dto.isActive },
      diffSummary: changed
        ? `isActive: ${String(previousIsActive)} → ${String(dto.isActive)}`
        : '状态未变化（幂等命中，未再次变更数据）',
      reason: dto.reason ?? null,
      context,
    });

    return {
      questionId,
      code: existing.code,
      previousIsActive,
      isActive: dto.isActive,
      reason: dto.reason ?? null,
      affectedTestCodes: [existing.testDefinitionCode],
      impactAssessment: {
        existingSessionsUnaffected: true,
        questionCountAfterToggle: { [existing.testDefinitionCode]: countAfter },
        sufficientQuota: this.buildSufficientQuota(
          [existing.testDefinitionCode],
          { [existing.testDefinitionCode]: countAfter },
          this.buildRequiredByCode([definition]),
        ),
      },
      cacheInvalidated,
      auditLogId,
      updatedAt: updatedAt.toISOString(),
    };
  }

  // ==========================================================================
  // 内部：导入分析与解析
  // ==========================================================================

  /** 解析 + 逐行校验 + 与库内状态比对，产出试运行与写入共用的分析结果 */
  private async analyzeImport(dto: ImportAdminQuestionsDto, mode: ImportMode): Promise<ImportAnalysis> {
    const parsed = this.parseImportPayload(dto.format, dto.data);
    const errors: AdminQuestionImportIssue[] = [...parsed.errors];
    const warnings: AdminQuestionImportIssue[] = [];
    const definitions = await this.loadAffectedDefinitions(dto.testCode, parsed.rows);

    const rows: PreparedImportRow[] = [];
    const seenCodes = new Map<string, number>();

    for (const raw of parsed.rows) {
      const rowNumber = raw.__row;
      const normalized = this.normalizeImportRow(raw, rowNumber, dto.testCode, definitions);

      if (!normalized.ok) {
        errors.push(normalized.issue);
        continue;
      }

      const row = normalized.value;

      // 批次内编码唯一：唯一约束是全局的，同批出现两次必然有一行失败，
      // 与其让数据库报错，不如明确指出「第 N 行与第 M 行重复」
      const duplicatedAt = seenCodes.get(row.code);

      if (duplicatedAt !== undefined) {
        errors.push({
          row: rowNumber,
          code: row.code,
          field: 'code',
          issue: 'DUPLICATE_CODE_IN_PAYLOAD',
          message: `第 ${rowNumber} 行的 code 与第 ${duplicatedAt} 行重复，同一批次内编码必须唯一`,
        });
        continue;
      }

      seenCodes.set(row.code, rowNumber);
      rows.push({ ...row, existingId: null, action: 'CREATE' });
    }

    // 与库内已有编码比对：APPEND 命中即报错，UPSERT / REPLACE 转为更新
    const existingRows =
      rows.length === 0
        ? []
        : await this.prisma.question.findMany({
            where: { code: { in: rows.map((row) => row.code) } },
            select: { id: true, code: true, type: true, deletedAt: true },
          });

    const existingByCode = new Map(existingRows.map((row) => [row.code, row]));
    const survivors: PreparedImportRow[] = [];

    for (const row of rows) {
      const existing = existingByCode.get(row.code);

      if (!existing) {
        survivors.push(row);
        continue;
      }

      if (mode === 'APPEND') {
        errors.push({
          row: row.row,
          code: row.code,
          field: 'code',
          issue: 'CODE_EXISTS',
          message: existing.deletedAt
            ? `编码 ${row.code} 已被一道已删除的题目占用（APPEND 不会覆盖），请改用 UPSERT`
            : `编码 ${row.code} 已存在（APPEND 模式不更新既有题目），如需覆盖请使用 UPSERT`,
        });
        continue;
      }

      if (existing.type !== row.type) {
        // type 变更会破坏已有选项结构（与 PATCH 同一约束），导入路径同样只告警不改写
        warnings.push({
          row: row.row,
          code: row.code,
          field: 'type',
          issue: 'TYPE_IMMUTABLE_IGNORED',
          message: `既有题目 ${row.code} 的题型为 ${existing.type}，本次导入的 ${row.type} 被忽略（题型不可变，如需换题型请新建题目并下线旧题）`,
        });
      }

      if (existing.deletedAt) {
        warnings.push({
          row: row.row,
          code: row.code,
          field: 'code',
          issue: 'QUESTION_RESTORED',
          message: `编码 ${row.code} 指向一道已删除的题目，本次导入将恢复并覆盖它`,
        });
      }

      survivors.push({ ...row, type: existing.type, existingId: existing.id, action: 'UPDATE' });
    }

    // REPLACE：该测试下未出现在导入数据中的题 → 软删除
    const wouldDelete: ImportAnalysis['wouldDelete'] = [];

    if (mode === 'REPLACE') {
      const payloadCodes = new Set(survivors.map((row) => row.code));

      for (const definition of definitions.values()) {
        const leftovers = await this.prisma.question.findMany({
          where: { testDefinitionId: definition.id, deletedAt: null },
          select: { id: true, code: true, dimension: true },
        });

        for (const leftover of leftovers) {
          if (payloadCodes.has(leftover.code)) continue;
          wouldDelete.push({
            id: leftover.id,
            code: leftover.code,
            testCode: definition.code,
            dimension: leftover.dimension,
          });
        }
      }
    }

    const affectedTestCodes = [
      ...new Set<string>([...survivors.map((row) => row.testCode), ...wouldDelete.map((row) => row.testCode)]),
    ].sort();

    const estimatedWarnings = await this.buildDimensionWarnings(definitions, {
      rows: survivors,
      deleted: wouldDelete,
    });

    return {
      totalParsed: parsed.rows.length,
      rows: survivors,
      errors,
      warnings: [...warnings, ...estimatedWarnings],
      wouldDelete,
      definitions,
      affectedTestCodes,
    };
  }

  /** 按格式解析出「行对象 + 行号」，解析层面的问题也逐条返回而不是抛出 */
  private parseImportPayload(
    format: ImportFormat,
    data: string,
  ): { rows: Array<Record<string, unknown> & { __row: number }>; errors: AdminQuestionImportIssue[] } {
    return format === 'JSON' ? this.parseJsonPayload(data) : this.parseCsvPayload(data);
  }

  private parseJsonPayload(data: string): {
    rows: Array<Record<string, unknown> & { __row: number }>;
    errors: AdminQuestionImportIssue[];
  } {
    let parsed: unknown;

    try {
      parsed = JSON.parse(data);
    } catch (error) {
      return {
        rows: [],
        errors: [
          {
            row: 0,
            code: null,
            field: 'data',
            issue: 'INVALID_JSON',
            message: `data 不是合法 JSON：${error instanceof Error ? error.message : '解析失败'}`,
          },
        ],
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        rows: [],
        errors: [
          {
            row: 0,
            code: null,
            field: 'data',
            issue: 'INVALID_JSON_SHAPE',
            message: 'JSON 格式的 data 必须是题目对象数组',
          },
        ],
      };
    }

    const errors: AdminQuestionImportIssue[] = [];
    const rows: Array<Record<string, unknown> & { __row: number }> = [];

    parsed.forEach((item, index) => {
      const rowNumber = index + 1;

      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        errors.push({
          row: rowNumber,
          code: null,
          field: 'row',
          issue: 'INVALID_ROW_SHAPE',
          message: `第 ${rowNumber} 行不是对象`,
        });
        return;
      }

      rows.push({ ...(item as Record<string, unknown>), __row: rowNumber });
    });

    return { rows, errors };
  }

  /**
   * CSV 解析
   *
   * 只支持契约约定的表头（§3.14.3.6 业务规则 2）。行号取「数据行序号（不含表头，从 1 起）」，
   * 与 JSON 格式的数组下标语义对齐 —— 契约的错误示例里 `row: 3` 指向的正是第 3 个题目。
   */
  private parseCsvPayload(data: string): {
    rows: Array<Record<string, unknown> & { __row: number }>;
    errors: AdminQuestionImportIssue[];
  } {
    const records = this.parseCsvRecords(data).filter((record) => record.some((field) => field.trim() !== ''));

    if (records.length === 0) {
      return {
        rows: [],
        errors: [{ row: 0, code: null, field: 'data', issue: 'EMPTY_CSV', message: 'CSV 内容为空（至少需要表头行）' }],
      };
    }

    const header = (records[0] ?? []).map((field) => field.trim());
    const missingColumns = IMPORT_CSV_COLUMNS.filter((column) => !header.includes(column));

    if (missingColumns.length > 0) {
      return {
        rows: [],
        errors: [
          {
            row: 0,
            code: null,
            field: 'data',
            issue: 'INVALID_CSV_HEADER',
            message: `CSV 表头缺少列：${missingColumns.join(', ')}（约定表头：${IMPORT_CSV_COLUMNS.join(',')}）`,
          },
        ],
      };
    }

    const indexOf = (column: string): number => header.indexOf(column);
    const errors: AdminQuestionImportIssue[] = [];
    const rows: Array<Record<string, unknown> & { __row: number }> = [];

    for (let index = 1; index < records.length; index += 1) {
      const record = records[index] ?? [];
      const rowNumber = index;
      const cell = (column: string): string => (record[indexOf(column)] ?? '').trim();
      const code = cell('code');

      const optionLabels = this.splitPipe(cell('optionLabels'));
      const optionValues = this.splitPipe(cell('optionValues'));
      const scoreMapCells = this.splitPipe(cell('scoreMaps'));

      if (optionLabels.length !== optionValues.length || optionLabels.length !== scoreMapCells.length) {
        errors.push({
          row: rowNumber,
          code: code === '' ? null : code,
          field: 'options',
          issue: 'CSV_OPTION_COLUMN_MISMATCH',
          message: `第 ${rowNumber} 行的 optionLabels/optionValues/scoreMaps 列数量不一致（${optionLabels.length}/${optionValues.length}/${scoreMapCells.length}）`,
        });
        continue;
      }

      const options: Array<Record<string, unknown>> = [];
      let scoreMapIssue: AdminQuestionImportIssue | null = null;

      for (let optionIndex = 0; optionIndex < optionLabels.length; optionIndex += 1) {
        const scoreMap = this.parseCsvScoreMap(scoreMapCells[optionIndex] ?? '');

        if (scoreMap === null) {
          scoreMapIssue = {
            row: rowNumber,
            code: code === '' ? null : code,
            field: 'scoreMaps',
            issue: 'INVALID_SCORE_MAP',
            message: `第 ${rowNumber} 行的 scoreMaps 片段「${scoreMapCells[optionIndex] ?? ''}」无法解析（约定 DIM:分值，多维度用 ; 分隔）`,
          };
          break;
        }

        options.push({
          label: optionLabels[optionIndex] ?? '',
          value: optionValues[optionIndex] ?? '',
          scoreMap,
        });
      }

      if (scoreMapIssue) {
        errors.push(scoreMapIssue);
        continue;
      }

      rows.push({
        __row: rowNumber,
        code,
        content: cell('content'),
        type: cell('type'),
        dimension: cell('dimension'),
        weight: cell('weight'),
        reverseScored: cell('reverseScored'),
        order: cell('order'),
        tags: this.splitPipe(cell('tags')),
        options,
      });
    }

    return { rows, errors };
  }

  /** 单行的语义校验与归一化（与 DTO 的结构校验共用同一批常量） */
  private normalizeImportRow(
    raw: Record<string, unknown> & { __row: number },
    rowNumber: number,
    uniformTestCode: TestCodeValue | undefined,
    definitions: Map<string, DefinitionRef>,
  ):
    | { ok: true; value: Omit<PreparedImportRow, 'existingId' | 'action'> }
    | { ok: false; issue: AdminQuestionImportIssue } {
    const fail = (field: string, issue: string, message: string): { ok: false; issue: AdminQuestionImportIssue } => ({
      ok: false,
      issue: { row: rowNumber, code: this.readString(raw['code']), field, issue, message },
    });

    const code = this.readString(raw['code'])?.trim() ?? '';

    if (code.length < 3 || code.length > QUESTION_CODE_MAX_LENGTH || !QUESTION_CODE_PATTERN.test(code)) {
      return fail('code', 'INVALID_CODE', `code 需匹配 ^Q_[A-Z0-9_]+$ 且长度 3–32（收到「${code}」）`);
    }

    const rawContent = this.readString(raw['content']) ?? '';
    const content = this.normalizeContent(rawContent);

    if (content.length < MIN_CONTENT_LENGTH || content.length > MAX_CONTENT_LENGTH) {
      return fail(
        'content',
        'INVALID_CONTENT',
        `content 清洗后长度需在 ${MIN_CONTENT_LENGTH}–${MAX_CONTENT_LENGTH} 之间（收到 ${content.length}）`,
      );
    }

    const type = this.readString(raw['type']) ?? '';

    if (!(QUESTION_TYPES as readonly string[]).includes(type)) {
      return fail('type', 'INVALID_TYPE', `type 仅支持：${QUESTION_TYPES.join(' / ')}`);
    }

    const dimension = this.readString(raw['dimension']) ?? '';

    if (!(QUESTION_DIMENSIONS as readonly string[]).includes(dimension)) {
      return fail('dimension', 'INVALID_DIMENSION', `dimension 取值不合法（收到「${dimension}」）`);
    }

    const weight = this.readNumber(raw['weight'], 1);

    if (weight === null || weight < MIN_WEIGHT || weight > MAX_WEIGHT || !this.hasSingleDecimal(weight)) {
      return fail('weight', 'INVALID_WEIGHT', `weight 需在 ${MIN_WEIGHT}–${MAX_WEIGHT} 之间且最多 1 位小数`);
    }

    const order = this.readNumber(raw['order'], 0);

    if (order === null || !Number.isInteger(order) || order < MIN_QUESTION_ORDER || order > MAX_QUESTION_ORDER) {
      return fail('order', 'INVALID_ORDER', `order 需为 ${MIN_QUESTION_ORDER}–${MAX_QUESTION_ORDER} 的整数`);
    }

    const reverseScored = this.readBoolean(raw['reverseScored'], false);

    if (reverseScored === null) {
      return fail('reverseScored', 'INVALID_BOOLEAN', 'reverseScored 必须是布尔值');
    }

    const isActive = this.readBoolean(raw['isActive'], true);

    if (isActive === null) {
      return fail('isActive', 'INVALID_BOOLEAN', 'isActive 必须是布尔值');
    }

    const tags = this.readStringArray(raw['tags']);

    if (tags === null) {
      return fail('tags', 'INVALID_TAGS', 'tags 必须是字符串数组');
    }

    if (tags.length > MAX_TAGS) {
      return fail('tags', 'TOO_MANY_TAGS', `tags 最多 ${MAX_TAGS} 个（收到 ${tags.length} 个）`);
    }

    if (tags.some((tag) => tag.length === 0 || tag.length > MAX_TAG_LENGTH)) {
      return fail('tags', 'INVALID_TAG_LENGTH', `tags 元素长度需在 1–${MAX_TAG_LENGTH} 之间`);
    }

    const explanationRaw = this.readString(raw['explanation']);

    if (explanationRaw !== null && explanationRaw.length > MAX_EXPLANATION_LENGTH) {
      return fail('explanation', 'INVALID_EXPLANATION', `explanation 最长 ${MAX_EXPLANATION_LENGTH} 个字符`);
    }

    // 归属定义：行内可覆盖请求级的 testCode；数据模型只支持单归属
    const rowTestCodes = this.readStringArray(raw['testCodes']);
    const rowTestCode = this.readString(raw['testCode']);
    const requestedCodes = rowTestCodes ?? (rowTestCode === null ? [] : [rowTestCode]);

    if (requestedCodes.length > 1) {
      return fail(
        'testCodes',
        'UNSUPPORTED_MULTIPLE_TEST_CODES',
        `本实现不支持多归属（数据模型 Question.testDefinitionId 为必填外键），请只提供 1 个 testCode`,
      );
    }

    const testCode = requestedCodes[0] ?? uniformTestCode ?? null;

    if (testCode === null) {
      return fail(
        'testCode',
        'MISSING_TEST_CODE',
        '缺少 testCode：数据模型要求每道题必须归属一个测试定义（请求级 testCode 或行内 testCode 二选一）',
      );
    }

    if (!(TEST_CODE_WHITELIST as readonly string[]).includes(testCode)) {
      return fail('testCode', 'INVALID_TEST_CODE', `testCode 仅支持：${TEST_CODE_WHITELIST.join(' / ')}`);
    }

    const definition = definitions.get(testCode);

    if (!definition) {
      return fail('testCode', 'TEST_CODE_NOT_FOUND', `测试定义 ${testCode} 不存在（请在后台先创建该定义）`);
    }

    const options = this.resolveImportOptions(
      raw['options'],
      type as QuestionType,
      dimension as Dimension,
      reverseScored,
    );

    if (!options.ok) {
      return {
        ok: false,
        issue: { row: rowNumber, code, field: options.field, issue: options.issue, message: options.message },
      };
    }

    return {
      ok: true,
      value: {
        row: rowNumber,
        code,
        content,
        type: type as QuestionType,
        dimension: dimension as Dimension,
        weight,
        reverseScored,
        order,
        isActive,
        tags,
        explanation: explanationRaw === null ? null : this.normalizeOptionalText(explanationRaw),
        options: options.value,
        testCode,
        testDefinitionId: definition.id,
      },
    };
  }

  /** 导入用选项归一化：LIKERT5 可省略（服务端生成），其余题型必填 */
  private resolveImportOptions(
    raw: unknown,
    type: QuestionType,
    dimension: Dimension,
    reverseScored: boolean,
  ): ValidationResult<NormalizedOption[]> {
    if (raw === undefined || raw === null) {
      if (type === 'LIKERT5') {
        return { ok: true, value: this.buildLikert5Options(dimension, reverseScored) };
      }
      return {
        ok: false,
        field: 'options',
        issue: 'OPTIONS_REQUIRED',
        message: `${type} 题型必须提供 options（只有 LIKERT5 可由服务端生成默认选项）`,
      };
    }

    if (!Array.isArray(raw)) {
      return { ok: false, field: 'options', issue: 'INVALID_OPTIONS', message: 'options 必须是数组' };
    }

    return this.normalizeOptions(raw, type);
  }

  /** 导入行的归属定义集合：请求级 testCode + 行内 testCode */
  private async loadAffectedDefinitions(
    uniformTestCode: TestCodeValue | undefined,
    rows: Array<Record<string, unknown> & { __row: number }>,
  ): Promise<Map<string, DefinitionRef>> {
    const codes = new Set<string>();

    if (uniformTestCode) codes.add(uniformTestCode);

    for (const row of rows) {
      const rowTestCodes = this.readStringArray(row['testCodes']);
      const rowTestCode = this.readString(row['testCode']);

      for (const code of rowTestCodes ?? (rowTestCode === null ? [] : [rowTestCode])) {
        codes.add(code);
      }
    }

    if (codes.size === 0) return new Map();

    const definitions = await this.prisma.testDefinition.findMany({
      where: { code: { in: [...codes] }, deletedAt: null },
      select: { id: true, code: true, questionCount: true, dimensionQuotas: true },
    });

    return new Map(
      definitions.map((definition) => [
        definition.code,
        {
          id: definition.id,
          code: definition.code,
          questionCount: definition.questionCount,
          dimensionQuotas: this.readDimensionQuotas(definition.dimensionQuotas),
        },
      ]),
    );
  }

  // ==========================================================================
  // 内部：题目 / 定义读取
  // ==========================================================================

  /** 写入路径用的题目读取（含选项，用于 before/after 快照与选项替换） */
  private async loadQuestionForWrite(questionId: string): Promise<{
    id: string;
    code: string;
    content: string;
    type: QuestionType;
    dimension: Dimension;
    weight: number;
    reverseScored: boolean;
    order: number;
    isActive: boolean;
    tags: string[];
    explanation: string | null;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    testDefinitionId: string;
    testDefinitionCode: string;
    options: Array<{ id: string; label: string; value: number; scoreMap: unknown; order: number }>;
  } | null> {
    return this.prisma.question
      .findUnique({
        where: { id: questionId },
        select: {
          id: true,
          code: true,
          content: true,
          type: true,
          dimension: true,
          weight: true,
          reverseScored: true,
          order: true,
          isActive: true,
          tags: true,
          explanation: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          testDefinitionId: true,
          testDefinition: { select: { code: true } },
          options: {
            orderBy: { order: 'asc' },
            select: { id: true, label: true, value: true, scoreMap: true, order: true },
          },
        },
      })
      .then((question) => {
        if (!question) return null;

        return {
          id: question.id,
          code: question.code,
          content: question.content,
          type: question.type,
          dimension: question.dimension,
          weight: question.weight,
          reverseScored: question.reverseScored,
          order: question.order,
          isActive: question.isActive,
          tags: question.tags,
          explanation: question.explanation,
          deletedAt: question.deletedAt,
          createdAt: question.createdAt,
          updatedAt: question.updatedAt,
          testDefinitionId: question.testDefinitionId,
          testDefinitionCode: question.testDefinition.code,
          options: question.options,
        };
      });
  }

  private async loadDefinitionById(definitionId: string): Promise<DefinitionRef | null> {
    const definition = await this.prisma.testDefinition.findUnique({
      where: { id: definitionId },
      select: { id: true, code: true, questionCount: true, dimensionQuotas: true },
    });

    if (!definition) return null;

    return {
      id: definition.id,
      code: definition.code,
      questionCount: definition.questionCount,
      dimensionQuotas: this.readDimensionQuotas(definition.dimensionQuotas),
    };
  }

  /**
   * 解析并校验 `testCodes`
   *
   * 数据模型是「一题一归属」（`Question.testDefinitionId` 必填），契约却允许多归属
   * （样例请求带 `["MBTI_LITE","MBTI_FULL"]`）。这里**显式拒绝**多归属与空数组，
   * 而不是「取第一个、静默丢弃其余」：静默丢弃会让调用方以为题已经挂到两个测试下，
   * 直到用户端抽题时才发现少了。详见实现简报的契约矛盾清单。
   */
  private async resolveSingleDefinition(testCodes: string[] | undefined): Promise<DefinitionRef> {
    if (testCodes === undefined || testCodes.length === 0) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        'testCodes 必填且需包含 1 个测试定义（数据模型 Question.testDefinitionId 为必填外键，无法表达「不归属任何测试」）',
        [{ field: 'testCodes', issue: '缺失或为空数组' }],
      );
    }

    if (testCodes.length > 1) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        '本实现只支持单归属：数据模型 Question.testDefinitionId 为必填外键，无法表达多归属（需新增关联表才能支持）',
        [{ field: 'testCodes', issue: `收到 ${testCodes.length} 个测试定义，仅支持 1 个` }],
      );
    }

    const code = testCodes[0] ?? '';
    const definition = await this.prisma.testDefinition.findFirst({
      where: { code, deletedAt: null },
      select: { id: true, code: true, questionCount: true, dimensionQuotas: true },
    });

    if (!definition) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `测试定义 ${code} 不存在`, [
        {
          field: 'testCodes',
          issue: `库中不存在 code=${code} 的测试定义（白名单：${TEST_CODE_WHITELIST.join(' / ')}）`,
        },
      ]);
    }

    return {
      id: definition.id,
      code: definition.code,
      questionCount: definition.questionCount,
      dimensionQuotas: this.readDimensionQuotas(definition.dimensionQuotas),
    };
  }

  // ==========================================================================
  // 内部：选项写入与替换
  // ==========================================================================

  /**
   * 选项全量替换
   *
   * 契约 §3.14.3.4 规则 2：传入数组即最终状态；**若 value 集合不变则保留原 optionId**
   * （保持统计连续性）。实现要点：
   *   · `(questionId, order)` 上有唯一约束，重排顺序时直接改 `order` 会撞约束，
   *     因此先把「被复用」的选项移到临时 order（10 万段，远离业务取值域）再落最终值；
   *   · 未匹配的选项直接删除（不是置 isActive=false）：选项没有历史引用，
   *     留着会让 `optionCount` 与「实际可用选项」永久不一致。
   */
  private async replaceOptions(
    tx: Prisma.TransactionClient,
    questionId: string,
    options: NormalizedOption[],
    existingOptions: Array<{ id: string; value: number; order: number }>,
  ): Promise<void> {
    const existingByValue = new Map(existingOptions.map((option) => [option.value, option]));
    const reused: Array<{ id: string; targetOrder: number; option: NormalizedOption }> = [];
    const created: Array<{ order: number; option: NormalizedOption }> = [];

    options.forEach((option, index) => {
      const matched = existingByValue.get(option.value);

      if (matched) {
        reused.push({ id: matched.id, targetOrder: index, option });
      } else {
        created.push({ order: index, option });
      }
    });

    const reusedIds = new Set(reused.map((item) => item.id));
    const obsolete = existingOptions.filter((option) => !reusedIds.has(option.id));

    // 先删多余项，腾出可能被占用的 order
    for (const option of obsolete) {
      await tx.questionOption.delete({ where: { id: option.id } });
    }

    // 再临时挪位，最后落最终 order —— 全程避免 (questionId, order) 唯一约束冲突
    for (const item of reused) {
      await tx.questionOption.update({
        where: { id: item.id },
        data: { order: OPTION_TEMP_ORDER_BASE + item.targetOrder },
      });
    }

    for (const item of reused) {
      await tx.questionOption.update({
        where: { id: item.id },
        data: {
          order: item.targetOrder,
          label: item.option.label,
          value: item.option.value,
          scoreMap: item.option.scoreMap,
          isActive: true,
        },
      });
    }

    for (const item of created) {
      await tx.questionOption.create({
        data: {
          questionId,
          order: item.order,
          label: item.option.label,
          value: item.option.value,
          scoreMap: item.option.scoreMap,
          isActive: true,
        },
      });
    }
  }

  /**
   * 同步 `TestDefinition.questionCount`
   *
   * 语义 = **可用题量**（`isActive = true AND deletedAt IS NULL`），因为用户端
   * `test.service.createSession` 正是按这个口径比较 `questionCount`（不足即 40011）。
   * 后台任何影响可用题集的写操作都必须调用本方法，否则会出现
   * 「运营删了一道题 → 用户端再也进不去该测试」这类线上事故。
   */
  private async syncDefinitionQuestionCounts(tx: Prisma.TransactionClient, definitionIds: string[]): Promise<void> {
    for (const definitionId of [...new Set(definitionIds)]) {
      const available = await tx.question.count({
        where: { testDefinitionId: definitionId, isActive: true, deletedAt: null },
      });

      await tx.testDefinition.update({
        where: { id: definitionId },
        data: { questionCount: available },
      });
    }
  }

  // ==========================================================================
  // 内部：统计与校验
  // ==========================================================================

  /** 单一维度内的题量与正/反向题分布（同一测试定义内） */
  private async loadDimensionStats(definitionId: string): Promise<Map<Dimension, DimensionStat>> {
    const rows = await this.prisma.question.groupBy({
      by: ['dimension', 'reverseScored'],
      where: { testDefinitionId: definitionId, isActive: true, deletedAt: null },
      _count: { _all: true },
    });

    const stats = new Map<Dimension, DimensionStat>();

    for (const row of rows) {
      const current = stats.get(row.dimension) ?? { active: 0, forward: 0, reverse: 0 };
      current.active += row._count._all;

      if (row.reverseScored) {
        current.reverse += row._count._all;
      } else {
        current.forward += row._count._all;
      }

      stats.set(row.dimension, current);
    }

    return stats;
  }

  /** 可用题量（`isActive && !deletedAt`）按定义聚合 */
  private async loadActiveQuestionCounts(definitionIds: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(definitionIds)];

    if (unique.length === 0) return new Map();

    const rows = await this.prisma.question.groupBy({
      by: ['testDefinitionId'],
      where: { testDefinitionId: { in: unique }, isActive: true, deletedAt: null },
      _count: { _all: true },
    });

    return new Map(rows.map((row) => [row.testDefinitionId, row._count._all]));
  }

  /**
   * 「定义要求题量」
   *
   * 契约把 `questionCount` 同时用作「题量要求」（§3.14.4.2）与「可用题量」（§3.14.3.6
   * 的 `requiredCount`），而本仓库用户端把它当作「可用题量下限」。为兼顾两者：
   *   · 配置了 `dimensionQuotas` → 用配额之和（这是独立于同步逻辑的真实要求，最权威）；
   *   · 否则 → 用**本次操作前的** questionCount 作为基线要求。
   * 这样「删/停一道题」仍会如契约所愿产出题量不足的预警，而落库值保持等于可用题量。
   */
  private loadRequiredCounts(definitions: Map<string, DefinitionRef>): Map<string, number> {
    const required = new Map<string, number>();

    for (const definition of definitions.values()) {
      const quotaTotal = Object.values(definition.dimensionQuotas).reduce((sum, quota) => sum + quota, 0);
      required.set(definition.code, quotaTotal > 0 ? quotaTotal : definition.questionCount);
    }

    return required;
  }

  /** 由已加载的定义直接构造「要求题量」映射（删除 / 停用路径已在手边持有定义对象） */
  private buildRequiredByCode(definitions: Array<DefinitionRef | null>): Map<string, number> {
    const required = new Map<string, number>();

    for (const definition of definitions) {
      if (!definition) continue;

      const quotaTotal = Object.values(definition.dimensionQuotas).reduce((sum, quota) => sum + quota, 0);
      required.set(definition.code, quotaTotal > 0 ? quotaTotal : definition.questionCount);
    }

    return required;
  }

  /** 构造题量充足性视图（不阻断，只预警） */
  private buildSufficientQuota(
    definitionCodes: string[],
    countsAfter: Record<string, number>,
    requiredByCode?: Map<string, number>,
  ): AdminQuestionSufficientQuota {
    const quota: AdminQuestionSufficientQuota = {};
    const insufficient: string[] = [];

    for (const code of definitionCodes) {
      const available = countsAfter[code] ?? 0;
      const required = requiredByCode?.get(code);
      const isSufficient = required === undefined ? true : available >= required;

      quota[code] = isSufficient;

      if (!isSufficient && required !== undefined) {
        insufficient.push(`${code} 可用题量（${available}）已低于要求（${required}）`);
      }
    }

    if (insufficient.length > 0) {
      quota.note = `${insufficient.join('；')}，新建会话将可能返回 40011，请尽快补充或启用其它题目。`;
    }

    return quota;
  }

  /** 题库总览：不受列表筛选影响（运营看的是整体态势，不是当前页） */
  private async buildSummary(): Promise<AdminQuestionSummary> {
    const [total, active, byDimensionRows, byTypeRows] = await Promise.all([
      this.prisma.question.count({ where: { deletedAt: null } }),
      this.prisma.question.count({ where: { deletedAt: null, isActive: true } }),
      this.prisma.question.groupBy({ by: ['dimension'], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.question.groupBy({ by: ['type'], where: { deletedAt: null }, _count: { _all: true } }),
    ]);

    const byDimension: Record<string, number> = {};
    for (const row of byDimensionRows) {
      byDimension[row.dimension] = row._count._all;
    }

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.type] = row._count._all;
    }

    return {
      totalQuestions: total,
      activeQuestions: active,
      inactiveQuestions: total - active,
      byDimension,
      byType,
    };
  }

  /**
   * 会话快照引用计数（契约的 `usageCount` 口径）
   *
   * `test_sessions.paper_snapshot` 是 `{ questions: [{ questionId, ... }] }`，
   * 因此用 JSONB 数组包含关系直接统计「有多少个会话的试卷引用了这道题」——
   * 这正是契约要的口径（含已软删除的会话：历史快照的解释力不因会话被隐藏而消失）。
   *
   * ⚠ 性能：`paper_snapshot` 上没有 GIN 索引（加索引需要迁移文件，超出本次范围），
   * 该查询会扫 `test_sessions`；调用方只在一页/一题上使用，规模可控。
   */
  private async loadSnapshotUsage(questionIds: string[]): Promise<Map<string, number>> {
    if (questionIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<Array<{ questionId: string; count: number }>>`
      SELECT item ->> 'questionId' AS "questionId", COUNT(DISTINCT ts.id)::int AS "count"
      FROM test_sessions ts
      CROSS JOIN LATERAL jsonb_array_elements(ts.paper_snapshot -> 'questions') AS item
      WHERE jsonb_typeof(ts.paper_snapshot -> 'questions') = 'array'
        AND item ->> 'questionId' = ANY(${questionIds}::text[])
      GROUP BY 1
    `;

    return new Map(rows.map((row) => [row.questionId, Number(row.count)]));
  }

  /** 使用范围：按测试定义拆分的引用会话数（详情响应 `usageScopes`） */
  private async loadUsageScopes(questionId: string): Promise<AdminQuestionUsageScope[]> {
    const rows = await this.prisma.$queryRaw<Array<{ testCode: string; sessionCount: number }>>`
      SELECT ts.definition_code AS "testCode", COUNT(DISTINCT ts.id)::int AS "sessionCount"
      FROM test_sessions ts
      CROSS JOIN LATERAL jsonb_array_elements(ts.paper_snapshot -> 'questions') AS item
      WHERE jsonb_typeof(ts.paper_snapshot -> 'questions') = 'array'
        AND item ->> 'questionId' = ${questionId}
      GROUP BY 1
      ORDER BY 2 DESC
    `;

    return rows.map((row) => ({ testCode: row.testCode, sessionCount: Number(row.sessionCount) }));
  }

  /**
   * 题目统计（详情响应）
   *
   * `usageCount` / `answerCount`：前者是会话快照引用（契约口径），后者是答题明细条数
   * —— 契约样例里两者数值相同（18420 / 18420），因此这里如实分别统计。
   * `averageValue` / `standardDeviation`：基于**非跳过且为数值**的作答（RANK 题的数组
   * 作答不参与，否则会被当成 0 拉低均值）。
   * `discriminationIndex`：题目作答值与「同维度总分」的相关系数（PG `CORR`），
   * 是契约定义的近似实现 —— 用原始作答值求和近似维度总分（未按 weight / reverseScored
   * 还原算分口径），样本不足时返回 null 并标注 INSUFFICIENT_DATA。
   */
  private async loadStatistics(questionId: string): Promise<AdminQuestionStatistics> {
    const usageCount = (await this.loadSnapshotUsage([questionId])).get(questionId) ?? 0;

    const [aggregate] = await this.prisma.$queryRaw<
      Array<{ answered: number; skipped: number; avgValue: number | null; stddevValue: number | null }>
    >`
      SELECT
        (COUNT(*) FILTER (WHERE is_skipped = false AND jsonb_typeof(raw_value) = 'number'))::int AS "answered",
        (COUNT(*) FILTER (WHERE is_skipped = true))::int AS "skipped",
        (AVG((raw_value)::text::float8) FILTER (WHERE is_skipped = false AND jsonb_typeof(raw_value) = 'number'))::float8 AS "avgValue",
        (STDDEV_POP((raw_value)::text::float8) FILTER (WHERE is_skipped = false AND jsonb_typeof(raw_value) = 'number'))::float8 AS "stddevValue"
      FROM test_answers
      WHERE question_id = ${questionId}::uuid
    `;

    const [correlation] = await this.prisma.$queryRaw<Array<{ discrimination: number | null }>>`
      WITH target AS (
        SELECT a.session_id AS session_id, (a.raw_value)::text::float8 AS value
        FROM test_answers a
        WHERE a.question_id = ${questionId}::uuid
          AND a.is_skipped = false
          AND jsonb_typeof(a.raw_value) = 'number'
      ),
      dimension_total AS (
        SELECT a.session_id AS session_id, SUM((a.raw_value)::text::float8) AS total
        FROM test_answers a
        JOIN questions q ON q.id = a.question_id
        WHERE a.is_skipped = false
          AND jsonb_typeof(a.raw_value) = 'number'
          AND q.dimension = (SELECT dimension FROM questions WHERE id = ${questionId}::uuid)
          AND a.session_id IN (SELECT session_id FROM target)
        GROUP BY a.session_id
      )
      SELECT (CORR(t.value, d.total))::float8 AS "discrimination"
      FROM target t
      JOIN dimension_total d ON d.session_id = t.session_id
    `;

    const answered = Number(aggregate?.answered ?? 0);
    const skipped = Number(aggregate?.skipped ?? 0);
    const answerCount = answered + skipped;
    const discriminationRaw = correlation?.discrimination ?? null;
    const quality = this.assessQuality(discriminationRaw === null ? null : Number(discriminationRaw), answered);

    return {
      usageCount,
      answerCount,
      averageValue:
        aggregate?.avgValue === null || aggregate?.avgValue === undefined ? null : this.round(aggregate.avgValue, 2),
      standardDeviation:
        aggregate?.stddevValue === null || aggregate?.stddevValue === undefined
          ? null
          : this.round(aggregate.stddevValue, 2),
      // 样本不足时不下结论：返回 null 比返回一个由 3 条作答算出的相关系数更有信息量
      discriminationIndex: quality.qualityLevel === 'INSUFFICIENT_DATA' ? null : quality.discriminationIndex,
      skipRate: answerCount === 0 ? 0 : this.round(skipped / answerCount, 3),
      qualityLevel: quality.qualityLevel,
      qualityHint: quality.qualityHint,
    };
  }

  /** 选项被选次数（按 `raw_value` 的数值分组；RANK 的数组作答不参与分布） */
  private async loadOptionDistribution(questionId: string): Promise<Map<number, number>> {
    const rows = await this.prisma.$queryRaw<Array<{ value: string; count: number }>>`
      SELECT (raw_value::text) AS "value", COUNT(*)::int AS "count"
      FROM test_answers
      WHERE question_id = ${questionId}::uuid
        AND is_skipped = false
        AND jsonb_typeof(raw_value) = 'number'
      GROUP BY raw_value::text
    `;

    const distribution = new Map<number, number>();

    for (const row of rows) {
      const value = Number(row.value);
      if (Number.isFinite(value)) {
        distribution.set(value, Number(row.count));
      }
    }

    return distribution;
  }

  /** 质量分级（契约只明确了 POOR 的判据与 GOOD 的示例，其余区间为本实现定义） */
  private assessQuality(
    discrimination: number | null,
    answered: number,
  ): {
    qualityLevel: AdminQuestionStatistics['qualityLevel'];
    qualityHint: string;
    discriminationIndex: number | null;
  } {
    if (discrimination === null || answered < MIN_DISCRIMINATION_SAMPLE) {
      return {
        qualityLevel: 'INSUFFICIENT_DATA',
        qualityHint: `有效作答样本不足 ${MIN_DISCRIMINATION_SAMPLE} 条，暂无法评估区分度（不建议据此刻意下线该题）。`,
        discriminationIndex: null,
      };
    }

    const rounded = this.round(discrimination, 3);

    if (rounded < 0.2) {
      return {
        qualityLevel: 'POOR',
        qualityHint: `区分度 ${rounded} 低于 0.2，建议下线或重写题干（契约 §3.14.3.3 规则 2）。`,
        discriminationIndex: rounded,
      };
    }

    if (rounded < 0.4) {
      return {
        qualityLevel: 'ACCEPTABLE',
        qualityHint: `区分度 ${rounded} 属可接受区间（> 0.3 为可接受，> 0.4 为良好）。`,
        discriminationIndex: rounded,
      };
    }

    return {
      qualityLevel: 'GOOD',
      qualityHint: `区分度 ${rounded} 属良好区间（> 0.3 为可接受，> 0.4 为良好）。`,
      discriminationIndex: rounded,
    };
  }

  /** 变更历史：审计日志的题目维度切片（`UPDATE` 给出字段级 before/after） */
  private async loadChangeHistory(questionId: string): Promise<AdminQuestionChangeEntry[]> {
    const logs = await this.prisma.adminAuditLog.findMany({
      where: { resourceType: AUDIT_RESOURCE_TYPE, resourceId: questionId },
      orderBy: { createdAt: 'desc' },
      take: CHANGE_HISTORY_LIMIT,
      select: {
        action: true,
        createdAt: true,
        adminUserId: true,
        adminUsername: true,
        beforeData: true,
        afterData: true,
      },
    });

    if (logs.length === 0) return [];

    const adminIds = [...new Set(logs.map((log) => log.adminUserId).filter((id): id is string => id !== null))];
    const admins = await this.prisma.adminUser.findMany({
      where: { id: { in: adminIds } },
      select: { id: true, username: true, nickname: true, realName: true },
    });
    const displayNameById = new Map(
      admins.map((admin) => [admin.id, admin.nickname ?? admin.realName ?? admin.username]),
    );

    return logs.map((log) => ({
      at: log.createdAt.toISOString(),
      action: log.action,
      operatorName:
        (log.adminUserId ? displayNameById.get(log.adminUserId) : undefined) ?? log.adminUsername ?? '未知操作人',
      changes: log.action === 'UPDATE' ? this.diffSnapshots(log.beforeData, log.afterData) : null,
    }));
  }

  /** 字段级 diff（只列真正发生变化的字段，供详情页「最近变更」展示） */
  private diffSnapshots(before: unknown, after: unknown): Record<string, { before: unknown; after: unknown }> | null {
    if (!this.isPlainObject(before) || !this.isPlainObject(after)) return null;

    const changes: Record<string, { before: unknown; after: unknown }> = {};

    for (const key of Object.keys(after)) {
      const beforeValue = before[key];
      const afterValue = after[key];

      if (JSON.stringify(beforeValue ?? null) === JSON.stringify(afterValue ?? null)) continue;

      changes[key] = { before: beforeValue ?? null, after: afterValue ?? null };
    }

    return Object.keys(changes).length > 0 ? changes : null;
  }

  /**
   * 冗余存储的「最后修改人显示名」
   *
   * 契约要求列表返回 `updatedBy`（显示名）。取值优先级：最近的审计记录操作人 →
   * 创建人（`createdByAdminId`）→ 种子题目的固定文案（无任何审计轨迹时）。
   * 用两次批量查询覆盖整页，避免 N+1。
   */
  private async loadLastOperatorNames(questionIds: string[]): Promise<Map<string, string>> {
    if (questionIds.length === 0) return new Map();

    const [logs, creators] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where: { resourceType: AUDIT_RESOURCE_TYPE, resourceId: { in: questionIds } },
        orderBy: { createdAt: 'desc' },
        select: { resourceId: true, adminUserId: true, adminUsername: true },
      }),
      this.prisma.question.findMany({
        where: { id: { in: questionIds } },
        select: { id: true, createdByAdminId: true },
      }),
    ]);

    const adminIds = [
      ...new Set(
        [...logs.map((log) => log.adminUserId), ...creators.map((creator) => creator.createdByAdminId)].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];

    const admins = await this.prisma.adminUser.findMany({
      where: { id: { in: adminIds } },
      select: { id: true, username: true, nickname: true, realName: true },
    });
    const displayNameById = new Map(
      admins.map((admin) => [admin.id, admin.nickname ?? admin.realName ?? admin.username]),
    );

    const creatorByQuestion = new Map(creators.map((creator) => [creator.id, creator.createdByAdminId]));
    const result = new Map<string, string>();

    for (const log of logs) {
      if (log.resourceId === null || result.has(log.resourceId)) continue;
      result.set(
        log.resourceId,
        (log.adminUserId ? displayNameById.get(log.adminUserId) : undefined) ?? log.adminUsername ?? '未知操作人',
      );
    }

    for (const questionId of questionIds) {
      if (result.has(questionId)) continue;

      const creatorId = creatorByQuestion.get(questionId);
      const creatorName = creatorId ? displayNameById.get(creatorId) : undefined;

      // 无审计记录且无创建人 → 只可能是 seed 灌入的历史数据（契约样例同样写作「初始种子」）
      result.set(questionId, creatorName ?? '初始种子');
    }

    return result;
  }

  /** 查找最相似的既有题目（同维度、最近的 N 题；不含自身） */
  private async findMostSimilarContent(
    content: string,
    dimension: Dimension,
    excludeCode?: string,
  ): Promise<{
    checked: boolean;
    highestSimilarity: number;
    similarQuestionCode: string | null;
    warning: string | null;
  }> {
    const candidates = await this.prisma.question.findMany({
      where: {
        dimension,
        deletedAt: null,
        ...(excludeCode ? { code: { not: excludeCode } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: SIMILARITY_CANDIDATE_LIMIT,
      select: { code: true, content: true },
    });

    if (candidates.length === 0) {
      return { checked: true, highestSimilarity: 0, similarQuestionCode: null, warning: null };
    }

    const target = this.toBigrams(content);
    let highest = 0;
    let similarCode: string | null = null;

    for (const candidate of candidates) {
      const similarity = this.diceSimilarity(target, this.toBigrams(candidate.content));

      if (similarity > highest) {
        highest = similarity;
        similarCode = candidate.code;
      }
    }

    const rounded = this.round(highest, 4);

    return {
      checked: true,
      highestSimilarity: rounded,
      similarQuestionCode: similarCode,
      warning:
        rounded > DUPLICATE_SIMILARITY_THRESHOLD
          ? `与 ${similarCode ?? '既有题目'} 的题干相似度 ${rounded} 超过 ${DUPLICATE_SIMILARITY_THRESHOLD}，建议确认是否重复（仍已保存）。`
          : null,
    };
  }

  /** 组装新建响应的 `validation` 块 */
  private buildValidation(params: {
    dimension: Dimension;
    definition: DefinitionRef;
    statsBefore: Map<Dimension, DimensionStat>;
    statsAfter: Map<Dimension, DimensionStat>;
    duplicate: {
      checked: boolean;
      highestSimilarity: number;
      similarQuestionCode: string | null;
      warning: string | null;
    };
  }): AdminQuestionValidation {
    const { dimension, definition, statsBefore, statsAfter, duplicate } = params;

    const after = statsAfter.get(dimension) ?? { active: 0, forward: 0, reverse: 0 };
    const before = statsBefore.get(dimension) ?? { active: 0, forward: 0, reverse: 0 };

    const quota = this.resolveDimensionQuota(definition, dimension, statsAfter);
    const deviation = quota === 0 ? 0 : Math.abs(after.active - quota) / quota;

    const totalInDimension = after.forward + after.reverse;
    const ratio = totalInDimension === 0 ? 0 : this.round(after.reverse / totalInDimension, 2);

    return {
      dimensionBalance: {
        dimension,
        activeCountBefore: before.active,
        activeCountAfter: after.active,
        balanceWarning:
          quota > 0 && deviation > DIMENSION_BALANCE_TOLERANCE
            ? `${dimension} 维度题量 ${after.active} 偏离配额 ${quota} 超过 ±${DIMENSION_BALANCE_TOLERANCE * 100}%，建议补充其它维度题目以保持均衡。`
            : null,
      },
      reverseRatio: {
        dimension,
        forwardCount: after.forward,
        reverseCount: after.reverse,
        ratio,
        isBalanced: ratio >= REVERSE_RATIO_MIN && ratio <= REVERSE_RATIO_MAX,
        hint: `正向/反向题比例建议保持在 ${REVERSE_RATIO_MIN}–${REVERSE_RATIO_MAX}，用于一致性校验（架构 11.2）`,
      },
      duplicateSimilarity: duplicate,
    };
  }

  /** 维度的配额目标：优先取定义配置的 `dimensionQuotas`，否则用「均分」作为兜底目标 */
  private resolveDimensionQuota(
    definition: DefinitionRef,
    dimension: Dimension,
    stats: Map<Dimension, DimensionStat>,
  ): number {
    const configured = definition.dimensionQuotas[dimension];

    if (typeof configured === 'number' && configured > 0) return configured;

    const activeDimensions = [...stats.values()].filter((stat) => stat.active > 0).length || 1;
    const total = [...stats.values()].reduce((sum, stat) => sum + stat.active, 0);

    return Math.round(total / activeDimensions);
  }

  /** 维度均衡告警（导入路径；`estimate` 用于试运行的增量估算） */
  private async buildDimensionWarnings(
    definitions: Map<string, DefinitionRef>,
    estimate?: {
      rows: PreparedImportRow[];
      deleted: Array<{ dimension: Dimension; testCode: string }>;
    },
  ): Promise<AdminQuestionImportIssue[]> {
    const warnings: AdminQuestionImportIssue[] = [];

    for (const definition of definitions.values()) {
      const stats = await this.loadDimensionStats(definition.id);

      if (estimate) {
        for (const row of estimate.rows) {
          if (row.testDefinitionId !== definition.id) continue;
          const stat = stats.get(row.dimension) ?? { active: 0, forward: 0, reverse: 0 };
          stat.active += 1;
          stats.set(row.dimension, stat);
        }

        for (const deleted of estimate.deleted) {
          if (deleted.testCode !== definition.code) continue;
          const stat = stats.get(deleted.dimension);
          if (stat) stat.active = Math.max(0, stat.active - 1);
        }
      }

      for (const [dimension, stat] of stats) {
        const quota = this.resolveDimensionQuota(definition, dimension, stats);
        if (quota === 0) continue;

        const deviation = Math.abs(stat.active - quota) / quota;

        if (deviation <= DIMENSION_BALANCE_TOLERANCE) continue;

        const rowOfDimension = estimate?.rows.find(
          (row) => row.testDefinitionId === definition.id && row.dimension === dimension,
        );

        warnings.push({
          row: rowOfDimension?.row ?? 0,
          code: rowOfDimension?.code ?? null,
          field: 'dimension',
          issue: 'DIMENSION_QUOTA_IMBALANCE',
          message: estimate
            ? `导入后 ${definition.code} 的 ${dimension} 维度题量将比均衡目标（${quota}）${stat.active > quota ? '多' : '少'} ${Math.abs(stat.active - quota)} 题，建议保持均衡`
            : `${definition.code} 的 ${dimension} 维度题量 ${stat.active} 比均衡目标（${quota}）${stat.active > quota ? '多' : '少'} ${Math.abs(stat.active - quota)} 题`,
        });
      }
    }

    // 只保留计数最高的若干条告警，避免一次导入刷出几十行噪声
    return warnings.slice(0, 20);
  }

  // ==========================================================================
  // 内部：选项校验
  // ==========================================================================

  /** 新建/修改路径的选项归一化（失败即抛业务异常） */
  private resolveOptions(
    rawOptions: Array<{ label: string; value: number; scoreMap: Record<string, number> }> | undefined,
    type: QuestionType,
    dimension: Dimension,
    reverseScored: boolean,
  ): NormalizedOption[] {
    if (rawOptions === undefined || rawOptions.length === 0) {
      if (type === 'LIKERT5') {
        return this.buildLikert5Options(dimension, reverseScored);
      }

      // 契约错误码 40008 在本仓库已被 QUESTION_NOT_IN_PAPER 占用，故退化为 10001（同为 400）
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `${type} 题型必须提供 options（只有 LIKERT5 可由服务端生成默认 1–5 选项）`,
        [{ field: 'options', issue: '缺失' }],
      );
    }

    const result = this.normalizeOptions(rawOptions, type);

    if (!result.ok) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, result.message, [
        { field: `options.${result.field}`, issue: result.issue },
      ]);
    }

    return result.value;
  }

  /** 选项结构 + 语义校验（新建、修改、导入共用） */
  private normalizeOptions(rawOptions: unknown[], type: QuestionType): ValidationResult<NormalizedOption[]> {
    if (rawOptions.length < MIN_OPTION_COUNT || rawOptions.length > MAX_OPTION_COUNT) {
      return {
        ok: false,
        field: 'options',
        issue: 'OPTIONS_OUT_OF_RANGE',
        message: `options 长度需在 ${MIN_OPTION_COUNT}–${MAX_OPTION_COUNT} 之间（收到 ${rawOptions.length}）`,
      };
    }

    const normalized: NormalizedOption[] = [];

    for (const [index, raw] of rawOptions.entries()) {
      if (!this.isPlainObject(raw)) {
        return { ok: false, field: `[${index}]`, issue: 'INVALID_OPTION', message: `options[${index}] 必须是对象` };
      }

      const label = this.normalizeContent(this.readString(raw['label']) ?? '');

      if (label.length < 1 || label.length > 32) {
        return {
          ok: false,
          field: `[${index}].label`,
          issue: 'INVALID_OPTION_LABEL',
          message: `options[${index}].label 长度需在 1–32 之间`,
        };
      }

      const value = this.readNumber(raw['value'], null);

      if (value === null || !Number.isInteger(value)) {
        return {
          ok: false,
          field: `[${index}].value`,
          issue: 'INVALID_OPTION_VALUE',
          message: `options[${index}].value 必须是整数`,
        };
      }

      const scoreMapValue = raw['scoreMap'];

      if (!this.isPlainObject(scoreMapValue)) {
        return {
          ok: false,
          field: `[${index}].scoreMap`,
          issue: 'INVALID_SCORE_MAP',
          message: `options[${index}].scoreMap 必须是 {维度: 分值} 对象`,
        };
      }

      const scoreMap: Record<string, number> = {};

      for (const [scoreDimension, score] of Object.entries(scoreMapValue)) {
        if (!(QUESTION_DIMENSIONS as readonly string[]).includes(scoreDimension)) {
          return {
            ok: false,
            field: `[${index}].scoreMap`,
            issue: 'INVALID_SCORE_MAP',
            message: `options[${index}].scoreMap 含非法维度「${scoreDimension}」`,
          };
        }

        if (typeof score !== 'number' || !Number.isFinite(score) || score < SCORE_MAP_MIN || score > SCORE_MAP_MAX) {
          return {
            ok: false,
            field: `[${index}].scoreMap`,
            issue: 'INVALID_SCORE_MAP',
            message: `options[${index}].scoreMap.${scoreDimension} 需为 ${SCORE_MAP_MIN}–${SCORE_MAP_MAX} 的数值`,
          };
        }

        scoreMap[scoreDimension] = score;
      }

      normalized.push({ label, value, scoreMap });
    }

    const values = normalized.map((option) => option.value);

    // 契约错误码 40008（`options[].value` 题内重复）在本仓库已被 QUESTION_NOT_IN_PAPER 占用，
    // 故统一用 10001（HTTP 400 一致），并在 details 里指明重复的值
    const duplicated = values.filter((value, index) => values.indexOf(value) !== index);

    if (duplicated.length > 0) {
      return {
        ok: false,
        field: 'value',
        issue: 'DUPLICATE_OPTION_VALUE',
        message: `options[].value 在题内重复：${[...new Set(duplicated)].join(', ')}`,
      };
    }

    if (type === 'LIKERT5') {
      const expected = [...LIKERT5_VALUES].sort((a, b) => a - b).join(',');
      const actual = [...values].sort((a, b) => a - b).join(',');

      // 契约 §3.14.3.2 错误码 40008：LIKERT5 的 value 必须是 1–5
      if (actual !== expected) {
        return {
          ok: false,
          field: 'value',
          issue: 'INVALID_LIKERT5_VALUES',
          message: `LIKERT5 的选项 value 必须恰好是 ${expected}（收到 ${actual}）`,
        };
      }
    }

    return { ok: true, value: normalized };
  }

  /**
   * LIKERT5 默认选项
   *
   * `scoreMap` 用 `{维度: 偏移}` 表达：非反向题 `value - 3`（1→−2 … 5→+2，与契约示例一致），
   * 反向题取相反数，使「正向得分」与 `reverseScored` 的语义自洽。
   * ⚠ seed 灌入的历史题目 `scoreMap` 是空对象（引擎按 `value` + `reverseScored` 计分），
   * 二者并存不冲突：`scoreMap` 目前只对后台展示与后续算分口径迁移有意义。
   */
  private buildLikert5Options(dimension: Dimension, reverseScored: boolean): NormalizedOption[] {
    return LIKERT5_VALUES.map((value, index) => ({
      label: LIKERT5_DEFAULT_LABELS[index] ?? `选项 ${value}`,
      value,
      scoreMap: { [dimension]: reverseScored ? 3 - value : value - 3 },
    }));
  }

  // ==========================================================================
  // 内部：审计 / 缓存
  // ==========================================================================

  /** 写审计并回查该条审计的 ID（契约响应里的 `auditLogId`） */
  private async writeAudit(params: {
    adminUserId: string;
    adminUsername: string;
    action: AdminAuditAction;
    resourceId: string | null;
    beforeData: AuditSnapshot | null;
    afterData: AuditSnapshot | null;
    diffSummary: string;
    reason?: string | null;
    success?: boolean;
    errorCode?: string | null;
    context: AdminQuestionRequestContext;
  }): Promise<string | null> {
    const entry = {
      adminUserId: params.adminUserId,
      adminUsername: params.adminUsername,
      action: params.action,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: params.resourceId,
      // 显式区分「没有值」与「JSON null」的语义由 AdminAuditService 负责，这里只保证可序列化
      beforeData: params.beforeData === null ? null : (params.beforeData as unknown as Prisma.InputJsonValue),
      afterData: params.afterData === null ? null : (params.afterData as unknown as Prisma.InputJsonValue),
      diffSummary: params.diffSummary,
      reason: params.reason ?? null,
      ip: params.context.ip ?? null,
      userAgent: params.context.userAgent ?? null,
      requestId: params.context.requestId ?? null,
      success: params.success ?? true,
      errorCode: params.errorCode ?? null,
    };

    const written = await this.audit.log(entry);

    if (!written) return null;

    /**
     * `AdminAuditService.log()` 只返回布尔值（不返回行 ID），而契约响应要求 `auditLogId`。
     * 这里回查「本人 + 同资源 + 同动作」的最新一条 —— 幂等键与请求级串行保证了它的准确性，
     * 最坏情况下（同毫秒内两次完全相同的操作）拿到的是同一资源的另一条等价审计记录。
     * 更干净的做法是让 `log()` 返回 ID，但那需要改动共享的 `admin-audit.service.ts`。
     */
    return this.loadLatestAuditId(params.adminUserId, params.action, params.resourceId);
  }

  private async loadLatestAuditId(
    adminUserId: string,
    action: AdminAuditAction,
    resourceId: string | null,
  ): Promise<string | null> {
    const log = await this.prisma.adminAuditLog.findFirst({
      where: { adminUserId, action, resourceType: AUDIT_RESOURCE_TYPE, resourceId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return log?.id ?? null;
  }

  /**
   * 缓存失效（契约 §3.14.3.2 规则 4 / §3.14.3.4 规则 5）
   *
   * 目前用户端尚未对测试定义与试卷做缓存（`test.service` 直读数据库），
   * 这里的删除是**防御性**的：缓存键遵循架构 §10.3 的命名，一旦后续加缓存即自动生效。
   * 缓存清理失败不影响业务结果（题目已经写进数据库了），只记 warn。
   */
  private async invalidateTestCaches(testCodes: string[]): Promise<boolean> {
    const keys = [
      this.redis.key('test', 'definitions'),
      ...testCodes.map((code) => this.redis.key('test', 'paper', code)),
    ];

    try {
      await this.redis.del(...keys);
      return true;
    } catch (error) {
      this.logger.warn(`题库缓存失效失败（不影响数据写入）：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async safeGetJson<T>(key: string): Promise<T | null> {
    try {
      return await this.redis.getJson<T>(key);
    } catch (error) {
      this.logger.warn(`读取幂等记录失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async safeSetJson(key: string | null, value: unknown, ttlSeconds: number): Promise<void> {
    if (!key) return;

    try {
      await this.redis.setJson(key, value, ttlSeconds);
    } catch (error) {
      // 幂等记录写失败只意味着「重试可能重复写入」，不应让已经成功的导入返回失败
      this.logger.warn(`写入幂等记录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadAdminIdentity(adminUserId: string): Promise<{ username: string; displayName: string }> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
      select: { username: true, nickname: true, realName: true },
    });

    if (!admin) {
      // 走到这里说明令牌有效但账号已被删除，属于异常状态；审计仍需一个可读的操作人标识
      return { username: `(unknown:${adminUserId})`, displayName: '未知管理员' };
    }

    return { username: admin.username, displayName: admin.nickname ?? admin.realName ?? admin.username };
  }

  // ==========================================================================
  // 内部：纯函数工具
  // ==========================================================================

  private buildOrderBy(sortBy: QuestionSortField, order: SortDirection): Prisma.QuestionOrderByWithRelationInput[] {
    // 追加 id 作为兜底排序键：否则「order 相同的题」在翻页时可能重复或漏出
    return [{ [sortBy]: order }, { id: 'asc' }] as Prisma.QuestionOrderByWithRelationInput[];
  }

  private buildImpactAssessment(
    existing: { dimension: Dimension; weight: number; reverseScored: boolean },
    next: { dimension: Dimension; weight: number; reverseScored: boolean },
  ): AdminQuestionImpactAssessment {
    const scoringChanges: string[] = [];

    if (existing.dimension !== next.dimension) {
      scoringChanges.push(`dimension 由 ${existing.dimension} → ${next.dimension}`);
    }

    if (existing.weight !== next.weight) {
      scoringChanges.push(`weight 由 ${existing.weight} → ${next.weight}`);
    }

    if (existing.reverseScored !== next.reverseScored) {
      scoringChanges.push(`reverseScored 由 ${String(existing.reverseScored)} → ${String(next.reverseScored)}`);
    }

    return {
      affectsNewSessionsOnly: true,
      existingSessionsUnaffected: true,
      note: '已开始或已完成的测试会话使用冻结的试卷快照，不受本次修改影响（架构 11.1）。',
      scoringImpact:
        scoringChanges.length === 0
          ? null
          : `${scoringChanges.join('；')} 会改变新建会话的算分口径，建议同步评估维度内题量与权重平衡。`,
    };
  }

  /** 计算真正发生变化的字段（契约响应的 `changedFields`） */
  private diffFields(
    existing: {
      content: string;
      dimension: Dimension;
      weight: number;
      reverseScored: boolean;
      order: number;
      isActive: boolean;
      tags: string[];
      testDefinitionId: string;
      explanation: string | null;
      options: Array<{ label: string; value: number; scoreMap: unknown; order: number }>;
    },
    next: {
      content: string;
      dimension: Dimension;
      weight: number;
      reverseScored: boolean;
      order: number;
      isActive: boolean;
      tags: string[];
      testDefinitionId: string;
      explanation: string | null;
      options: NormalizedOption[] | null;
    },
  ): string[] {
    const changed: string[] = [];

    if (existing.content !== next.content) changed.push('content');
    if (existing.dimension !== next.dimension) changed.push('dimension');
    if (existing.weight !== next.weight) changed.push('weight');
    if (existing.reverseScored !== next.reverseScored) changed.push('reverseScored');
    if (existing.order !== next.order) changed.push('order');
    if (existing.isActive !== next.isActive) changed.push('isActive');
    if (JSON.stringify(existing.tags) !== JSON.stringify(next.tags)) changed.push('tags');
    if (existing.testDefinitionId !== next.testDefinitionId) changed.push('testCodes');
    if (existing.explanation !== next.explanation) changed.push('explanation');

    if (next.options !== null && !this.sameOptions(existing.options, next.options)) {
      changed.push('options');
    }

    return changed;
  }

  private sameOptions(
    existing: Array<{ label: string; value: number; scoreMap: unknown; order: number }>,
    next: NormalizedOption[],
  ): boolean {
    const sortedExisting = [...existing]
      .sort((a, b) => a.order - b.order)
      .map((option) => ({
        label: option.label,
        value: option.value,
        scoreMap: this.readScoreMap(option.scoreMap),
      }));

    return JSON.stringify(sortedExisting) === JSON.stringify(next);
  }

  private buildQuestionSnapshot(params: {
    code: string;
    content: string;
    type: QuestionType;
    dimension: Dimension;
    weight: number;
    reverseScored: boolean;
    order: number;
    isActive: boolean;
    tags: string[];
    explanation: string | null;
    testCode: string;
    options: NormalizedOption[];
  }): AuditSnapshot {
    return {
      code: params.code,
      content: params.content,
      type: params.type,
      dimension: params.dimension,
      weight: params.weight,
      reverseScored: params.reverseScored,
      order: params.order,
      isActive: params.isActive,
      tags: params.tags,
      explanation: params.explanation,
      testCode: params.testCode,
      options: params.options.map((option) => `${option.value}:${option.label}`),
    };
  }

  /** 题干/文案清洗：🚫 不支持 HTML，存储前剥离标签（契约 §3.14.3.2 规则 5） */
  private normalizeContent(input: string): string {
    return input
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 解释类文本只剥标签、保留换行 */
  private normalizeOptionalText(input: string): string | null {
    const cleaned = input.replace(/<[^>]*>/g, '').trim();
    return cleaned.length === 0 ? null : cleaned;
  }

  /** 字符二元组集合（Dice 相似度的输入） */
  private toBigrams(text: string): Set<string> {
    const normalized = text.replace(/[\s，。！？、；：,.!?;:'"（）()《》\-—]/g, '');

    if (normalized.length < 2) return new Set(normalized.length === 1 ? [normalized] : []);

    const bigrams = new Set<string>();

    for (let index = 0; index < normalized.length - 1; index += 1) {
      bigrams.add(normalized.slice(index, index + 2));
    }

    return bigrams;
  }

  /** Dice 系数：2|A∩B| / (|A|+|B|)，范围 0–1（契约的相似度阈值为 0.85） */
  private diceSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection += 1;
    }

    return (2 * intersection) / (a.size + b.size);
  }

  /** RFC4180 风格的 CSV 记录解析（支持引号包裹与 `""` 转义） */
  private parseCsvRecords(text: string): string[][] {
    const records: string[][] = [];
    let record: string[] = [];
    let field = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (inQuotes) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
        continue;
      }

      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        record.push(field);
        field = '';
      } else if (char === '\n') {
        record.push(field);
        records.push(record);
        record = [];
        field = '';
      } else if (char === '\r') {
        // CRLF 与 LF 等价：忽略 \r，由 \n 收尾
        continue;
      } else {
        field += char;
      }
    }

    if (field !== '' || record.length > 0) {
      record.push(field);
      records.push(record);
    }

    return records;
  }

  /** CSV 的 `scoreMaps` 单元格：`DIM:分值`（多维用 `;` 分隔） */
  private parseCsvScoreMap(cell: string): Record<string, number> | null {
    const scoreMap: Record<string, number> = {};

    for (const segment of cell.split(';')) {
      const trimmed = segment.trim();
      if (trimmed === '') continue;

      const separatorIndex = trimmed.lastIndexOf(':');
      if (separatorIndex <= 0) return null;

      const dimension = trimmed.slice(0, separatorIndex).trim();
      const score = Number(trimmed.slice(separatorIndex + 1).trim());

      if (dimension === '' || !Number.isFinite(score)) return null;

      scoreMap[dimension] = score;
    }

    return scoreMap;
  }

  private splitPipe(value: string): string[] {
    if (value === '') return [];
    return value
      .split('|')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }

  private splitCsv(value: string | undefined): string[] {
    if (!value) return [];
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }

  private readScoreMap(value: unknown): Record<string, number> {
    if (!this.isPlainObject(value)) return {};

    const scoreMap: Record<string, number> = {};
    for (const [key, score] of Object.entries(value)) {
      if (typeof score === 'number' && Number.isFinite(score)) {
        scoreMap[key] = score;
      }
    }

    return scoreMap;
  }

  private readDimensionQuotas(value: unknown): Record<string, number> {
    if (!this.isPlainObject(value)) return {};

    const quotas: Record<string, number> = {};
    for (const [key, quota] of Object.entries(value)) {
      if (typeof quota === 'number' && Number.isFinite(quota)) {
        quotas[key] = quota;
      }
    }

    return quotas;
  }

  private readString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
  }

  private readNumber(value: unknown, fallback: number): number;
  private readNumber(value: unknown, fallback: null): number | null;
  private readNumber(value: unknown, fallback: number | null): number | null {
    if (value === undefined || value === null || value === '') return fallback;
    // 只接受数字与数字字符串：对象经 String() 会变成 '[object Object]' 并静默变成 NaN
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;

    const parsed = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(parsed)) return fallback;

    return parsed;
  }

  private readBoolean(value: unknown, fallback: boolean): boolean | null {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'TRUE' || value === '1') return true;
    if (value === 'false' || value === 'FALSE' || value === '0') return false;
    return null;
  }

  private readStringArray(value: unknown): string[] | null {
    if (value === undefined || value === null || value === '') return [];
    if (!Array.isArray(value)) return null;

    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') return null;
      result.push(item.trim());
    }

    return result;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private hasSingleDecimal(value: number): boolean {
    return Math.round(value * 10) === value * 10;
  }

  private round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }
}

/** 选项重排时的临时 order 基址：远离业务取值域，避免与任何真实 order 相撞 */
const OPTION_TEMP_ORDER_BASE = 1_000_000;
