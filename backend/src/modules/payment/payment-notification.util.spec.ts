/**
 * 支付通知业务判定测试
 *
 * 这是**资金安全**的核心：每一条断言都对应一种真实的资损或错发场景。
 * 用真实数据构造（而非只测 happy path），因为这里的错误都不是"报错"，
 * 而是"静默地发了不该发的货"。
 */

import {
  decideFulfillment,
  entitlementIdempotencyKey,
  parseWechatPayNotification,
  type OrderForFulfillment,
  type ParsedPaymentNotification,
} from './payment-notification.util';

const MCHID = '1900000109';
const ORDER_NO = 'SM20261010000001';

/** 造一份解密后的通知体（微信的真实结构） */
const notification = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  mchid: MCHID,
  out_trade_no: ORDER_NO,
  transaction_id: '4200001234202610101234567890',
  trade_state: 'SUCCESS',
  trade_state_desc: '支付成功',
  success_time: '2026-10-10T12:00:00+08:00',
  amount: { total: 19900, payer_total: 19900, currency: 'CNY' },
  ...overrides,
});

const parsed = (overrides: Partial<ParsedPaymentNotification> = {}): ParsedPaymentNotification => ({
  orderNo: ORDER_NO,
  transactionId: '4200001234202610101234567890',
  claimedAmount: 19900,
  currency: 'CNY',
  tradeState: 'SUCCESS',
  successTime: '2026-10-10T12:00:00+08:00',
  ...overrides,
});

const order = (overrides: Partial<OrderForFulfillment> = {}): OrderForFulfillment => ({
  orderNo: ORDER_NO,
  totalAmount: 19900,
  paidAmount: 0,
  currency: 'CNY',
  status: 'CREATED',
  ...overrides,
});

// ============================================================================
// 解析
// ============================================================================

describe('parseWechatPayNotification', () => {
  it('合法通知解析成功', () => {
    const result = parseWechatPayNotification(notification(), MCHID);

    expect(result).toEqual({
      ok: true,
      value: {
        orderNo: ORDER_NO,
        transactionId: '4200001234202610101234567890',
        claimedAmount: 19900,
        currency: 'CNY',
        tradeState: 'SUCCESS',
        successTime: '2026-10-10T12:00:00+08:00',
      },
    });
  });

  it('【关键】商户号不匹配即拒绝（重放别人的回调）', () => {
    // 攻击者可以把自己订单的真实回调重放到我们的服务上：
    // 验签能过（确实是微信签的），但商户号不是我们的
    expect(parseWechatPayNotification(notification({ mchid: '1900000999' }), MCHID)).toEqual({
      ok: false,
      reason: 'MCHID_MISMATCH',
    });
  });

  it('【关键】商户号缺失也拒绝（不能因为读不到就当通过）', () => {
    expect(parseWechatPayNotification(notification({ mchid: undefined }), MCHID)).toEqual({
      ok: false,
      reason: 'MISSING_FIELD',
    });
  });

  it('【关键】商户号校验收在交易状态之前', () => {
    // 顺序反了会把"发给别人的通知"报成"交易未成功"，掩盖更重要的事实
    expect(parseWechatPayNotification(notification({ mchid: 'other', trade_state: 'NOTPAY' }), MCHID)).toEqual({
      ok: false,
      reason: 'MCHID_MISMATCH',
    });
  });

  it('非 SUCCESS 状态拒绝', () => {
    for (const state of ['NOTPAY', 'CLOSED', 'REFUND', 'PAYERROR', 'REVOKED']) {
      expect(parseWechatPayNotification(notification({ trade_state: state }), MCHID)).toEqual({
        ok: false,
        reason: 'TRADE_STATE_NOT_SUCCESS',
      });
    }
  });

  it('关键字段缺失拒绝', () => {
    for (const missing of ['out_trade_no', 'transaction_id', 'trade_state', 'amount']) {
      expect(parseWechatPayNotification(notification({ [missing]: undefined }), MCHID)).toEqual({
        ok: false,
        reason: 'MISSING_FIELD',
      });
    }
  });

  it('【关键】金额必须是非负整数分（小数与负数额拒绝）', () => {
    for (const total of [1.5, -1, '19900', null]) {
      expect(parseWechatPayNotification(notification({ amount: { total, currency: 'CNY' } }), MCHID)).toEqual({
        ok: false,
        reason: 'MISSING_FIELD',
      });
    }
  });

  it('【关键】金额币种与顶层币种不一致即拒绝', () => {
    expect(
      parseWechatPayNotification(notification({ currency: 'CNY', amount: { total: 19900, currency: 'USD' } }), MCHID),
    ).toEqual({ ok: false, reason: 'CURRENCY_MISMATCH' });
  });

  it('顶层币种缺失时默认 CNY，此时与 amount.currency 一致', () => {
    const result = parseWechatPayNotification(notification({ currency: undefined }), MCHID);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.currency).toBe('CNY');
  });
});

// ============================================================================
// 发货判定
// ============================================================================

describe('decideFulfillment', () => {
  it('首次支付成功 → 发货，金额以订单为准', () => {
    expect(decideFulfillment(order(), parsed())).toEqual({ action: 'FULFILL', paidAmount: 19900 });
  });

  it('【关键】订单不存在即拒绝（不能凭空发货）', () => {
    expect(decideFulfillment(null, parsed())).toEqual({ action: 'REJECT', reason: 'ORDER_NOT_FOUND' });
  });

  it('【关键】金额少于应付额即拒绝（付 1 分拿 199 元）', () => {
    expect(decideFulfillment(order(), parsed({ claimedAmount: 1 }))).toEqual({
      action: 'REJECT',
      reason: 'AMOUNT_MISMATCH',
    });
  });

  it('【关键】金额多于应付额同样拒绝（可能是串单，需人工介入）', () => {
    // 只判"回调 >= 应付"是不够的：多付意味着上下游对不上，
    // 静默按应付额发货会掩盖这个不一致
    expect(decideFulfillment(order(), parsed({ claimedAmount: 20000 }))).toEqual({
      action: 'REJECT',
      reason: 'AMOUNT_MISMATCH',
    });
  });

  it('币种不一致即拒绝', () => {
    expect(decideFulfillment(order(), parsed({ currency: 'USD' }))).toEqual({
      action: 'REJECT',
      reason: 'CURRENCY_MISMATCH',
    });
  });

  it('【关键】已支付/已发货的订单不重复发货（微信会多次投递）', () => {
    // 第二次必须识别为"已处理"并返回成功，否则用户付一次钱拿到多份权益
    for (const status of ['PAID', 'FULFILLED'] as const) {
      expect(decideFulfillment(order({ status, paidAmount: 19900 }), parsed())).toEqual({
        action: 'ALREADY_FULFILLED',
        paidAmount: 19900,
      });
    }
  });

  it('【关键】已取消/已关闭/已退款的订单拒绝发货（避免账实不符）', () => {
    expect(decideFulfillment(order({ status: 'CANCELLED' }), parsed())).toEqual({
      action: 'REJECT',
      reason: 'ORDER_CANCELLED',
    });
    // `CLOSED` 是真实枚举值（超时关单）。曾经写成并不存在的 `EXPIRED`，
    // 那条分支永远不会命中 —— 超时关单的订单会被当成待支付而发货
    expect(decideFulfillment(order({ status: 'CLOSED' }), parsed())).toEqual({
      action: 'REJECT',
      reason: 'ORDER_CLOSED',
    });
    for (const status of ['REFUNDED', 'PARTIAL_REFUNDED'] as const) {
      expect(decideFulfillment(order({ status }), parsed())).toEqual({ action: 'REJECT', reason: 'ORDER_REFUNDED' });
    }
  });

  it('待支付（`PENDING_PAY`）与已创建（`CREATED`）都正常发货', () => {
    for (const status of ['CREATED', 'PENDING_PAY'] as const) {
      expect(decideFulfillment(order({ status }), parsed())).toEqual({ action: 'FULFILL', paidAmount: 19900 });
    }
  });

  it('【关键】终态与金额校验的顺序：金额不对时先报金额问题', () => {
    // 已支付但金额不符，说明数据本身有问题，应当暴露而不是当成幂等命中
    expect(decideFulfillment(order({ status: 'PAID', paidAmount: 19900 }), parsed({ claimedAmount: 1 }))).toEqual({
      action: 'REJECT',
      reason: 'AMOUNT_MISMATCH',
    });
  });
});

// ============================================================================
// 幂等键
// ============================================================================

describe('entitlementIdempotencyKey', () => {
  it('同一订单同后缀稳定（数据库唯一约束的防重闸门）', () => {
    expect(entitlementIdempotencyKey(ORDER_NO)).toBe(entitlementIdempotencyKey(ORDER_NO));
  });

  it('【关键】用订单号而不是交易号（交易号在同订单的多次通知里会变）', () => {
    const key = entitlementIdempotencyKey(ORDER_NO);

    expect(key).toContain(ORDER_NO);
    // 键里不该出现交易号 —— 否则同订单的第二次通知会生成不同的键，失去防重作用
    expect(key).not.toContain('4200001234');
  });

  it('不同后缀区分同一订单的多份权益（如报告解锁 + PDF 导出权）', () => {
    expect(entitlementIdempotencyKey(ORDER_NO, 'report')).not.toBe(entitlementIdempotencyKey(ORDER_NO, 'pdf'));
  });

  it('长度不超过列的 128 字符上限', () => {
    expect(entitlementIdempotencyKey('x'.repeat(200)).length).toBeLessThanOrEqual(128);
  });
});
