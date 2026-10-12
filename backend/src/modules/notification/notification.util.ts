/**
 * 通知模块纯逻辑（无 I/O、可 100% 单测）
 *
 * 契约 §3.11；架构 §6.4（`notify.subscribe` 队列）、§3.3（同步/异步边界）。
 *
 * ## 为什么这里有一大堆「派生」字段
 *
 * `notifications` 表（`DATABASE_DESIGN.md` §5.6.7）只存**投递记录**：类型只有
 * `IN_APP` / `SUBSCRIPTION_MESSAGE`（**传输通道**），没有「业务类型」，也没有
 * `expiresAt` / `iconUrl` / `action` 这些列。而契约 §3.11.1 的响应要求业务类型
 * （`REPORT_READY` / `SECURITY_ALERT` …）、过期时间与跳转动作。
 *
 * 因此本文件把这些字段**全部按可解释的规则推导**出来，而不是在 Service 里散落
 * 判断：
 *
 *   · 业务类型 ← `payload.bizType`（白名单内才认）→ 否则按 `idempotencyKey`
 *     前缀（`ban:` / `unban:`，即既有写入方唯一的两个来源）→ 否则 `SYSTEM`
 *   · `expiresAt` ← `createdAt + TTL`（30 天；`SECURITY_ALERT` 180 天，契约规则 2）
 *   · `iconUrl` ← `system_configs.assets.staticDomain` + 类型对应的固定文件名；
 *     域名未配置时返回 `null`，而不是**编造**一个 CDN 地址
 *   · `action` ← 由 `pagePath` 组装，且**必须过白名单**（契约规则 3：不接受服务端
 *     下发任意 URL，防跳转劫持）
 *
 * 派生的代价是「同一份数据在两处的解释必须一致」——所以筛选条件也在本文件里
 * 用同一套规则生成 SQL 片段（见 `buildCategoryClause`）。若只在内存里过滤，
 * 分页的 `total` / `hasNext` 就会建立在被裁剪过的集合上，翻页时出现重复或漏项。
 */

/** 业务通知类型（契约 §3.11.1 的 `type` 枚举，顺序即文档顺序） */
export const NOTIFICATION_CATEGORIES = [
  'SYSTEM',
  'REPORT_READY',
  'RELATIONSHIP',
  'PAYMENT',
  'MEMBERSHIP',
  'SECURITY_ALERT',
  'ACCOUNT_RESTORED',
  'CONTENT_MODERATION',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(NOTIFICATION_CATEGORIES);

export const isNotificationCategory = (value: unknown): value is NotificationCategory =>
  typeof value === 'string' && CATEGORY_SET.has(value);

/** 类型中文名（契约 §3.11.1 的 `typeName`，取值与契约示例一致） */
const CATEGORY_NAMES: Readonly<Record<NotificationCategory, string>> = {
  SYSTEM: '系统通知',
  REPORT_READY: '报告已生成',
  RELATIONSHIP: '关系变动',
  PAYMENT: '支付通知',
  MEMBERSHIP: '会员提醒',
  SECURITY_ALERT: '账号安全提醒',
  ACCOUNT_RESTORED: '账号恢复通知',
  CONTENT_MODERATION: '内容审核通知',
};

export const notificationCategoryName = (category: NotificationCategory): string => CATEGORY_NAMES[category];

/** 图标文件名（`assets.staticDomain` 未配置时整体返回 `null`，见 `buildIconUrl`） */
const CATEGORY_ICON_SLUGS: Readonly<Record<NotificationCategory, string>> = {
  SYSTEM: 'system',
  REPORT_READY: 'report-ready',
  RELATIONSHIP: 'relationship',
  PAYMENT: 'payment',
  MEMBERSHIP: 'membership',
  SECURITY_ALERT: 'security-alert',
  ACCOUNT_RESTORED: 'account-restored',
  CONTENT_MODERATION: 'content-moderation',
};

/**
 * 组装图标地址
 *
 * 域名来自配置（`system_configs.assets.staticDomain`），**未配置时返回 `null`**：
 * 编一个 `https://cdn.example.com/...` 会让前端拿到一个必然 404 的地址，
 * 而失败发生在图片加载层、没有任何日志 —— 这类「静默坏图」比缺少字段更难发现。
 */
export const buildIconUrl = (category: NotificationCategory, staticDomain: string | null): string | null => {
  if (staticDomain === null) return null;

  const trimmed = staticDomain.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return null;

  return `${trimmed}/static/notification/${CATEGORY_ICON_SLUGS[category]}.png`;
};

// ============================================================================
// 业务类型推导
// ============================================================================

/** 已知的 `idempotencyKey` 前缀 → 业务类型（既有写入方目前只有这两个来源） */
const IDEMPOTENCY_PREFIX_CATEGORIES: readonly (readonly [string, NotificationCategory])[] = [
  ['ban:', 'SECURITY_ALERT'],
  ['unban:', 'ACCOUNT_RESTORED'],
];

/** 从 `payload` 读业务类型；只有白名单内的值才被承认（防脏数据污染筛选） */
export const readBizType = (payload: unknown): NotificationCategory | null => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const value = (payload as Record<string, unknown>).bizType;

  return isNotificationCategory(value) ? value : null;
};

/**
 * 推导业务类型
 *
 * 优先级：`payload.bizType`（白名单）→ `idempotencyKey` 前缀 → `SYSTEM`。
 *
 * 注意 `payload.bizType` 优先于前缀：写入方显式声明了业务类型时，它就是权威 ——
 * 否则后续某天用 `ban:` 前缀发一条「会员到期」通知时，会被静默归到安全告警，
 * 用户点进去看到的是账号安全的说明。
 */
export const resolveNotificationCategory = (row: {
  readonly payload: unknown;
  readonly idempotencyKey: string | null;
}): NotificationCategory => {
  const declared = readBizType(row.payload);
  if (declared !== null) return declared;

  const key = row.idempotencyKey;
  if (typeof key === 'string') {
    for (const [prefix, category] of IDEMPOTENCY_PREFIX_CATEGORIES) {
      if (key.startsWith(prefix)) return category;
    }
  }

  return 'SYSTEM';
};

// ============================================================================
// 过期（TTL 为派生值，见文件头说明）
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** 默认保留 30 天（契约规则 2） */
export const NOTIFICATION_TTL_DAYS = 30;

/** 安全提醒保留 180 天（契约规则 2；账号安全类通知必须留够申诉期） */
export const SECURITY_ALERT_TTL_DAYS = 180;

export const notificationTtlDays = (category: NotificationCategory): number =>
  category === 'SECURITY_ALERT' ? SECURITY_ALERT_TTL_DAYS : NOTIFICATION_TTL_DAYS;

/** 过期时间（派生：`createdAt + TTL`） */
export const notificationExpiresAt = (createdAt: Date, category: NotificationCategory): Date =>
  new Date(createdAt.getTime() + notificationTtlDays(category) * DAY_MS);

/** 是否已过期（过期后不再返回，契约规则 2） */
export const isNotificationExpired = (createdAt: Date, category: NotificationCategory, now: Date): boolean =>
  notificationExpiresAt(createdAt, category).getTime() <= now.getTime();

// ============================================================================
// 订阅消息投递状态
// ============================================================================

/** 订阅消息状态（契约规则 4） */
export type SubscribeMsgStatus = 'SENT' | 'NOT_SENT' | 'FAILED';

/**
 * 读取订阅消息投递状态
 *
 * 只有 `SUBSCRIPTION_MESSAGE` 行的 `sentAt` / `status` 能表达「是否已发出」；
 * 站内通知（`IN_APP`）本身不经过微信订阅消息管道，恒为 `NOT_SENT`，
 * 这与契约示例中「站内通知且未发订阅消息」的那条完全一致。
 */
export const resolveSubscribeMsgStatus = (row: {
  readonly type: string;
  readonly status: string;
  readonly sentAt: Date | null;
}): SubscribeMsgStatus => {
  if (row.type !== 'SUBSCRIPTION_MESSAGE') return 'NOT_SENT';
  if (row.status === 'FAILED') return 'FAILED';
  if (row.sentAt !== null && row.status === 'SENT') return 'SENT';

  return 'NOT_SENT';
};

// ============================================================================
// 跳转动作（白名单校验）
// ============================================================================

/**
 * 允许的页面路径前缀
 *
 * 契约规则 3：`action.path` 会被前端**直接跳转**，因此服务端不得下发任意 URL。
 * 这里做的是**结构白名单**：只允许小程序内部页面路径（无协议、无主机名、
 * 无 `..`、无控制字符）。含 `://` 或 `//` 的值会被整体丢弃 ——
 * 否则一条被污染的通知就能把用户带去站外页面（跳转劫持）。
 *
 * 用前缀白名单而不是「仅校验不含 `://`」：后者仍允许
 * `@evil.com/x` 之类的怪值，而小程序 `navigateTo` 对它们的行为依赖具体实现。
 */
const ALLOWED_PAGE_PATH_PREFIXES: readonly string[] = [
  '/pages/',
  'pages/',
  '/pkgMember/',
  'pkgMember/',
  '/pkg/',
  'pkg/',
];

/** 解析出的内部路径与查询参数 */
export interface ParsedMiniAppPath {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

/** 路径最大长度（`page_path` 列为 `VarChar(256)`，解析结果不应超过它） */
const MAX_PAGE_PATH_LENGTH = 256;

/**
 * 解析并校验小程序页面路径
 *
 * 不合法（外链、相对路径跳转、含控制字符、超长）时返回 `null` ——
 * 调用方据此**不下发 `action`**。前端拿不到动作时只会渲染成一张不可点的卡片，
 * 比"点了一下跳到站外"安全得多。
 */
export const parseMiniAppPath = (pagePath: string | null): ParsedMiniAppPath | null => {
  if (typeof pagePath !== 'string') return null;

  const value = pagePath.trim();
  if (value.length === 0 || value.length > MAX_PAGE_PATH_LENGTH) return null;

  // 跳转劫持的三种形态：绝对 URL（`https://`）、协议相对（`//evil`）、
  // 以及小程序 `webview` 跳板（`/pages/webview?url=...` 本身会被下面的
  // 前缀白名单放行，但 url 参数由 `params` 原样返回，前端应自行校验）
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//')) return null;

  // 控制字符与反斜杠（`..\\..\\` 在某些解析器里等价于上一级）
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;

  const [rawPath = '', rawQuery = ''] = value.split('?');
  if (!ALLOWED_PAGE_PATH_PREFIXES.some((prefix) => rawPath.startsWith(prefix))) return null;

  // 目录穿越：`/pages/../../admin` 这类值前缀合法但会跳出去。
  // 小程序运行时对 `..` 的处理各版本不一，因此**在服务端直接拒绝**，
  // 而不是依赖客户端解析器的行为
  if (rawPath.split('/').some((segment) => segment === '..')) return null;

  const params: Record<string, string> = {};
  if (rawQuery.length > 0) {
    for (const pair of rawQuery.split('&')) {
      if (pair.length === 0) continue;

      const separatorIndex = pair.indexOf('=');
      const key = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
      const decodedKey = safeDecode(key);
      if (decodedKey.length === 0) continue;

      // 后出现的同名参数覆盖先出现的：前端 `options` 的解析行为与之一致
      params[decodedKey] = separatorIndex === -1 ? '' : safeDecode(pair.slice(separatorIndex + 1));
    }
  }

  return { path: rawPath, params };
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // 非法百分号编码（如 `%zz`）会让 `decodeURIComponent` 抛错。
    // 一处畸形参数不该让整个列表接口 500，原样返回即可
    return value;
  }
};

/** 通知跳转动作（契约 §3.11.1 的 `action`） */
export interface NotificationActionView {
  readonly type: 'NAVIGATE';
  readonly label: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * 动作按钮文案
 *
 * 表里没有「按钮文案」这一列，因此按**业务类型**给一个中性文案。刻意不用
 * 「查看报告」这类具体文案去猜内容：`pagePath` 是通用路径（既有写入方一律写
 * `/pages/profile/index`），猜错会让按钮写着「去续费」却跳到个人主页。
 */
const CATEGORY_ACTION_LABELS: Readonly<Record<NotificationCategory, string>> = {
  SYSTEM: '查看',
  REPORT_READY: '查看报告',
  RELATIONSHIP: '去查看',
  PAYMENT: '查看订单',
  MEMBERSHIP: '查看会员',
  SECURITY_ALERT: '查看详情',
  ACCOUNT_RESTORED: '查看详情',
  CONTENT_MODERATION: '查看详情',
};

export const buildNotificationAction = (
  pagePath: string | null,
  category: NotificationCategory,
): NotificationActionView | null => {
  const parsed = parseMiniAppPath(pagePath);
  if (parsed === null) return null;

  return { type: 'NAVIGATE', label: CATEGORY_ACTION_LABELS[category], path: parsed.path, params: parsed.params };
};

// ============================================================================
// 关联资源
// ============================================================================

export const RELATED_RESOURCE_TYPES = ['REPORT', 'RELATIONSHIP', 'ORDER', 'MEMBERSHIP', 'TEST_SESSION'] as const;

export type RelatedResourceType = (typeof RELATED_RESOURCE_TYPES)[number];

/** 参数键 → 关联资源类型（`pagePath` 的查询参数与 `payload` 用同一套键名） */
const PARAM_KEY_RESOURCE_TYPES: readonly (readonly [string, RelatedResourceType])[] = [
  ['reportId', 'REPORT'],
  ['relationshipId', 'RELATIONSHIP'],
  ['orderId', 'ORDER'],
  ['membershipId', 'MEMBERSHIP'],
  ['sessionId', 'TEST_SESSION'],
];

export interface RelatedResourceView {
  readonly type: RelatedResourceType;
  readonly id: string;
}

/**
 * 提取关联资源
 *
 * 先看 `payload`（写入方显式给出的事实），再回落到 `pagePath` 的查询参数。
 * 两者都没有时返回 `null`（契约示例里「会员到期提醒」就是 `null`）——
 * 宁可为空，也不要从标题文本里"猜"出一个 ID。
 */
export const buildRelatedResource = (
  payload: unknown,
  action: NotificationActionView | null,
): RelatedResourceView | null => {
  const payloadObject =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;

  for (const [key, type] of PARAM_KEY_RESOURCE_TYPES) {
    const fromPayload = payloadObject?.[key];
    if (typeof fromPayload === 'string' && fromPayload.length > 0) return { type, id: fromPayload };
  }

  for (const [key, type] of PARAM_KEY_RESOURCE_TYPES) {
    const fromPath = action?.params[key];
    if (typeof fromPath === 'string' && fromPath.length > 0) return { type, id: fromPath };
  }

  return null;
};

// ============================================================================
// 列表项组装
// ============================================================================

/** 列表项的输入行（与 Prisma `Notification` 的 select 结果对应） */
export interface NotificationRowLike {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly templateId: string | null;
  readonly title: string | null;
  readonly content: string | null;
  readonly pagePath: string | null;
  readonly payload: unknown;
  readonly idempotencyKey: string | null;
  readonly sentAt: Date | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/** 列表项（契约 §3.11.1 的 `items[]`） */
export interface NotificationItemView {
  readonly notificationId: string;
  readonly type: NotificationCategory;
  readonly typeName: string;
  readonly title: string;
  readonly content: string;
  readonly iconUrl: string | null;
  readonly isRead: boolean;
  readonly readAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly action: NotificationActionView | null;
  readonly relatedResource: RelatedResourceView | null;
  readonly isSubscribeMsgSent: boolean;
  readonly subscribeMsgStatus: SubscribeMsgStatus;
}

/**
 * 组装列表项
 *
 * `title` / `content` 在库里可空（订阅消息行的正文在 `payload` 里，没有渲染后
 * 的文本）。此处回落到空串而不是省略字段：省略会让前端 `item.title` 变成
 * `undefined`，在模板里渲染成字面量「undefined」——空串至少是安静的。
 */
export const toNotificationItem = (row: NotificationRowLike, staticDomain: string | null): NotificationItemView => {
  const category = resolveNotificationCategory(row);
  const action = buildNotificationAction(row.pagePath, category);
  const subscribeMsgStatus = resolveSubscribeMsgStatus(row);

  return {
    notificationId: row.id,
    type: category,
    typeName: notificationCategoryName(category),
    title: row.title ?? '',
    content: row.content ?? '',
    iconUrl: buildIconUrl(category, staticDomain),
    isRead: row.readAt !== null || row.status === 'READ',
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: notificationExpiresAt(row.createdAt, category).toISOString(),
    action,
    relatedResource: buildRelatedResource(row.payload, action),
    isSubscribeMsgSent: subscribeMsgStatus === 'SENT',
    subscribeMsgStatus,
  };
};

// ============================================================================
// 筛选条件的 SQL 片段（与上面的推导规则**必须**一致）
// ============================================================================

/** 白名单业务类型的 JSON 条件（`payload.bizType = X`） */
const bizTypeEquals = (category: NotificationCategory): Record<string, unknown> => ({
  payload: { path: ['bizType'], equals: category },
});

/** `payload.bizType` 为白名单内任一值 */
const anyDeclaredBizType = (): Record<string, unknown> => ({
  OR: NOTIFICATION_CATEGORIES.map((category) => bizTypeEquals(category)),
});

/** `payload.bizType` 非白名单值（含字段缺失） */
const noDeclaredBizType = (): Record<string, unknown> => ({ NOT: anyDeclaredBizType() });

/** 某个前缀规则的 SQL 条件 */
const prefixClause = (prefix: string): Record<string, unknown> => ({ idempotencyKey: { startsWith: prefix } });

/**
 * 单个业务类型的筛选条件（镜像 `resolveNotificationCategory` 的优先级）
 *
 * 这是本文件里**唯一**必须与推导逻辑成对演进的地方：两处一旦不一致，用户会
 * 遇到「筛选 `REPORT_READY` 时某条通知消失，但 `ALL` 里它明明标着 `REPORT_READY`」。
 */
export const buildCategoryClause = (category: NotificationCategory): Record<string, unknown> => {
  const prefixMatches = IDEMPOTENCY_PREFIX_CATEGORIES.filter(([, mapped]) => mapped === category).map(
    ([prefix]) => prefix,
  );

  /**
   * `SYSTEM` 是**兜底类型**，必须显式覆盖两批行：
   *   · 写入方声明了 `payload.bizType = 'SYSTEM'` 的
   *   · 既没声明 bizType、也不命中任何前缀规则的
   *
   * 只写 `bizTypeEquals('SYSTEM')` 会把绝大多数系统通知漏掉 ——
   * 既有的站内通知写入方根本不写 `bizType`。
   */
  if (category === 'SYSTEM') {
    return {
      OR: [
        bizTypeEquals('SYSTEM'),
        {
          AND: [
            noDeclaredBizType(),
            ...IDEMPOTENCY_PREFIX_CATEGORIES.map(([prefix]) => ({ NOT: prefixClause(prefix) })),
          ],
        },
      ],
    };
  }

  // 无前缀兜底的类型：只有显式声明才命中
  if (prefixMatches.length === 0) return bizTypeEquals(category);

  // 既有声明匹配、也有前缀兜底（`ban:` / `unban:`）
  return {
    OR: [
      bizTypeEquals(category),
      { AND: [noDeclaredBizType(), { OR: prefixMatches.map((prefix) => prefixClause(prefix)) }] },
    ],
  };
};

/** 业务类型多选条件；为空时返回 `null`（调用方不加该条件） */
export const buildCategoryFilter = (categories: readonly NotificationCategory[]): Record<string, unknown> | null => {
  if (categories.length === 0) return null;
  if (categories.length === 1) return buildCategoryClause(categories[0]);

  return { OR: categories.map((category) => buildCategoryClause(category)) };
};

/** 未过期条件（TTL 因类型而异，因此必须同时判类型） */
export const buildNotExpiredClause = (now: Date): Record<string, unknown> => ({
  OR: [
    { createdAt: { gt: new Date(now.getTime() - NOTIFICATION_TTL_DAYS * DAY_MS) } },
    {
      AND: [
        buildCategoryClause('SECURITY_ALERT'),
        { createdAt: { gt: new Date(now.getTime() - SECURITY_ALERT_TTL_DAYS * DAY_MS) } },
      ],
    },
  ],
});

// ============================================================================
// 订阅消息授权（契约 §3.11.3）
// ============================================================================

/** 订阅场景（契约 §3.11.3 的 `scene` 枚举） */
export const SUBSCRIPTION_SCENES = [
  'REPORT_READY',
  'RELATIONSHIP_INVITE',
  'RELATIONSHIP_CONFIRMED',
  'MEMBERSHIP_EXPIRING',
  'DELETION_REMINDER',
  'PAYMENT_RESULT',
] as const;

export type SubscriptionScene = (typeof SUBSCRIPTION_SCENES)[number];

/** 用户选择结果（契约 §3.11.3 的 `result` 枚举） */
export const SUBSCRIPTION_RESULTS = ['ACCEPT', 'REJECT', 'BAN'] as const;

export type SubscriptionResult = (typeof SUBSCRIPTION_RESULTS)[number];

/** 一次 `ACCEPT` 授予的配额（微信订阅消息为一次性授权，契约背景说明） */
export const SUBSCRIPTION_GRANTED_QUOTA = 1;

/** 授权有效期（契约示例 `expiresAt = subscribedAt + 30 天`） */
export const SUBSCRIPTION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 每个场景的下一步提示（契约 §3.11.3 的 `nextSendHint`） */
const NEXT_SEND_HINTS: Readonly<Record<SubscriptionScene, string>> = {
  REPORT_READY: '生成报告完成时会发送 1 条提醒',
  RELATIONSHIP_INVITE: '收到新的关系邀请时会发送 1 条提醒',
  RELATIONSHIP_CONFIRMED: '对方确认关系时会发送 1 条提醒',
  MEMBERSHIP_EXPIRING: '会员即将到期时会发送 1 条提醒',
  DELETION_REMINDER: '账号注销冷静期结束前会发送 1 条提醒',
  PAYMENT_RESULT: '支付结果确认后会发送 1 条提醒',
};

export const nextSendHint = (scene: SubscriptionScene): string => NEXT_SEND_HINTS[scene];

/** 契约 §3.11.3 响应里的固定合规提示 */
export const SUBSCRIPTION_NOTICE = '订阅消息为一次性授权，每授权一次可接收一条对应场景的消息。';

/**
 * `system_configs` 里权威模板 ID 的键名
 *
 * 契约规则 3 要求「服务端用 `scene` 映射权威 `templateId`」。项目里没有
 * `notify.*` 配置目录项，因此这里读**库中该键**（`SystemConfigService.getEntry`
 * 会返回目录之外的键）；库里没有时才回落到客户端上报值并记告警。
 */
export const sceneTemplateConfigKey = (scene: SubscriptionScene): string => `notify.template.${scene}`;

/** Redis 配额键的后缀（契约规则 4：`sm:sub:quota:{userId}:{scene}`） */
export const SUBSCRIPTION_QUOTA_KEY_PARTS = ['sub', 'quota'] as const;

/** 客户端请求 ID 的留存键（仅用于审计与去重，无表可落） */
export const SUBSCRIPTION_REQUEST_KEY_PARTS = ['sub', 'request'] as const;

/** 一条授权记录（落 Redis 的结构） */
export interface SubscriptionRecord {
  readonly scene: SubscriptionScene;
  readonly templateId: string;
  readonly result: SubscriptionResult;
  readonly grantedQuota: number;
  readonly remainingQuota: number;
  /** `ACCEPT` 才有值；`REJECT` / `BAN` 为 `null` */
  readonly subscribedAt: string | null;
  readonly expiresAt: string | null;
  readonly clientRequestId: string | null;
}

/**
 * 由一次上报结果构造记录
 *
 * `REJECT` / `BAN` 同样要落库（契约规则 5：30 天内不再请求该场景授权），
 * 因此它们的 `remainingQuota` 为 0 但记录**必须存在** —— 只记 `ACCEPT`
 * 会让服务端无法区分「用户拒绝过」与「从未问过」，于是每次都会再弹一次授权框，
 * 这正是契约要避免的骚扰。
 */
export const buildSubscriptionRecord = (input: {
  readonly scene: SubscriptionScene;
  readonly templateId: string;
  readonly result: SubscriptionResult;
  readonly clientRequestId: string | null;
  readonly now: Date;
}): SubscriptionRecord => {
  if (input.result !== 'ACCEPT') {
    return {
      scene: input.scene,
      templateId: input.templateId,
      result: input.result,
      grantedQuota: 0,
      remainingQuota: 0,
      subscribedAt: null,
      expiresAt: null,
      clientRequestId: input.clientRequestId,
    };
  }

  return {
    scene: input.scene,
    templateId: input.templateId,
    result: input.result,
    grantedQuota: SUBSCRIPTION_GRANTED_QUOTA,
    remainingQuota: SUBSCRIPTION_GRANTED_QUOTA,
    subscribedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + SUBSCRIPTION_TTL_SECONDS * 1000).toISOString(),
    clientRequestId: input.clientRequestId,
  };
};

/** 幂等：同 `templateId` 重复上报覆盖结果，因此不做累加（契约 §3.11.3 的幂等说明） */
export const buildSubscriptionItemView = (record: SubscriptionRecord): Record<string, unknown> => ({
  scene: record.scene,
  templateId: record.templateId,
  result: record.result,
  grantedQuota: record.grantedQuota,
  remainingQuota: record.remainingQuota,
  subscribedAt: record.subscribedAt,
  expiresAt: record.expiresAt,
  nextSendHint: nextSendHint(record.scene),
});

/** `allScenes` 里的一项 */
export const buildSceneSummary = (
  scene: SubscriptionScene,
  record: SubscriptionRecord | null,
): Record<string, unknown> => ({
  scene,
  // 库中无权威模板时，未授权的场景没有已知模板 ID，返回 null 而不是编造
  templateId: record?.templateId ?? null,
  isSubscribed: record !== null && record.remainingQuota > 0,
  remainingQuota: record?.remainingQuota ?? 0,
});
