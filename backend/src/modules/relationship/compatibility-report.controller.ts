/**
 * 匹配报告控制器（契约 §3.6.10 / §3.6.11）
 *
 * | 契约     | 方法与路径                                  | 鉴权 | 成功码 |
 * | -------- | ------------------------------------------- | ---- | ------ |
 * | §3.6.10  | `GET /compatibility-reports/{id}`           | 🔑 + 归属校验 + 💎 | 200 |
 * | §3.6.11  | `GET /compatibility-reports/{id}/progress`  | 🔑 + 归属校验      | 200 |
 *
 * ## 为什么单独一个控制器，而不是塞进 `RelationshipController`
 *
 * 一个 `@Controller()` 只有一个基础路径。这两个端点的基础路径是
 * `compatibility-reports`（按**报告 ID** 查），与 `RelationshipController` 的
 * `relationships`（按**关系 ID** 查）不同。
 *
 * 它们**不是重复路由**：`GET /relationships/{id}/compatibility`（§3.6.9）返回
 * 某段关系的**最新报告摘要**，当客户端还不知道 `reportId` 时用；本控制器返回
 * **指定报告**的全文与进度。两者共用同一个 `CompatibilityService`，
 * 校验链与视图组装**完全复用**，没有任何一份逻辑被抄第二遍。
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../common/decorators';
import { CompatibilityReportIdParamDto, GetCompatibilityReportQueryDto } from './dto/relationship.dto';
import {
  CompatibilityService,
  type CompatibilityProgressView,
  type CompatibilityReportDetailView,
} from './compatibility.service';

@ApiTags('关系')
@ApiBearerAuth('user-token')
@Controller('compatibility-reports')
export class CompatibilityReportController {
  constructor(private readonly compatibilityService: CompatibilityService) {}

  @Get(':id')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '匹配报告详情（AI 解读）',
    description: [
      '返回指定报告的全文：总分拆解 + AI 生成的优势/冲突/建议/话术。',
      '',
      '**归属校验**：`报告 → 关系 → (我是 A 或 B)`，任一层不满足都返回 `60010`（404）。',
      '非双方看到的是「不存在」而不是 403 —— 403 会告诉攻击者这个 ID 真实存在。',
      '',
      '**服务端裁剪**：未解锁时只下发确定性算分结果（总分、等级、四维拆解），',
      '`aiInsights` 与 `profileComparison` 置 `null`，并在 `freePreview.excludes`',
      '中列出被隐藏的板块。**绝不下发 AI 解读全文** —— 靠前端"不渲染"等于白送。',
      '',
      '**报告仍在生成中返回 409（`60011`）**，前端应改轮询',
      '`GET /compatibility-reports/{id}/progress`。',
      '',
      '⚠ 契约 §3.6.10 要求「关系已解除且 `keepHistory=false` 时报告对双方隐藏」（`60010`）：',
      '`relationships` 表**没有** `keepHistory` 列（`DELETE` 接口的该参数被接受但未持久化），',
      '因此本接口**一律按"保留历史"处理**，已解除关系的报告仍可读。',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: '查询成功（未解锁时 `aiInsights` / `profileComparison` 为 `null`，并附 `freePreview`）',
  })
  @ApiResponse({ status: 400, description: '`id` 非合法 UUID（`10001`）' })
  @ApiResponse({ status: 401, description: '未登录或登录态失效（`20000`/`20001`）' })
  @ApiResponse({ status: 404, description: '报告不存在，或当前用户不是该报告所属关系的双方之一（`60010`）' })
  @ApiResponse({ status: 409, description: '报告仍在生成中（`60011`），请改订阅进度接口' })
  async getReportDetail(
    @CurrentUser('userId') userId: string,
    @Param() params: CompatibilityReportIdParamDto,
    @Query() query: GetCompatibilityReportQueryDto,
  ): Promise<CompatibilityReportDetailView> {
    return this.compatibilityService.getReportById(userId, params.id, {
      // 契约默认值：`includeScoreBreakdown` 默认 true、`previewOnly` 默认 false
      includeScoreBreakdown: query.includeScoreBreakdown ?? true,
      previewOnly: query.previewOnly ?? false,
    });
  }

  @Get(':id/progress')
  @Throttle({ global: { limit: 240, ttl: 60_000 } })
  @ApiOperation({
    summary: '匹配报告生成进度',
    description: [
      '轮询生成进度：算分阶段（确定性、毫秒级）与 AI 解读阶段（10–30s）分开返回。',
      '',
      '**失败不返回 5xx**：`status = ERROR` / `PARTIAL` 均以 200 返回，并附',
      '`canRetry` 与 `retryScope`（`AI_ONLY` 只重跑解读、`FULL` 整体重跑）。',
      '用 5xx 表达"生成失败"会让前端当成网络故障重试请求，而该重试的是生成任务。',
      '',
      '`PARTIAL` 是契约规则 1 的关键设计：算分已完成、解读失败时，前端**先展示总分',
      '与拆解**，AI 区域展示「解读生成失败，点击重试」。',
      '',
      '⚠ 阶段时间戳只在有列可查时下发（`QUEUED`/`SCORING`/`GENERATING_AI_INSIGHTS`）；',
      '`SAFETY_CHECK` / `PERSISTING` 在本项目没有落库字段，**如实返回 `null`**，',
      '`scoring.durationMs` 同理（不用「算分完成时间 − 创建时间」冒充，那里面含排队时间）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（终态同样返回 200）' })
  @ApiResponse({ status: 400, description: '`id` 非合法 UUID（`10001`）' })
  @ApiResponse({ status: 401, description: '未登录或登录态失效（`20000`/`20001`）' })
  @ApiResponse({ status: 404, description: '报告不存在或不属于当前用户的关系（`60010`）' })
  @ApiResponse({ status: 429, description: '轮询过快（超出 240 次/60s）' })
  async getReportProgress(
    @CurrentUser('userId') userId: string,
    @Param() params: CompatibilityReportIdParamDto,
  ): Promise<CompatibilityProgressView> {
    return this.compatibilityService.getReportProgress(userId, params.id);
  }
}
