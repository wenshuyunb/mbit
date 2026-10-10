/**
 * 会员与权益接口
 *
 * 核心概念（架构文档 §13.1）：Entitlement（权益）是解锁内容的唯一依据，
 * 前端不做「是否买过」的判断，一律以服务端返回的权益为准。
 */

import { http } from './request';

/** 会员套餐 */
export interface MembershipPlan {
  code: string;
  name: string;
  description: string;
  durationDays: number;
  /** 现价（分） */
  priceAmount: number;
  /** 原价（分），用于展示划线价 */
  originalAmount: number | null;
  /** 权益说明列表（运营文案，后端可配） */
  benefits: string[];
  /** 是否推荐（前端高亮展示） */
  recommended: boolean;
}

/** 权益类型 */
export type EntitlementType = 'REPORT_UNLOCK' | 'MEMBERSHIP_ACTIVE' | 'AI_CREDITS' | 'PDF_EXPORT';

/** 权益 */
export interface Entitlement {
  id: string;
  type: EntitlementType;
  /** 关联资源 ID（如报告解锁对应的 reportId） */
  targetId: string | null;
  /** 剩余次数（AI_CREDITS 类权益） */
  remaining: number | null;
  /** 生效时间 */
  effectiveAt: string;
  /** 失效时间（NULL 表示永久） */
  expiresAt: string | null;
  /** 是否当前有效 */
  active: boolean;
}

/** 我的会员状态 */
export interface MembershipStatus {
  isActive: boolean;
  planCode: string | null;
  planName: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  /** 剩余天数，便于前端展示「还有 N 天到期」 */
  remainingDays: number | null;
}

/** 会员套餐列表（公开接口，用于会员页展示） */
export const listPlans = (): Promise<MembershipPlan[]> =>
  http.get<MembershipPlan[]>('/membership/plans', undefined, { needAuth: false, showError: false });

/** 我的会员状态 */
export const getMyMembership = (): Promise<MembershipStatus> =>
  http.get<MembershipStatus>('/membership/me', undefined, { showError: false });

/** 我的权益列表 */
export const listEntitlements = (): Promise<Entitlement[]> =>
  http.get<Entitlement[]>('/membership/entitlements', undefined, { showError: false });
