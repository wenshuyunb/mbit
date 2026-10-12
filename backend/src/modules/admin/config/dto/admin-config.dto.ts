/**
 * 管理端系统配置的 DTO（契约 §3.14.9.1 / §3.14.9.2）
 *
 * ## 为什么 PUT 的 `value` 不在这里做类型校验
 *
 * 每个键的合法类型由 `system_configs.valueType` + 目录里的 `min`/`max` 决定，
 * 属于**动态**约束（`reportFreePreviewRatio` 是 0–1 的数字，`FEATURE_PAYMENT` 是布尔）。
 * 在 DTO 层用一个固定类型去校验必然错一半，因此 `value` 声明为 `unknown`，
 * 由 `AdminConfigService` 按目录逐项校验并回填字段级 `validation.errors` ——
 * 这也正好是契约 §3.14.9.2 要求的响应结构。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * query 里的布尔值转换
 *
 * 全局管道开启了 `enableImplicitConversion`，而 JS 的 `Boolean('false')` 是 `true` ——
 * 直接用隐式转换会把 `?includeHistory=false` 解析成 `true`（静默的错误默认值）。
 */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === true || value === false) return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

export class AdminConfigListQueryDto {
  @ApiPropertyOptional({
    description: '配置分组，逗号分隔，默认 ALL',
    example: 'FEATURE_FLAG,LIMIT',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'group 过长' })
  group?: string;

  @ApiPropertyOptional({ description: '指定配置键，逗号分隔，最多 50 个' })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'keys 过长' })
  keys?: string;

  @ApiPropertyOptional({ description: '是否返回变更历史（每条配置最近 5 次）', default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'includeHistory 需要布尔值' })
  includeHistory?: boolean;
}

export class ConfigUpdateItemDto {
  @ApiProperty({ description: '配置键（必须存在于配置目录且可编辑）', example: 'reportFreePreviewRatio' })
  @IsString()
  @IsNotEmpty({ message: 'key 不能为空' })
  @MaxLength(96, { message: 'key 最长 96 个字符' })
  key!: string;

  @ApiProperty({
    description: '新值，类型必须与该键的 valueType 相符（BOOLEAN / NUMBER / STRING / JSON）',
    example: 0.25,
  })
  @IsDefined({ message: 'value 不能为空' })
  value!: unknown;

  @ApiPropertyOptional({ description: '变更说明（强烈建议填写，审计可读性依赖它）', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'changeNote 最长 200 个字符' })
  changeNote?: string;
}

export class AdminUpdateConfigsDto {
  @ApiProperty({ description: '待更新配置项，1–30 条', type: [ConfigUpdateItemDto] })
  @IsArray({ message: 'items 必须是数组' })
  @ArrayMinSize(1, { message: 'items 至少需要 1 条' })
  @ArrayMaxSize(30, { message: 'items 最多 30 条' })
  @ValidateNested({ each: true })
  @Type(() => ConfigUpdateItemDto)
  items!: ConfigUpdateItemDto[];

  @ApiPropertyOptional({ description: '试运行：只校验并返回 before/after，不写入', default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'dryRun 需要布尔值' })
  dryRun?: boolean;

  @ApiPropertyOptional({ description: '是否主动失效相关缓存', default: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'invalidateCaches 需要布尔值' })
  invalidateCaches?: boolean;
}
