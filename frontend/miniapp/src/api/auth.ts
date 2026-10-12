/**
 * 认证接口
 *
 * 说明：登录态的核心逻辑在 `store/auth.ts`（含 token 持久化与刷新单飞控制），
 *       这里只暴露「无状态」的接口调用。
 *
 * ## 权威结构（`backend/src/modules/auth/auth.service.ts`）
 *
 * | 响应类型            | 对应接口                    | 要点                          |
 * | ------------------- | --------------------------- | ----------------------------- |
 * | `AuthLoginResult`   | `POST /auth/wechat/login`   | 含 `user` 与 `session`        |
 * | `AuthRefreshResult` | `POST /auth/refresh`        | **不含 `user`**（契约 §3.1.2） |
 * | `AuthLogoutResult`  | `POST /auth/logout(-all)`   | 含被作废的会话数              |
 * | `AuthSessionResult` | `GET  /auth/session`        | 当前会话详情                  |
 *
 * ⚠ 本文件此前用**同一个 `AuthSession`** 描述登录与刷新两个响应，而两者结构本就不同：
 * 刷新不返回 `user`。后果不只是类型不准 —— `store/auth.ts` 的 `refresh()` 也调用了
 * 持久化用户信息的逻辑，于是**每次刷新令牌都会把 `userInfo` 覆盖成 `undefined`**，
 * 表现为昵称变回默认值、头像消失、会员状态丢失。TypeScript 发现不了，
 * 因为错误的那份 interface 是自洽的。现已按接口拆成两个类型。
 */

import { http } from './request';

/**
 * 微信登录入参（后端 `WechatLoginDto`）
 *
 * ⚠ 原先多出的 `nickname` / `avatarKey` 在后端 DTO 里**不存在**，
 * 而全局管道开了 `forbidNonWhitelisted`，传了会被直接判为 `400 / 10001`。
 * 昵称与头像走的是另外的接口（`PATCH /users/me`、`POST /users/me/avatar`）。
 */
export interface WechatLoginPayload {
  /** `wx.login` 返回的临时凭证 */
  code: string;
  /** 设备标识（8–64 位），用于多端会话管理 */
  deviceId?: string;
  platform?: 'miniapp';
  /** 邀请码（恰好 8 位），用于渠道归因 */
  inviterCode?: string;
  /** 用户声明的年龄（1–120），用于合规判定 */
  ageDeclared?: number;
}

/** 登录响应中的用户信息（后端 `AuthUserView`） */
export interface AuthUserView {
  id: string;
  nickname: string | null;
  /** 字段名是 `avatarUrl`（原前端写成 `avatar`，导致头像永远不显示） */
  avatarUrl: string | null;
  gender: string;
  birthday: string | null;
  phoneBound: boolean;
  status: string;
  ageVerified: boolean;
  /** 是否已完成过至少一次人格测试 */
  hasProfile: boolean;
  mbtiType: string | null;
  /**
   * 会员摘要
   *
   * ⚠ 注意这是**登录响应里的**形状（`isActive` / `planCode` / `expiresAt`），
   * 与 `GET /membership` 的 `MembershipStatus`（`isMember` / `expireAt` /
   * `remainingDays`）**字段名不同**；两者不可互换使用。
   */
  membership: {
    isActive: boolean;
    planCode: string | null;
    expiresAt: string | null;
  };
  createdAt: string;
}

/** 会话元信息 */
export interface AuthSessionMeta {
  sessionId: string;
  issuedAt: string;
  expiresAt: string;
  deviceId: string | null;
}

/** 登录响应（后端 `LoginResult`） */
export interface AuthLoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** accessToken 有效期（秒） */
  expiresIn: number;
  /** refreshToken 有效期（秒） */
  refreshExpiresIn: number;
  isNewUser: boolean;
  user: AuthUserView;
  session: AuthSessionMeta;
}

/** 刷新响应（后端 `RefreshResult`）—— **不含 `user`** */
export interface AuthRefreshResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
  /** 本次轮换时间 */
  rotatedAt: string;
}

/** 登出响应（后端 `LogoutResult`） */
export interface AuthLogoutResult {
  revokedSessions: number;
  accessTokenRevoked: boolean;
  revokedAt: string;
}

/** 当前会话详情（后端 `SessionResult`） */
export interface AuthSessionResult {
  sessionId: string;
  userId: string;
  realm: string;
  deviceId: string | null;
  platform: string | null;
  issuedAt: string;
  expiresAt: string;
  absoluteLifecycleDays: number;
}

/** 微信静默登录（code2session 由服务端完成） */
export const wechatLogin = (payload: WechatLoginPayload): Promise<AuthLoginResult> =>
  http.post<AuthLoginResult>('/auth/wechat/login', payload, { needAuth: false, showError: false });

/** 刷新登录态（refresh token 旋转） */
export const refreshSession = (refreshToken: string): Promise<AuthRefreshResult> =>
  http.post<AuthRefreshResult>('/auth/refresh', { refreshToken }, { needAuth: false, showError: false });

/** 登出当前设备 */
export const logout = (): Promise<AuthLogoutResult> =>
  http.post<AuthLogoutResult>('/auth/logout', {}, { showError: false });

/** 登出全部设备（凭证泄露时使用） */
export const logoutAll = (): Promise<AuthLogoutResult> => http.post<AuthLogoutResult>('/auth/logout-all', {});

/** 查询当前会话信息（用于校验 token 是否仍有效） */
export const getSession = (): Promise<AuthSessionResult> =>
  http.get<AuthSessionResult>('/auth/session', undefined, { showError: false });
