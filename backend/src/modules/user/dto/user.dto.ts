/**
 * 用户模块 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.2（用户 user）
 * 校验策略：全局 ValidationPipe 已开启 whitelist + forbidNonWhitelisted。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** `GET /users/me?include=` 支持的扩展块白名单 */
export const INCLUDE_BLOCKS = ['profile', 'membership', 'aiQuota', 'stats', 'consents'] as const;
export type IncludeBlock = (typeof INCLUDE_BLOCKS)[number];

/** 注销原因枚举（契约 §3.2.10） */
export const DELETION_REASONS = [
  'NO_LONGER_NEEDED',
  'PRIVACY_CONCERN',
  'POOR_EXPERIENCE',
  'COST_CONCERN',
  'OTHER',
] as const;
export type DeletionReason = (typeof DELETION_REASONS)[number];

/** 同意类型（与 Prisma ConsentType 对齐） */
export const CONSENT_TYPES = [
  'PRIVACY_POLICY',
  'TERMS_OF_SERVICE',
  'AGE_DECLARATION',
  'AI_CONTENT_NOTICE',
  'MARKETING',
] as const;
export type ConsentTypeValue = (typeof CONSENT_TYPES)[number];

/** 注销二次确认文本（必须精确匹配，防误操作） */
export const DELETION_CONFIRM_TEXT = '确认注销';

// ============================================================================
// GET /users/me
// ============================================================================

export class GetMeQueryDto {
  @ApiPropertyOptional({
    description: `逗号分隔的扩展块白名单：${INCLUDE_BLOCKS.join(' | ')}`,
    example: 'profile,membership,aiQuota,stats',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    // 允许 `?include=a,b` 与 `?include=a&include=b` 两种写法，统一为数组。
    // 仅处理字符串与非空字符串数组，其他类型原样返回交由 class-validator 报错
    // （不做隐式 String() 转换，避免把对象变成 '[object Object]' 这类无意义值）。
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
  })
  @ArrayUnique({ message: 'include 中不能有重复值' })
  @IsIn(INCLUDE_BLOCKS, { each: true, message: `include 仅支持：${INCLUDE_BLOCKS.join(', ')}` })
  include?: IncludeBlock[];
}

// ============================================================================
// PATCH /users/me
// ============================================================================

export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: '昵称（1–20 字符，trim 后非空；保存前会过内容安全检测）',
    example: '小满',
    nullable: true,
    minLength: 1,
    maxLength: 20,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'nickname 必须是字符串或 null' })
  @Length(1, 20, { message: '昵称长度需在 1–20 个字符之间' })
  nickname?: string | null;

  @ApiPropertyOptional({
    description: '性别；UNKNOWN 等价于清空',
    enum: ['MALE', 'FEMALE', 'UNKNOWN'],
    nullable: true,
  })
  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'UNKNOWN'], { message: 'gender 仅支持 MALE / FEMALE / UNKNOWN' })
  gender?: 'MALE' | 'FEMALE' | 'UNKNOWN' | null;

  @ApiPropertyOptional({
    description: '生日（YYYY-MM-DD，范围 1900-01-01 ~ 今天）；变更后可能影响 ageVerified',
    example: '1996-08-21',
    nullable: true,
  })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'birthday 必须是 YYYY-MM-DD 格式' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthday 必须是 YYYY-MM-DD 格式' })
  birthday?: string | null;

  @ApiPropertyOptional({
    description: '乐观锁版本号（来自上次 GET/PATCH 响应）；不传则「最后写入者胜」',
    example: 12,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'expectedVersion 必须是整数' })
  @Min(0, { message: 'expectedVersion 不能为负数' })
  expectedVersion?: number;
}

// ============================================================================
// 同意记录
// ============================================================================

export class SubmitConsentDto {
  @ApiProperty({ description: '同意类型', enum: CONSENT_TYPES, example: 'PRIVACY_POLICY' })
  @IsIn(CONSENT_TYPES, { message: `type 仅支持：${CONSENT_TYPES.join(', ')}` })
  type!: ConsentTypeValue;

  @ApiProperty({
    description: '协议版本号（由 GET /system/config 下发）；与当前服务端版本不一致会返回 30017',
    example: '2026-02-14',
    maxLength: 32,
  })
  @IsString({ message: 'policyVersion 必须是字符串' })
  @Length(1, 32, { message: 'policyVersion 长度需在 1–32 之间' })
  policyVersion!: string;

  @ApiProperty({ description: 'true = 同意；false = 撤回同意', example: true })
  @IsBoolean({ message: 'agreed 必须是布尔值' })
  agreed!: boolean;
}

// ============================================================================
// 账号注销
// ============================================================================

export class RequestDeletionDto {
  @ApiProperty({ description: '注销原因', enum: DELETION_REASONS, example: 'PRIVACY_CONCERN' })
  @IsIn(DELETION_REASONS, { message: `reason 仅支持：${DELETION_REASONS.join(', ')}` })
  reason!: DeletionReason;

  @ApiPropertyOptional({
    description: '补充说明（reason = OTHER 时必填）',
    example: '希望减少个人数据的留存',
    maxLength: 200,
  })
  @IsOptional()
  @IsString({ message: 'reasonDetail 必须是字符串' })
  @Length(0, 200, { message: 'reasonDetail 长度不能超过 200' })
  reasonDetail?: string;

  @ApiProperty({
    description: `二次确认文本，必须精确等于「${DELETION_CONFIRM_TEXT}」`,
    example: DELETION_CONFIRM_TEXT,
  })
  @IsString({ message: 'confirmText 必须是字符串' })
  @IsIn([DELETION_CONFIRM_TEXT], { message: `confirmText 必须精确等于「${DELETION_CONFIRM_TEXT}」` })
  confirmText!: string;

  @ApiProperty({ description: '确认已知晓「订单与支付记录法定保留 3 年」', example: true })
  @IsBoolean({ message: 'acknowledgeRetention 必须是布尔值' })
  @IsIn([true], { message: '必须确认已知晓数据保留说明' })
  acknowledgeRetention!: boolean;

  @ApiProperty({ description: '确认已知晓冷静期后不可恢复', example: true })
  @IsBoolean({ message: 'acknowledgeIrreversible 必须是布尔值' })
  @IsIn([true], { message: '必须确认已知晓注销不可恢复' })
  acknowledgeIrreversible!: boolean;
}

export class CancelDeletionDto {
  @ApiPropertyOptional({ description: '撤销原因（可选，用于产品分析）', example: '还想再体验一段时间', maxLength: 200 })
  @IsOptional()
  @IsString({ message: 'reason 必须是字符串' })
  @Length(0, 200, { message: 'reason 长度不能超过 200' })
  reason?: string;
}

// ============================================================================
// 数据导出（任务状态存 Redis；见 ADR-024）
// ============================================================================

export class RequestExportDto {
  @ApiPropertyOptional({
    description: '导出范围，默认全量',
    enum: ['ALL', 'PROFILE', 'REPORTS', 'CONVERSATIONS'],
    default: 'ALL',
  })
  @IsOptional()
  @IsIn(['ALL', 'PROFILE', 'REPORTS', 'CONVERSATIONS'], { message: 'scope 取值不合法' })
  scope?: 'ALL' | 'PROFILE' | 'REPORTS' | 'CONVERSATIONS';
}

/**
 * 导出任务的合法状态（契约 §3.2.8「状态枚举」）
 *
 * 用 `SUCCEEDED` 而非 `READY`：该字段会直接下发给前端做分支判断，
 * 必须与接口契约逐字一致，否则客户端解析不到成功态。
 */
export const EXPORT_TASK_STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED'] as const;
export type ExportTaskStatus = (typeof EXPORT_TASK_STATUSES)[number];

/** 导出阶段（契约 §3.2.8，用于进度展示与排障） */
export const EXPORT_TASK_STAGES = [
  'QUEUED',
  'COLLECTING',
  'RENDERING_JSON',
  'UPLOADING',
  'DONE',
  'ERROR',
  'EXPIRED',
] as const;
export type ExportTaskStage = (typeof EXPORT_TASK_STAGES)[number];

/** 导出文件条目 */
export interface ExportFileEntry {
  format: 'JSON' | 'PDF';
  fileName: string;
  sizeBytes: number;
  /** OSS 签名下载地址（有效期 24h，契约 §3.2.7 规则 3） */
  downloadUrl: string;
  expiresAt: string;
}

/**
 * 导出任务状态（存于 Redis，见 ADR-024「短生命周期任务状态不落库」）
 *
 * 为什么不建表：任务状态天然临时（源文件 7 天、签名 URL 24h 有效），
 * 生命周期与 Redis TTL 语义契合；为它引入表 + 迁移 + 归档作业收益不匹配。
 */
export interface ExportTaskState {
  taskId: string;
  userId: string;
  scope: string;
  status: ExportTaskStatus;
  stage: ExportTaskStage;
  progress: number;
  files: ExportFileEntry[];
  errorMessage: string | null;
  requestedAt: string;
  finishedAt: string | null;
  /** 源文件在 OSS 的保留截止时间（7 天），到期即 `EXPIRED` */
  expiresAt: string;
}

export class ExportTaskParamDto {
  @ApiProperty({ description: '导出任务 ID（UUID v7）', example: '0195f3a2-4be1-7d1f-9e8a-a6db3e4f5c3e' })
  @IsString({ message: 'taskId 必须是字符串' })
  @Length(36, 36, { message: 'taskId 必须是 36 位 UUID' })
  taskId!: string;
}

/** 用于校验分页/数量等整数参数的通用上限（避免超大 pageSize 打爆数据库） */
export const MAX_PAGE_SIZE = 100;

export class CountLimitDto {
  @ApiPropertyOptional({ description: '返回条数上限', default: 20, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit 必须是整数' })
  @Min(1, { message: 'limit 最小为 1' })
  @Max(MAX_PAGE_SIZE, { message: `limit 最大为 ${MAX_PAGE_SIZE}` })
  limit?: number;
}

// ============================================================================
// POST /users/me/avatar
// ============================================================================

/** 头像大小上限（2MB，与 AVATAR 场景策略一致） */
export const AVATAR_MAX_BYTES = 2097152;

/** 头像边长上限（契约 §3.2.3） */
export const AVATAR_MAX_DIMENSION = 4096;

/**
 * 上传头像（登记已直传至 OSS 的对象）
 *
 * 本接口**不接收文件二进制**：真实流程是「申请票据 → 客户端直传 OSS → 用本接口登记」。
 * `objectKey` 与 `isDefault` 至少提供一个（跨字段约束在 Service 中校验，
 * 与 `BindPhoneDto` 同一处理方式）。
 */
export class UpdateAvatarDto {
  @ApiPropertyOptional({
    description: '由 `POST /storage/upload-ticket` 返回的对象键；必须以 `avatar/{userId}/` 开头',
    example: 'avatar/0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70/20260214_a7c3f9e1b2d4c6a8.webp',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  objectKey?: string;

  @ApiPropertyOptional({
    description: 'OSS 返回的 ETag（服务端用于二次确认对象版本）',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  etag?: string;

  @ApiPropertyOptional({
    description: '文件字节数；仅用于提前拒绝，**权威值以 OSS HEAD 结果为准**',
    minimum: 1,
    maximum: AVATAR_MAX_BYTES,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(AVATAR_MAX_BYTES)
  size?: number;

  @ApiPropertyOptional({ description: '图片宽度（前端 getImageInfo 取得）', minimum: 1, maximum: AVATAR_MAX_DIMENSION })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(AVATAR_MAX_DIMENSION)
  width?: number;

  @ApiPropertyOptional({ description: '图片高度（前端 getImageInfo 取得）', minimum: 1, maximum: AVATAR_MAX_DIMENSION })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(AVATAR_MAX_DIMENSION)
  height?: number;

  @ApiPropertyOptional({
    description: '是否改用系统默认头像（`true` 时忽略 `objectKey`，不触碰 OSS）',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

// ============================================================================
// POST /users/me/phone
// ============================================================================

/** 手机号授权来源（契约 §3.2.4，用于埋点与合规记录） */
export const PHONE_SOURCES = ['BUTTON', 'PROFILE'] as const;
export type PhoneSource = (typeof PHONE_SOURCES)[number];

/**
 * 绑定手机号
 *
 * 跨字段约束（`code` 与 `encryptedData` 至少一个、`encryptedData` 必须配 `iv`）
 * **不在此处校验**：class-validator 表达「至少其一」需要自定义装饰器，
 * 而放在 Service 里能用明确的中文文案与统一错误码拒绝，且可被单测直接覆盖。
 */
export class BindPhoneDto {
  @ApiPropertyOptional({
    description: '`getPhoneNumber` 新版返回的动态令牌（**推荐**，服务端调微信换取号码）',
    example: 'e9a1c7f2b3d84e6a9c0f1b2d3e4a5f60',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  code?: string;

  @ApiPropertyOptional({
    description: '旧版加密数据（base64）；与 `iv` 成对出现，且需要有效的 `session_key`',
    maxLength: 4096,
  })
  @IsOptional()
  @IsString()
  @Length(1, 4096)
  encryptedData?: string;

  @ApiPropertyOptional({
    description: '旧版加密向量（base64，16 字节 ≈ 24 字符）',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  iv?: string;

  @ApiPropertyOptional({ enum: PHONE_SOURCES, description: '授权来源', default: 'BUTTON' })
  @IsOptional()
  @IsIn(PHONE_SOURCES, { message: 'source 必须是 BUTTON 或 PROFILE' })
  source?: PhoneSource;
}
