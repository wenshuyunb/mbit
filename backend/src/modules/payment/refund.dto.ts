/**
 * 退款 DTO（契约 §3.9.9 / §3.9.10 / §3.14.6.3）
 *
 * ## 金额一律整数分（ADR-009）
 *
 * `refundAmount` 是**唯一**允许客户端传金额的字段，且它受到
 * 「`0 < refundAmount ≤ 可退金额`」与「用户侧只允许全额」两道约束。
 * 其余金额（订单总额、实付额）**只能由服务端从 `orders` 表读取** ——
 * 前端把「元」当「分」传是这类接口最经典的事故。
 *
 * ## 幂等
 *
 * 两个退款接口都要求 `X-Idempotency-Key`（契约标注 ♻️），由
 * `@IdempotencyKey()` 提取与校验格式，缺失即 `10009`
 * （契约写作 `10011`，但本项目 `10011` 是 `VERSION_OUTDATED`，见 ADR-031）。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './order-query.util';
import { USER_REFUND_REASONS } from './refund.util';

/** 退款记录状态（与 Prisma `RefundStatus` 逐字一致） */
export const REFUND_STATUS_VALUES = ['PENDING', 'SUCCESS', 'FAILED', 'CLOSED'] as const;
export type RefundStatusValue = (typeof REFUND_STATUS_VALUES)[number];

/** 退款类型（管理员可指定；用户侧只允许全额） */
export const REFUND_TYPE_VALUES = ['FULL', 'PARTIAL'] as const;
export type RefundTypeValue = (typeof REFUND_TYPE_VALUES)[number];

/** 逗号分隔 → 数组 */
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

/** 布尔解析（理由见 `order-query.dto.ts` 的文件头：隐式转换会把 `'false'` 变成 `true`） */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }

  return value;
};

// ============================================================================
// GET /refunds
// ============================================================================

export class ListRefundsQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, default: 1 })
  @IsOptional()
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须 ≥ 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，默认 ${DEFAULT_PAGE_SIZE}，最大 ${MAX_PAGE_SIZE}`,
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
    description: '状态筛选（逗号分隔）',
    example: 'SUCCESS,FAILED',
    enum: REFUND_STATUS_VALUES,
    isArray: true,
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsIn(REFUND_STATUS_VALUES, { each: true, message: `status 仅支持：${REFUND_STATUS_VALUES.join(', ')}` })
  status?: RefundStatusValue[];

  @ApiPropertyOptional({
    description: '按订单筛选（**必须属于当前用户**，否则 `70002`）',
    example: '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89',
  })
  @IsOptional()
  @IsString({ message: 'orderId 必须是字符串' })
  @Length(1, 64, { message: 'orderId 长度需在 1–64 字符之间' })
  orderId?: string;

  @ApiPropertyOptional({ description: '申请时间范围起点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startTime 必须是 ISO 8601 时间' })
  startTime?: string;

  @ApiPropertyOptional({ description: '申请时间范围终点（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endTime 必须是 ISO 8601 时间' })
  endTime?: string;
}

// ============================================================================
// POST /orders/{id}/refund（用户侧）
// ============================================================================

export class ApplyRefundBodyDto {
  @ApiPropertyOptional({
    description:
      '退款金额（整数分）。**用户侧仅允许全额**：不传或等于可退金额；' +
      '小于可退金额 → `70012`，大于 → `70010`（本项目映射见简报）',
    example: 9900,
    minimum: 1,
  })
  @IsOptional()
  @IsInt({ message: 'refundAmount 必须是整数分' })
  @Min(1, { message: 'refundAmount 必须 > 0' })
  refundAmount?: number;

  @ApiProperty({
    description: '退款原因（**必填**）',
    enum: USER_REFUND_REASONS,
    example: 'NOT_AS_EXPECTED',
  })
  @IsIn(USER_REFUND_REASONS, { message: `reason 仅支持：${USER_REFUND_REASONS.join(', ')}` })
  reason!: string;

  @ApiPropertyOptional({ description: '补充说明（进入客服工单）', maxLength: 200, example: '报告与我的情况差异较大' })
  @IsOptional()
  @IsString({ message: 'description 必须是字符串' })
  @Length(0, 200, { message: 'description 长度不能超过 200 字符' })
  description?: string;

  @ApiPropertyOptional({ description: '联系方式（便于客服跟进）', maxLength: 64, example: '微信同号' })
  @IsOptional()
  @IsString({ message: 'contact 必须是字符串' })
  @Length(0, 64, { message: 'contact 长度不能超过 64 字符' })
  contact?: string;
}

// ============================================================================
// POST /admin/orders/{id}/refund（管理端）
// ============================================================================

export class AdminRefundBodyDto {
  @ApiPropertyOptional({
    description:
      '退款金额（整数分）。`refundType=FULL` 时可不传（自动等于可退金额）；' +
      '`PARTIAL` 时必传。**支持部分退款**（管理员权限高于用户侧）',
    example: 9900,
    minimum: 1,
  })
  @IsOptional()
  @IsInt({ message: 'refundAmount 必须是整数分' })
  @Min(1, { message: 'refundAmount 必须 > 0' })
  refundAmount?: number;

  @ApiPropertyOptional({
    description: '`FULL`（默认，自动等于可退金额）| `PARTIAL`（必须显式给 `refundAmount`）',
    enum: REFUND_TYPE_VALUES,
    default: 'FULL',
  })
  @IsOptional()
  @IsIn(REFUND_TYPE_VALUES, { message: `refundType 仅支持：${REFUND_TYPE_VALUES.join(', ')}` })
  refundType?: RefundTypeValue;

  @ApiProperty({
    description: '退款原因（**必填**，写入审计与微信备注）',
    minLength: 5,
    maxLength: 200,
    example: '用户投诉报告生成失败且多次重试无效，客服核实后全额退款',
  })
  @IsString({ message: 'reason 必须是字符串' })
  @Length(5, 200, { message: 'reason 长度需在 5–200 字符之间' })
  reason!: string;

  @ApiPropertyOptional({
    description: '是否撤销对应权益（默认 `true`；部分退款的补偿场景可传 `false`）',
    type: Boolean,
    default: true,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'revokeEntitlement 必须是布尔值' })
  revokeEntitlement?: boolean | string;

  @ApiPropertyOptional({ description: '是否通知用户（默认 `true`）', type: Boolean, default: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'notifyUser 必须是布尔值' })
  notifyUser?: boolean | string;

  @ApiPropertyOptional({ description: '内部备注（用户不可见）', maxLength: 500 })
  @IsOptional()
  @IsString({ message: 'internalNote 必须是字符串' })
  @Length(0, 500, { message: 'internalNote 长度不能超过 500 字符' })
  internalNote?: string;

  @ApiPropertyOptional({ description: '关联客服工单号', maxLength: 64, example: 'TK-20260214-0087' })
  @IsOptional()
  @IsString({ message: 'ticketId 必须是字符串' })
  @Length(0, 64, { message: 'ticketId 长度不能超过 64 字符' })
  ticketId?: string;
}

export class AdminRefundQueryDto {
  @ApiPropertyOptional({
    description:
      '`true` 时覆盖商品退款策略（如超 7 天仍退）。**必须在 `reason` 中说明理由**，' +
      '审计额外标记 `isForced: true`（契约 §3.14.6.3 规则 5）',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'force 必须是布尔值' })
  force?: boolean | string;
}
