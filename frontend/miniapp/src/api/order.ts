/**
 * 商品与订单接口（微信支付 JSAPI）
 *
 * 支付流程（架构文档 §13.2）：
 *   ① 前端 POST /orders 创建订单 → 服务端调微信 prepay → 返回 JSAPI 支付参数
 *   ② 前端 wx.requestPayment(payParams)
 *   ③ 服务端接收微信异步回调（验签 + 幂等）→ 发放权益
 *   ④ 前端轮询 GET /orders/{id}（或支付成功页主动查单）确认最终状态
 *
 * 安全约束：
 *   · 金额以服务端商品价格为准，前端不传金额
 *   · 前端支付成功 ≠ 权益已发放，必须以服务端订单状态为准
 *   · 创建订单必须携带幂等键，避免重复下单
 */

import { http, httpPage } from './request';
import { createIdempotencyKey } from '@/utils/request-id';
import type { PaginatedData } from './types';

/** 商品类型 */
export type ProductType = 'REPORT_PERSONAL' | 'REPORT_COMPATIBILITY' | 'MEMBERSHIP' | 'AI_CREDITS';

/** 商品 */
export interface Product {
  code: string;
  type: ProductType;
  name: string;
  description: string;
  /** 现价（分） */
  priceAmount: number;
  originalAmount: number | null;
  /** 关联资源（如报告解锁对应 reportId） */
  targetId: string | null;
  /** 权益摘要文案 */
  benefitText: string;
}

/** 订单状态 */
export type OrderStatus =
  'CREATED' | 'PENDING_PAY' | 'PAID' | 'FULFILLED' | 'CLOSED' | 'CANCELLED' | 'REFUNDED' | 'PARTIAL_REFUNDED';

/** 订单 */
export interface Order {
  id: string;
  orderNo: string;
  productCode: string;
  productName: string;
  /** 应付金额（分） */
  amount: number;
  /** 实付金额（分） */
  paidAmount: number | null;
  status: OrderStatus;
  /** 权益是否已发放（前端据此决定是否解锁内容） */
  fulfilled: boolean;
  createdAt: string;
  /** 未支付订单的自动关闭时间 */
  expiredAt: string;
  paidAt: string | null;
}

/** wx.requestPayment 所需参数 */
export interface PaymentParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

/** 下单结果 */
export interface CreateOrderResult {
  order: Order;
  payment: PaymentParams;
}

/** 商品列表（用于报告解锁、会员、AI 套餐的购买入口） */
export const listProducts = (query: { type?: ProductType } = {}): Promise<Product[]> =>
  http.get<Product[]>('/products', query, { needAuth: false, showError: false });

/**
 * 创建订单并获取支付参数
 * 幂等键在调用时生成一次；重试同一笔订单必须复用同一 key（由调用方保存）
 */
export const createOrder = (payload: { productCode: string; idempotencyKey?: string }): Promise<CreateOrderResult> =>
  http.post<CreateOrderResult>(
    '/orders',
    { productCode: payload.productCode },
    { timeout: 30_000, idempotencyKey: payload.idempotencyKey ?? createIdempotencyKey() },
  );

/** 订单列表 */
export const listOrders = (
  query: { page?: number; pageSize?: number; status?: OrderStatus } = {},
): Promise<PaginatedData<Order>> => httpPage('/orders', query);

/** 订单详情 */
export const getOrder = (orderId: string): Promise<Order> => http.get<Order>(`/orders/${orderId}`);

/**
 * 主动查单（补偿机制）
 * 微信回调可能延迟或丢失，前端在支付返回后调用此接口向微信侧主动查询并对账
 */
export const queryOrder = (orderId: string): Promise<Order> =>
  http.post<Order>(`/orders/${orderId}/query`, {}, { timeout: 20_000, showError: false });

/** 取消订单（仅未支付状态可取消） */
export const cancelOrder = (orderId: string): Promise<void> => http.post<void>(`/orders/${orderId}/cancel`, {});
