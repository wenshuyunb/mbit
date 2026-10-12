/**
 * 管理端订单模块纯逻辑（无 I/O、可 100% 单测）
 *
 * 为什么单独成文件：契约 §3.14.6 的响应里有大量**推导**字段
 * （`statusLabel`、`refundableAmount`、`hasAbnormalFlag`、`timeline`、`adminActions`），
 * 它们的口径一旦散落在 Service 里就只能靠 mock 间接覆盖；而「可退金额为 0 时
 * `canRefund` 必须为 false」这类边界恰恰是返工与线上事故的高发区。
 * 抽成纯函数后可以把边界枚举出来直接测。
 *
 * ## 与共享工具的关系
 *
 * 手机号 / 标识掩码复用 `common/utils/mask.util.ts`（`maskPhone` / `maskMiddle`）。
 * **昵称掩码没有复用**：`mask.util.ts` 未提供昵称脱敏函数，而该文件属共享文件
 * （本轮不得修改），因此在此实现同一口径的本地版本 —— 各模块各自持有一份
 * 3 行实现，避免引入跨目录的隐式依赖。
 */

import type { Entitlement, Order, OrderStatus, Payment, Product, Refund } from '@prisma/client';

import { maskMiddle, maskPhone } from '../../../common/utils/mask.util';

/** 订单状态中文名（契约 §3.14.6.1 的 `statusLabel`，`FULFILLED` → 「已完成」） */
const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  CREATED: '已创建',
  PENDING_PAY: '待支付',
  PAID: '已支付',
  FULFILLED: '已完成',
  CLOSED: '已关闭',
  CANCELLED: '已取消',
  REFUNDED: '已全额退款',
  PARTIAL_REFUNDED: '部分退款',
};

/** 状态中文名；未知状态回落原值而非空串（便于发现新增状态未登记） */
export const orderStatusLabel = (status: string): string => ORDER_STATUS_LABELS[status as OrderStatus] ?? status;

/**
 * 昵称掩码：保留首字符，其余打码（契约示例 `小满` → `小*`、`阿泽` → `阿*`）
 *
 * 空昵称为 null（而不是空串）：前端据此渲染「未设置昵称」占位，
 * 空串会被渲染成一个空白的用户名，看起来像数据缺失。
 */
export const maskNickname = (nickname: string | null | undefined): string | null => {
  if (!nickname) return null;
  const trimmed = nickname.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length === 1) return `${trimmed}*`;
  return `${trimmed.slice(0, 1)}${'*'.repeat(trimmed.length - 1)}`;
};

/** 用户 ID 掩码（导出用；契约 §3.14.6.4：`maskSensitive` 掩码昵称与用户 ID） */
export const maskUserId = (userId: string | null | undefined): string | null => maskMiddle(userId, 8, 4);

/** 手机号掩码（订单详情 `user.phoneMasked`） */
export const maskPhoneOf = (phonePlain: string | null | undefined): string | null => maskPhone(phonePlain);

// ============================================================================
// 退款与可执行操作
// ============================================================================

/**
 * 可退金额 = 实付金额 − 已退金额（契约 §3.9.10 规则 5 / §3.9.9 规则 3）
 *
 * 夹到 ≥ 0：历史数据存在「退款成功但 refundedAmount 未回写」的窗口，
 * 直接相减会得到负数，前端会渲染出「-¥xx」这种不可能出现的金额。
 */
export const computeRefundableAmount = (paidAmount: number, refundedAmount: number): number =>
  Math.max(0, paidAmount - refundedAmount);

/** 退款窗口（契约 §3.9.10 规则 1：7 天内可退款，超过 7 天引导联系客服） */
export const REFUND_WINDOW_DAYS = 7;

/** 异常订单标记（契约 §3.14.6.1 规则 2 举例的两类，另补一条金额自洽性检查） */
export const ABNORMAL_FLAG_LABELS = {
  /** 已支付但 24h 未发放权益（风险 R6 的「付了没给货」） */
  PAID_NOT_FULFILLED_24H: '已支付但 24 小时内未发放权益',
  /** 实付金额 ≠ 应付金额（应付 = 总额 − 优惠） */
  AMOUNT_MISMATCH: '订单金额与支付金额不一致',
  /** 已退金额超过实付金额（数据异常，需人工核对） */
  REFUND_OVER_PAID: '累计退款金额超过实付金额',
} as const;
export type AbnormalFlag = keyof typeof ABNORMAL_FLAG_LABELS;

/** 异常判定的最小输入（避免依赖完整行对象，便于单测直接构造） */
export interface AbnormalCheckInput {
  readonly status: string;
  readonly totalAmount: number;
  readonly discountAmount: number;
  readonly paidAmount: number;
  readonly refundedAmount: number;
  readonly paidAt: Date | null;
  /** 与订单关联的权益条数 */
  readonly entitlementCount: number;
  /** 判定基准时刻（便于测试注入） */
  readonly now: Date;
}

/** 24 小时（毫秒） */
const FULFILLMENT_ALERT_MS = 24 * 60 * 60 * 1000;

/**
 * 推导异常标记
 *
 * ⚠ 契约 §3.14.6.1 规则 2 说明该标记「由对账任务标记」，但 `orders` 表
 * **没有**对应的持久化列（schema 不可改）。因此这里退化为**读时推导**：
 * 只覆盖「可由当前数据判定」的三条规则。这不是等价替代 ——
 * 真正的对账结论（如与微信账单逐笔核对不一致）无法在读取时算出，
 * 需补 `orders.abnormal_flags` 列或独立对账表后才能完整实现。
 */
export const deriveAbnormalFlags = (input: AbnormalCheckInput): AbnormalFlag[] => {
  const flags: AbnormalFlag[] = [];

  if (input.status === 'PAID' && input.entitlementCount === 0 && input.paidAt !== null) {
    if (input.now.getTime() - input.paidAt.getTime() >= FULFILLMENT_ALERT_MS) {
      flags.push('PAID_NOT_FULFILLED_24H');
    }
  }

  if (input.paidAmount > 0 && input.paidAmount !== input.totalAmount - input.discountAmount) {
    flags.push('AMOUNT_MISMATCH');
  }

  if (input.refundedAmount > input.paidAmount) {
    flags.push('REFUND_OVER_PAID');
  }

  return flags;
};

/** 管理端可执行操作（契约 §3.14.6.2 的 `adminActions`） */
export interface AdminActionsView {
  readonly canRefund: boolean;
  readonly canResendEntitlement: boolean;
  readonly canRetryReconcile: boolean;
  readonly canManualClose: boolean;
}

/** `adminActions` 的输入 */
export interface AdminActionsInput {
  readonly status: string;
  readonly paidAt: Date | null;
  readonly refundableAmount: number;
  readonly entitlementCount: number;
  readonly hasPayment: boolean;
  readonly now: Date;
}

/**
 * 推导管理端可执行操作
 *
 * 设计意图（契约 §3.14.6.2 规则 2）：前端**只据此渲染按钮**，避免越权尝试。
 * 因此这里的每个 `true` 都必须能被后端真正执行，宁可保守：
 *   · `canRefund`：状态可退 + 可退金额 > 0 + 在 7 天窗口内（§3.9.10 规则 1）
 *   · `canResendEntitlement`：严格按契约 —— 仅 `status = PAID` 且权益为空
 *   · `canRetryReconcile`：已支付且存在支付单（没有支付单时「对账重试」无对象可查）
 *   · `canManualClose`：仅未支付且未终结的订单可人工关单
 */
export const deriveAdminActions = (input: AdminActionsInput): AdminActionsView => {
  const refundableStatuses = new Set(['PAID', 'FULFILLED', 'PARTIAL_REFUNDED']);
  const withinWindow =
    input.paidAt !== null && input.now.getTime() - input.paidAt.getTime() <= REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  return {
    canRefund: refundableStatuses.has(input.status) && input.refundableAmount > 0 && withinWindow,
    canResendEntitlement: input.status === 'PAID' && input.entitlementCount === 0,
    canRetryReconcile: input.hasPayment && (input.status === 'PAID' || input.status === 'FULFILLED'),
    canManualClose: input.status === 'CREATED' || input.status === 'PENDING_PAY',
  };
};

// ============================================================================
// 时间线
// ============================================================================

/** 时间线事件（契约 §3.14.6.2 的 `timeline`） */
export interface OrderTimelineEvent {
  readonly event: string;
  readonly label: string;
  readonly at: string;
  readonly actor: 'USER' | 'SYSTEM' | 'WECHAT' | 'ADMIN';
}

/** 时间线输入 */
export interface OrderTimelineInput {
  readonly createdAt: Date;
  readonly paidAt: Date | null;
  readonly fulfilledAt: Date | null;
  readonly closedAt: Date | null;
  readonly cancelledAt: Date | null;
  /** 支付单创建时间（用于 `PREPAY_SUCCESS`） */
  readonly paymentCreatedAt: Date | null;
  readonly paymentStatus: string | null;
  /** 最近一次成功退款时间 */
  readonly refundSuccessAt: Date | null;
}

/**
 * 组装订单时间线
 *
 * 按时间**升序**返回：时间线的语义是「发生了什么」，倒序会让读者先看到结果
 * 再看到原因。契约示例也是升序。
 *
 * `RECONCILED` 事件缺省不入列 —— `payments` 表没有对账字段（`isReconciled` /
 * `reconciledAt` 在 schema 中不存在），凭空造一个「对账一致」节点比不返回更糟。
 */
export const buildOrderTimeline = (input: OrderTimelineInput): OrderTimelineEvent[] => {
  const events: OrderTimelineEvent[] = [
    { event: 'CREATED', label: '订单创建', at: input.createdAt.toISOString(), actor: 'USER' },
  ];

  if (input.paymentCreatedAt !== null && input.paymentStatus !== null && input.paymentStatus !== 'INIT') {
    events.push({
      event: 'PREPAY_SUCCESS',
      label: '微信预支付成功',
      at: input.paymentCreatedAt.toISOString(),
      actor: 'SYSTEM',
    });
  }

  if (input.paidAt !== null) {
    events.push({ event: 'PAID', label: '支付成功（回调）', at: input.paidAt.toISOString(), actor: 'WECHAT' });
  }

  if (input.fulfilledAt !== null) {
    events.push({ event: 'FULFILLED', label: '权益已发放', at: input.fulfilledAt.toISOString(), actor: 'SYSTEM' });
  }

  if (input.refundSuccessAt !== null) {
    events.push({ event: 'REFUNDED', label: '退款成功', at: input.refundSuccessAt.toISOString(), actor: 'ADMIN' });
  }

  if (input.cancelledAt !== null) {
    events.push({ event: 'CANCELLED', label: '用户取消', at: input.cancelledAt.toISOString(), actor: 'USER' });
  }

  if (input.closedAt !== null) {
    events.push({ event: 'CLOSED', label: '订单关闭', at: input.closedAt.toISOString(), actor: 'SYSTEM' });
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
};

// ============================================================================
// 列表摘要
// ============================================================================

/** 按状态聚合的一行（来自 Prisma `groupBy`，避免全表扫描） */
export interface OrderStatusBucket {
  readonly status: OrderStatus;
  readonly count: number;
  readonly paidAmount: number;
  readonly refundedAmount: number;
}

/** 按商品类型聚合的一行 */
export interface OrderProductTypeBucket {
  readonly productType: string;
  readonly count: number;
  readonly paidAmount: number;
}

/** 列表摘要（契约 §3.14.6.1 的 `summary`） */
export interface OrderListSummary {
  readonly totalOrders: number;
  readonly paidOrders: number;
  readonly pendingOrders: number;
  readonly closedOrders: number;
  readonly refundedOrders: number;
  readonly totalPaidAmount: number;
  readonly totalRefundedAmount: number;
  readonly netRevenue: number;
  readonly byProductType: Record<string, { orderCount: number; paidAmount: number }>;
}

/**
 * 口径说明（契约只给了字段名，未给判定规则，这里显式定义以免运营争议）：
 *
 * | 字段                 | 口径                                                       |
 * | -------------------- | ---------------------------------------------------------- |
 * | `totalOrders`        | 命中筛选条件的订单总数                                     |
 * | `paidOrders`         | 「支付成功过」的订单数 = 状态 ∈ PAID/FULFILLED/两种退款状态 |
 * | `pendingOrders`      | 未支付的在途订单 = 状态 ∈ CREATED/PENDING_PAY              |
 * | `closedOrders`       | 非支付终结 = 状态 ∈ CLOSED/CANCELLED                       |
 * | `refundedOrders`     | 发生过退款的订单 = `refundedAmount > 0`                    |
 * | `totalPaidAmount`    | Σ `paidAmount`（实付口径）                                 |
 * | `totalRefundedAmount`| Σ `refundedAmount`                                         |
 * | `netRevenue`         | `totalPaidAmount − totalRefundedAmount`（契约规则 1 明示） |
 */
const PAID_STATUSES: ReadonlySet<string> = new Set(['PAID', 'FULFILLED', 'REFUNDED', 'PARTIAL_REFUNDED']);
const PENDING_STATUSES: ReadonlySet<string> = new Set(['CREATED', 'PENDING_PAY']);
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['CLOSED', 'CANCELLED']);

export const buildOrderListSummary = (
  totalOrders: number,
  byStatus: readonly OrderStatusBucket[],
  byProductType: readonly OrderProductTypeBucket[],
): OrderListSummary => {
  let paidOrders = 0;
  let pendingOrders = 0;
  let closedOrders = 0;
  let refundedOrders = 0;
  let totalPaidAmount = 0;
  let totalRefundedAmount = 0;

  for (const bucket of byStatus) {
    if (PAID_STATUSES.has(bucket.status)) paidOrders += bucket.count;
    if (PENDING_STATUSES.has(bucket.status)) pendingOrders += bucket.count;
    if (CLOSED_STATUSES.has(bucket.status)) closedOrders += bucket.count;
    if (bucket.refundedAmount > 0) refundedOrders += bucket.count;

    totalPaidAmount += bucket.paidAmount;
    totalRefundedAmount += bucket.refundedAmount;
  }

  const byProductTypeMap: Record<string, { orderCount: number; paidAmount: number }> = {};
  for (const bucket of byProductType) {
    byProductTypeMap[bucket.productType] = { orderCount: bucket.count, paidAmount: bucket.paidAmount };
  }

  return {
    totalOrders,
    paidOrders,
    pendingOrders,
    closedOrders,
    refundedOrders,
    totalPaidAmount,
    totalRefundedAmount,
    netRevenue: totalPaidAmount - totalRefundedAmount,
    byProductType: byProductTypeMap,
  };
};

// ============================================================================
// 详情视图组装（纯函数部分）
// ============================================================================

/** 订单详情里的 `order` 块 */
export interface AdminOrderCoreView {
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
  originalAmount: number;
  discountAmount: number;
  currency: string;
  targetResourceId: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  expiredAt: string;
  closedAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  wechatPayEnv: string;
}

/** 组装 `order` 块所需的行数据 */
export interface OrderCoreInput {
  readonly order: Order;
  readonly product: Pick<Product, 'code' | 'name'> | null;
  /** `refundedAt` = 最近一次成功退款时间 */
  readonly refundedAt: Date | null;
  readonly wechatPayEnv: string;
}

/**
 * 商品名/编码：**优先取 `products` 关联行，缺失时回落到 `productSnapshot`**
 *
 * 商品可能已下架甚至被删除（`onDelete: Restrict` 下 `productId` 可指向已软删的行），
 * 而订单必须永远能展示「当时买的是什么」—— 这正是 `productSnapshot` 的用途。
 * 只取关联行会让历史订单在商品改名后显示错误信息。
 */
const readProductName = (order: Order, product: Pick<Product, 'code' | 'name'> | null): string | null => {
  if (product !== null) return product.name;
  const snapshot = order.productSnapshot;
  if (typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)) {
    const name = (snapshot as Record<string, unknown>)['name'];
    if (typeof name === 'string') return name;
  }
  return null;
};

const readProductCode = (order: Order, product: Pick<Product, 'code' | 'name'> | null): string | null => {
  if (product !== null) return product.code;
  const snapshot = order.productSnapshot;
  if (typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)) {
    const code = (snapshot as Record<string, unknown>)['code'];
    if (typeof code === 'string') return code;
  }
  return null;
};

/**
 * `originalAmount` = 应付 + 优惠
 *
 * 校验过契约示例：`amount 3900 + discountAmount 3000 = originalAmount 6900` ✓。
 * 不直接读 `products.originalAmount` —— 商品改价后历史订单的原价就被改写了。
 */
export const buildOrderCoreView = (input: OrderCoreInput): AdminOrderCoreView => {
  const { order } = input;

  return {
    orderId: order.id,
    orderNo: order.orderNo,
    status: order.status,
    statusLabel: orderStatusLabel(order.status),
    productCode: readProductCode(order, input.product),
    productName: readProductName(order, input.product),
    productType: order.productType,
    quantity: order.quantity,
    amount: order.totalAmount,
    payAmount: order.paidAmount,
    originalAmount: order.totalAmount + order.discountAmount,
    discountAmount: order.discountAmount,
    currency: order.currency,
    // 契约字段名为 targetResourceId；落库字段是「报告 or 关系」二选一
    targetResourceId: order.relatedReportId ?? order.relatedRelationshipId ?? null,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
    expiredAt: order.expiredAt.toISOString(),
    closedAt: order.closedAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    refundedAt: input.refundedAt?.toISOString() ?? null,
    wechatPayEnv: input.wechatPayEnv,
  };
};

/** 支付渠道 → 微信 `trade_type`（契约 §3.14.6.2 的 `payment.tradeType`） */
const TRADE_TYPE_BY_CHANNEL: Readonly<Record<string, string>> = {
  WECHAT_JSAPI: 'JSAPI',
  WECHAT_NATIVE: 'NATIVE',
  WECHAT_H5: 'H5',
  SANDBOX: 'SANDBOX',
};

/** 订单详情里的 `payment` 块 */
export interface AdminOrderPaymentView {
  paymentId: string;
  outTradeNo: string;
  transactionId: string | null;
  prepayId: string | null;
  status: string;
  amount: number;
  payerTotal: number | null;
  /**
   * 契约要求「仅返回哈希（🚫 不返回明文）」，但 `payments` 表**没有**该列
   * （只有 `appid`/`mchid`/`bankType` 等）。此处固定返回 null：
   * 用 openid 明文顶替会直接违反架构 §14.2，返回值缺失只是功能缺口 ——
   * 两者风险不对等，故选择后者（见交付简报的契约/模型差异清单）。
   */
  payerOpenidHash: null;
  tradeType: string | null;
  tradeState: string | null;
  bankType: string | null;
  paidAt: string | null;
  notifyReceivedAt: string | null;
  /** `payments` 表无回调次数字段：有回调时间即视为 1 次（>1 无法还原） */
  notifyCount: number;
  /** 无「最近查询时间」字段 */
  lastQueryAt: null;
  /** 无对账字段 */
  isReconciled: null;
  reconciledAt: null;
}

export const buildOrderPaymentView = (payment: Payment | null): AdminOrderPaymentView | null => {
  if (payment === null) return null;

  return {
    paymentId: payment.id,
    outTradeNo: payment.outTradeNo,
    transactionId: payment.transactionId,
    prepayId: payment.prepayId,
    status: payment.status,
    amount: payment.amount,
    payerTotal: payment.payerAmount,
    payerOpenidHash: null,
    tradeType: TRADE_TYPE_BY_CHANNEL[payment.channel] ?? null,
    tradeState: payment.tradeState,
    bankType: payment.bankType,
    paidAt: payment.successTime?.toISOString() ?? null,
    notifyReceivedAt: payment.notifyReceivedAt?.toISOString() ?? null,
    notifyCount: payment.notifyReceivedAt === null ? 0 : 1,
    lastQueryAt: null,
    isReconciled: null,
    reconciledAt: null,
  };
};

/** 订单详情里的 `entitlements[]` 项 */
export interface AdminOrderEntitlementView {
  entitlementId: string;
  type: string;
  status: string;
  grantedAt: string;
  expiresAt: string | null;
  remainingCount: number | null;
  resourceId: string | null;
  sourceType: string;
  grantSource: string;
}

export const buildOrderEntitlementView = (entitlement: Entitlement): AdminOrderEntitlementView => ({
  entitlementId: entitlement.id,
  type: entitlement.type,
  status: entitlement.status,
  grantedAt: entitlement.startAt.toISOString(),
  expiresAt: entitlement.expireAt?.toISOString() ?? null,
  remainingCount: entitlement.remainingQuota,
  resourceId: entitlement.reportId ?? entitlement.relationshipId ?? null,
  sourceType: entitlement.orderId === null ? 'MANUAL' : 'ORDER',
  // 有发放管理员即人工发放；否则视为支付履约自动发放
  grantSource: entitlement.grantedByAdminId === null ? 'PAYMENT_FULFILLMENT' : 'ADMIN_GRANT',
});

/** 订单详情里的 `refunds[]` 项 */
export interface AdminOrderRefundView {
  refundId: string;
  refundNo: string;
  status: string;
  refundAmount: number;
  reason: string | null;
  errorMessage: string | null;
  createdAt: string;
  succeededAt: string | null;
}

export const buildOrderRefundView = (refund: Refund): AdminOrderRefundView => ({
  refundId: refund.id,
  refundNo: refund.refundNo,
  status: refund.status,
  refundAmount: refund.refundAmount,
  reason: refund.reason,
  errorMessage: refund.errorMessage,
  createdAt: refund.createdAt.toISOString(),
  succeededAt: refund.successTime?.toISOString() ?? null,
});

/** 最近一次成功退款时间（用于 `order.refundedAt` 与时间线） */
export const latestRefundSuccessAt = (refunds: readonly Refund[]): Date | null => {
  let latest: Date | null = null;

  for (const refund of refunds) {
    if (refund.status !== 'SUCCESS' || refund.successTime === null) continue;
    if (latest === null || refund.successTime.getTime() > latest.getTime()) {
      latest = refund.successTime;
    }
  }

  return latest;
};

/** 最近一次支付单（按创建时间倒序取首个；对齐 `payments.orderId` 索引） */
export const latestPayment = (payments: readonly Payment[]): Payment | null => {
  let latest: Payment | null = null;

  for (const payment of payments) {
    if (latest === null || payment.createdAt.getTime() > latest.createdAt.getTime()) {
      latest = payment;
    }
  }

  return latest;
};
