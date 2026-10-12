/**
 * 用户端订单查询纯逻辑测试
 *
 * 重点覆盖三类**边界**，它们各自的失效形态都是线上可见的：
 *   · `canRefund` —— 多返回一个 `true` 就是"点了退款按钮却被后端拒"，少返回是资损风险
 *   · `canQuery`  —— 早于 1 分钟允许查单会白耗微信调用配额
 *   · 倒计时      —— 只对 `PENDING_PAY` 有意义，其他状态给出正数会让前端显示假倒计时
 */

import {
  buildOrderProductSnapshotView,
  buildOrderTimelineView,
  buildPaginatedView,
  computeRemainingSeconds,
  deriveOrderActionFlags,
  grantedEntitlementTypeOf,
  hasConsumedEntitlement,
  isEntitlementConsumed,
  isOrderExpired,
  orderStatusDescription,
  orderStatusLabel,
} from './order-query.util';

const NOW = new Date('2026-02-14T12:00:00.000Z');

const actionInput = (
  overrides: Partial<Parameters<typeof deriveOrderActionFlags>[0]> = {},
): Parameters<typeof deriveOrderActionFlags>[0] => ({
  status: 'FULFILLED',
  createdAt: new Date('2026-02-14T10:00:00.000Z'),
  paidAt: new Date('2026-02-14T10:05:00.000Z'),
  refundableAmount: 9900,
  entitlements: [{ status: 'ACTIVE', usedQuota: 0 }],
  now: NOW,
  ...overrides,
});

describe('orderStatusLabel / orderStatusDescription', () => {
  it('状态标签与管理端口径一致（同一订单两端不能显示不同说法）', () => {
    expect(orderStatusLabel('FULFILLED')).toBe('已完成');
    expect(orderStatusLabel('PENDING_PAY')).toBe('待支付');
  });

  it('每个状态都有说明文案（新增状态忘记登记时这里会失败）', () => {
    for (const status of [
      'CREATED',
      'PENDING_PAY',
      'PAID',
      'FULFILLED',
      'CLOSED',
      'CANCELLED',
      'REFUNDED',
      'PARTIAL_REFUNDED',
    ]) {
      expect(orderStatusDescription(status).length).toBeGreaterThan(0);
    }
  });

  it('未登记状态回落到空串而不是抛错（脏数据不该让详情页 500）', () => {
    expect(orderStatusDescription('SOMETHING_NEW')).toBe('');
  });
});

describe('isEntitlementConsumed', () => {
  it('【关键】计数型权益用过即算已消费（只看 status 会漏判 AI 次数包）', () => {
    expect(isEntitlementConsumed({ status: 'ACTIVE', usedQuota: 3 })).toBe(true);
    expect(isEntitlementConsumed({ status: 'ACTIVE', usedQuota: 0 })).toBe(false);
  });

  it('CONSUMED 状态即已消费（报告已解锁查看）', () => {
    expect(isEntitlementConsumed({ status: 'CONSUMED', usedQuota: 0 })).toBe(true);
  });

  it('REVOKED 不算消费（自己撤回的权益不该成为拒绝退款的理由）', () => {
    expect(isEntitlementConsumed({ status: 'REVOKED', usedQuota: 0 })).toBe(false);
  });

  it('任一权益被消费即视为已消费', () => {
    expect(
      hasConsumedEntitlement([
        { status: 'ACTIVE', usedQuota: 0 },
        { status: 'ACTIVE', usedQuota: 1 },
      ]),
    ).toBe(true);
  });
});

describe('grantedEntitlementTypeOf', () => {
  it('商品类型 → 权益类型与发放逻辑一致', () => {
    expect(grantedEntitlementTypeOf('MEMBERSHIP')).toBe('MEMBERSHIP_ACTIVE');
    expect(grantedEntitlementTypeOf('REPORT_PERSONAL')).toBe('REPORT_UNLOCK');
    expect(grantedEntitlementTypeOf('REPORT_COMPATIBILITY')).toBe('REPORT_UNLOCK');
    expect(grantedEntitlementTypeOf('AI_CREDITS')).toBe('AI_CREDITS');
  });

  it('未知商品类型返回 null（不猜测）', () => {
    expect(grantedEntitlementTypeOf('UNKNOWN_TYPE')).toBeNull();
  });
});

describe('buildOrderProductSnapshotView', () => {
  it('把快照字段映射为契约字段名', () => {
    const view = buildOrderProductSnapshotView(
      { name: '月度会员', durationDays: 30, priceAmount: 3900, code: 'MEMBERSHIP_MONTHLY', productType: 'MEMBERSHIP' },
      'MEMBERSHIP',
    );

    expect(view).toEqual({
      name: '月度会员',
      durationDays: 30,
      grantedEntitlementType: 'MEMBERSHIP_ACTIVE',
      priceAmountAtPurchase: 3900,
    });
  });

  it('快照缺失/格式非法时返回全 null，而不是抛错或编造值', () => {
    expect(buildOrderProductSnapshotView(null, 'MEMBERSHIP')).toEqual({
      name: null,
      durationDays: null,
      grantedEntitlementType: 'MEMBERSHIP_ACTIVE',
      priceAmountAtPurchase: null,
    });
    expect(buildOrderProductSnapshotView([1, 2], 'AI_CREDITS').name).toBeNull();
  });

  it('只暴露契约声明的四个字段（内部字段不外泄）', () => {
    const view = buildOrderProductSnapshotView({ name: 'x', productId: 'p', snapshotAt: 't' }, 'AI_CREDITS');

    expect(Object.keys(view).sort()).toEqual([
      'durationDays',
      'grantedEntitlementType',
      'name',
      'priceAmountAtPurchase',
    ]);
  });
});

describe('buildOrderTimelineView', () => {
  const base = {
    createdAt: new Date('2026-02-14T09:58:12.000Z'),
    paidAt: new Date('2026-02-14T10:00:00.000Z'),
    fulfilledAt: new Date('2026-02-14T10:00:01.000Z'),
    closedAt: null,
    cancelledAt: null,
    paymentCreatedAt: new Date('2026-02-14T09:58:13.000Z'),
    paymentStatus: 'INIT',
    refundSuccessAt: null,
  };

  it('按时间升序返回，且只含契约字段（无 actor）', () => {
    const events = buildOrderTimelineView(base);

    expect(events.map((event) => event.event)).toEqual(['CREATED', 'PAID', 'FULFILLED']);
    expect(Object.keys(events[0] ?? {})).toEqual(['event', 'label', 'at']);
  });

  it('【关键】`payments.status = INIT` 不产生「预支付成功」节点', () => {
    expect(buildOrderTimelineView(base).some((event) => event.event === 'PREPAY_SUCCESS')).toBe(false);
  });

  it('预支付成功后会产生该节点，并落在正确的时间位置', () => {
    const events = buildOrderTimelineView({ ...base, paymentStatus: 'SUCCESS' });

    expect(events.map((event) => event.event)).toEqual(['CREATED', 'PREPAY_SUCCESS', 'PAID', 'FULFILLED']);
  });

  it('退款成功节点来自最近一次成功退款时间', () => {
    const events = buildOrderTimelineView({ ...base, refundSuccessAt: new Date('2026-02-14T11:00:00.000Z') });

    expect(events[events.length - 1]?.event).toBe('REFUNDED');
  });

  it('取消与关单各自成节点', () => {
    const cancelled = buildOrderTimelineView({
      ...base,
      paidAt: null,
      fulfilledAt: null,
      cancelledAt: new Date('2026-02-14T10:30:00.000Z'),
    });
    const closed = buildOrderTimelineView({
      ...base,
      paidAt: null,
      fulfilledAt: null,
      closedAt: new Date('2026-02-14T10:28:12.000Z'),
    });

    expect(cancelled.map((event) => event.event)).toEqual(['CREATED', 'CANCELLED']);
    expect(closed.map((event) => event.event)).toEqual(['CREATED', 'CLOSED']);
  });
});

describe('deriveOrderActionFlags', () => {
  it('已完成的订单不可支付/取消/关单，但可退款（权益未消费 + 7 天内）', () => {
    const flags = deriveOrderActionFlags(actionInput());

    expect(flags).toEqual({ canPay: false, canCancel: false, canClose: false, canQuery: false, canRefund: true });
  });

  it('【关键】未支付订单可支付/取消/关单，但不可退款', () => {
    const flags = deriveOrderActionFlags(
      actionInput({ status: 'PENDING_PAY', paidAt: null, refundableAmount: 0, entitlements: [] }),
    );

    expect(flags.canPay).toBe(true);
    expect(flags.canCancel).toBe(true);
    expect(flags.canClose).toBe(true);
    expect(flags.canRefund).toBe(false);
  });

  it('【关键】可退金额为 0 时 canRefund 必须为 false（已全额退款）', () => {
    expect(deriveOrderActionFlags(actionInput({ refundableAmount: 0 })).canRefund).toBe(false);
  });

  it('【关键】权益已消费时不可退款', () => {
    expect(
      deriveOrderActionFlags(actionInput({ entitlements: [{ status: 'CONSUMED', usedQuota: 0 }] })).canRefund,
    ).toBe(false);
  });

  it('【关键】超过 7 天不可退款，第 7 天当天仍可', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const exactlySevenDays = deriveOrderActionFlags(actionInput({ paidAt: new Date(NOW.getTime() - 7 * dayMs) }));
    const overSevenDays = deriveOrderActionFlags(actionInput({ paidAt: new Date(NOW.getTime() - 7 * dayMs - 1) }));

    expect(exactlySevenDays.canRefund).toBe(true);
    expect(overSevenDays.canRefund).toBe(false);
  });

  it('已退款/已关闭/已取消状态下全部操作均不可用', () => {
    for (const status of ['REFUNDED', 'CLOSED', 'CANCELLED']) {
      const flags = deriveOrderActionFlags(actionInput({ status, refundableAmount: 0, entitlements: [] }));

      expect(Object.values(flags).every((value) => value === false)).toBe(true);
    }
  });

  it('【关键】canQuery 要求 PENDING_PAY 且创建超过 1 分钟', () => {
    const fresh = deriveOrderActionFlags(
      actionInput({
        status: 'PENDING_PAY',
        paidAt: null,
        refundableAmount: 0,
        entitlements: [],
        createdAt: new Date(NOW.getTime() - 59_000),
      }),
    );
    const oldEnough = deriveOrderActionFlags(
      actionInput({
        status: 'PENDING_PAY',
        paidAt: null,
        refundableAmount: 0,
        entitlements: [],
        createdAt: new Date(NOW.getTime() - 60_000),
      }),
    );

    expect(fresh.canQuery).toBe(false);
    expect(oldEnough.canQuery).toBe(true);
  });

  it('部分退款后仍有余额则可继续退款', () => {
    const flags = deriveOrderActionFlags(actionInput({ status: 'PARTIAL_REFUNDED', refundableAmount: 5000 }));

    expect(flags.canRefund).toBe(true);
  });
});

describe('computeRemainingSeconds', () => {
  it('PENDING_PAY 返回剩余秒数', () => {
    expect(computeRemainingSeconds('PENDING_PAY', new Date(NOW.getTime() + 90_000), NOW)).toBe(90);
  });

  it('【关键】非 PENDING_PAY 一律 0（否则前端会显示假倒计时）', () => {
    expect(computeRemainingSeconds('FULFILLED', new Date(NOW.getTime() + 90_000), NOW)).toBe(0);
    expect(computeRemainingSeconds('CREATED', new Date(NOW.getTime() + 90_000), NOW)).toBe(0);
  });

  it('【关键】已过期夹到 0（负数会让前端渲染出 -00:32）', () => {
    expect(computeRemainingSeconds('PENDING_PAY', new Date(NOW.getTime() - 5000), NOW)).toBe(0);
  });
});

describe('isOrderExpired', () => {
  it('到点即算过期（超时关单扫描不能在边界上漏单）', () => {
    expect(isOrderExpired(NOW, NOW)).toBe(true);
    expect(isOrderExpired(new Date(NOW.getTime() + 1), NOW)).toBe(false);
  });
});

describe('buildPaginatedView', () => {
  it('hasNext 由页码推算', () => {
    expect(buildPaginatedView([1, 2], 3, 1, 2).hasNext).toBe(true);
    expect(buildPaginatedView([1], 3, 2, 2).hasNext).toBe(false);
    expect(buildPaginatedView([], 0, 1, 20).hasNext).toBe(false);
  });
});
