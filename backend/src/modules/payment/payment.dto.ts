/**
 * 支付模块 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.7
 *
 * ⚠ **刻意不包含任何金额字段**：金额一律由服务端从商品表读取。
 * 前端传"元"而服务端当"分"用是这类接口最经典的事故 ——
 * 小额测试订单上完全看不出来，上线后少收 100 倍。不提供这个字段，
 * 出错的可能性就从"取决于前端写对"变成"结构上不可能"。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class CreateOrderDto {
  @ApiProperty({
    description: '商品 ID（UUID）。价格与类型由服务端从商品表读取',
    example: '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d',
    format: 'uuid',
  })
  @IsUUID(undefined, { message: 'productId 必须是合法 UUID' })
  productId!: string;

  @ApiPropertyOptional({
    description: '相关报告 ID（购买单份报告解锁时提供）',
    example: '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID(undefined, { message: 'reportId 必须是合法 UUID' })
  reportId?: string;

  @ApiPropertyOptional({
    description: '相关关系 ID（购买匹配报告时提供）',
    example: '0195f3a2-d46a-7ca8-8d13-9fca6d7e8b67',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID(undefined, { message: 'relationshipId 必须是合法 UUID' })
  relationshipId?: string;
}
