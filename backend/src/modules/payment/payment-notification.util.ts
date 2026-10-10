/**
 * 微信支付回调的业务判定（纯函数，无 I/O、可 100% 单测）
 *
 * 验签与解密解决的是"这确实来自微信、内容没被篡改"（见 `wechat-pay-crypto.util.ts`）；
 * 本文件解决的是**"这条通知该不该发货"** —— 后者才是资金风险所在。
 *
 * 三条铁律，每条都对应一种真实的资损场景：
 *
 * ① **必须核对商户号**。攻击者若拿到过任意一个真实回调体（例如自己的订单），
 *    可以把它重放到别人的服务上。验签能过（确实是微信签的），但商户号不是我们的。
 *
 * ② **必须核对金额**。回调里的 `amount.total` 若小于订单应付额，按回调发货就是
 *    "付 1 分拿 199 元商品"。金额只信**订单侧**的记录，回调里的金额只用来比对。
 *
 * ③ **已发货的订单不重复发货**。微信对同一笔支付可能多次投递通知（网络重试、
 *    我们响应超时）。第二次必须识别为"已处理"并直接返回成功，
 *    否则用户付一次钱拿到多份权益。
 */

/** 回调被拒绝的原因（用于日志与监控，不对外暴露细节） */
export type PaymentNotificationRejection =
  'MCHID_MISMATCH' | 'MISSING_FIELD' | 'TRADE_STATE_NOT_SUCCESS' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH';

/** 解析后的支付通知 */
export interface ParsedPaymentNotification {
  /** 商户订单号（我们生成并传给微信的 `out_trade_no`） */
  readonly orderNo: string;
  /** 微信支付订单号（对账与退款时使用） */
  readonly transactionId: string;
  /**
   * 实付金额（**分**）
   *
   * ⚠ 这是**回调声称**的金额，只能用于与订单应付额比对，
   * **绝不能**作为记账依据 —— 记账用订单上的 `paidAmount`。
   */
  readonly claimedAmount: number;
  readonly currency: string;
  /** `SUCCESS` / `REFUND` / `NOTPAY` / `CLOSED` 等 */
  readonly tradeState: string;
  readonly successTime: string | null;
}

/** 解析结果 */
export type ParseNotificationResult =
  | { readonly ok: true; readonly value: ParsedPaymentNotification }
  | { readonly ok: false; readonly reason: PaymentNotificationRejection };

/** 从解密后的对象里安全取字符串 */
const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** 从解密后的对象里安全取非负整数（金额必须是整数分，不接受小数） */
const readInteger = (source: Record<string, unknown>, key: string): number | null => {
  const value = source[key];

  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/**
 * 解析解密后的支付通知
 *
 * **顺序有意义**：先校商户号（决定"这条通知是不是发给我们的"），
 * 再看交易状态（决定"是不是成功支付"），最后校金额与币种。
 * 反过来的话，一条商户号不匹配的通知如果状态不是 SUCCESS，会先被报成
 * `TRADE_STATE_NOT_SUCCESS` —— 掩盖了"这是发给别人的通知"这个更重要的事实。
 *
 * @param decrypted `decryptWechatPayResource` 的产物
 * @param expectedMchId 我们自己的商户号（来自配置）
 */
export const parseWechatPayNotification = (
  decrypted: Record<string, unknown>,
  expectedMchId: string,
): ParseNotificationResult => {
  const mchid = readString(decrypted, 'mchid');
  if (mchid === null) return { ok: false, reason: 'MISSING_FIELD' };
  if (mchid !== expectedMchId) return { ok: false, reason: 'MCHID_MISMATCH' };

  const orderNo = readString(decrypted, 'out_trade_no');
  const transactionId = readString(decrypted, 'transaction_id');
  const tradeState = readString(decrypted, 'trade_state');
  const currency = readString(decrypted, 'currency') ?? 'CNY';

  if (orderNo === null || transactionId === null || tradeState === null) {
    return { ok: false, reason: 'MISSING_FIELD' };
  }

  if (tradeState !== 'SUCCESS') return { ok: false, reason: 'TRADE_STATE_NOT_SUCCESS' };

  // 金额在嵌套的 `amount` 对象里
  const amount = decrypted['amount'];
  if (typeof amount !== 'object' || amount === null) return { ok: false, reason: 'MISSING_FIELD' };

  const total = readInteger(amount as Record<string, unknown>, 'total');
  if (total === null) return { ok: false, reason: 'MISSING_FIELD' };

  const amountCurrency = readString(amount as Record<string, unknown>, 'currency');
  if (amountCurrency !== null && amountCurrency !== currency) return { ok: false, reason: 'CURRENCY_MISMATCH' };

  return {
    ok: true,
    value: {
      orderNo,
      transactionId,
      claimedAmount: total,
      currency,
      tradeState,
      successTime: readString(decrypted, 'success_time'),
    },
  };
};

/**
 * 订单状态（与 Prisma `OrderStatus` 严格对齐）
 *
 * 写成联合类型而不是 `string`：本轮就写错过一次（用了并不存在的 `EXPIRED`），
 * 而 `string` 类型下编译器不会报错、测试也未必覆盖到那条分支 ——
 * 结果是超时关单的订单被当成待支付而发货。收紧成联合类型后这类错误编译期即失败。
 */
export type OrderStatusValue =
  'CREATED' | 'PENDING_PAY' | 'PAID' | 'FULFILLED' | 'CLOSED' | 'CANCELLED' | 'REFUNDED' | 'PARTIAL_REFUNDED';

/** 订单侧的最小信息（用于发货判定） */
export interface OrderForFulfillment {
  readonly orderNo: string;
  /** 订单应付金额（分） */
  readonly totalAmount: number;
  readonly paidAmount: number;
  readonly currency: string;
  readonly status: OrderStatusValue;
}

/** 发货决定 */
export type FulfillmentDecision =
  /** 首次支付成功，需要发货（标记订单已付 + 发放权益） */
  | { readonly action: 'FULFILL'; readonly paidAmount: number }
  /** 已处理过，直接返回成功（幂等命中） */
  | { readonly action: 'ALREADY_FULFILLED'; readonly paidAmount: number }
  /** 拒绝，不发货 */
  | { readonly action: 'REJECT'; readonly reason: FulfillmentRejection };

/** 拒绝发货的原因 */
export type FulfillmentRejection =
  'ORDER_NOT_FOUND' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'ORDER_CLOSED' | 'ORDER_CANCELLED' | 'ORDER_REFUNDED';

/**
 * 决定一条支付通知该如何处理
 *
 * 状态取值与 Prisma `OrderStatus` 严格一致
 * （`CREATED | PENDING_PAY | PAID | FULFILLED | CLOSED | CANCELLED | REFUNDED | PARTIAL_REFUNDED`）。
 * 曾经写过 `EXPIRED` 这个**并不存在**的状态 —— 那样的分支永远不会命中，
 * 超时关单的订单会被当成待支付而发货。
 *
 * @param order 订单（`null` 表示库里没有这个 `orderNo`）
 * @param notification 解析后的通知
 */
export const decideFulfillment = (
  order: OrderForFulfillment | null,
  notification: ParsedPaymentNotification,
): FulfillmentDecision => {
  if (order === null) return { action: 'REJECT', reason: 'ORDER_NOT_FOUND' };

  const { status } = order;

  // 已取消 / 已关单 / 已退款：不再发货。
  // 用户或运营可能已明确终止了它，此时再发货会造成"订单是终态但权益已发放"的账实不符
  if (status === 'CANCELLED') return { action: 'REJECT', reason: 'ORDER_CANCELLED' };
  if (status === 'CLOSED') return { action: 'REJECT', reason: 'ORDER_CLOSED' };
  if (status === 'REFUNDED' || status === 'PARTIAL_REFUNDED') {
    return { action: 'REJECT', reason: 'ORDER_REFUNDED' };
  }

  // 【关键】金额比对：以**订单侧**应付额为准，回调金额只用于比对。
  // 要求完全相等而不是"大于等于" —— 多付也是异常（可能是串单），必须人工介入
  if (notification.claimedAmount !== order.totalAmount) {
    return { action: 'REJECT', reason: 'AMOUNT_MISMATCH' };
  }

  if (notification.currency !== order.currency) return { action: 'REJECT', reason: 'CURRENCY_MISMATCH' };

  // 幂等：已支付或已发货 → 不重复发货。
  // 微信会对同一笔支付多次投递（网络重试、我们响应超时），
  // 第二次必须识别为"已处理"并返回成功，否则用户付一次钱拿到多份权益
  if (status === 'PAID' || status === 'FULFILLED') {
    return { action: 'ALREADY_FULFILLED', paidAmount: order.paidAmount };
  }

  return { action: 'FULFILL', paidAmount: order.totalAmount };
};

/**
 * 权益发放的幂等键
 *
 * `entitlements.idempotencyKey` 有唯一约束，因此这个键是**数据库层**的防重闸门 ——
 * 比"先查再插"可靠：并发投递两条回调时，应用层的查询都会说"还没有"，
 * 而唯一约束只会放行一条。
 *
 * 用 `order:{orderNo}` 而不是 `transactionId`：订单号是我们生成的、
 * 在退款重下单等场景下稳定；而同一笔支付可能对应多次通知，用交易号
 * 反而会让"同一订单的第二次通知"生成不同的键，失去防重作用。
 */
export const entitlementIdempotencyKey = (orderNo: string, suffix = 'main'): string =>
  `order:${orderNo}:${suffix}`.slice(0, 128);
