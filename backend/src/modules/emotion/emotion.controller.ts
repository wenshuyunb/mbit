/**
 * 情感画像控制器（ADR-038 阶段 3）
 *
 * 路由挂在 `/emotion` 而不是塞进 `/personality` 下：三个模块互不干扰，
 * 前端也要能一眼看出"我正在读哪个模块的结果"。
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../common/decorators';
import { GetEmotionProfileQueryDto } from './dto/emotion.dto';
import { EmotionService, type EmotionProfileView } from './emotion.service';

@ApiTags('情感画像')
@Controller('emotion')
export class EmotionController {
  constructor(private readonly emotionService: EmotionService) {}

  @Get('me')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '获取当前情感画像',
    description: [
      '返回最新（或指定版本）的情感画像：依恋类型与两个轴、五种爱的语言得分与主导项、五种冲突风格得分与主导风格、质量指标。',
      '',
      '**只读接口**：写入路径只有完成情感测评（`POST /tests/sessions/{id}/submit`）。',
      '',
      '**为什么依恋既给类型又给两条轴**：四种依恋类型是焦虑轴与回避轴**求交**得出的象限结果，',
      '只给标签无法回答"为什么是这个类型"，也无法表达"离分界线有多近"。',
      '',
      '**版本语义**：每次完成情感测评都生成新版本；旧版本不重算。',
      '',
      '**免责声明由服务端下发**，前端不得硬编码（合规要求）。',
      '',
      '⚠ 本接口**只返回情感模块的数据**，不含 MBTI / 大五 —— 情感测评没有测人格（ADR-038）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '尚未生成情感画像（`40014`）或指定版本不存在' })
  async getProfile(
    @CurrentUser('userId') userId: string,
    @Query() query: GetEmotionProfileQueryDto,
  ): Promise<EmotionProfileView> {
    return this.emotionService.getProfile(userId, query.version);
  }
}
