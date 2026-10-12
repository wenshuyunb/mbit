/**
 * 用户端订单查询纯逻辑（无 I/O、可 100% 单测）
 *
 * 契约 §3.9.3 ~ §3.9.7。
 *
 * ## 为什么单独成文件
 *
 * 契约响应里有大量**推导**字段（`statusLabel`、`statusDescription`、`canRefund`、
 * `canQuery`、`canClose`、`remainingSeconds`、`timeline`）。这些字段一旦散在 Service
 * 里就只能靠 mock 间接覆盖，而「可退金额为 0 时 `canRefund` 必须为 false」
 * 「已过期订单 `canCancel` 必须为 false」这类边界恰恰是线上事故高发区。
 *
 * ## 与 `admin/order/admin-order.util.ts` 的关系（刻意复用）
 *
 * `computeRefundableAmount` / `orderStatusLabel` / `REFUND_WINDOW_DAYS` **直接复用**
 * 管理端那份，不在此处重写：
 *   · 「可退金额 = 实付 − 已退，且夹到 ≥ 0」是**资金口径**，用户端与管理端算出
 *     不同的数就是资损；
 *   · 状态中文名两端不一致（「已完成」vs「已支付」）会让客服与用户看到不同的说法。
 * 该文件是**纯函数模块**（无 NestIO 装饰器、无 DI），因此这个 import 不会让
 * 用户端的 payment 模块依赖管理端的 Nest 模块。
 */

import type { OrderStatus } from '@prisma/client';

import { REFUND_WINDOW_DAYS, computeRefundableAmount, orderStatusLabel } from '../admin/order/admin-order.util';

export { REFUND_WINDOW_DAYS, computeRefundableAmount, orderStatusLabel };

// ============================================================================
// 状态展示
// ============================================================================

/**
 * 状态补充说明（契约 §3.9.4 的 `statusDescription`）
 *
 * 与 `statusLabel`（短标签，列表页用）分开：详情页需要一句解释「现在能做什么」，
 * 而把这句话塞进 label 会让列表页每行都变成一段话。
 */
const ORDER_STATUS_DESCRIPTIONS: Readonly<Record<OrderStatus, string>> = {
  CREATED: '订单已创建，尚未拉起支付。',
  PENDING_PAY: '订单待支付，请在有效期内完成支付，超时将自动关闭。',
  PAID: '支付成功，正在发放权益。',
  FULFILLED: '支付成功，权益已发放。',
  CLOSED: '订单已关闭（超时未支付或已失效），可重新下单。',
  CANCELLED: '订单已由用户取消，可重新下单。',
  REFUNDED: '订单已全额退款，对应权益已撤销。',
  PARTIAL_REFUNDED: '订单已部分退款。',
};

/** 状态中文说明；未知状态回落空串（便于发现新增状态未登记） */
export const orderStatusDescription = (status: string): string =>
  ORDER_STATUS_DESCRIPTIONS[status as OrderStatus] ?? '';

// ============================================================================
// 权益
// ============================================================================

/** 权益消费判定所需的最小字段 */
export interface EntitlementConsumptionInput {
  readonly status: string;
  readonly usedQuota: number;
}

/**
 * 权益是否**已被消费**
 *
 * 契约 §3.9.10 规则 1：权益已消费（报告已解锁查看、AI 次数已用）→ 不支持退款。
 * 判定口径取「状态为 `CONSUMED` 或已用次数 > 0」：
 *   · 只判 `status === 'CONSUMED'` 会漏掉计数型权益（`AI_CREDITS` 用的是
 *     `usedQuota` 递减，状态可能仍是 `ACTIVE`）—— 那会让「用过 3 次 AI 对话」
 *     仍可全额退款；
 *   · 把 `REVOKED` 也算作消费会自相矛盾（驳回退款的原因写成"已撤销"）。
 */
export const isEntitlementConsumed = (entitlement: EntitlementConsumptionInput): boolean =>
  entitlement.status === 'CONSUMED' || entitlement.usedQuota > 0;

/** 该笔订单是否含已消费权益 */
export const hasConsumedEntitlement = (entitlements: readonly EntitlementConsumptionInput[]): boolean =>
  entitlements.some((entitlement) => isEntitlementConsumed(entitlement));

// ============================================================================
// 商品类型 → 权益类型
// ============================================================================

/**
 * 商品类型 → 发放的权益类型（与 `payment.service.ts` 的 `GRANT_BY_PRODUCT_TYPE` 对齐）
 *
 * 详情页的 `productSnapshot.grantedEntitlementType` 需要它；不直接读权益表是因为
 * **未发货的订单也要能展示"买到了什么"**（例如 `PAID` 但还没发权益的窗口期）。
 */
const GRANTED_ENTITLEMENT_BY_PRODUCT_TYPE: Readonly<Record<string, string>> = {
  REPORT_PERSONAL: 'REPORT_UNLOCK',
  REPORT_COMPATIBILITY: 'REPORT_UNLOCK',
  MEMBERSHIP: 'MEMBERSHIP_ACTIVE',
  AI_CREDITS: 'AI_CREDITS',
};

/** 商品类型 → 权益类型；未知类型返回 `null`（不猜测） */
export const grantedEntitlementTypeOf = (productType: string): string | null =>
  GRANTED_ENTITLEMENT_BY_PRODUCT_TYPE[productType] ?? null;

// ============================================================================
// 商品快照
// ============================================================================

/** 契约 §3.9.4 的 `productSnapshot` */
export interface OrderProductSnapshotView {
  readonly name: string | null;
  readonly durationDays: number | null;
  readonly grantedEntitlementType: string | null;
  readonly priceAmountAtPurchase: number | null;
}

/** 从 `unknown` 里安全取字符串（JsonB 列的内容无法在类型层保证） */
const readSnapshotString = (snapshot: Record<string, unknown>, key: string): string | null => {
  const value = snapshot[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** 从 `unknown` 里安全取整数 */
const readSnapshotInteger = (snapshot: Record<string, unknown>, key: string): number | null => {
  const value = snapshot[key];

  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
};

/**
 * 组装 `productSnapshot`
 *
 * 只暴露契约声明的四个字段：快照里还有 `productType` / `snapshotAt` / `productId`，
 * 全部透传会把内部实现细节泄露到对外契约里（日后想改快照结构就成了破坏性变更）。
 * 商品类型**由订单当前行提供而不是快照**，这样历史订单（快照里没有该字段）也能算出来。
 */
export const buildOrderProductSnapshotView = (snapshot: unknown, productType: string): OrderProductSnapshotView => {
  const grantedEntitlementType = grantedEntitlementTypeOf(productType);

  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return { name: null, durationDays: null, grantedEntitlementType, priceAmountAtPurchase: null };
  }

  const record = snapshot as Record<string, unknown>;

  return {
    name: readSnapshotString(record, 'name'),
    durationDays: readSnapshotInteger(record, 'durationDays'),
    grantedEntitlementType,
    // 契约字段名是 `priceAmountAtPurchase`，快照里存的是 `priceAmount`
    priceAmountAtPurchase: readSnapshotInteger(record, 'priceAmount'),
  };
};

// ============================================================================
// 时间线
// ============================================================================

/** 契约 §3.9.4 的 `timeline[]` 项（用户端**不带** `actor`，与 §3.14.6.2 不同） */
export interface OrderTimelineEventView {
  readonly event: string;
  readonly label: string;
  readonly at: string;
}

/** 时间线输入 */
export interface OrderTimelineSource {
  readonly createdAt: Date;
  readonly paidAt: Date | null;
  readonly fulfilledAt: Date | null;
  readonly closedAt: Date | null;
  readonly cancelledAt: Date | null;
  /** 支付单创建时间（`PREPAY_SUCCESS` 节点） */
  readonly paymentCreatedAt: Date | null;
  /** 支付单状态；`INIT` 表示预支付未完成，不产生节点 */
  readonly paymentStatus: string | null;
  /** 最近一次成功退款时间 */
  readonly refundSuccessAt: Date | null;
}

/**
 * 组装时间线（升序）
 *
 * 升序的理由：时间线回答的是「发生了什么」，倒序会让读者先看到结果再看到原因。
 * 契约示例也是升序。
 */
export const buildOrderTimelineView = (source: OrderTimelineSource): OrderTimelineEventView[] => {
  const events: OrderTimelineEventView[] = [
    { event: 'CREATED', label: '订单创建', at: source.createdAt.toISOString() },
  ];

  // `payments.status === 'INIT'` 说明预支付单还没建成功（`prepayId` 为空），
  // 此时把支付单的创建时间当成「预支付成功」是错的
  if (source.paymentCreatedAt !== null && source.paymentStatus !== null && source.paymentStatus !== 'INIT') {
    events.push({
      event: 'PREPAY_SUCCESS',
      label: '微信预支付成功',
      at: source.paymentCreatedAt.toISOString(),
    });
  }

  if (source.paidAt !== null) {
    events.push({ event: 'PAID', label: '支付成功', at: source.paidAt.toISOString() });
  }

  if (source.fulfilledAt !== null) {
    events.push({ event: 'FULFILLED', label: '权益已发放', at: source.fulfilledAt.toISOString() });
  }

  if (source.refundSuccessAt !== null) {
    events.push({ event: 'REFUNDED', label: '退款成功', at: source.refundSuccessAt.toISOString() });
  }

  if (source.cancelledAt !== null) {
    events.push({ event: 'CANCELLED', label: '用户取消订单', at: source.cancelledAt.toISOString() });
  }

  if (source.closedAt !== null) {
    events.push({ event: 'CLOSED', label: '订单关闭', at: source.closedAt.toISOString() });
  }

  return events.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
};

// ============================================================================
// 可执行操作（`canPay` / `canCancel` / `canClose` / `canQuery` / `canRefund`）
// ============================================================================

/** 已支付（可退款）的状态集合 */
const REFUNDABLE_STATUSES: ReadonlySet<string> = new Set(['PAID', 'FULFILLED', 'PARTIAL_REFUNDED']);

/** 未支付（可取消 / 可关单 / 可支付）的状态集合 */
const UNPAID_STATUSES: ReadonlySet<string> = new Set(['CREATED', 'PENDING_PAY']);

/** `canQuery` 要求订单已创建超过该秒数（契约 §3.9.3 规则 3：创建超过 1 分钟） */
export const QUERY_MIN_AGE_SECONDS = 60;

/** 主动查单的节流窗口（契约 §3.9.5 规则 3：最近 30s 已查过则直接返回上次结果） */
export const QUERY_THROTTLE_SECONDS = 30;

/** 操作可见性输入 */
export interface OrderActionInput {
  readonly status: string;
  readonly createdAt: Date;
  readonly paidAt: Date | null;
  /** 可退金额（`paidAmount - refundedAmount`，已夹到 ≥ 0） */
  readonly refundableAmount: number;
  /** 订单关联的权益（用于「权益是否已消费」判定） */
  readonly entitlements: readonly EntitlementConsumptionInput[];
  readonly now: Date;
}

/** 操作可见性（前端只据此渲染按钮，后端每个 `true` 都必须真能执行） */
export interface OrderActionFlags {
  readonly canPay: boolean;
  readonly canCancel: boolean;
  readonly canClose: boolean;
  readonly canQuery: boolean;
  readonly canRefund: boolean;
}

/**
 * 推导操作可见性
 *
 * 与契约 §3.9.6 / §3.9.7 的状态约束**逐条对应**，宁可保守：
 *   · `PAID` 之后不可取消（契约明确）→ `canCancel = false`
 *   · `canRefund` 要求「状态可退 + 可退金额 > 0 + 权益未消费 + 在 7 天窗口内」
 *     四项同时成立（契约 §3.9.3 规则 2）
 *   · `canQuery` 仅 `PENDING_PAY` 且创建超过 1 分钟（契约 §3.9.3 规则 3）
 */
export const deriveOrderActionFlags = (input: OrderActionInput): OrderActionFlags => {
  const unpaid = UNPAID_STATUSES.has(input.status);
  const withinRefundWindow =
    input.paidAt !== null && input.now.getTime() - input.paidAt.getTime() <= REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  return {
    canPay: unpaid,
    canCancel: unpaid,
    canClose: unpaid,
    canQuery:
      input.status === 'PENDING_PAY' && input.now.getTime() - input.createdAt.getTime() >= QUERY_MIN_AGE_SECONDS * 1000,
    canRefund:
      REFUNDABLE_STATUSES.has(input.status) &&
      input.refundableAmount > 0 &&
      withinRefundWindow &&
      !hasConsumedEntitlement(input.entitlements),
  };
};

// ============================================================================
// 支付倒计时
// ============================================================================

/**
 * 剩余支付秒数（契约 §3.9.4 的 `remainingSeconds`）
 *
 * 只对 `PENDING_PAY` 有意义（契约规则 4）；其余状态一律 0。夹到 ≥ 0 ——
 * 前端把负数渲染成倒计时会直接显示 `-00:32`。
 */
export const computeRemainingSeconds = (status: string, expiredAt: Date, now: Date): number => {
  if (status !== 'PENDING_PAY') return 0;

  return Math.max(0, Math.ceil((expiredAt.getTime() - now.getTime()) / 1000));
};

/** 是否已过期（`CREATED` 也参与：超时关单扫描同时覆盖两个未支付状态） */
export const isOrderExpired = (expiredAt: Date, now: Date): boolean => expiredAt.getTime() <= now.getTime();

// ============================================================================
// 分页
// ============================================================================

/** 统一分页口径（契约 §2.2：`{ items, total, page, pageSize, hasNext }`） */
export interface PaginatedView<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
}

/** 组装分页包络（`hasNext` 由「已取条数」推导，避免 `page*pageSize < total` 的边界误判） */
export const buildPaginatedView = <T>(items: T[], total: number, page: number, pageSize: number): PaginatedView<T> => ({
  items,
  total,
  page,
  pageSize,
  hasNext: page * pageSize < total,
});

/** 分页上限（契约 §3.9.3：`pageSize ≤ 100`） */
export const MAX_PAGE_SIZE = 100;

/** 默认每页条数（契约 §3.9.3） */
export const DEFAULT_PAGE_SIZE = 20;
