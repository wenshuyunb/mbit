/**
 * 塔罗牌的请求参数校验
 *
 * 与星座模块同一套：`date` 是用户侧传入的（可能被手改），非法值必须在入口挡掉，
 * 否则它会一路走到种子计算里，变成"同一天显示不同的牌"。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/** `YYYY-MM-DD`（只校验形状，真实性由种子计算天然容错） */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 今日抽卡的 query */
export class TarotDailyQueryDto {
  @ApiProperty({
    description: '查询日期（`YYYY-MM-DD`）。同一天同一用户永远是同一张牌',
    example: '2026-10-19',
  })
  @IsString({ message: 'date 必须是字符串' })
  @Matches(DATE_PATTERN, { message: 'date 需为 YYYY-MM-DD 格式' })
  date!: string;
}
