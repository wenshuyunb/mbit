/**
 * 认证接口
 *
 * 说明：登录态的核心逻辑在 store/auth.ts（含 token 持久化与刷新单飞控制），
 *       这里只暴露「无状态」的接口调用，供特殊场景（如换绑、注销）使用。
 */

import { http } from './request';

export interface WechatLoginPayload {
  /** wx.login 返回的临时凭证 */
  code: string;
  /** 可选：昵称（用户通过 button type="nickname" 授权后获得） */
  nickname?: string;
  /** 可选：头像 OSS key（用户通过 chooseAvatar 上传后获得） */
  avatarKey?: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  isNewUser: boolean;
  user: {
    id: string;
    nickname: string | null;
    avatar: string | null;
    hasProfile: boolean;
  };
}

/** 微信静默登录（code2session 由服务端完成） */
export const wechatLogin = (payload: WechatLoginPayload): Promise<AuthSession> =>
  http.post<AuthSession>('/auth/wechat/login', payload, { needAuth: false, showError: false });

/** 刷新登录态（refresh token 旋转） */
export const refreshSession = (refreshToken: string): Promise<AuthSession> =>
  http.post<AuthSession>('/auth/refresh', { refreshToken }, { needAuth: false, showError: false });

/** 登出当前设备 */
export const logout = (): Promise<void> => http.post<void>('/auth/logout', {}, { showError: false });

/** 登出全部设备（凭证泄露时使用） */
export const logoutAll = (): Promise<void> => http.post<void>('/auth/logout-all', {});

/** 查询当前会话信息（用于校验 token 是否仍有效） */
export const getSession = (): Promise<{ userId: string; realm: string; expiresAt: string }> =>
  http.get('/auth/session', undefined, { showError: false });
