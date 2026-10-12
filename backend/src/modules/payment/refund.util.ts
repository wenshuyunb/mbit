/**
 * 退款纯逻辑（无 I/O、可 100% 单测）
 *
 * 契约 §3.9.9 / §3.9.10 / §3.14.6.3；架构 §13.2 / §13.3。
 *
 * ## 为什么把退款判定全部抽成纯函数
 *
 * 退款是本项目**唯一会真实出款**的链路。它的每一个分支都对应一种资损形态：
 *   · 金额算错 → 多退钱
 *   · 状态判定错 → 「钱退了但订单还是已支付」或「订单标了已退款但钱没退」
 *   · 权益回收漏掉 → 退款后用户仍然免费用着会员
 *
 * 把「该不该退、退多少、退成什么状态、要撤销哪些权益」变成纯函数后，这些边界
 * 可以逐条枚举测试，而不是藏在事务与 HTTP 调用之间只能靠集成测试碰运气。
 */

import { createHash, randomInt } from 'node:crypto';

import { REFUND_WINDOW_DAYS } from '../admin/order/admin-order.util';

/** 退款窗口（7 天）转出，便于调用方与测试从语义最贴近的文件引入 */
export { REFUND_WINDOW_DAYS };

/** 退款单号前缀（契约 §3.9.10 规则 6：`RF` + `yyyyMMdd` + 8 位 Base32） */
const REFUND_NO_PREFIX = 'RF';

/** Base32 字符集（Crockford 变体：去掉 I/L/O/U，避免与 1/0 混淆） */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 随机部分长度（契约规定 8 位） */
const REFUND_NO_RANDOM_LENGTH = 8;

/**
 * 生成退款单号（微信 `out_refund_no`）
 *
 * 用 `crypto.randomInt` 而非 `Math.random`：退款单号会出现在微信侧与对账文件里，
 * 可预测的编号让人能**猜中他人退款单号**去试探查询接口。
 */
export const generateRefundNo = (now: Date): string => {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');

  let random = '';
  for (let index = 0; index < REFUND_NO_RANDOM_LENGTH; index += 1) {
    random += BASE32_ALPHABET[randomInt(BASE32_ALPHABET.length)];
  }

  return `${REFUND_NO_PREFIX}${year}${month}${day}${random}`;
};

/** 退款单号形态校验（供 `byNo` 类查询与测试使用） */
export const isValidRefundNo = (refundNo: string): boolean =>
  new RegExp(`^${REFUND_NO_PREFIX}\\d{8}[${BASE32_ALPHABET}]{${REFUND_NO_RANDOM_LENGTH}}$`).test(refundNo);

/**
 * 构造退款幂等键
 *
 * 契约要求「同一 `X-Idempotency-Key` 重放返回首次退款记录」，而
 * `refunds.idempotency_key` 是**全局唯一**列（VarChar(64)），直接把客户端传来的
 * 键写进去会有两个问题：
 *   ① 两个不同用户偶然用了同一个键（如前端写死的常量）会互相顶掉；
 *   ② 客户端键最长 64 位，加上前缀就超列长度。
 *
 * 因此这里做**加盐摘要**：把 `userId + orderId + 客户端键` 一起哈希后截断。
 * 带上 `orderId` 是有意的 —— 同一用户对不同订单复用同一个键时，本应各自产生
 * 一笔独立退款；只有**同一订单 + 同一键**才应该命中幂等。
 */
export const buildRefundIdempotencyKey = (userId: string, orderId: string, clientKey: string): string =>
  `rf${createHash('sha256').update(`${userId}:${orderId}:${clientKey}`).digest('hex').slice(0, 48)}`;

// ============================================================================
// 退款原因与文案
// ============================================================================

/** 用户侧退款原因枚举（契约 §3.9.10 请求体） */
export const USER_REFUND_REASONS = [
  'DUPLICATE_PURCHASE',
  'NOT_AS_EXPECTED',
  'ACCIDENTAL',
  'SERVICE_ISSUE',
  'OTHER',
] as const;
export type UserRefundReason = (typeof USER_REFUND_REASONS)[number];

/** 原因中文名 */
export const USER_REFUND_REASON_LABELS: Readonly<Record<UserRefundReason, string>> = {
  DUPLICATE_PURCHASE: '重复购买',
  NOT_AS_EXPECTED: '与预期不符',
  ACCIDENTAL: '误操作',
  SERVICE_ISSUE: '服务问题',
  OTHER: '其他',
};

/**
 * 规则内可直接通过的退款原因（契约 §3.9.10 规则 1）
 *
 * 只含「用户没拿到任何价值」的两类：重复购买与误操作。其余原因（与预期不符、
 * 服务问题）需要人工判断，不能自动出款。
 */
export const AUTO_APPROVE_REFUND_REASONS: ReadonlySet<string> = new Set(['DUPLICATE_PURCHASE', 'ACCIDENTAL']);

/** 自动通过的时间窗（契约：24 小时内） */
export const AUTO_APPROVE_WINDOW_HOURS = 24;

/** 退款申请的理由文本（写入 `refunds.reason`，也是列表页展示的 `reason`） */
export const composeUserRefundReason = (reason: string, description: string | null): string => {
  const label = USER_REFUND_REASON_LABELS[reason as UserRefundReason] ?? reason;
  const base = `用户申请：${label}`;
  const trimmed = description?.trim() ?? '';

  // `refunds.reason` 是 VarChar(256)：超长直接截断而不是让整笔退款失败
  return (trimmed.length > 0 ? `${base}（${trimmed}）` : base).slice(0, 256);
};

/** 到账说明（契约 §3.9.10 规则 8：文案必须明确 1–3 个工作日，避免用户误解为即时到账） */
export const REFUND_ARRIVAL_NOTICE = '退款已原路返回，到账时间以微信支付与银行为准（通常 1–3 个工作日）。';

/** 退款状态中文名（契约 §3.9.9 示例） */
const REFUND_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: '已受理，处理中',
  SUCCESS: '已退款',
  FAILED: '退款失败',
  CLOSED: '已关闭',
};

/** 退款状态中文名；未知状态回落原值 */
export const refundStatusLabel = (status: string): string => REFUND_STATUS_LABELS[status] ?? status;

/** 用户申请后的可撤回窗口（契约 §3.9.10 的 `nextAction.cancelDeadline`：+30 分钟） */
export const REFUND_CANCEL_WINDOW_MINUTES = 30;

/** 退款类型 */
export type RefundType = 'FULL' | 'PARTIAL';

/**
 * 退款类型
 *
 * `refunds` 表没有 `refund_type` 列（schema 本轮不可改），因此按金额推导：
 * 退款额 == 实付额 → 全额，否则部分。多次部分退款时每笔都小于实付额，
 * 推导结果正确；只有「若干次部分退款之和恰好等于实付额」的最后那笔会被标为
 * `PARTIAL` 而不是 `FULL` —— 该场景下订单最终状态仍是 `REFUNDED`，不影响资金口径。
 */
export const refundTypeOf = (refundAmount: number, paidAmount: number): RefundType =>
  paidAmount > 0 && refundAmount >= paidAmount ? 'FULL' : 'PARTIAL';

// ============================================================================
// 用户侧退款策略（契约 §3.9.10 规则 1）
// ============================================================================

/** 策略判定结果 */
export type UserRefundPolicy = 'AUTO_APPROVE' | 'MANUAL_REVIEW' | 'REJECT_CONSUMED' | 'REJECT_EXPIRED';

/** 策略判定输入 */
export interface UserRefundPolicyInput {
  readonly paidAt: Date | null;
  readonly reason: string;
  readonly hasConsumedEntitlement: boolean;
  readonly now: Date;
}

/**
 * 判定用户退款申请的处理方式
 *
 * 判定**顺序有意义**：先看权益是否已消费。
 * 一笔「30 天前购买且已看的报告」若先判「超过 7 天」，给出的理由是「超期」，
 * 而真实原因（用户已经把内容看完了）会被掩盖 —— 客服据此沟通会非常被动。
 */
export const decideUserRefundPolicy = (input: UserRefundPolicyInput): UserRefundPolicy => {
  if (input.hasConsumedEntitlement) return 'REJECT_CONSUMED';

  if (input.paidAt === null) return 'REJECT_EXPIRED';

  const elapsedMs = input.now.getTime() - input.paidAt.getTime();

  if (elapsedMs > REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000) return 'REJECT_EXPIRED';

  if (elapsedMs <= AUTO_APPROVE_WINDOW_HOURS * 60 * 60 * 1000 && AUTO_APPROVE_REFUND_REASONS.has(input.reason)) {
    return 'AUTO_APPROVE';
  }

  return 'MANUAL_REVIEW';
};

/** 撤回截止时间（仅 `PENDING` 有意义） */
export const refundCancelDeadline = (appliedAt: Date): Date =>
  new Date(appliedAt.getTime() + REFUND_CANCEL_WINDOW_MINUTES * 60_000);

// ============================================================================
// 微信退款结果 → 本地状态机
// ============================================================================

/** 结算动作 */
export type RefundSettlement = 'SUCCESS' | 'FAILED' | 'PENDING';

/**
 * 微信退款状态 → 本地结算动作（契约 §3.9.10 规则 3：`PENDING → SUCCESS / FAILED`）
 *
 * ⚠ `UNKNOWN` 一律归为 `PENDING` 而不是 `FAILED`：未知状态意味着**微信侧的真实
 * 状态我们并不知道**，把它写成失败会造成「钱退了但本地记录失败」；保持处理中
 * 让查询对账任务继续跟进，最坏的结果只是退款记录晚一点落定。
 */
export const refundSettlementOfWechatState = (state: string): RefundSettlement => {
  if (state === 'SUCCESS') return 'SUCCESS';
  if (state === 'CLOSED' || state === 'ABNORMAL') return 'FAILED';

  return 'PENDING';
};

/** 微信异常退款状态 → 面向用户的失败原因 */
export const wechatRefundFailureReason = (state: string): string =>
  state === 'CLOSED'
    ? '退款已被关闭（微信侧未完成出款），请联系客服处理。'
    : state === 'ABNORMAL'
      ? '微信退款接口返回异常，请联系客服处理。'
      : '退款未能完成，请联系客服处理。';

/**
 * 退款成功后的订单状态（契约 §3.14.6.3 规则 7：全额 → `REFUNDED`，部分 → `PARTIAL_REFUNDED`）
 *
 * 入参是**累计已退金额**（不是本笔金额）：多次部分退款累计等于实付时也必须落到
 * `REFUNDED`，否则订单会永远停在 `PARTIAL_REFUNDED`，而可退金额已经是 0。
 */
export const orderStatusAfterRefund = (
  totalRefundedAmount: number,
  paidAmount: number,
): 'REFUNDED' | 'PARTIAL_REFUNDED' =>
  paidAmount > 0 && totalRefundedAmount >= paidAmount ? 'REFUNDED' : 'PARTIAL_REFUNDED';

/** 失败原因文本（写入 `refunds.error_message`，列长度 512） */
export const composeRefundFailureReason = (message: string): string => message.slice(0, 500);

// ============================================================================
// 退款元数据（`refunds.notify_payload` 的命名空间）
// ============================================================================

/**
 * 元数据存放位置说明（**契约/模型差异的落地方式，需评审**）
 *
 * 契约 §3.9.9 的 `refunds[]` 需要 `operator`（USER/ADMIN/SYSTEM）、`refundType`、
 * `entitlementRevoked`、`revokedEntitlementIds`、`description` / `contact` /
 * `internalNote` / `ticketId`，而 `refunds` 表**没有任何列**承载它们
 * （schema 与 migrations 本轮不可改）。可选的落法有三种：
 *   ① 丢弃 → 契约字段恒为 null/[]，功能缺失；
 *   ② 每次读取时重新推导 → 只能推出 `refundType`，撤销记录无从还原；
 *   ③ 存进已有的 JsonB 列 `notify_payload`（该列设计上就是给「微信侧原始报文」用的，
 *      目前退款回调尚未实现，写入方只有本模块）。
 *
 * 这里选 ③，并**用明确的命名空间键隔离**，避免与将来的微信原始报文互相覆盖。
 * 正确解法仍是加列（`refunds.metadata` JsonB 或独立 `refund_reviews` 表），
 * 已列入交付简报的待接线清单。
 */
export const REFUND_META_KEY = '__soulmapRefundMeta';

/** 退款操作者（契约 §3.9.9 规则 5） */
export type RefundOperator = 'USER' | 'ADMIN' | 'SYSTEM';

/** 退款元数据 */
export interface RefundMeta {
  readonly operator: RefundOperator;
  readonly refundType: RefundType;
  /** 是否走了人工审核（用户侧规则外申请） */
  readonly requiresReview: boolean;
  readonly description: string | null;
  readonly contact: string | null;
  readonly internalNote: string | null;
  readonly ticketId: string | null;
  /** 管理员用 `?force=true` 覆盖退款策略（契约 §3.14.6.3 规则 5） */
  readonly isForced: boolean;
  readonly entitlementRevoked: boolean;
  readonly revokedEntitlementIds: readonly string[];
}

/** 元数据默认值（调用方只需覆盖关心的字段） */
export const emptyRefundMeta = (operator: RefundOperator, refundType: RefundType): RefundMeta => ({
  operator,
  refundType,
  requiresReview: false,
  description: null,
  contact: null,
  internalNote: null,
  ticketId: null,
  isForced: false,
  entitlementRevoked: false,
  revokedEntitlementIds: [],
});

/** 把元数据合并进 `notify_payload`（保留其中已有的其它键） */
export const withRefundMeta = (payload: unknown, meta: RefundMeta): Record<string, unknown> => {
  const base =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  return { ...base, [REFUND_META_KEY]: meta };
};

/** 安全取字符串 */
const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** 安全取布尔 */
const readBoolean = (source: Record<string, unknown>, key: string): boolean => source[key] === true;

/** 安全取字符串数组 */
const readStringArray = (source: Record<string, unknown>, key: string): string[] => {
  const value = source[key];

  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
};

/**
 * 读取退款元数据
 *
 * 读不到时返回 `null` 而不是编造默认值：历史退款单（若有）确实没有这些信息，
 * 显示 `operator: 'USER'` 会让审计误以为"是用户申请的"。
 */
export const readRefundMeta = (payload: unknown): RefundMeta | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const raw = (payload as Record<string, unknown>)[REFUND_META_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  const operator = readString(record, 'operator');
  const refundType = readString(record, 'refundType');

  return {
    operator: operator === 'ADMIN' || operator === 'SYSTEM' ? operator : 'USER',
    refundType: refundType === 'FULL' ? 'FULL' : 'PARTIAL',
    requiresReview: readBoolean(record, 'requiresReview'),
    description: readString(record, 'description'),
    contact: readString(record, 'contact'),
    internalNote: readString(record, 'internalNote'),
    ticketId: readString(record, 'ticketId'),
    isForced: readBoolean(record, 'isForced'),
    entitlementRevoked: readBoolean(record, 'entitlementRevoked'),
    revokedEntitlementIds: readStringArray(record, 'revokedEntitlementIds'),
  };
};

// ============================================================================
// 关单 / 取消
// ============================================================================

/** 用户取消原因（契约 §3.9.6 请求体） */
export const USER_CANCEL_REASONS = ['CHANGED_MIND', 'WRONG_PRODUCT', 'PRICE_CONCERN', 'OTHER'] as const;
export type UserCancelReason = (typeof USER_CANCEL_REASONS)[number];

/** 取消原因中文名（写入 `orders.cancel_reason`） */
export const USER_CANCEL_REASON_LABELS: Readonly<Record<UserCancelReason, string>> = {
  CHANGED_MIND: '改变主意',
  WRONG_PRODUCT: '买错商品',
  PRICE_CONCERN: '价格因素',
  OTHER: '其他',
};

/** 关单原因（契约 §3.9.7 请求体） */
export const CLOSE_REASONS = ['USER_REQUEST', 'TIMEOUT'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/**
 * 用户可指定的关单原因
 *
 * 契约明确：用户调用 `close` 时 `TIMEOUT` 被忽略并**强制为 `USER_REQUEST`**。
 * 理由是要让「用户主动放弃」与「超时未支付」在数据上可分 —— 否则流失分析会把
 * 用户主动关单也算成系统超时关单。
 */
export const normalizeCloseReason = (requested: string | undefined, triggeredByUser: boolean): CloseReason =>
  triggeredByUser ? 'USER_REQUEST' : requested === 'TIMEOUT' ? 'TIMEOUT' : 'USER_REQUEST';
