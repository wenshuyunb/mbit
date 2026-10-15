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
  /**
   * 性别**是否已被询问过**（ADR-039）
   *
   * ⚠ 不能用 `gender === 'UNKNOWN'` 代替：`UNKNOWN` 既可能是"从没问过"，
   * 也可能是"问过了、用户选择不说"。前者要弹引导，后者再弹就是骚扰。
   */
  genderDeclared: boolean;
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

/**
 * 性别取值（后端 `PATCH /users/me` 的 DTO 只接受这三个）
 *
 * ⚠ 数据层的 `UserGender` 枚举还有 `OTHER`，但接口层**不接受**它 ——
 * 产品的三个选项是「男生 / 女生 / 不想说」，"不想说"落在 `UNKNOWN`。
 * 前端只发这三个值，避免出现"类型允许、接口必拒"的死角。
 */
export type UserGenderCode = 'MALE' | 'FEMALE' | 'UNKNOWN';

/** `PATCH /users/me` 的请求体 */
export interface UpdateProfilePayload {
  nickname?: string | null;
  gender?: UserGenderCode | null;
  /** `YYYY-MM-DD` */
  birthday?: string | null;
  /** 乐观锁版本号；不传则最后写入者胜 */
  expectedVersion?: number;
}

/** `PATCH /users/me` 响应（后端 `ProfileUpdatedView`） */
export interface ProfileUpdatedView {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
  gender: string;
  /** 见 `MeView.genderDeclared` */
  genderDeclared: boolean;
  birthday: string | null;
  ageRange: string | null;
  version: number;
  updatedAt: string;
}

/**
 * 修改当前用户资料
 *
 * ⚠ 后端在 `gender` 传入时（**包括传 `UNKNOWN` / `null`**）会一并记下
 * "性别已被询问过"的时间，因此：
 *   · 用户选择「不想说」也必须发这个请求 —— 只在前端记本地标记的话，
 *     换设备/清缓存后会再被问一遍；
 *   · 只改昵称时**不要**顺手带上 `gender`，否则等于替用户"确认"了一次性别。
 */
export const updateProfile = (payload: UpdateProfilePayload): Promise<ProfileUpdatedView> =>
  http.patch<ProfileUpdatedView>('/users/me', payload, { timeout: 20_000 });
