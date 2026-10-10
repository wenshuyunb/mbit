/**
 * 存储模块 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.10（存储 storage）
 * 校验策略：全局 ValidationPipe 已开启 whitelist + forbidNonWhitelisted。
 *
 * 分工说明：DTO 只做**形状与粗粒度白名单**校验（枚举、长度、数值区间），
 * 「扩展名与 MIME 是否同族」「场景是否开放」「文件是否超场景上限」等
 * 语义校验在 `storage.util.ts` 中完成 —— 那里有独立单测，且错误码更精确。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { ALL_UPLOAD_MIME_TYPES } from '../storage-policy';
import { STORAGE_SCENES, type StorageScene } from '../storage.types';

/** 签名 URL 有效期下限（秒） */
export const SIGN_URL_MIN_TTL = 60;

/** 签名 URL 有效期上限（秒）—— 契约 §3.10.2 规则 2「绝不签发长期 URL」 */
export const SIGN_URL_MAX_TTL = 3600;

/** 单次批量签名的对象数上限（契约 §3.10.2） */
export const SIGN_URL_MAX_BATCH = 20;

/**
 * OSS 图片处理参数白名单
 *
 * 该参数会被原样拼进 `x-oss-process`，因此必须限制字符集：
 * 一旦允许 `&` 或 `#`，就能在 URL 中追加参数、篡改签名覆盖范围。
 */
const PROCESS_PATTERN = /^[A-Za-z0-9_\-/,=.]+$/;

/**
 * 下载文件名提示的字符白名单
 *
 * 允许 `attachment; filename="report.pdf"` 这类合法形态，
 * 但拒绝 CR/LF —— 该值会进入响应头，注入换行等于响应头注入（CRLF injection）。
 */
const CONTENT_DISPOSITION_PATTERN = /^[A-Za-z0-9 _\-.,;=/"'()]+$/;

// ============================================================================
// POST /storage/upload-ticket
// ============================================================================

export class UploadTicketDto {
  @ApiProperty({
    enum: STORAGE_SCENES,
    description: '上传场景，决定路径前缀、大小上限与类型白名单',
    example: 'AVATAR',
  })
  @IsIn(STORAGE_SCENES, { message: 'scene 不在允许的场景枚举内' })
  scene!: StorageScene;

  @ApiProperty({
    description: '原始文件名（服务端**仅取扩展名**用于校验，对象名会重命名为 UUID）',
    example: 'avatar_temp_20260214.jpg',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @Length(1, 128)
  fileName!: string;

  @ApiProperty({
    enum: ALL_UPLOAD_MIME_TYPES,
    description: '声明的媒体类型（服务端仍会用魔数二次校验）',
    example: 'image/jpeg',
  })
  @IsIn(ALL_UPLOAD_MIME_TYPES, { message: 'mimeType 不在允许的白名单内' })
  mimeType!: string;

  @ApiProperty({
    description: '文件字节数（前端 `uni.getFileInfo` 获取）',
    example: 186420,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  size!: number;

  @ApiPropertyOptional({
    description: '文件 MD5（32 位十六进制）；提供时 OSS 会校验完整性',
    example: '7f3a91c24b8e4d1f9a026c5e8b7d1f30',
  })
  @IsOptional()
  @Matches(/^[a-fA-F0-9]{32}$/, { message: 'md5 必须为 32 位十六进制' })
  md5?: string;
}

// ============================================================================
// POST /storage/sign-url
// ============================================================================

export class SignUrlDto {
  @ApiProperty({
    description: `待签名的对象键列表（1–${SIGN_URL_MAX_BATCH} 个，每项 1–200 字符）`,
    type: [String],
    example: ['avatar/0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70/20260214_a7c3f9e1b2d4c6a8.webp'],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'objectKeys 不能为空数组' })
  @ArrayMaxSize(SIGN_URL_MAX_BATCH, { message: `objectKeys 最多 ${SIGN_URL_MAX_BATCH} 个` })
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  objectKeys!: string[];

  @ApiPropertyOptional({
    description: `有效期（秒），${SIGN_URL_MIN_TTL}–${SIGN_URL_MAX_TTL}，默认 900（15 分钟）`,
    example: 900,
    minimum: SIGN_URL_MIN_TTL,
    maximum: SIGN_URL_MAX_TTL,
  })
  @IsOptional()
  @IsInt()
  @Min(SIGN_URL_MIN_TTL, { message: `expiresInSeconds 不得小于 ${SIGN_URL_MIN_TTL}` })
  @Max(SIGN_URL_MAX_TTL, { message: `expiresInSeconds 不得超过 ${SIGN_URL_MAX_TTL}` })
  expiresInSeconds?: number;

  @ApiPropertyOptional({
    description: 'OSS 图片处理参数（如 `image/resize,w_240/format,webp`）',
    example: 'image/resize,w_240/format,webp',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Matches(PROCESS_PATTERN, { message: 'process 含非法字符' })
  process?: string;

  @ApiPropertyOptional({
    description: '下载时的文件名提示（如 `attachment; filename="report.pdf"`）',
    example: 'attachment; filename="report.pdf"',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  @Matches(CONTENT_DISPOSITION_PATTERN, {
    message: 'responseContentDisposition 含非法字符（禁止换行）',
  })
  responseContentDisposition?: string;
}

// ============================================================================
// POST /storage/callback
// ============================================================================

/**
 * OSS 上传回调请求体（契约 §3.10.3）
 *
 * 字段由我们签发票据时下发的 `callbackBody` 模板决定，因此结构可控；
 * 但**内容一律不可信** —— 请求来自公网，`objectKey`/`mimeType`/`size` 都可能被伪造。
 * 验签通过前不得使用任何字段（Service 中验签排在所有校验之前）。
 *
 * 该接口的失败响应走统一包络（非 2xx），而非契约示意图中的 `{Status:'FAIL'}`：
 * OSS 只要求非 200 即判定上传失败，保留包络能让错误码进入日志与监控。
 */
export class StorageCallbackDto {
  @ApiProperty({
    description: '对象键（`${object}` 模板变量）',
    example: 'avatar/0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70/20260214_a7c3f9e1b2d4c6a8.webp',
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  objectKey!: string;

  @ApiProperty({ description: '对象 ETag', example: 'F1A2B3C4D5E6F708192A3B4C5D6E7F80' })
  @IsString()
  @Length(8, 64)
  etag!: string;

  @ApiProperty({ description: '文件字节数', example: 86420, minimum: 1 })
  @IsInt()
  @Min(1)
  size!: number;

  @ApiProperty({ description: 'OSS 探测的媒体类型', example: 'image/webp', maxLength: 64 })
  @IsString()
  @Length(1, 64)
  mimeType!: string;

  @ApiPropertyOptional({ description: 'Bucket 名（多桶场景校验用）', maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  bucket?: string;

  @ApiPropertyOptional({ description: '区域', maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  region?: string;
}
