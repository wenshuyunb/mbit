/**
 * 通知纯逻辑测试（契约 §3.11）
 *
 * 三组最重要的主张：
 *   · **业务类型推导与筛选条件是同一套规则** —— 不一致时用户会遇到
 *     「筛选 REPORT_READY 时这条通知消失，但 ALL 里它明明标着 REPORT_READY」
 *   · **跳转路径必须过白名单** —— 契约规则 3 明令不接受服务端下发任意 URL
 *   · **过期 TTL 分类型** —— `SECURITY_ALERT` 保留 180 天，其余 30 天
 */

import {
  NOTIFICATION_CATEGORIES,
  SUBSCRIPTION_GRANTED_QUOTA,
  SUBSCRIPTION_SCENES,
  SUBSCRIPTION_TTL_SECONDS,
  buildCategoryClause,
  buildCategoryFilter,
  buildIconUrl,
  buildNotExpiredClause,
  buildNotificationAction,
  buildRelatedResource,
  buildSceneSummary,
  buildSubscriptionItemView,
  buildSubscriptionRecord,
  isNotificationExpired,
  notificationExpiresAt,
  notificationTtlDays,
  parseMiniAppPath,
  readBizType,
  resolveNotificationCategory,
  resolveSubscribeMsgStatus,
  toNotificationItem,
  type NotificationRowLike,
} from './notification.util';

const NOW = new Date('2026-02-14T18:30:00.000Z');

const row = (overrides: Partial<NotificationRowLike> = {}): NotificationRowLike => ({
  id: '0195f3a2-c1a8-7e20-9f35-5c6d7e8f9a0b',
  type: 'IN_APP',
  status: 'SENT',
  templateId: null,
  title: '你的人格深度报告已生成',
  content: '基于最新的画像（v3），你的 INFJ 深度解读报告已经准备好，快去看看吧。',
  pagePath: '/pages/profile/index',
  payload: null,
  idempotencyKey: null,
  sentAt: new Date('2026-02-14T14:00:52.000Z'),
  readAt: null,
  createdAt: new Date('2026-02-14T14:00:52.000Z'),
  ...overrides,
});

// ============================================================================
// 业务类型推导
// ============================================================================

describe('resolveNotificationCategory', () => {
  it('优先采用 payload.bizType（白名单内）', () => {
    expect(resolveNotificationCategory({ payload: { bizType: 'REPORT_READY' }, idempotencyKey: 'ban:user:1' })).toBe(
      'REPORT_READY',
    );
  });

  it('白名单之外的 bizType 不被承认（回落到前缀规则）', () => {
    expect(readBizType({ bizType: 'NOT_A_CATEGORY' })).toBeNull();
    expect(readBizType({ bizType: 123 })).toBeNull();
    expect(readBizType(null)).toBeNull();
    expect(readBizType(['REPORT_READY'])).toBeNull();
    expect(resolveNotificationCategory({ payload: { bizType: 'NOPE' }, idempotencyKey: 'ban:user:1' })).toBe(
      'SECURITY_ALERT',
    );
  });

  it('既有写入方的 ban: / unban: 前缀分别映射到安全告警与账号恢复', () => {
    expect(resolveNotificationCategory({ payload: { reason: 'SPAM' }, idempotencyKey: 'ban:u:1' })).toBe(
      'SECURITY_ALERT',
    );
    expect(resolveNotificationCategory({ payload: { compensationGranted: true }, idempotencyKey: 'unban:u:1' })).toBe(
      'ACCOUNT_RESTORED',
    );
  });

  it('无任何信号时兜底 SYSTEM', () => {
    expect(resolveNotificationCategory({ payload: null, idempotencyKey: null })).toBe('SYSTEM');
  });
});

describe('筛选条件与推导规则镜像一致', () => {
  it('每个业务类型都能生成一个筛选片段', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(buildCategoryClause(category)).toBeDefined();
    }
  });

  it('SYSTEM 片段必须同时覆盖「显式声明」与「无声明且无前缀」两批行', () => {
    // 只写 bizTypeEquals('SYSTEM') 会把绝大多数系统通知漏掉 —— 既有写入方
    // 根本不写 bizType
    const clause = buildCategoryClause('SYSTEM') as { OR: unknown[] };
    const serialized = JSON.stringify(clause);

    expect(serialized).toContain('"equals":"SYSTEM"');
    expect(serialized).toContain('"startsWith":"ban:"');
    expect(serialized).toContain('"startsWith":"unban:"');
    expect(Array.isArray(clause.OR)).toBe(true);
  });

  it('SECURITY_ALERT 片段同时认「显式声明」与「ban: 前缀」', () => {
    const serialized = JSON.stringify(buildCategoryClause('SECURITY_ALERT'));

    expect(serialized).toContain('"equals":"SECURITY_ALERT"');
    expect(serialized).toContain('"startsWith":"ban:"');
    // 不应把 unban: 也算进安全告警
    expect(serialized).not.toContain('"startsWith":"unban:"');
  });

  it('多选类型生成 OR 组合；空数组返回 null（调用方不加条件）', () => {
    expect(buildCategoryFilter([])).toBeNull();
    expect(buildCategoryFilter(['REPORT_READY'])).toEqual(buildCategoryClause('REPORT_READY'));
    expect(buildCategoryFilter(['REPORT_READY', 'MEMBERSHIP'])).toHaveProperty('OR');
  });
});

// ============================================================================
// 过期（TTL 分类型）
// ============================================================================

describe('通知过期', () => {
  it('默认 TTL 30 天，SECURITY_ALERT 180 天', () => {
    expect(notificationTtlDays('SYSTEM')).toBe(30);
    expect(notificationTtlDays('REPORT_READY')).toBe(30);
    expect(notificationTtlDays('SECURITY_ALERT')).toBe(180);
  });

  it('过期时间 = createdAt + TTL', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');

    expect(notificationExpiresAt(createdAt, 'SYSTEM').toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(notificationExpiresAt(createdAt, 'SECURITY_ALERT').toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it('30 天边界：恰好到期视为已过期（不返回给用户）', () => {
    const createdAt = new Date('2026-01-15T00:00:00.000Z');
    const exactly30DaysLater = new Date('2026-02-14T00:00:00.000Z');

    expect(isNotificationExpired(createdAt, 'SYSTEM', exactly30DaysLater)).toBe(true);
    expect(isNotificationExpired(createdAt, 'SYSTEM', new Date('2026-02-13T23:59:59.000Z'))).toBe(false);
    // 同一条通知对安全告警类型仍未过期
    expect(isNotificationExpired(createdAt, 'SECURITY_ALERT', exactly30DaysLater)).toBe(false);
  });

  it('未过期条件包含「安全告警用 180 天」的分支', () => {
    const serialized = JSON.stringify(buildNotExpiredClause(NOW));

    expect(serialized).toContain('"equals":"SECURITY_ALERT"');
  });
});

// ============================================================================
// 订阅消息状态
// ============================================================================

describe('resolveSubscribeMsgStatus', () => {
  it('站内通知不经订阅消息管道，恒为 NOT_SENT', () => {
    expect(resolveSubscribeMsgStatus({ type: 'IN_APP', status: 'SENT', sentAt: NOW })).toBe('NOT_SENT');
  });

  it('订阅消息行按投递状态判定', () => {
    expect(resolveSubscribeMsgStatus({ type: 'SUBSCRIPTION_MESSAGE', status: 'SENT', sentAt: NOW })).toBe('SENT');
    expect(resolveSubscribeMsgStatus({ type: 'SUBSCRIPTION_MESSAGE', status: 'FAILED', sentAt: null })).toBe('FAILED');
    expect(resolveSubscribeMsgStatus({ type: 'SUBSCRIPTION_MESSAGE', status: 'PENDING', sentAt: null })).toBe(
      'NOT_SENT',
    );
  });
});

// ============================================================================
// 跳转路径白名单
// ============================================================================

describe('parseMiniAppPath（跳转劫持防护）', () => {
  it('接受小程序内部路径，并解析查询参数', () => {
    expect(parseMiniAppPath('/pages/profile/index')).toEqual({ path: '/pages/profile/index', params: {} });
    expect(parseMiniAppPath('pages/report/detail?id=abc&from=msg')).toEqual({
      path: 'pages/report/detail',
      params: { id: 'abc', from: 'msg' },
    });
  });

  it('拒绝绝对 URL 与协议相对 URL', () => {
    expect(parseMiniAppPath('https://evil.example.com/x')).toBeNull();
    expect(parseMiniAppPath('//evil.example.com/x')).toBeNull();
    expect(parseMiniAppPath('/pages/https://evil/x')).toBeNull();
  });

  it('拒绝目录穿越、控制字符与超长路径', () => {
    expect(parseMiniAppPath('/pages/../../etc/passwd')).toBeNull();
    // 前缀不在白名单内（即使不含遍历序列）
    expect(parseMiniAppPath('/admin/users')).toBeNull();
    expect(parseMiniAppPath(`/pages/${'a'.repeat(300)}`)).toBeNull();
  });

  it('非法百分号编码不会抛错（原样保留）', () => {
    expect(parseMiniAppPath('/pages/x?a=%zz')).toEqual({ path: '/pages/x', params: { a: '%zz' } });
  });

  it('空值与非法类型返回 null', () => {
    expect(parseMiniAppPath(null)).toBeNull();
    expect(parseMiniAppPath('')).toBeNull();
    expect(parseMiniAppPath('   ')).toBeNull();
  });
});

describe('buildNotificationAction', () => {
  it('按钮文案按业务类型给出，路径非法时不下发动作', () => {
    expect(buildNotificationAction('/pages/profile/index', 'REPORT_READY')).toEqual({
      type: 'NAVIGATE',
      label: '查看报告',
      path: '/pages/profile/index',
      params: {},
    });
    expect(buildNotificationAction('https://evil.example.com', 'SYSTEM')).toBeNull();
    expect(buildNotificationAction(null, 'SYSTEM')).toBeNull();
  });
});

// ============================================================================
// 关联资源
// ============================================================================

describe('buildRelatedResource', () => {
  it('优先取 payload，其次回落到 pagePath 参数', () => {
    expect(buildRelatedResource({ reportId: 'r-1' }, null)).toEqual({ type: 'REPORT', id: 'r-1' });
    expect(
      buildRelatedResource(null, {
        type: 'NAVIGATE',
        label: '去查看',
        path: '/pages/match/result',
        params: { relationshipId: 'rel-1' },
      }),
    ).toEqual({ type: 'RELATIONSHIP', id: 'rel-1' });
  });

  it('两者都没有时返回 null（契约示例里「会员提醒」就是 null）', () => {
    expect(buildRelatedResource(null, null)).toBeNull();
    expect(buildRelatedResource({ reason: 'SPAM' }, null)).toBeNull();
  });

  it('不从标题文本猜 ID（只有显式字段才算）', () => {
    expect(buildRelatedResource({ title: '报告 0195f3a2 已生成' }, null)).toBeNull();
  });
});

// ============================================================================
// 图标
// ============================================================================

describe('buildIconUrl', () => {
  it('域名未配置时返回 null（不编造 CDN 地址）', () => {
    expect(buildIconUrl('REPORT_READY', null)).toBeNull();
    expect(buildIconUrl('REPORT_READY', '')).toBeNull();
    expect(buildIconUrl('REPORT_READY', '   ')).toBeNull();
  });

  it('配置了域名时拼接固定文件名，并去掉重复斜杠', () => {
    expect(buildIconUrl('REPORT_READY', 'https://cdn.example.com/')).toBe(
      'https://cdn.example.com/static/notification/report-ready.png',
    );
  });
});

// ============================================================================
// 列表项组装
// ============================================================================

describe('toNotificationItem', () => {
  it('字段对齐既有写入方（admin 封禁通知）', () => {
    const item = toNotificationItem(
      row({
        payload: { reason: 'SPAM', banType: 'PERMANENT', expiresAt: null },
        idempotencyKey: 'ban:u:1',
      }),
      'https://cdn.example.com',
    );

    expect(item.notificationId).toBe('0195f3a2-c1a8-7e20-9f35-5c6d7e8f9a0b');
    expect(item.type).toBe('SECURITY_ALERT');
    expect(item.typeName).toBe('账号安全提醒');
    expect(item.title).toBe('你的人格深度报告已生成');
    expect(item.isRead).toBe(false);
    expect(item.readAt).toBeNull();
    expect(item.createdAt).toBe('2026-02-14T14:00:52.000Z');
    // 安全告警保留 180 天（不是默认的 30 天）
    expect(item.expiresAt).toBe('2026-08-13T14:00:52.000Z');
    expect(item.isSubscribeMsgSent).toBe(false);
    expect(item.subscribeMsgStatus).toBe('NOT_SENT');
    expect(item.relatedResource).toBeNull();
    expect(item.action?.path).toBe('/pages/profile/index');
  });

  it('普通系统通知按 30 天 TTL 计算过期时间', () => {
    const item = toNotificationItem(row({ payload: null, idempotencyKey: null }), null);

    expect(item.type).toBe('SYSTEM');
    expect(item.expiresAt).toBe('2026-03-16T14:00:52.000Z');
  });

  it('status = READ 也算已读（兼容其它写入方）', () => {
    expect(toNotificationItem(row({ status: 'READ' }), null).isRead).toBe(true);
    expect(toNotificationItem(row({ status: 'READ' }), null).readAt).toBeNull();
  });

  it('title / content 为 null 时回落空串（避免前端渲染出 undefined）', () => {
    const item = toNotificationItem(row({ title: null, content: null }), null);

    expect(item.title).toBe('');
    expect(item.content).toBe('');
  });
});

// ============================================================================
// 订阅授权
// ============================================================================

describe('订阅授权记录', () => {
  it('ACCEPT 授予 1 次配额并给出 30 天有效期', () => {
    const record = buildSubscriptionRecord({
      scene: 'REPORT_READY',
      templateId: 'TMPL_REPORT_READY',
      result: 'ACCEPT',
      clientRequestId: 'sub_req_1',
      now: NOW,
    });

    expect(record.grantedQuota).toBe(SUBSCRIPTION_GRANTED_QUOTA);
    expect(record.remainingQuota).toBe(1);
    expect(record.subscribedAt).toBe('2026-02-14T18:30:00.000Z');
    expect(record.expiresAt).toBe('2026-03-16T18:30:00.000Z');
    expect(new Date(record.expiresAt as string).getTime() - NOW.getTime()).toBe(SUBSCRIPTION_TTL_SECONDS * 1000);

    const item = buildSubscriptionItemView(record);

    expect(item).toMatchObject({
      scene: 'REPORT_READY',
      result: 'ACCEPT',
      grantedQuota: 1,
      remainingQuota: 1,
      nextSendHint: '生成报告完成时会发送 1 条提醒',
    });
  });

  it('REJECT / BAN 记 0 配额但仍落记录（否则会反复弹授权框）', () => {
    for (const result of ['REJECT', 'BAN'] as const) {
      const record = buildSubscriptionRecord({
        scene: 'MEMBERSHIP_EXPIRING',
        templateId: 'TMPL_MEMBERSHIP',
        result,
        clientRequestId: null,
        now: NOW,
      });

      expect(record.grantedQuota).toBe(0);
      expect(record.remainingQuota).toBe(0);
      expect(record.subscribedAt).toBeNull();
      expect(record.expiresAt).toBeNull();
      expect(record.result).toBe(result);
    }
  });

  it('allScenes 汇总：无记录时不可订阅、配额 0、模板为 null', () => {
    expect(buildSceneSummary('DELETION_REMINDER', null)).toEqual({
      scene: 'DELETION_REMINDER',
      templateId: null,
      isSubscribed: false,
      remainingQuota: 0,
    });

    const record = buildSubscriptionRecord({
      scene: 'DELETION_REMINDER',
      templateId: 'TMPL_DELETION',
      result: 'ACCEPT',
      clientRequestId: null,
      now: NOW,
    });

    expect(buildSceneSummary('DELETION_REMINDER', record)).toEqual({
      scene: 'DELETION_REMINDER',
      templateId: 'TMPL_DELETION',
      isSubscribed: true,
      remainingQuota: 1,
    });
  });

  it('六个场景都有下一步提示（枚举全覆盖，避免前端出现空文案）', () => {
    for (const scene of SUBSCRIPTION_SCENES) {
      const record = buildSubscriptionRecord({
        scene,
        templateId: 'TMPL_X',
        result: 'ACCEPT',
        clientRequestId: null,
        now: NOW,
      });
      const item = buildSubscriptionItemView(record);

      expect(typeof item.nextSendHint).toBe('string');
      expect((item.nextSendHint as string).length).toBeGreaterThan(0);
    }
  });
});
