/**
 * 退款服务（契约 §3.9.9 / §3.9.10 / §3.14.6.3）
 *
 * 这是本仓库**唯一会真实出款**的代码，因此把「为什么会这么写」逐条记在这里。
 *
 * ## 一、执行顺序：先落库，再调微信
 *
 * ```
 * ① 校验（状态 / 金额 / 策略 / 归属）
 * ② 【事务】在 orders 上**预留**退款额度 + 建 Refund(PENDING)   ← 先落库
 * ③ 调微信退款 API（事务之外，绝不在事务里做网络调用）
 * ④ 【事务】按微信结果结算 SUCCESS / FAILED，并回收权益       ← 后结算
 * ```
 *
 * 反过来（先调微信再落库）会造出**最糟糕的一类事故**：钱已经从微信出款，
 * 而因为落库失败（连接抖动、进程崩溃）本地没有任何退款记录 —— 既查不到、
 * 也不会被对账任务发现，只能等用户投诉。
 *
 * ## 二、并发防护靠**数据库条件更新**，不靠应用层判断
 *
 * 预留动作是一条带条件的 `UPDATE`：
 *
 * ```sql
 * UPDATE orders SET refunded_amount = refunded_amount + :amt
 *  WHERE id = :id AND status IN (PAID, FULFILLED, PARTIAL_REFUNDED)
 *    AND refunded_amount + :amt <= paid_amount
 * ```
 *
 * PostgreSQL 会对该行加行锁，因此**并发的两笔退款只有一笔能把 `count` 更新为 1**，
 * 另一笔拿到 0 并被拒。应用层的 `refundableAmount > 0` 判断只用来给出友好文案，
 * 它本身**不构成**任何安全保证（两个请求可以同时通过判断）。
 *
 * ## 三、失败语义：区分「微信明确拒绝」与「不知道结果」
 *
 * | 微信返回                                  | 本地处理                          | 理由                                     |
 * | ----------------------------------------- | --------------------------------- | ---------------------------------------- |
 * | 200 + `SUCCESS`                           | 结算 `SUCCESS` + 回收权益         | 明确成功                                 |
 * | 200 + `PROCESSING`                        | 保持 `PENDING`，由对账任务跟进    | 微信还在处理                             |
 * | 4xx（参数错/余额不足/订单不存在）         | 结算 `FAILED` + 释放预留额度      | **明确**没退成，重试无意义               |
 * | 超时 / 网络错误 / 5xx / 429               | **保持 `PENDING`**                | 请求可能已被受理，置 FAILED 会"钱退了却没记录" |
 *
 * 最后一行是对契约「失败时 `status = FAILED` + `failedReason`」的**有意偏离**：
 * 契约没有区分「确定失败」与「结果未知」，而在资金链路上这两者必须分开 ——
 * 信用卡中心的超时重试、网关 502 之后请求实际到达，都是真实存在的场景。
 *
 * ## 四、权益回收：退款成功**同事务**撤销
 *
 * 不回收权益就会出现「退款了但会员还在」。回收按 `orderId` 圈定权益（而不是按
 * 用户），因为用户可能同时拥有多笔订单带来的权益，退款只应影响这一单。
 * 计数型权益（`AI_CREDITS`）按契约「已消耗部分不追偿」：整条置 `REVOKED`，
 * 剩余次数不结转。
 *
 * ## 五、对账任务为何是**必需**的
 *
 * 退款回调（`refundNotifyUrl`）本模块尚未实现，而微信退款是**异步出款**：
 * 同步返回 `PROCESSING` 才是常态。没有主动查询，`PENDING` 会永远停在那里 ——
 * 用户看到「处理中」，订单状态也停在 `FULFILLED`。
 * 因此 `reconcilePendingRefunds` 由队列每分钟驱动（见 `payment-jobs.module.ts`）。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Entitlement, Order, OrderStatus, Payment, Prisma, Refund } from '@prisma/client';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { WechatPayApiError, WechatPayService } from '../../infra/wechat/wechat-pay.service';
import type { WechatPayRefundResult } from '../../infra/wechat/wechat-pay.service';
import { enforceRateLimit } from './payment-rate-limit.util';
import { buildPaginatedView, computeRefundableAmount, hasConsumedEntitlement } from './order-query.util';
import type { ApplyRefundBodyDto, AdminRefundBodyDto, ListRefundsQueryDto } from './refund.dto';
import {
  REFUND_ARRIVAL_NOTICE,
  REFUND_WINDOW_DAYS,
  buildRefundIdempotencyKey,
  composeRefundFailureReason,
  composeUserRefundReason,
  decideUserRefundPolicy,
  emptyRefundMeta,
  generateRefundNo,
  orderStatusAfterRefund,
  readRefundMeta,
  refundCancelDeadline,
  refundSettlementOfWechatState,
  refundStatusLabel,
  refundTypeOf,
  wechatRefundFailureReason,
  withRefundMeta,
  type RefundMeta,
  type RefundOperator,
  type RefundType,
} from './refund.util';

/** 已支付可退状态 */
const REFUNDABLE_STATUSES: readonly OrderStatus[] = ['PAID', 'FULFILLED', 'PARTIAL_REFUNDED'];

/** 用户侧退款申请限流（契约 §3.9.10：userId 5 次/24h） */
const USER_REFUND_RATE_LIMIT = 5;
const USER_REFUND_RATE_TTL_SECONDS = 86_400;

/** 管理端退款限流（契约 §3.14.6.3：adminId 20 次/60min） */
const ADMIN_REFUND_RATE_LIMIT = 20;
const ADMIN_REFUND_RATE_TTL_SECONDS = 3_600;

/**
 * 对账任务只处理「申请后超过 2 分钟仍是 PENDING」的退款
 *
 * 立即对账会与同步调用抢同一笔单：同步调用刚发出、微信还没受理，此时查询
 * 得到 404，会把一笔本来会成功的退款错判成"未提交"。2 分钟足以覆盖微信侧的受理延迟。
 */
const RECONCILE_MIN_AGE_MS = 2 * 60_000;

/** PENDING 超过该时长且微信侧查不到 → 判定为"从未提交成功"，释放额度 */
const RECONCILE_ABANDON_AGE_MS = 30 * 60_000;

/** 幂等键生成的重试次数（退款单号碰撞是正常概率事件） */
const REFUND_NO_MAX_ATTEMPTS = 5;

/** 请求上下文（审计用） */
export interface RefundRequestContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

/** 用户侧退款申请结果（契约 §3.9.10 的两种成功响应之一） */
export interface UserRefundPendingView {
  refundId: string;
  refundNo: string;
  orderId: string;
  orderNo: string;
  status: string;
  statusLabel: string;
  refundType: RefundType;
  refundAmount: number;
  currency: string;
  reason: string;
  description: string | null;
  requiresReview: boolean;
  reviewHint: string;
  appliedAt: string;
  estimatedProcessHours: number;
  entitlementRevoked: boolean;
  entitlementRevokeNote: string;
  nextAction: { canCancel: boolean; cancelDeadline: string };
}

/** 用户侧退款已结算结果 */
export interface UserRefundSettledView {
  refundId: string;
  refundNo: string;
  orderId: string;
  orderNo: string;
  status: string;
  statusLabel: string;
  refundType: RefundType;
  refundAmount: number;
  currency: string;
  reason: string;
  requiresReview: boolean;
  wechatRefundId: string | null;
  wechatRefundStatus: string | null;
  appliedAt: string;
  succeededAt: string | null;
  failedReason: string | null;
  orderStatus: string;
  entitlementRevoked: boolean;
  revokedEntitlementIds: string[];
  arrivalNotice: string | null;
  nextAction: { canCancel: boolean; cancelDeadline: null };
}

/** 用户侧退款结果（`PENDING` 走 201，其余走 200） */
export type UserRefundApplyView = UserRefundPendingView | UserRefundSettledView;

/** 退款记录列表条目（契约 §3.9.9） */
export interface RefundListItem {
  refundId: string;
  refundNo: string;
  orderId: string;
  orderNo: string;
  status: string;
  statusLabel: string;
  refundAmount: number;
  currency: string;
  refundType: RefundType;
  reason: string | null;
  wechatRefundId: string | null;
  wechatRefundStatus: string | null;
  appliedAt: string;
  succeededAt: string | null;
  failedReason: string | null;
  entitlementRevoked: boolean;
  revokedEntitlementIds: string[];
  arrivalNotice: string | null;
  operator: RefundOperator;
}

/** 退款列表响应 */
export interface RefundListView {
  items: RefundListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: {
    totalRefunds: number;
    successCount: number;
    failedCount: number;
    pendingCount: number;
    totalRefundedAmount: number;
  };
}

/** 管理端退款结果（契约 §3.14.6.3） */
export interface AdminRefundView {
  refundId: string;
  refundNo: string;
  orderId: string;
  orderNo: string;
  status: string;
  statusLabel: string;
  refundType: RefundType;
  refundAmount: number;
  previousRefundedAmount: number;
  totalRefundedAmount: number;
  refundableAmountAfter: number;
  currency: string;
  reason: string;
  internalNote: string | null;
  ticketId: string | null;
  wechatRefundId: string | null;
  wechatRefundStatus: string | null;
  orderStatus: string;
  entitlementRevoked: boolean;
  revokedEntitlements: Array<{
    entitlementId: string;
    type: string;
    previousStatus: string;
    newStatus: string;
    resourceId: string | null;
  }>;
  userNotified: boolean;
  appliedAt: string;
  succeededAt: string | null;
  failedReason: string | null;
  operator: { adminId: string; displayName: string };
  auditLogId: string | null;
  reconciliation: { isReconciled: boolean; note: string };
}

/** 对账批次结果 */
export interface ReconcileRefundsResult {
  scanned: number;
  settled: number;
  failed: number;
  stillPending: number;
}

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wechatPay: WechatPayService,
    private readonly redis: RedisService,
  ) {}

  // ==========================================================================
  // POST /orders/{id}/refund（用户侧）
  // ==========================================================================

  async applyUserRefund(params: {
    userId: string;
    orderId: string;
    dto: ApplyRefundBodyDto;
    idempotencyKey: string;
  }): Promise<UserRefundApplyView> {
    await enforceRateLimit({
      redis: this.redis,
      keyParts: ['refund-apply', params.userId],
      limit: USER_REFUND_RATE_LIMIT,
      ttlSeconds: USER_REFUND_RATE_TTL_SECONDS,
      message: '退款申请过于频繁，请稍后再试或联系客服',
    });

    const order = await this.findOwnedOrder(params.userId, params.orderId);
    const refundableAmount = computeRefundableAmount(order.paidAmount, order.refundedAmount);

    // 幂等：同一「用户 + 订单 + 客户端键」重放返回首次退款记录（契约 §3.9.10 规则 7）
    const idempotencyKey = buildRefundIdempotencyKey(params.userId, order.id, params.idempotencyKey);
    const replayed = await this.prisma.refund.findUnique({ where: { idempotencyKey } });
    if (replayed !== null) {
      this.logger.log(`退款申请幂等命中 refundNo=${replayed.refundNo} orderNo=${order.orderNo}`);

      return this.toUserApplyView(order, replayed);
    }

    // 状态校验（契约 §3.9.10：非 PAID/FULFILLED → 70004）
    if (!REFUNDABLE_STATUSES.includes(order.status)) {
      throw new BusinessException(ErrorCode.ORDER_STATUS_INVALID, '当前订单状态不支持退款');
    }

    if (refundableAmount <= 0) {
      throw new BusinessException(ErrorCode.REFUND_NOT_ALLOWED, '该订单已全额退款');
    }

    const requestedAmount = params.dto.refundAmount ?? refundableAmount;
    if (requestedAmount > refundableAmount) {
      throw BusinessException.badRequest(
        ErrorCode.PAYMENT_AMOUNT_MISMATCH,
        `退款金额超出可退金额（可退 ${String(refundableAmount)} 分）`,
      );
    }

    // 用户侧仅允许全额（契约 §3.9.10 规则 2）
    if (requestedAmount !== refundableAmount) {
      throw new BusinessException(ErrorCode.REFUND_NOT_ALLOWED, '仅支持全额退款，部分退款请联系客服');
    }

    const entitlements = await this.loadOrderEntitlements(order.id);
    const policy = decideUserRefundPolicy({
      paidAt: order.paidAt,
      reason: params.dto.reason,
      hasConsumedEntitlement: hasConsumedEntitlement(
        entitlements.map((item) => ({ status: item.status, usedQuota: item.usedQuota })),
      ),
      now: new Date(),
    });

    if (policy === 'REJECT_CONSUMED') {
      throw new BusinessException(ErrorCode.REFUND_NOT_ALLOWED, '该商品权益已使用，不支持退款，如有疑问请联系客服');
    }

    if (policy === 'REJECT_EXPIRED') {
      throw new BusinessException(ErrorCode.REFUND_NOT_ALLOWED, '已超过 7 天退款期限，请联系客服处理');
    }

    const description = params.dto.description?.trim() ?? '';
    const contact = params.dto.contact?.trim() ?? '';

    const meta: RefundMeta = {
      ...emptyRefundMeta('USER', 'FULL'),
      requiresReview: policy === 'MANUAL_REVIEW',
      description: description.length > 0 ? description : null,
      contact: contact.length > 0 ? contact : null,
    };

    const payment = await this.ensurePayment(order);
    const reserved = await this.reserveAndCreateRefund({
      order,
      payment,
      refundAmount: requestedAmount,
      reason: composeUserRefundReason(params.dto.reason, meta.description),
      meta,
      idempotencyKey,
      operatorAdminId: null,
    });

    // 规则内直通：同步调微信退款（契约 §3.9.10 规则 1「自动退款」）
    if (policy === 'AUTO_APPROVE') {
      const settled = await this.executeWechatRefund(reserved, order);

      return this.toUserApplyView(await this.reloadOrder(order.id), settled);
    }

    this.logger.log(
      `用户退款申请已受理（待人工审核）refundNo=${reserved.refundNo} orderNo=${order.orderNo} amount=${String(requestedAmount)}`,
    );

    return this.toUserApplyView(order, reserved);
  }

  // ==========================================================================
  // POST /admin/orders/{id}/refund（管理端）
  // ==========================================================================

  async adminRefund(params: {
    adminUserId: string;
    adminUsername: string;
    adminDisplayName: string;
    orderId: string;
    dto: AdminRefundBodyDto;
    idempotencyKey: string;
    force: boolean;
    ctx: RefundRequestContext;
  }): Promise<AdminRefundView> {
    await enforceRateLimit({
      redis: this.redis,
      keyParts: ['refund-admin', params.adminUserId],
      limit: ADMIN_REFUND_RATE_LIMIT,
      ttlSeconds: ADMIN_REFUND_RATE_TTL_SECONDS,
      message: '退款操作过于频繁，请稍后再试',
    });

    const order = await this.findOrderById(params.orderId);
    const previousRefundedAmount = order.refundedAmount;
    const refundableAmount = computeRefundableAmount(order.paidAmount, order.refundedAmount);

    const idempotencyKey = buildRefundIdempotencyKey(params.adminUserId, order.id, params.idempotencyKey);
    const replayed = await this.prisma.refund.findUnique({ where: { idempotencyKey } });
    if (replayed !== null) {
      this.logger.log(`管理员退款幂等命中 refundNo=${replayed.refundNo} orderNo=${order.orderNo}`);

      return this.toAdminView({
        order,
        refund: replayed,
        previousRefundedAmount,
        adminId: params.adminUserId,
        adminDisplayName: params.adminDisplayName,
        auditLogId: null,
        revokedEntitlements: await this.loadRevokedEntitlements(replayed),
      });
    }

    if (!REFUNDABLE_STATUSES.includes(order.status)) {
      throw new BusinessException(ErrorCode.ORDER_STATUS_INVALID, '当前订单状态不支持退款');
    }

    if (refundableAmount <= 0) {
      throw new BusinessException(ErrorCode.REFUND_NOT_ALLOWED, '该订单已全额退款');
    }

    const isFull = (params.dto.refundType ?? 'FULL') === 'FULL';
    if (!isFull && params.dto.refundAmount === undefined) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '部分退款必须显式指定 refundAmount');
    }

    const refundAmount = isFull ? refundableAmount : (params.dto.refundAmount as number);

    if (refundAmount > refundableAmount) {
      throw BusinessException.badRequest(
        ErrorCode.PAYMENT_AMOUNT_MISMATCH,
        `退款金额超出可退金额（可退 ${String(refundableAmount)} 分）`,
      );
    }

    const entitlements = await this.loadOrderEntitlements(order.id);
    const consumed = hasConsumedEntitlement(
      entitlements.map((item) => ({ status: item.status, usedQuota: item.usedQuota })),
    );
    const withinWindow =
      order.paidAt !== null && Date.now() - order.paidAt.getTime() <= REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    // 策略限制：管理员可用 `?force=true` 覆盖，但必须留下 isForced 审计标记
    if (!params.force && (consumed || !withinWindow)) {
      throw new BusinessException(
        ErrorCode.REFUND_NOT_ALLOWED,
        consumed
          ? '该商品权益已使用，如需退款请使用 ?force=true 强制退款并在原因中说明'
          : '已超过 7 天退款期限，如需退款请使用 ?force=true 强制退款并在原因中说明',
      );
    }

    const revokeEntitlement = params.dto.revokeEntitlement !== false;
    const meta: RefundMeta = {
      ...emptyRefundMeta('ADMIN', refundTypeOf(refundAmount, order.paidAmount)),
      internalNote: params.dto.internalNote?.trim() ?? null,
      ticketId: params.dto.ticketId?.trim() ?? null,
      isForced: params.force,
    };

    // 该订单已有待审核的用户申请：管理员这次操作视为**审核通过**，执行同一笔而非新开一笔，
    // 否则会重复占额并产生两笔退款单（契约 §3.14.6 没有"审核退款"接口，见交付简报）
    const pending = await this.prisma.refund.findFirst({
      where: { orderId: order.id, status: 'PENDING', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    let refund: Refund;

    if (pending !== null) {
      if (pending.refundAmount !== refundAmount) {
        throw new BusinessException(
          ErrorCode.ORDER_IN_PROGRESS,
          `该订单存在处理中的退款申请（金额 ${String(pending.refundAmount)} 分），请先以相同金额审核或等待其完成`,
        );
      }

      const existingMeta = readRefundMeta(pending.notifyPayload);
      refund = await this.prisma.refund.update({
        where: { id: pending.id },
        data: {
          // 保留原始的申请信息（描述/联系方式），叠加管理员的操作信息
          notifyPayload: withRefundMeta(pending.notifyPayload, {
            ...(existingMeta ?? emptyRefundMeta('USER', meta.refundType)),
            operator: 'ADMIN',
            refundType: meta.refundType,
            requiresReview: false,
            internalNote: meta.internalNote,
            ticketId: meta.ticketId,
            isForced: meta.isForced,
          }) as unknown as Prisma.InputJsonValue,
          operatorAdminId: params.adminUserId,
          reason: `${pending.reason ?? '用户申请'}；管理员审核通过：${params.dto.reason}`.slice(0, 256),
          version: { increment: 1 },
        },
      });

      this.logger.log(`管理员审核通过已有退款申请 refundNo=${refund.refundNo} admin=${params.adminUsername}`);
    } else {
      const payment = await this.ensurePayment(order);

      refund = await this.reserveAndCreateRefund({
        order,
        payment,
        refundAmount,
        reason: params.dto.reason.slice(0, 256),
        meta,
        idempotencyKey,
        operatorAdminId: params.adminUserId,
      });
    }

    // 出款与审计的顺序（**不要改成裸调用**）
    //
    // 原实现是 `const settled = await this.executeWechatRefund(...)` 后面直接写审计，
    // 中间没有异常保护：于是**任何一次出款异常都不会留下审计记录**。实测中
    // 渠道未配置（`70018`）就会走到这条路，订单的 `refundedAmount` 已被预留，
    // 而 `admin_audit_logs` 里查询该订单命中 0 条。
    //
    // 这恰恰是最需要审计的场景：出款调用「结果未知」（超时 / 5xx / 本地结算事务失败）
    // 时，微信侧可能**已经出款成功**，事后追查却无法回答"是谁在什么时候发起的这笔退款"。
    // 因此失败也必须落一条审计，再原样抛出 —— 抛出的错误语义不变，
    // 只是不再以"丢失审计"为代价。
    //
    // 保护范围是**整段**（出款 + 结算后回读 + 审计），不只是出款那一行：
    // 出款成功之后的 `reloadRefund` / `reloadOrder` / `loadRevokedEntitlements`
    // 任何一步抛错（瞬时断库是有记录的既有故障形态，见交接文档 §6.3 第 16 条），
    // 若把它们留在保护之外，就会出现"钱已经出去了、审计仍然是 0 条"——
    // 与本次要消灭的事故一模一样，只是往后挪了几行。
    let settled: Refund | null = null;
    let finalRefund: Refund;
    let finalOrder: Order;
    let revokedEntitlements: Awaited<ReturnType<RefundService['loadRevokedEntitlements']>>;
    let auditLogId: string | null;

    try {
      settled = await this.executeWechatRefund(refund, order, { revokeEntitlement });

      finalRefund = await this.reloadRefund(settled.id);
      finalOrder = await this.reloadOrder(order.id);
      revokedEntitlements = await this.loadRevokedEntitlements(finalRefund);

      auditLogId = await this.writeAdminAudit({
        adminUserId: params.adminUserId,
        adminUsername: params.adminUsername,
        order: finalOrder,
        refund: finalRefund,
        beforeRefundedAmount: previousRefundedAmount,
        ctx: params.ctx,
        isForced: params.force,
        ticketId: params.dto.ticketId ?? null,
      });
    } catch (error) {
      await this.auditAdminRefundFailure({
        adminUserId: params.adminUserId,
        adminUsername: params.adminUsername,
        // 传入入参对象作为**回读失败时的兜底**：审计宁可少几个字段，
        // 也不能因为"读不到"就整条不写（见该方法的注释）
        fallbackOrder: order,
        fallbackRefund: settled ?? refund,
        // 出款是否已经返回：决定这条审计是"出款失败"还是"结算后处理失败"，
        // 前者必须标 success=false，后者不能把一次成功的退款记成失败
        payoutReturned: settled !== null,
        beforeRefundedAmount: previousRefundedAmount,
        ctx: params.ctx,
        isForced: params.force,
        ticketId: params.dto.ticketId ?? null,
        error,
      });

      throw error;
    }

    return this.toAdminView({
      order: finalOrder,
      refund: finalRefund,
      // 复用用户已有申请时，那笔额度在本次请求开始前就已预留，
      // 因此"退款前已退金额"要把它扣回去才准确
      previousRefundedAmount:
        pending === null ? previousRefundedAmount : Math.max(0, previousRefundedAmount - finalRefund.refundAmount),
      adminId: params.adminUserId,
      adminDisplayName: params.adminDisplayName,
      auditLogId,
      revokedEntitlements,
    });
  }

  // ==========================================================================
  // GET /refunds
  // ==========================================================================

  async listRefunds(userId: string, query: ListRefundsQueryDto): Promise<RefundListView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.RefundWhereInput = { userId, deletedAt: null };

    if (query.status !== undefined && query.status.length > 0) {
      where.status = { in: query.status };
    }

    if (query.orderId !== undefined) {
      // 归属校验：该订单必须属于当前用户，否则 `70002`（契约 §3.9.9 错误码表）
      const order = await this.findOwnedOrder(userId, query.orderId);
      where.orderId = order.id;
    }

    if (query.startTime !== undefined || query.endTime !== undefined) {
      where.createdAt = {
        ...(query.startTime !== undefined ? { gte: new Date(query.startTime) } : {}),
        ...(query.endTime !== undefined ? { lte: new Date(query.endTime) } : {}),
      };
    }

    const [rows, total, statusBuckets] = await Promise.all([
      this.prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { order: { select: { orderNo: true, paidAmount: true } } },
      }),
      this.prisma.refund.count({ where }),
      this.prisma.refund.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { refundAmount: true } }),
    ]);

    const items = rows.map((row) => this.toListItem(row));

    let successCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    let totalRefundedAmount = 0;

    for (const bucket of statusBuckets) {
      if (bucket.status === 'SUCCESS') {
        successCount += bucket._count._all;
        totalRefundedAmount += bucket._sum.refundAmount ?? 0;
      } else if (bucket.status === 'FAILED') {
        failedCount += bucket._count._all;
      } else if (bucket.status === 'PENDING') {
        pendingCount += bucket._count._all;
      }
    }

    return {
      ...buildPaginatedView(items, total, page, pageSize),
      summary: { totalRefunds: total, successCount, failedCount, pendingCount, totalRefundedAmount },
    };
  }

  // ==========================================================================
  // 对账（队列每分钟驱动）
  // ==========================================================================

  /**
   * 主动查询未结算的退款
   *
   * 契约 §3.9.10 写的是「状态由退款回调或主动查询更新」。退款回调端点不在本轮
   * 范围内，因此**主动查询是唯一的结算路径**，缺了它 PENDING 永远不会终结。
   */
  async reconcilePendingRefunds(batchSize = 100): Promise<ReconcileRefundsResult> {
    const result: ReconcileRefundsResult = { scanned: 0, settled: 0, failed: 0, stillPending: 0 };
    const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS);

    const rows = await this.prisma.refund.findMany({
      where: { status: 'PENDING', deletedAt: null, createdAt: { lt: cutoff } },
      // 先处理最老的：它们是最可能已经"卡死"的
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    if (rows.length === 0) return result;

    result.scanned = rows.length;

    for (const refund of rows) {
      const order = await this.prisma.order.findFirst({ where: { id: refund.orderId, deletedAt: null } });
      if (order === null) {
        result.stillPending += 1;
        continue;
      }

      try {
        const wechat = await this.wechatPay.queryRefundByOutRefundNo(refund.outRefundNo);
        const settlement = refundSettlementOfWechatState(wechat.status);

        if (settlement === 'SUCCESS') {
          await this.settleRefundSuccess(refund, order, wechat, {
            revokeEntitlement: this.shouldRevoke(refund, order),
          });
          result.settled += 1;
        } else if (settlement === 'FAILED') {
          await this.failRefund(refund, order, wechatRefundFailureReason(wechat.status), true);
          result.failed += 1;
        } else {
          result.stillPending += 1;
        }
      } catch (error) {
        if (error instanceof WechatPayApiError && error.kind === 'NOT_FOUND') {
          // 微信侧查不到这笔退款：要么从未提交成功（进程在"落库后、调用前"崩溃），
          // 要么微信还没受理。给足宽限期后判定为未提交，释放预留额度让用户重新申请
          const age = Date.now() - refund.createdAt.getTime();

          if (age > RECONCILE_ABANDON_AGE_MS) {
            await this.failRefund(refund, order, '未能提交至微信（超时未受理），已自动释放额度，请重新申请', true);
            result.failed += 1;
            this.logger.warn(`退款长期未提交至微信，已置失败并释放额度 refundNo=${refund.refundNo}`);
          } else {
            result.stillPending += 1;
          }
        } else {
          result.stillPending += 1;
          this.logger.warn(
            `退款对账失败 refundNo=${refund.refundNo}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return result;
  }

  // ==========================================================================
  // 内部：额度预留 + 建单
  // ==========================================================================

  /**
   * 预留退款额度并创建退款单（**唯一**的并发闸门）
   *
   * 两步必须在**同一事务**里：只预留不建单会在失败时留下一个被吃掉的额度，
   * 只建单不预留则超额退款无法被数据库拦住。
   */
  private async reserveAndCreateRefund(params: {
    order: Order;
    payment: Payment;
    refundAmount: number;
    reason: string;
    meta: RefundMeta;
    idempotencyKey: string;
    operatorAdminId: string | null;
  }): Promise<Refund> {
    const { order, payment, refundAmount } = params;

    return this.prisma.$transaction(async (tx) => {
      const reserved = await tx.order.updateMany({
        where: {
          id: order.id,
          deletedAt: null,
          status: { in: [...REFUNDABLE_STATUSES] },
          // 关键条件：加上本笔金额后仍不得超过实付额
          refundedAmount: { lte: order.paidAmount - refundAmount },
        },
        data: { refundedAmount: { increment: refundAmount }, version: { increment: 1 } },
      });

      if (reserved.count === 0) {
        await this.throwReservationFailure(tx, order, refundAmount);
      }

      const now = new Date();

      for (let attempt = 1; attempt <= REFUND_NO_MAX_ATTEMPTS; attempt += 1) {
        const refundNo = generateRefundNo(now);

        try {
          return await tx.refund.create({
            data: {
              refundNo,
              outRefundNo: refundNo,
              orderId: order.id,
              paymentId: payment.id,
              userId: order.userId,
              refundAmount,
              // 微信要求 `amount.total` 与原支付单一致；以本地订单实付额为准
              totalAmount: order.paidAmount,
              currency: order.currency,
              reason: params.reason,
              status: 'PENDING',
              channel: payment.channel,
              operatorAdminId: params.operatorAdminId,
              idempotencyKey: params.idempotencyKey,
              notifyPayload: withRefundMeta(null, params.meta) as unknown as Prisma.InputJsonValue,
            },
          });
        } catch (error) {
          // 退款单号碰撞是正常概率事件（与订单号同一处理策略）：重试而不是抛错
          if (isUniqueConstraintError(error) && attempt < REFUND_NO_MAX_ATTEMPTS) {
            this.logger.warn(`退款单号碰撞，重试生成 attempt=${attempt}`);
            continue;
          }

          throw error;
        }
      }

      throw BusinessException.internal(ErrorCode.INTERNAL_ERROR, '退款单创建失败，请稍后重试');
    });
  }

  /** 预留失败时区分「额度不足」与「并发占用」，给出不同错误码 */
  private async throwReservationFailure(
    tx: Pick<PrismaService, 'order'>,
    order: Order,
    refundAmount: number,
  ): Promise<never> {
    const fresh = await tx.order.findUnique({ where: { id: order.id }, select: { refundedAmount: true } });
    const total = (fresh?.refundedAmount ?? order.refundedAmount) + refundAmount;

    if (total > order.paidAmount) {
      throw new BusinessException(ErrorCode.REFUND_NOT_ALLOWED, '可退金额不足，请刷新后重试');
    }

    // 额度够却更新不到行 = 有并发退款正在处理（或状态已被改变）
    throw new BusinessException(ErrorCode.ORDER_IN_PROGRESS, '该订单存在处理中的退款，请稍后重试');
  }

  // ==========================================================================
  // 内部：调用微信 + 结算
  // ==========================================================================

  /**
   * 调用微信退款并结算
   *
   * @returns 结算后的退款行（可能是 `PENDING`：微信仍在处理或结果未知）
   */
  private async executeWechatRefund(
    refund: Refund,
    order: Order,
    options?: { revokeEntitlement?: boolean },
  ): Promise<Refund> {
    if (!this.wechatPay.isApiConfigured) {
      // 契约 §3.9.10：支付通道未配置 → `70018`。这里**不**把退款单置失败：
      // 配置补上之后这笔申请仍可被执行，置失败会让用户白等 24 小时
      throw BusinessException.unavailable(
        ErrorCode.PAYMENT_FEATURE_DISABLED,
        '支付通道未配置，暂时无法退款，请联系客服',
      );
    }

    let wechat: WechatPayRefundResult;

    try {
      wechat = await this.wechatPay.createRefund({
        outTradeNo: order.orderNo,
        outRefundNo: refund.outRefundNo,
        refundAmount: refund.refundAmount,
        totalAmount: refund.totalAmount,
        currency: refund.currency,
        reason: refund.reason ?? undefined,
      });
    } catch (error) {
      if (error instanceof WechatPayApiError) {
        if (error.kind === 'REJECTED' || error.kind === 'NOT_FOUND') {
          // 微信**明确**拒绝：结算为失败并释放预留额度，用户可以重新申请
          const message = `微信退款被拒（${error.wechatCode ?? error.kind}），请联系客服处理。`;

          this.logger.error(`退款被微信拒绝 refundNo=${refund.refundNo} code=${error.wechatCode ?? 'unknown'}`);

          return this.failRefund(refund, order, message, true);
        }

        // 结果未知（超时/网络/5xx/限流）：**保持处理中**，交由对账任务查询真实结果
        this.logger.warn(`退款结果未知，保持处理中 refundNo=${refund.refundNo} kind=${error.kind}: ${error.message}`);

        return this.reloadRefund(refund.id);
      }

      // 未分类异常同样按"结果未知"处理，绝不写 FAILED
      this.logger.error(
        `退款调用异常（保持处理中）refundNo=${refund.refundNo}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return this.reloadRefund(refund.id);
    }

    const settlement = refundSettlementOfWechatState(wechat.status);

    if (settlement === 'SUCCESS') {
      return this.settleRefundSuccess(refund, order, wechat, {
        revokeEntitlement: this.shouldRevoke(refund, order, options?.revokeEntitlement),
      });
    }

    if (settlement === 'FAILED') {
      return this.failRefund(refund, order, wechatRefundFailureReason(wechat.status), true);
    }

    // PROCESSING / UNKNOWN：微信已受理但未出款，等对账任务
    await this.persistWechatRefund(refund.id, wechat, 'PENDING');

    return this.reloadRefund(refund.id);
  }

  /**
   * 是否回收权益
   *
   * 默认按「全额退款即回收」：部分退款（补偿场景）不回收，否则用户既拿了退款
   * 又失去权益，相当于双重处罚。管理员可以通过 `revokeEntitlement` 显式覆盖。
   */
  private shouldRevoke(refund: Refund, order: Order, explicit?: boolean): boolean {
    if (explicit !== undefined) return explicit;

    const meta = readRefundMeta(refund.notifyPayload);

    // 管理员发起的部分退款默认不回收（契约 §3.14.6.3 规则 3）
    if (meta?.operator === 'ADMIN' && meta.refundType === 'PARTIAL') return false;

    return refund.refundAmount >= order.paidAmount;
  }

  /** 结算为成功：改退款单 + 改订单状态 + 回收权益 + 写发件箱（同一事务） */
  private async settleRefundSuccess(
    refund: Refund,
    order: Order,
    wechat: WechatPayRefundResult,
    options: { revokeEntitlement: boolean },
  ): Promise<Refund> {
    const now = new Date();
    const meta = readRefundMeta(refund.notifyPayload) ?? emptyRefundMeta('SYSTEM', 'FULL');

    // `refunds.refund_id` 有唯一约束：若该微信退款单号已被另一行占用（数据异常），
    // 直接写会抛 P2002 并把整个事务回滚 —— 而这是**微信已经出款成功之后**，
    // 回滚会让我们把一次成功的退款记成失败/处理中。因此先探测占用情况，
    // 冲突时只跳过写入该列并告警，资金状态照常结算。
    const wechatRefundId = await this.resolveWritableWechatRefundId(refund, wechat.wechatRefundId);

    const revoked = await this.prisma.$transaction(async (tx) => {
      // 条件更新 PENDING → SUCCESS：与 `failRefund` 互为排他，并发对账时只会有一方成功
      const updated = await tx.refund.updateMany({
        where: { id: refund.id, status: 'PENDING' },
        data: {
          status: 'SUCCESS',
          successTime: wechat.successTime === null ? now : new Date(wechat.successTime),
          ...(wechatRefundId === null ? {} : { refundId: wechatRefundId }),
          errorCode: null,
          errorMessage: null,
          notifyPayload: withRefundMeta(refund.notifyPayload, meta) as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        this.logger.warn(`退款已被并发结算，跳过 refundNo=${refund.refundNo}`);

        return null;
      }

      const fresh = await tx.order.findUnique({
        where: { id: order.id },
        select: { refundedAmount: true, paidAmount: true, status: true },
      });

      // 预留时已经加过金额，这里**只改状态**，绝不再次累加
      const totalRefunded = fresh?.refundedAmount ?? order.refundedAmount;
      const nextStatus = orderStatusAfterRefund(totalRefunded, fresh?.paidAmount ?? order.paidAmount);

      await tx.order.updateMany({
        where: { id: order.id, deletedAt: null, status: { in: [...REFUNDABLE_STATUSES, 'REFUNDED'] } },
        data: { status: nextStatus, version: { increment: 1 } },
      });

      if (nextStatus === 'REFUNDED') {
        // 全额退款：支付单同步进入 `REFUNDED`，便于对账时一眼区分
        await tx.payment.updateMany({
          where: { id: refund.paymentId, status: 'SUCCESS' },
          data: { status: 'REFUNDED', version: { increment: 1 } },
        });
      }

      const revokedEntitlements = options.revokeEntitlement
        ? await this.revokeOrderEntitlements(tx, order.id, `订单 ${order.orderNo} 退款成功`)
        : [];

      await tx.refund.update({
        where: { id: refund.id },
        data: {
          notifyPayload: withRefundMeta(
            { ...(readRefundPayload(refund.notifyPayload) ?? {}), wechatRefund: wechat.raw },
            {
              ...meta,
              entitlementRevoked: revokedEntitlements.length > 0,
              revokedEntitlementIds: revokedEntitlements.map((item) => item.id),
            },
          ) as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });

      return revokedEntitlements;
    });

    // 发件箱在事务之外：`outbox_events` 的唯一键保证同一退款只入队一次，
    // 写失败也不该回滚已经完成的资金操作
    await this.writeOutbox(
      'order.refunded',
      'order',
      order.id,
      {
        orderId: order.id,
        orderNo: order.orderNo,
        userId: order.userId,
        refundNo: refund.refundNo,
        refundAmount: refund.refundAmount,
        entitlementRevoked: (revoked?.length ?? 0) > 0,
      },
      `order.refunded:${refund.id}`,
    );

    this.logger.log(
      `退款成功 refundNo=${refund.refundNo} orderNo=${order.orderNo} amount=${String(refund.refundAmount)} revoked=${String(revoked?.length ?? 0)}`,
    );

    return this.reloadRefund(refund.id);
  }

  /** 结算为失败：改退款单 + **释放预留额度**（同一事务、条件更新保证只释放一次） */
  private async failRefund(refund: Refund, order: Order, reason: string, releaseReservation: boolean): Promise<Refund> {
    const message = composeRefundFailureReason(reason);

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.refund.updateMany({
        where: { id: refund.id, status: 'PENDING' },
        data: { status: 'FAILED', errorMessage: message, version: { increment: 1 } },
      });

      // 已被并发结算成 SUCCESS：**绝不**释放额度，否则会凭空多出可退金额
      if (updated.count === 0) {
        this.logger.warn(`退款已终结，跳过失败结算与额度释放 refundNo=${refund.refundNo}`);

        return;
      }

      if (!releaseReservation) return;

      await tx.order.updateMany({
        where: { id: order.id, refundedAmount: { gte: refund.refundAmount } },
        data: { refundedAmount: { decrement: refund.refundAmount }, version: { increment: 1 } },
      });
    });

    this.logger.warn(`退款失败 refundNo=${refund.refundNo} reason=${message}`);

    return this.reloadRefund(refund.id);
  }

  /** 把微信返回的退款单号/状态写回本地（不改变本地状态机） */
  private async persistWechatRefund(refundId: string, wechat: WechatPayRefundResult, status: 'PENDING'): Promise<void> {
    try {
      const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
      const writable = refund === null ? null : await this.resolveWritableWechatRefundId(refund, wechat.wechatRefundId);

      await this.prisma.refund.updateMany({
        where: { id: refundId, status },
        data: { ...(writable === null ? {} : { refundId: writable }), version: { increment: 1 } },
      });
    } catch (error) {
      // 只是回写微信单号，失败不影响"退款处理中"这个事实，交由对账任务补齐
      this.logger.warn(
        `回写微信退款单号失败 refundId=${refundId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 判断微信退款单号是否可以安全写入 `refunds.refund_id`
   *
   * 该列有唯一约束。异常情况下（同一微信退款单号出现在两笔本地退款单上），
   * 直接写会抛 P2002 并回滚整个结算事务 —— 而那时钱已经出款，
   * 回滚等于把成功记成失败。此时选择**只跳过这一列**并告警。
   */
  private async resolveWritableWechatRefundId(refund: Refund, wechatRefundId: string | null): Promise<string | null> {
    if (wechatRefundId === null) return null;
    if (refund.refundId === wechatRefundId) return wechatRefundId;

    const owner = await this.prisma.refund.findUnique({
      where: { refundId: wechatRefundId },
      select: { id: true, refundNo: true },
    });

    if (owner === null || owner.id === refund.id) return wechatRefundId;

    this.logger.error(
      `【数据异常】微信退款单号已被占用，已跳过写入 refundNo=${refund.refundNo} 占用方=${owner.refundNo} wechatRefundId=${wechatRefundId}`,
    );

    return null;
  }

  /**
   * 撤销某订单关联的权益（契约 §3.9.10 规则 4）
   *
   * 按 `orderId` 圈定而不是按 `userId`：用户可能同时持有多笔订单带来的权益，
   * 按用户回收会把**没退款的那单**的权益也一起收走。
   *
   * `ACTIVE` 与 `CONSUMED` 都要处理：报告解锁的权益在使用后状态是 `CONSUMED`，
   * 但契约要求退款后「报告重新变为未解锁」，因此不能只回收 `ACTIVE`。
   */
  private async revokeOrderEntitlements(
    tx: Pick<PrismaService, 'entitlement' | 'membership'>,
    orderId: string,
    reason: string,
  ): Promise<Entitlement[]> {
    const targets = await tx.entitlement.findMany({
      where: { orderId, deletedAt: null, status: { in: ['ACTIVE', 'CONSUMED'] } },
      select: { id: true },
    });

    if (targets.length === 0) return [];

    const ids = targets.map((item) => item.id);
    const now = new Date();

    const affected = await tx.entitlement.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });

    await tx.entitlement.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'REVOKED',
        revokedAt: now,
        revokeReason: reason.slice(0, 256),
        version: { increment: 1 },
      },
    });

    // 会员实例同步取消：`memberships` 与 `entitlements` 是两份表达，
    // 只改一份会留下「权益已撤销但会员记录仍是 ACTIVE」的矛盾数据
    await tx.membership.updateMany({
      where: { orderId, deletedAt: null, status: 'ACTIVE' },
      data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason.slice(0, 256), version: { increment: 1 } },
    });

    this.logger.log(`退款已撤销权益 orderId=${orderId} count=${String(affected.length)}`);

    return affected;
  }

  // ==========================================================================
  // 内部：取数与装配
  // ==========================================================================

  private async findOwnedOrder(userId: string, orderId: string): Promise<Order> {
    if (!UUID_PATTERN.test(orderId)) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'id 必须是合法 UUID');
    }

    const order = await this.prisma.order.findFirst({ where: { id: orderId, deletedAt: null } });

    if (order === null) throw BusinessException.notFound(ErrorCode.ORDER_NOT_FOUND, '订单不存在');

    if (order.userId !== userId) {
      this.logger.warn(`【安全】越权申请退款 userId=${userId} orderId=${order.id} ownerId=${order.userId}`);

      throw BusinessException.forbidden(ErrorCode.ORDER_NOT_OWNED, '无权访问该订单');
    }

    return order;
  }

  private async findOrderById(orderId: string): Promise<Order> {
    if (!UUID_PATTERN.test(orderId)) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'id 必须是合法 UUID');
    }

    const order = await this.prisma.order.findFirst({ where: { id: orderId, deletedAt: null } });

    if (order === null) throw BusinessException.notFound(ErrorCode.ORDER_NOT_FOUND, '订单不存在');

    return order;
  }

  private loadOrderEntitlements(orderId: string): Promise<Entitlement[]> {
    return this.prisma.entitlement.findMany({ where: { orderId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  }

  private async reloadOrder(orderId: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (order === null) throw BusinessException.notFound(ErrorCode.ORDER_NOT_FOUND, '订单不存在');

    return order;
  }

  private async reloadRefund(refundId: string): Promise<Refund> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (refund === null) throw BusinessException.notFound(ErrorCode.RESOURCE_NOT_FOUND, '退款记录不存在');

    return refund;
  }

  /**
   * 取（必要时补建）支付单
   *
   * `refunds.payment_id` 是**非空外键**，没有支付单行就无法创建退款记录。
   * 而当前仓库没有任何代码写入 `payments`（下单只拿到 `prepayId` 就结束），
   * 因此这里必须兜底补建 —— 否则「用户付了钱要退款」会以数据库外键错误收场。
   * 正确做法是在下单时建 `INIT` 支付单（已列入简报的待接线清单）。
   */
  private async ensurePayment(order: Order): Promise<Payment> {
    const existing = await this.prisma.payment.findFirst({
      where: { orderId: order.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (existing !== null) return existing;

    try {
      return await this.prisma.payment.create({
        data: {
          orderId: order.id,
          userId: order.userId,
          outTradeNo: order.orderNo,
          channel: order.payChannel ?? 'WECHAT_JSAPI',
          status: 'SUCCESS',
          amount: order.paidAmount,
          payerAmount: order.paidAmount,
          currency: order.currency,
          successTime: order.paidAt,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        // 并发补建：另一条路径已经建好了
        const raced = await this.prisma.payment.findUnique({ where: { outTradeNo: order.orderNo } });
        if (raced !== null) return raced;
      }

      this.logger.error(
        `补建支付单失败 orderNo=${order.orderNo}: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw BusinessException.internal(ErrorCode.INTERNAL_ERROR, '退款暂时不可用，请联系客服');
    }
  }

  private toUserApplyView(order: Order, refund: Refund): UserRefundApplyView {
    const meta = readRefundMeta(refund.notifyPayload);
    const refundType = meta?.refundType ?? refundTypeOf(refund.refundAmount, order.paidAmount);
    const appliedAt = refund.createdAt.toISOString();

    if (refund.status === 'PENDING') {
      const requiresReview = meta?.requiresReview ?? true;

      return {
        refundId: refund.id,
        refundNo: refund.refundNo,
        orderId: order.id,
        orderNo: order.orderNo,
        status: refund.status,
        statusLabel: refundStatusLabel(refund.status),
        refundType,
        refundAmount: refund.refundAmount,
        currency: refund.currency,
        reason: refund.reason ?? '',
        description: meta?.description ?? null,
        requiresReview,
        reviewHint: requiresReview
          ? '客服将在 24 小时内处理，处理结果会通过站内通知与订阅消息告知。'
          : '退款已提交微信处理，结果将在几分钟内更新。',
        appliedAt,
        estimatedProcessHours: 24,
        entitlementRevoked: meta?.entitlementRevoked ?? false,
        entitlementRevokeNote: '退款成功后，对应的会员权益或报告解锁将被撤销。',
        nextAction: { canCancel: true, cancelDeadline: refundCancelDeadline(refund.createdAt).toISOString() },
      };
    }

    return {
      refundId: refund.id,
      refundNo: refund.refundNo,
      orderId: order.id,
      orderNo: order.orderNo,
      status: refund.status,
      statusLabel: refundStatusLabel(refund.status),
      refundType,
      refundAmount: refund.refundAmount,
      currency: refund.currency,
      reason: refund.reason ?? '',
      requiresReview: meta?.requiresReview ?? false,
      wechatRefundId: refund.refundId,
      wechatRefundStatus: refund.status === 'SUCCESS' ? 'SUCCESS' : (refund.errorCode ?? null),
      appliedAt,
      succeededAt: refund.successTime?.toISOString() ?? null,
      failedReason: refund.errorMessage,
      orderStatus: order.status,
      entitlementRevoked: meta?.entitlementRevoked ?? false,
      revokedEntitlementIds: [...(meta?.revokedEntitlementIds ?? [])],
      arrivalNotice: refund.status === 'SUCCESS' ? REFUND_ARRIVAL_NOTICE : null,
      nextAction: { canCancel: false, cancelDeadline: null },
    };
  }

  private toListItem(row: Refund & { order: { orderNo: string; paidAmount: number } }): RefundListItem {
    const meta = readRefundMeta(row.notifyPayload);

    return {
      refundId: row.id,
      refundNo: row.refundNo,
      orderId: row.orderId,
      orderNo: row.order.orderNo,
      status: row.status,
      statusLabel: refundStatusLabel(row.status),
      refundAmount: row.refundAmount,
      currency: row.currency,
      refundType: meta?.refundType ?? refundTypeOf(row.refundAmount, row.order.paidAmount),
      reason: row.reason,
      wechatRefundId: row.refundId,
      wechatRefundStatus: wechatRefundStatusOf(row),
      appliedAt: row.createdAt.toISOString(),
      succeededAt: row.successTime?.toISOString() ?? null,
      failedReason: row.errorMessage,
      entitlementRevoked: meta?.entitlementRevoked ?? false,
      revokedEntitlementIds: [...(meta?.revokedEntitlementIds ?? [])],
      arrivalNotice: row.status === 'SUCCESS' ? REFUND_ARRIVAL_NOTICE : null,
      // 历史/异常数据缺失元数据时回落为 `SYSTEM`：`USER` 会让人以为是用户主动申请的
      operator: meta?.operator ?? (row.operatorAdminId === null ? 'SYSTEM' : 'ADMIN'),
    };
  }

  private toAdminView(params: {
    order: Order;
    refund: Refund;
    previousRefundedAmount: number;
    adminId: string;
    adminDisplayName: string;
    auditLogId: string | null;
    revokedEntitlements: readonly Entitlement[];
  }): AdminRefundView {
    const { order, refund } = params;
    const meta = readRefundMeta(refund.notifyPayload);

    return {
      refundId: refund.id,
      refundNo: refund.refundNo,
      orderId: order.id,
      orderNo: order.orderNo,
      status: refund.status,
      statusLabel: refundStatusLabel(refund.status),
      refundType: meta?.refundType ?? refundTypeOf(refund.refundAmount, order.paidAmount),
      refundAmount: refund.refundAmount,
      previousRefundedAmount: params.previousRefundedAmount,
      totalRefundedAmount: order.refundedAmount,
      refundableAmountAfter: computeRefundableAmount(order.paidAmount, order.refundedAmount),
      currency: refund.currency,
      reason: refund.reason ?? '',
      internalNote: meta?.internalNote ?? null,
      ticketId: meta?.ticketId ?? null,
      wechatRefundId: refund.refundId,
      wechatRefundStatus: wechatRefundStatusOf(refund),
      orderStatus: order.status,
      entitlementRevoked: meta?.entitlementRevoked ?? false,
      revokedEntitlements: params.revokedEntitlements.map((entitlement) => ({
        entitlementId: entitlement.id,
        type: entitlement.type,
        // `entitlements` 表没有状态变更流水，退款前的状态无从还原；
        // 能进入退款流程说明它当时是"可用"的，因此如实填 `ACTIVE`
        // （`CONSUMED` 的情况无法区分 —— 需补状态流水表才能精确）
        previousStatus: 'ACTIVE',
        newStatus: entitlement.status,
        resourceId: entitlement.reportId ?? entitlement.relationshipId ?? null,
      })),
      // 通知渠道（订阅消息 / 站内信）由 notification 域实现，本模块只写 `outbox_event`；
      // 因此这里如实返回 `false`，🚫 不谎报"已通知"
      userNotified: false,
      appliedAt: refund.createdAt.toISOString(),
      succeededAt: refund.successTime?.toISOString() ?? null,
      failedReason: refund.errorMessage,
      operator: { adminId: params.adminId, displayName: params.adminDisplayName },
      auditLogId: params.auditLogId,
      reconciliation: {
        isReconciled: refund.status === 'SUCCESS',
        note:
          refund.status === 'SUCCESS'
            ? '退款金额与微信侧一致，对账通过'
            : refund.status === 'PENDING'
              ? '微信仍在处理，结果由退款对账任务更新'
              : '退款未成功，未产生出款',
      },
    };
  }

  /** 取本次退款撤销掉的权益（用于管理端响应的 `revokedEntitlements`） */
  private async loadRevokedEntitlements(refund: Refund): Promise<Entitlement[]> {
    const meta = readRefundMeta(refund.notifyPayload);
    const ids = meta?.revokedEntitlementIds ?? [];

    if (ids.length === 0) return [];

    return this.prisma.entitlement.findMany({ where: { id: { in: [...ids] } }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * 出款异常时的退款审计（**失败也要留痕**）
   *
   * 与 `writeAdminAudit` 分开的原因：那条路径读的是结算**之后**的退款单与订单，
   * 而出款抛错时结算根本没发生 —— 此时要记录的是"谁在什么时候试图对哪笔订单退款、
   * 失败原因是什么"。
   *
   * 四处刻意的取舍：
   *   ① 重新读库而不是用入参对象：出款过程可能已经写过状态（例如微信明确拒绝后
   *      `failRefund` 会把退款单置 `FAILED`、释放预留额度），读库才能记下真实状态；
   *   ② **读不到就退回入参对象**（`fallback*`），不允许"因为读库失败而整条不写"：
   *      出款异常 + 数据库抖动是最需要证据的组合，此时若还强依赖读库，
   *      结果就是只剩一行 error 日志、`admin_audit_logs` 依旧 0 条；
   *   ③ 全程 try/catch 且**不向外抛**：审计写失败不能顶替掉原始异常，
   *      否则排障看到的是"审计表写不进去"，而真正的问题在出款；
   *   ④ `payoutReturned` 决定成败口径 —— 出款没返回时退款单往往是 `PENDING`
   *      （"结果未知"按资金安全要求不置 `FAILED`），沿用按状态推断会被记成成功，
   *      而这条审计的意义正是标注"这次尝试失败了"，故强标 `success=false`；
   *      出款**已经返回**、失败发生在结算后回读时，退款单可能已是 `SUCCESS`，
   *      那就不能把一次成功的退款记成失败，只把错误追加进摘要。
   */
  private async auditAdminRefundFailure(params: {
    adminUserId: string;
    adminUsername: string;
    fallbackOrder: Order;
    fallbackRefund: Refund;
    payoutReturned: boolean;
    beforeRefundedAmount: number;
    ctx: RefundRequestContext;
    isForced: boolean;
    ticketId: string | null;
    error: unknown;
  }): Promise<void> {
    const message = params.error instanceof Error ? params.error.message : String(params.error);

    try {
      const [order, refund] = await Promise.all([
        this.reloadOrder(params.fallbackOrder.id).catch(() => params.fallbackOrder),
        this.reloadRefund(params.fallbackRefund.id).catch(() => params.fallbackRefund),
      ]);

      await this.writeAdminAudit({
        adminUserId: params.adminUserId,
        adminUsername: params.adminUsername,
        order,
        refund,
        beforeRefundedAmount: params.beforeRefundedAmount,
        ctx: params.ctx,
        isForced: params.isForced,
        ticketId: params.ticketId,
        ...(params.payoutReturned
          ? { note: `结算后处理失败：${message}` }
          : { failure: { errorCode: readErrorCode(params.error), message } }),
      });
    } catch (auditError) {
      this.logger.error(
        `写退款失败审计也失败 refundId=${params.fallbackRefund.id}: ${
          auditError instanceof Error ? auditError.message : String(auditError)
        }`,
      );
    }
  }

  /**
   * 管理端退款审计
   *
   * 契约要求响应里带 `auditLogId`，而 `AdminAuditService.log()` 只返回布尔值，
   * 因此这里直接写表以拿到 ID。**审计失败不影响退款结果**（钱已经退出去的
   * 事实不会因为审计表写不进去而改变），但会打 error 日志供运维发现审计链路故障。
   *
   * `failure` 非空表示这次是**出款异常**的记录（见 `auditAdminRefundFailure`）：
   * 此时 `success` 强制定为 `false` 并落 `errorCode`，其余字段照常记录。
   *
   * `note` 用于"业务成功但过程有异常"（例如出款已成功、结算后回读失败）：
   * 只往摘要里追加说明，**不**改变按状态推断的 `success` —— 把成功记成失败
   * 会让对账的人去追一笔根本没出问题的钱。
   */
  private async writeAdminAudit(params: {
    adminUserId: string;
    adminUsername: string;
    order: Order;
    refund: Refund;
    beforeRefundedAmount: number;
    ctx: RefundRequestContext;
    isForced: boolean;
    ticketId: string | null;
    failure?: { errorCode: number | null; message: string };
    note?: string;
  }): Promise<string | null> {
    const amountText = `退款 ${String(params.refund.refundAmount)} 分（${params.refund.refundNo}）`;
    // `diff_summary` 是 VarChar(1024)：错误消息不可控（可能带上游整段报文），必须截断
    const diffSummary = (
      params.failure === undefined
        ? `${amountText} → ${params.refund.status}${params.note === undefined ? '' : `；${params.note}`}`
        : `${amountText} 执行失败：${params.failure.message}`
    ).slice(0, 1024);
    const failureCode = params.failure?.errorCode ?? null;

    try {
      const row = await this.prisma.adminAuditLog.create({
        data: {
          adminUserId: params.adminUserId,
          adminUsername: params.adminUsername,
          action: 'REFUND',
          resourceType: 'order',
          resourceId: params.order.id,
          targetUserId: params.order.userId,
          beforeData: {
            orderStatus: params.order.status,
            refundedAmount: params.beforeRefundedAmount,
          },
          afterData: {
            refundNo: params.refund.refundNo,
            refundStatus: params.refund.status,
            refundAmount: params.refund.refundAmount,
            refundedAmount: params.order.refundedAmount,
            isForced: params.isForced,
          },
          diffSummary,
          reason: params.refund.reason ?? null,
          ip: params.ctx.ip ?? null,
          userAgent: params.ctx.userAgent ?? null,
          requestId: params.ctx.requestId ?? null,
          success: params.failure === undefined && params.refund.status !== 'FAILED',
          errorCode: failureCode === null ? null : String(failureCode),
        },
        select: { id: true },
      });

      return row.id;
    } catch (error) {
      this.logger.error(
        `写退款审计失败 refundNo=${params.refund.refundNo}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  /** 事务性发件箱（唯一键保证同一事件只入队一次，冲突视为幂等命中） */
  private async writeOutbox(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Prisma.InputJsonObject,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      await this.prisma.outboxEvent.create({
        data: { eventType, aggregateType, aggregateId, payload, idempotencyKey },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return;

      this.logger.error(
        `写发件箱失败 key=${idempotencyKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** UUID 形态判定 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 从异常里取业务错误码（取不到返回 `null`）
 *
 * 用于把"出款为什么失败"写进审计的 `error_code` 列。判定顺序与
 * `report-generation.service.ts` / `chat-message.service.ts` 的同名函数一致：
 * 先认 `BusinessException.code`，再认结构化对象的数字 `code`（异常可能被
 * 拦截器或 SDK 包装过，读 `code` 比 `instanceof` 稳；`isUniqueConstraintError`
 * 判定 Prisma 冲突时也是同一思路）。
 *
 * 这里刻意**不**跨模块 import 那两份：payment 去依赖 ai 模块的内部工具会把
 * 资金链路与 AI 链路耦在一起。三份副本的收敛单独做（与 `common/utils/uuid.util.ts`
 * 文件头记的 UUID 正则收敛是同一批待办）。
 */
const readErrorCode = (error: unknown): number | null => {
  if (error instanceof BusinessException) return error.code;

  if (typeof error === 'object' && error !== null) {
    const raw = (error as { code?: unknown }).code;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }

  return null;
};

/** Prisma 唯一约束冲突判定 */
const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * 微信退款状态（列表/详情展示用）
 *
 * `refunds` 表没有独立的微信状态列，只有本地状态；`error_code` 在失败时会被写入
 * 微信错误码，因此用它区分「接口返回异常」。不凭空造 `SUCCESS`：只有本地
 * `SUCCESS`（即微信明确返回成功）才回 `SUCCESS`。
 */
const wechatRefundStatusOf = (refund: Refund): string | null => {
  if (refund.status === 'SUCCESS') return 'SUCCESS';
  if (refund.status === 'PENDING') return 'PROCESSING';
  if (refund.status === 'FAILED') return refund.errorCode ?? 'ABNORMAL';

  return null;
};

/** 读取 `notify_payload` 的原始对象（保留其中的微信报文等其它键） */
const readRefundPayload = (payload: unknown): Record<string, unknown> | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  return payload as Record<string, unknown>;
};
