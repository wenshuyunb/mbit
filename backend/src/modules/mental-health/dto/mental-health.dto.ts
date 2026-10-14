/**
 * 心理健康模块的请求 DTO
 *
 * `version` 用 `@Type(() => Number)`：查询串的值**永远是字符串**，
 * 不转换的话 `version="2"` 会以字符串形式传进 Prisma，得到"找不到"的空结果 ——
 * 那看起来像"这个版本不存在"，与真实的"类型不对"完全不同。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class GetMentalHealthProfileQueryDto {
  @ApiPropertyOptional({ description: '画像版本号；不传则返回当前生效版本', minimum: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'version 必须是整数' })
  @Min(1, { message: 'version 必须大于 0' })
  version?: number;
}
