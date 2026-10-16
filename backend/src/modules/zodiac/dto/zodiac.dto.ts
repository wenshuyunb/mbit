/**
 * 星座运势的请求参数校验
 *
 * 校验放在 DTO 而不是 Service：`birthday` 是**用户直接输入**的（日期选择器也可能
 * 被绕过），非法值必须在入口处挡掉 —— 否则它会一路走到星座判定里，
 * 变成"用户明明选了生日却看到别人的星座"。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

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
