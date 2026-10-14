/**
 * 管理端「关系与报告核查」模块 DTO（契约 §3.14.8.1 / §3.14.8.2）
 *
 * 错误码映射同其他管理端模块：契约声明的 `10004`（sortBy 白名单）/`10016`
 * （区间非法）在本项目映射为 `10001 PARAM_INVALID`（400，语义最接近），
 * 不新增错误码。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

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

/** 关系状态（与 `RelationshipStatus` 一致） */
export const RELATIONSHIP_STATUSES = ['PENDING_A_CONFIRM', 'ACTIVE', 'REJECTED', 'EXPIRED', 'REMOVED'] as const;
export type RelationshipStatusFilter = (typeof RELATIONSHIP_STATUSES)[number];

/** 关系类型（与 `RelationshipType` 一致） */
export const RELATIONSHIP_TYPES = ['COUPLE', 'FRIEND', 'FAMILY'] as const;
export type RelationshipTypeFilter = (typeof RELATIONSHIP_TYPES)[number];

/** 关系排序白名单（契约 §3.14.8.1） */
export const RELATIONSHIP_SORT_FIELDS = ['createdAt', 'activatedAt', 'overallScore'] as const;
export type RelationshipSortField = (typeof RELATIONSHIP_SORT_FIELDS)[number];

/** 报告类型（契约 §3.14.8.2） */
export const ADMIN_REPORT_TYPES = [
  'MBTI_REPORT',
  'BIG_FIVE_REPORT',
  'GROWTH_REPORT',
  'COMPATIBILITY_REPORT',
  // 情感测评报告（ADR-038 阶段 3）。
  // ⚠ 管理端白名单有**两处**（本文件与 `admin/ai-stats/dto`），
  // 漏改一处就会出现「后台筛不到情感报告」这类静默不一致。
  'EMOTION_REPORT',
] as const;
export type ReportTypeFilter = (typeof ADMIN_REPORT_TYPES)[number];

/** 报告状态（契约 §3.14.8.2） */
export const ADMIN_REPORT_STATUSES = ['PENDING', 'GENERATING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PARTIAL'] as const;
export type ReportStatusFilter = (typeof ADMIN_REPORT_STATUSES)[number];

/** 内容审核状态（契约 §3.14.8.2） */
export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'FLAGGED', 'REMOVED'] as const;
export type ReviewStatusFilter = (typeof REVIEW_STATUSES)[number];

/** 报告排序白名单（契约 §3.14.8.2） */
export const ADMIN_REPORT_SORT_FIELDS = ['generatedAt', 'wordCount', 'createdAt'] as const;
export type ReportSortField = (typeof ADMIN_REPORT_SORT_FIELDS)[number];

/** 排序方向 */
export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** 分页上限（契约 §3.14.8） */
export const ADMIN_REPORT_MAX_PAGE_SIZE = 100;

/** 默认每页条数 */
export const ADMIN_REPORT_DEFAULT_PAGE_SIZE = 20;

// ============================================================================
// GET /admin/relationships
// ============================================================================

export class AdminRelationshipsQueryDto {
  @ApiPropertyOptional({ description: '页码', default: 1 })
  @IsOptional()
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  page?: number;

  @ApiPropertyOptional({ description: `每页条数，最大 ${ADMIN_REPORT_MAX_PAGE_SIZE}`, default: 20 })
  @IsOptional()
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须 ≥ 1' })
  @Max(ADMIN_REPORT_MAX_PAGE_SIZE, { message: `pageSize 不能超过 ${ADMIN_REPORT_MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({ description: '状态筛选（逗号分隔）', enum: RELATIONSHIP_STATUSES, isArray: true })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(RELATIONSHIP_STATUSES, { each: true, message: `status 仅支持：${RELATIONSHIP_STATUSES.join(', ')}` })
  status?: RelationshipStatusFilter[];

  @ApiPropertyOptional({ description: '关系类型筛选（逗号分隔）', enum: RELATIONSHIP_TYPES, isArray: true })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(RELATIONSHIP_TYPES, { each: true, message: `relationType 仅支持：${RELATIONSHIP_TYPES.join(', ')}` })
  relationType?: RelationshipTypeFilter[];

  @ApiPropertyOptional({ description: '参与方用户 ID（匹配 userA 或 userB）' })
  @IsOptional()
  @IsUUID(undefined, { message: 'userId 必须是合法 UUID' })
  userId?: string;

  @ApiPropertyOptional({ description: '是否有匹配报告' })
  @IsOptional()
  @IsBoolean({ message: 'hasCompatibilityReport 必须是布尔值' })
  hasCompatibilityReport?: boolean;

  @ApiPropertyOptional({ description: '匹配分数下限（0–100）', minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt({ message: 'minScore 必须是整数' })
  @Min(0, { message: 'minScore 必须 ≥ 0' })
  @Max(100, { message: 'minScore 不能超过 100' })
  minScore?: number;

  @ApiPropertyOptional({ description: '匹配分数上限（0–100）', minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt({ message: 'maxScore 必须是整数' })
  @Min(0, { message: 'maxScore 必须 ≥ 0' })
  @Max(100, { message: 'maxScore 不能超过 100' })
  maxScore?: number;

  @ApiPropertyOptional({ description: '来源邀请码（裂变链路追溯）', maxLength: 8 })
  @IsOptional()
  @IsString({ message: 'sourceInviteCode 必须是字符串' })
  @Length(1, 8, { message: 'sourceInviteCode 长度需在 1–8 字符之间' })
  sourceInviteCode?: string;

  @ApiPropertyOptional({ description: '创建时间范围起点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startTime 必须是 ISO 8601 时间' })
  startTime?: string;

  @ApiPropertyOptional({ description: '创建时间范围终点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endTime 必须是 ISO 8601 时间' })
  endTime?: string;

  @ApiPropertyOptional({ description: '排序字段白名单', enum: RELATIONSHIP_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(RELATIONSHIP_SORT_FIELDS, { message: `sortBy 仅支持：${RELATIONSHIP_SORT_FIELDS.join(', ')}` })
  sortBy?: RelationshipSortField;

  @ApiPropertyOptional({ description: '排序方向', enum: SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(SORT_ORDERS, { message: `order 仅支持：${SORT_ORDERS.join(', ')}` })
  order?: SortOrder;
}

// ============================================================================
// GET /admin/reports
// ============================================================================

export class AdminReportsQueryDto {
  @ApiPropertyOptional({ description: '页码', default: 1 })
  @IsOptional()
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  page?: number;

  @ApiPropertyOptional({ description: `每页条数，最大 ${ADMIN_REPORT_MAX_PAGE_SIZE}`, default: 20 })
  @IsOptional()
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须 ≥ 1' })
  @Max(ADMIN_REPORT_MAX_PAGE_SIZE, { message: `pageSize 不能超过 ${ADMIN_REPORT_MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({ description: '报告类型（逗号分隔）', enum: ADMIN_REPORT_TYPES, isArray: true })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(ADMIN_REPORT_TYPES, { each: true, message: `type 仅支持：${ADMIN_REPORT_TYPES.join(', ')}` })
  type?: ReportTypeFilter[];

  @ApiPropertyOptional({ description: '报告状态（逗号分隔）', enum: ADMIN_REPORT_STATUSES, isArray: true })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(ADMIN_REPORT_STATUSES, { each: true, message: `status 仅支持：${ADMIN_REPORT_STATUSES.join(', ')}` })
  status?: ReportStatusFilter[];

  @ApiPropertyOptional({ description: '内容审核状态', enum: REVIEW_STATUSES })
  @IsOptional()
  @IsIn(REVIEW_STATUSES, { message: `reviewStatus 仅支持：${REVIEW_STATUSES.join(', ')}` })
  reviewStatus?: ReviewStatusFilter;

  @ApiPropertyOptional({
    description: '关联对象是否有报告（如关系是否有匹配报告）；仅对匹配报告类型生效',
  })
  @IsOptional()
  @IsBoolean({ message: 'hasReport 必须是布尔值' })
  hasReport?: boolean;

  @ApiPropertyOptional({ description: '指定用户 ID' })
  @IsOptional()
  @IsUUID(undefined, { message: 'userId 必须是合法 UUID' })
  userId?: string;

  @ApiPropertyOptional({ description: '指定关系 ID（匹配报告）' })
  @IsOptional()
  @IsUUID(undefined, { message: 'relationshipId 必须是合法 UUID' })
  relationshipId?: string;

  @ApiPropertyOptional({ description: '是否已解锁' })
  @IsOptional()
  @IsBoolean({ message: 'isUnlocked 必须是布尔值' })
  isUnlocked?: boolean;

  @ApiPropertyOptional({ description: '字数下限' })
  @IsOptional()
  @IsInt({ message: 'minWordCount 必须是整数' })
  @Min(0, { message: 'minWordCount 必须 ≥ 0' })
  minWordCount?: number;

  @ApiPropertyOptional({ description: '字数上限' })
  @IsOptional()
  @IsInt({ message: 'maxWordCount 必须是整数' })
  @Max(1_000_000, { message: 'maxWordCount 超出合理范围' })
  maxWordCount?: number;

  @ApiPropertyOptional({ description: '生成时间范围起点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startTime 必须是 ISO 8601 时间' })
  startTime?: string;

  @ApiPropertyOptional({ description: '生成时间范围终点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endTime 必须是 ISO 8601 时间' })
  endTime?: string;

  @ApiPropertyOptional({ description: '排序字段白名单', enum: ADMIN_REPORT_SORT_FIELDS, default: 'generatedAt' })
  @IsOptional()
  @IsIn(ADMIN_REPORT_SORT_FIELDS, { message: `sortBy 仅支持：${ADMIN_REPORT_SORT_FIELDS.join(', ')}` })
  sortBy?: ReportSortField;

  @ApiPropertyOptional({ description: '排序方向', enum: SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(SORT_ORDERS, { message: `order 仅支持：${SORT_ORDERS.join(', ')}` })
  order?: SortOrder;
}
