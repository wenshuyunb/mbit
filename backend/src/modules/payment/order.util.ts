/**
 * 订单纯逻辑（无 I/O、可 100% 单测）
 *
 * 契约 §3.7；架构 §13.3。
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';

/** 订单号前缀（商户自定义，微信要求 6–32 位字母数字与 `_-|*`） */
const ORDER_NO_PREFIX = 'SM';

/**
 * 订单号长度
 *
 * `orders.order_no` 是 `VarChar(32)`，微信要求 ≤32。这里固定 20 位：
 * `SM` + `yyyyMMdd` + 10 位随机 —— 留出充足余量，且**肉眼可读**
 * （客服拿到订单号能一眼看出下单日期）。
 */
const RANDOM_PART_LENGTH = 10;

/**
 * 生成订单号
 *
 * 用 `crypto.randomInt` 而非 `Math.random`：订单号会出现在支付参数与对账里，
 * 可预测的订单号让攻击者能**猜中他人订单号**去做越权查询。
 *
 * 日期 + 10 位随机数在单日内的空间是 10^10，配合 `order_no` 的唯一约束与
 * 调用方的冲突重试，实际不会碰撞。
 */
export const generateOrderNo = (now: Date): string => {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  let random = '';
  for (let index = 0; index < RANDOM_PART_LENGTH; index += 1) {
    random += String(randomInt(10));
  }

  return `${ORDER_NO_PREFIX}${year}${month}${day}${random}`;
};

/** 订单号是否合法（用于按订单号查询时的边界校验） */
export const isValidOrderNo = (orderNo: string): boolean => /^SM\d{18}$/.test(orderNo);

/**
 * 订单有效期（分钟）—— **兜底值**，契约 §3.9.2 规则 5 与 `/system/config` 都是 30
 *
 * ⚠ 这里原先是 **15**，且注释引用的是不存在的「契约 §3.7」（§3.7 是 AI 助手章）——
 * 于是出现三方不一致：契约三处（§3.9.2 规则 5、§3.9 时序图、下单接口说明）都写
 * `expiredAt = createdAt + 30min`，`/system/config` 的
 * `featuresExplain.FEATURE_PAYMENT.orderExpireMinutes` 也按 30 下发，
 * 只有真正的关单行为按 15 分钟执行 —— 运营在后台看到 30、实际 15。
 *
 * **后续改进（未做）**：彻底的做法是让这里读 `payment.orderExpireMinutes` 配置
 * （与 `/system/config` 同源），否则运营把配置改成 45 分钟时行为仍停在常量上，
 * 同类不一致会再次出现。当前先对齐数值。
 */
export const ORDER_TTL_MINUTES = 30;

/** 计算订单过期时间 */
export const orderExpiresAt = (now: Date, ttlMinutes = ORDER_TTL_MINUTES): Date =>
  new Date(now.getTime() + ttlMinutes * 60_000);

/** 客户端标识（`order.clientIp`）—— 微信要求 ≤64 字符，且不接受 `::ffff:` 前缀 */
export const normalizeClientIp = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // IPv4-mapped IPv6（`::ffff:1.2.3.4`）在日志与风控里都被当成 IPv6，
  // 转换后才能与纯 IPv4 的规则一致匹配
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);

  return (mapped?.[1] ?? trimmed).slice(0, 64);
};

/**
 * 支付金额校验（分）
 *
 * 微信要求金额为**整数分**且 > 0。前端常传"元"（如 `199` 表示 199 元），
 * 直接当分用会少收 100 倍 —— 这类错误在测试环境用小额订单时完全看不出来。
 * 因此金额一律由**服务端**从商品快照读取，不接受客户端传值。
 */
export const isValidPayAmount = (amount: number): boolean =>
  Number.isSafeInteger(amount) && amount > 0 && amount <= 100_000_000;

/**
 * 商品快照
 *
 * 下单时把商品信息**复制一份**存进订单：商品价格与名称日后会被运营修改，
 * 而订单必须永远反映**下单当时**的约定 —— 否则用户看到的订单详情
 * 会与他实际购买的东西不一致，退款金额也无从计算。
 */
export interface ProductSnapshotInput {
  readonly productId: string;
  readonly code: string;
  readonly name: string;
  readonly priceAmount: number;
  readonly productType: string;
  readonly durationDays: number | null;
}

export const buildProductSnapshot = (product: ProductSnapshotInput, now: Date): Record<string, unknown> => ({
  productId: product.productId,
  code: product.code,
  name: product.name,
  priceAmount: product.priceAmount,
  productType: product.productType,
  durationDays: product.durationDays,
  // 快照时间：日后排查"为什么这个订单是 19.9 而现在是 29.9"时唯一能回答的字段
  snapshotAt: now.toISOString(),
});

/** 幂等键的随机部分（写入 `orders.idempotency_key`，供微信侧下单幂等使用） */
export const generateOrderIdempotencyKey = (): string => randomBytes(12).toString('hex');

// ============================================================================
// 下单幂等（契约 §2.9.2 —— `POST /payment/orders` 必须携带 X-Idempotency-Key）
// ============================================================================

/** 下单幂等键在 Redis 中的前缀 */
export const ORDER_IDEMPOTENCY_PREFIX = 'idem:payment:order';

/**
 * 幂等重放窗口（秒）—— **刻意与订单有效期相等**
 *
 * 不做成"永久重放"：订单 30 分钟后失效，此后客户端拿同一个
 * `X-Idempotency-Key` 重试时**应当拿到一张新订单**。否则用户会永久卡在
 * 一张付不了款的过期订单上 —— 每次重试都只把那张死单还给他。
 */
export const ORDER_IDEMPOTENCY_TTL_SECONDS = ORDER_TTL_MINUTES * 60;

/**
 * 构造下单幂等键的摘要部分
 *
 * 客户端传来的键是**可控字符串**，原样拼进 Redis 键空间不合适
 * （与 `data-export.service.ts` 的处理一致）；摘要里再带上 `userId`，
 * 避免两个用户偶然用了同一个键（如前端写死的常量）而互相顶掉重放结果。
 *
 * 为什么不复用 `orders.idempotency_key` 列：该列是 `VarChar(64)` **全局唯一**，
 * 且当前承载的是服务端随机生成的微信下单幂等值。把客户端键写进去会同时踩到
 * 「跨用户撞键」与「超列长度」两个坑（同款推理见 `refund.util.ts`）。
 */
export const buildOrderIdempotencyDigest = (userId: string, clientKey: string): string =>
  createHash('sha256').update(`${userId}:${clientKey}`).digest('hex').slice(0, 32);
