/**
 * 用户资料接口
 *
 * 对应后端模块：user（契约来源 `docs/API_DESIGN.md` §3.2）
 *
 * ## 为什么需要这个文件
 *
 * 此前小程序**没有用户模块的 API 层**：`store/auth.ts` 直接 `http.get('/users/me')`
 * 并复用了登录响应的用户类型，于是把两个**结构不同**的视图当成了同一个：
 *
 * | 来源                          | 顶层字段                     | 画像/会员                       |
 * | ----------------------------- | ---------------------------- | ------------------------------- |
 * | `POST /auth/wechat/login`.user | `AuthUserView`               | `hasProfile`、`mbtiType` 在顶层 |
 * | `GET /users/me`               | `MeView`                     | **可选块**，需 `include` 才返回 |
 *
 * 最典型的后果是头像字段名不一致（两处都叫 `avatarUrl`，而前端写成了 `avatar`），
 * 以及把可选块当成必填读取。
 *
 * ## 扩展块（`include`）
 *
 * `/users/me` 默认只返回基础资料；画像、会员、AI 配额、统计、同意记录都要显式请求，
 * 避免「打开个人页就顺带查了 5 张表」。
 */

import { http } from './request';

/** 可请求的扩展块（与后端 `INCLUDE_BLOCKS` 一致） */
export const INCLUDE_BLOCKS = ['profile', 'membership', 'aiQuota', 'stats', 'consents'] as const;
export type IncludeBlock = (typeof INCLUDE_BLOCKS)[number];

/** 画像摘要（`include=profile`） */
export interface ProfileBlock {
  profileId: string;
  mbtiType: string;
  engineVersion: string;
  version: number;
  confidence: number;
  bigFive: Record<string, number>;
  relationshipStyle: {
    attachment: string;
    loveLanguage: string[];
    conflictStyle: string | null;
  };
  generatedAt: string;
}

/**
 * 会员摘要（`include=membership`）
 *
 * ⚠ 这是**第 3 种**会员结构（另两种见 `api/membership.ts` 的 `MembershipStatus`
 * 与 `api/auth.ts` 的 `AuthUserView.membership`）。三者字段名互不相同，
 * 不可互换使用 —— 这是后端契约层面的不一致，已记录待统一。
 */
export interface MembershipBlock {
  isActive: boolean;
  planCode: string | null;
  planName: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  remainingDays: number | null;
}

/** AI 配额摘要（`include=aiQuota`） */
export interface AiQuotaBlock {
  remaining: number;
  dailyLimit: number;
  usedToday: number;
  resetAt: string;
  /** 付费购买的次数余额 */
  creditBalance: number;
}

/** 使用统计（`include=stats`） */
export interface StatsBlock {
  testSessionCount: number;
  reportCount: number;
  relationshipCount: number;
  aiMessageCount: number;
}

/** `GET /users/me` 响应（后端 `MeView`） */
export interface MeView {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
  gender: string;
  birthday: string | null;
  ageRange: string | null;
  phoneBound: boolean;
  /** 已脱敏的手机号，如 `138****6721` */
  phoneMasked: string | null;
  status: string;
  ageVerified: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** 以下均为可选块：只有 `include` 请求了才存在 */
  profile?: ProfileBlock;
  membership?: MembershipBlock;
  aiQuota?: AiQuotaBlock;
  stats?: StatsBlock;
}

export interface GetMeQuery {
  /** 需要一并返回的扩展块 */
  include?: IncludeBlock[];
}

/** 当前用户聚合资料 */
export const getMe = (query: GetMeQuery = {}): Promise<MeView> => {
  const include = query.include ?? [];
  return http.get<MeView>('/users/me', include.length > 0 ? { include: include.join(',') } : undefined, {
    showError: false,
  });
};
