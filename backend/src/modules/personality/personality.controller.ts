/**
 * 人格画像控制器
 *
 * 契约来源：docs/API_DESIGN.md §3.4
 *
 * ⚠ 路由注册顺序：`GET /personality/types/:mbti` 与 `GET /personality/me*` 前缀不同，
 *   不存在冲突；但 `me/history`、`me/snapshots` 必须注册在 `me` 之前
 *   （否则会被 `@Get('me')` 精确匹配拦下 —— 实际上精确路径不会匹配多段，此处仍按最具体优先排列）。
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../common/decorators';
import type { MbtiTypeProfile } from './data/mbti-types.types';
import {
  GetProfileQueryDto,
  GetSnapshotsQueryDto,
  ListProfileHistoryQueryDto,
  MbtiTypeParamDto,
} from './dto/personality.dto';
import {
  PersonalityService,
  type ProfileHistoryItem,
  type ProfileView,
  type SnapshotsView,
} from './personality.service';

@ApiTags('人格画像')
@Controller('personality')
export class PersonalityController {
  constructor(private readonly personalityService: PersonalityService) {}

  // ==========================================================================
  // 类型百科（公开）
  // ==========================================================================

  @Get('types/:mbti')
  @Public()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'MBTI 类型百科（公开）',
    description: [
      '返回指定类型的名称、描述、优势/盲点、关系建议与典型维度画像。',
      '',
      '**公开接口**：游客可访问，用于结果页分享引导与 SEO 落地页。',
      '类型参数**大小写不敏感**，每维取值受限（`E/I`、`S/N`、`T/F`、`J/P`），非法组合返回 `40012`。',
    ].join('\n'),
  })
  @ApiParam({ name: 'mbti', description: 'MBTI 类型（4 字母）', example: 'INFJ' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '类型格式非法（`10001`）' })
  @ApiResponse({ status: 404, description: '类型不存在（`40012`）' })
  getTypeInfo(@Param() params: MbtiTypeParamDto): MbtiTypeProfile {
    return this.personalityService.getTypeInfo(params);
  }

  // ==========================================================================
  // 当前画像
  // ==========================================================================

  @Get('me/history')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '画像历史版本',
    description: '分页返回历史画像版本（算法版本、生成时间、MBTI、置信度），用于「查看某次历史画像」。',
  })
  @ApiResponse({ status: 200, description: '获取成功（无画像时返回空列表）' })
  async getHistory(
    @CurrentUser('userId') userId: string,
    @Query() query: ListProfileHistoryQueryDto,
  ): Promise<{
    items: ProfileHistoryItem[];
    total: number;
    page: number;
    pageSize: number;
    hasNext: boolean;
  }> {
    return this.personalityService.listHistory(userId, query);
  }

  @Get('me/snapshots')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '成长曲线时间序列',
    description: [
      '返回时间序列的人格快照点，用于绘制 Big Five 五维成长曲线与 MBTI 置信度趋势。',
      '',
      '**指标族**：`BIG_FIVE`（默认）、`MBTI_DIMENSIONS`、`CONFIDENCE`；',
      '`dimension` 参数必须属于所选指标族，否则返回 `10001`（避免返回永远为空的曲线）。',
      '',
      '**聚合**：`granularity = WEEK / MONTH` 时按区间取**算术平均**，`sampleCount` 标识该点聚合的原始记录数。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: 'dimension 与 metric 不匹配（`10001`）' })
  async getSnapshots(
    @CurrentUser('userId') userId: string,
    @Query() query: GetSnapshotsQueryDto,
  ): Promise<SnapshotsView> {
    return this.personalityService.getSnapshots(userId, query);
  }

  @Get('me')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '获取当前人格画像',
    description: [
      '返回最新（或指定版本）的人格画像：MBTI 四维度、大五分数、关系风格、质量指标、与上一版本的对比。',
      '',
      '**只读接口**：画像的写入路径只有完成测试（`POST /tests/sessions/{id}/submit`）。',
      '',
      '**版本语义**：每次完成测试都生成新版本（即使 MBTI 未变化），以保证成长曲线连续；旧版本不重算。',
      '',
      '**summary 为规则模板生成**（`isAiGenerated: false`），AI 深度解读在报告模块。',
      '',
      '**免责声明由服务端下发**，前端不得硬编码（合规要求）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '算法版本不受支持（`40013`）' })
  @ApiResponse({ status: 404, description: '尚无画像（`40010`）或指定版本不存在' })
  async getProfile(@CurrentUser('userId') userId: string, @Query() query: GetProfileQueryDto): Promise<ProfileView> {
    return this.personalityService.getProfile(userId, query);
  }
}
