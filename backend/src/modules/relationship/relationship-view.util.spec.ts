/**
 * 关系视图纯逻辑测试（契约 §3.6.4 / §3.6.5）
 *
 * 重点覆盖两类**错了不会报错、只会默默给出错误结果**的逻辑：
 *   ① 权限判定 —— 判错就是越权（该显示确认按钮的人看不到，或不该有的人看到）
 *   ② 天数与边界 —— 差一天的算法错误，手工验收几乎不可能发现
 */

import {
  MAX_ACTIVE_RELATIONSHIPS,
  buildPermissions,
  buildRelationshipSummary,
  buildTimeline,
  compatibilityScoreLabel,
  compatibilityScoreLevel,
  daysTogether,
  mbtiTypeName,
  relationStatusLabel,
  relationTypeName,
  relationshipExpiresAt,
} from './relationship-view.util';

// ============================================================================
// 标签
// ============================================================================

describe('中文标签', () => {
  it('关系类型与状态有中文名', () => {
    expect(relationTypeName('COUPLE')).toBe('伴侣关系');
    expect(relationStatusLabel('PENDING_A_CONFIRM')).toBe('待确认');
    expect(relationStatusLabel('ACTIVE')).toBe('已建立');
  });

  it('【关键】ADR-030 改名的状态必须都能翻译（否则界面会露出英文枚举）', () => {
    // `UNBOUND` 已在 ADR-030 中改名为 `REMOVED`；若标签表还是旧键，
    // 已解除的关系会显示成 `REMOVED` 这个原始枚举值
    expect(relationStatusLabel('REMOVED')).toBe('已解除');
    expect(relationStatusLabel('EXPIRED')).toBe('已过期');
    expect(relationStatusLabel('REJECTED')).toBe('已拒绝');
  });

  it('未知取值回落到原始值而非空串（让"新增枚举没登记"被看见）', () => {
    expect(relationTypeName('PARTNER')).toBe('PARTNER');
    expect(relationStatusLabel('BLOCKED')).toBe('BLOCKED');
  });

  it('MBTI 中文名来自类型百科数据', () => {
    expect(mbtiTypeName('INFJ')).toBe('提倡者');
    expect(mbtiTypeName('INTJ')).toBe('建筑师');
  });

  it('没有画像或无对应类型时返回 null（前端据此只显示四个字母）', () => {
    expect(mbtiTypeName(null)).toBeNull();
    expect(mbtiTypeName('XXXX')).toBeNull();
  });
});

// ============================================================================
// 在一起天数
// ============================================================================

describe('daysTogether', () => {
  it('当天为第 0 天', () => {
    expect(daysTogether(new Date('2026-10-10T09:00:00.000Z'), new Date('2026-10-10T23:00:00.000Z'))).toBe(0);
  });

  it('【关键】按自然日而非 24 小时倍数（跨零点即为第 1 天）', () => {
    // 若用 (now - start) / 86400000，昨天 23:00 → 今天 01:00 只有 2 小时，
    // 会算成 0 天，用户看到"今天刚建立" —— 与直觉不符
    expect(daysTogether(new Date('2026-10-09T23:00:00.000Z'), new Date('2026-10-10T01:00:00.000Z'))).toBe(1);
  });

  it('【关键】不足 24 小时但跨了自然日即为 1 天', () => {
    expect(daysTogether(new Date('2026-10-09T12:00:00.000Z'), new Date('2026-10-10T11:00:00.000Z'))).toBe(1);
  });

  it('未激活时返回 null（返回 0 会让人以为今天刚建立）', () => {
    expect(daysTogether(null, new Date('2026-10-10T12:00:00.000Z'))).toBeNull();
  });

  it('【关键】时钟回拨时钳到 0，不返回负数', () => {
    // 服务器时间被校正后退时，"在一起第 -3 天"会直接出现在界面上
    expect(daysTogether(new Date('2026-10-20T12:00:00.000Z'), new Date('2026-10-10T12:00:00.000Z'))).toBe(0);
  });

  it('跨月与跨年正确', () => {
    expect(daysTogether(new Date('2026-01-31T12:00:00.000Z'), new Date('2026-02-01T12:00:00.000Z'))).toBe(1);
    expect(daysTogether(new Date('2025-12-31T12:00:00.000Z'), new Date('2026-01-01T12:00:00.000Z'))).toBe(1);
  });
});

// ============================================================================
// 权限
// ============================================================================

describe('buildPermissions', () => {
  it('待确认 + 我是邀请方 → 可确认', () => {
    const permissions = buildPermissions({ status: 'PENDING_A_CONFIRM', isInviter: true, bothHaveProfiles: true });

    expect(permissions.canConfirm).toBe(true);
    expect(permissions.canRemove).toBe(true);
  });

  it('【关键】待确认 + 我是接受方 → 不可确认（契约 §3.6.6 的「待 A 确认」）', () => {
    const permissions = buildPermissions({ status: 'PENDING_A_CONFIRM', isInviter: false, bothHaveProfiles: true });

    expect(permissions.canConfirm).toBe(false);
    // 但接受方可以撤回
    expect(permissions.canRemove).toBe(true);
  });

  it('【关键】已生效时不可再确认（幂等由接口保证，但按钮不该出现）', () => {
    const permissions = buildPermissions({ status: 'ACTIVE', isInviter: true, bothHaveProfiles: true });

    expect(permissions.canConfirm).toBe(false);
    expect(permissions.canRemove).toBe(true);
    expect(permissions.canGenerateCompatibility).toBe(true);
    expect(permissions.canViewPartnerProfile).toBe(true);
  });

  it('【关键】已生效但对方无画像 → 不可生成匹配报告（缺画像无法算分）', () => {
    const permissions = buildPermissions({ status: 'ACTIVE', isInviter: true, bothHaveProfiles: false });

    expect(permissions.canGenerateCompatibility).toBe(false);
    // 关系生效与否与画像无关，仍可查看伙伴信息
    expect(permissions.canViewPartnerProfile).toBe(true);
  });

  it('【关键】终态下一律不可操作', () => {
    // 逐条列出，避免日后新增终态时漏配。若某个终态仍返回 canRemove=true，
    // 用户点"解除"会得到 409，看起来像 bug
    for (const status of ['REJECTED', 'EXPIRED', 'REMOVED']) {
      const permissions = buildPermissions({ status, isInviter: true, bothHaveProfiles: true });

      expect(permissions).toEqual({
        canConfirm: false,
        canRemove: false,
        canGenerateCompatibility: false,
        canViewPartnerProfile: false,
      });
    }
  });

  it('未知状态按终态处理（保守：不给任何操作权限）', () => {
    const permissions = buildPermissions({ status: 'SOMETHING_NEW', isInviter: true, bothHaveProfiles: true });

    expect(permissions.canRemove).toBe(false);
    expect(permissions.canConfirm).toBe(false);
  });
});

// ============================================================================
// 时间线
// ============================================================================

describe('buildTimeline', () => {
  const invited = new Date('2026-10-01T10:00:00.000Z');
  const accepted = new Date('2026-10-02T10:00:00.000Z');
  const activated = new Date('2026-10-03T10:00:00.000Z');

  it('【关键】按时间升序（时间线是叙事，倒序读起来像倒放）', () => {
    const timeline = buildTimeline({
      invitedAt: invited,
      invitedByUserId: 'user-a',
      acceptedAt: accepted,
      acceptedByUserId: 'user-b',
      activatedAt: activated,
      activatedByUserId: 'user-a',
      lastReportAt: null,
    });

    expect(timeline.map((item) => item.event)).toEqual(['INVITE_CREATED', 'INVITE_ACCEPTED', 'RELATIONSHIP_ACTIVATED']);
    expect(timeline[0].label).toBe('发起邀请');
  });

  it('【关键】缺失节点直接跳过，不做占位（占位会让用户以为发生过）', () => {
    const timeline = buildTimeline({
      invitedAt: invited,
      invitedByUserId: 'user-a',
      acceptedAt: null,
      acceptedByUserId: null,
      activatedAt: null,
      activatedByUserId: null,
      lastReportAt: null,
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0].event).toBe('INVITE_CREATED');
  });

  it('四个节点齐全时按顺序输出', () => {
    const timeline = buildTimeline({
      invitedAt: invited,
      invitedByUserId: 'user-a',
      acceptedAt: accepted,
      acceptedByUserId: 'user-b',
      activatedAt: activated,
      activatedByUserId: 'user-a',
      lastReportAt: new Date('2026-10-04T10:00:00.000Z'),
    });

    expect(timeline.map((item) => item.event)).toEqual([
      'INVITE_CREATED',
      'INVITE_ACCEPTED',
      'RELATIONSHIP_ACTIVATED',
      'COMPATIBILITY_GENERATED',
    ]);
  });

  it('【关键】同一时刻的事件保持插入顺序（否则"接受邀请"会跑到"发起邀请"前）', () => {
    const sameMoment = new Date('2026-10-01T10:00:00.000Z');
    const timeline = buildTimeline({
      invitedAt: sameMoment,
      invitedByUserId: 'user-a',
      acceptedAt: sameMoment,
      acceptedByUserId: 'user-b',
      activatedAt: null,
      activatedByUserId: null,
      lastReportAt: null,
    });

    expect(timeline.map((item) => item.event)).toEqual(['INVITE_CREATED', 'INVITE_ACCEPTED']);
  });

  it('全部缺失时返回空数组（新建立的关系尚无接受记录）', () => {
    expect(
      buildTimeline({
        invitedAt: null,
        invitedByUserId: null,
        acceptedAt: null,
        acceptedByUserId: null,
        activatedAt: null,
        activatedByUserId: null,
        lastReportAt: null,
      }),
    ).toEqual([]);
  });

  it('事件带操作人（用于区分"谁确认的"）', () => {
    const timeline = buildTimeline({
      invitedAt: invited,
      invitedByUserId: 'user-a',
      acceptedAt: null,
      acceptedByUserId: null,
      activatedAt: null,
      activatedByUserId: null,
      lastReportAt: null,
    });

    expect(timeline[0].actorUserId).toBe('user-a');
    expect(timeline[0].at).toBe(invited.toISOString());
  });
});

// ============================================================================
// 匹配分档
// ============================================================================

describe('compatibilityScoreLevel', () => {
  it('【关键】边界值按契约口径（>= 而非 >）', () => {
    // 恰好 80 分若被判成 GOOD，用户会看到与 79 分相同的结论 ——
    // 而"刚好卡边界"的用例在手工验收时几乎不会被覆盖
    expect(compatibilityScoreLevel(100)).toBe('EXCELLENT');
    expect(compatibilityScoreLevel(80)).toBe('EXCELLENT');
    expect(compatibilityScoreLevel(79)).toBe('GOOD');
    expect(compatibilityScoreLevel(65)).toBe('GOOD');
    expect(compatibilityScoreLevel(64)).toBe('FAIR');
    expect(compatibilityScoreLevel(50)).toBe('FAIR');
    expect(compatibilityScoreLevel(49)).toBe('CHALLENGING');
    expect(compatibilityScoreLevel(0)).toBe('CHALLENGING');
  });

  it('中文名齐全', () => {
    expect(compatibilityScoreLabel('GOOD')).toBe('契合良好');
    expect(compatibilityScoreLabel('EXCELLENT')).toBe('非常契合');
  });
});

// ============================================================================
// 摘要
// ============================================================================

describe('buildRelationshipSummary', () => {
  it('补上 maxAllowed（契约 §3.6.3 的 ACTIVE 上限 20）', () => {
    const summary = buildRelationshipSummary({
      activeCount: 2,
      pendingCount: 1,
      coupleCount: 1,
      friendCount: 2,
      familyCount: 0,
    });

    expect(summary.maxAllowed).toBe(MAX_ACTIVE_RELATIONSHIPS);
    expect(summary.activeCount).toBe(2);
  });

  it('全零时不报错', () => {
    expect(
      buildRelationshipSummary({
        activeCount: 0,
        pendingCount: 0,
        coupleCount: 0,
        friendCount: 0,
        familyCount: 0,
      }).maxAllowed,
    ).toBe(20);
  });
});

// ============================================================================
// 到期时间
// ============================================================================

describe('relationshipExpiresAt', () => {
  const expiresAt = new Date('2026-10-08T10:00:00.000Z');

  it('待确认时返回邀请的有效期', () => {
    expect(relationshipExpiresAt('PENDING_A_CONFIRM', expiresAt)).toBe(expiresAt.toISOString());
  });

  it('【关键】终态不返回到期时间（否则已解除的关系会显示一个未来日期，像还会自动生效）', () => {
    for (const status of ['ACTIVE', 'REJECTED', 'EXPIRED', 'REMOVED']) {
      expect(relationshipExpiresAt(status, expiresAt)).toBeNull();
    }
  });

  it('没有邀请记录时返回 null', () => {
    expect(relationshipExpiresAt('PENDING_A_CONFIRM', null)).toBeNull();
  });
});
