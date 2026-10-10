/**
 * 统一响应包络 DTO（见 PROJECT_ARCHITECTURE.md §6.2）
 *
 * 成功：{ code: 0, message: 'ok', data, requestId, timestamp }
 * 失败：{ code: <非0>, message, data: null, requestId, timestamp, details? }
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { ErrorDetail } from '../errors/business.exception';

export class ApiResponseDto<T> {
  @ApiProperty({ description: '业务错误码，0 表示成功', example: 0 })
  code!: number;

  @ApiProperty({ description: '提示信息（中文，可直接展示给用户）', example: 'ok' })
  message!: string;

  @ApiProperty({ description: '业务数据，失败时为 null', nullable: true })
  data!: T | null;

  @ApiProperty({ description: '请求追踪 ID，排障时提供给客服', example: 'req_0192f3c1-7a4b-7c3d-9e2f-1a2b3c4d5e6f' })
  requestId!: string;

  @ApiProperty({ description: '服务端响应时间（ISO 8601 UTC）', example: '2026-02-14T10:00:00.000Z' })
  timestamp!: string;

  @ApiPropertyOptional({
    description: '字段级错误明细（仅在参数校验失败时出现）',
    type: 'array',
    items: { type: 'object' },
  })
  details?: ErrorDetail[];
}

/** 分页响应体 */
export class PaginatedDataDto<T> {
  @ApiProperty({ description: '当前页数据', isArray: true })
  items!: T[];

  @ApiProperty({ description: '总记录数', example: 128 })
  total!: number;

  @ApiProperty({ description: '当前页码，从 1 开始', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;

  @ApiProperty({ description: '是否还有下一页', example: true })
  hasNext!: boolean;
}

/** 分页查询基类 — 所有列表接口的 Query DTO 都应继承本类 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 最小为 1' })
  page: number = 1;

  @ApiPropertyOptional({ description: '每页条数，最大 100', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 最小为 1' })
  @Max(100, { message: 'pageSize 最大为 100' })
  pageSize: number = 20;

  /** Prisma 分页偏移量 */
  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }

  /** Prisma 分页 limit */
  get take(): number {
    return this.pageSize;
  }
}

/** 构造分页结果 */
export const buildPaginated = <T>(items: T[], total: number, page: number, pageSize: number): PaginatedDataDto<T> => ({
  items,
  total,
  page,
  pageSize,
  hasNext: page * pageSize < total,
});
