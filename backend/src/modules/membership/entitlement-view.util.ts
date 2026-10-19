/**
 * 权益视图纯逻辑（契约 §3.8.3，无 I/O、可 100% 单测）
 *
 * ## 为什么需要「派生状态」
 *
 * `entitlements.status` 是一列**由后台/定时任务维护**的状态（`ACTIVE` /
 * `CONSUMED` / `EXPIRED` / `REVOKED`），而契约 §3.8.3 的 `status` 还需要覆盖
 * 「时间窗已过但状态列还没被刷」这一大片现实数据 —— 到期任务可能延迟几分钟到
 * 几小时，也可能因为一次部署而根本没跑。
 *
 * 因此响应里的 `status` 是**派生值**：状态列 + `expireAt` + `remainingQuota` 综合判断。
 * 与之配套的筛选条件也必须用同一套规则生成 SQL（`buildStatusFilter`），
 * 否则会出现「列表里显示 EXPIRED，但筛 EXPIRED 时它不见了」。
 *
 * ## 脱敏范围（本文件是唯一的出口）
 *
 * `entitlements` 表里有 `grantedByAdminId` / `revokeReason` / `idempotencyKey` /
 * `version` 等**内部字段**。它们不是"返回后删掉"，而是**不进入查询**（见
 * `EntitlementService.listEntitlements` 的 select）：从源头杜绝泄露，
 * 避免某次加字段时被顺手带出去。
 * 唯一例外是 `grantedByAdminId`：它只被用来判断 `sourceType = 'ADMIN'`，
 * **不进入响应**（操作人 ID 属内部信息）。
 */

import type { EntitlementStatus, EntitlementType } from '@prisma/client';

import { isEntitlementActive, type EntitlementLike } from './entitlement.util';

/** 权益类型（契约 §3.8.3 的 `type` 枚举，顺序即文档顺序） */
export const ENTITLEMENT_TYPES = [
  'REPORT_UNLOCK',
  'MEMBERSHIP_ACTIVE',
  'AI_CREDITS',
  'PDF_EXPORT',
  'ZODIAC_READING',
] as const;

export type EntitlementTypeValue = (typeof ENTITLEMENT_TYPES)[number];

/** 权益状态（契约 §3.8.3 的 `status` 枚举） */
export const ENTITLEMENT_STATUSES = ['ACTIVE', 'EXPIRED', 'CONSUMED', 'REVOKED'] as const;

export type EntitlementStatusValue = (typeof ENTITLEMENT_STATUSES)[number];

/** 类型中文名（契约 §3.8.3 的 `typeName`） */
const TYPE_NAMES: Readonly<Record<EntitlementTypeValue, string>> = {
  REPORT_UNLOCK: '报告解锁',
  MEMBERSHIP_ACTIVE: '会员权益',
  AI_CREDITS: 'AI 对话次数包',
  PDF_EXPORT: 'PDF 导出权益',
  ZODIAC_READING: '星盘解读解锁',
};

export const entitlementTypeName = (type: EntitlementTypeValue): string => TYPE_NAMES[type];

/** 权益来源（契约 §3.8.3 的 `sourceType`） */
export const ENTITLEMENT_SOURCES = ['ORDER', 'MEMBERSHIP', 'ADMIN', 'SYSTEM'] as const;

export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/** 权益行的输入形状（与 `EntitlementService.listEntitlements` 的 select 一一对应） */
export interface EntitlementRowLike {
  readonly id: string;
  readonly type: EntitlementType;
  readonly status: EntitlementStatus;
  readonly resourceKey: string | null;
  readonly orderId: string | null;
  readonly membershipId: string | null;
  readonly reportId: string | null;
  readonly relationshipId: string | null;
  readonly totalQuota: number | null;
  readonly usedQuota: number;
  readonly remainingQuota: number | null;
  readonly startAt: Date;
  readonly expireAt: Date | null;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  /** ⚠ 仅用于推导 `sourceType = 'ADMIN'`，**绝不进入响应** */
  readonly grantedByAdminId: string | null;
}

/**
 * 派生状态
 *
 * 判断顺序**有意义**：退款撤销（`REVOKED`）优先于一切 —— 钱已经退了，
 * 权益无论如何都不该可用；其次才是时间窗、最后才是配额。
 * 反过来先判配额的话，一条"已退款且次数用尽"的权益会显示成 `CONSUMED`，
 * 用户会以为自己是用完的，而不是被撤销的。
 */
export const deriveEntitlementStatus = (
  row: Pick<EntitlementRowLike, 'type' | 'status' | 'expireAt' | 'remainingQuota'>,
  now: Date,
): EntitlementStatusValue => {
  if (row.status === 'REVOKED') return 'REVOKED';
  if (row.status === 'EXPIRED') return 'EXPIRED';
  if (row.expireAt !== null && row.expireAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (row.status === 'CONSUMED') return 'CONSUMED';

  // 计数型配额用尽即视为已消耗（`remainingQuota === null` 表示不限次）
  if (isQuotaType(row.type) && row.remainingQuota !== null && row.remainingQuota <= 0) return 'CONSUMED';

  return 'ACTIVE';
};

/** 计数型权益（会递减的两种） */
const isQuotaType = (type: EntitlementType): boolean => type === 'AI_CREDITS' || type === 'PDF_EXPORT';

/**
 * 状态中文名（契约 §3.8.3 的 `statusLabel`）
 *
 * 文案**分类型**：同样是 `ACTIVE`，会员是「生效中」、永久报告解锁是「永久有效」、
 * 次数包是「剩余 30 次」。统一成「生效中」会让用户看不出次数包里还剩多少次 ——
 * 而那正是他要的信息。
 */
export const entitlementStatusLabel = (row: EntitlementRowLike, status: EntitlementStatusValue, now: Date): string => {
  switch (status) {
    case 'REVOKED':
      return '已撤销';
    case 'EXPIRED':
      return '已过期';
    case 'CONSUMED':
      return '已用完';
    case 'ACTIVE':
    default:
      if (row.type === 'AI_CREDITS' || row.type === 'PDF_EXPORT') {
        return row.remainingQuota === null ? '不限次' : `剩余 ${row.remainingQuota} 次`;
      }

      // 无到期时间的报告解锁是永久权益，显示「永久有效」而不是「生效中」
      return row.expireAt === null ? '永久有效' : `生效中（剩余 ${remainingDays(row.expireAt, now)} 天）`;
  }
};

const remainingDays = (expireAt: Date, now: Date): number =>
  Math.max(0, Math.ceil((expireAt.getTime() - now.getTime()) / 86_400_000));

/** 剩余秒数：无到期时间返回 `null`（不是 0 —— 0 表示"马上过期"） */
export const entitlementRemainingSeconds = (expireAt: Date | null, now: Date): number | null => {
  if (expireAt === null) return null;

  return Math.max(0, Math.floor((expireAt.getTime() - now.getTime()) / 1000));
};

/**
 * 是否可用
 *
 * **直接复用 `isEntitlementActive`**，不另写一套判定：报告页的付费墙、AI 配额
 * 校验都走那个函数，两处不一致会让「权益页说可用、点进去被挡住」（或反过来的
 * 白送）。这里只做转换，不新增规则。
 */
export const entitlementIsUsable = (row: EntitlementRowLike, now: Date): boolean =>
  isEntitlementActive(toEntitlementLike(row), now);

/** 转成 `EntitlementLike`（只取判定需要的 6 个字段） */
const toEntitlementLike = (row: EntitlementRowLike): EntitlementLike => ({
  type: row.type,
  status: row.status,
  resourceKey: row.resourceKey,
  reportId: row.reportId,
  expireAt: row.expireAt,
  remainingQuota: row.remainingQuota,
});

/**
 * 关联资源 ID
 *
 * 与契约示例对齐：`REPORT_UNLOCK` 给报告 ID，`MEMBERSHIP_ACTIVE` 为 `null`
 * （会员不对应单个资源）。**不返回 `resourceKey`** ——
 * 它是内部编码（`report:{id}#{sectionKey}`），暴露出去等于让客户端依赖一个
 * 可以随时演进的字符串格式。
 */
export const entitlementResourceId = (row: EntitlementRowLike): string | null => {
  if (row.type === 'REPORT_UNLOCK') return row.reportId ?? row.relationshipId;

  return null;
};

/**
 * 可读的资源描述（契约规则 3）
 *
 * 「这条权益是干什么的」——契约要求给用户看得懂的一句话，但明确**不返回资源正文**。
 * 报告标题需要联查 `ai_reports`（见 Service 的 select），拿不到时回落到类型描述，
 * 而不是留空：留空会让"我的权益"页出现一行只有日期的条目。
 */
export const entitlementResourceSummary = (row: EntitlementRowLike, reportTitle: string | null): string | null => {
  switch (row.type) {
    case 'MEMBERSHIP_ACTIVE':
      return row.expireAt === null ? '会员权益' : `会员权益（${daysBetween(row.startAt, row.expireAt)} 天）`;
    case 'REPORT_UNLOCK':
      return reportTitle ?? '报告解锁';
    case 'AI_CREDITS':
      return row.totalQuota === null ? 'AI 次数包' : `AI 次数包 ${row.totalQuota} 次`;
    case 'PDF_EXPORT':
      return row.remainingQuota === null ? 'PDF 导出权益' : `PDF 导出 ${row.remainingQuota} 次`;
    default:
      return null;
  }
};

const daysBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));

/** 来源（契约 §3.8.3 的 `sourceType` / `sourceId` / `sourceOrderNo`） */
export const entitlementSource = (
  row: EntitlementRowLike,
  orderNo: string | null,
): { sourceType: EntitlementSource; sourceId: string | null; sourceOrderNo: string | null } => {
  if (row.orderId !== null) {
    return { sourceType: 'ORDER', sourceId: row.orderId, sourceOrderNo: orderNo };
  }

  if (row.membershipId !== null) {
    return { sourceType: 'MEMBERSHIP', sourceId: row.membershipId, sourceOrderNo: null };
  }

  if (row.grantedByAdminId !== null) {
    // `sourceId` **刻意留空**：管理员 ID 属内部信息（协议约定不返回操作人 ID），
    // 前端只需要知道"这是人工发放的"
    return { sourceType: 'ADMIN', sourceId: null, sourceOrderNo: null };
  }

  return { sourceType: 'SYSTEM', sourceId: null, sourceOrderNo: null };
};

// ============================================================================
// 筛选条件的 SQL 片段（必须与 `deriveEntitlementStatus` 逐条镜像）
// ============================================================================

/** 时间窗未过期 */
const notExpiredClause = (now: Date): Record<string, unknown> => ({
  OR: [{ expireAt: null }, { expireAt: { gt: now } }],
});

/** 时间窗已过期 */
const expiredClause = (now: Date): Record<string, unknown> => ({ expireAt: { not: null, lte: now } });

/** 计数型配额已用尽（`remainingQuota` 为 null 表示不限次，不算用尽） */
const quotaExhaustedClause = (): Record<string, unknown> => ({
  type: { in: ['AI_CREDITS', 'PDF_EXPORT'] },
  remainingQuota: { lte: 0 },
});

/** 单个派生状态的筛选条件 */
export const buildStatusClause = (status: EntitlementStatusValue, now: Date): Record<string, unknown> => {
  switch (status) {
    case 'REVOKED':
      return { status: 'REVOKED' };
    case 'EXPIRED':
      return {
        OR: [
          { status: 'EXPIRED' },
          // 状态列还停在 ACTIVE/CONSUMED，但时间窗已经过了
          { status: { in: ['ACTIVE', 'CONSUMED'] }, ...expiredClause(now) },
        ],
      };
    case 'CONSUMED':
      return {
        OR: [
          // 状态列为 CONSUMED 且未过期
          { status: 'CONSUMED', ...notExpiredClause(now) },
          // 状态列还是 ACTIVE，但配额已用尽且未过期
          { status: 'ACTIVE', ...notExpiredClause(now), ...quotaExhaustedClause() },
        ],
      };
    case 'ACTIVE':
    default:
      // `NOT` 单独成键：Prisma 的 `NOT` 与其它字段是 AND 关系，
      // 而配额与时间窗都需要 OR，因此必须各自包一层
      return {
        status: 'ACTIVE',
        ...notExpiredClause(now),
        NOT: quotaExhaustedClause(),
      };
  }
};

/** 多选状态筛选；为空时返回 `null` */
export const buildStatusFilter = (
  statuses: readonly EntitlementStatusValue[],
  now: Date,
): Record<string, unknown> | null => {
  if (statuses.length === 0) return null;
  if (statuses.length === 1) return buildStatusClause(statuses[0], now);

  return { OR: statuses.map((status) => buildStatusClause(status, now)) };
};

/** 组装一条列表项（契约 §3.8.3） */
export const toEntitlementItem = (
  row: EntitlementRowLike,
  now: Date,
  reportTitle: string | null,
  orderNo: string | null,
): Record<string, unknown> => {
  const status = deriveEntitlementStatus(row, now);
  const source = entitlementSource(row, orderNo);

  return {
    entitlementId: row.id,
    type: row.type,
    typeName: entitlementTypeName(row.type),
    status,
    statusLabel: entitlementStatusLabel(row, status, now),
    grantedAt: row.startAt.toISOString(),
    expiresAt: row.expireAt?.toISOString() ?? null,
    remainingSeconds: entitlementRemainingSeconds(row.expireAt, now),
    remainingCount: row.remainingQuota,
    totalCount: row.totalQuota,
    usedCount: row.usedQuota,
    resourceId: entitlementResourceId(row),
    resourceSummary: entitlementResourceSummary(row, reportTitle),
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceOrderNo: source.sourceOrderNo,
    isUsable: entitlementIsUsable(row, now),
  };
};
