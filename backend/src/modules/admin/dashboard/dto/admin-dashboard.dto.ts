/**
 * 管理端看板 DTO（契约 §3.14.9.9）
 *
 * 错误码映射同其他管理端模块：契约声明的 `10002`（缺必填）/`10016`（范围 > 366 天）
 * 在本项目统一映射为 `10001 PARAM_INVALID`（400），不新增错误码。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsOptional } from 'class-validator';

import { DASHBOARD_GRANULARITIES, DASHBOARD_RANGES } from '../admin-dashboard.util';

export class AdminDashboardQueryDto {
  @ApiPropertyOptional({
    description: '时间范围',
    enum: DASHBOARD_RANGES,
    default: '7D',
  })
  @IsOptional()
  @IsIn(DASHBOARD_RANGES, { message: `range 仅支持：${DASHBOARD_RANGES.join(', ')}` })
  range?: 'TODAY' | '7D' | '30D' | '90D' | 'CUSTOM';

  @ApiPropertyOptional({ description: 'range = CUSTOM 时必填（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startTime 必须是 ISO 8601 时间' })
  startTime?: string;

  @ApiPropertyOptional({ description: 'range = CUSTOM 时必填（ISO 8601）' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endTime 必须是 ISO 8601 时间' })
  endTime?: string;

  @ApiPropertyOptional({
    description: '趋势粒度（按 UTC 自然日/周/月切桶）',
    enum: DASHBOARD_GRANULARITIES,
    default: 'DAY',
  })
  @IsOptional()
  @IsIn(DASHBOARD_GRANULARITIES, { message: `granularity 仅支持：${DASHBOARD_GRANULARITIES.join(', ')}` })
  granularity?: 'DAY' | 'WEEK' | 'MONTH';

  @ApiPropertyOptional({ description: '是否返回与前一等长周期的对比', default: true })
  @IsOptional()
  @IsBoolean({ message: 'compareWithPrevious 必须是布尔值' })
  compareWithPrevious?: boolean;
}
