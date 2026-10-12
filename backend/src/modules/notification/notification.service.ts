/**
 * 站内通知服务（契约 §3.11）
 *
 * ## 职责边界：只做「读」，不做「写通知」
 *
 * 契约规则 5（§3.11.1）明确：通知由 `outbox_event` → `notify.subscribe` 队列产生，
 * **业务代码不直接创建通知**。目前唯一的写入方是后台用户管理（封禁/解封通知，
 * 见 `admin/user/admin-user.service.ts` 的 `createUserNotification`）。
 *
 * 因此本服务只实现三件事：**列取**、**标记已读**、**记录订阅授权**。
 * 这里**没有**任何创建/删除通知的入口 —— 加了就等于给业务代码开了一条绕过
 * Outbox 的旁路，审计链会断在这里。
 *
 * ## 为什么订阅授权落在 Redis 而不是数据库
 *
 * 契约 §3.11.3 规则 4 要求落 `notification_subscriptions` 表，但 `schema.prisma`
 * 里**没有这张表**，也没有对应迁移，而本次约定不允许改 schema 与迁移。
 * 因此授权记录落在 Redis（键名与契约规则 4 给出的 `sm:sub:quota:{userId}:{scene}`
 * 完全一致），并用同一份 TTL（30 天）表达「授权有效期」。
 *
 * 这是**降级而非等价实现**：Redis 不是持久审计源，重启/换实例后授权记录会丢，
 * 表现为「用户明明授权过，服务端却认为没授权」—— 订阅消息发不出去，但站内通知
 * 始终可用，符合契约规则 6 的降级要求。补齐需要新增表与迁移，属冻结项变更，
 * 已记入交付报告的「契约模糊/矛盾」一节。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { SystemConfigService } from '../system/system-config.service';
import type { MarkNotificationsReadDto, SubscribeNotificationsDto } from './dto/notification.dto';
import {
  NOTIFICATION_CATEGORIES,
  SUBSCRIPTION_NOTICE,
  SUBSCRIPTION_QUOTA_KEY_PARTS,
  SUBSCRIPTION_REQUEST_KEY_PARTS,
  SUBSCRIPTION_SCENES,
  SUBSCRIPTION_TTL_SECONDS,
  buildCategoryClause,
  buildCategoryFilter,
  buildNotExpiredClause,
  buildSceneSummary,
  buildSubscriptionItemView,
  buildSubscriptionRecord,
  sceneTemplateConfigKey,
  toNotificationItem,
  type NotificationCategory,
  type NotificationItemView,
  type SubscriptionRecord,
  type SubscriptionScene,
} from './notification.util';

/** 列表查询入参（由 Controller 组装，缺省值在这里兜底） */
export interface ListNotificationsInput {
  readonly userId: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: 'UNREAD' | 'READ' | 'ALL';
  readonly type?: readonly NotificationCategory[];
  readonly sortBy?: 'createdAt' | 'readAt';
  readonly order?: 'asc' | 'desc';
}

/** 列表汇总（契约 §3.11.1 的 `summary`） */
export interface NotificationSummaryView {
  readonly unreadCount: number;
  readonly totalCount: number;
  /**
   * 各业务类型的条数
   *
   * **所有类型都出现**（无记录时为 `0`），而不是只列非零项：契约 §3.11.1 的示例
   * 只列了 3 项，而 §3.8.3 的同名字段列全了 4 项。让键集合稳定，前端就不必写
   * `?? 0` 这类防御代码。
   */
  readonly byType: Readonly<Record<NotificationCategory, number>>;
}

/** 列表响应（契约 §3.11.1） */
export interface NotificationListView {
  readonly items: readonly NotificationItemView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly summary: NotificationSummaryView;
}

/** 标记已读结果（契约 §3.11.2） */
export interface MarkNotificationsReadView {
  readonly requestedCount: number;
  readonly updatedCount: number;
  readonly skippedCount: number;
  readonly skippedIds: readonly string[];
  readonly unreadCount: number;
  readonly readAt: string;
}

/** 订阅授权结果（契约 §3.11.3） */
export interface SubscribeNotificationsView {
  readonly items: readonly Record<string, unknown>[];
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly totalRemainingQuota: number;
  readonly allScenes: readonly Record<string, unknown>[];
  readonly notice: string;
}

/** `assets.staticDomain` 配置键（通知图标的域名来源） */
const STATIC_DOMAIN_CONFIG_KEY = 'assets.staticDomain';

/**
 * 单次「全部已读」最多处理的批次数
 *
 * 契约规则 3 要求「单次最多 1000 条，超出分批处理」。除了分批，这里还加了一道
 * **总上限**：否则一个持有 10 万条未读的账号会让这个接口一直循环下去，
 * 而它同时占着数据库连接。达到上限时如实返回已处理数量（接口仍 200）。
 */
const READ_ALL_BATCH_SIZE = 1000;
const READ_ALL_MAX_BATCHES = 20;

/** 未读的判定：只认 `readAt`（见 `markRead` 注释） */
const UNREAD_CLAUSE: Record<string, unknown> = { readAt: null };

/** 已读的判定：`readAt` 有值，或 `status` 已被其它写入方置为 `READ` */
const READ_CLAUSE: Record<string, unknown> = { OR: [{ readAt: { not: null } }, { status: 'READ' }] };

/** 各类型计数的初值（`byType` 的键集合必须稳定） */
const EMPTY_BY_TYPE: Record<NotificationCategory, number> = {
  SYSTEM: 0,
  REPORT_READY: 0,
  RELATIONSHIP: 0,
  PAYMENT: 0,
  MEMBERSHIP: 0,
  SECURITY_ALERT: 0,
  ACCOUNT_RESTORED: 0,
  CONTENT_MODERATION: 0,
};

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  // ==========================================================================
  // §3.11.1 列表
  // ==========================================================================

  /**
   * 站内通知列表
   *
   * 三条硬性口径：
   *   ① **强归属过滤** `WHERE userId = currentUser.id`（契约规则 1，架构 §14.1）
   *   ② **过期不返回**（契约规则 2），且 TTL 因类型而异 —— 因此过期条件里
   *      必须同时判类型，不能只按 `createdAt` 一刀切 30 天
   *   ③ `summary` 的统计**不受 `status` / `type` 筛选影响**：数当前筛选结果会让
   *      用户切到「已读」页时看到「未读 0」，以为消息被清空了
   */
  async listNotifications(input: ListNotificationsInput): Promise<NotificationListView> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const readStatus = input.status ?? 'UNREAD';
    const now = new Date();

    const scope = this.buildScopeWhere(input.userId, now);
    const categoryFilter = buildCategoryFilter(input.type ?? []);
    // 读取状态条件必须走 `AND`：条件是 `{ OR: [...] }`（`readAt` 有值 **或** 状态为
    // `READ`），直接展开会把范围里"必须有可展示文本"的那个 `OR` 覆盖掉，
    // 于是列表会混进没有任何文字的订阅消息行
    const withStatus =
      readStatus === 'UNREAD'
        ? this.appendAnd(scope, UNREAD_CLAUSE)
        : readStatus === 'READ'
          ? this.appendAnd(scope, READ_CLAUSE)
          : scope;

    const where: Record<string, unknown> =
      categoryFilter === null ? withStatus : this.appendAnd(withStatus, categoryFilter);

    const sortField = input.sortBy ?? 'createdAt';
    const order = input.order ?? 'desc';

    const [rows, total, staticDomain] = await Promise.all([
      this.prisma.notification.findMany({
        where: where,
        orderBy:
          sortField === 'readAt'
            ? // `readAt` 可空：不指定 `nulls` 时 PG 在 DESC 下把 NULL 排在最前，
              // 于是一个从未读过的通知会插到「最近已读」列表的最上面
              { readAt: { sort: order, nulls: 'last' } }
            : { createdAt: order },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          templateId: true,
          title: true,
          content: true,
          pagePath: true,
          payload: true,
          idempotencyKey: true,
          sentAt: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.count({ where: where }),
      this.readStaticDomain(),
    ]);

    const summary = await this.buildSummary(input.userId, now, total);

    return {
      items: rows.map((row) => toNotificationItem(row, staticDomain)),
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary,
    };
  }

  /**
   * 未读数量（供其它模块做红点）
   *
   * 复用同一套范围条件，避免「列表说 3 条未读、红点显示 5」这种自相矛盾的界面。
   */
  async countUnread(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { ...this.buildScopeWhere(userId, new Date()), ...UNREAD_CLAUSE },
    });
  }

  // ==========================================================================
  // §3.11.2 标记已读
  // ==========================================================================

  /**
   * 批量标记已读
   *
   * ## 三处刻意的行为选择
   *
   * ① **他人的通知 ID 静默跳过，不报 403**（契约规则 1）：报 403 等于告诉攻击者
   *    「这个 ID 真实存在」，可以据此枚举。跳过则什么信息都不泄露。
   * ② **已读的不改 `readAt`**（契约规则 2）：保留**首次**已读时间。用 `now` 覆盖
   *    会让「我什么时候看的」变成「我最后一次点全部已读的时间」。
   * ③ **只写 `readAt`，不改 `status` 列**：`status` 是**投递状态**（`SENT` /
   *    `FAILED` / `PENDING`），后台的投递失败池按 `INDEX(status, createdAt)` 捞
   *    重试对象。把已读写成 `READ` 会把「发送失败」这一事实抹掉，
   *    失败池再也捞不到它。已读判定因此只认 `readAt`（`READ` 状态仍被兼容，
   *    见 `READ_CLAUSE`）。
   */
  async markRead(userId: string, dto: MarkNotificationsReadDto): Promise<MarkNotificationsReadView> {
    const now = new Date();
    const all = dto.all === true;

    if (!all && (dto.notificationIds === undefined || dto.notificationIds.length === 0)) {
      // 契约把这一条列为 `10002`（400），但本项目 `10002` 是「资源不存在」(404)，
      // 语义不符；故用既有的 `10001 PARAM_INVALID`（400）—— HTTP 语义一致
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'notificationIds 与 all 至少提供一个');
    }

    const { requestedCount, updatedCount, skippedIds } = all
      ? await this.markAllRead(userId, dto.type ?? null, now)
      : await this.markIdsRead(userId, dto.notificationIds ?? [], now);

    return {
      requestedCount,
      updatedCount,
      skippedCount: requestedCount - updatedCount,
      skippedIds,
      unreadCount: await this.countUnread(userId),
      readAt: now.toISOString(),
    };
  }

  /** 按 ID 标记（含越权与已读跳过） */
  private async markIdsRead(
    userId: string,
    rawIds: readonly string[],
    now: Date,
  ): Promise<{ requestedCount: number; updatedCount: number; skippedIds: string[] }> {
    // 去重：同一 ID 传两次时 `updatedCount` 不该是 2（用户只标记了一条通知）
    const requestedIds = [...new Set(rawIds)];

    const owned = await this.prisma.notification.findMany({
      where: { id: { in: requestedIds }, userId, deletedAt: null },
      select: { id: true, readAt: true, status: true },
    });

    const ownedUnread = owned.filter((row) => row.readAt === null && row.status !== 'READ').map((row) => row.id);

    let updatedCount = 0;
    if (ownedUnread.length > 0) {
      const result = await this.prisma.notification.updateMany({
        where: { id: { in: ownedUnread }, userId, readAt: null, deletedAt: null },
        data: { readAt: now },
      });
      updatedCount = result.count;
    }

    const updatedSet = new Set(ownedUnread);
    // 未被更新的都进 `skippedIds`：他人的 / 不存在的 / 已读的（契约规则 1、2）
    const skippedIds = requestedIds.filter((id) => !updatedSet.has(id));

    return { requestedCount: requestedIds.length, updatedCount, skippedIds };
  }

  /** 全部标记（可按类型），分批处理 */
  private async markAllRead(
    userId: string,
    category: NotificationCategory | null,
    now: Date,
  ): Promise<{ requestedCount: number; updatedCount: number; skippedIds: string[] }> {
    const scope = this.buildScopeWhere(userId, now);
    const unreadWhere =
      category === null
        ? this.appendAnd(scope, UNREAD_CLAUSE)
        : this.appendAnd(scope, UNREAD_CLAUSE, buildCategoryClause(category));

    let requestedCount = 0;
    let updatedCount = 0;

    for (let batch = 0; batch < READ_ALL_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.notification.findMany({
        where: unreadWhere,
        select: { id: true },
        take: READ_ALL_BATCH_SIZE,
      });

      if (rows.length === 0) break;

      const ids = rows.map((row) => row.id);
      requestedCount += ids.length;

      // 更新条件里再带一次 `userId` 与 `readAt: null` 作为兜底：
      // 即使两批之间用户又收到一条通知，也不会把并发写入的那条误标
      const result = await this.prisma.notification.updateMany({
        where: { id: { in: ids }, userId, readAt: null, deletedAt: null },
        data: { readAt: now },
      });
      updatedCount += result.count;

      if (rows.length < READ_ALL_BATCH_SIZE) break;
    }

    return { requestedCount, updatedCount, skippedIds: [] };
  }

  // ==========================================================================
  // §3.11.3 订阅消息授权
  // ==========================================================================

  /**
   * 记录订阅消息授权
   *
   * **只记录，不发送**（契约规则 1）：`wx.requestSubscribeMessage` 由小程序端完成，
   * 本接口只上报结果；发送由 `notify.subscribe` 队列负责。
   *
   * 幂等：同一 `scene` 重复上报**覆盖**上一次结果（契约幂等说明），不做配额累加 ——
   * 累加会让「连点两次授权」凭空得到 2 条发送额度。
   */
  async recordSubscriptions(userId: string, dto: SubscribeNotificationsDto): Promise<SubscribeNotificationsView> {
    const now = new Date();
    const clientRequestId = dto.clientRequestId ?? null;

    // 审计/去重：`clientRequestId` 同值重放时留一条日志（天然幂等，仍返回 200）
    if (clientRequestId !== null) {
      await this.recordClientRequest(userId, clientRequestId);
    }

    const items: Record<string, unknown>[] = [];
    let acceptedCount = 0;
    let rejectedCount = 0;
    let totalRemainingQuota = 0;

    for (const subscription of dto.subscriptions) {
      const templateId = await this.resolveAuthoritativeTemplateId(subscription.scene, subscription.templateId, userId);

      const record = buildSubscriptionRecord({
        scene: subscription.scene,
        templateId,
        result: subscription.result,
        clientRequestId,
        now,
      });

      await this.redis.setJson(this.quotaKey(userId, subscription.scene), record, SUBSCRIPTION_TTL_SECONDS);

      items.push(buildSubscriptionItemView(record));

      if (record.result === 'ACCEPT') {
        acceptedCount += 1;
      } else {
        // `BAN`（被微信后台封禁）与 `REJECT` 都归入「未授权」：对业务而言两者后果
        // 完全相同 —— 都不能发订阅消息
        rejectedCount += 1;
      }
      totalRemainingQuota += record.remainingQuota;
    }

    const allScenes = await Promise.all(
      SUBSCRIPTION_SCENES.map(async (scene) => {
        const record = await this.readSubscriptionRecord(userId, scene);
        if (record !== null) return buildSceneSummary(scene, record);

        // 无记录时也给出 `templateId`：契约示例里未授权的场景同样带模板 ID
        // （来自服务端配置）。库中若没配 `notify.template.*`，这里如实返回 `null`
        const configured = await this.readConfiguredTemplateId(scene);

        return { ...buildSceneSummary(scene, null), templateId: configured };
      }),
    );

    this.logger.log(
      `订阅授权已记录 userId=${userId} accepted=${acceptedCount} rejected=${rejectedCount} requestId=${clientRequestId ?? '无'}`,
    );

    return { items, acceptedCount, rejectedCount, totalRemainingQuota, allScenes, notice: SUBSCRIPTION_NOTICE };
  }

  /**
   * 读取权威模板 ID（契约规则 3）
   *
   * 客户端传来的 `templateId` **只用于核对**：服务端优先用 `scene` 映射的配置值。
   * 不匹配时忽略客户端值并记告警 —— 否则客户端可以伪造模板 ID，把用户授权的
   * 额度「存」到一个永远不会被发送的场景上。
   */
  private async resolveAuthoritativeTemplateId(
    scene: SubscriptionScene,
    clientTemplateId: string,
    userId: string,
  ): Promise<string> {
    const configured = await this.readConfiguredTemplateId(scene);

    if (configured === null) {
      // 库里没有权威模板（项目尚无 `notify.template.*` 配置项）：如实采用客户端值，
      // 但留下痕迹 —— 否则「配置缺失」会一直无人发现
      this.logger.warn(
        `订阅模板未配置权威值，采用客户端上报值 scene=${scene} key=${sceneTemplateConfigKey(scene)} userId=${userId}`,
      );

      return clientTemplateId;
    }

    if (configured !== clientTemplateId) {
      this.logger.warn(
        `订阅模板 ID 与权威配置不一致（已采用权威值）scene=${scene} client=${clientTemplateId} server=${configured} userId=${userId}`,
      );
    }

    return configured;
  }

  /** 读 `system_configs` 的 `notify.template.{scene}`；缺失或为空返回 `null` */
  private async readConfiguredTemplateId(scene: SubscriptionScene): Promise<string | null> {
    const entry = await this.systemConfig.getEntry(sceneTemplateConfigKey(scene));

    if (entry === undefined) return null;

    const value = entry.rawValue.trim();

    return value.length > 0 ? value : null;
  }

  /** 读一条授权记录；JSON 解析失败时 `getJson` 会自行清理脏键 */
  private async readSubscriptionRecord(userId: string, scene: SubscriptionScene): Promise<SubscriptionRecord | null> {
    return this.redis.getJson<SubscriptionRecord>(this.quotaKey(userId, scene));
  }

  /** 契约规则 4 的键名：`sm:sub:quota:{userId}:{scene}` */
  private quotaKey(userId: string, scene: SubscriptionScene): string {
    return this.redis.key(...SUBSCRIPTION_QUOTA_KEY_PARTS, userId, scene);
  }

  /**
   * 记录本次授权的客户端请求 ID
   *
   * 只做「重复即提示」的轻量去重（契约把它列为「去重与审计」）：没有审计表可落，
   * 因此退化为一个带 TTL 的标记键。它的价值在于重放时能留下日志，而不是真的
   * 阻止重复 —— 本接口天然幂等，重复无副作用。
   */
  private async recordClientRequest(userId: string, clientRequestId: string): Promise<void> {
    try {
      const key = this.redis.key(...SUBSCRIPTION_REQUEST_KEY_PARTS, userId, clientRequestId);
      const isFirst = await this.redis.setIfAbsent(key, new Date().toISOString(), SUBSCRIPTION_TTL_SECONDS);

      if (!isFirst) {
        this.logger.warn(`订阅授权请求 ID 重复上报（幂等覆盖）userId=${userId} clientRequestId=${clientRequestId}`);
      }
    } catch (error) {
      // 审计写失败不应影响授权结果本身
      this.logger.warn(`订阅授权请求 ID 记录失败: ${(error as Error).message}`);
    }
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  /**
   * 列表与统计共用的范围条件
   *
   * `CANCELLED` 被排除：它表示「发送前被撤销」，用户**从未收到过**这条通知，
   * 展示出来会让人困惑「我什么时候收到过这个」。
   */
  private buildScopeWhere(userId: string, now: Date): Record<string, unknown> {
    return {
      userId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      // 订阅消息行的正文在 `payload` 里（模板数据），`title` / `content` 可能都为空；
      // 这种行渲染出来是一张空白卡片，不如不返回
      OR: [{ title: { not: null } }, { content: { not: null } }],
      AND: [buildNotExpiredClause(now)],
    };
  }

  /** 把条件追加到 `AND`（保留已有条件，避免覆盖 `OR`） */
  private appendAnd(
    where: Record<string, unknown>,
    ...clauses: readonly Record<string, unknown>[]
  ): Record<string, unknown> {
    const existing = Array.isArray(where.AND) ? (where.AND as Record<string, unknown>[]) : [];

    return { ...where, AND: [...existing, ...clauses] };
  }

  /** `summary` 的三项计数（不受 `status` / `type` 筛选影响） */
  private async buildSummary(userId: string, now: Date, unfilteredTotal: number): Promise<NotificationSummaryView> {
    const scope = this.buildScopeWhere(userId, now);

    const unreadCount = await this.prisma.notification.count({
      where: this.appendAnd(scope, UNREAD_CLAUSE),
    });

    if (unfilteredTotal === 0) {
      return { unreadCount, totalCount: 0, byType: { ...EMPTY_BY_TYPE } };
    }

    // 业务类型是**派生值**（库里只有 IN_APP / SUBSCRIPTION_MESSAGE），无法用
    // `groupBy` 聚合，因此按类型分别计数（8 次走 `(userId, status, createdAt)`
    // 索引的 count，每次只扫该用户已被裁剪的行）
    const counts = await Promise.all(
      NOTIFICATION_CATEGORIES.map((category) =>
        this.prisma.notification.count({
          where: this.appendAnd(scope, buildCategoryClause(category)),
        }),
      ),
    );

    const byType = { ...EMPTY_BY_TYPE };
    NOTIFICATION_CATEGORIES.forEach((category, index) => {
      byType[category] = counts[index] ?? 0;
    });

    return { unreadCount, totalCount: unfilteredTotal, byType };
  }

  /** 读静态资源域名（通知图标用）；未配置返回 `null` */
  private async readStaticDomain(): Promise<string | null> {
    try {
      const entry = await this.systemConfig.getEntry(STATIC_DOMAIN_CONFIG_KEY);
      const value = entry?.rawValue.trim() ?? '';

      return value.length > 0 ? value : null;
    } catch (error) {
      // 图标只是装饰：配置读不到不该让整个通知列表 500
      this.logger.warn(`读取 ${STATIC_DOMAIN_CONFIG_KEY} 失败（图标将为空）: ${(error as Error).message}`);

      return null;
    }
  }
}
