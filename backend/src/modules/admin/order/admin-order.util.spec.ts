/**
 * 管理端订单纯逻辑单测
 *
 * 重点覆盖**口径**与**边界**（返工与线上事故的高发区）：
 *   · 可退金额的下界（历史数据可能算出负数）
 *   · `canRefund` 的三重条件（状态 / 金额 / 7 天窗口）
 *   · 异常订单标记的三条规则
 *   · 列表摘要的「已支付/待支付/已关闭」口径
 *   · 昵称与用户 ID 脱敏
 */

import type { Order, Payment, Refund } from '@prisma/client';

import {
  ABNORMAL_FLAG_LABELS,
  buildOrderCoreView,
  buildOrderListSummary,
  buildOrderTimeline,
  computeRefundableAmount,
  deriveAbnormalFlags,
  deriveAdminActions,
  latestPayment,
  latestRefundSuccessAt,
  maskNickname,
  maskUserId,
  orderStatusLabel,
  REFUND_WINDOW_DAYS,
} from './admin-order.util';

const NOW = new Date('2026-02-14T21:06:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('computeRefundableAmount', () => {
  it('实付减已退', () => {
    expect(computeRefundableAmount(9900, 0)).toBe(9900);
    expect(computeRefundableAmount(9900, 3000)).toBe(6900);
  });

  it('已退超过实付时夹到 0（历史数据存在退款成功但未回写 refundedAmount 的窗口）', () => {
    expect(computeRefundableAmount(9900, 12000)).toBe(0);
  });
});

describe('orderStatusLabel', () => {
  it('契约示例：FULFILLED → 已完成', () => {
    expect(orderStatusLabel('FULFILLED')).toBe('已完成');
  });

  it('未知状态回落原值（便于发现新增状态未登记），而不是空串', () => {
    expect(orderStatusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('maskNickname / maskUserId', () => {
  it('昵称保留首字符，其余打码（契约示例 小满 → 小*）', () => {
    expect(maskNickname('小满')).toBe('小*');
    expect(maskNickname('阿泽')).toBe('阿*');
    // 5 个字符 = 保留 1 个 + 打码 4 个（口径就是「其余全部打码」，不截断掩码长度；
    // 与本文件同目录的 report / ai-stats 两份同名实现保持同一口径）
    expect(maskNickname('测试用户甲')).toBe('测****');
  });

  it('单字昵称至少给出一个掩码位，避免「掩码后仍是原文」', () => {
    expect(maskNickname('甲')).toBe('甲*');
  });

  it('空昵称返回 null（前端据此渲染占位，而非空白用户名）', () => {
    expect(maskNickname(null)).toBeNull();
    expect(maskNickname('   ')).toBeNull();
  });

  it('用户 ID 保留前 8 后 4', () => {
    const masked = maskUserId('0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70');
    expect(masked).toBe(`0195f3a2${'*'.repeat(24)}4d70`);
  });
});

describe('deriveAbnormalFlags', () => {
  const base = {
    status: 'FULFILLED',
    totalAmount: 3900,
    discountAmount: 0,
    paidAmount: 3900,
    refundedAmount: 0,
    paidAt: new Date(NOW.getTime() - HOUR),
    entitlementCount: 1,
    now: NOW,
  };

  it('正常订单无标记', () => {
    expect(deriveAbnormalFlags(base)).toEqual([]);
  });

  it('已支付超 24h 未发权益（风险 R6「付了没给货」）', () => {
    const flags = deriveAbnormalFlags({
      ...base,
      status: 'PAID',
      entitlementCount: 0,
      paidAt: new Date(NOW.getTime() - 25 * HOUR),
    });

    expect(flags).toEqual(['PAID_NOT_FULFILLED_24H']);
    expect(ABNORMAL_FLAG_LABELS['PAID_NOT_FULFILLED_24H']).toContain('24');
  });

  it('未满 24h 不标记（给履约留出正常窗口）', () => {
    const flags = deriveAbnormalFlags({
      ...base,
      status: 'PAID',
      entitlementCount: 0,
      paidAt: new Date(NOW.getTime() - 23 * HOUR),
    });

    expect(flags).toEqual([]);
  });

  it('实付 ≠ 应付（总额 − 优惠）→ 金额不一致', () => {
    const flags = deriveAbnormalFlags({ ...base, paidAmount: 3800 });
    expect(flags).toEqual(['AMOUNT_MISMATCH']);
  });

  it('累计退款超过实付 → 退款金额异常', () => {
    const flags = deriveAbnormalFlags({ ...base, refundedAmount: 4000 });
    expect(flags).toEqual(['REFUND_OVER_PAID']);
  });
});

describe('deriveAdminActions', () => {
  const input = {
    status: 'FULFILLED',
    paidAt: new Date(NOW.getTime() - DAY),
    refundableAmount: 9900,
    entitlementCount: 1,
    hasPayment: true,
    now: NOW,
  };

  it('已履约、有可退金额且在 7 天内 → 可退款；已发权益 → 不可补发', () => {
    const actions = deriveAdminActions(input);
    expect(actions.canRefund).toBe(true);
    expect(actions.canResendEntitlement).toBe(false);
    expect(actions.canRetryReconcile).toBe(true);
    expect(actions.canManualClose).toBe(false);
  });

  it('超过 7 天窗口 → 不可退款（契约 §3.9.10 规则 1）', () => {
    const actions = deriveAdminActions({
      ...input,
      paidAt: new Date(NOW.getTime() - (REFUND_WINDOW_DAYS + 1) * DAY),
    });

    expect(actions.canRefund).toBe(false);
  });

  it('可退金额为 0 → 不可退款', () => {
    expect(deriveAdminActions({ ...input, refundableAmount: 0 }).canRefund).toBe(false);
  });

  it('严格按契约：仅 status = PAID 且权益为空时可补发权益', () => {
    expect(deriveAdminActions({ ...input, status: 'PAID', entitlementCount: 0 }).canResendEntitlement).toBe(true);
    expect(deriveAdminActions({ ...input, status: 'FULFILLED', entitlementCount: 0 }).canResendEntitlement).toBe(false);
  });

  it('未支付订单可人工关单，但没有支付单时不可触发对账重试', () => {
    const actions = deriveAdminActions({
      ...input,
      status: 'PENDING_PAY',
      paidAt: null,
      hasPayment: false,
      refundableAmount: 0,
    });

    expect(actions.canManualClose).toBe(true);
    expect(actions.canRetryReconcile).toBe(false);
    expect(actions.canRefund).toBe(false);
  });
});

describe('buildOrderTimeline', () => {
  it('按时间升序返回，且缺省事件不入列（RECONCILED 无数据源）', () => {
    const timeline = buildOrderTimeline({
      createdAt: new Date('2026-02-14T09:58:12.000Z'),
      paymentCreatedAt: new Date('2026-02-14T09:58:13.000Z'),
      paymentStatus: 'SUCCESS',
      paidAt: new Date('2026-02-14T10:00:00.000Z'),
      fulfilledAt: new Date('2026-02-14T10:00:01.000Z'),
      closedAt: null,
      cancelledAt: null,
      refundSuccessAt: null,
    });

    expect(timeline.map((event) => event.event)).toEqual(['CREATED', 'PREPAY_SUCCESS', 'PAID', 'FULFILLED']);
    expect(timeline.map((event) => event.actor)).toEqual(['USER', 'SYSTEM', 'WECHAT', 'SYSTEM']);
  });

  it('INIT 状态的支付单不产生 PREPAY_SUCCESS 节点（那时还没拿到 prepay_id）', () => {
    const timeline = buildOrderTimeline({
      createdAt: new Date('2026-02-14T09:58:12.000Z'),
      paymentCreatedAt: new Date('2026-02-14T09:58:13.000Z'),
      paymentStatus: 'INIT',
      paidAt: null,
      fulfilledAt: null,
      closedAt: null,
      cancelledAt: null,
      refundSuccessAt: null,
    });

    expect(timeline.map((event) => event.event)).toEqual(['CREATED']);
  });
});

describe('buildOrderListSummary', () => {
  it('各状态口径与净收入计算', () => {
    const summary = buildOrderListSummary(
      342,
      [
        { status: 'FULFILLED', count: 300, paidAmount: 1_800_000, refundedAmount: 0 },
        { status: 'PAID', count: 18, paidAmount: 42_600, refundedAmount: 0 },
        { status: 'PENDING_PAY', count: 8, paidAmount: 0, refundedAmount: 0 },
        { status: 'CLOSED', count: 10, paidAmount: 0, refundedAmount: 0 },
        { status: 'CANCELLED', count: 4, paidAmount: 0, refundedAmount: 0 },
        { status: 'PARTIAL_REFUNDED', count: 2, paidAmount: 0, refundedAmount: 13_800 },
      ],
      [
        { productType: 'MEMBERSHIP', count: 68, paidAmount: 402_600 },
        { productType: 'REPORT_PERSONAL', count: 186, paidAmount: 1_841_400 },
      ],
    );

    expect(summary.totalOrders).toBe(342);
    expect(summary.paidOrders).toBe(320);
    expect(summary.pendingOrders).toBe(8);
    expect(summary.closedOrders).toBe(14);
    // 发生过退款的订单数 = Σ(refundedAmount > 0 的桶的 count) = PARTIAL_REFUNDED 的 2 笔。
    // 与契约示例一致：同一组总量（342 / 1,842,600 / 13,800 / 1,828,800）的响应里
    // `refundedOrders` 就是 2（docs/API_DESIGN.md §3.14.6.1 示例，行 14355）
    expect(summary.refundedOrders).toBe(2);
    expect(summary.totalPaidAmount).toBe(1_842_600);
    expect(summary.totalRefundedAmount).toBe(13_800);
    expect(summary.netRevenue).toBe(1_828_800);
    expect(summary.byProductType['MEMBERSHIP']).toEqual({ orderCount: 68, paidAmount: 402_600 });
  });
});

describe('buildOrderCoreView', () => {
  const order = {
    id: '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89',
    orderNo: 'SM20260214A7K3M9Q1',
    userId: 'u1',
    productId: 'p1',
    planId: null,
    productType: 'MEMBERSHIP',
    productSnapshot: { code: 'MEMBERSHIP_MONTHLY', name: '月度会员' },
    quantity: 1,
    totalAmount: 3900,
    discountAmount: 3000,
    paidAmount: 3900,
    refundedAmount: 0,
    currency: 'CNY',
    status: 'FULFILLED',
    payChannel: 'WECHAT_JSAPI',
    clientIp: null,
    remark: null,
    relatedReportId: null,
    relatedRelationshipId: null,
    expiredAt: new Date('2026-02-14T10:28:12.000Z'),
    paidAt: new Date('2026-02-14T10:00:00.000Z'),
    fulfilledAt: new Date('2026-02-14T10:00:01.000Z'),
    closedAt: null,
    cancelledAt: null,
    cancelReason: null,
    idempotencyKey: null,
    version: 0,
    createdAt: new Date('2026-02-14T09:58:12.000Z'),
    updatedAt: new Date('2026-02-14T10:00:01.000Z'),
    deletedAt: null,
  } satisfies Order;

  it('原价 = 应付 + 优惠（校验过契约示例 3900 + 3000 = 6900）', () => {
    const view = buildOrderCoreView({
      order,
      product: { code: 'MEMBERSHIP_MONTHLY', name: '月度会员' },
      refundedAt: null,
      wechatPayEnv: 'production',
    });

    expect(view.originalAmount).toBe(6900);
    expect(view.amount).toBe(3900);
    expect(view.discountAmount).toBe(3000);
    expect(view.statusLabel).toBe('已完成');
    expect(view.wechatPayEnv).toBe('production');
  });

  it('商品行缺失时回落 productSnapshot（历史订单不能被商品下架/改名影响）', () => {
    const view = buildOrderCoreView({ order, product: null, refundedAt: null, wechatPayEnv: 'sandbox' });

    expect(view.productCode).toBe('MEMBERSHIP_MONTHLY');
    expect(view.productName).toBe('月度会员');
  });

  it('targetResourceId 取「报告 or 关系」二选一', () => {
    const view = buildOrderCoreView({
      order: { ...order, relatedRelationshipId: 'rel-1' },
      product: null,
      refundedAt: null,
      wechatPayEnv: 'sandbox',
    });

    expect(view.targetResourceId).toBe('rel-1');
  });
});

describe('latestPayment / latestRefundSuccessAt', () => {
  it('支付单按创建时间取最近一张', () => {
    const older = { id: 'p1', createdAt: new Date('2026-02-14T09:00:00.000Z') } as unknown as Payment;
    const newer = { id: 'p2', createdAt: new Date('2026-02-14T09:30:00.000Z') } as unknown as Payment;

    expect(latestPayment([newer, older])?.id).toBe('p2');
    expect(latestPayment([])).toBeNull();
  });

  it('只认 SUCCESS 的退款（PENDING/FAILED 不代表钱已退）', () => {
    const success = {
      status: 'SUCCESS',
      successTime: new Date('2026-02-14T11:00:00.000Z'),
    } as unknown as Refund;
    const failed = {
      status: 'FAILED',
      successTime: new Date('2026-02-14T12:00:00.000Z'),
    } as unknown as Refund;

    expect(latestRefundSuccessAt([success, failed])?.toISOString()).toBe('2026-02-14T11:00:00.000Z');
    expect(latestRefundSuccessAt([])).toBeNull();
  });
});
