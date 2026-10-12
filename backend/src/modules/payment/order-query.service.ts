/**
 * 用户端订单查询与状态流转服务（契约 §3.9.3 ~ §3.9.7）
 *
 * ## 归属校验是**强过滤**，不是"查完再比"
 *
 * 所有查询的 `where` 都强制带 `userId = currentUser.id`（架构 §14.1）。
 * 「先按 ID 查到再比对 userId」的写法在加了缓存、批量取数或分页之后极易被改坏，
 * 而它的失效方式正是最严重的 IDOR（用户能读到他人订单的金额与微信交易号）。
 *
 * 详情接口需要区分「不存在」与「不是你的」，因此单独查一次再比 —— 但**必须记
 * 安全探测日志**（契约 §3.9.4 明确要求），否则横向越权尝试在日志里完全不可见。
 *
 * ## 主动查单是**补偿链路**，不是"再查一次"
 *
 * 正常路径由微信回调驱动；本接口承担的是「回调丢失导致付了没给货」（架构 §13.2
 * 硬性要求 4 / 风险 R6）。因此它必须做三件回调同样要做的事：
 *   ① 只有微信明确 `SUCCESS` 才发货（🚫 不做乐观发放）
 *   ② 金额与本地订单**逐分比对**，不一致即风控告警且**不发货**
 *   ③ 发货走与回调**完全相同**的幂等状态推进（`PaymentService.fulfillPaidOrder`），
 *      而不是在查询服务里另写一套 —— 两套发货逻辑必然会在某次改动后不一致
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Entitlement, Order, OrderStatus, Prisma, Refund } from '@prisma/client';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { WechatPayApiError, WechatPayService } from '../../infra/wechat/wechat-pay.service';
import { buildOrderCoreView, latestPayment, latestRefundSuccessAt } from '../admin/order/admin-order.util';
import { ListOrdersQueryDto, type OrderSortField, type OrderSortOrder } from './order-query.dto';
import {
  buildOrderProductSnapshotView,
  buildOrderTimelineView,
  buildPaginatedView,
  computeRefundableAmount,
  computeRemainingSeconds,
  deriveOrderActionFlags,
  isOrderExpired,
  orderStatusDescription,
  orderStatusLabel,
} from './order-query.util';
import { enforceRateLimit } from './payment-rate-limit.util';
import { PaymentService } from './payment.service';
import { normalizeCloseReason, refundStatusLabel, type CloseReason } from './refund.util';

/** UUID 形态（v4/v7 均匹配） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 订单号形态（`order.util.ts` 的 `generateOrderNo` 产物） */
const ORDER_NO_PATTERN = /^SM\d{18}$/;

/** 未支付状态（可取消 / 可关单 / 可查单补偿） */
const UNPAID_STATUSES: readonly OrderStatus[] = ['CREATED', 'PENDING_PAY'];

/** 主动查单的限流（契约 §3.9.5：userId + orderId 10 次/10min） */
const QUERY_RATE_LIMIT = 10;
const QUERY_RATE_TTL_SECONDS = 600;

/** 查单节流缓存 TTL（契约 §3.9.5 规则 3：30s 内直接返回上次结果） */
const QUERY_CACHE_TTL_SECONDS = 30;

/** 取消/关单的限流（契约 §3.9.6 / §3.9.7：userId 20 次/60min） */
const CANCEL_RATE_LIMIT = 20;
const CANCEL_RATE_TTL_SECONDS = 3_600;

/** 超时关单单次扫描的最大批次数（防止一次任务把连接池占满） */
const EXPIRE_SCAN_MAX_BATCHES = 5;

/** 列表条目（契约 §3.9.3 的 `items[]`） */
export interface UserOrderListItem {
  orderId: string;
  orderNo: string;
  status: string;
  statusLabel: string;
  productCode: string | null;
  productName: string | null;
  productType: string;
  quantity: number;
  amount: number;
  payAmount: number;
  currency: string;
  targetResourceId: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  expiredAt: string;
  closedAt: string | null;
  cancelledAt: string | null;
  refundedAmount: number;
  refundStatus: string | null;
  entitlements: Array<{ entitlementId: string; type: string; status: string; expiresAt: string | null }>;
  canRefund: boolean;
  canQuery: boolean;
  payMethod: string | null;
  transactionId: string | null;
}

/** 列表摘要（契约 §3.9.3 的 `summary`，**仅这六个字段**） */
export interface UserOrderSummary {
  totalOrders: number;
  paidOrders: number;
  pendingOrders: number;
  closedOrders: number;
  totalPaidAmount: number;
  totalRefundedAmount: number;
}

/** 列表响应 */
export interface UserOrderListView {
  items: UserOrderListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: UserOrderSummary;
}

/** 详情里的 `payment` 块（契约 §3.9.4） */
export interface UserOrderPaymentView {
  paymentId: string;
  outTradeNo: string;
  transactionId: string | null;
  prepayId: string | null;
  status: string;
  amount: number;
  payerTotal: number | null;
  /**
   * 契约要求返回**脱敏后的支付者标识**，但 `payments` 表没有 openid 列
   * （只有 `appid` / `mchid` / `bankType` / `tradeState`）。
   * 固定返回 `null` 而不是拿别的字段顶替 —— 凭空造一个"支付者标识"
   * 会在对账排查时把人引到错误的方向。
   */
  payerOpenid: null;
  tradeType: string | null;
  bankType: string | null;
  paidAt: string | null;
  notifyReceivedAt: string | null;
  notifyCount: number;
  isReconciled: null;
}

/** 详情响应（契约 §3.9.4） */
export interface UserOrderDetailView {
  orderId: string;
  orderNo: string;
  userId: string;
  status: string;
  statusLabel: string;
  statusDescription: string;
  productCode: string | null;
  productName: string | null;
  productType: string;
  productSnapshot: ReturnType<typeof buildOrderProductSnapshotView>;
  quantity: number;
  amount: number;
  payAmount: number;
  originalAmount: number;
  discountAmount: number;
  currency: string;
  targetResourceId: string | null;
  payMethod: string | null;
  wechatPayEnv: string;
  payment: UserOrderPaymentView | null;
  entitlements: Array<{
    entitlementId: string;
    type: string;
    status: string;
    grantedAt: string;
    expiresAt: string | null;
    remainingCount: number | null;
    resourceId: string | null;
  }>;
  refunds: Array<{
    refundId: string;
    refundNo: string;
    status: string;
    statusLabel: string;
    refundAmount: number;
    reason: string | null;
    succeededAt: string | null;
    failedReason: string | null;
  }>;
  refundedAmount: number;
  refundableAmount: number;
  timeline: ReturnType<typeof buildOrderTimelineView>;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  expiredAt: string;
  closedAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  remainingSeconds: number;
  isExpired: boolean;
  canPay: boolean;
  canCancel: boolean;
  canClose: boolean;
  canQuery: boolean;
  canRefund: boolean;
  serverTime: string;
}

/** 主动查单响应（契约 §3.9.5） */
export interface QueryOrderResultView {
  orderId: string;
  orderNo: string;
  previousStatus: string;
  currentStatus: string;
  wechatTradeState: string;
  wechatTradeStateDesc: string | null;
  transactionId: string | null;
  paidAt: string | null;
  localUpdated: boolean;
  entitlementGranted: boolean;
  entitlement: { entitlementId: string; type: string; grantedAt: string; expiresAt: string | null } | null;
  outboxEventId: string | null;
  queriedAt: string;
  note: string;
  nextActions: { shouldPollAgain: boolean; pollAfterMs: number | null };
}

/** 取消响应（契约 §3.9.6） */
export interface CancelOrderResultView {
  orderId: string;
  orderNo: string;
  previousStatus: string;
  status: string;
  statusLabel: string;
  reason: string;
  cancelledAt: string | null;
  wechatOrderClosed: boolean;
  note: string;
}

/** 关单响应（契约 §3.9.7） */
export interface CloseOrderResultView {
  orderId: string;
  orderNo: string;
  previousStatus: string;
  status: string;
  statusLabel: string;
  closeReason: CloseReason;
  closedAt: string | null;
  expiredAt: string;
  wechatOrderClosed: boolean;
  canRecreateOrder: boolean;
  recreateHint: string;
}

/** 超时关单批次结果（供队列处理器记录指标） */
export interface CloseExpiredOrdersResult {
  scanned: number;
  closed: number;
  wechatClosed: number;
  wechatFailed: number;
}

@Injectable()
export class OrderQueryService {
  private readonly logger = new Logger(OrderQueryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wechatPay: WechatPayService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly payments: PaymentService,
  ) {}

  // ==========================================================================
  // GET /orders
  // ==========================================================================

  async listOrders(userId: string, query: ListOrdersQueryDto): Promise<UserOrderListView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.OrderWhereInput = { userId, deletedAt: null };

    if (query.status !== undefined && query.status.length > 0) {
      where.status = { in: query.status as OrderStatus[] };
    }

    if (query.type !== undefined) {
      where.productType = query.type;
    }

    if (query.startTime !== undefined || query.endTime !== undefined) {
      where.createdAt = {
        ...(query.startTime !== undefined ? { gte: new Date(query.startTime) } : {}),
        ...(query.endTime !== undefined ? { lte: new Date(query.endTime) } : {}),
      };
    }

    const [rows, total, statusBuckets] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: this.buildOrderBy(query.sortBy ?? 'createdAt', query.order ?? 'desc'),
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { product: { select: { code: true, name: true } } },
      }),
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { paidAmount: true, refundedAmount: true },
      }),
    ]);

    const orderIds = rows.map((row) => row.id);
    const [entitlementsByOrder, transactionIds, refundStatusByOrder] = await Promise.all([
      this.loadEntitlements(orderIds),
      this.loadTransactionIds(orderIds),
      this.loadLatestRefundStatus(orderIds),
    ]);

    const now = new Date();
    const items = rows.map((row) =>
      this.toListItem(
        row,
        entitlementsByOrder.get(row.id) ?? [],
        transactionIds.get(row.id) ?? null,
        refundStatusByOrder.get(row.id) ?? null,
        now,
      ),
    );

    return {
      ...buildPaginatedView(items, total, page, pageSize),
      summary: this.buildSummary(statusBuckets),
    };
  }

  // ==========================================================================
  // GET /orders/{id}
  // ==========================================================================

  async getOrderDetail(
    userId: string,
    idOrNo: string,
    byNo: boolean,
    includeRefunds: boolean,
  ): Promise<UserOrderDetailView> {
    const order = await this.findOwnedOrder(userId, idOrNo, byNo);

    const [entitlements, payments, refunds] = await Promise.all([
      this.prisma.entitlement.findMany({
        where: { orderId: order.id, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.payment.findMany({ where: { orderId: order.id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
      this.prisma.refund.findMany({ where: { orderId: order.id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);

    const now = new Date();
    const payment = latestPayment(payments);
    const refundedAmount = order.refundedAmount;
    const refundableAmount = computeRefundableAmount(order.paidAmount, refundedAmount);
    const core = buildOrderCoreView({
      order,
      product: await this.loadProductName(order.productId),
      refundedAt: latestRefundSuccessAt(refunds),
      wechatPayEnv: this.configService.get('wechatPay.env', { infer: true }),
    });

    const entitlementInputs = entitlements.map((entitlement) => ({
      status: entitlement.status,
      usedQuota: entitlement.usedQuota,
    }));

    const actions = deriveOrderActionFlags({
      status: order.status,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
      refundableAmount,
      entitlements: entitlementInputs,
      now,
    });

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      userId: order.userId,
      status: order.status,
      statusLabel: orderStatusLabel(order.status),
      statusDescription: orderStatusDescription(order.status),
      productCode: core.productCode,
      productName: core.productName,
      productType: order.productType,
      productSnapshot: buildOrderProductSnapshotView(order.productSnapshot, order.productType),
      quantity: order.quantity,
      amount: order.totalAmount,
      payAmount: order.paidAmount,
      originalAmount: core.originalAmount,
      discountAmount: order.discountAmount,
      currency: order.currency,
      targetResourceId: core.targetResourceId,
      payMethod: order.payChannel,
      wechatPayEnv: core.wechatPayEnv,
      payment: this.toPaymentView(payment),
      entitlements: entitlements.map((entitlement) => this.toEntitlementView(entitlement)),
      // `includeRefunds=false` 时返回空数组而不是 `null`：契约的字段是数组，
      // 前端 `refunds.length` 会因 null 直接崩
      refunds: includeRefunds ? refunds.map((refund) => this.toRefundSummary(refund)) : [],
      refundedAmount,
      refundableAmount,
      timeline: buildOrderTimelineView({
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        fulfilledAt: order.fulfilledAt,
        closedAt: order.closedAt,
        cancelledAt: order.cancelledAt,
        paymentCreatedAt: payment?.createdAt ?? null,
        paymentStatus: payment?.status ?? null,
        refundSuccessAt: latestRefundSuccessAt(refunds),
      }),
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
      fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
      expiredAt: order.expiredAt.toISOString(),
      closedAt: order.closedAt?.toISOString() ?? null,
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
      refundedAt: core.refundedAt,
      remainingSeconds: computeRemainingSeconds(order.status, order.expiredAt, now),
      isExpired: isOrderExpired(order.expiredAt, now),
      ...actions,
      serverTime: now.toISOString(),
    };
  }

  // ==========================================================================
  // POST /orders/{id}/query
  // ==========================================================================

  async queryOrder(userId: string, orderId: string, force: boolean): Promise<QueryOrderResultView> {
    await enforceRateLimit({
      redis: this.redis,
      keyParts: ['order-query', userId, orderId],
      limit: QUERY_RATE_LIMIT,
      ttlSeconds: QUERY_RATE_TTL_SECONDS,
      message: '查单过于频繁，请稍后再试',
    });

    const order = await this.findOwnedOrder(userId, orderId, false);

    // 节流：30s 内同订单直接返回上次结果（省微信调用配额）
    const cacheKey = this.redis.key('pay', 'order-query', order.id);
    if (!force) {
      const cached = await this.readQueryCache(cacheKey);
      if (cached !== null) return cached;
    }

    const result = await this.performWechatQuery(order);
    await this.writeQueryCache(cacheKey, result);

    return result;
  }

  /**
   * 真正的查单与补偿
   *
   * 无论本地处于什么状态都**实际向微信查询一次**：本接口的用途是「客服排障 +
   * 回调丢失兜底」，返回本地的推导值等于把"排障"变成"复述本地状态"，
   * 反而会掩盖不一致。契约 §3.9.5 错误码表里 `70004` 同时写着「返回 409」
   * 与「返回 200 + note 不报错」，自相矛盾；这里取**后者**（不报错），
   * 因为前端支付成功页正在轮询这个接口，报错会把它逼进错误分支。
   */
  private async performWechatQuery(order: Order): Promise<QueryOrderResultView> {
    const previousStatus = order.status;
    const queriedAt = new Date();

    let transaction;
    try {
      transaction = await this.wechatPay.queryTransactionByOutTradeNo(order.orderNo);
    } catch (error) {
      if (error instanceof WechatPayApiError && error.kind === 'NOT_FOUND') {
        // 微信侧没有这笔单：说明预支付从未成功，本地保持原状态即可
        return this.buildQueryResult(order, {
          previousStatus,
          currentStatus: order.status,
          wechatTradeState: 'NOTPAY',
          wechatTradeStateDesc: '微信侧不存在该订单（未完成预支付）',
          transactionId: null,
          paidAt: null,
          localUpdated: false,
          granted: null,
          outboxEventId: null,
          queriedAt,
          note: '微信侧尚未生成该订单，请重新发起支付。',
          shouldPollAgain: false,
        });
      }

      // 契约 §3.9.5：微信查单失败 → 502（本项目映射为 `70007 PAYMENT_FAILED`）
      this.logger.error(
        `微信查单失败 orderNo=${order.orderNo}: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new BusinessException(ErrorCode.PAYMENT_FAILED, '微信查单暂时失败，请稍后重试');
    }

    const base = {
      previousStatus,
      wechatTradeState: transaction.tradeState,
      wechatTradeStateDesc: transaction.tradeStateDesc,
      transactionId: transaction.transactionId,
      queriedAt,
    };

    switch (transaction.tradeState) {
      case 'SUCCESS': {
        // 金额必须逐分比对：不一致是**风控事件**，绝不发货
        const claimed = transaction.totalAmount;
        if (claimed !== null && claimed !== order.totalAmount) {
          this.logger.error(
            `【风控】微信查单金额与订单不一致 orderNo=${order.orderNo} 微信=${claimed} 订单=${order.totalAmount}`,
          );

          throw new BusinessException(
            ErrorCode.PAYMENT_AMOUNT_MISMATCH,
            '支付金额与订单不一致，已暂停发放权益，请联系客服',
            { httpStatus: 409 },
          );
        }

        // 本地已是完成态：不重复发放（幂等），但如实告知
        if (!UNPAID_STATUSES.includes(order.status)) {
          return this.buildQueryResult(order, {
            ...base,
            currentStatus: order.status,
            paidAt: order.paidAt?.toISOString() ?? null,
            localUpdated: false,
            granted: null,
            outboxEventId: null,
            note: '本地已是支付完成状态，无需补偿。',
            shouldPollAgain: false,
          });
        }

        const paidAt = parseWechatTime(transaction.successTime) ?? queriedAt;
        const fulfillment = await this.payments.fulfillPaidOrder({
          orderId: order.id,
          transactionId: transaction.transactionId,
          paidAmount: order.totalAmount,
          paidAt,
        });

        const outboxEventId = fulfillment.fulfilled
          ? await this.writeOutbox(
              'order.paid',
              'order',
              order.id,
              {
                orderId: order.id,
                orderNo: order.orderNo,
                userId: order.userId,
                paidAmount: order.totalAmount,
                source: 'QUERY_COMPENSATION',
              },
              `order.paid:${order.id}`,
            )
          : null;

        const grantedId = fulfillment.grantedEntitlementIds[0] ?? null;
        const granted =
          grantedId === null ? null : await this.prisma.entitlement.findUnique({ where: { id: grantedId } });

        this.logger.log(
          `主动查单补偿完成 orderNo=${order.orderNo} fulfilled=${String(fulfillment.fulfilled)} entitlements=${fulfillment.grantedEntitlementIds.length}`,
        );

        return this.buildQueryResult(order, {
          ...base,
          currentStatus: fulfillment.fulfilled ? 'FULFILLED' : order.status,
          paidAt: paidAt.toISOString(),
          localUpdated: fulfillment.fulfilled,
          granted,
          outboxEventId,
          note: fulfillment.fulfilled ? '已确认支付成功并补发权益。' : '本地已是支付完成状态，无需补偿。',
          shouldPollAgain: false,
        });
      }

      case 'CLOSED':
      case 'REVOKED': {
        const targetStatus: OrderStatus = transaction.tradeState === 'CLOSED' ? 'CLOSED' : 'CANCELLED';
        const updated = UNPAID_STATUSES.includes(order.status)
          ? await this.prisma.order.updateMany({
              where: { id: order.id, status: { in: [...UNPAID_STATUSES] }, deletedAt: null },
              data: {
                status: targetStatus,
                ...(targetStatus === 'CLOSED' ? { closedAt: queriedAt } : { cancelledAt: queriedAt }),
                cancelReason: '微信侧状态同步',
                version: { increment: 1 },
              },
            })
          : { count: 0 };

        return this.buildQueryResult(order, {
          ...base,
          currentStatus: updated.count > 0 ? targetStatus : order.status,
          paidAt: null,
          localUpdated: updated.count > 0,
          granted: null,
          outboxEventId: null,
          note:
            targetStatus === 'CLOSED'
              ? '微信侧订单已关闭，本地已同步为已关闭。'
              : '微信侧订单已撤销，本地已同步为已取消。',
          shouldPollAgain: false,
        });
      }

      case 'REFUND': {
        // 以退款记录为准：这里**不**擅自改订单状态，只如实回报
        return this.buildQueryResult(order, {
          ...base,
          currentStatus: order.status,
          paidAt: order.paidAt?.toISOString() ?? null,
          localUpdated: false,
          granted: null,
          outboxEventId: null,
          note: '微信侧订单已转入退款，请以退款记录为准。',
          shouldPollAgain: false,
        });
      }

      case 'NOTPAY': {
        return this.buildQueryResult(order, {
          ...base,
          currentStatus: order.status,
          paidAt: null,
          localUpdated: false,
          granted: null,
          outboxEventId: null,
          note: '微信侧显示仍未支付。若你已完成支付，请稍后重试或联系客服。',
          shouldPollAgain: true,
        });
      }

      case 'USERPAYING': {
        return this.buildQueryResult(order, {
          ...base,
          currentStatus: order.status,
          paidAt: null,
          localUpdated: false,
          granted: null,
          outboxEventId: null,
          note: '微信侧显示支付处理中，请稍后重试查询。',
          shouldPollAgain: true,
        });
      }

      default: {
        return this.buildQueryResult(order, {
          ...base,
          currentStatus: order.status,
          paidAt: null,
          localUpdated: false,
          granted: null,
          outboxEventId: null,
          note: '微信侧支付未成功，请重新发起支付。',
          shouldPollAgain: true,
        });
      }
    }
  }

  // ==========================================================================
  // POST /orders/{id}/cancel
  // ==========================================================================

  async cancelOrder(userId: string, orderId: string, reason: string): Promise<CancelOrderResultView> {
    await enforceRateLimit({
      redis: this.redis,
      keyParts: ['order-cancel', userId],
      limit: CANCEL_RATE_LIMIT,
      ttlSeconds: CANCEL_RATE_TTL_SECONDS,
      message: '取消操作过于频繁，请稍后再试',
    });

    const order = await this.findOwnedOrder(userId, orderId, false);
    const previousStatus = order.status;

    // 幂等：已取消直接返回当前状态（契约 §3.9.6 业务规则 3）
    if (previousStatus === 'CANCELLED') {
      return {
        orderId: order.id,
        orderNo: order.orderNo,
        previousStatus,
        status: 'CANCELLED',
        statusLabel: orderStatusLabel('CANCELLED'),
        reason: order.cancelReason ?? reason,
        cancelledAt: order.cancelledAt?.toISOString() ?? null,
        wechatOrderClosed: false,
        note: '订单已是取消状态。',
      };
    }

    // 已超时关单：契约 §3.9.6 错误码 `70005`（410）
    if (previousStatus === 'CLOSED') {
      throw new BusinessException(ErrorCode.ORDER_EXPIRED, '订单已关闭，如需购买请重新下单');
    }

    // `PAID` 之后不可取消，只能退款（契约 §3.9.6 业务规则 1；架构 §13.3 明确约束）
    if (!UNPAID_STATUSES.includes(previousStatus)) {
      throw new BusinessException(ErrorCode.ORDER_STATUS_INVALID, '订单已支付，如需退款请走退款流程');
    }

    const now = new Date();
    const updated = await this.prisma.order.updateMany({
      where: { id: order.id, status: { in: [...UNPAID_STATUSES] }, deletedAt: null },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelReason: reason,
        version: { increment: 1 },
      },
    });

    // 并发下可能被超时关单抢先；以数据库里的真实状态为准回答，而不是假装成功
    if (updated.count === 0) {
      const current = await this.prisma.order.findUnique({ where: { id: order.id } });

      return {
        orderId: order.id,
        orderNo: order.orderNo,
        previousStatus: current?.status ?? previousStatus,
        status: current?.status ?? previousStatus,
        statusLabel: orderStatusLabel(current?.status ?? previousStatus),
        reason,
        cancelledAt: current?.cancelledAt?.toISOString() ?? null,
        wechatOrderClosed: false,
        note: '订单状态已被其他操作变更，请刷新后查看。',
      };
    }

    const wechatOrderClosed = await this.closeOnWechat(order);

    this.logger.log(
      `用户取消订单 orderNo=${order.orderNo} userId=${userId} reason=${reason} wechatClosed=${String(wechatOrderClosed)}`,
    );

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      previousStatus,
      status: 'CANCELLED',
      statusLabel: orderStatusLabel('CANCELLED'),
      reason,
      cancelledAt: now.toISOString(),
      wechatOrderClosed,
      note: '订单已取消，如已产生支付请等待退款或联系客服。',
    };
  }

  // ==========================================================================
  // POST /orders/{id}/close
  // ==========================================================================

  async closeOrder(userId: string, orderId: string, closeReason: string | undefined): Promise<CloseOrderResultView> {
    await enforceRateLimit({
      redis: this.redis,
      keyParts: ['order-close', userId],
      limit: CANCEL_RATE_LIMIT,
      ttlSeconds: CANCEL_RATE_TTL_SECONDS,
      message: '关单操作过于频繁，请稍后再试',
    });

    const order = await this.findOwnedOrder(userId, orderId, false);
    const previousStatus = order.status;

    if (!UNPAID_STATUSES.includes(previousStatus) && previousStatus !== 'CLOSED') {
      throw new BusinessException(ErrorCode.ORDER_STATUS_INVALID, '当前订单状态不支持关单');
    }

    // 用户主动关单时强制 `USER_REQUEST`：`TIMEOUT` 只允许 cron 使用，
    // 否则「用户主动放弃」会被记成「系统超时」，流失分析直接失真
    const normalizedReason = normalizeCloseReason(closeReason, true);
    const closed = await this.closeSingleOrder(order, normalizedReason);

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      previousStatus,
      status: 'CLOSED',
      statusLabel: orderStatusLabel('CLOSED'),
      closeReason: normalizedReason,
      closedAt: closed.closedAt?.toISOString() ?? null,
      expiredAt: order.expiredAt.toISOString(),
      wechatOrderClosed: closed.wechatOrderClosed,
      canRecreateOrder: true,
      recreateHint: '如需继续购买，可重新下单。',
    };
  }

  // ==========================================================================
  // 超时自动关单（契约 §3.9.7 业务规则 2：每分钟扫描 `CREATED`/`PENDING_PAY` 且超 `expiredAt`）
  // ==========================================================================

  /**
   * 关闭所有已超时的未支付订单
   *
   * 这是**资损相关**能力：订单不关，用户就能在 15 分钟后继续支付，
   * 而我们可能已经把库存/权益口径按"未支付"处理过。因此它不依赖任何外部触发，
   * 由队列的 repeatable job 每分钟驱动（见 `payment-jobs.module.ts`）。
   *
   * 单次扫描分批取，避免一次任务把连接池与微信调用配额占满；没关完的留给下一分钟。
   */
  async closeExpiredOrders(batchSize = 200): Promise<CloseExpiredOrdersResult> {
    const now = new Date();
    const result: CloseExpiredOrdersResult = { scanned: 0, closed: 0, wechatClosed: 0, wechatFailed: 0 };

    for (let batch = 0; batch < EXPIRE_SCAN_MAX_BATCHES; batch += 1) {
      const expired = await this.prisma.order.findMany({
        where: { status: { in: [...UNPAID_STATUSES] }, expiredAt: { lt: now }, deletedAt: null },
        // 早过期的先关：长时间停留的订单是"最该被清理"的那批，
        // 按主键排序会让老订单永远排在新订单后面
        orderBy: { expiredAt: 'asc' },
        take: batchSize,
        select: { id: true, orderNo: true },
      });

      if (expired.length === 0) break;

      result.scanned += expired.length;

      for (const row of expired) {
        const order = await this.prisma.order.findFirst({ where: { id: row.id, deletedAt: null } });
        if (order === null) continue;

        const closed = await this.closeSingleOrder(order, 'TIMEOUT');
        if (closed.closed) result.closed += 1;
        if (closed.wechatOrderClosed) result.wechatClosed += 1;
        if (!closed.wechatOrderClosed && !closed.wechatSkipped) result.wechatFailed += 1;
      }

      // 取不满一批说明已扫完
      if (expired.length < batchSize) break;
    }

    if (result.closed > 0 || result.wechatFailed > 0) {
      this.logger.log(
        `超时关单批次完成 scanned=${result.scanned} closed=${result.closed} wechatClosed=${result.wechatClosed} wechatFailed=${result.wechatFailed}`,
      );
    }

    return result;
  }

  /**
   * 关闭单笔订单（用户主动关单与超时关单共用）
   *
   * **本地状态优先**（契约 §3.9.7 规则 4）：微信 `close` 失败不阻断本地关单，
   * 而是写一条 outbox 事件供重试。反过来（微信失败就不关本地）会让用户面对
   * 一个"关不掉但也没法支付"的订单。
   */
  private async closeSingleOrder(
    order: Order,
    closeReason: CloseReason,
  ): Promise<{ closed: boolean; closedAt: Date | null; wechatOrderClosed: boolean; wechatSkipped: boolean }> {
    if (order.status === 'CLOSED') {
      return { closed: false, closedAt: order.closedAt, wechatOrderClosed: false, wechatSkipped: true };
    }

    const now = new Date();
    const updated = await this.prisma.order.updateMany({
      where: { id: order.id, status: { in: [...UNPAID_STATUSES] }, deletedAt: null },
      data: {
        status: 'CLOSED',
        closedAt: now,
        cancelReason: closeReason === 'TIMEOUT' ? '超时未支付自动关单' : '用户主动关单',
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      // 被并发操作（用户取消 / 回调支付）抢先，不覆盖更"权威"的状态
      this.logger.log(`订单状态已被并发变更，跳过关单 orderNo=${order.orderNo}`);
      return { closed: false, closedAt: null, wechatOrderClosed: false, wechatSkipped: true };
    }

    const wechatOrderClosed = await this.closeOnWechat(order);

    // 微信关单失败：写入发件箱重试（契约 §3.9.7 规则 4）
    if (!wechatOrderClosed) {
      await this.writeOutbox(
        'order.wechat_close_retry',
        'order',
        order.id,
        { orderId: order.id, orderNo: order.orderNo, closeReason },
        `order.wechat_close:${order.id}`,
      );
    }

    return { closed: true, closedAt: now, wechatOrderClosed, wechatSkipped: false };
  }

  /** 调微信关单；未配置支付通道时直接跳过（不视作失败，也不写重试事件） */
  private async closeOnWechat(order: Order): Promise<boolean> {
    if (!this.wechatPay.isApiConfigured) {
      this.logger.warn(`微信支付未配置，跳过关单调用 orderNo=${order.orderNo}`);

      return false;
    }

    const result = await this.wechatPay.closeOrder(order.orderNo);

    if (result.closed) return true;

    // 「微信侧无此订单」等价于目标达成：没有可被支付的单
    if (result.notFound) return true;

    this.logger.warn(`微信关单未成功 orderNo=${order.orderNo} note=${result.note}`);

    return false;
  }

  // ==========================================================================
  // 内部：查询与装配
  // ==========================================================================

  /**
   * 按归属查订单（强过滤）
   *
   * @param byNo `true` 时把 `idOrNo` 当作 `orderNo` 解析（契约 §3.9.4）
   */
  private async findOwnedOrder(userId: string, idOrNo: string, byNo: boolean): Promise<Order> {
    if (byNo) {
      if (!ORDER_NO_PATTERN.test(idOrNo)) {
        throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'orderNo 格式不合法');
      }
    } else if (!UUID_PATTERN.test(idOrNo)) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'id 必须是合法 UUID');
    }

    const order = await this.prisma.order.findFirst({
      where: byNo ? { orderNo: idOrNo, deletedAt: null } : { id: idOrNo, deletedAt: null },
    });

    if (order === null) {
      throw BusinessException.notFound(ErrorCode.ORDER_NOT_FOUND, '订单不存在');
    }

    // 契约 §3.9.4：IDOR 防护要**记录安全探测日志**（否则横向越权在日志里不可见）
    if (order.userId !== userId) {
      this.logger.warn(
        `【安全】越权访问订单 userId=${userId} orderId=${order.id} ownerId=${order.userId} orderNo=${order.orderNo}`,
      );

      throw BusinessException.forbidden(ErrorCode.ORDER_NOT_OWNED, '无权访问该订单');
    }

    return order;
  }

  private async loadProductName(productId: string | null): Promise<{ code: string; name: string } | null> {
    if (productId === null) return null;

    return this.prisma.product.findUnique({ where: { id: productId }, select: { code: true, name: true } });
  }

  /** 批量取权益（1 次查询，避免逐订单查的 N+1） */
  private async loadEntitlements(orderIds: readonly string[]): Promise<Map<string, Entitlement[]>> {
    const map = new Map<string, Entitlement[]>();
    if (orderIds.length === 0) return map;

    const rows = await this.prisma.entitlement.findMany({
      where: { orderId: { in: [...orderIds] }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    for (const row of rows) {
      if (row.orderId === null) continue;
      const list = map.get(row.orderId);
      if (list === undefined) {
        map.set(row.orderId, [row]);
      } else {
        list.push(row);
      }
    }

    return map;
  }

  /** 批量取微信交易号（同一订单可能有多张支付单，取最近一次） */
  private async loadTransactionIds(orderIds: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (orderIds.length === 0) return map;

    const rows = await this.prisma.payment.findMany({
      where: { orderId: { in: [...orderIds] }, transactionId: { not: null }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { orderId: true, transactionId: true },
    });

    for (const row of rows) {
      if (row.transactionId === null || map.has(row.orderId)) continue;
      map.set(row.orderId, row.transactionId);
    }

    return map;
  }

  /** 批量取最近一笔退款状态（列表的 `refundStatus`） */
  private async loadLatestRefundStatus(orderIds: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (orderIds.length === 0) return map;

    const rows = await this.prisma.refund.findMany({
      where: { orderId: { in: [...orderIds] }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { orderId: true, status: true },
    });

    for (const row of rows) {
      if (!map.has(row.orderId)) map.set(row.orderId, row.status);
    }

    return map;
  }

  private toListItem(
    row: Order,
    entitlements: readonly Entitlement[],
    transactionId: string | null,
    refundStatus: string | null,
    now: Date,
  ): UserOrderListItem {
    const refundedAmount = row.refundedAmount;
    const refundableAmount = computeRefundableAmount(row.paidAmount, refundedAmount);

    const actions = deriveOrderActionFlags({
      status: row.status,
      createdAt: row.createdAt,
      paidAt: row.paidAt,
      refundableAmount,
      entitlements: entitlements.map((entitlement) => ({
        status: entitlement.status,
        usedQuota: entitlement.usedQuota,
      })),
      now,
    });

    return {
      orderId: row.id,
      orderNo: row.orderNo,
      status: row.status,
      statusLabel: orderStatusLabel(row.status),
      productCode: readSnapshotString(row.productSnapshot, 'code'),
      productName: readSnapshotString(row.productSnapshot, 'name'),
      productType: row.productType,
      quantity: row.quantity,
      amount: row.totalAmount,
      payAmount: row.paidAmount,
      currency: row.currency,
      targetResourceId: row.relatedReportId ?? row.relatedRelationshipId ?? null,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
      expiredAt: row.expiredAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      refundedAmount,
      // 未发生过退款时为 null（契约示例即如此），发生过则给最近一笔的状态
      refundStatus: refundedAmount > 0 ? refundStatus : null,
      entitlements: entitlements.map((entitlement) => ({
        entitlementId: entitlement.id,
        type: entitlement.type,
        status: entitlement.status,
        expiresAt: entitlement.expireAt?.toISOString() ?? null,
      })),
      canRefund: actions.canRefund,
      canQuery: actions.canQuery,
      payMethod: row.payChannel,
      transactionId,
    };
  }

  /**
   * 列表摘要
   *
   * 口径与管理端 §3.14.6.1 保持一致（`paidOrders` = 支付成功过的订单数，
   * `closedOrders` = CLOSED + CANCELLED），否则同一批订单在两端显示不同的数字，
   * 运营与客服会互相质疑数据。
   */
  private buildSummary(
    buckets: ReadonlyArray<{
      status: OrderStatus;
      _count: { _all: number };
      _sum: { paidAmount: number | null; refundedAmount: number | null };
    }>,
  ): UserOrderSummary {
    const paidStatuses = new Set<string>(['PAID', 'FULFILLED', 'REFUNDED', 'PARTIAL_REFUNDED']);
    const pendingStatuses = new Set<string>(['CREATED', 'PENDING_PAY']);
    const closedStatuses = new Set<string>(['CLOSED', 'CANCELLED']);

    let totalOrders = 0;
    let paidOrders = 0;
    let pendingOrders = 0;
    let closedOrders = 0;
    let totalPaidAmount = 0;
    let totalRefundedAmount = 0;

    for (const bucket of buckets) {
      totalOrders += bucket._count._all;
      if (paidStatuses.has(bucket.status)) paidOrders += bucket._count._all;
      if (pendingStatuses.has(bucket.status)) pendingOrders += bucket._count._all;
      if (closedStatuses.has(bucket.status)) closedOrders += bucket._count._all;

      totalPaidAmount += bucket._sum.paidAmount ?? 0;
      totalRefundedAmount += bucket._sum.refundedAmount ?? 0;
    }

    return { totalOrders, paidOrders, pendingOrders, closedOrders, totalPaidAmount, totalRefundedAmount };
  }

  private toPaymentView(payment: ReturnType<typeof latestPayment>): UserOrderPaymentView | null {
    if (payment === null) return null;

    return {
      paymentId: payment.id,
      outTradeNo: payment.outTradeNo,
      transactionId: payment.transactionId,
      prepayId: payment.prepayId,
      status: payment.status,
      amount: payment.amount,
      payerTotal: payment.payerAmount,
      payerOpenid: null,
      tradeType: TRADE_TYPE_BY_CHANNEL[payment.channel] ?? null,
      bankType: payment.bankType,
      paidAt: payment.successTime?.toISOString() ?? null,
      notifyReceivedAt: payment.notifyReceivedAt?.toISOString() ?? null,
      // `payments` 表没有回调次数字段：有回调时间即视为 1 次（>1 无法还原）
      notifyCount: payment.notifyReceivedAt === null ? 0 : 1,
      isReconciled: null,
    };
  }

  private toEntitlementView(entitlement: Entitlement): UserOrderDetailView['entitlements'][number] {
    return {
      entitlementId: entitlement.id,
      type: entitlement.type,
      status: entitlement.status,
      grantedAt: entitlement.startAt.toISOString(),
      expiresAt: entitlement.expireAt?.toISOString() ?? null,
      remainingCount: entitlement.remainingQuota,
      resourceId: entitlement.reportId ?? entitlement.relationshipId ?? null,
    };
  }

  private toRefundSummary(refund: Refund): UserOrderDetailView['refunds'][number] {
    return {
      refundId: refund.id,
      refundNo: refund.refundNo,
      status: refund.status,
      statusLabel: refundStatusLabel(refund.status),
      refundAmount: refund.refundAmount,
      reason: refund.reason,
      succeededAt: refund.successTime?.toISOString() ?? null,
      failedReason: refund.errorMessage,
    };
  }

  /**
   * 排序映射
   *
   * `sortBy=amount` 映射到 `totalAmount`（列表里的 `amount` 字段就是应付额）；
   * 管理端 §3.14.6.1 映射到实付额，两者口径**有意不同**：用户端列表展示的是
   * "这个订单多少钱"，用应付额才与同一条目的 `amount` 字段自洽。
   */
  private buildOrderBy(sortBy: OrderSortField, order: OrderSortOrder): Prisma.OrderOrderByWithRelationInput[] {
    const primary: Prisma.OrderOrderByWithRelationInput =
      sortBy === 'amount' ? { totalAmount: order } : sortBy === 'paidAt' ? { paidAt: order } : { createdAt: order };

    // 次级排序固定 id：`paidAt` 可空且大量订单时间相同，PostgreSQL 不保证稳定序，
    // 仅按单一字段排序时同一条记录会在第 1、2 页各出现一次
    return [primary, { id: 'desc' }];
  }

  // ==========================================================================
  // 内部：查单响应装配与缓存
  // ==========================================================================

  private buildQueryResult(
    order: Order,
    input: {
      previousStatus: string;
      currentStatus: string;
      wechatTradeState: string;
      wechatTradeStateDesc: string | null;
      transactionId: string | null;
      paidAt: string | null;
      localUpdated: boolean;
      granted: Entitlement | null;
      outboxEventId: string | null;
      queriedAt: Date;
      note: string;
      shouldPollAgain: boolean;
    },
  ): QueryOrderResultView {
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      previousStatus: input.previousStatus,
      currentStatus: input.currentStatus,
      wechatTradeState: input.wechatTradeState,
      wechatTradeStateDesc: input.wechatTradeStateDesc,
      transactionId: input.transactionId,
      paidAt: input.paidAt,
      localUpdated: input.localUpdated,
      entitlementGranted: input.granted !== null,
      entitlement:
        input.granted === null
          ? null
          : {
              entitlementId: input.granted.id,
              type: input.granted.type,
              grantedAt: input.granted.startAt.toISOString(),
              expiresAt: input.granted.expireAt?.toISOString() ?? null,
            },
      outboxEventId: input.outboxEventId,
      queriedAt: input.queriedAt.toISOString(),
      note: input.note,
      nextActions: {
        shouldPollAgain: input.shouldPollAgain,
        pollAfterMs: input.shouldPollAgain ? 3000 : null,
      },
    };
  }

  /** 读取 30s 查单缓存；Redis 故障时返回 null（等价于"没有缓存"，直接实时查） */
  private async readQueryCache(key: string): Promise<QueryOrderResultView | null> {
    try {
      return await this.redis.getJson<QueryOrderResultView>(key);
    } catch (error) {
      this.logger.warn(`读取查单缓存失败（忽略）: ${error instanceof Error ? error.message : String(error)}`);

      return null;
    }
  }

  private async writeQueryCache(key: string, value: QueryOrderResultView): Promise<void> {
    try {
      await this.redis.setJson(key, value, QUERY_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`写查单缓存失败（忽略）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 写事务性发件箱
   *
   * `outbox_events.idempotencyKey` 的唯一约束天然提供「同一事件只入队一次」的幂等
   * （与 `StorageService.enqueueModerationCheck` 同一模式）。因此这里**必须**吞掉
   * 唯一冲突 —— 把重复投递升级成接口报错，会让一次成功的支付补偿以 500 结束。
   */
  private async writeOutbox(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Prisma.InputJsonObject,
    idempotencyKey: string,
  ): Promise<string | null> {
    try {
      const row = await this.prisma.outboxEvent.create({
        data: { eventType, aggregateType, aggregateId, payload, idempotencyKey },
        select: { id: true },
      });

      return row.id;
    } catch (error) {
      if ((error as { code?: unknown }).code === 'P2002') {
        this.logger.log(`发件箱事件已存在（幂等命中）key=${idempotencyKey}`);

        return null;
      }

      // 发件箱写不进去不能影响主流程（订单状态与权益已经落库），但要留痕
      this.logger.error(
        `写发件箱失败 key=${idempotencyKey}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }
}

/** 支付渠道 → 微信 `trade_type` */
const TRADE_TYPE_BY_CHANNEL: Readonly<Record<string, string>> = {
  WECHAT_JSAPI: 'JSAPI',
  WECHAT_NATIVE: 'NATIVE',
  WECHAT_H5: 'H5',
  SANDBOX: 'SANDBOX',
};

/** 从 JsonB 快照里安全取字符串 */
const readSnapshotString = (snapshot: unknown, key: string): string | null => {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null;

  const value = (snapshot as Record<string, unknown>)[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** 解析微信返回的 RFC3339 时间；无法解析时返回 null（由调用方兜底为"现在"） */
const parseWechatTime = (raw: string | null): Date | null => {
  if (raw === null) return null;

  const parsed = new Date(raw);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
