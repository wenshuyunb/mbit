/**
 * 人格画像模块 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.4
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/api-response.dto';

/** 成长曲线指标族 */
export const SNAPSHOT_METRICS = ['BIG_FIVE', 'CONFIDENCE', 'MBTI_DIMENSIONS'] as const;
/** 时间范围 */
export const SNAPSHOT_RANGES = ['30D', '90D', '180D', '365D', 'ALL'] as const;
/** 聚合粒度 */
export const SNAPSHOT_GRANULARITIES = ['RAW', 'WEEK', 'MONTH'] as const;

/** 大五维度键（用于 dimension 参数校验） */
export const BIG_FIVE_DIMENSION_KEYS = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
] as const;
/** MBTI 维度键 */
export const MBTI_DIMENSION_KEYS = ['EI', 'SN', 'TF', 'JP'] as const;

/** 合法的 4 字母类型：每维取值受限，天然排除 ISTR 这类非法组合 */
const MBTI_PATTERN = /^[EI][SN][TF][JP]$/i;

// ============================================================================
// GET /personality/me
// ============================================================================

export class GetProfileQueryDto {
  @ApiPropertyOptional({
    description: '指定历史版本号；不传返回最新版本',
    minimum: 1,
    example: 3,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'version 必须是整数' })
  @Min(1, { message: 'version 最小为 1' })
  version?: number;

  @ApiPropertyOptional({
    description: '是否附带与上一版本的对比（无上一版本时 trend 为 null）',
    default: true,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    // query 参数是字符串，需显式转换；仅接受 'true'/'false'，其他值交给校验器报错
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean({ message: 'includeTrend 必须是布尔值' })
  includeTrend?: boolean;
}

// ============================================================================
// GET /personality/me/history
// ============================================================================

export class ListProfileHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按算法版本筛选', example: 'pe-v1.0.0', maxLength: 16 })
  @IsOptional()
  @IsString({ message: 'engineVersion 必须是字符串' })
  @Length(1, 16, { message: 'engineVersion 长度需在 1–16 之间' })
  engineVersion?: string;

  @ApiPropertyOptional({ description: '排序字段', enum: ['version', 'generatedAt'], default: 'version' })
  @IsOptional()
  @IsIn(['version', 'generatedAt'], { message: 'sortBy 仅支持 version / generatedAt' })
  sortBy?: 'version' | 'generatedAt';

  @ApiPropertyOptional({ description: '排序方向', enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'order 仅支持 asc / desc' })
  order?: 'asc' | 'desc';
}

// ============================================================================
// GET /personality/me/snapshots
// ============================================================================

export class GetSnapshotsQueryDto {
  @ApiPropertyOptional({ description: '曲线指标族', enum: SNAPSHOT_METRICS, default: 'BIG_FIVE' })
  @IsOptional()
  @IsIn(SNAPSHOT_METRICS, { message: `metric 仅支持：${SNAPSHOT_METRICS.join(', ')}` })
  metric?: (typeof SNAPSHOT_METRICS)[number];

  @ApiPropertyOptional({
    description: '指定单维曲线（不传返回该指标族全部维度）',
    example: 'openness',
  })
  @IsOptional()
  @IsString({ message: 'dimension 必须是字符串' })
  @Length(1, 32, { message: 'dimension 长度需在 1–32 之间' })
  dimension?: string;

  @ApiPropertyOptional({ description: '时间范围', enum: SNAPSHOT_RANGES, default: '90D' })
  @IsOptional()
  @IsIn(SNAPSHOT_RANGES, { message: `range 仅支持：${SNAPSHOT_RANGES.join(', ')}` })
  range?: (typeof SNAPSHOT_RANGES)[number];

  @ApiPropertyOptional({ description: '聚合粒度（聚合值为区间均值）', enum: SNAPSHOT_GRANULARITIES, default: 'RAW' })
  @IsOptional()
  @IsIn(SNAPSHOT_GRANULARITIES, { message: `granularity 仅支持：${SNAPSHOT_GRANULARITIES.join(', ')}` })
  granularity?: (typeof SNAPSHOT_GRANULARITIES)[number];
}

// ============================================================================
// GET /personality/types/{mbti}
// ============================================================================

export class MbtiTypeParamDto {
  @ApiProperty({ description: 'MBTI 类型（大小写不敏感）', example: 'INFJ' })
  @IsString({ message: 'mbti 必须是字符串' })
  @Matches(MBTI_PATTERN, {
    message: 'mbti 必须是合法的 4 字母类型（形如 INFJ），每维取值为 E/I、S/N、T/F、J/P',
  })
  mbti!: string;
}

/** 最多返回的历史版本数（防止超大分页拖垮查询） */
export const MAX_PROFILE_HISTORY_PAGE_SIZE = 100;

/** 快照查询的最大返回点数（避免曲线接口返回过大响应体） */
export const MAX_SNAPSHOT_POINTS = 500;
