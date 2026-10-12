/**
 * 权益清单测试（契约 §3.8.3）
 *
 * 三组最重要的主张：
 *   · **强归属过滤**：所有查询条件都带 `userId`（架构 §14.1）
 *   · **脱敏**：响应与查询里都不出现内部发放备注、操作人 ID、`idempotencyKey`
 *   · **派生状态与筛选条件镜像一致**：`status` 由状态列 + 到期时间 + 剩余次数推导，
 *     筛选用的 SQL 片段必须能捞到同一批行
 */

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import {
  buildStatusClause,
  buildStatusFilter,
  deriveEntitlementStatus,
  entitlementIsUsable,
  entitlementResourceId,
  entitlementResourceSummary,
  entitlementSource,
  entitlementStatusLabel,
  entitlementTypeName,
  toEntitlementItem,
  type EntitlementRowLike,
} from './entitlement-view.util';
import { EntitlementService } from './entitlement.service';
import { MembershipController } from './membership.controller';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const NOW = new Date('2026-02-14T17:10:00.000Z');

const row = (overrides: Partial<EntitlementRowLike> = {}): EntitlementRowLike => ({
  id: '0195f3a2-eda7-7d20-8f35-d1ec8f9a0d8b',
  type: 'MEMBERSHIP_ACTIVE',
  status: 'ACTIVE',
  resourceKey: null,
  orderId: '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89',
  membershipId: null,
  reportId: null,
  relationshipId: null,
  totalQuota: null,
  usedQuota: 0,
  remainingQuota: null,
  startAt: new Date('2026-02-14T10:00:00.000Z'),
  expireAt: new Date('2026-03-14T10:00:00.000Z'),
  consumedAt: null,
  revokedAt: null,
  grantedByAdminId: null,
  ...overrides,
});

// ============================================================================
// 派生状态
// ============================================================================

describe('deriveEntitlementStatus（契约规则 2）', () => {
  it('REVOKED 优先于一切（退款后无论如何都不可用）', () => {
    expect(deriveEntitlementStatus(row({ status: 'REVOKED' }), NOW)).toBe('REVOKED');
    expect(
      deriveEntitlementStatus(row({ status: 'REVOKED', expireAt: new Date('2030-01-01T00:00:00.000Z') }), NOW),
    ).toBe('REVOKED');
  });

  it('时间窗已过 → EXPIRED（即使状态列还停在 ACTIVE）', () => {
    const past = new Date('2026-02-01T00:00:00.000Z');

    expect(deriveEntitlementStatus(row({ status: 'ACTIVE', expireAt: past }), NOW)).toBe('EXPIRED');
    // 恰好到期视为已过期
    expect(deriveEntitlementStatus(row({ expireAt: NOW }), NOW)).toBe('EXPIRED');
  });

  it('计数型配额用尽 → CONSUMED；null 表示不限次，不算用尽', () => {
    expect(deriveEntitlementStatus(row({ type: 'AI_CREDITS', remainingQuota: 0 }), NOW)).toBe('CONSUMED');
    expect(deriveEntitlementStatus(row({ type: 'AI_CREDITS', remainingQuota: 3 }), NOW)).toBe('ACTIVE');
    expect(deriveEntitlementStatus(row({ type: 'AI_CREDITS', remainingQuota: null }), NOW)).toBe('ACTIVE');
    // 非计数型不看配额
    expect(deriveEntitlementStatus(row({ type: 'PDF_EXPORT', remainingQuota: 0 }), NOW)).toBe('CONSUMED');
    expect(deriveEntitlementStatus(row({ type: 'REPORT_UNLOCK', remainingQuota: 0 }), NOW)).toBe('ACTIVE');
  });

  it('到期时间早于配额判断（已过期就不该显示为"已用完"）', () => {
    expect(
      deriveEntitlementStatus(
        row({ type: 'AI_CREDITS', remainingQuota: 0, expireAt: new Date('2026-01-01T00:00:00.000Z') }),
        NOW,
      ),
    ).toBe('EXPIRED');
  });

  it('状态列为 CONSUMED 时如实返回 CONSUMED', () => {
    expect(deriveEntitlementStatus(row({ status: 'CONSUMED', expireAt: null }), NOW)).toBe('CONSUMED');
  });
});

describe('筛选条件与派生状态镜像一致', () => {
  it('EXPIRED 片段同时覆盖「状态列已过期」与「状态列未刷但时间已过」', () => {
    const serialized = JSON.stringify(buildStatusClause('EXPIRED', NOW));

    expect(serialized).toContain('"status":"EXPIRED"');
    expect(serialized).toContain('"in":["ACTIVE","CONSUMED"]');
    expect(serialized).toContain('"lte"');
  });

  it('CONSUMED 片段同时覆盖「状态列 CONSUMED」与「配额用尽的 ACTIVE」', () => {
    const serialized = JSON.stringify(buildStatusClause('CONSUMED', NOW));

    expect(serialized).toContain('"status":"CONSUMED"');
    expect(serialized).toContain('"lte":0');
    expect(serialized).toContain('AI_CREDITS');
  });

  it('ACTIVE 片段排除已过期与配额用尽', () => {
    const serialized = JSON.stringify(buildStatusClause('ACTIVE', NOW));

    expect(serialized).toContain('"status":"ACTIVE"');
    expect(serialized).toContain('"gt"');
    // 配额用尽的行必须被 NOT 排除
    expect(serialized).toContain('"NOT"');
    expect(serialized).toContain('"lte":0');
  });

  it('REVOKED 片段只匹配状态列', () => {
    expect(buildStatusClause('REVOKED', NOW)).toEqual({ status: 'REVOKED' });
  });

  it('多选生成 OR；空数组返回 null（不加条件 = 返回全部状态）', () => {
    expect(buildStatusFilter([], NOW)).toBeNull();
    expect(buildStatusFilter(['ACTIVE'], NOW)).toEqual(buildStatusClause('ACTIVE', NOW));
    expect(buildStatusFilter(['ACTIVE', 'EXPIRED'], NOW)).toHaveProperty('OR');
  });
});

// ============================================================================
// 中文名与可用性
// ============================================================================

describe('entitlementStatusLabel（契约示例的三条文案）', () => {
  it('会员生效中 / 永久有效的报告解锁 / 次数包剩余 N 次', () => {
    expect(entitlementStatusLabel(row(), 'ACTIVE', NOW)).toBe('生效中（剩余 28 天）');
    expect(entitlementStatusLabel(row({ type: 'REPORT_UNLOCK', expireAt: null }), 'ACTIVE', NOW)).toBe('永久有效');
    expect(entitlementStatusLabel(row({ type: 'AI_CREDITS', remainingQuota: 30 }), 'ACTIVE', NOW)).toBe('剩余 30 次');
  });

  it('终态文案明确', () => {
    expect(entitlementStatusLabel(row(), 'EXPIRED', NOW)).toBe('已过期');
    expect(entitlementStatusLabel(row(), 'CONSUMED', NOW)).toBe('已用完');
    expect(entitlementStatusLabel(row(), 'REVOKED', NOW)).toBe('已撤销');
  });
});

describe('entitlementTypeName', () => {
  it('四种类型都有中文名', () => {
    expect(entitlementTypeName('REPORT_UNLOCK')).toBe('报告解锁');
    expect(entitlementTypeName('MEMBERSHIP_ACTIVE')).toBe('会员权益');
    expect(entitlementTypeName('AI_CREDITS')).toBe('AI 对话次数包');
    expect(entitlementTypeName('PDF_EXPORT')).toBe('PDF 导出权益');
  });
});

describe('entitlementIsUsable（复用 isEntitlementActive，不另写一套）', () => {
  it('生效中可用；已过期 / 已撤销 / 次数用尽不可用', () => {
    expect(entitlementIsUsable(row(), NOW)).toBe(true);
    expect(entitlementIsUsable(row({ expireAt: new Date('2026-01-01T00:00:00.000Z') }), NOW)).toBe(false);
    expect(entitlementIsUsable(row({ status: 'REVOKED' }), NOW)).toBe(false);
    expect(entitlementIsUsable(row({ type: 'AI_CREDITS', remainingQuota: 0 }), NOW)).toBe(false);
  });

  it('CONSUMED 的报告解锁仍算"已解锁"（用户买的是内容访问权）', () => {
    expect(entitlementIsUsable(row({ type: 'REPORT_UNLOCK', status: 'CONSUMED', expireAt: null }), NOW)).toBe(true);
  });
});

// ============================================================================
// 脱敏与来源
// ============================================================================

describe('来源与资源描述（脱敏）', () => {
  it('订单来源给 sourceOrderNo；人工发放只给 ADMIN 且 sourceId 为空（不暴露操作人）', () => {
    expect(entitlementSource(row(), 'SM20260214A7K3M9Q1')).toEqual({
      sourceType: 'ORDER',
      sourceId: '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89',
      sourceOrderNo: 'SM20260214A7K3M9Q1',
    });

    const admin = entitlementSource(
      row({ orderId: null, grantedByAdminId: '0195f3a2-aaaa-7bbb-8ccc-ddddeeeeffff' }),
      null,
    );

    expect(admin.sourceType).toBe('ADMIN');
    expect(admin.sourceId).toBeNull();
    expect(admin.sourceOrderNo).toBeNull();
  });

  it('resourceId 只对报告解锁有意义；不暴露内部 resourceKey', () => {
    expect(entitlementResourceId(row())).toBeNull();
    expect(
      entitlementResourceId(
        row({ type: 'REPORT_UNLOCK', reportId: '0195f3a2-aa11-7b97-8c02-2e3f4a5b6c01', resourceKey: 'report:x' }),
      ),
    ).toBe('0195f3a2-aa11-7b97-8c02-2e3f4a5b6c01');
  });

  it('resourceSummary 给用户看得懂的一句话', () => {
    expect(entitlementResourceSummary(row({ type: 'AI_CREDITS', totalQuota: 50 }), null)).toBe('AI 次数包 50 次');
    expect(entitlementResourceSummary(row({ type: 'REPORT_UNLOCK', reportId: 'r-1' }), '人格深度报告（画像 v2）')).toBe(
      '人格深度报告（画像 v2）',
    );
    // 报告标题取不到时回落到类型描述，而不是留空
    expect(entitlementResourceSummary(row({ type: 'REPORT_UNLOCK', reportId: 'r-1' }), null)).toBe('报告解锁');
  });
});

describe('toEntitlementItem', () => {
  it('契约字段齐全，且**不含**任何内部字段', () => {
    const item = toEntitlementItem(row(), NOW, null, 'SM20260214A7K3M9Q1');
    const serialized = JSON.stringify(item);

    expect(item).toMatchObject({
      entitlementId: '0195f3a2-eda7-7d20-8f35-d1ec8f9a0d8b',
      type: 'MEMBERSHIP_ACTIVE',
      typeName: '会员权益',
      status: 'ACTIVE',
      grantedAt: '2026-02-14T10:00:00.000Z',
      expiresAt: '2026-03-14T10:00:00.000Z',
      remainingSeconds: 2393400,
      remainingCount: null,
      totalCount: null,
      usedCount: 0,
      resourceId: null,
      sourceType: 'ORDER',
      sourceOrderNo: 'SM20260214A7K3M9Q1',
      isUsable: true,
    });

    for (const forbidden of ['grantedByAdminId', 'revokeReason', 'idempotencyKey', 'resourceKey', 'version']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// 服务
// ============================================================================

interface Harness {
  service: EntitlementService;
  prisma: {
    entitlement: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
  };
}

const createHarness = (rows: unknown[] = []): Harness => {
  const prisma = {
    entitlement: {
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };

  return { service: new EntitlementService(prisma as unknown as PrismaService), prisma };
};

describe('EntitlementService.listEntitlements（契约 §3.8.3）', () => {
  it('【关键】强归属过滤：查询条件始终包含 userId', async () => {
    const harness = createHarness();

    await harness.service.listEntitlements(USER_ID, {});

    const where = (harness.prisma.entitlement.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

    expect(where.userId).toBe(USER_ID);
    expect(where.deletedAt).toBeNull();
  });

  it('不传 status 时不加状态条件（契约用途栏要求含已过期/已消耗）', async () => {
    const harness = createHarness();

    await harness.service.listEntitlements(USER_ID, {});

    const where = (harness.prisma.entitlement.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

    expect(JSON.stringify(where)).not.toContain('"lte"');
  });

  it('status 筛选走派生规则（EXPIRED 会捞「状态未刷但时间已过」的行）', async () => {
    const harness = createHarness();

    await harness.service.listEntitlements(USER_ID, { status: ['EXPIRED'] });

    const where = (harness.prisma.entitlement.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

    expect(JSON.stringify(where)).toContain('"lte"');
  });

  it('type 与 resourceId 筛选生效，且 resourceId 同时匹配报告与关系', async () => {
    const harness = createHarness();

    await harness.service.listEntitlements(USER_ID, { type: ['REPORT_UNLOCK'], resourceId: 'res-1' });

    const where = (harness.prisma.entitlement.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

    expect(JSON.stringify(where)).toContain('"in":["REPORT_UNLOCK"]');
    expect(JSON.stringify(where)).toContain('"reportId":"res-1"');
    expect(JSON.stringify(where)).toContain('"relationshipId":"res-1"');
  });

  it('排序：status 为第一排序键（可用权益置顶），sortBy 为第二排序键', async () => {
    const harness = createHarness();

    await harness.service.listEntitlements(USER_ID, { sortBy: 'expiresAt', order: 'asc' });

    expect(harness.prisma.entitlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ status: 'asc' }, { expireAt: 'asc' }] }),
    );
  });

  it('默认按 grantedAt（= startAt）倒序', async () => {
    const harness = createHarness();

    await harness.service.listEntitlements(USER_ID, {});

    expect(harness.prisma.entitlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ status: 'asc' }, { startAt: 'desc' }] }),
    );
  });

  it('分页与 hasNext 按契约计算', async () => {
    const harness = createHarness();
    harness.prisma.entitlement.count.mockResolvedValue(45);

    const view = await harness.service.listEntitlements(USER_ID, { page: 3, pageSize: 20 });

    expect(view).toMatchObject({ total: 45, page: 3, pageSize: 20, hasNext: false });
  });

  it('【关键】select 里不查内部字段（脱敏从查询层开始）', async () => {
    const harness = createHarness();

    await harness.service.listEntitlements(USER_ID, {});

    const select = (harness.prisma.entitlement.findMany.mock.calls[0]?.[0] as { select: Record<string, unknown> })
      .select;
    const serialized = JSON.stringify(Object.keys(select));

    expect(serialized).not.toContain('revokeReason');
    expect(serialized).not.toContain('idempotencyKey');
    expect(serialized).not.toContain('version');
  });

  it('summary：三类状态计数 + 全部类型的 byType（无记录为 0）', async () => {
    const harness = createHarness();
    harness.prisma.entitlement.count.mockResolvedValue(1);
    harness.prisma.entitlement.groupBy.mockResolvedValue([
      { type: 'REPORT_UNLOCK', _count: { _all: 2 } },
      { type: 'AI_CREDITS', _count: { _all: 1 } },
    ]);

    const view = await harness.service.listEntitlements(USER_ID, {});

    expect(view.summary.activeCount).toBe(1);
    expect(view.summary.expiredCount).toBe(1);
    expect(view.summary.consumedCount).toBe(1);
    expect(view.summary.byType).toEqual({
      REPORT_UNLOCK: 2,
      MEMBERSHIP_ACTIVE: 0,
      AI_CREDITS: 1,
      PDF_EXPORT: 0,
    });
  });

  it('响应同时带上会员状态（避免"我的权益"页两次请求的中间态）', async () => {
    const harness = createHarness();

    const view = await harness.service.listEntitlements(USER_ID, {});

    expect(view.membership).toEqual({ isMember: false, expireAt: null, remainingDays: null });
  });

  it('列表项带上报告的标题作为 resourceSummary', async () => {
    const harness = createHarness([
      {
        ...row({ type: 'REPORT_UNLOCK', reportId: 'r-1', orderId: null, expireAt: null }),
        order: { orderNo: null },
        report: { title: '人格深度报告（画像 v2）' },
      },
    ]);

    const view = await harness.service.listEntitlements(USER_ID, {});

    expect(view.items[0]?.resourceSummary).toBe('人格深度报告（画像 v2）');
  });

  it('列表项不泄露内部字段（对象级断言）', async () => {
    const harness = createHarness([
      { ...row({ grantedByAdminId: 'admin-1' }), order: { orderNo: 'SM1' }, report: null },
    ]);

    const view = await harness.service.listEntitlements(USER_ID, {});
    const serialized = JSON.stringify(view.items);

    expect(serialized).not.toContain('admin-1');
    expect(serialized).not.toContain('grantedByAdminId');
  });
});

// ============================================================================
// 路由契约
// ============================================================================

describe('GET /membership/entitlements 路由契约（契约 §3.8.3）', () => {
  it('路径与 HTTP 方法', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MembershipController.prototype.listEntitlements)).toBe('entitlements');
    expect(Reflect.getMetadata(METHOD_METADATA, MembershipController.prototype.listEntitlements)).toBe(
      RequestMethod.GET,
    );
  });

  it('【关键】必须鉴权（契约标 🔑）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MembershipController.prototype.listEntitlements)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MembershipController)).toBeUndefined();
  });

  it('显式限流 120 次/60s', () => {
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}global`, MembershipController.prototype.listEntitlements)).toBe(120);
  });

  it('透传 userId 与全部查询参数（缺省值由 Service 兜底）', async () => {
    const listEntitlements = jest.fn().mockResolvedValue({});
    const controller = new MembershipController(
      {} as unknown as PrismaService,
      { listEntitlements } as unknown as EntitlementService,
    );

    await controller.listEntitlements(USER_ID, { page: 2, status: ['ACTIVE'] });

    expect(listEntitlements).toHaveBeenCalledWith(USER_ID, { page: 2, status: ['ACTIVE'] });
  });
});
