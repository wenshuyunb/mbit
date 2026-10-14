/**
 * 管理端 AI 统计模块 DTO（契约 §3.14.7.1 ~ §3.14.7.5）
 *
 * 校验策略与错误码映射同订单模块（见 `order/dto/admin-order.dto.ts` 文件头）：
 * 契约声明的 `10002`/`10004`/`10016` 在本项目或不存在、或含义不同，
 * 因此统一由 ValidationPipe / Service 抛 `10001 PARAM_INVALID`（400），
 * 跨字段与范围校验在 Service 内显式抛出。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

import { AI_TASK_FILTERS, AI_PROVIDERS, OVERVIEW_RANGES, type AiProviderName } from '../admin-ai-stats.util';

const csvToArray = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .flatMap((item) => item.split(',').map((part) => part.trim()))
      .filter((item) => item.length > 0);
  }

  return value;
};

/** 时间粒度（契约 §3.14.7.2） */
export const USAGE_GRANULARITIES = ['DAY', 'HOUR', 'WEEK', 'MONTH'] as const;
export type UsageGranularity = (typeof USAGE_GRANULARITIES)[number];

/** 用量聚合维度白名单（契约 §3.14.7.2） */
export const USAGE_GROUP_BY = ['DATE', 'TASK', 'PROVIDER', 'MODEL', 'PROMPT_VERSION', 'USER'] as const;
export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

/** 成本聚合维度白名单（契约 §3.14.7.3） */
export const COSTS_GROUP_BY = ['DATE', 'PROVIDER', 'MODEL', 'TASK'] as const;
export type CostsGroupBy = (typeof COSTS_GROUP_BY)[number];

/** 调用日志结果枚举（契约 §3.14.7.4） */
export const CALL_LOG_STATUSES = ['SUCCESS', 'FAILED', 'ABORTED', 'BLOCKED'] as const;
export type CallLogStatus = (typeof CALL_LOG_STATUSES)[number];

/** 调用日志排序白名单（契约 §3.14.7.4） */
export const CALL_LOG_SORT_FIELDS = ['createdAt', 'latencyMs', 'costCents'] as const;
export type CallLogSortField = (typeof CALL_LOG_SORT_FIELDS)[number];

/** 排序方向 */
export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** 报告类型（契约 §3.14.7.5；与 `AiReportType` 的差异见 admin-ai-report.service.ts） */
export const ADMIN_REPORT_TYPES = [
  'MBTI_REPORT',
  'BIG_FIVE_REPORT',
  'GROWTH_REPORT',
  'COMPATIBILITY_REPORT',
  // 情感测评报告（ADR-038 阶段 3）。
  // ⚠ 与 `admin/report/dto` 里的同名常量必须**逐字一致** ——
  // 两处是独立定义的历史遗留，漏改一处只会表现为"某个后台页面筛不到"。
  'EMOTION_REPORT',
] as const;
export type AdminReportType = (typeof ADMIN_REPORT_TYPES)[number];

/** 报告状态（契约 §3.14.7.5；`PARTIAL` 为匹配报告「算分完成但 AI 解读失败」的推导态） */
export const ADMIN_REPORT_STATUSES = ['PENDING', 'GENERATING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PARTIAL'] as const;
export type AdminReportStatus = (typeof ADMIN_REPORT_STATUSES)[number];

/** 报告排序白名单（契约 §3.14.7.5） */
export const ADMIN_REPORT_SORT_FIELDS = ['createdAt', 'generatedAt', 'wordCount', 'totalTokens'] as const;
export type AdminReportSortField = (typeof ADMIN_REPORT_SORT_FIELDS)[number];

/** 分页上限（契约 §3.14.7.4 / §3.14.7.5） */
export const ADMIN_AI_MAX_PAGE_SIZE = 100;

/** 默认每页条数 */
export const ADMIN_AI_DEFAULT_PAGE_SIZE = 20;

/**
 * 时间范围 + 任务筛选的公共基类
 *
 * 用一个基类而非两个：TypeScript 不支持类多继承，`class A extends B, C` 是语法错误。
 * 需要「只要时间范围、不要 task」的 DTO（如 costs）单独声明字段。
 */
export class AiRangeTaskQueryDto {
  @ApiPropertyOptional({ description: '起始时间（ISO 8601）', example: '2026-02-08T00:00:00.000Z' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startTime 必须是 ISO 8601 时间' })
  startTime?: string;

  @ApiPropertyOptional({ description: '结束时间（ISO 8601）', example: '2026-02-14T23:59:59.999Z' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endTime 必须是 ISO 8601 时间' })
  endTime?: string;

  @ApiPropertyOptional({
    description: `任务类型（逗号分隔）：${AI_TASK_FILTERS.join(' | ')}`,
    example: 'MBTI_REPORT,AI_COMPANION',
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(AI_TASK_FILTERS, { each: true, message: `task 仅支持：${AI_TASK_FILTERS.join(', ')}` })
  task?: string[];
}

// ============================================================================
// GET /admin/ai/stats/overview
// ============================================================================

export class AiOverviewQueryDto extends AiRangeTaskQueryDto {
  @ApiPropertyOptional({
    description: '时间范围',
    enum: OVERVIEW_RANGES,
    default: 'TODAY',
  })
  @IsOptional()
  @IsIn(OVERVIEW_RANGES, { message: `range 仅支持：${OVERVIEW_RANGES.join(', ')}` })
  range?: 'TODAY' | '7D' | '30D' | 'CUSTOM';
}

// ============================================================================
// GET /admin/ai/stats/usage
// ============================================================================

export class AiUsageQueryDto extends AiRangeTaskQueryDto {
  @ApiPropertyOptional({
    description: `聚合维度（逗号分隔，可多选做交叉分析）：${USAGE_GROUP_BY.join(' | ')}`,
    example: 'DATE,TASK',
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(USAGE_GROUP_BY, { each: true, message: `groupBy 仅支持：${USAGE_GROUP_BY.join(', ')}` })
  groupBy?: UsageGroupBy[];

  @ApiPropertyOptional({
    description: 'HOUR 粒度仅允许查询 ≤ 7 天',
    enum: USAGE_GRANULARITIES,
    default: 'DAY',
  })
  @IsOptional()
  @IsIn(USAGE_GRANULARITIES, { message: `granularity 仅支持：${USAGE_GRANULARITIES.join(', ')}` })
  granularity?: UsageGranularity;

  @ApiPropertyOptional({
    description: `provider 筛选（逗号分隔）：${AI_PROVIDERS.join(' | ')}`,
    example: 'deepseek',
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(AI_PROVIDERS, { each: true, message: `provider 仅支持：${AI_PROVIDERS.join(', ')}` })
  provider?: AiProviderName[];

  @ApiPropertyOptional({ description: 'Prompt 模板 key', maxLength: 64 })
  @IsOptional()
  @IsString({ message: 'promptKey 必须是字符串' })
  @Length(1, 64, { message: 'promptKey 长度需在 1–64 字符之间' })
  promptKey?: string;

  @ApiPropertyOptional({ description: '返回行数上限（按首维度排序）', default: 100, minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsInt({ message: 'limit 必须是整数' })
  @Min(1, { message: 'limit 必须 ≥ 1' })
  @Max(1_000, { message: 'limit 不能超过 1000' })
  limit?: number;
}

// ============================================================================
// GET /admin/ai/stats/costs
// ============================================================================

export class AiCostsQueryDto {
  @ApiPropertyOptional({ description: '起始时间（ISO 8601，**必填**）', example: '2026-02-08T00:00:00.000Z' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startTime 必须是 ISO 8601 时间' })
  startTime?: string;

  @ApiPropertyOptional({ description: '结束时间（ISO 8601，**必填**）', example: '2026-02-14T23:59:59.999Z' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endTime 必须是 ISO 8601 时间' })
  endTime?: string;

  @ApiPropertyOptional({
    description: `聚合维度（逗号分隔）：${COSTS_GROUP_BY.join(' | ')}`,
    example: 'DATE,PROVIDER',
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(COSTS_GROUP_BY, { each: true, message: `groupBy 仅支持：${COSTS_GROUP_BY.join(', ')}` })
  groupBy?: CostsGroupBy[];

  @ApiPropertyOptional({ description: '是否返回单位经济模型', default: true })
  @IsOptional()
  @IsBoolean({ message: 'includeUnitEconomics 必须是布尔值' })
  includeUnitEconomics?: boolean;

  @ApiPropertyOptional({ description: '是否返回成本异常检测结果', default: true })
  @IsOptional()
  @IsBoolean({ message: 'includeAnomalies 必须是布尔值' })
  includeAnomalies?: boolean;
}

// ============================================================================
// GET /admin/ai/call-logs
// ============================================================================

export class AiCallLogQueryDto extends AiRangeTaskQueryDto {
  @ApiPropertyOptional({ description: '页码', default: 1 })
  @IsOptional()
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  page?: number;

  @ApiPropertyOptional({ description: `每页条数，最大 ${ADMIN_AI_MAX_PAGE_SIZE}`, default: 20 })
  @IsOptional()
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须 ≥ 1' })
  @Max(ADMIN_AI_MAX_PAGE_SIZE, { message: `pageSize 不能超过 ${ADMIN_AI_MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({ description: `provider：${AI_PROVIDERS.join(' | ')}` })
  @IsOptional()
  @IsIn(AI_PROVIDERS, { message: `provider 仅支持：${AI_PROVIDERS.join(', ')}` })
  provider?: AiProviderName;

  @ApiPropertyOptional({ description: '模型名', maxLength: 64 })
  @IsOptional()
  @IsString({ message: 'model 必须是字符串' })
  @Length(1, 64, { message: 'model 长度需在 1–64 字符之间' })
  model?: string;

  @ApiPropertyOptional({ description: '调用结果', enum: CALL_LOG_STATUSES })
  @IsOptional()
  @IsIn(CALL_LOG_STATUSES, { message: `status 仅支持：${CALL_LOG_STATUSES.join(', ')}` })
  status?: CallLogStatus;

  @ApiPropertyOptional({ description: '错误码（本项目错误码值，如 50000）', example: 50000 })
  @IsOptional()
  @IsInt({ message: 'errorCode 必须是整数' })
  @Min(1, { message: 'errorCode 必须 ≥ 1' })
  errorCode?: number;

  @ApiPropertyOptional({ description: '是否命中缓存' })
  @IsOptional()
  @IsBoolean({ message: 'cacheHit 必须是布尔值' })
  cacheHit?: boolean;

  @ApiPropertyOptional({ description: '指定用户 ID' })
  @IsOptional()
  @IsUUID(undefined, { message: 'userId 必须是合法 UUID' })
  userId?: string;

  @ApiPropertyOptional({ description: 'Prompt 模板 key', maxLength: 64 })
  @IsOptional()
  @IsString({ message: 'promptKey 必须是字符串' })
  @Length(1, 64, { message: 'promptKey 长度需在 1–64 字符之间' })
  promptKey?: string;

  @ApiPropertyOptional({ description: '请求追踪 ID', maxLength: 64 })
  @IsOptional()
  @IsString({ message: 'traceId 必须是字符串' })
  @Length(1, 64, { message: 'traceId 长度需在 1–64 字符之间' })
  traceId?: string;

  @ApiPropertyOptional({ description: '排序字段白名单', enum: CALL_LOG_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(CALL_LOG_SORT_FIELDS, { message: `sortBy 仅支持：${CALL_LOG_SORT_FIELDS.join(', ')}` })
  sortBy?: CallLogSortField;

  @ApiPropertyOptional({ description: '排序方向', enum: SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(SORT_ORDERS, { message: `order 仅支持：${SORT_ORDERS.join(', ')}` })
  order?: SortOrder;
}

// ============================================================================
// GET /admin/ai/reports
// ============================================================================

export class AiReportsQueryDto {
  @ApiPropertyOptional({ description: '起始时间（ISO 8601，生成时间范围）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startTime 必须是 ISO 8601 时间' })
  startTime?: string;

  @ApiPropertyOptional({ description: '结束时间（ISO 8601，生成时间范围）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endTime 必须是 ISO 8601 时间' })
  endTime?: string;

  @ApiPropertyOptional({ description: '页码', default: 1 })
  @IsOptional()
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  page?: number;

  @ApiPropertyOptional({ description: `每页条数，最大 ${ADMIN_AI_MAX_PAGE_SIZE}`, default: 20 })
  @IsOptional()
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须 ≥ 1' })
  @Max(ADMIN_AI_MAX_PAGE_SIZE, { message: `pageSize 不能超过 ${ADMIN_AI_MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({
    description: `报告类型（逗号分隔）：${ADMIN_REPORT_TYPES.join(' | ')}`,
    example: 'MBTI_REPORT',
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(ADMIN_REPORT_TYPES, { each: true, message: `type 仅支持：${ADMIN_REPORT_TYPES.join(', ')}` })
  type?: AdminReportType[];

  @ApiPropertyOptional({
    description: `报告状态（逗号分隔）：${ADMIN_REPORT_STATUSES.join(' | ')}`,
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(ADMIN_REPORT_STATUSES, { each: true, message: `status 仅支持：${ADMIN_REPORT_STATUSES.join(', ')}` })
  status?: AdminReportStatus[];

  @ApiPropertyOptional({ description: '指定用户 ID' })
  @IsOptional()
  @IsUUID(undefined, { message: 'userId 必须是合法 UUID' })
  userId?: string;

  @ApiPropertyOptional({ description: '是否已解锁' })
  @IsOptional()
  @IsBoolean({ message: 'isUnlocked 必须是布尔值' })
  isUnlocked?: boolean;

  @ApiPropertyOptional({ description: 'Prompt 模板 key', maxLength: 64 })
  @IsOptional()
  @IsString({ message: 'promptKey 必须是字符串' })
  @Length(1, 64, { message: 'promptKey 长度需在 1–64 字符之间' })
  promptKey?: string;

  @ApiPropertyOptional({ description: 'Prompt 版本（AB 质量对比）', minimum: 1 })
  @IsOptional()
  @IsInt({ message: 'promptVersion 必须是整数' })
  @Min(1, { message: 'promptVersion 必须 ≥ 1' })
  promptVersion?: number;

  @ApiPropertyOptional({ description: '字数下限' })
  @IsOptional()
  @IsInt({ message: 'minWordCount 必须是整数' })
  @Min(0, { message: 'minWordCount 必须 ≥ 0' })
  minWordCount?: number;

  @ApiPropertyOptional({ description: '字数上限' })
  @IsOptional()
  @IsInt({ message: 'maxWordCount 必须是整数' })
  @Min(0, { message: 'maxWordCount 必须 ≥ 0' })
  maxWordCount?: number;

  @ApiPropertyOptional({ description: '排序字段白名单', enum: ADMIN_REPORT_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(ADMIN_REPORT_SORT_FIELDS, { message: `sortBy 仅支持：${ADMIN_REPORT_SORT_FIELDS.join(', ')}` })
  sortBy?: AdminReportSortField;

  @ApiPropertyOptional({ description: '排序方向', enum: SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(SORT_ORDERS, { message: `order 仅支持：${SORT_ORDERS.join(', ')}` })
  order?: SortOrder;

  @ApiPropertyOptional({
    description:
      '⚠️ 是否返回报告正文（默认 false）。开启需 `X-Confirm-Password`（操作者本人密码），' +
      '并写入高等级审计，用于内容合规抽检。',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'includeContent 必须是布尔值' })
  includeContent?: boolean;
}
