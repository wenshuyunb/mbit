/**
 * 心理健康控制器（ADR-038 阶段 4）
 *
 * 路由挂在 `/mental-health`（而不是塞进 `/personality`）：三个模块互不干扰，
 * 前端也要一眼看出"我正在读哪个模块的结果"。
 *
 * ⚠ 文档里**不写**任何诊断类表述：这个模块只给结论，接口描述也不该暗示诊断能力。
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../common/decorators';
import { GetMentalHealthProfileQueryDto } from './dto/mental-health.dto';
import { MentalHealthService, type MentalHealthProfileView } from './mental-health.service';

@ApiTags('心理健康画像')
@Controller('mental-health')
export class MentalHealthController {
  constructor(private readonly mentalHealthService: MentalHealthService) {}

  @Get('me')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '获取当前心理健康画像',
    description: [
      '返回最新（或指定版本）的心理健康画像：六个维度的得分与档位、整体档位、文字结论、质量指标。',
      '',
      '**只读接口**：写入路径只有完成心理健康测评（`POST /tests/sessions/{id}/submit`）。',
      '',
      '**本接口只给结论**：不提供建议、不提供干预方案、不做任何判定或分级。',
      '`conclusion` 由**确定性规则**在提交时生成并落库（不是 AI 现编的），',
      '因此同一份作答任何时候读到的都是同一段话。',
      '',
      '`disclaimer` 由服务端下发（含「本结果仅供参考」），**前端不得硬编码**。',
      '',
      '⚠ 各维度的 `score` 与 `band` 都读自落库快照，不在读取时按当前阈值重算 ——',
      '`conclusion` 里嵌着档位措辞，重算会让标签与正文自相矛盾。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '尚未生成心理健康画像（`40017`）或指定版本不存在' })
  async getProfile(
    @CurrentUser('userId') userId: string,
    @Query() query: GetMentalHealthProfileQueryDto,
  ): Promise<MentalHealthProfileView> {
    return this.mentalHealthService.getProfile(userId, query.version);
  }
}
