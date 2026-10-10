/**
 * 关系与匹配接口
 *
 * ## 与后端的对齐关系（重要）
 *
 * 本文件曾按**设计契约**先行编写，而后端实现晚于它落地，两边一度不一致
 * （状态枚举、字段名、分页信封都不同）。现已逐字段对齐以下**权威来源**：
 *
 * | 前端类型                    | 后端来源                                                            |
 * | --------------------------- | ------------------------------------------------------------------- |
 * | 关系状态                    | Prisma `RelationshipStatus`（ADR-030 对齐后为 5 个值）              |
 * | `RelationshipInvite`        | `RelationshipController.InviteCreatedView`                          |
 * | `Relationship`（列表项）    | `RelationshipService.RelationshipListItemView`                      |
 * | `RelationshipDetail`        | `RelationshipService.RelationshipDetailView`                        |
 * | 分页信封 `items/hasNext`    | 契约 §3.6.4                                                         |
 *
 * **状态枚举尤其要注意**：契约文档里出现过 `ENDED`，而数据库枚举是 `REMOVED`
 * （ADR-030 从 `UNBOUND` 改名而来）。运行时事实源是 Prisma 枚举。
 */

import { http } from './request';
import type { PaginatedData } from './types';
import type { RelationType } from '@/config/constants';

/** 关系状态（与 Prisma `RelationshipStatus` 一致） */
export type RelationshipStatus = 'PENDING_A_CONFIRM' | 'ACTIVE' | 'REJECTED' | 'EXPIRED' | 'REMOVED';

/** 关系类型中文名（`RELATION_TYPES` 的展示用）*/
export type RelationshipRole = 'INVITER' | 'INVITEE';

/** 关系里的伙伴信息（服务端只返回展示所需的最小字段） */
export interface RelationshipPartner {
  userId: string;
  nickname: string | null;
  avatarUrl: string | null;
  mbtiType: string | null;
  /** MBTI 中文名（如 `提倡者`）；无画像时为 `null` */
  typeName: string | null;
  profileVersion: number | null;
  hasProfile: boolean;
}

/** 匹配报告摘要 */
export interface CompatibilitySummary {
  hasReport: boolean;
  latestReportId: string | null;
  overallScore: number | null;
  scoreLevel: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'CHALLENGING' | null;
  scoreLabel: string | null;
  generatedAt: string | null;
  /**
   * 当前是否可触发匹配报告
   *
   * ⚠ 匹配报告链路（`compatibility.calc`）尚未实现，因此后端**恒定返回 `false`**。
   * 前端不要因为它是 `false` 就以为缺前置条件 —— 先看 `blockedReason`。
   */
  canGenerate: boolean;
  isGenerating: boolean;
  /** 不可生成的原因；为 `null` 表示"前置条件都满足，但功能尚未上线" */
  blockedReason: 'RELATIONSHIP_NOT_ACTIVE' | 'PARTNER_NO_PROFILE' | 'MY_NO_PROFILE' | null;
}

/** 关系列表项 */
export interface Relationship {
  relationshipId: string;
  relationType: RelationType;
  relationTypeName: string;
  status: RelationshipStatus;
  statusLabel: string;
  myRole: RelationshipRole;
  partner: RelationshipPartner;
  invitedAt: string | null;
  acceptedAt: string | null;
  activatedAt: string | null;
  /** 仅待确认状态有值（邀请的有效期）；关系进入终态后为 `null` */
  expiresAt: string | null;
  /** 在一起第 N 天（自然日）；未生效时为 `null` */
  daysTogether: number | null;
  compatibility: CompatibilitySummary;
  conversationCount: number;
  lastInteractionAt: string;
}

/** 关系里的一端（A = 邀请方，B = 接受方，**不按 pairKey 排序**） */
export interface RelationshipSide {
  userId: string;
  nickname: string | null;
  avatarUrl: string | null;
  mbtiType: string | null;
  isMe: boolean;
  role: RelationshipRole;
  confirmedAt: string | null;
  hasProfile: boolean;
  profileVersion: number;
}

/** 时间线条目 */
export interface RelationshipTimelineItem {
  event: 'INVITE_CREATED' | 'INVITE_ACCEPTED' | 'RELATIONSHIP_ACTIVATED' | 'COMPATIBILITY_GENERATED';
  label: string;
  at: string;
  actorUserId: string | null;
}

/**
 * 页面权限
 *
 * **由服务端计算**，前端只按结果渲染。让前端自己判断"我是不是邀请方"等于把规则
 * 复制一份到客户端 —— 两边一旦不一致，就会出现按钮点了报错或该有的按钮没有。
 */
export interface RelationshipPermissions {
  canConfirm: boolean;
  canRemove: boolean;
  canGenerateCompatibility: boolean;
  canViewPartnerProfile: boolean;
}

/** 关系详情 */
export interface RelationshipDetail {
  relationshipId: string;
  relationType: RelationType;
  relationTypeName: string;
  status: RelationshipStatus;
  statusLabel: string;
  myRole: RelationshipRole;
  /** 待确认时指向需要确认的一方（即邀请方 A） */
  pendingConfirmationBy: string | null;
  userA: RelationshipSide;
  userB: RelationshipSide;
  acceptedAt: string | null;
  activatedAt: string | null;
  daysTogether: number | null;
  compatibility: CompatibilitySummary;
  aiConversation: {
    conversationCount: number;
    latestConversationId: string | null;
    lastMessageAt: string | null;
    canStartNew: boolean;
  };
  timeline: RelationshipTimelineItem[];
  permissions: RelationshipPermissions;
  disclaimer: string;
}

/** 列表汇总统计（口径为**全部关系**，不随筛选与翻页变化） */
export interface RelationshipListSummary {
  activeCount: number;
  pendingCount: number;
  coupleCount: number;
  friendCount: number;
  familyCount: number;
  /** 允许的 ACTIVE 关系上限 */
  maxAllowed: number;
}

/** 关系列表响应（信封 + `summary`） */
export interface RelationshipListData extends PaginatedData<Relationship> {
  summary: RelationshipListSummary;
}

/** 邀请（创建结果） */
export interface RelationshipInvite {
  inviteId: string;
  /** 契约字段名；`code` 是其别名，保留是为了兼容既有调用 */
  inviteCode: string;
  code: string;
  relationType: RelationType;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expiresAt: string;
  remainingSeconds: number;
  /**
   * 小程序码地址
   *
   * ⚠ 小程序码生成（`wxacode.getUnlimited` + OSS 上传）尚未实现，后端**恒返回 `null`**。
   * 前端必须处理 `null`：降级为展示短码 + 复制链接，而不是渲染一个破图。
   */
  qrCodeUrl: string | null;
  /** 小程序码携带的 scene 参数（即邀请码） */
  qrCodeScene: string;
  /** `onShareAppMessage` 直接使用的分享路径 */
  sharePath: string;
}

/** 接受邀请的结果 */
export interface AcceptedRelationship {
  relationshipId: string;
  status: RelationshipStatus;
  relationType: RelationType;
  peerUserId: string;
  /** 待另一方确认时为 `true`（前端据此展示"等待对方确认"） */
  awaitingPeerConfirm: boolean;
}

/** 确认 / 解除的结果 */
export interface RelationshipState {
  relationshipId: string;
  status: RelationshipStatus;
  confirmedAt: string | null;
  unboundAt: string | null;
}

/** 列表查询参数 */
export interface ListRelationshipsQuery {
  page?: number;
  pageSize?: number;
  /** 逗号分隔多选。**不传时后端只返回 ACTIVE 与 PENDING_A_CONFIRM** */
  status?: string;
  /** 逗号分隔多选 */
  relationType?: string;
  sortBy?: 'createdAt' | 'activatedAt';
  order?: 'asc' | 'desc';
}

/**
 * 创建邀请（生成小程序码）
 *
 * `qrCodeUrl` 可能为 `null`（生成失败或功能未上线），前端需降级为展示短码。
 */
export const createInvite = (payload: {
  relationType: RelationType;
  message?: string;
  channel?: 'WECHAT_SESSION' | 'WECHAT_TIMELINE' | 'MINIAPP_CODE' | 'POSTER' | 'QRCODE' | 'COPY_LINK';
}): Promise<RelationshipInvite> =>
  http.post<RelationshipInvite>('/relationships/invites', payload, { timeout: 30_000 });

/** 接受邀请（需已登录且已完成测试） */
export const acceptInvite = (code: string): Promise<AcceptedRelationship> =>
  http.post<AcceptedRelationship>(`/relationships/invites/${code}/accept`, {});

/**
 * 我的关系列表
 *
 * 不传 `status` 时后端只返回 `ACTIVE` 与 `PENDING_A_CONFIRM` —— 这不是"不筛选"，
 * 而是避免已解除的历史记录淹没首屏。要查历史需显式传 `status: 'REMOVED'`。
 */
export const listRelationships = (query: ListRelationshipsQuery = {}): Promise<RelationshipListData> =>
  http.get<RelationshipListData>('/relationships', { ...query });

/** 关系详情（含 `timeline` 与**服务端计算**的 `permissions`） */
export const getRelationship = (id: string): Promise<RelationshipDetail> =>
  http.get<RelationshipDetail>(`/relationships/${id}`);

/** 确认关系（**仅邀请方**可调用，否则 60008） */
export const confirmRelationship = (id: string): Promise<RelationshipState> =>
  http.post<RelationshipState>(`/relationships/${id}/confirm`, {});

/** 解除关系（任一方可单方解除；幂等） */
export const removeRelationship = (
  id: string,
  query: { reason?: 'NO_LONGER_NEEDED' | 'MISTAKE' | 'PRIVACY' | 'OTHER'; keepHistory?: boolean } = {},
): Promise<RelationshipState> => http.delete<RelationshipState>(`/relationships/${id}`, { ...query });

// ---------------------------------------------------------------------------
// 未实现的后端端点（**刻意不提供客户端**）
// ---------------------------------------------------------------------------
//
// 以下端点在本文件早期版本中存在，但后端从未实现，调用只会得到 404。
// 保留它们会制造"功能已就绪"的假象 —— 页面调过去失败时，排查方向会被引向
// 前端或网络，而真正原因是端点不存在。实现后再加回来：
//
//   · GET  /relationships/invites/{code}                契约 §3.6.2（邀请详情，扫码进入时用）
//   · POST /relationships/{id}/compatibility            契约 §3.6.8（触发匹配算分）
//   · GET  /relationships/{id}/compatibility            契约 §3.6.9（查询匹配报告）
//   · GET  /compatibility-reports/{id}                  —（按报告 ID 查询）
//
// 依赖关系：前两个依赖 `compatibility.calc` 队列与匹配报告落库链路；
// `GET /relationships/invites/{code}` 依赖邀请详情的公开信息视图。
