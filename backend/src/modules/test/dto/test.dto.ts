/**
 * 测试模块 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.3
 * 校验分层：
 *   · 本文件负责**结构性校验**（类型、长度、枚举、格式）
 *   · **语义校验**（答案是否属于本试卷、值域是否符合该题题型）在 Service 中
 *     基于试卷快照完成 —— 因为只有那里才知道「这道题是 LIKERT5 还是 RANK」
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
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

import { PaginationQueryDto } from '../../../common/dto/api-response.dto';

/** 进入测试的来源（埋点用） */
export const TEST_SOURCES = ['HOME', 'TEST_CENTER', 'SHARE', 'INVITE', 'REPORT'] as const;
export type TestSource = (typeof TEST_SOURCES)[number];

/** 会话状态（与 Prisma TestSessionStatus 对齐，用于历史列表筛选） */
export const TEST_SESSION_STATUSES = [
  'CREATED',
  'IN_PROGRESS',
  'SUBMITTED',
  'SCORED',
  'REPORT_READY',
  'EXPIRED',
  'ABANDONED',
] as const;

/** 单批答案数量上限（契约 §3.3.5 错误码 40017） */
export const MAX_ANSWERS_PER_BATCH = 200;

/** 单题作答耗时上限（毫秒，10 分钟） */
export const MAX_RESPONSE_MS = 600_000;

// ============================================================================
// 测试定义
// ============================================================================

export class ListTestsQueryDto {
  @ApiPropertyOptional({
    description: '按类别筛选',
    enum: ['MBTI', 'BIG_FIVE', 'RELATIONSHIP_STYLE', 'COMPREHENSIVE'],
  })
  @IsOptional()
  @IsIn(['MBTI', 'BIG_FIVE', 'RELATIONSHIP_STYLE', 'COMPREHENSIVE'], {
    message: 'category 取值不合法',
  })
  category?: 'MBTI' | 'BIG_FIVE' | 'RELATIONSHIP_STYLE' | 'COMPREHENSIVE';
}

// ============================================================================
// 创建会话
// ============================================================================

export class CreateSessionDto {
  @ApiPropertyOptional({
    description: '若存在未过期的 IN_PROGRESS 会话则复用（不重新抽题、不重置进度）',
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'reuseInProgress 必须是布尔值' })
  reuseInProgress?: boolean;

  @ApiPropertyOptional({
    description: '强制新建会话；与 reuseInProgress 同时为 true 时本字段优先',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'forceNew 必须是布尔值' })
  forceNew?: boolean;

  @ApiPropertyOptional({
    description: '客户端时区（仅展示层提示，不参与业务判定）',
    example: 'Asia/Shanghai',
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'clientTimezone 必须是字符串' })
  @Length(1, 64, { message: 'clientTimezone 长度需在 1–64 之间' })
  clientTimezone?: string;

  @ApiPropertyOptional({ description: '进入来源埋点', enum: TEST_SOURCES, default: 'HOME' })
  @IsOptional()
  @IsIn(TEST_SOURCES, { message: `source 仅支持：${TEST_SOURCES.join(', ')}` })
  source?: TestSource;
}

// ============================================================================
// 获取会话（断点续答 / 分批取卷）
// ============================================================================

export class GetSessionQueryDto {
  @ApiPropertyOptional({
    description: '批次序号，从 1 开始；不传返回第 1 批',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'batch 必须是整数' })
  @Min(1, { message: 'batch 最小为 1' })
  batch?: number;
}

// ============================================================================
// 批量保存答案
// ============================================================================

export class AnswerItemDto {
  @ApiProperty({ description: '题目 ID（必须属于该会话试卷）', format: 'uuid' })
  @IsUUID('7', { message: 'questionId 必须是合法的 UUIDv7' })
  questionId!: string;

  @ApiProperty({
    description: '答案值。单选题传数字（LIKERT5 为 1–5，BINARY 为 0/1）；排序题传全部选项 value 的排列数组',
    oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }],
  })
  @Transform(({ value }: { value: unknown }) => value)
  value!: number | number[];

  @ApiPropertyOptional({ description: '本题作答耗时（毫秒）', minimum: 0, maximum: MAX_RESPONSE_MS })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'responseMs 必须是整数' })
  @Min(0, { message: 'responseMs 不能为负数' })
  @Max(MAX_RESPONSE_MS, { message: `responseMs 最大为 ${MAX_RESPONSE_MS}` })
  responseMs?: number;

  @ApiPropertyOptional({ description: '客户端作答时间（仅审计，服务端落自己的时间）', format: 'date-time' })
  @IsOptional()
  @IsDateString({ strict: false }, { message: 'answeredAt 必须是 ISO 8601 时间字符串' })
  answeredAt?: string;
}

export class SaveAnswersDto {
  @ApiProperty({
    description: `答案数组（1–${MAX_ANSWERS_PER_BATCH} 条）`,
    type: [AnswerItemDto],
    minItems: 1,
    maxItems: MAX_ANSWERS_PER_BATCH,
  })
  @IsArray({ message: 'answers 必须是数组' })
  @ArrayMinSize(1, { message: 'answers 不能为空数组' })
  @ArrayMaxSize(MAX_ANSWERS_PER_BATCH, { message: `单批答案不能超过 ${MAX_ANSWERS_PER_BATCH} 条` })
  @ValidateNested({ each: true })
  @Type(() => AnswerItemDto)
  answers!: AnswerItemDto[];

  @ApiPropertyOptional({
    description: '客户端草稿修订号（单调递增），用于乱序请求检测；不拒绝较小值，仅记录告警',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'clientRevision 必须是整数' })
  @Min(0, { message: 'clientRevision 不能为负数' })
  clientRevision?: number;
}

// ============================================================================
// 提交
// ============================================================================

export class SubmitSessionDto {
  @ApiProperty({
    description: '用户已确认提交（前端在二次确认弹窗后传 true）',
    example: true,
  })
  @IsBoolean({ message: 'confirm 必须是布尔值' })
  @IsIn([true], { message: '必须确认提交（confirm 需为 true）' })
  confirm!: boolean;

  @ApiPropertyOptional({
    description: '本次答题总耗时（毫秒），用于质量指标',
    minimum: 0,
    maximum: 3_600_000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'totalResponseMs 必须是整数' })
  @Min(0, { message: 'totalResponseMs 不能为负数' })
  @Max(3_600_000, { message: 'totalResponseMs 最大为 3600000' })
  totalResponseMs?: number;

  @ApiPropertyOptional({ description: '客户端提交时间（仅审计）', format: 'date-time' })
  @IsOptional()
  @IsDateString({ strict: false }, { message: 'clientSubmittedAt 必须是 ISO 8601 时间字符串' })
  clientSubmittedAt?: string;

  @ApiPropertyOptional({
    description: '是否从本地草稿恢复后提交（用于数据质量分析）',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'isDraftRestored 必须是布尔值' })
  isDraftRestored?: boolean;
}

// ============================================================================
// 历史列表
// ============================================================================

export class ListSessionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按状态筛选', enum: TEST_SESSION_STATUSES })
  @IsOptional()
  @IsIn(TEST_SESSION_STATUSES, { message: 'status 取值不合法' })
  status?: (typeof TEST_SESSION_STATUSES)[number];

  @ApiPropertyOptional({ description: '按测试定义编码筛选', example: 'MBTI_LITE', maxLength: 32 })
  @IsOptional()
  @IsString({ message: 'definitionCode 必须是字符串' })
  @Length(1, 32, { message: 'definitionCode 长度需在 1–32 之间' })
  definitionCode?: string;
}

// ============================================================================
// 路径参数
// ============================================================================

export class SessionIdParamDto {
  @ApiProperty({ description: '会话 ID', format: 'uuid' })
  @IsUUID('7', { message: '会话 ID 必须是合法的 UUIDv7' })
  id!: string;
}

export class TestCodeParamDto {
  @ApiProperty({ description: '测试定义编码', example: 'MBTI_LITE', maxLength: 32 })
  @IsString({ message: 'code 必须是字符串' })
  @Length(1, 32, { message: 'code 长度需在 1–32 之间' })
  code!: string;
}
