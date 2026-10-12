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

/**
 * 把查询参数拼成查询串
 *
 * 存在的理由：请求层只对 **GET** 把 `data` 拼到 URL 上，非 GET 一律放进请求体
 * （`request.ts` 的 `buildUrl` 与 `request()` 两处行为叠加）。而
 * `DELETE /relationships/{id}` 的后端实现用 `@Query()` 读取参数 —— 直接把对象当
 * body 传过去，参数会被**静默丢弃**（200 成功但 reason 丢失，最难排查的一类缺陷）。
 * 因此凡是非 GET 却要用查询参数的地方，都必须自己拼串。
 */
const toQueryString = (params: Record<string, unknown>): string => {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);

  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
};

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

/** 匹配报告摘要（嵌入关系列表项；后端 `RelationshipService.CompatibilitySummaryView`） */
export interface CompatibilitySummary {
  hasReport: boolean;
  latestReportId: string | null;
  overallScore: number | null;
  scoreLevel: CompatibilityScoreLevel | null;
  scoreLabel: string | null;
  generatedAt: string | null;
  /**
   * 当前是否可触发匹配报告
   *
   * 由后端 `resolveCompatibilityBlocker` 判定，**与触发接口用的是同一份判定逻辑** ——
   * 前端不要自己推断前置条件（那等于把规则复制一份到客户端）。
   *
   * ⚠ 本字段的注释此前写着「后端恒定返回 false」，那是匹配链路尚未接入时的状态，
   * 现已不成立：后端已实现 `compatibility.calc` 与两个匹配接口。
   */
  canGenerate: boolean;
  isGenerating: boolean;
  /**
   * 不可生成的原因
   *
   * 为 `null` 有两种含义：① 可以生成；② 前置条件都满足但报告正在生成中
   * —— 后端把 `ALREADY_GENERATING` 归一化为 `null`，这种情况要看 `isGenerating`。
   */
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

/**
 * 解除关系（任一方可单方解除；幂等）
 *
 * ⚠ 参数必须放在 **URL 查询串**里：后端用 `@Query()` 读取（`RemoveRelationshipQueryDto`），
 * 而请求层对非 GET 请求不会把 `data` 拼进 URL —— 直接传对象会变成 DELETE 的请求体，
 * 后端读不到，于是**返回 200 但 reason 被静默丢弃**。
 *
 * 另外 `keepHistory` 目前是「后端接受但未使用」：DTO 声明了该字段，但
 * `RelationshipController.removeRelationship` 只把 `query.reason` 传给 Service。
 * 这里仍然照传，等后端接上后无需改前端。
 */
export const removeRelationship = (
  id: string,
  query: { reason?: 'NO_LONGER_NEEDED' | 'MISTAKE' | 'PRIVACY' | 'OTHER'; keepHistory?: boolean } = {},
): Promise<RelationshipState> =>
  http.delete<RelationshipState>(
    `/relationships/${id}${toQueryString({ reason: query.reason, keepHistory: query.keepHistory })}`,
  );

// ---------------------------------------------------------------------------
// 匹配报告
// ---------------------------------------------------------------------------

/** 匹配分档（与后端 `CompatibilityScoreLevel` 一致） */
export type CompatibilityScoreLevel = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'CHALLENGING';

/** 触发匹配算分的结果（后端 `CompatibilityRequestView`，HTTP 202） */
export interface CompatibilityRequestResult {
  reportId: string;
  status: string;
  /** 队列名，便于排查任务去向 */
  queue: string;
  /** `true` 表示复用了既有报告（同参数重复触发不会重复消耗配额） */
  isReused: boolean;
  estimatedSeconds: number;
}

/**
 * 匹配报告（后端 `CompatibilityReportView`）
 *
 * 分数为 `null` 表示该维度尚不可算（例如对方没有对应数据），**不是 0 分** ——
 * 前端必须区分「算出来是 0」与「没算」，否则会把"暂无数据"显示成"完全不匹配"。
 */
export interface CompatibilityReport {
  reportId: string;
  relationshipId: string;
  status: string;
  totalScore: number | null;
  mbtiScore: number | null;
  bigFiveScore: number | null;
  attachmentScore: number | null;
  communicationScore: number | null;
  scoreLevel: CompatibilityScoreLevel | null;
  scoreLabel: string | null;
  scoreBreakdown: Record<string, unknown> | null;
  engineVersion: string;
  weightsVersion: string;
  computedAt: string | null;
  createdAt: string;
  /** 失败时的**友好文案**（后端不透出上游错误原文） */
  failureReason?: string;
  /** AI 解读部分的落库状态；本期后端恒为 `available: false` */
  aiInterpretation: {
    available: boolean;
    aiReportId: string | null;
  };
}

/**
 * 触发匹配算分（异步，返回 202）
 *
 * 算分结果由纯数学决定、与 AI 无关（ADR-005）：同一份输入必然得到同一个分数。
 * 后端已按「双方画像版本 + 权重版本 + 引擎版本」做幂等，连点不会产生重复报告。
 */
export const requestCompatibility = (relationshipId: string): Promise<CompatibilityRequestResult> =>
  http.post<CompatibilityRequestResult>(`/relationships/${relationshipId}/compatibility`, {}, { timeout: 30_000 });

/**
 * 查询匹配报告
 *
 * **返回 `null` 表示尚未生成，这是正常状态而非错误** —— 后端明确用 `data: null`
 * 表达（而不是抛异常），此处如实透传，页面据此展示「尚未生成」引导。
 */
export const getCompatibility = (relationshipId: string): Promise<CompatibilityReport | null> =>
  http.get<CompatibilityReport | null>(`/relationships/${relationshipId}/compatibility`);

// ---------------------------------------------------------------------------
// 未实现的后端端点（**刻意不提供客户端**）
// ---------------------------------------------------------------------------
//
// 以下端点**后端确实不存在**，调用只会得到 404，因此刻意不提供客户端。
// 凭空提供会制造「功能已就绪」的假象：页面调过去失败时，排查方向会被引向
// 前端或网络，而真正原因是端点不存在。实现后再加回来：
//
//   · GET  /relationships/invites/{code}                契约 §3.6.2（邀请详情，扫码进入时用）
//   · GET  /compatibility-reports/{id}                  —（按报告 ID 查询）
//
// `GET /relationships/invites/{code}` 依赖邀请详情的公开信息视图。
//
// ⚠ 更正（本文件早期版本的注释在此处有误）：`POST/GET /relationships/{id}/compatibility`
// 曾被列为「后端从未实现」，但后端**已经实现**（`RelationshipController` 的
// `generateCompatibility` / `getCompatibility`，对应本文件上方新加的
// `requestCompatibility` / `getCompatibility`）。该错误注释会让团队误以为
// 匹配报告链路未就绪，从而不提供客户端入口 —— 已随本次修复一并纠正。
