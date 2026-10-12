/**
 * 审计日志查询参数（契约 §3.14.9.3）
 *
 * 校验策略：全局 `ValidationPipe` 已开启 `whitelist` + `forbidNonWhitelisted`，
 * 因此**每一个**契约 Query 参数都必须在这里声明，否则会被判为「未声明字段」直接
 * 报 `10001`（静默丢弃更糟：前端以为过滤生效了，实际返回的是全量数据）。
 *
 * 校验失败统一由全局 `exceptionFactory` 抛 `ErrorCode.PARAM_INVALID`（`10001`，400），
 * 与契约错误表一致 —— 契约里 `10001` / `10002` 两种写法都指向 400，而本仓库的
 * `10002` 是 `RESOURCE_NOT_FOUND`（404），语义不符，故只用 `10001`。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsIn, IsISO8601, IsOptional, IsString, Length, Matches } from 'class-validator';

import { PaginationQueryDto } from '../../../../common/dto/api-response.dto';
import {
  AUDIT_RESULTS,
  AUDIT_SEVERITIES,
  AUDIT_SORT_FIELDS,
  AUDIT_SORT_ORDERS,
  AUDIT_TARGET_TYPES,
  UUID_PATTERN,
  type AuditResult,
  type AuditSeverity,
  type AuditSortField,
  type AuditSortOrder,
  type AuditTargetType,
} from '../admin-audit-log.constants';

/**
 * 逗号分隔的多值参数 → 数组
 *
 * 与 `ai/report/report.dto.ts` 同一手法：全局管道开了 `enableImplicitConversion`，
 * 不先转换的话 `@IsString({ each: true })` 会拿到整串 `'a,b'` 当单个值。
 * 同时去空白（`'A, B'` 要能解析）并丢弃空段（`'A,,'` 不应触发校验失败）。
 */
const splitCommaSeparated = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
};

export class AdminAuditLogQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '开始时间（ISO 8601，**必填**）',
    example: '2026-02-01T00:00:00.000Z',
  })
  // 契约标为必填。这里刻意**不加** `@IsOptional()`：缺参时 `@IsString` 会拒绝
  // `undefined`，返回 10001（「缺时间范围」），与契约错误表一致
  @IsString({ message: 'startTime 必须是 ISO 8601 字符串' })
  @IsISO8601({ strict: true }, { message: 'startTime 必须是合法的 ISO 8601 时间' })
  startTime!: string;

  @ApiProperty({
    description: '结束时间（ISO 8601，**必填**，必须晚于 `startTime`，且范围 ≤ 90 天）',
    example: '2026-02-14T23:59:59.999Z',
  })
  @IsString({ message: 'endTime 必须是 ISO 8601 字符串' })
  @IsISO8601({ strict: true }, { message: 'endTime 必须是合法的 ISO 8601 时间' })
  endTime!: string;

  @ApiPropertyOptional({
    description: '按操作人（管理员 ID）过滤',
    example: '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a',
  })
  @IsOptional()
  // 必须校验 UUID 形态：`admin_user_id` 是 `@db.Uuid` 列，传非 UUID 串会被
  // PostgreSQL 判为非法输入而抛错（表现为 500），而不是「查不到」
  @Matches(UUID_PATTERN, { message: 'operatorAdminId 必须是合法的 UUID' })
  operatorAdminId?: string;

  @ApiPropertyOptional({
    isArray: true,
    description:
      '动作（**权限点**或裸动作名），逗号分隔多选，如 `payment:order:refund,ai:prompt:publish`。' +
      '权限点由 `(resourceType, action)` 反推，无法反推时按 `resourceType` 精确匹配',
    example: 'payment:order:refund',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsString({ each: true, message: 'action 必须是字符串列表' })
  // 上限用于挡住「一个请求塞上千个 OR 条件」把库拖垮
  @ArrayMaxSize(20, { message: 'action 最多 20 个取值' })
  action?: string[];

  @ApiPropertyOptional({
    enum: [...AUDIT_TARGET_TYPES],
    description: '目标类型（枚举外的取值 → `10001`）',
    example: 'ORDER',
  })
  @IsOptional()
  @IsIn(AUDIT_TARGET_TYPES, { message: 'targetType 取值不合法' })
  targetType?: AuditTargetType;

  @ApiPropertyOptional({
    description: '目标 ID（≤ 64 字符）',
    example: '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64, { message: 'targetId 长度需在 1–64 个字符之间' })
  targetId?: string;

  @ApiPropertyOptional({
    enum: [...AUDIT_RESULTS],
    description: '操作结果（`DENIED` 表示越权尝试被拒，安全审计重点）',
    example: 'SUCCESS',
  })
  @IsOptional()
  @IsIn(AUDIT_RESULTS, { message: 'result 取值不合法' })
  result?: AuditResult;

  @ApiPropertyOptional({
    enum: [...AUDIT_SEVERITIES],
    description: '风险等级（由权限点推导，非表内列）',
    example: 'CRITICAL',
  })
  @IsOptional()
  @IsIn(AUDIT_SEVERITIES, { message: 'severity 取值不合法' })
  severity?: AuditSeverity;

  @ApiPropertyOptional({
    description: '关键词（在 `changeNote`（`reason` / `diff_summary`）与 `action` 内搜索，≤ 64 字符）',
    example: '退款',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64, { message: 'keyword 长度需在 1–64 个字符之间' })
  keyword?: string;

  @ApiPropertyOptional({
    enum: [...AUDIT_SORT_FIELDS],
    description: '排序字段（白名单只有 `createdAt`，越界 → `10001`）',
    default: 'createdAt',
    example: 'createdAt',
  })
  @IsOptional()
  @IsIn(AUDIT_SORT_FIELDS, { message: 'sortBy 仅支持 createdAt（不在白名单内）' })
  sortBy?: AuditSortField;

  @ApiPropertyOptional({
    enum: [...AUDIT_SORT_ORDERS],
    description: '排序方向，默认 `desc`（新记录在前）',
    default: 'desc',
    example: 'desc',
  })
  @IsOptional()
  @IsIn(AUDIT_SORT_ORDERS, { message: 'order 必须是 asc 或 desc' })
  order?: AuditSortOrder;
}
