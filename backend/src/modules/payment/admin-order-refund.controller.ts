/**
 * 管理端退款控制器（契约 §3.14.6.3）
 *
 * ## 守卫组合（管理端控制器的固定写法，照 `admin-order.controller.ts`）
 *
 * `@Public()` 跳过的是**用户端**全局守卫（`JwtAuthGuard`）—— 管理员令牌的
 * `realm = 'admin'` 会被它判为 `REALM_MISMATCH`（20013）。管理端认证由
 * `AdminAuthGuard` + `RolesGuard` + `ConfirmPasswordGuard` 承接。
 *
 * ⚠ **绝不能**用 `@AdminPublic()`：那个装饰器会让 `AdminAuthGuard` 直接放行，
 * 接口将完全公开。
 *
 * ## 为什么这个控制器放在 payment 模块而不是 `admin/order`
 *
 * 契约里它是 `admin/orders/{id}/refund`，路径属于管理端；但它的**实现**与用户侧
 * 退款共用同一套资金状态机（`RefundService`）。把它放进 `admin/order` 就需要
 * 让管理端订单模块反向依赖用户端 payment 模块，而管理端订单域的职责是"读"。
 * 路由前缀用 `@Controller('admin/orders')` 表达，与 `AdminOrderController`
 * 共存不冲突（后者只有 `GET`，本控制器只有 `POST :id/refund`）。
 *
 * ## 部分退款
 *
 * 用户侧只允许全额；**部分退款是管理员专属**（契约 §3.14.6.3 规则 2）。
 * 多次部分退款累计不得超过 `payAmount` —— 该约束由数据库条件更新保证
 * （见 `RefundService.reserveAndCreateRefund`），不依赖应用层判断。
 *
 * ## 审核已有申请
 *
 * 契约 §3.14.6 只定义了「发起退款」，没有「审核退款」。当订单已存在用户提交的
 * `PENDING` 退款申请且金额一致时，本接口**执行同一笔**（相当于审核通过）而不是
 * 新开一笔 —— 否则会重复占额并产生两笔退款单。金额不一致则返回 `70019`。
 */

import { Body, Controller, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, IdempotencyKey, Public } from '../../common/decorators';
import type { RequestWithContext } from '../../common/types/request.type';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AdminAuthGuard } from '../admin/auth/admin-auth.guard';
import { SensitiveOperation } from '../admin/decorators/sensitive-operation.decorator';
import { ADMIN_PERMISSIONS } from '../admin/rbac/admin-permission.constants';
import { RequirePermission } from '../admin/rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../admin/rbac/guards/confirm-password.guard';
import { RolesGuard } from '../admin/rbac/guards/roles.guard';
import { AdminRefundBodyDto, AdminRefundQueryDto } from './refund.dto';
import { RefundService } from './refund.service';
import type { AdminRefundView } from './refund.service';

@ApiTags('后台管理 - 订单')
@ApiBearerAuth('admin-token')
@Public()
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/orders')
export class AdminOrderRefundController {
  constructor(
    private readonly refunds: RefundService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ADMIN_PERMISSIONS.ORDER_REFUND)
  @SensitiveOperation()
  @Throttle({ global: { limit: 20, ttl: 60_000 } })
  @ApiHeader({
    name: 'X-Confirm-Password',
    required: true,
    description: '**必填**：操作者本人的登录密码（敏感操作二次确认，缺失 `20017`，错误 `20018`）',
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: '**必填**（8–64 位）：同一键重放返回首次退款记录，避免重复出款',
  })
  @ApiParam({ name: 'id', description: '订单 UUID' })
  @ApiOperation({
    summary: '管理员发起退款（支持部分退款）',
    description: [
      '调微信退款 API 并在**同一事务**内撤销对应权益，同时写 `admin_audit_logs`。',
      '',
      '**权益撤销策略**：全额退款默认撤销全部关联权益；部分退款由 `revokeEntitlement` 决定',
      '（默认 `true`，补偿性部分退款可传 `false`）。会员撤权会立即失效。',
      '',
      '**失败语义**：微信**明确拒绝**（4xx）→ `FAILED` 并释放预留额度；',
      '网络超时 / 5xx / 微信仍在处理（`PROCESSING`）→ 保持 `PENDING`，',
      '由退款对账任务查询真实结果。🚫 绝不在结果未知时把订单标成已退款。',
      '',
      '**部分退款累计上限**由数据库条件更新保证（`refunded_amount + 本笔 ≤ paid_amount`），',
      '并发下也只会成功一笔。',
      '',
      '**`?force=true`**：覆盖商品退款策略（如超 7 天仍退），审计额外标记 `isForced`，',
      '必须在 `reason` 中说明理由（契约 §3.14.6.3 规则 5）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '退款已提交（`status` 为 `SUCCESS` / `PENDING` / `FAILED`）' })
  @ApiResponse({ status: 400, description: '缺少幂等键（`10009`）；reason 缺失/超长、金额超可退（`10001`/`70011`）' })
  @ApiResponse({ status: 401, description: '缺少/错误二次确认密码（`20017`/`20018`）' })
  @ApiResponse({ status: 403, description: '缺少 `payment:order:refund`（`20009`）' })
  @ApiResponse({ status: 404, description: '订单不存在（`70002`）' })
  @ApiResponse({
    status: 409,
    description: '状态不支持 / 已全额退款 / 策略限制 / 存在处理中的退款（`70004`/`70012`/`70019`）',
  })
  @ApiResponse({ status: 429, description: '60 分钟内超过 20 次（`10007`）' })
  @ApiResponse({ status: 503, description: '支付通道未配置（`70018`）' })
  async refundOrder(
    @CurrentUser('userId') adminUserId: string,
    @Param('id') orderId: string,
    @Body() dto: AdminRefundBodyDto,
    @Query() query: AdminRefundQueryDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminRefundView> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { username: true, nickname: true },
    });

    return this.refunds.adminRefund({
      adminUserId,
      // 审计里必须存**用户名**：账号被删后仍要能追责（见 AdminAuditEntry 约定）
      adminUsername: admin?.username ?? adminUserId,
      adminDisplayName: admin?.nickname ?? admin?.username ?? adminUserId,
      orderId,
      dto,
      idempotencyKey: idempotencyKey ?? '',
      force: query.force === true,
      ctx: {
        ip: request.ip ?? null,
        userAgent: headerOf(request, 'user-agent'),
        requestId: request.requestId ?? null,
      },
    });
  }
}

/** 从请求头取字符串（Node 把头名转小写；数组形态取第一个） */
const headerOf = (request: RequestWithContext, name: string): string | null => {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value === undefined || value.trim() === '' ? null : value.slice(0, 256);
};
