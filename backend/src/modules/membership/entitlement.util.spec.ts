/**
 * 权益判定纯逻辑测试（契约 §2.4；架构 §13）
 *
 * 这类逻辑错一次就是两类严重问题之一：
 *   · **用户没付钱却看到了付费内容**（漏判）
 *   · **付了钱却被挡住**（误判，直接导致退款与投诉）
 * 两者都必须能 100% 回归，且不该依赖数据库替身 —— 因此判定逻辑全在这里。
 */

import {
  hasActiveMembership,
  isEntitlementActive,
  isReportUnlocked,
  membershipExpireAt,
  parseReportResourceKey,
  reportResourceKey,
  reportSectionResourceKey,
  resolveReportUnlock,
  type EntitlementLike,
} from './entitlement.util';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const REPORT_ID = '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d';

/** 造一条权益；默认是有效的整份报告解锁 */
const entitlement = (overrides: Partial<EntitlementLike> = {}): EntitlementLike => ({
  type: 'REPORT_UNLOCK',
  status: 'ACTIVE',
  resourceKey: reportResourceKey(REPORT_ID),
  reportId: null,
  expireAt: null,
  remainingQuota: null,
  ...overrides,
});

const daysFromNow = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

// ============================================================================
// 资源键编码
// ============================================================================

describe('资源键编码', () => {
  it('整份与单段两种形态', () => {
    expect(reportResourceKey(REPORT_ID)).toBe(`report:${REPORT_ID}`);
    expect(reportSectionResourceKey(REPORT_ID, 'overview')).toBe(`report:${REPORT_ID}#overview`);
  });

  it('【关键】编码与解码成对（往返一致）', () => {
    const whole = parseReportResourceKey(reportResourceKey(REPORT_ID));
    const section = parseReportResourceKey(reportSectionResourceKey(REPORT_ID, 'strengths'));

    expect(whole).toEqual({ reportId: REPORT_ID, sectionKey: null });
    expect(section).toEqual({ reportId: REPORT_ID, sectionKey: 'strengths' });
  });

  it('【关键】无法识别时返回 null 而不抛错', () => {
    // 这个方法会在批量解析权益时被调用成百次。抛错会让一条脏数据
    // （例如历史遗留的旧格式）把整次查询打挂 —— 跳过最多少解锁一段，
    // 而抛错是整页 500
    for (const bad of [null, '', 'report:', 'report:#overview', 'report:x#', 'membership:abc', '#x']) {
      expect(parseReportResourceKey(bad)).toBeNull();
    }
  });

  it('段落键里含 `#` 时按第一个分隔（reportId 是 UUID，不会含 `#`）', () => {
    expect(parseReportResourceKey(`report:${REPORT_ID}#a#b`)).toEqual({ reportId: REPORT_ID, sectionKey: 'a#b' });
  });
});

// ============================================================================
// 有效性
// ============================================================================

describe('isEntitlementActive', () => {
  it('默认有效', () => {
    expect(isEntitlementActive(entitlement(), NOW)).toBe(true);
  });

  it('【关键】`CONSUMED` 仍然算已解锁', () => {
    // 一次性权益"用掉"后状态变 `CONSUMED`，但用户买的是**内容访问权**，
    // 不是"一次查看"。若判为无效，用户刷新一次报告就又被付费墙挡住
    expect(isEntitlementActive(entitlement({ status: 'CONSUMED' }), NOW)).toBe(true);
  });

  it('【关键】`REVOKED`（退款撤销）立刻失效', () => {
    expect(isEntitlementActive(entitlement({ status: 'REVOKED' }), NOW)).toBe(false);
  });

  it('`EXPIRED` 失效', () => {
    expect(isEntitlementActive(entitlement({ status: 'EXPIRED' }), NOW)).toBe(false);
  });

  it('【关键】`expireAt` 为 null 表示永不过期，不能当成已过期', () => {
    expect(isEntitlementActive(entitlement({ expireAt: null }), NOW)).toBe(true);
  });

  it('【关键】到期时刻用 `<=`（恰好等于 now 即失效）', () => {
    expect(isEntitlementActive(entitlement({ expireAt: NOW }), NOW)).toBe(false);
    expect(isEntitlementActive(entitlement({ expireAt: daysFromNow(1) }), NOW)).toBe(true);
    expect(isEntitlementActive(entitlement({ status: 'EXPIRED', expireAt: daysFromNow(1) }), NOW)).toBe(false);
  });

  it('【关键】配额型权益次数用完后失效', () => {
    const credits = entitlement({ type: 'AI_CREDITS', remainingQuota: 0, resourceKey: null });

    expect(isEntitlementActive(credits, NOW)).toBe(false);
    expect(isEntitlementActive({ ...credits, remainingQuota: 1 }, NOW)).toBe(true);
    // 不限次（会员期内无限次）
    expect(isEntitlementActive({ ...credits, remainingQuota: null }, NOW)).toBe(true);
  });

  it('【关键】报告解锁与会员不看配额', () => {
    // 否则一条 `remainingQuota: 0` 的脏数据会让已购买的报告重新上锁
    expect(isEntitlementActive(entitlement({ remainingQuota: 0 }), NOW)).toBe(true);
    expect(
      isEntitlementActive(
        entitlement({ type: 'MEMBERSHIP_ACTIVE', remainingQuota: 0, expireAt: daysFromNow(30) }),
        NOW,
      ),
    ).toBe(true);
  });
});

// ============================================================================
// 报告解锁
// ============================================================================

describe('resolveReportUnlock', () => {
  it('没有任何权益 → 全锁', () => {
    const state = resolveReportUnlock([], REPORT_ID, NOW);

    expect(state.allUnlocked).toBe(false);
    expect(state.unlockedSectionKeys.size).toBe(0);
    expect(state.source).toBe('NONE');
  });

  it('整份解锁（`resourceKey` 形态）', () => {
    const state = resolveReportUnlock([entitlement()], REPORT_ID, NOW);

    expect(state.allUnlocked).toBe(true);
    expect(state.source).toBe('REPORT_PURCHASE');
  });

  it('整份解锁（`reportId` 外键形态）', () => {
    // 两种写法历史上都存在：`reportId` 是结构化外键、`resourceKey` 是通用键。
    // 只认一种就会出现"权益在库里但用户看不到"
    const state = resolveReportUnlock([entitlement({ resourceKey: null, reportId: REPORT_ID })], REPORT_ID, NOW);

    expect(state.allUnlocked).toBe(true);
    expect(state.source).toBe('REPORT_PURCHASE');
  });

  it('单段解锁', () => {
    const state = resolveReportUnlock(
      [entitlement({ resourceKey: reportSectionResourceKey(REPORT_ID, 'overview') })],
      REPORT_ID,
      NOW,
    );

    expect(state.allUnlocked).toBe(false);
    expect([...state.unlockedSectionKeys]).toEqual(['overview']);
    expect(state.source).toBe('SECTION_PURCHASE');
  });

  it('多段解锁累积', () => {
    const state = resolveReportUnlock(
      [
        entitlement({ resourceKey: reportSectionResourceKey(REPORT_ID, 'overview') }),
        entitlement({ resourceKey: reportSectionResourceKey(REPORT_ID, 'strengths') }),
      ],
      REPORT_ID,
      NOW,
    );

    expect([...state.unlockedSectionKeys].sort()).toEqual(['overview', 'strengths']);
  });

  it('【关键】会员优先于单份购买（避免用户以为付了两次钱）', () => {
    const state = resolveReportUnlock(
      [
        entitlement({ status: 'CONSUMED' }),
        entitlement({ type: 'MEMBERSHIP_ACTIVE', resourceKey: null, expireAt: daysFromNow(30) }),
      ],
      REPORT_ID,
      NOW,
    );

    expect(state.allUnlocked).toBe(true);
    expect(state.source).toBe('MEMBERSHIP');
  });

  it('【关键】别的报告的权益不能解锁本报告', () => {
    const other = '0195f3a2-ffff-7fff-8fff-ffffffffffff';
    const state = resolveReportUnlock(
      [
        entitlement({ resourceKey: reportResourceKey(other) }),
        entitlement({ resourceKey: reportSectionResourceKey(other, 'overview') }),
      ],
      REPORT_ID,
      NOW,
    );

    expect(state.allUnlocked).toBe(false);
    expect(state.unlockedSectionKeys.size).toBe(0);
  });

  it('过期与撤销的权益不生效', () => {
    const expired = entitlement({ expireAt: daysFromNow(-1) });
    const revoked = entitlement({ status: 'REVOKED' });
    const expiredMembership = entitlement({
      type: 'MEMBERSHIP_ACTIVE',
      resourceKey: null,
      expireAt: daysFromNow(-1),
    });

    expect(resolveReportUnlock([expired, revoked, expiredMembership], REPORT_ID, NOW)).toEqual({
      allUnlocked: false,
      unlockedSectionKeys: new Set<string>(),
      source: 'NONE',
    });
  });

  it('脏数据（识别不了的 resourceKey）被跳过而不是让判定失败', () => {
    const state = resolveReportUnlock(
      [entitlement({ resourceKey: 'legacy-format-abc' }), entitlement()],
      REPORT_ID,
      NOW,
    );

    expect(state.allUnlocked).toBe(true);
  });
});

describe('isReportUnlocked', () => {
  it('整份或单段解锁都算已解锁（列表页的 `isUnlocked` 用它）', () => {
    expect(isReportUnlocked([entitlement()], REPORT_ID, NOW)).toBe(true);
    expect(
      isReportUnlocked([entitlement({ resourceKey: reportSectionResourceKey(REPORT_ID, 'overview') })], REPORT_ID, NOW),
    ).toBe(true);
    expect(isReportUnlocked([], REPORT_ID, NOW)).toBe(false);
  });
});

// ============================================================================
// 会员
// ============================================================================

describe('会员判定', () => {
  const membership = (expireAt: Date | null): EntitlementLike =>
    entitlement({ type: 'MEMBERSHIP_ACTIVE', resourceKey: null, expireAt });

  it('有效会员期为真', () => {
    expect(hasActiveMembership([membership(daysFromNow(30))], NOW)).toBe(true);
  });

  it('【关键】缺 `expireAt` 的会员按无效处理（宁可少给，也不能白送终身会员）', () => {
    expect(hasActiveMembership([membership(null)], NOW)).toBe(false);
  });

  it('过期会员为假', () => {
    expect(hasActiveMembership([membership(daysFromNow(-1))], NOW)).toBe(false);
  });

  it('非会员权益不算会员', () => {
    expect(hasActiveMembership([entitlement()], NOW)).toBe(false);
  });

  it('多份会员权益取最晚的到期时间（续费叠加）', () => {
    const expireAt = membershipExpireAt([membership(daysFromNow(10)), membership(daysFromNow(400))], NOW);

    expect(expireAt?.toISOString()).toBe(daysFromNow(400).toISOString());
  });

  it('无有效会员时到期时间为 null', () => {
    expect(membershipExpireAt([membership(daysFromNow(-1))], NOW)).toBeNull();
    expect(membershipExpireAt([], NOW)).toBeNull();
  });
});
