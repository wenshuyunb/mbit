/**
 * 星座运势的请求参数校验
 *
 * 校验放在 DTO 而不是 Service：`birthday` 是**用户直接输入**的（日期选择器也可能
 * 被绕过），非法值必须在入口处挡掉 —— 否则它会一路走到星座判定里，
 * 变成"用户明明选了生日却看到别人的星座"。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

import { ZODIAC_SIGNS, type ZodiacSign } from '../zodiac.types';

/** `YYYY-MM-DD`（只做形状校验，真实性由 `resolveZodiacSignFromDate` 判定） */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 查运势时的公共 query（三种周期共用） */
export class ZodiacFortuneQueryDto {
  @ApiProperty({
    description: '查询日期（`YYYY-MM-DD`）。日运按当天、周运按所在周、月运按所在月计算结果',
    example: '2026-10-16',
  })
  @IsString()
  @Matches(DATE_PATTERN, { message: 'date 需为 YYYY-MM-DD 格式' })
  date!: string;

  @ApiPropertyOptional({
    description:
      '临时指定出生日期（`YYYY-MM-DD`）。**不写库**：想改账号里的生日请用 `PATCH /users/me`。' +
      '不传时使用当前账号已保存的生日（未设置则返回 `30019`），年份不影响星座判定',
    example: '1996-03-08',
  })
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: 'birthday 需为 YYYY-MM-DD 格式' })
  birthday?: string;
}

/** 星座配对 query */
export class ZodiacMatchQueryDto {
  @ApiProperty({ description: '我方星座', enum: ZODIAC_SIGNS, example: 'PISCES' })
  @IsIn(ZODIAC_SIGNS, { message: 'a 取值不合法' })
  a!: ZodiacSign;

  @ApiProperty({ description: '对方星座', enum: ZODIAC_SIGNS, example: 'VIRGO' })
  @IsIn(ZODIAC_SIGNS, { message: 'b 取值不合法' })
  b!: ZodiacSign;
}

/**
 * 星盘 query
 *
 * 目前**不接受任何参数** —— 出生信息一律从账号里读（见 `ZodiacService.getChart`）。
 * 保留这个 DTO 是为了：① Swagger 上有一个明确的空参数对象；
 * ② 将来若要支持"临时看别人的盘"（不写库），参数加在这里就行。
 *
 * ⚠ 刻意**不提供** `birthday`/`latitude` 这类覆盖参数：星盘是会员功能，
 * 一旦允许请求方自带出生数据，前端就能绕过会员门槛自行拼出完整盘。
 */
export class ZodiacChartQueryDto {}

/** 出生城市搜索 query */
export class ZodiacCityQueryDto {
  @ApiPropertyOptional({
    description: '关键词（城市名或省份，如 `杭州` / `浙江` / `Hangzhou`）；为空时返回热门城市',
    example: '杭州',
    maxLength: 32,
  })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(32, { message: 'keyword 最长 32 个字符' })
  keyword?: string;
}

/**
 * 三级联动：按「省 / 市 / 县」取具体城市
 *
 * ⚠ 三个参数都必填且必须**成对匹配**：路径不合法时后端返回 400，
 * 而不是悄悄回退到某个默认城市 —— 回退会让用户选的地方与实际算盘的地方不一致。
 */
export class ZodiacRegionResolveQueryDto {
  @ApiProperty({ description: '省级名称（如 `福建省` / `北京市`）', example: '福建省', maxLength: 32 })
  @IsString({ message: 'province 必须是字符串' })
  @Length(1, 32, { message: 'province 长度需在 1–32 个字符之间' })
  province!: string;

  @ApiProperty({ description: '地级市名称（如 `龙岩市`）', example: '龙岩市', maxLength: 32 })
  @IsString({ message: 'city 必须是字符串' })
  @Length(1, 32, { message: 'city 长度需在 1–32 个字符之间' })
  city!: string;

  @ApiProperty({
    description: '县/区名称（如 `武平县`）；没有区县的地级市传 `全市`',
    example: '武平县',
    maxLength: 32,
  })
  @IsString({ message: 'county 必须是字符串' })
  @Length(1, 32, { message: 'county 长度需在 1–32 个字符之间' })
  county!: string;
}
