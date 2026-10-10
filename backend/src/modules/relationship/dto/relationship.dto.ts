/**
 * 关系模块 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.6（关系 relationship）
 * 校验策略：全局 ValidationPipe 已开启 whitelist + forbidNonWhitelisted，
 * 因此**未声明的字段会被直接拒绝**（400），不会静默丢弃。
 *
 * 分工说明：DTO 只做**形状与粗粒度白名单**校验（枚举、长度、UUID 形态），
 * 「邀请码是否合法字符集」「关系归属是否属于当前用户」等语义校验在
 * `relationship.util.ts` / `relationship.service.ts` 中完成 —— 那里有独立单测，
 * 且错误码更精确（如邀请码非法要区分「格式错」与「不存在」）。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

/** 关系类型（与 Prisma `RelationshipType` 一致） */
export const RELATIONSHIP_TYPES = ['COUPLE', 'FRIEND', 'FAMILY'] as const;

/** 关系类型取值 */
export type RelationshipTypeValue = (typeof RELATIONSHIP_TYPES)[number];

/**
 * 分享渠道（与 Prisma `ShareChannel` 一致）
 *
 * **必须在这里白名单校验**：`channel` 会直接写进 `relationship_invites.channel`
 * （一个 PG 枚举列）。此前 Service 用 `input.channel as never` 绕过类型检查，
 * 于是前端传任意字符串（如 `"wechat"`）都能通过编译，却在 Prisma 写入时
 * 抛底层枚举错误 → **500**。枚举值必须在 HTTP 边界上拦掉，错误码才是可控的 400。
 */
export const SHARE_CHANNELS = [
  'WECHAT_SESSION',
  'WECHAT_TIMELINE',
  'MINIAPP_CODE',
  'POSTER',
  'QRCODE',
  'COPY_LINK',
] as const;

/** 分享渠道取值 */
export type ShareChannelValue = (typeof SHARE_CHANNELS)[number];

/**
 * 解除原因（契约 §3.6.7 的 `reason` 枚举）
 *
 * 用固定枚举而非自由文本：该值会进入运营统计（"用户为什么解除关系"），
 * 自由文本无法聚合；用户想补充说明时应走反馈渠道而非塞进这里。
 */
export const REMOVAL_REASONS = ['NO_LONGER_NEEDED', 'MISTAKE', 'PRIVACY', 'OTHER'] as const;

/** 解除原因取值 */
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

/** 邀请短码长度（与 `INVITE_CODE_LENGTH` 一致，契约 §3.6.1） */
const INVITE_CODE_LENGTH = 8;

/**
 * `message` / `acceptMessage` / `displayName` / `inviteeName` 的长度上限
 * （契约 §3.6.1 / §3.6.3）
 *
 * 这些字段会展示在**对方**的界面上，因此必须限长：不限长时一条超长消息会撑破
 * 邀请卡片的布局，而这是唯一一处「陌生人可以向我投递文本」的入口。
 */
const MESSAGE_MAX_LENGTH = 60;

// ============================================================================
// POST /relationships/invites
// ============================================================================

export class CreateInviteDto {
  @ApiProperty({
    enum: RELATIONSHIP_TYPES,
    description: '关系类型。`COUPLE` 会额外校验双方年龄（≥18）与功能开关',
    example: 'COUPLE',
  })
  @IsIn(RELATIONSHIP_TYPES, { message: 'relationType 必须是 COUPLE / FRIEND / FAMILY' })
  relationType!: RelationshipTypeValue;

  @ApiPropertyOptional({
    description: `邀请留言（对方向你展示，最多 ${MESSAGE_MAX_LENGTH} 字）`,
    example: '一起做个测试看看我们有多合拍吧',
    maxLength: MESSAGE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(0, MESSAGE_MAX_LENGTH, { message: `message 不得超过 ${MESSAGE_MAX_LENGTH} 字` })
  message?: string;

  @ApiPropertyOptional({
    enum: SHARE_CHANNELS,
    description: '分享渠道（写入 `share_channel` 枚举列，用于裂变归因）',
    example: 'MINIAPP_CODE',
  })
  @IsOptional()
  @IsIn(SHARE_CHANNELS, {
    message: `channel 必须是 ${SHARE_CHANNELS.join(' / ')} 之一`,
  })
  channel?: ShareChannelValue;
}

// ============================================================================
// POST /relationships/invites/{code}/accept
// ============================================================================

/**
 * 接受邀请请求体
 *
 * **刻意留空**：契约 §3.6.3 定义了 `confirmTestCode` / `displayName` /
 * `acceptMessage` 三个字段，但数据模型里**没有任何列可以承载后两者** ——
 * `relationships` 表没有 `display_name_a` / `display_name_b`，
 * `relationship_invites` 表也没有存放接受方留言的列。
 *
 * 空 DTO 配合全局 `forbidNonWhitelisted`，会让**任何**请求体字段都返回 400。
 * 这是有意选择：另一种写法是「接受并校验，然后丢掉」，那会让前端收到 200、
 * 以为设置生效，而用户填的称呼与留言凭空消失 —— 这种静默丢弃是最难排查的一类
 * 缺陷。宁可现在报错，也不要假装支持。
 *
 * 待补列（需先改 `DATABASE_DESIGN.md` 并加迁移）后，在此处加入字段即可。
 */
export class AcceptInviteDto {}

// ============================================================================
// POST /relationships/{id}/confirm
// ============================================================================

export class ConfirmRelationshipDto {
  @ApiPropertyOptional({
    description: '确认后是否自动触发匹配报告。缺省 `true`（`compatibility.calc` 队列接入前不产生副作用）',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoGenerateReport?: boolean;
}

// ============================================================================
// DELETE /relationships/{id}（查询参数）
// ============================================================================

export class RemoveRelationshipQueryDto {
  @ApiPropertyOptional({
    enum: REMOVAL_REASONS,
    description: '解除原因（进入运营统计，故用枚举而非自由文本）',
    example: 'NO_LONGER_NEEDED',
    default: 'NO_LONGER_NEEDED',
  })
  @IsOptional()
  @IsIn(REMOVAL_REASONS, { message: 'reason 必须是 NO_LONGER_NEEDED / MISTAKE / PRIVACY / OTHER' })
  reason?: RemovalReason;

  @ApiPropertyOptional({
    description: '是否保留历史匹配报告（`false` 仅对双方隐藏，**不物理删除**，审计仍留存）',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  keepHistory?: boolean;
}

// ============================================================================
// 路径参数
// ============================================================================

export class InviteCodeParamDto {
  @ApiProperty({
    description: `邀请短码（${INVITE_CODE_LENGTH} 位 Crockford Base32，大小写不敏感）`,
    example: 'K7M2XQ9V',
    minLength: INVITE_CODE_LENGTH,
    maxLength: INVITE_CODE_LENGTH,
  })
  @IsString()
  @Length(INVITE_CODE_LENGTH, INVITE_CODE_LENGTH, {
    message: `邀请码必须为 ${INVITE_CODE_LENGTH} 位`,
  })
  code!: string;
}

/**
 * 关系 ID 路径参数
 *
 * 用 `@IsUUID()` 而非直接查库：非法 UUID 进到 `findFirst` 会让 Prisma 抛
 * 底层校验错误 → 500。在边界上拦掉，错误码才是可控的 `PARAM_INVALID`。
 */
export class RelationshipIdParamDto {
  @ApiProperty({
    description: '关系 ID（UUID v7）',
    example: '0195f3a2-d46a-7ca8-8d13-9fca6d7e8b67',
    format: 'uuid',
  })
  @IsUUID(undefined, { message: '关系 ID 必须是合法 UUID' })
  relationshipId!: string;
}

// ============================================================================
// GET /relationships
// ============================================================================

/** 状态筛选白名单（与 Prisma `RelationshipStatus` 一致，ADR-030 对齐后为 5 个值） */
export const RELATIONSHIP_STATUS_FILTERS = ['PENDING_A_CONFIRM', 'ACTIVE', 'REJECTED', 'EXPIRED', 'REMOVED'] as const;

/** 状态筛选取值 */
export type RelationshipStatusFilter = (typeof RELATIONSHIP_STATUS_FILTERS)[number];

/** 排序字段白名单（契约 §3.6.4） */
export const RELATIONSHIP_SORT_FIELDS = ['createdAt', 'activatedAt'] as const;

/** 排序字段取值 */
export type RelationshipSortField = (typeof RELATIONSHIP_SORT_FIELDS)[number];

/** 每页条数上限（契约 §3.6.4：`pageSize ≤ 100`） */
const MAX_PAGE_SIZE = 100;

/**
 * 逗号分隔的多值参数 → 数组
 *
 * 契约把 `status` / `relationType` 定义为「逗号分隔枚举」。全局 ValidationPipe
 * 开了 `enableImplicitConversion`，若不先转换，`@IsIn(..., { each: true })` 会把
 * 整个字符串 `'ACTIVE,PENDING_A_CONFIRM'` 当作单个值 → 误判为非法枚举。
 */
const splitCommaSeparated = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
};

export class ListRelationshipsQueryDto {
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
    enum: RELATIONSHIP_STATUS_FILTERS,
    isArray: true,
    description:
      '关系状态，逗号分隔多选（如 `ACTIVE,PENDING_A_CONFIRM`）。**不传时只返回 ACTIVE 与 PENDING_A_CONFIRM** —— 这不是"不筛选"，而是避免历史记录淹没首屏',
    example: 'ACTIVE',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(RELATIONSHIP_STATUS_FILTERS, { each: true, message: 'status 含非法枚举值' })
  status?: RelationshipStatusFilter[];

  @ApiPropertyOptional({
    enum: RELATIONSHIP_TYPES,
    isArray: true,
    description: '关系类型，逗号分隔多选；不传则不限类型',
    example: 'COUPLE',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(RELATIONSHIP_TYPES, { each: true, message: 'relationType 含非法枚举值' })
  relationType?: RelationshipTypeValue[];

  @ApiPropertyOptional({
    enum: RELATIONSHIP_SORT_FIELDS,
    description: '排序字段（白名单，越界返回 `10004`）',
    example: 'createdAt',
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(RELATIONSHIP_SORT_FIELDS, { message: 'sortBy 不在允许的排序字段内' })
  sortBy?: RelationshipSortField;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    description: '排序方向',
    example: 'desc',
    default: 'desc',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'order 必须是 asc 或 desc' })
  order?: 'asc' | 'desc';
}
