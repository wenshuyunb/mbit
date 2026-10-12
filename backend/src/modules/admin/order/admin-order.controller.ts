/**
 * 管理端订单控制器（契约 §3.14.6.1 / §3.14.6.2 / §3.14.6.4）
 *
 * ## 守卫组合（管理端控制器的固定写法）
 *
 * `@Public()` 跳过的是**用户端**全局守卫（`JwtAuthGuard`）—— 管理员令牌的
 * `realm = 'admin'` 会被它判为 `REALM_MISMATCH`（20013）。管理端认证由
 * `AdminAuthGuard` + `RolesGuard` + `ConfirmPasswordGuard` 承接。
 *
 * ⚠ 这里**绝不能**用 `@AdminPublic()`：那个装饰器会跳过管理端守卫，接口将完全公开。
 *
 * ## 路由顺序
 *
 * `export` 必须声明在 `:id` **之前**：Nest 按声明顺序匹配路由，否则
 * `GET /admin/orders/export` 会被 `:id` 吃掉并把 `export` 当成订单 ID。
 *
 * ## 为什么 GET 不标 `@SensitiveOperation()`
 *
 * 二次确认密码针对的是**写操作**（退款/封禁/发布 Prompt）。把只读查询也要求
 * 输入密码，只会让管理员把密码记在便利贴上。订单导出按契约附录 A.13
 * 「二次确认」列为 `—`，故同样不标。
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, IdempotencyKey, Public } from '../../../common/decorators';
import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminOrderExportService } from './admin-order-export.service';
import type { OrderExportRequestedView, OrderExportTaskView } from './admin-order-export.service';
import { AdminOrderService } from './admin-order.service';
import type { AdminOrderDetailView, AdminOrderListView } from './admin-order.service';
import {
  ExportAdminOrdersQueryDto,
  GetAdminOrderParamDto,
  GetAdminOrderQueryDto,
  ListAdminOrdersQueryDto,
} from './dto/admin-order.dto';

@ApiTags('后台管理 - 订单')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/orders')
export class AdminOrderController {
  constructor(
    private readonly orderService: AdminOrderService,
    private readonly exportService: AdminOrderExportService,
  ) {}

  // ==========================================================================
  // 列表
  // ==========================================================================

  @Get()
  @RequirePermission(ADMIN_PERMISSIONS.ORDER_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: '订单列表（多维筛选）',
    description: [
      '分页查询全部订单，用于对账与客服；响应同时给出**筛选条件下的聚合摘要**。',
      '',
      '**金额口径**：全部为整数分（ADR-009）；`netRevenue = totalPaidAmount - totalRefundedAmount`。',
      '`minAmount`/`maxAmount` 与 `sortBy=amount` 均作用于**实付金额**（`paidAmount`）。',
      '',
      '**异常订单**：`hasAbnormalFlag` 由读时规则推导（已支付超 24h 未发权益 / 金额不一致 /',
      '退款超过实付）。`orders` 表没有对账标记列，真实的「对账任务标记」尚无法表达。',
      '',
      '**性能**：固定 6 条 SQL（主查询 + count + 2 个 groupBy 摘要 + 2 个批量关联查询），',
      '与页大小无关。',
      '',
      '🚫 不返回支付者 openid 明文。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（items + summary）' })
  @ApiResponse({
    status: 400,
    description: '枚举/白名单非法、pageSize > 100、minAmount > maxAmount（均 `10001`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `payment:order:read`（`20009`）' })
  async listOrders(@Query() query: ListAdminOrdersQueryDto): Promise<AdminOrderListView> {
    return this.orderService.listOrders(query);
  }

  // ==========================================================================
  // 导出（异步）
  // ==========================================================================

  /**
   * 导出任务：创建（202）与查询（200）共用同一 URL
   *
   * 契约 §3.14.6.4 的 `pollUrl` 就是 `GET /admin/orders/export?taskId=xxx`，
   * 因此不能拆成两个路径。带 `taskId` 时按「查询任务状态」处理，不要求幂等键。
   */
  @Get('export')
  @RequirePermission(ADMIN_PERMISSIONS.ORDER_EXPORT)
  @Throttle({ global: { limit: 5, ttl: 3_600_000 } })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description: '创建导出任务时必填（8–64 位）；同一键重放返回首次的 202 响应体',
  })
  @ApiOperation({
    summary: '订单导出（异步）',
    description: [
      '按条件异步导出订单 CSV/XLSX，返回 `202` 与 `taskId`；携带 `?taskId=` 时改为',
      '查询任务状态并返回签名下载 URL（200）。',
      '',
      '**异步必选**：导出涉及大数据量聚合与文件上传，**禁止同步实现**；',
      '任务由 `export.data` 队列（并发 2、重试 2 次）处理。',
      '',
      '**强制时间范围**：`createdStartTime`/`createdEndTime` 必填且跨度 ≤ 366 天，',
      '🚫 不允许无时间范围的导出（防一次性拖走全量订单数据）。',
      '',
      '**敏感字段绝对禁止**：导出文件**永不包含**手机号、openid、unionid、支付者标识；',
      '`maskSensitive`（默认 `true`）进一步掩码用户昵称与用户 ID。',
      '',
      '**有效期**：签名 URL 24h，源文件与任务状态保留 7 天，过期后状态转 `EXPIRED`。',
      '',
      '**强审计**：导出操作写 `admin_audit_logs`（含查询条件、预估行数、字段列表）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 202, description: '创建成功，返回 taskId 与轮询地址' })
  @ApiResponse({ status: 200, description: '任务状态查询成功（含 downloadUrl）' })
  @ApiResponse({
    status: 400,
    description: '缺时间范围 / 范围 > 366 天 / format 或 fields 非白名单 / 缺幂等键（均 `10001`、`10009`）',
  })
  @ApiResponse({ status: 403, description: '缺少 `payment:order:export`（`20009`）' })
  @ApiResponse({ status: 404, description: '导出任务不存在或已过期（`80005`）' })
  @ApiResponse({ status: 409, description: '已有进行中的导出任务（`10003`）' })
  @ApiResponse({ status: 429, description: '60 分钟内超过 5 次（`10007`）' })
  @ApiResponse({ status: 503, description: '队列不可用（`90004`）' })
  async exportOrders(
    @CurrentUser('userId') adminUserId: string,
    @Query() query: ExportAdminOrdersQueryDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<OrderExportRequestedView | OrderExportTaskView> {
    if (query.taskId !== undefined && query.taskId.length > 0) {
      return this.exportService.getExportTask(adminUserId, query.taskId);
    }

    // 契约附录 A.13 标注本接口幂等键为「是」：重复点击会产生多份导出文件与多份签名 URL
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw BusinessException.badRequest(ErrorCode.IDEMPOTENCY_KEY_MISSING, '缺少 X-Idempotency-Key 请求头');
    }

    return this.exportService.requestExport(adminUserId, query, idempotencyKey);
  }

  // ==========================================================================
  // 详情
  // ==========================================================================

  @Get(':id')
  @RequirePermission(ADMIN_PERMISSIONS.ORDER_READ)
  @Throttle({ global: { limit: 300, ttl: 60_000 } })
  @ApiParam({ name: 'id', description: '订单 UUID；`byNo=true` 时为订单号' })
  @ApiOperation({
    summary: '订单详情',
    description: [
      '订单完整详情：支付信息、权益发放、退款记录、时间线、审计轨迹与**可执行操作提示**。',
      '',
      '**`adminActions`**：前端只据此渲染按钮，避免越权尝试；其中 `canResendEntitlement`',
      '严格按契约 —— 仅 `status = PAID` 且 `entitlements` 为空时可用。',
      '',
      '**脱敏**：手机号只返回掩码值；`payerOpenidHash` 契约要求哈希，但 `payments` 表',
      '无此列，固定返回 `null`（🚫 绝不用 openid 明文顶替）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  @ApiResponse({ status: 400, description: 'id 非合法 UUID（`10001`）' })
  @ApiResponse({ status: 403, description: '缺少 `payment:order:read`（`20009`）' })
  @ApiResponse({ status: 404, description: '订单不存在（`70002`）' })
  async getOrderDetail(
    @Param() params: GetAdminOrderParamDto,
    @Query() query: GetAdminOrderQueryDto,
  ): Promise<AdminOrderDetailView> {
    return this.orderService.getOrderDetail(params.id, query.byNo ?? false);
  }
}
