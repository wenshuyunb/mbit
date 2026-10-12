/**
 * 退款纯逻辑测试
 *
 * 这些断言是**资金口径的回归网**：每一条对应一种真实资损形态。
 * 特别是 `orderStatusAfterRefund`（订单是否该落到全额退款）与
 * `refundSettlementOfWechatState`（未知状态绝不能判成失败）——
 * 两者算错都会造成账实不符，且只在真实退款发生时才暴露。
 */

import {
  AUTO_APPROVE_WINDOW_HOURS,
  REFUND_ARRIVAL_NOTICE,
  REFUND_CANCEL_WINDOW_MINUTES,
  REFUND_META_KEY,
  REFUND_WINDOW_DAYS,
  buildRefundIdempotencyKey,
  composeRefundFailureReason,
  composeUserRefundReason,
  decideUserRefundPolicy,
  emptyRefundMeta,
  generateRefundNo,
  isValidRefundNo,
  normalizeCloseReason,
  orderStatusAfterRefund,
  readRefundMeta,
  refundCancelDeadline,
  refundSettlementOfWechatState,
  refundStatusLabel,
  refundTypeOf,
  wechatRefundFailureReason,
  withRefundMeta,
} from './refund.util';

const NOW = new Date('2026-02-14T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('generateRefundNo / isValidRefundNo', () => {
  it('格式为 `RF` + yyyyMMdd + 8 位 Base32（契约 §3.9.10 规则 6）', () => {
    const refundNo = generateRefundNo(NOW);

    expect(refundNo).toMatch(/^RF\d{8}[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(refundNo.startsWith('RF20260214')).toBe(true);
    expect(refundNo.length).toBe(18);
  });

  it('【关键】两次生成不同（同一秒内两笔退款不能撞号）', () => {
    const values = new Set(Array.from({ length: 200 }, () => generateRefundNo(NOW)));

    expect(values.size).toBe(200);
  });

  it('`isValidRefundNo` 与生成格式一致', () => {
    expect(isValidRefundNo(generateRefundNo(NOW))).toBe(true);
    expect(isValidRefundNo('RF20260214')).toBe(false);
    expect(isValidRefundNo('SM20260214A7K3M9Q1')).toBe(false);
  });
});

describe('buildRefundIdempotencyKey', () => {
  it('长度不超过 `refunds.idempotency_key` 的 64 字符上限', () => {
    const key = buildRefundIdempotencyKey('u'.repeat(36), 'o'.repeat(36), 'k'.repeat(64));

    expect(key.length).toBeLessThanOrEqual(64);
    expect(key.startsWith('rf')).toBe(true);
  });

  it('同一输入稳定（重放必须命中同一行）', () => {
    const args = ['u1', 'o1', 'client-key'] as const;

    expect(buildRefundIdempotencyKey(...args)).toBe(buildRefundIdempotencyKey(...args));
  });

  it('【关键】不同用户使用相同客户端键不会互相顶掉', () => {
    expect(buildRefundIdempotencyKey('userA', 'order1', 'same-key')).not.toBe(
      buildRefundIdempotencyKey('userB', 'order1', 'same-key'),
    );
  });

  it('【关键】同一用户对不同订单用同一键会各自生成独立退款', () => {
    expect(buildRefundIdempotencyKey('userA', 'order1', 'same-key')).not.toBe(
      buildRefundIdempotencyKey('userA', 'order2', 'same-key'),
    );
  });
});

describe('decideUserRefundPolicy', () => {
  const decide = (
    overrides: Partial<Parameters<typeof decideUserRefundPolicy>[0]> = {},
  ): ReturnType<typeof decideUserRefundPolicy> =>
    decideUserRefundPolicy({
      paidAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      reason: 'DUPLICATE_PURCHASE',
      hasConsumedEntitlement: false,
      now: NOW,
      ...overrides,
    });

  it('【关键】24h 内 + 重复购买/误操作 + 权益未消费 → 自动退款', () => {
    expect(decide({ reason: 'DUPLICATE_PURCHASE' })).toBe('AUTO_APPROVE');
    expect(decide({ reason: 'ACCIDENTAL' })).toBe('AUTO_APPROVE');
  });

  it('24h 内但原因需要判断（如与预期不符）→ 人工审核', () => {
    expect(decide({ reason: 'NOT_AS_EXPECTED' })).toBe('MANUAL_REVIEW');
    expect(decide({ reason: 'SERVICE_ISSUE' })).toBe('MANUAL_REVIEW');
  });

  it('【关键】超过 24h 但 7 天内 + 权益未消费 → 人工审核（不自动出款）', () => {
    expect(decide({ paidAt: new Date(NOW.getTime() - (AUTO_APPROVE_WINDOW_HOURS + 1) * 60 * 60 * 1000) })).toBe(
      'MANUAL_REVIEW',
    );
  });

  it('【关键】权益已消费 → 直接拒绝（即使只过了 1 小时）', () => {
    expect(decide({ hasConsumedEntitlement: true })).toBe('REJECT_CONSUMED');
  });

  it('【关键】权益已消费优先于超期判定（给出的理由必须是最相关的那条）', () => {
    expect(
      decide({
        hasConsumedEntitlement: true,
        paidAt: new Date(NOW.getTime() - (REFUND_WINDOW_DAYS + 5) * DAY_MS),
      }),
    ).toBe('REJECT_CONSUMED');
  });

  it('超过 7 天 → 拒绝', () => {
    expect(decide({ paidAt: new Date(NOW.getTime() - (REFUND_WINDOW_DAYS + 1) * DAY_MS) })).toBe('REJECT_EXPIRED');
  });

  it('第 7 天当天仍可申请（边界归入可退）', () => {
    expect(decide({ paidAt: new Date(NOW.getTime() - REFUND_WINDOW_DAYS * DAY_MS) })).toBe('MANUAL_REVIEW');
  });

  it('未支付（paidAt 为空）按超期拒绝', () => {
    expect(decide({ paidAt: null })).toBe('REJECT_EXPIRED');
  });
});

describe('refundTypeOf', () => {
  it('等于实付额即全额，否则部分', () => {
    expect(refundTypeOf(9900, 9900)).toBe('FULL');
    expect(refundTypeOf(9900, 9900 + 100)).toBe('PARTIAL');
    expect(refundTypeOf(5000, 9900)).toBe('PARTIAL');
  });

  it('实付额为 0 时归为 PARTIAL（避免 0/0 被当成全额）', () => {
    expect(refundTypeOf(0, 0)).toBe('PARTIAL');
  });
});

describe('refundSettlementOfWechatState', () => {
  it('SUCCESS → 结算成功', () => {
    expect(refundSettlementOfWechatState('SUCCESS')).toBe('SUCCESS');
  });

  it('CLOSED / ABNORMAL → 结算失败', () => {
    expect(refundSettlementOfWechatState('CLOSED')).toBe('FAILED');
    expect(refundSettlementOfWechatState('ABNORMAL')).toBe('FAILED');
  });

  it('【关键】PROCESSING 与任何未知状态都归为 PENDING（绝不写 FAILED）', () => {
    for (const state of ['PROCESSING', 'UNKNOWN', '', 'SOMETHING_NEW']) {
      expect(refundSettlementOfWechatState(state)).toBe('PENDING');
    }
  });

  it('失败原因文案区分「已关闭」与「异常」', () => {
    expect(wechatRefundFailureReason('CLOSED')).toContain('关闭');
    expect(wechatRefundFailureReason('ABNORMAL')).toContain('异常');
  });
});

describe('orderStatusAfterRefund', () => {
  it('【关键】累计已退 == 实付 → 全额退款状态', () => {
    expect(orderStatusAfterRefund(9900, 9900)).toBe('REFUNDED');
  });

  it('【关键】多次部分退款累计到实付额也必须落到全额退款状态', () => {
    // 否则订单会永远停在 PARTIAL_REFUNDED，而可退金额已经是 0
    expect(orderStatusAfterRefund(5000 + 4900, 9900)).toBe('REFUNDED');
  });

  it('累计未到实付额 → 部分退款状态', () => {
    expect(orderStatusAfterRefund(4900, 9900)).toBe('PARTIAL_REFUNDED');
    expect(orderStatusAfterRefund(0, 9900)).toBe('PARTIAL_REFUNDED');
  });

  it('实付额为 0 的脏数据不会误判为全额退款', () => {
    expect(orderStatusAfterRefund(0, 0)).toBe('PARTIAL_REFUNDED');
  });
});

describe('composeUserRefundReason / composeRefundFailureReason', () => {
  it('用户申请原因带中文标签与补充说明', () => {
    expect(composeUserRefundReason('DUPLICATE_PURCHASE', null)).toBe('用户申请：重复购买');
    expect(composeUserRefundReason('OTHER', '买错了')).toBe('用户申请：其他（买错了）');
  });

  it('【关键】超长文本被截断到 256 字符（列长度上限，超长会让整笔退款失败）', () => {
    expect(composeUserRefundReason('OTHER', 'x'.repeat(500)).length).toBe(256);
  });

  it('失败原因截断到 500 字符', () => {
    expect(composeRefundFailureReason('y'.repeat(900)).length).toBe(500);
  });
});

describe('refundStatusLabel', () => {
  it('四种状态都有中文名（契约 §3.9.9 示例的措辞）', () => {
    expect(refundStatusLabel('PENDING')).toBe('已受理，处理中');
    expect(refundStatusLabel('SUCCESS')).toBe('已退款');
    expect(refundStatusLabel('FAILED')).toBe('退款失败');
    expect(refundStatusLabel('CLOSED')).toBe('已关闭');
  });

  it('未登记状态回落原值', () => {
    expect(refundStatusLabel('NEW_STATE')).toBe('NEW_STATE');
  });

  it('到账说明明确为 1–3 个工作日（不承诺即时到账）', () => {
    expect(REFUND_ARRIVAL_NOTICE).toContain('1–3 个工作日');
  });
});

describe('refundCancelDeadline', () => {
  it('申请后 30 分钟（契约 §3.9.10 的 `nextAction.cancelDeadline`）', () => {
    const deadline = refundCancelDeadline(NOW);

    expect(deadline.getTime() - NOW.getTime()).toBe(REFUND_CANCEL_WINDOW_MINUTES * 60_000);
  });
});

describe('退款元数据（notify_payload 命名空间）', () => {
  it('写入后可完整读回', () => {
    const meta = {
      ...emptyRefundMeta('ADMIN', 'PARTIAL'),
      requiresReview: false,
      internalNote: '客服工单 TK-1',
      ticketId: 'TK-1',
      isForced: true,
      entitlementRevoked: true,
      revokedEntitlementIds: ['e1', 'e2'],
    };
    const payload = withRefundMeta(null, meta);

    expect(readRefundMeta(payload)).toEqual(meta);
  });

  it('【关键】不会覆盖 payload 里已有的其它键（微信原始报文必须保留）', () => {
    const payload = withRefundMeta({ wechatRefund: { status: 'SUCCESS' } }, emptyRefundMeta('USER', 'FULL'));

    expect(payload['wechatRefund']).toEqual({ status: 'SUCCESS' });
    expect(payload[REFUND_META_KEY]).toBeDefined();
  });

  it('读不到元数据时返回 null（不编造 `USER`，否则审计会误判为"用户申请"）', () => {
    expect(readRefundMeta(null)).toBeNull();
    expect(readRefundMeta({})).toBeNull();
    expect(readRefundMeta([])).toBeNull();
    expect(readRefundMeta({ [REFUND_META_KEY]: 'not-an-object' })).toBeNull();
  });

  it('元数据里的非法枚举被归一到安全值', () => {
    const meta = readRefundMeta({
      [REFUND_META_KEY]: { operator: 'HACKER', refundType: 'WEIRD', revokedEntitlementIds: ['e1', 42, null] },
    });

    expect(meta?.operator).toBe('USER');
    expect(meta?.refundType).toBe('PARTIAL');
    expect(meta?.revokedEntitlementIds).toEqual(['e1']);
  });
});

describe('normalizeCloseReason', () => {
  it('【关键】用户调用时强制 USER_REQUEST（否则流失分析会把主动放弃算成系统超时）', () => {
    expect(normalizeCloseReason('TIMEOUT', true)).toBe('USER_REQUEST');
    expect(normalizeCloseReason(undefined, true)).toBe('USER_REQUEST');
  });

  it('cron 可以使用 TIMEOUT', () => {
    expect(normalizeCloseReason('TIMEOUT', false)).toBe('TIMEOUT');
    expect(normalizeCloseReason(undefined, false)).toBe('USER_REQUEST');
  });
});
