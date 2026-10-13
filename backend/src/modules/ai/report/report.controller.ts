/**
 * 报告控制器（契约 §3.5）
 *
 * 分层约定（架构 §6.1 P2）：Controller 只做参数校验、调用 Service、返回 DTO。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../../common/decorators';
import { EntitlementService } from '../../membership/entitlement.service';
import { CreateReportDto, ListReportsQueryDto, ReportIdParamDto } from './report.dto';
import {
  ReportService,
  type ReportCreatedView,
  type ReportDetailView,
  type ReportListView,
  type ReportProgressView,
} from './report.service';

/**
 * 历史遗留：Phase 6 之前的临时解锁桩
 *
 * 权益体系（`EntitlementService`）接入后**已不再使用**。保留这条注释是为了说明
 * 它当时为什么存在（宁可少给内容，也不能因为"暂时不校验"而把付费内容放出去），
 * 以及现在由谁接管：`resolveUnlockStateFor` 会读取真实的 `entitlements` 行。
 *
 * 不要把这个函数接回去 —— 它恒返回"全锁"，接回去等于付费墙永远打不开。
 */

/**
 * 读取某份报告的真实解锁状态（会员 / 单份购买 / 单段购买）
 *
 * 写成**模块级函数**而不是控制器私有方法：`report.controller.spec.ts` 会枚举
 * 原型上的方法并断言"恰好这四个路由"，私有方法会被当成新增路由。
 * 给它加排除名单是更糟的选择 —— 那会让断言失去"有人误加路由"的防护作用。
 */
const resolveUnlockStateFor = async (
  entitlements: EntitlementService,
  userId: string,
  reportId: string,
): Promise<{ allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> }> => {
  const state = await entitlements.resolveReportUnlock(userId, reportId);

  return { allUnlocked: state.allUnlocked, unlockedSectionKeys: state.unlockedSectionKeys };
};

@ApiTags('报告')
@ApiBearerAuth('user-token')
@Controller('reports')
export class ReportController {
  constructor(
    private readonly reportService: ReportService,
    private readonly entitlements: EntitlementService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: '创建报告（异步）',
    description: [
      '提交生成申请，返回 `202` 与 `reportId`，由 `ai.report` 队列异步生成。',
      '',
      '**幂等**：同一份画像 + 同一 Prompt 版本 + 同一模型产出的报告必然相同，',
      '因此若已有成功报告会**直接复用**（`isReused: true`）—— 用户不会为同一内容付两次费。',
      '',
      '**前置条件**：用户必须已有一次完成的人格测评，否则返回 `40010`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 202, description: '申请已受理，返回 reportId 与轮询地址' })
  @ApiResponse({ status: 400, description: '报告类型不合法（`10001`）或关系报告缺 `relationshipId`（`10001`）' })
  @ApiResponse({ status: 404, description: '尚无可用画像（`40010`）或关系不存在（`60000`）' })
  @ApiResponse({
    status: 409,
    description: '报告正在生成中（`50017`）、关系未生效（`60008`）或匹配算分未完成（`60009`）',
  })
  @ApiResponse({ status: 503, description: '队列不可用（`90004`，可直接重试）' })
  async createReport(@CurrentUser('userId') userId: string, @Body() dto: CreateReportDto): Promise<ReportCreatedView> {
    return this.reportService.createReport({
      userId,
      type: dto.type,
      ...(dto.sessionId !== undefined ? { sessionId: dto.sessionId } : {}),
      // 关系报告的上下文来自"关系双方画像 + 算分报告"，服务层按它走另一条取数路径
      ...(dto.relationshipId !== undefined ? { relationshipId: dto.relationshipId } : {}),
    });
  }

  @Get()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '报告列表',
    description: [
      '只返回**元信息与免费预览摘要**，不含分段正文（正文走详情接口）。',
      '',
      '**进行中的报告置顶**，并参与分页计算 —— 否则一条在第 2 页的生成中报告永远不会',
      '浮到第 1 页，而"让用户立刻看到正在生成的任务"正是这条规则的目的。',
      '显式传 `status` 时不再置顶：用户要的就是那批。',
      '',
      '`summary` 里的统计是**该用户全部报告**的口径，不随筛选与翻页变化。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（`items` + `total` + `hasNext` + `summary`）' })
  @ApiResponse({ status: 400, description: '分页越界（`10005`）、排序字段越界（`10004`）或枚举非法（`10001`）' })
  async listReports(
    @CurrentUser('userId') userId: string,
    @Query() query: ListReportsQueryDto,
  ): Promise<ReportListView> {
    return this.reportService.listReports({
      userId,
      unlockContext: await this.entitlements.buildListUnlockContext(userId),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.sortBy !== undefined ? { sortBy: query.sortBy } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
    });
  }

  @Get(':reportId')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '报告详情（服务端裁剪免费预览）',
    description: [
      '返回报告元信息与**裁剪后**的分段列表。',
      '',
      '**未解锁段落不下发正文**（`content` 为 `null`），而不是把全文发给前端再隐藏 ——',
      '后者抓包即可看到付费内容，付费墙形同虚设。未解锁段落只下发标题、顺序与字数。',
      '',
      '生成中返回 `50017`（前端应继续轮询进度接口），生成失败返回 `50018`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（含 `visibility` 汇总：已解锁/锁定段数）' })
  @ApiResponse({ status: 400, description: '报告 ID 不合法（`10001`）' })
  @ApiResponse({ status: 404, description: '报告不存在或不属于当前用户（`50016`）' })
  @ApiResponse({ status: 403, description: '整份报告均未解锁（`50019`）' })
  @ApiResponse({ status: 409, description: '报告正在生成中（`50017`）' })
  async getReport(@CurrentUser('userId') userId: string, @Param() params: ReportIdParamDto): Promise<ReportDetailView> {
    return this.reportService.getDetail(
      userId,
      params.reportId,
      await resolveUnlockStateFor(this.entitlements, userId, params.reportId),
    );
  }

  @Get(':reportId/progress')
  @Throttle({ global: { limit: 240, ttl: 60_000 } })
  @ApiOperation({
    summary: '生成进度轮询',
    description: '返回 `status` / `progress`；完成或失败后停止轮询。限流 240 次/60s（允许每秒一次）。',
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  @ApiResponse({ status: 404, description: '报告不存在或不属于当前用户（`50016`）' })
  async getProgress(
    @CurrentUser('userId') userId: string,
    @Param() params: ReportIdParamDto,
  ): Promise<ReportProgressView> {
    return this.reportService.getProgress(userId, params.reportId);
  }
}
