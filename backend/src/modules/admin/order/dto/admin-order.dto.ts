/**
 * 管理端订单模块 DTO
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.6（列表 / 详情 / 导出）
 * 校验策略：全局 ValidationPipe 已开启 `whitelist + forbidNonWhitelisted + transform`，
 * 因此这里的 `@IsIn` 白名单同时承担「拒绝未知字段」与「拒绝非法枚举」两件事。
 *
 * ## 错误码落地说明（重要）
 *
 * 契约 §3.14.6 声明的 `10004`（sortBy 白名单）/`10005`（pageSize 超限）/`10016`
 * （金额或时间范围非法）/`10011`（缺幂等键）在本项目 `common/errors/error-code.ts`
 * 中**已被占用且含义不同**或**不存在**（见 ADR-031 对管理端错误码的处理原则）：
 *
 * | 契约码 | 契约含义              | 本项目实际映射                                    |
 * | ------ | --------------------- | ------------------------------------------------- |
 * | 10004  | sortBy 不在白名单     | `10001 PARAM_INVALID`（400，语义最接近）          |
 * | 10005  | pageSize > 100        | `10001 PARAM_INVALID`（400）                      |
 * | 10016  | 范围/区间非法         | `10001 PARAM_INVALID`（400）                      |
 * | 10011  | 缺 X-Idempotency-Key  | `10009 IDEMPOTENCY_KEY_MISSING`（400，本项目定义）|
 *
 * 因此 DTO 层的枚举/区间校验统一让 ValidationPipe 抛 400，再由全局过滤器归一为
 * `10001`；跨字段校验（min>max、范围>366 天）在 Service 里显式抛 `10001`。
 * 不新增错误码：错误码是对外契约，新增会与前端既有分支逻辑脱节。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

/** 订单状态（与 Prisma `OrderStatus` 逐字一致，契约 §3.14.6.1 的 8 个状态） */
export const ADMIN_ORDER_STATUSES = [
  'CREATED',
  'PENDING_PAY',
  'PAID',
  'FULFILLED',
  'CLOSED',
  'CANCELLED',
  'REFUNDED',
  'PARTIAL_REFUNDED',
] as const;
export type AdminOrderStatus = (typeof ADMIN_ORDER_STATUSES)[number];

/** 商品类型（与 Prisma `ProductType` 一致） */
export const ADMIN_ORDER_PRODUCT_TYPES = [
  'REPORT_PERSONAL',
  'REPORT_COMPATIBILITY',
  'MEMBERSHIP',
  'AI_CREDITS',
] as const;
export type AdminOrderProductType = (typeof ADMIN_ORDER_PRODUCT_TYPES)[number];

/** 排序字段白名单（契约 §3.14.6.1；其余值 → `10001`） */
export const ADMIN_ORDER_SORT_FIELDS = ['createdAt', 'paidAt', 'amount'] as const;
export type AdminOrderSortField = (typeof ADMIN_ORDER_SORT_FIELDS)[number];

/** 排序方向（契约 §3.14.6.1，默认 `desc`） */
export const ADMIN_ORDER_SORT_ORDERS = ['asc', 'desc'] as const;
export type AdminOrderSortOrder = (typeof ADMIN_ORDER_SORT_ORDERS)[number];

/** 导出格式（契约 §3.14.6.4） */
export const ORDER_EXPORT_FORMATS = ['CSV', 'XLSX'] as const;
export type OrderExportFormat = (typeof ORDER_EXPORT_FORMATS)[number];

/** 导出字段白名单（契约 §3.14.6.4，逐字照抄） */
export const ORDER_EXPORT_FIELDS = [
  'orderNo',
  'status',
  'productName',
  'productType',
  'userId',
  'userNickname',
  'amount',
  'payAmount',
  'refundedAmount',
  'payMethod',
  'transactionId',
  'createdAt',
  'paidAt',
  'fulfilledAt',
  'refundCount',
] as const;
export type OrderExportField = (typeof ORDER_EXPORT_FIELDS)[number];

/** 导出时间范围上限（契约 §3.14.6.4：≤ 366 天，防一次性拖走全量订单） */
export const ORDER_EXPORT_MAX_RANGE_DAYS = 366;

/** 分页上限（契约 §3.14.6.1） */
export const ADMIN_ORDER_MAX_PAGE_SIZE = 100;

/** 默认每页条数（契约 §3.14.6.1） */
export const ADMIN_ORDER_DEFAULT_PAGE_SIZE = 20;

/**
 * 逗号分隔字符串 → 数组
 *
 * 同时接受 `?status=A,B` 与 `?status=A&status=B` 两种写法（与用户端 `include` 参数
 * 保持一致的手感）。刻意**不做**隐式 `String()` 转换：把对象变成 `'[object Object]'`
 * 再交给枚举校验，会产出「值非法」这种看不出根因的报错。
 */
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

// ============================================================================
// GET /admin/orders
// ============================================================================

export class ListAdminOrdersQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, default: 1 })
  @IsOptional()
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，默认 20，最大 ${ADMIN_ORDER_MAX_PAGE_SIZE}（超出 → 10001）`,
    example: 20,
    default: 20,
    maximum: ADMIN_ORDER_MAX_PAGE_SIZE,
  })
  @IsOptional()
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须 ≥ 1' })
  @Max(ADMIN_ORDER_MAX_PAGE_SIZE, { message: `pageSize 不能超过 ${ADMIN_ORDER_MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({ description: '搜索：orderNo / transactionId / 用户 ID / 用户昵称', maxLength: 64 })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @Length(1, 64, { message: 'keyword 长度需在 1–64 字符之间' })
  keyword?: string;

  @ApiPropertyOptional({
    description: '状态筛选（逗号分隔）',
    example: 'FULFILLED,PAID',
    enum: ADMIN_ORDER_STATUSES,
    isArray: true,
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(ADMIN_ORDER_STATUSES, { each: true, message: `status 仅支持：${ADMIN_ORDER_STATUSES.join(', ')}` })
  status?: AdminOrderStatus[];

  @ApiPropertyOptional({ description: '商品类型', enum: ADMIN_ORDER_PRODUCT_TYPES })
  @IsOptional()
  @IsIn(ADMIN_ORDER_PRODUCT_TYPES, { message: `productType 仅支持：${ADMIN_ORDER_PRODUCT_TYPES.join(', ')}` })
  productType?: AdminOrderProductType;

  @ApiPropertyOptional({ description: '商品编码（products.code）', maxLength: 64 })
  @IsOptional()
  @IsString({ message: 'productCode 必须是字符串' })
  @Length(1, 64, { message: 'productCode 长度需在 1–64 字符之间' })
  productCode?: string;

  @ApiPropertyOptional({ description: '指定用户 ID（UUIDv7）' })
  @IsOptional()
  @IsUUID(undefined, { message: 'userId 必须是合法 UUID' })
  userId?: string;

  @ApiPropertyOptional({ description: '金额下限（整数分）', example: 0 })
  @IsOptional()
  @IsInt({ message: 'minAmount 必须是整数分' })
  @Min(0, { message: 'minAmount 必须 ≥ 0' })
  minAmount?: number;

  @ApiPropertyOptional({ description: '金额上限（整数分）', example: 100000 })
  @IsOptional()
  @IsInt({ message: 'maxAmount 必须是整数分' })
  @Min(0, { message: 'maxAmount 必须 ≥ 0' })
  maxAmount?: number;

  @ApiPropertyOptional({ description: '是否含退款' })
  @IsOptional()
  @IsBoolean({ message: 'hasRefund 必须是布尔值' })
  hasRefund?: boolean;

  @ApiPropertyOptional({ description: '支付时间范围起点（ISO 8601）', example: '2026-02-14T00:00:00.000Z' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'paidStartTime 必须是 ISO 8601 时间' })
  paidStartTime?: string;

  @ApiPropertyOptional({ description: '支付时间范围终点（ISO 8601）', example: '2026-02-14T23:59:59.999Z' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'paidEndTime 必须是 ISO 8601 时间' })
  paidEndTime?: string;

  @ApiPropertyOptional({ description: '创建时间范围起点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'createdStartTime 必须是 ISO 8601 时间' })
  createdStartTime?: string;

  @ApiPropertyOptional({ description: '创建时间范围终点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'createdEndTime 必须是 ISO 8601 时间' })
  createdEndTime?: string;

  @ApiPropertyOptional({
    description: '排序字段白名单',
    enum: ADMIN_ORDER_SORT_FIELDS,
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(ADMIN_ORDER_SORT_FIELDS, { message: `sortBy 仅支持：${ADMIN_ORDER_SORT_FIELDS.join(', ')}` })
  sortBy?: AdminOrderSortField;

  @ApiPropertyOptional({ description: '排序方向', enum: ADMIN_ORDER_SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(ADMIN_ORDER_SORT_ORDERS, { message: `order 仅支持：${ADMIN_ORDER_SORT_ORDERS.join(', ')}` })
  order?: AdminOrderSortOrder;
}

// ============================================================================
// GET /admin/orders/{id}
// ============================================================================

export class GetAdminOrderParamDto {
  @ApiPropertyOptional({
    description: '订单 UUID；`byNo=true` 时为订单号（形如 SM20260214A7K3M9Q1）',
  })
  @IsString({ message: 'id 必须是字符串' })
  @Length(1, 64, { message: 'id 长度需在 1–64 字符之间' })
  id!: string;
}

export class GetAdminOrderQueryDto {
  @ApiPropertyOptional({
    description: '为 true 时把 path 参数 `id` 当作 `orderNo` 查询（契约 §3.14.6.2）',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'byNo 必须是布尔值' })
  byNo?: boolean;
}

// ============================================================================
// GET /admin/orders/export
// ============================================================================

/**
 * 导出参数
 *
 * `taskId` 与查询参数**互斥**：带 `taskId` 时是「查询任务状态」（200），
 * 不带时是「创建任务」（202）。契约 §3.14.6.4 的 `pollUrl` 就是这个形态
 * （`GET /admin/orders/export?taskId=xxx`），因此两条语义必须共用一个 URL。
 */
export class ExportAdminOrdersQueryDto {
  @ApiPropertyOptional({ description: '导出任务 ID；携带时查询任务状态而非创建任务' })
  @IsOptional()
  @IsUUID(undefined, { message: 'taskId 必须是合法 UUID' })
  taskId?: string;

  @ApiPropertyOptional({ description: '状态筛选（逗号分隔）', enum: ADMIN_ORDER_STATUSES, isArray: true })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(ADMIN_ORDER_STATUSES, { each: true, message: `status 仅支持：${ADMIN_ORDER_STATUSES.join(', ')}` })
  status?: AdminOrderStatus[];

  @ApiPropertyOptional({ description: '商品类型', enum: ADMIN_ORDER_PRODUCT_TYPES })
  @IsOptional()
  @IsIn(ADMIN_ORDER_PRODUCT_TYPES, { message: `productType 仅支持：${ADMIN_ORDER_PRODUCT_TYPES.join(', ')}` })
  productType?: AdminOrderProductType;

  @ApiPropertyOptional({
    description: '创建时间范围起点（**创建任务时必填**，ISO 8601）',
    example: '2026-02-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'createdStartTime 必须是 ISO 8601 时间' })
  createdStartTime?: string;

  @ApiPropertyOptional({
    description: '创建时间范围终点（**创建任务时必填**，ISO 8601）',
    example: '2026-02-14T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'createdEndTime 必须是 ISO 8601 时间' })
  createdEndTime?: string;

  @ApiPropertyOptional({ description: '支付时间范围起点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'paidStartTime 必须是 ISO 8601 时间' })
  paidStartTime?: string;

  @ApiPropertyOptional({ description: '支付时间范围终点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'paidEndTime 必须是 ISO 8601 时间' })
  paidEndTime?: string;

  @ApiPropertyOptional({ description: '是否含退款' })
  @IsOptional()
  @IsBoolean({ message: 'hasRefund 必须是布尔值' })
  hasRefund?: boolean;

  @ApiPropertyOptional({ description: '导出格式', enum: ORDER_EXPORT_FORMATS, default: 'CSV' })
  @IsOptional()
  @IsIn(ORDER_EXPORT_FORMATS, { message: `format 仅支持：${ORDER_EXPORT_FORMATS.join(', ')}` })
  format?: OrderExportFormat;

  @ApiPropertyOptional({
    description: '导出字段（逗号分隔，白名单）',
    example: 'orderNo,status,payAmount',
    enum: ORDER_EXPORT_FIELDS,
    isArray: true,
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(ORDER_EXPORT_FIELDS, { each: true, message: `fields 仅支持：${ORDER_EXPORT_FIELDS.join(', ')}` })
  fields?: OrderExportField[];

  @ApiPropertyOptional({
    description: '是否脱敏（用户昵称与用户 ID 部分掩码），默认 true',
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'maskSensitive 必须是布尔值' })
  maskSensitive?: boolean;
}
