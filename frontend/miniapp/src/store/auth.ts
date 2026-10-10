/**
 * 认证状态
 *
 * 职责：
 *   · 微信静默登录（wx.login → code → 后端换取 JWT）
 *   · accessToken / refreshToken 的持久化与到期管理
 *   · 向请求层注册钩子（取 token、刷新 token、登录失效处理），
 *     以此避免 api/request.ts ←→ store 的循环依赖
 *
 * 安全约束：
 *   · 只持久化 token 与最小化的用户信息，禁止缓存 openid/session_key 等敏感数据
 *   · session_key 永远不落客户端（后端加密存储，见架构文档 §9.1）
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { http, registerRequestHooks } from '@/api/request';
import { ERROR_CODES, type ApiError } from '@/api/types';
import { STORAGE_KEYS } from '@/config/constants';
import { storage } from '@/utils/storage';

/** 登录接口返回体 */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  /** accessToken 有效期（秒） */
  expiresIn: number;
  isNewUser: boolean;
  user: UserInfo;
}

/** 当前用户信息（最小集；服务端不会下发 openid 原文） */
export interface UserInfo {
  id: string;
  nickname: string | null;
  avatar: string | null;
  gender: 'MALE' | 'FEMALE' | 'UNKNOWN' | null;
  /** 是否已完成过至少一次人格测试 */
  hasProfile: boolean;
  /** 会员状态 */
  membership: {
    isActive: boolean;
    expiresAt: string | null;
    planCode: string | null;
  };
}

/** accessToken 提前刷新窗口：剩余有效期不足 5 分钟即主动刷新 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;

export const useAuthStore = defineStore('auth', () => {
  // -------------------------------------------------------------------- state
  const accessToken = ref<string | null>(storage.get<string>(STORAGE_KEYS.accessToken));
  const refreshToken = ref<string | null>(storage.get<string>(STORAGE_KEYS.refreshToken));
  const expireAt = ref<number>(storage.get<number>(STORAGE_KEYS.accessTokenExpireAt) ?? 0);
  const userInfo = ref<UserInfo | null>(storage.get<UserInfo>(STORAGE_KEYS.userInfo));

  /** 登录中的 Promise，避免并发触发多次 wx.login */
  const loginPromise = ref<Promise<boolean> | null>(null);

  // -------------------------------------------------------------------- getter
  const isLoggedIn = computed(() => Boolean(accessToken.value));
  const isMember = computed(() => userInfo.value?.membership.isActive === true);
  const displayName = computed(() => userInfo.value?.nickname ?? 'SoulMap 用户');

  // -------------------------------------------------------------------- 内部
  const persistSession = (result: LoginResult): void => {
    accessToken.value = result.accessToken;
    refreshToken.value = result.refreshToken;
    // 服务端 expiresIn 为秒；本地留 30 秒安全余量，避免边界期请求被拒
    expireAt.value = Date.now() + Math.max(0, result.expiresIn - 30) * 1000;
    userInfo.value = result.user;

    storage.set(STORAGE_KEYS.accessToken, result.accessToken);
    storage.set(STORAGE_KEYS.refreshToken, result.refreshToken);
    storage.set(STORAGE_KEYS.accessTokenExpireAt, expireAt.value);
    storage.set(STORAGE_KEYS.userInfo, result.user);
  };

  const clearSession = (): void => {
    accessToken.value = null;
    refreshToken.value = null;
    expireAt.value = 0;
    userInfo.value = null;

    storage.removeAll([
      STORAGE_KEYS.accessToken,
      STORAGE_KEYS.refreshToken,
      STORAGE_KEYS.accessTokenExpireAt,
      STORAGE_KEYS.userInfo,
    ]);
  };

  /** 调用 wx.login 获取临时 code */
  const getWechatCode = (): Promise<string> =>
    new Promise((resolve, reject) => {
      uni.login({
        provider: 'weixin',
        success: (res) => {
          if (res.code) {
            resolve(res.code);
          } else {
            reject(new Error('微信登录未返回有效 code'));
          }
        },
        fail: (err) => reject(new Error(err.errMsg || '微信登录调用失败')),
      });
    });

  // -------------------------------------------------------------------- action

  /**
   * 静默登录：不弹授权框，仅用 wx.login 的 code 换取 openid 对应的账号
   * 首次进入小程序时调用；失败不抛异常（游客可继续浏览）
   */
  const silentLogin = async (): Promise<boolean> => {
    if (loginPromise.value) return loginPromise.value;
    if (isLoggedIn.value && Date.now() < expireAt.value) return true;

    loginPromise.value = (async () => {
      try {
        const code = await getWechatCode();
        const result = await http.post<LoginResult>(
          '/auth/wechat/login',
          { code },
          { needAuth: false, showError: false },
        );
        persistSession(result);
        return true;
      } catch (error) {
        console.warn('[auth] 静默登录失败：', (error as ApiError).message);
        return false;
      } finally {
        loginPromise.value = null;
      }
    })();

    return loginPromise.value;
  };

  /**
   * 刷新登录态（refresh token 旋转）
   * 由请求层在收到 401 时调用；返回新的 accessToken，失败返回 null
   */
  const refresh = async (): Promise<string | null> => {
    const currentRefreshToken = refreshToken.value;
    if (!currentRefreshToken) return null;

    try {
      const result = await http.post<LoginResult>(
        '/auth/refresh',
        { refreshToken: currentRefreshToken },
        { needAuth: false, showError: false },
      );
      persistSession(result);
      return result.accessToken;
    } catch (error) {
      const apiError = error as ApiError;
      // 凭证被复用或已失效：必须彻底登出，避免被服务端判定为凭证泄露
      if (
        apiError.code === ERROR_CODES.REFRESH_TOKEN_INVALID ||
        apiError.code === ERROR_CODES.REFRESH_TOKEN_REUSED ||
        apiError.code === ERROR_CODES.TOKEN_REVOKED
      ) {
        clearSession();
      }
      return null;
    }
  };

  /** 主动登出（服务端会作废当前 refreshToken） */
  const logout = async (options: { allDevices?: boolean } = {}): Promise<void> => {
    try {
      await http.post(
        options.allDevices ? '/auth/logout-all' : '/auth/logout',
        {},
        { showError: false, needAuth: true },
      );
    } catch {
      // 服务端调用失败也必须清理本地状态，否则用户无法退出
    } finally {
      clearSession();
    }
  };

  /** accessToken 是否即将过期（供请求前主动刷新用） */
  const isTokenExpiringSoon = (): boolean => Date.now() + REFRESH_AHEAD_MS >= expireAt.value;

  /** 拉取最新用户信息（修改昵称/头像后刷新） */
  const fetchUserInfo = async (): Promise<void> => {
    const user = await http.get<UserInfo>('/users/me', undefined, { showError: false });
    userInfo.value = user;
    storage.set(STORAGE_KEYS.userInfo, user);
  };

  /** 本地更新用户信息（乐观更新，避免多一次请求） */
  const patchUserInfo = (patch: Partial<UserInfo>): void => {
    if (!userInfo.value) return;
    userInfo.value = { ...userInfo.value, ...patch };
    storage.set(STORAGE_KEYS.userInfo, userInfo.value);
  };

  // 向请求层注册钩子（模块加载时执行一次）
  registerRequestHooks({
    getAccessToken: () => accessToken.value,
    refreshAccessToken: refresh,
    onUnauthorized: () => {
      clearSession();
    },
  });

  return {
    // state
    accessToken,
    refreshToken,
    expireAt,
    userInfo,
    // getter
    isLoggedIn,
    isMember,
    displayName,
    // action
    silentLogin,
    refresh,
    logout,
    fetchUserInfo,
    patchUserInfo,
    clearSession,
    isTokenExpiringSoon,
  };
});
