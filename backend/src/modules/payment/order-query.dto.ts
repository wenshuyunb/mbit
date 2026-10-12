/**
 * 用户端订单模块 DTO（契约 §3.9.3 ~ §3.9.7）
 *
 * ## 错误码落地说明（与 §3.14.6 同一原则，见 ADR-031）
 *
 * 契约声明的 `10003`（id 非合法 UUID）/`10004`（sortBy 白名单）/`10005`
 * （pageSize > 100）在本项目 `common/errors/error-code.ts` 中**已被占用且含义不同**
 * 或不存在，因此统一映射为 `10001 PARAM_INVALID`（400）：
 *
 * | 契约码 | 契约含义          | 本项目实际映射                                    |
 * | ------ | ----------------- | ------------------------------------------------- |
 * | 10003  | id 非合法 UUID    | `10001`（且本项目 `10003` 是 `RESOURCE_CONFLICT`）|
 * | 10004  | sortBy 不在白名单 | `10001`（本项目 `10004` 是 `METHOD_NOT_ALLOWED`） |
 * | 10005  | pageSize > 100    | `10001`（本项目 `10005` 是 `PAYLOAD_TOO_LARGE`）  |
 *
 * 不新增错误码：错误码是对外契约，前端已按码做分支，新增会与其脱节。
 *
 * ## 为什么不用 `enableImplicitConversion` 处理布尔查询参数
 *
 * `ValidationPipe` 开了 `enableImplicitConversion`，而 `class-transformer` 对
 * `design:type === Boolean` 的属性做的是 `Boolean(value)` —— **字符串 `'false'`
 * 会变成 `true`**（已实测）。因此 `?byNo=false` 会被当成 `byNo=true`，
 * 接口行为与调用方预期完全相反。这里的做法是把属性类型声明为联合类型
 * （`boolean | string`，其 `design:type` 是 `Object`，不触发隐式转换），
 * 再用 `@Transform` 显式解析，最后交给 `@IsBoolean` 兜底。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './order-query.util';
import { CLOSE_REASONS, USER_CANCEL_REASONS } from './refund.util';

/** 订单状态（与 Prisma `OrderStatus` 逐字一致） */
export const ORDER_STATUS_VALUES = [
  'CREATED',
  'PENDING_PAY',
  'PAID',
  'FULFILLED',
  'CLOSED',
  'CANCELLED',
  'REFUNDED',
  'PARTIAL_REFUNDED',
] as const;
export type OrderStatusValue = (typeof ORDER_STATUS_VALUES)[number];

/** 商品类型（与 Prisma `ProductType` 一致） */
export const ORDER_PRODUCT_TYPES = ['REPORT_PERSONAL', 'REPORT_COMPATIBILITY', 'MEMBERSHIP', 'AI_CREDITS'] as const;
export type OrderProductTypeValue = (typeof ORDER_PRODUCT_TYPES)[number];

/** 排序字段白名单（契约 §3.9.3） */
export const ORDER_SORT_FIELDS = ['createdAt', 'paidAt', 'amount'] as const;
export type OrderSortField = (typeof ORDER_SORT_FIELDS)[number];

/** 排序方向 */
export const ORDER_SORT_ORDERS = ['asc', 'desc'] as const;
export type OrderSortOrder = (typeof ORDER_SORT_ORDERS)[number];

/** 逗号分隔 → 数组（同时接受 `?status=A,B` 与 `?status=A&status=B`） */
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

/**
 * 查询参数布尔值解析
 *
 * 只认明确的 `true/false/1/0`（大小写不敏感）；其余值原样返回，由 `@IsBoolean`
 * 报 400 —— 把 `'yes'` / `''` 猜成布尔会让调用方在毫不知情的情况下改变行为。
 */
const toQueryBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }

  return value;
};

// ============================================================================
// GET /orders
// ============================================================================

export class ListOrdersQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, default: 1 })
  @IsOptional()
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，默认 ${DEFAULT_PAGE_SIZE}，最大 ${MAX_PAGE_SIZE}（超出 → 10001）`,
    example: DEFAULT_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须 ≥ 1' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize 不能超过 ${MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({
    description: '状态筛选（逗号分隔，非法值 → 10001）',
    example: 'FULFILLED,PAID',
    enum: ORDER_STATUS_VALUES,
    isArray: true,
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(ORDER_STATUS_VALUES, { each: true, message: `status 仅支持：${ORDER_STATUS_VALUES.join(', ')}` })
  status?: OrderStatusValue[];

  @ApiPropertyOptional({ description: '按商品类型筛选', enum: ORDER_PRODUCT_TYPES })
  @IsOptional()
  @IsIn(ORDER_PRODUCT_TYPES, { message: `type 仅支持：${ORDER_PRODUCT_TYPES.join(', ')}` })
  type?: OrderProductTypeValue;

  @ApiPropertyOptional({ description: '创建时间范围起点（ISO 8601）', example: '2026-02-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startTime 必须是 ISO 8601 时间' })
  startTime?: string;

  @ApiPropertyOptional({ description: '创建时间范围终点（ISO 8601）', example: '2026-02-14T23:59:59.999Z' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endTime 必须是 ISO 8601 时间' })
  endTime?: string;

  @ApiPropertyOptional({ description: '排序字段白名单', enum: ORDER_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(ORDER_SORT_FIELDS, { message: `sortBy 仅支持：${ORDER_SORT_FIELDS.join(', ')}` })
  sortBy?: OrderSortField;

  @ApiPropertyOptional({ description: '排序方向', enum: ORDER_SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(ORDER_SORT_ORDERS, { message: `order 仅支持：${ORDER_SORT_ORDERS.join(', ')}` })
  order?: OrderSortOrder;
}

// ============================================================================
// GET /orders/{id}
// ============================================================================

/**
 * 路径参数刻意**不**用 `@IsUUID()`
 *
 * 契约 §3.9.4 允许 `?byNo=true` 时把该参数当作 `orderNo`（形如 `SM20260214A7K3M9Q1`），
 * 而 DTO 校验发生在服务层拿到 `byNo` 之前，"按条件校验"写不进装饰器。
 * 因此这里只做长度与形态粗筛，精确判定（UUID 或订单号）在 Service 里完成，
 * 并统一抛 `10001`（契约的 `10003` 在本项目含义不同）。
 */
export class GetOrderParamDto {
  @ApiProperty({ description: '订单 UUID；`byNo=true` 时为订单号', example: '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89' })
  @IsString({ message: 'id 必须是字符串' })
  @Length(1, 64, { message: 'id 长度需在 1–64 字符之间' })
  id!: string;
}

export class GetOrderQueryDto {
  @ApiPropertyOptional({
    description: '`true` 时把 path 参数当作 `orderNo` 解析（默认 `false`）',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @Transform(toQueryBoolean)
  @IsBoolean({ message: 'byNo 必须是布尔值' })
  byNo?: boolean | string;

  @ApiPropertyOptional({ description: '是否内联退款记录（默认 `true`）', type: Boolean, default: true })
  @IsOptional()
  @Transform(toQueryBoolean)
  @IsBoolean({ message: 'includeRefunds 必须是布尔值' })
  includeRefunds?: boolean | string;
}

// ============================================================================
// POST /orders/{id}/query
// ============================================================================

export class QueryOrderBodyDto {
  @ApiPropertyOptional({
    description: '`true` 时忽略「最近 30s 已查过」的节流，强制实时查单（仅供客服/排障）',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @Transform(toQueryBoolean)
  @IsBoolean({ message: 'force 必须是布尔值' })
  force?: boolean | string;
}

// ============================================================================
// POST /orders/{id}/cancel
// ============================================================================

export class CancelOrderBodyDto {
  @ApiPropertyOptional({
    description: '取消原因（用于产品分析）',
    enum: USER_CANCEL_REASONS,
    default: 'CHANGED_MIND',
  })
  @IsOptional()
  @IsIn(USER_CANCEL_REASONS, { message: `reason 仅支持：${USER_CANCEL_REASONS.join(', ')}` })
  reason?: string;
}

// ============================================================================
// POST /orders/{id}/close
// ============================================================================

export class CloseOrderBodyDto {
  @ApiPropertyOptional({
    description: '关单原因。用户调用时 `TIMEOUT` 会被忽略并强制为 `USER_REQUEST`（契约 §3.9.7）',
    enum: CLOSE_REASONS,
    default: 'USER_REQUEST',
  })
  @IsOptional()
  @IsIn(CLOSE_REASONS, { message: `closeReason 仅支持：${CLOSE_REASONS.join(', ')}` })
  closeReason?: string;
}
