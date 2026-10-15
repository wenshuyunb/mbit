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

import {
  refreshSession,
  wechatLogin,
  type AuthLoginResult,
  type AuthRefreshResult,
  type AuthUserView,
} from '@/api/auth';
import { http, registerRequestHooks } from '@/api/request';
import { ERROR_CODES, type ApiError } from '@/api/types';
import { getMe, updateProfile, type MeView, type UserGenderCode } from '@/api/user';
import { STORAGE_KEYS } from '@/config/constants';
import { storage } from '@/utils/storage';

/**
 * 当前用户信息
 *
 * 统一采用**登录响应**的用户形状（后端 `AuthUserView`），`/users/me`（后端 `MeView`）
 * 的结果由 `toUserInfo` 归一化过来。这样 store 只有一个用户形状，
 * 页面无需同时考虑两种来源的差异。
 */
export type UserInfo = AuthUserView & {
  /**
   * 性别**是否已被询问过**（ADR-039）
   *
   * `undefined` 表示"还不知道"（登录响应里没有这个字段，只有 `/users/me` 才有），
   * `false` 才是"确定没问过"。**引导只在明确为 `false` 时弹** ——
   * 把 `undefined` 也当成"没问过"的话，每次冷启动都会因为还没拉到 `/users/me`
   * 而闪一下性别弹窗。
   */
  genderDeclared?: boolean;
};

/** 登录响应（保留本地别名，避免调用方改动） */
export type LoginResult = AuthLoginResult;

/**
 * 把 `/users/me` 的响应归一化为 `UserInfo`
 *
 * 两个视图的差异：`MeView` 把画像与会员作为**可选块**（需 `include` 才返回），
 * 且没有顶层的 `hasProfile` / `mbtiType` —— 它们要从 `profile` 块推导。
 */
const toUserInfo = (me: MeView): UserInfo => ({
  id: me.id,
  nickname: me.nickname,
  avatarUrl: me.avatarUrl,
  gender: me.gender,
  genderDeclared: me.genderDeclared,
  birthday: me.birthday,
  phoneBound: me.phoneBound,
  status: me.status,
  ageVerified: me.ageVerified,
  // 有画像块即代表测过（后端在 include=profile 且存在画像时才返回该块）
  hasProfile: me.profile !== undefined,
  mbtiType: me.profile?.mbtiType ?? null,
  membership: {
    isActive: me.membership?.isActive ?? false,
    planCode: me.membership?.planCode ?? null,
    expiresAt: me.membership?.expiresAt ?? null,
  },
  createdAt: me.createdAt,
});

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

  /**
   * 是否需要弹「你是男生还是女生」引导（ADR-039）
   *
   * 只在**服务端明确说"没问过"**（`genderDeclared === false`）时为真：
   * `undefined`（还没拉到 `/users/me`）不算 —— 否则每次冷启动都会闪一下弹窗。
   */
  const needsGenderSetup = computed(() => isLoggedIn.value && userInfo.value?.genderDeclared === false);

  /** 性别展示文案（个人中心用；"不想说"与"没填"在这里是同一个展示结果） */
  const genderText = computed(() => {
    const gender = userInfo.value?.gender;
    if (gender === 'MALE') return '男生';
    if (gender === 'FEMALE') return '女生';
    return '未设置';
  });

  // -------------------------------------------------------------------- 内部
  /**
   * 持久化令牌
   *
   * 与用户信息**分开**持久化是刻意的：`POST /auth/refresh` 只返回令牌、不返回 `user`
   * （契约 §3.1.2）。此前两者耦合在同一个 `persistSession` 里，于是每次刷新登录态
   * 都会把 `userInfo` 覆盖成 `undefined` —— 表现为昵称变回默认值、头像消失、
   * 会员状态丢失，而且**只在令牌过期后才复现**，极难排查。
   */
  const persistTokens = (tokens: Pick<AuthRefreshResult, 'accessToken' | 'refreshToken' | 'expiresIn'>): void => {
    accessToken.value = tokens.accessToken;
    refreshToken.value = tokens.refreshToken;
    // 服务端 expiresIn 为秒；本地留 30 秒安全余量，避免边界期请求被拒
    expireAt.value = Date.now() + Math.max(0, tokens.expiresIn - 30) * 1000;

    storage.set(STORAGE_KEYS.accessToken, tokens.accessToken);
    storage.set(STORAGE_KEYS.refreshToken, tokens.refreshToken);
    storage.set(STORAGE_KEYS.accessTokenExpireAt, expireAt.value);
  };

  /** 持久化登录结果（令牌 + 用户信息） */
  const persistLogin = (result: AuthLoginResult): void => {
    persistTokens(result);
    userInfo.value = result.user;
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
        const result = await wechatLogin({ code });
        persistLogin(result);
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
      const result = await refreshSession(currentRefreshToken);
      // 只更新令牌：刷新响应**不含** user，若在此处写 userInfo 会把它清空
      persistTokens(result);
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

  /**
   * 拉取最新用户信息（修改昵称/头像后刷新）
   *
   * 显式请求 `profile` 与 `membership` 两个扩展块：`/users/me` 默认不返回它们，
   * 而 `hasProfile` / `mbtiType` / 会员状态都来自这两个块。
   */
  const fetchUserInfo = async (): Promise<void> => {
    const me = await getMe({ include: ['profile', 'membership'] });
    userInfo.value = toUserInfo(me);
    storage.set(STORAGE_KEYS.userInfo, userInfo.value);
  };

  /** 本地更新用户信息（乐观更新，避免多一次请求） */
  const patchUserInfo = (patch: Partial<UserInfo>): void => {
    if (!userInfo.value) return;
    userInfo.value = { ...userInfo.value, ...patch };
    storage.set(STORAGE_KEYS.userInfo, userInfo.value);
  };

  /**
   * 保存性别（ADR-039）
   *
   * ⚠ 必须落服务端，不能只改本地：性别决定**出哪一套场景题**，
   * 换设备或清缓存后本地标记就没了，而服务端才是权威；
   * 且"不想说"也要发请求 —— 服务端据此记下"已经问过了"。
   */
  const saveGender = async (gender: UserGenderCode): Promise<void> => {
    const updated = await updateProfile({ gender });
    patchUserInfo({ gender: updated.gender, genderDeclared: updated.genderDeclared });
  };

  // 向请求层注册钩子（模块加载时执行一次）
  registerRequestHooks({
    getAccessToken: () => accessToken.value,
    refreshAccessToken: refresh,
    /**
     * 供请求层在「还没有令牌」时等待首轮静默登录结束
     *
     * 直接复用 `silentLogin()` —— 它内部本来就有 `loginPromise` single-flight，
     * 所以首屏多个并发请求只会触发**一次** `wx.login`，不会重复换码。
     */
    ensureAuthReady: silentLogin,
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
    needsGenderSetup,
    genderText,
    // action
    silentLogin,
    refresh,
    logout,
    fetchUserInfo,
    patchUserInfo,
    saveGender,
    clearSession,
    isTokenExpiringSoon,
  };
});
