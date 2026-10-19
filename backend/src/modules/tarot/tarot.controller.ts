/**
 * 塔罗牌控制器
 *
 * 路由挂在 `/tarot`。与三个测评模块**完全隔离**（ADR-038）：
 * 不写画像、不进测评框架、不影响任何测评结论。
 *
 * ⚠ 公开接口必须显式标 `@Public()`：全局 `JwtAuthGuard` 挂在 `APP_GUARD` 上，
 * 默认拒绝一切未标记的路由（这个坑在星座模块已经踩过一次，见审计 §29.4）。
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../common/decorators';
import { TarotDailyQueryDto } from './dto/tarot.dto';
import { TarotService, type DailyCardResponse } from './tarot.service';
import type { TarotCard } from './tarot.types';

@ApiTags('塔罗牌')
@Controller('tarot')
export class TarotController {
  constructor(private readonly tarotService: TarotService) {}

  @Get('deck')
  @Public()
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '78 张塔罗牌（牌义速查）',
    description: [
      '返回完整牌组：22 张大阿卡纳（逐张文案）+ 56 张小阿卡纳（花色 × 位阶组合）。',
      '',
      '⚠ 内容是**文化象征体系**的通识解读，不含任何预测；**不需要登录**。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  listDeck(): readonly TarotCard[] {
    return this.tarotService.listDeck();
  }

  @Get('daily')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '今日抽卡',
    description: [
      '按 `(用户 + 日期)` 确定性抽一张牌，并给出朝向（正位 / 逆位）与当日提示。',
      '',
      '**确定性**：同一个用户同一天永远是同一张牌（刷新不会变），隔天才换；',
      '不同用户同一天各抽各的（种子含用户 ID）。',
      '',
      '逆位不等于坏牌：它表示这股能量受阻、内化或过量 —— 文案里已按这个口径写好。',
      '',
      '⚠ 娱乐性质内容，`disclaimer` 由服务端下发，前端不得硬编码或省略。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '`date` 格式不合法（`10001`）' })
  async getDailyCard(
    @CurrentUser('userId') userId: string,
    @Query() query: TarotDailyQueryDto,
  ): Promise<DailyCardResponse> {
    return this.tarotService.getDailyCard(userId, query.date);
  }
}
