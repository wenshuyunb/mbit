/**
 * 报告模块 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.5
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsIn, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  REPORT_SORT_FIELDS,
  REPORT_SORT_ORDERS,
  REPORT_STATUS_FILTERS,
  type ReportSortField,
  type ReportSortOrder,
  type ReportStatusFilter,
} from './report-list.util';

/** 支持的报告类型（与 Prisma `AiReportType` 对齐） */
export const REPORT_TYPES = ['MBTI_REPORT', 'BIG_FIVE_REPORT', 'RELATIONSHIP_REPORT', 'GROWTH_SUMMARY'] as const;
export type ReportTypeValue = (typeof REPORT_TYPES)[number];

/**
 * 逗号分隔的多值参数 → 数组
 *
 * 契约 §3.5.2 把 `type` / `status` 定义为「逗号分隔枚举」。全局 ValidationPipe
 * 开了 `enableImplicitConversion`，若不先转换，`@IsIn(..., { each: true })` 会拿到
 * 整个字符串 `'SUCCEEDED,FAILED'` 当作单个值 → 误判为非法枚举。
 *
 * 同时做两件清洗：去空白（`'A, B'` 要能解析）、丢弃空段（`'A,,'` 不应触发校验失败）。
 */
const splitCommaSeparated = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
};

export class CreateReportDto {
  @ApiProperty({ enum: REPORT_TYPES, description: '报告类型', example: 'MBTI_REPORT' })
  @IsIn(REPORT_TYPES, { message: 'type 取值不合法' })
  type!: ReportTypeValue;

  @ApiPropertyOptional({
    description: '指定测评会话；不传则绑定该用户**当前**的人格画像',
    example: '0195f3a2-91a7-7d53-b8c9-4a7b1e2f3c12',
    maxLength: 36,
  })
  @IsOptional()
  @IsString()
  @Length(1, 36)
  sessionId?: string;
}

export class ReportIdParamDto {
  @ApiProperty({ description: '报告 ID（UUID）', example: '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d' })
  @IsString({ message: '报告 ID 必须是字符串' })
  @Length(1, 36, { message: '报告 ID 长度不合法' })
  reportId!: string;
}

// ============================================================================
// GET /reports
// ============================================================================

export class ListReportsQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'page 不得小于 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，最大 ${MAX_PAGE_SIZE}`,
    example: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'pageSize 不得小于 1' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize 不得超过 ${MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({
    enum: REPORT_TYPES,
    isArray: true,
    description: '报告类型，逗号分隔多选（如 `MBTI_REPORT,GROWTH_SUMMARY`）；不传则不限类型',
    example: 'MBTI_REPORT',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(REPORT_TYPES, { each: true, message: 'type 含非法枚举值' })
  type?: ReportTypeValue[];

  @ApiPropertyOptional({
    enum: REPORT_STATUS_FILTERS,
    isArray: true,
    description: '报告状态，逗号分隔多选（如 `SUCCEEDED,FAILED`）；不传则不限状态',
    example: 'SUCCEEDED',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(REPORT_STATUS_FILTERS, { each: true, message: 'status 含非法枚举值' })
  status?: ReportStatusFilter[];

  @ApiPropertyOptional({
    enum: REPORT_SORT_FIELDS,
    description: '排序字段（白名单，越界返回 `10004`）',
    example: 'createdAt',
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(REPORT_SORT_FIELDS, { message: 'sortBy 不在允许的排序字段内' })
  sortBy?: ReportSortField;

  @ApiPropertyOptional({
    enum: REPORT_SORT_ORDERS,
    description: '排序方向',
    example: 'desc',
    default: 'desc',
  })
  @IsOptional()
  @IsIn(REPORT_SORT_ORDERS, { message: 'order 必须是 asc 或 desc' })
  order?: ReportSortOrder;
}
