/**
 * 通知模块 DTO（契约 §3.11）
 *
 * 校验策略与项目其余模块一致：全局 `ValidationPipe` 开启 `whitelist` +
 * `forbidNonWhitelisted`，未声明的字段直接 400，不会静默丢弃。
 *
 * ## 错误码映射（契约码 → 本项目实际返回码）
 *
 * 契约 §3.11.1/§3.11.2/§3.11.3 用了一批**本项目没有**的码（`10004` / `10005` /
 * `10016`），而已有的 `10004` / `10005` 含义分别是「方法不允许」「请求体过大」，
 * 直接复用会把「`sortBy` 不在白名单」变成 405、「`pageSize > 100`」变成 413。
 * 错误码是对外契约（客户端按码分支），因此按项目既定做法统一映射：
 *
 * | 契约码 | HTTP | 触发条件              | 本项目返回                                  |
 * | ------ | ---- | --------------------- | ------------------------------------------- |
 * | 10001  | 400  | `status`/`type` 非法  | `10001 PARAM_INVALID`（400）                |
 * | 10004  | 400  | `sortBy` 不在白名单   | `10001 PARAM_INVALID`（400，语义最接近）    |
 * | 10005  | 400  | `pageSize > 100`      | `10001 PARAM_INVALID`（400）                |
 * | 10002  | 400  | `ids`/`all` 均未提供  | `10001 PARAM_INVALID`（400）                |
 * | 10003  | 400  | 数组含非法 UUID       | `10001 PARAM_INVALID`（400）                |
 * | 10016  | 400  | 数组长度超限          | `10001 PARAM_INVALID`（400）                |
 * | 10010  | 429  | 超出限流              | 由 `ThrottlerGuard` 统一返回（429）         |
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  NOTIFICATION_CATEGORIES,
  SUBSCRIPTION_RESULTS,
  SUBSCRIPTION_SCENES,
  type NotificationCategory,
  type SubscriptionResult,
  type SubscriptionScene,
} from '../notification.util';

/** 读取状态筛选（契约 §3.11.1 的 `status`；`UNREAD` 为默认值） */
export const NOTIFICATION_READ_STATUSES = ['UNREAD', 'READ', 'ALL'] as const;

export type NotificationReadStatus = (typeof NOTIFICATION_READ_STATUSES)[number];

/** 排序字段白名单（契约 §3.11.1 的 `sortBy`） */
export const NOTIFICATION_SORT_FIELDS = ['createdAt', 'readAt'] as const;

export type NotificationSortField = (typeof NOTIFICATION_SORT_FIELDS)[number];

/** 每页条数上限（契约 §3.11.1：`pageSize ≤ 100`） */
export const MAX_PAGE_SIZE = 100;

/** 单次批量标记的上限（契约 §3.11.2：`notificationIds` 长度 1–100） */
export const MAX_READ_IDS = 100;

/** 单次上报的授权条数上限（契约 §3.11.3：`subscriptions` 长度 1–10） */
export const MAX_SUBSCRIPTIONS = 10;

/** 订阅模板 ID 长度区间（契约 §3.11.3：8–128） */
const TEMPLATE_ID_MIN_LENGTH = 8;
const TEMPLATE_ID_MAX_LENGTH = 128;

/** `clientRequestId` 长度区间（契约 §3.11.3：8–64） */
const CLIENT_REQUEST_ID_MIN_LENGTH = 8;
const CLIENT_REQUEST_ID_MAX_LENGTH = 64;

/**
 * 逗号分隔的多值参数 → 数组
 *
 * 全局 `ValidationPipe` 开了 `enableImplicitConversion`，若不先转换，
 * `@IsIn(..., { each: true })` 会把整个字符串 `'REPORT_READY,MEMBERSHIP'`
 * 当成单个值 → 误判为非法枚举。
 */
const splitCommaSeparated = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
};

// ============================================================================
// GET /notifications
// ============================================================================

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'page 不得小于 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，最大 ${MAX_PAGE_SIZE}`,
    example: 20,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'pageSize 不得小于 1' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize 不得超过 ${MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({
    enum: NOTIFICATION_READ_STATUSES,
    description: '读取状态筛选，默认 `UNREAD`（未读优先，前端红点场景最常用）',
    example: 'UNREAD',
    default: 'UNREAD',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_READ_STATUSES, { message: 'status 必须是 UNREAD / READ / ALL' })
  status?: NotificationReadStatus;

  @ApiPropertyOptional({
    enum: NOTIFICATION_CATEGORIES,
    isArray: true,
    description: '业务类型，逗号分隔多选（如 `REPORT_READY,MEMBERSHIP`）',
    example: 'REPORT_READY',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(NOTIFICATION_CATEGORIES, { each: true, message: 'type 含非法枚举值' })
  type?: NotificationCategory[];

  @ApiPropertyOptional({
    enum: NOTIFICATION_SORT_FIELDS,
    description: '排序字段（白名单，越界由全局 ValidationPipe 返回 400）',
    example: 'createdAt',
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_SORT_FIELDS, { message: 'sortBy 不在允许的排序字段内' })
  sortBy?: NotificationSortField;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    description: '排序方向，默认 `desc`（新通知在前）',
    example: 'desc',
    default: 'desc',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'order 必须是 asc 或 desc' })
  order?: 'asc' | 'desc';
}

// ============================================================================
// POST /notifications/read
// ============================================================================

/**
 * 标记已读请求体
 *
 * `notificationIds` 与 `all` 为**二选一**（契约 §3.11.2）。两者都未提供时由
 * Service 抛 `10001 PARAM_INVALID`（400）—— 不能用 class-validator 的互斥校验，
 * 因为「都传了」不是错误（此时以 `all` 为准，见 Service 注释）。
 */
export class MarkNotificationsReadDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: `待标记的通知 ID 列表，长度 1–${MAX_READ_IDS}；与 \`all: true\` 二选一`,
    example: ['0195f3a2-c1a8-7e20-9f35-5c6d7e8f9a0b'],
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'notificationIds 不得为空数组' })
  @ArrayMaxSize(MAX_READ_IDS, { message: `notificationIds 长度不得超过 ${MAX_READ_IDS}` })
  @IsUUID(undefined, { each: true, message: 'notificationIds 含非法 UUID' })
  notificationIds?: string[];

  @ApiPropertyOptional({
    description: '是否标记全部未读为已读（默认 `false`）',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @ApiPropertyOptional({
    enum: NOTIFICATION_CATEGORIES,
    description: '当 `all: true` 时按业务类型批量标记（不传则全部类型）',
    example: 'REPORT_READY',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_CATEGORIES, { message: 'type 含非法枚举值' })
  type?: NotificationCategory;
}

// ============================================================================
// POST /notifications/subscribe
// ============================================================================

export class SubscribeItemDto {
  @ApiProperty({
    description: `订阅消息模板 ID（微信后台配置，长度 ${TEMPLATE_ID_MIN_LENGTH}–${TEMPLATE_ID_MAX_LENGTH}）。服务端会与 \`scene\` 映射的权威模板核对`,
    example: 'TMPL_REPORT_READY_9a3f2c',
  })
  @IsString()
  @Length(TEMPLATE_ID_MIN_LENGTH, TEMPLATE_ID_MAX_LENGTH, {
    message: `templateId 长度需在 ${TEMPLATE_ID_MIN_LENGTH}–${TEMPLATE_ID_MAX_LENGTH} 之间`,
  })
  templateId!: string;

  @ApiProperty({
    enum: SUBSCRIPTION_SCENES,
    description: '业务场景（服务端据此映射权威模板 ID，防止客户端传错）',
    example: 'REPORT_READY',
  })
  @IsIn(SUBSCRIPTION_SCENES, { message: `scene 必须是 ${SUBSCRIPTION_SCENES.join(' / ')} 之一` })
  scene!: SubscriptionScene;

  @ApiProperty({
    enum: SUBSCRIPTION_RESULTS,
    description: '用户选择结果；`BAN` 表示被微信后台封禁',
    example: 'ACCEPT',
  })
  @IsIn(SUBSCRIPTION_RESULTS, { message: 'result 必须是 ACCEPT / REJECT / BAN' })
  result!: SubscriptionResult;
}

export class SubscribeNotificationsDto {
  @ApiProperty({
    type: [SubscribeItemDto],
    description: `授权结果数组，长度 1–${MAX_SUBSCRIPTIONS}`,
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'subscriptions 不得为空' })
  @ArrayMaxSize(MAX_SUBSCRIPTIONS, { message: `subscriptions 长度不得超过 ${MAX_SUBSCRIPTIONS}` })
  @ValidateNested({ each: true })
  @Type(() => SubscribeItemDto)
  subscriptions!: SubscribeItemDto[];

  @ApiPropertyOptional({
    description: `本次授权的客户端请求 ID（去重与审计），长度 ${CLIENT_REQUEST_ID_MIN_LENGTH}–${CLIENT_REQUEST_ID_MAX_LENGTH}`,
    example: 'sub_req_a71f3c9e2b04',
  })
  @IsOptional()
  @IsString()
  @Length(CLIENT_REQUEST_ID_MIN_LENGTH, CLIENT_REQUEST_ID_MAX_LENGTH, {
    message: `clientRequestId 长度需在 ${CLIENT_REQUEST_ID_MIN_LENGTH}–${CLIENT_REQUEST_ID_MAX_LENGTH} 之间`,
  })
  clientRequestId?: string;
}
