/**
 * 关系视图纯逻辑（无 I/O、可 100% 单测）
 *
 * 契约 §3.6.4 / §3.6.5 的响应里有一大半是**推导**出来的：中文标签、在一起天数、
 * 权限判定、时间线。这类逻辑写在 Service 里只能靠 mock 间接覆盖，而它们恰恰
 * 是最容易出错的部分 —— 权限判错意味着越权，天数算错用户一眼就能看出来。
 */

import { MBTI_TYPE_PROFILES } from '../personality/data/mbti-types';

/** 关系类型中文名（契约 §3.6.4 的 `relationTypeName`） */
const RELATION_TYPE_NAMES: Readonly<Record<string, string>> = {
  COUPLE: '伴侣关系',
  FRIEND: '朋友关系',
  FAMILY: '家人关系',
};

/**
 * 关系状态中文名（契约 §3.6.4 的 `statusLabel`）
 *
 * 键与 Prisma `RelationshipStatus` 一致（ADR-030 对齐后为 5 个值）。
 * 缺少某个键时会回落到原始枚举值 —— 那至少能让"新增状态没登记"这件事
 * 在界面上被看见，而不是显示空白。
 */
const RELATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING_A_CONFIRM: '待确认',
  ACTIVE: '已建立',
  REJECTED: '已拒绝',
  EXPIRED: '已过期',
  REMOVED: '已解除',
};

export const relationTypeName = (type: string): string => RELATION_TYPE_NAMES[type] ?? type;

export const relationStatusLabel = (status: string): string => RELATION_STATUS_LABELS[status] ?? status;

/** MBTI 类型 → 中文名（如 `INFJ` → `提倡者`） */
const MBTI_NAMES: Readonly<Map<string, string>> = new Map(
  MBTI_TYPE_PROFILES.map((profile) => [profile.type, profile.typeName]),
);

/** MBTI 中文名；未知类型返回 `null`（前端据此只显示四个字母） */
export const mbtiTypeName = (type: string | null): string | null => {
  if (type === null) return null;

  return MBTI_NAMES.get(type) ?? null;
};

/** 一次关系允许的上限（契约 §3.6.3：ACTIVE 关系上限 20） */
export const MAX_ACTIVE_RELATIONSHIPS = 20;

/**
 * 「在一起第 N 天」
 *
 * 按**自然日**而非 24 小时倍数计算：用户认为"昨天在一起、今天第二天"，
 * 而 `(now - activatedAt) / 86400000` 在不足 24 小时时会得到 0 天 ——
 * 与用户直觉不符，也会让刚建立关系的人看到"第 0 天"。
 *
 * 未激活（`activatedAt` 为 `null`）时返回 `null`：契约明确该字段可为空，
 * 返回 0 会让人以为"今天刚建立"。
 */
export const daysTogether = (activatedAt: Date | null, now: Date): number | null => {
  if (activatedAt === null) return null;

  // 用 UTC 自然日做差，避免时区把"同一天"算成两天
  const startOfDay = (date: Date): number => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  const diffDays = Math.floor((startOfDay(now) - startOfDay(activatedAt)) / 86_400_000);

  // 时钟回拨或数据异常时钳到 0：负数会显示成"在一起第 -3 天"
  return Math.max(0, diffDays);
};

/** 关系详情页的权限集合（契约 §3.6.5 的 `permissions`） */
export interface RelationshipPermissions {
  readonly canConfirm: boolean;
  readonly canRemove: boolean;
  readonly canGenerateCompatibility: boolean;
  readonly canViewPartnerProfile: boolean;
}

/**
 * 计算当前用户在某段关系上的权限
 *
 * **权限一律服务端计算**，前端只按结果渲染。让前端自己判断"我是不是邀请方"
 * 等于把规则复制一份到客户端 —— 两边一旦不一致，就会出现按钮点了报错
 * 或者该有的按钮没有。这也是契约 §3.6.5 明确要求的。
 */
export const buildPermissions = (params: {
  status: string;
  /** 当前用户是否为邀请方（A） */
  isInviter: boolean;
  /** 双方是否都已有画像 */
  bothHaveProfiles: boolean;
}): RelationshipPermissions => {
  const isActive = params.status === 'ACTIVE';
  const isPending = params.status === 'PENDING_A_CONFIRM';
  // 终态（REJECTED / EXPIRED / REMOVED）下一切都不可做
  const isTerminal = !isActive && !isPending;

  return {
    // 只有邀请方可以确认，且必须处于待确认
    canConfirm: isPending && params.isInviter,
    // 未进入终态时任一方都可解除（强制双方同意会让人无法离开已结束的关系）
    canRemove: !isTerminal,
    // 匹配报告要求关系已生效且双方都有画像 —— 缺任一方画像就没法算分
    canGenerateCompatibility: isActive && params.bothHaveProfiles,
    // 伴侣画像详情（大五明细、关系风格）需关系生效后才可见
    canViewPartnerProfile: isActive,
  };
};

/** 时间线事件（契约 §3.6.5 的 `timeline`） */
export type RelationshipTimelineEvent =
  'INVITE_CREATED' | 'INVITE_ACCEPTED' | 'RELATIONSHIP_ACTIVATED' | 'COMPATIBILITY_GENERATED';

/** 单个时间线条目 */
export interface RelationshipTimelineItem {
  readonly event: RelationshipTimelineEvent;
  readonly label: string;
  readonly at: string;
  readonly actorUserId: string | null;
}

const TIMELINE_LABELS: Readonly<Record<RelationshipTimelineEvent, string>> = {
  INVITE_CREATED: '发起邀请',
  INVITE_ACCEPTED: '接受邀请',
  RELATIONSHIP_ACTIVATED: '关系生效',
  COMPATIBILITY_GENERATED: '生成匹配报告',
};

/** 时间线条目上限（契约 §3.6.5：仅最近 20 条） */
export const TIMELINE_MAX_ITEMS = 20;

/**
 * 组装时间线
 *
 * 按时间**升序**返回（最早的在前）—— 时间线是叙事，倒序会让"发起邀请 → 接受 →
 * 生效"读起来像倒放。缺失的节点直接跳过，不做占位：
 * 占位条目会让用户以为发生过某件事。
 */
export const buildTimeline = (params: {
  invitedAt: Date | null;
  invitedByUserId: string | null;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  activatedAt: Date | null;
  activatedByUserId: string | null;
  lastReportAt: Date | null;
}): readonly RelationshipTimelineItem[] => {
  const items: RelationshipTimelineItem[] = [];

  const push = (event: RelationshipTimelineEvent, at: Date | null, actorUserId: string | null): void => {
    if (at === null) return;
    items.push({ event, label: TIMELINE_LABELS[event], at: at.toISOString(), actorUserId });
  };

  push('INVITE_CREATED', params.invitedAt, params.invitedByUserId);
  push('INVITE_ACCEPTED', params.acceptedAt, params.acceptedByUserId);
  push('RELATIONSHIP_ACTIVATED', params.activatedAt, params.activatedByUserId);
  push('COMPATIBILITY_GENERATED', params.lastReportAt, null);

  // 升序；同一时刻多个事件时保持插入顺序（稳定排序），避免"接受邀请"跑到
  // "发起邀请"前面
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff = Date.parse(a.item.at) - Date.parse(b.item.at);

      return diff !== 0 ? diff : a.index - b.index;
    })
    .map(({ item }) => item)
    .slice(-TIMELINE_MAX_ITEMS);
};

// ============================================================================
// 匹配报告摘要（契约 §3.6.4 / §3.6.5 的 `compatibility`）
// ============================================================================

/** 匹配分档（契约 §3.6.4：≥80 EXCELLENT，65–79 GOOD，50–64 FAIR，<50 CHALLENGING） */
export type CompatibilityScoreLevel = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'CHALLENGING';

/**
 * 匹配分 → 档位
 *
 * 边界值必须与契约一致：`>=80` 与 `>80` 的差别会让恰好 80 分的用户看到不同的
 * 结论，而这类"刚好卡在边界"的用例在手工验收时几乎不会被覆盖到。
 */
export const compatibilityScoreLevel = (score: number): CompatibilityScoreLevel => {
  if (score >= 80) return 'EXCELLENT';
  if (score >= 65) return 'GOOD';
  if (score >= 50) return 'FAIR';

  return 'CHALLENGING';
};

/** 分档中文名（契约 §3.6.5 的 `scoreLabel`，示例「契合良好」） */
const SCORE_LABELS: Readonly<Record<CompatibilityScoreLevel, string>> = {
  EXCELLENT: '非常契合',
  GOOD: '契合良好',
  FAIR: '各有差异',
  CHALLENGING: '需要磨合',
};

export const compatibilityScoreLabel = (level: CompatibilityScoreLevel): string => SCORE_LABELS[level];

/** 关系列表的汇总统计（契约 §3.6.4 的 `summary`） */
export interface RelationshipListSummary {
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly coupleCount: number;
  readonly friendCount: number;
  readonly familyCount: number;
  readonly maxAllowed: number;
}

/** 汇总统计的原始输入 */
export interface RelationshipSummaryCounts {
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly coupleCount: number;
  readonly friendCount: number;
  readonly familyCount: number;
}

export const buildRelationshipSummary = (counts: RelationshipSummaryCounts): RelationshipListSummary => ({
  ...counts,
  maxAllowed: MAX_ACTIVE_RELATIONSHIPS,
});

/**
 * 结束时间
 *
 * `relationship_invites.expiresAt` 表达的是**邀请**的有效期，只对
 * `PENDING_A_CONFIRM` 有意义；关系一旦进入终态，那个时间点就不再是"到期时间"。
 * 直接透传会让已解除的关系也显示一个未来日期，看起来像还会自动生效。
 */
export const relationshipExpiresAt = (status: string, inviteExpiresAt: Date | null): string | null => {
  if (status !== 'PENDING_A_CONFIRM') return null;

  return inviteExpiresAt?.toISOString() ?? null;
};
