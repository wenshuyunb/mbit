/**
 * 权益 DTO（契约 §3.8.3）
 *
 * 校验策略与项目其余模块一致：全局 `ValidationPipe` 开启 `whitelist` +
 * `forbidNonWhitelisted`。
 *
 * ## 错误码映射（契约码 → 本项目实际返回码）
 *
 * 契约 §3.8.3 用到的 `10004`（`sortBy` 越界）与 `10005`（`pageSize > 100`）
 * 在本项目里的含义分别是「方法不允许」「请求体过大」，直接复用会把参数问题
 * 变成 405 / 413。因此统一映射为 `10001 PARAM_INVALID`（400，语义最接近），
 * 与 `admin/order`、`admin/audit-log` 等既有模块的处理方式一致。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { ENTITLEMENT_STATUSES, ENTITLEMENT_TYPES } from '../entitlement-view.util';

/** 排序字段白名单（契约 §3.8.3 的 `sortBy`） */
export const ENTITLEMENT_SORT_FIELDS = ['grantedAt', 'expiresAt'] as const;

export type EntitlementSortField = (typeof ENTITLEMENT_SORT_FIELDS)[number];

/** 每页条数上限（契约 §3.8.3：`pageSize ≤ 100`） */
export const MAX_ENTITLEMENT_PAGE_SIZE = 100;

/**
 * 逗号分隔的多值参数 → 数组
 *
 * 全局 `ValidationPipe` 开了 `enableImplicitConversion`，若不先转换，
 * `@IsIn(..., { each: true })` 会把 `'ACTIVE,EXPIRED'` 当成单个值。
 */
const splitCommaSeparated = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
};

export class ListEntitlementsQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'page 不得小于 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，最大 ${MAX_ENTITLEMENT_PAGE_SIZE}`,
    example: 20,
    minimum: 1,
    maximum: MAX_ENTITLEMENT_PAGE_SIZE,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'pageSize 不得小于 1' })
  @Max(MAX_ENTITLEMENT_PAGE_SIZE, { message: `pageSize 不得超过 ${MAX_ENTITLEMENT_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({
    enum: ENTITLEMENT_TYPES,
    isArray: true,
    description: '权益类型，逗号分隔多选（如 `REPORT_UNLOCK,AI_CREDITS`）；不传则不限类型',
    example: 'REPORT_UNLOCK',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(ENTITLEMENT_TYPES, { each: true, message: 'type 含非法枚举值' })
  type?: (typeof ENTITLEMENT_TYPES)[number][];

  @ApiPropertyOptional({
    enum: ENTITLEMENT_STATUSES,
    isArray: true,
    description:
      '状态，逗号分隔多选。**不传时返回全部状态**（含已过期/已消耗）——「我的权益」页需要能翻到历史记录；服务端状态为派生值（状态列 + 到期时间 + 剩余次数）',
    example: 'ACTIVE',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(ENTITLEMENT_STATUSES, { each: true, message: 'status 含非法枚举值' })
  status?: (typeof ENTITLEMENT_STATUSES)[number][];

  @ApiPropertyOptional({
    description: '按关联资源筛选（如某份报告的解锁权益）',
    example: '0195f3a2-aa11-7b97-8c02-2e3f4a5b6c01',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID(undefined, { message: 'resourceId 必须是合法 UUID' })
  resourceId?: string;

  @ApiPropertyOptional({
    enum: ENTITLEMENT_SORT_FIELDS,
    description:
      '排序字段（白名单，越界由全局 ValidationPipe 返回 400）。**可用权益始终置顶**：`status` 为第一排序键，本字段为第二排序键',
    example: 'grantedAt',
    default: 'grantedAt',
  })
  @IsOptional()
  @IsIn(ENTITLEMENT_SORT_FIELDS, { message: 'sortBy 不在允许的排序字段内' })
  sortBy?: EntitlementSortField;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    description: '排序方向，默认 `desc`',
    example: 'desc',
    default: 'desc',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'order 必须是 asc 或 desc' })
  order?: 'asc' | 'desc';
}
