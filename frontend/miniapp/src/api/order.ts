/**
 * 订单与微信支付接口
 *
 * ## 后端只有两个支付相关接口（权威来源 `backend/src/modules/payment/payment.controller.ts`）
 *
 * | 接口                          | 用途                                    | 鉴权        |
 * | ----------------------------- | --------------------------------------- | ----------- |
 * | `POST /payment/orders`        | 创建订单并返回 JSAPI 支付参数（金额服务端读） | 需登录      |
 * | `POST /payment/notify/wechat` | 微信支付结果回调 —— **微信服务器调用，前端不碰** | 公开 + 原始响应 |
 *
 * 原文件里的 `/orders`、`/orders/{id}`、`/orders/{id}/query`、`/orders/{id}/cancel`
 * 后端**全都不存在**（下单实际在 `/payment/orders`）。见文件末尾的说明。
 *
 * ## 支付流程（架构文档 §13.2）
 *
 *   ① `createOrder()` → 服务端调微信 prepay → 返回 JSAPI 支付参数
 *   ② `uni.requestPayment(payParams)`
 *   ③ 服务端接收微信异步回调（验签 + 幂等）→ 发放权益
 *   ④ 前端**以服务端状态为准**确认结果（见下方「支付后的状态确认」）
 *
 * ## 安全约束
 *
 *   · 金额以服务端商品价格为准，前端不传金额（DTO 里刻意没有金额字段）
 *   · 前端支付成功 ≠ 权益已发放，必须以服务端状态为准
 *   · 创建订单必须携带幂等键，避免重复下单
 */

import { createIdempotencyKey } from '@/utils/request-id';

import { http } from './request';

/** 订单状态（与 Prisma `OrderStatus` 一致） */
export type OrderStatus =
  'CREATED' | 'PENDING_PAY' | 'PAID' | 'FULFILLED' | 'CLOSED' | 'CANCELLED' | 'REFUNDED' | 'PARTIAL_REFUNDED';

/**
 * `uni.requestPayment` 所需参数
 *
 * `signType` 后端固定返回 `'RSA'`（微信支付 v3）。
 */
export interface PaymentParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

/** 下单入参 */
export interface CreateOrderInput {
  /**
   * 商品 ID（UUID）—— 来自 `listProducts()` 的 `Product.productId`
   *
   * ⚠ 不是 `code`：后端用 `@IsUUID()` 校验，传商品编码会被拒为 `400 / 10001`。
   */
  productId: string;
  /** 购买单份报告解锁时提供 */
  reportId?: string;
  /** 购买匹配报告时提供 */
  relationshipId?: string;
}

/** 下单结果（后端 `OrderCreatedView`） */
export interface OrderCreated {
  orderId: string;
  orderNo: string;
  /** 金额（分），由服务端从商品表读取 */
  amount: number;
  currency: string;
  /** 订单支付超时时间；超时后订单会被关闭 */
  expiresAt: string;
  /**
   * 支付参数；**预支付失败时为 `null`**
   *
   * 原文件把这个字段声明为非空，直接取 `payment.package` 会在预支付失败时抛
   * `TypeError: Cannot read properties of null`。调用方必须先判空，
   * 为 `null` 时用 `paymentUnavailableReason` 提示用户并允许重试。
   */
  payment: PaymentParams | null;
  /** 未返回支付参数时的原因（便于前端提示与排查） */
  paymentUnavailableReason?: string;
}

/**
 * 创建订单并获取支付参数
 *
 * 幂等键由本函数自动生成：同一意图重复调用会被服务端识别，避免重复下单。
 */
export const createOrder = (input: CreateOrderInput): Promise<OrderCreated> =>
  http.post<OrderCreated>(
    '/payment/orders',
    {
      productId: input.productId,
      ...(input.reportId === undefined ? {} : { reportId: input.reportId }),
      ...(input.relationshipId === undefined ? {} : { relationshipId: input.relationshipId }),
    },
    { timeout: 30_000, idempotencyKey: createIdempotencyKey() },
  );

// ---------------------------------------------------------------------------
// 未实现的后端端点（**刻意不提供客户端**）
// ---------------------------------------------------------------------------
//
// 契约 §3.9.3–3.9.6 定义了订单查询/取消接口，但后端**尚未实现**，
// 调用只会得到 `404 / 10002`。保留它们会制造「功能已就绪」的假象：
// 页面调过去失败时，排查方向会被引向网络或前端，而真正原因是端点不存在。
//
//   · GET  /orders                       契约 §3.9.3（我的订单列表）
//   · GET  /orders/{orderId}             契约 §3.9.4（订单详情）
//   · POST /orders/{orderId}/query       契约 §3.9.5（主动向微信查单）
//   · POST /orders/{orderId}/cancel      契约 §3.9.6（取消未支付订单）
//
// ## 支付后的状态确认（重要）
//
// 由于上述查询接口缺失，前端在 `uni.requestPayment` 成功后**无法直接查订单状态**。
// 现阶段可行的确认方式是「查业务状态」而非「查订单」：
//   · 买会员  → 重新拉 `GET /membership`，看 `isMember` / `expireAt`
//   · 买报告  → 重新拉报告详情，看 `isUnlocked` / `unlockType`
// 注意微信回调是异步的，支付成功后立刻查可能仍是旧状态，需要带退避的重试
// （建议 2s 起、上限 5 次），并明确告知用户「支付结果确认中」。
//
// 待后端补上订单查询接口后，这里应改为以订单状态为权威依据 —— 业务状态只能
// 证明「权益到了」，无法区分「回调还没到」与「扣款了但发放失败」。
