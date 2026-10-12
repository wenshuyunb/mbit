/**
 * 通知服务测试（契约 §3.11）
 *
 * 三组最重要的主张：
 *   · **强归属过滤**：所有查询/更新条件都带 `userId`（架构 §14.1）
 *   · **越权 ID 静默跳过**：他人的通知 ID 不进 `403`，只进 `skippedIds`
 *     （返回 403 等于告诉攻击者这个 ID 真实存在）
 *   · **已读幂等**：已读的再次标记不改 `readAt`，保留首次已读时间
 */

import { ErrorCode } from '../../common/errors/error-code';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { SystemConfigService } from '../system/system-config.service';
import { NotificationService } from './notification.service';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OTHER_USER_ID = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';
const NOTIFICATION_ID = '0195f3a2-c1a8-7e20-9f35-5c6d7e8f9a0b';
const OTHER_NOTIFICATION_ID = '0195f3a2-c2b9-7f31-8a46-6d7e8f9a0b1c';

interface Harness {
  service: NotificationService;
  prisma: {
    notification: {
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  redis: { key: jest.Mock; setJson: jest.Mock; getJson: jest.Mock; setIfAbsent: jest.Mock };
  systemConfig: { getEntry: jest.Mock };
}

const createHarness = (overrides: Partial<Harness['prisma']['notification']> = {}): Harness => {
  const prisma = {
    notification: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      ...overrides,
    },
  };

  const redis = {
    key: jest.fn((...parts: (string | number)[]) => ['sm', ...parts].join(':')),
    setJson: jest.fn().mockResolvedValue(undefined),
    getJson: jest.fn().mockResolvedValue(null),
    setIfAbsent: jest.fn().mockResolvedValue(true),
  };

  const systemConfig = { getEntry: jest.fn().mockResolvedValue(undefined) };

  const service = new NotificationService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    systemConfig as unknown as SystemConfigService,
  );

  return { service, prisma, redis, systemConfig };
};

/** 取 `findMany` 的 where 参数 */
const whereOf = (harness: Harness, call = 0): Record<string, unknown> =>
  (harness.prisma.notification.findMany.mock.calls[call]?.[0] as { where: Record<string, unknown> }).where;

// ============================================================================
// 列表
// ============================================================================

describe('NotificationService.listNotifications', () => {
  it('【关键】强归属过滤：查询条件始终包含 userId', async () => {
    const harness = createHarness();

    await harness.service.listNotifications({ userId: USER_ID });

    expect(whereOf(harness).userId).toBe(USER_ID);
    expect(harness.prisma.notification.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER_ID }) }),
    );
  });

  it('默认只返回未读（契约默认值 UNREAD）', async () => {
    const harness = createHarness();

    await harness.service.listNotifications({ userId: USER_ID });

    // 未读条件放在 `AND` 里（它与范围条件里的 `OR` 必须共存，不能互相覆盖）
    expect(JSON.stringify(whereOf(harness))).toContain('"readAt":null');
  });

  it('status=ALL 不加读取状态条件；status=READ 同时认 readAt 与 READ 状态', async () => {
    const all = createHarness();
    await all.service.listNotifications({ userId: USER_ID, status: 'ALL' });
    const allWhere = whereOf(all);
    expect(allWhere.readAt).toBeUndefined();
    expect(JSON.stringify(allWhere)).not.toContain('"readAt"');

    const read = createHarness();
    await read.service.listNotifications({ userId: USER_ID, status: 'READ' });
    expect(JSON.stringify(whereOf(read))).toContain('"readAt":{"not":null}');
  });

  it('分页参数与 hasNext 按契约计算', async () => {
    const harness = createHarness({ findMany: jest.fn().mockResolvedValue([]) });
    harness.prisma.notification.count.mockResolvedValue(45);

    const view = await harness.service.listNotifications({ userId: USER_ID, page: 2, pageSize: 20 });

    expect(view.page).toBe(2);
    expect(view.pageSize).toBe(20);
    expect(view.total).toBe(45);
    expect(view.hasNext).toBe(true);
    expect(harness.prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
  });

  it('sortBy=readAt 时指定 nulls: last（否则未读会插到最近已读最前面）', async () => {
    const harness = createHarness();

    await harness.service.listNotifications({ userId: USER_ID, sortBy: 'readAt', order: 'desc' });

    expect(harness.prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { readAt: { sort: 'desc', nulls: 'last' } } }),
    );
  });

  it('summary 的 byType 键集合稳定（全部类型都在，无记录为 0）', async () => {
    const harness = createHarness();
    harness.prisma.notification.count.mockResolvedValue(0);

    const view = await harness.service.listNotifications({ userId: USER_ID });

    expect(Object.keys(view.summary.byType).sort()).toEqual(
      [
        'ACCOUNT_RESTORED',
        'CONTENT_MODERATION',
        'MEMBERSHIP',
        'PAYMENT',
        'RELATIONSHIP',
        'REPORT_READY',
        'SECURITY_ALERT',
        'SYSTEM',
      ].sort(),
    );
    expect(view.summary.byType.REPORT_READY).toBe(0);
  });

  it('summary 的统计口径与筛选无关（未读数是独立的一次查询）', async () => {
    const harness = createHarness();
    harness.prisma.notification.count.mockResolvedValue(3);

    const view = await harness.service.listNotifications({
      userId: USER_ID,
      status: 'READ',
      type: ['REPORT_READY'],
    });

    expect(view.total).toBe(3);
    expect(view.summary.totalCount).toBe(3);

    // 未读数走的是独立 count（带 `readAt: null`，且不受 `status`/`type` 筛选影响）。
    // 注意 `readAt` 落在 `AND` 里而不是顶层键：读取状态条件必须与范围条件里的
    // `OR`（"必须有可展示文本"）共存，直接展开会互相覆盖
    const unreadCall = harness.prisma.notification.count.mock.calls.find((call) =>
      JSON.stringify(call[0]).includes('"readAt":null'),
    );

    expect(unreadCall).toBeDefined();
    expect(JSON.stringify(unreadCall?.[0])).toContain(USER_ID);

    // 未读计数**只带范围的过期条件 + 未读条件**，没有叠加读取状态/类型筛选。
    // 列表面向筛选的那次 count 会多出一项（类型条件）
    const unreadAnd = (unreadCall?.[0] as { where: { AND: unknown[] } }).where.AND;

    expect(unreadAnd).toHaveLength(2);
    expect(unreadAnd[1]).toEqual({ readAt: null });
  });

  it('图标域名来自配置；未配置时 iconUrl 为 null', async () => {
    const withDomain = createHarness();
    withDomain.systemConfig.getEntry.mockResolvedValue({ rawValue: 'https://cdn.example.com' });
    withDomain.prisma.notification.findMany.mockResolvedValue([
      {
        id: NOTIFICATION_ID,
        type: 'IN_APP',
        status: 'SENT',
        templateId: null,
        title: 'T',
        content: 'C',
        pagePath: '/pages/profile/index',
        payload: { bizType: 'REPORT_READY' },
        idempotencyKey: 'k',
        sentAt: new Date(),
        readAt: null,
        createdAt: new Date(),
      },
    ]);

    const view = await withDomain.service.listNotifications({ userId: USER_ID });

    expect(view.items[0]?.iconUrl).toBe('https://cdn.example.com/static/notification/report-ready.png');
  });
});

// ============================================================================
// 标记已读
// ============================================================================

describe('NotificationService.markRead', () => {
  it('两个参数都没传 → 400（PARAM_INVALID）', async () => {
    const harness = createHarness();

    await expect(harness.service.markRead(USER_ID, {})).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID,
    });
  });

  it('空数组同样拒绝', async () => {
    const harness = createHarness();

    await expect(harness.service.markRead(USER_ID, { notificationIds: [] })).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID,
    });
  });

  it('【关键】他人的通知 ID 静默跳过，不报 403', async () => {
    const harness = createHarness({
      // 只返回属于我的那一条
      findMany: jest.fn().mockResolvedValue([{ id: NOTIFICATION_ID, readAt: null, status: 'SENT' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    const result = await harness.service.markRead(USER_ID, {
      notificationIds: [NOTIFICATION_ID, OTHER_NOTIFICATION_ID],
    });

    expect(result.requestedCount).toBe(2);
    expect(result.updatedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skippedIds).toEqual([OTHER_NOTIFICATION_ID]);

    // 更新条件必须带 userId，否则就成了"凭 ID 改他人数据"
    expect(harness.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID, readAt: null }),
        data: expect.objectContaining({ readAt: expect.any(Date) }),
      }),
    );
  });

  it('【关键】已读的再次标记：不改 readAt（保留首次已读时间）', async () => {
    const firstReadAt = new Date('2026-02-14T10:00:00.000Z');
    const harness = createHarness({
      findMany: jest.fn().mockResolvedValue([{ id: NOTIFICATION_ID, readAt: firstReadAt, status: 'SENT' }]),
    });

    const result = await harness.service.markRead(USER_ID, { notificationIds: [NOTIFICATION_ID] });

    expect(result.updatedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.skippedIds).toEqual([NOTIFICATION_ID]);
    expect(harness.prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it('幂等：重复调用同一批 ID，第二次全部跳过且不报错', async () => {
    const harness = createHarness({
      findMany: jest.fn().mockResolvedValue([{ id: NOTIFICATION_ID, readAt: new Date(), status: 'SENT' }]),
    });

    const again = await harness.service.markRead(USER_ID, { notificationIds: [NOTIFICATION_ID] });

    expect(again.updatedCount).toBe(0);
    expect(again.skippedCount).toBe(1);
    expect(again.readAt).toEqual(expect.any(String));
  });

  it('重复 ID 去重（同一 ID 传两次不会把 updatedCount 算成 2）', async () => {
    const harness = createHarness({
      findMany: jest.fn().mockResolvedValue([{ id: NOTIFICATION_ID, readAt: null, status: 'SENT' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    const result = await harness.service.markRead(USER_ID, {
      notificationIds: [NOTIFICATION_ID, NOTIFICATION_ID],
    });

    expect(result.requestedCount).toBe(1);
    expect(result.updatedCount).toBe(1);
  });

  it('all=true 时按 1000 条分批，且更新条件带 userId 与 readAt: null', async () => {
    const batch = Array.from({ length: 1000 }, (_unused, index) => ({ id: `id-${index}` }));
    const findMany = jest.fn().mockResolvedValueOnce(batch).mockResolvedValueOnce([]);
    const harness = createHarness({
      findMany,
      updateMany: jest.fn().mockResolvedValue({ count: 1000 }),
    });

    const result = await harness.service.markRead(USER_ID, { all: true });

    expect(result.requestedCount).toBe(1000);
    expect(result.updatedCount).toBe(1000);
    expect(harness.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER_ID, readAt: null }) }),
    );
  });

  it('all=true + type 时批量条件里带上类型筛选', async () => {
    const harness = createHarness({ findMany: jest.fn().mockResolvedValue([]) });

    await harness.service.markRead(USER_ID, { all: true, type: 'SECURITY_ALERT' });

    expect(JSON.stringify(whereOf(harness))).toContain('"startsWith":"ban:"');
  });
});

// ============================================================================
// 订阅授权
// ============================================================================

describe('NotificationService.recordSubscriptions', () => {
  it('ACCEPT 落 Redis，键名符合契约规则 4', async () => {
    const harness = createHarness();

    const view = await harness.service.recordSubscriptions(USER_ID, {
      subscriptions: [{ templateId: 'TMPL_REPORT_READY', scene: 'REPORT_READY', result: 'ACCEPT' }],
    });

    expect(harness.redis.setJson).toHaveBeenCalledWith(
      `sm:sub:quota:${USER_ID}:REPORT_READY`,
      expect.objectContaining({ scene: 'REPORT_READY', remainingQuota: 1 }),
      30 * 24 * 60 * 60,
    );
    expect(view.acceptedCount).toBe(1);
    expect(view.rejectedCount).toBe(0);
    expect(view.totalRemainingQuota).toBe(1);
    expect(view.notice).toContain('一次性授权');
  });

  it('库中已配置权威模板 ID 时以服务端为准（客户端值仅用于核对）', async () => {
    const harness = createHarness();
    harness.systemConfig.getEntry.mockResolvedValue({ rawValue: 'TMPL_SERVER_AUTHORITATIVE' });

    const view = await harness.service.recordSubscriptions(USER_ID, {
      subscriptions: [{ templateId: 'TMPL_CLIENT_FAKE', scene: 'REPORT_READY', result: 'ACCEPT' }],
    });

    expect(view.items[0]?.templateId).toBe('TMPL_SERVER_AUTHORITATIVE');
  });

  it('REJECT 记 0 配额；totalRemainingQuota 只累加本次结果', async () => {
    const harness = createHarness();

    const view = await harness.service.recordSubscriptions(USER_ID, {
      subscriptions: [
        { templateId: 'TMPL_A', scene: 'REPORT_READY', result: 'ACCEPT' },
        { templateId: 'TMPL_B', scene: 'MEMBERSHIP_EXPIRING', result: 'REJECT' },
        { templateId: 'TMPL_C', scene: 'PAYMENT_RESULT', result: 'BAN' },
      ],
    });

    expect(view.acceptedCount).toBe(1);
    // BAN 归入未授权：与 REJECT 的后果相同
    expect(view.rejectedCount).toBe(2);
    expect(view.totalRemainingQuota).toBe(1);
  });

  it('allScenes 覆盖全部六个场景', async () => {
    const harness = createHarness();

    const view = await harness.service.recordSubscriptions(USER_ID, {
      subscriptions: [{ templateId: 'TMPL_A', scene: 'REPORT_READY', result: 'ACCEPT' }],
    });

    expect(view.allScenes.map((scene) => scene.scene as string).sort()).toEqual(
      [
        'DELETION_REMINDER',
        'MEMBERSHIP_EXPIRING',
        'PAYMENT_RESULT',
        'RELATIONSHIP_CONFIRMED',
        'RELATIONSHIP_INVITE',
        'REPORT_READY',
      ].sort(),
    );
  });

  it('clientRequestId 重复上报只记日志，不报错（天然幂等）', async () => {
    const harness = createHarness();
    harness.redis.setIfAbsent.mockResolvedValue(false);

    const view = await harness.service.recordSubscriptions(USER_ID, {
      subscriptions: [{ templateId: 'TMPL_A', scene: 'REPORT_READY', result: 'ACCEPT' }],
      clientRequestId: 'sub_req_replay',
    });

    expect(view.acceptedCount).toBe(1);
    expect(harness.redis.setIfAbsent).toHaveBeenCalled();
  });

  it('审计键写入失败不影响授权结果', async () => {
    const harness = createHarness();
    harness.redis.setIfAbsent.mockRejectedValue(new Error('redis down'));

    await expect(
      harness.service.recordSubscriptions(USER_ID, {
        subscriptions: [{ templateId: 'TMPL_A', scene: 'REPORT_READY', result: 'ACCEPT' }],
        clientRequestId: 'sub_req_1',
      }),
    ).resolves.toMatchObject({ acceptedCount: 1 });
  });
});

// ============================================================================
// 未读计数
// ============================================================================

describe('NotificationService.countUnread', () => {
  it('只数当前用户的未读，且口径与列表一致（未过期、非 CANCELLED）', async () => {
    const harness = createHarness();
    harness.prisma.notification.count.mockResolvedValue(2);

    await expect(harness.service.countUnread(USER_ID)).resolves.toBe(2);

    const where = harness.prisma.notification.count.mock.calls[0]?.[0] as { where: Record<string, unknown> };

    expect(where.where.userId).toBe(USER_ID);
    expect(where.where.readAt).toBeNull();
    expect(JSON.stringify(where.where)).toContain('"not":"CANCELLED"');
  });
});

describe('OTHER_USER_ID 常量', () => {
  it('仅用于构造「他人的通知」场景（防止被误改成当前用户）', () => {
    expect(OTHER_USER_ID).not.toBe(USER_ID);
  });
});
