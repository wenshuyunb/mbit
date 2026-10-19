/**
 * 塔罗牌控制器
 *
 * 路由挂在 `/tarot`。与三个测评模块**完全隔离**（ADR-038）：
 * 不写画像、不进测评框架、不影响任何测评结论。
 *
 * ⚠ 公开接口必须显式标 `@Public()`：全局 `JwtAuthGuard` 挂在 `APP_GUARD` 上，
 * 默认拒绝一切未标记的路由（这个坑在星座模块已经踩过一次，见审计 §29.4）。
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../common/decorators';
import { TarotDailyQueryDto } from './dto/tarot.dto';
import { TarotService, type DailyCardResponse, type SpreadDrawResponse } from './tarot.service';
import type { TarotSpread } from './tarot-spreads';
import type { TarotCard } from './tarot.types';

@ApiTags('塔罗牌')
@Controller('tarot')
export class TarotController {
  constructor(private readonly tarotService: TarotService) {}

  @Get('spreads')
  @Public()
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '牌阵列表（形式选择页）',
    description: [
      '返回五种牌阵：今日指引（1 张）/ 时间之流（3 张）/ 二选一（3 张）/ 关系之镜（4 张）/ 七日指引（7 张）。',
      '',
      '每个牌阵带：名称、一句话副标题、简介（适合什么场景）、张数、布局提示、以及每个位置的`名称 + 提问`。',
      '',
      '⚠ 位置的提问是解读的骨架 —— 前端可以直接展示出来，让用户在抽卡前就知道"这一张在问什么"。',
      '**不需要登录**（用户先看介绍再决定要不要登录抽卡）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  listSpreads(): readonly TarotSpread[] {
    return this.tarotService.listSpreads();
  }

  @Get('spreads/:id/draw')
  @ApiBearerAuth('user-token')
  @ApiParam({ name: 'id', description: '牌阵 id（见 `GET /tarot/spreads`）', example: 'THREE_TIME' })
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '按牌阵抽卡并生成解读',
    description: [
      '按牌阵规则抽出 N 张**互不重复**的牌，并逐位置给出解读与整体分析。',
      '',
      '**确定性**：种子 = `（用户 + 日期 + 牌阵）`。刷新不换牌，隔天或换牌阵才换；',
      '不同用户同一天抽到的也不同。',
      '',
      '**整体解读**由三条从牌面实际算出的信息构成：大阿卡纳占比（是否涉及底层模式）、',
      '花色分布（重心压在行动/情感/想法/现实哪一边）、逆位占比（能量是否受阻）。',
      '',
      '⚠ 牌阵不存在返回 `400`，**不会回退到默认牌阵**。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '牌阵不存在（`10001`）或 `date` 格式不合法' })
  async drawSpread(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Query() query: TarotDailyQueryDto,
  ): Promise<SpreadDrawResponse> {
    return this.tarotService.drawSpread(userId, query.date, id);
  }

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
