/**
 * 认证 store 测试
 *
 * 首要目的：锁死一个**只在令牌过期后才复现**的缺陷 ——
 * `refresh()` 此前与登录共用同一个 `persistSession`，而 `POST /auth/refresh`
 * 的响应里**没有 `user` 字段**，于是每次刷新登录态都会把 `userInfo` 覆盖成
 * `undefined`：昵称变回默认值、头像消失、会员状态丢失。
 *
 * 这类缺陷人工测试几乎撞不到（要先等 accessToken 过期），
 * 而 TypeScript 也发现不了 —— 因为错误的那份 interface 把自己写成了含 `user` 的样子。
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/store/auth';

/** 按 URL 片段路由的响应表 */
const respondByUrl = (routes: Record<string, unknown>): { urls: string[] } => {
  const urls: string[] = [];

  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    const url = String(options['url']);
    urls.push(url);

    const matched = Object.keys(routes).find((key) => url.includes(key));

    setTimeout(() => {
      if (matched === undefined) {
        (options['fail'] as (res: unknown) => void)({ errMsg: 'request:fail 未配置的地址' });
        return;
      }
      (options['success'] as (res: unknown) => void)({
        statusCode: 200,
        data: { code: 0, message: 'ok', data: routes[matched], requestId: 'req_test', timestamp: '' },
      });
    }, 0);
  }) as unknown as typeof uni.request);

  return { urls };
};

/** 后端 `LoginResult` 的真实结构（含 user 与 session） */
const LOGIN_RESULT = {
  accessToken: 'access_token_1',
  refreshToken: 'refresh_token_1',
  tokenType: 'Bearer',
  expiresIn: 7200,
  refreshExpiresIn: 2592000,
  isNewUser: false,
  user: {
    id: 'user-1',
    nickname: '小明',
    avatarUrl: 'https://cdn.example.com/avatar.webp',
    gender: 'MALE',
    birthday: null,
    phoneBound: false,
    status: 'ACTIVE',
    ageVerified: true,
    hasProfile: true,
    mbtiType: 'INFP',
    membership: { isActive: true, planCode: 'MEMBER_YEAR', expiresAt: '2027-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  session: {
    sessionId: 'session-1',
    issuedAt: '2026-10-12T00:00:00.000Z',
    expiresAt: '2027-10-12T00:00:00.000Z',
    deviceId: null,
  },
};

/** 后端 `RefreshResult` 的真实结构 —— **没有 user** */
const REFRESH_RESULT = {
  accessToken: 'access_token_2',
  refreshToken: 'refresh_token_2',
  tokenType: 'Bearer',
  expiresIn: 7200,
  refreshExpiresIn: 2592000,
  rotatedAt: '2026-10-12T01:00:00.000Z',
};

/** 后端 `MeView` 的真实结构（可选块 form） */
const ME_VIEW = {
  id: 'user-1',
  nickname: '小明',
  avatarUrl: 'https://cdn.example.com/avatar.webp',
  gender: 'MALE',
  genderDeclared: true,
  birthday: null,
  ageRange: null,
  phoneBound: true,
  phoneMasked: '138****6721',
  status: 'ACTIVE',
  ageVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  version: 3,
  profile: {
    profileId: 'p1',
    mbtiType: 'INFP',
    engineVersion: 'pe-v1.0.0',
    version: 1,
    confidence: 25,
    bigFive: { openness: 72.5, conscientiousness: 48, extraversion: 35.5, agreeableness: 66, neuroticism: 55 },
    generatedAt: '2026-10-12T00:00:00.000Z',
  },
  membership: {
    isActive: true,
    planCode: 'MEMBER_YEAR',
    planName: '年度会员',
    startedAt: '2026-10-12T00:00:00.000Z',
    expiresAt: '2027-10-12T00:00:00.000Z',
    autoRenew: false,
    remainingDays: 365,
  },
};

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('登录', () => {
  it('登录成功后写入用户信息（含正确的头像字段名 avatarUrl）', async () => {
    respondByUrl({ '/auth/wechat/login': LOGIN_RESULT });
    const store = useAuthStore();

    await store.silentLogin();

    expect(store.isLoggedIn).toBe(true);
    expect(store.userInfo?.nickname).toBe('小明');
    // 后端字段名是 avatarUrl，写成 avatar 会永远读不到
    expect(store.userInfo?.avatarUrl).toBe('https://cdn.example.com/avatar.webp');
    expect(store.displayName).toBe('小明');
  });

  it('登录响应里的会员摘要用 isActive / expiresAt', async () => {
    respondByUrl({ '/auth/wechat/login': LOGIN_RESULT });
    const store = useAuthStore();

    await store.silentLogin();

    expect(store.isMember).toBe(true);
    expect(store.userInfo?.membership.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('刷新令牌（核心回归）', () => {
  it('刷新后必须保留用户信息（此前会被覆盖成 undefined）', async () => {
    respondByUrl({ '/auth/wechat/login': LOGIN_RESULT, '/auth/refresh': REFRESH_RESULT });
    const store = useAuthStore();
    await store.silentLogin();

    const before = store.userInfo;

    const token = await store.refresh();

    expect(token).toBe('access_token_2');
    // 关键断言：刷新响应不含 user，绝不能因此清空本地用户信息
    expect(store.userInfo).toEqual(before);
  });

  it('刷新后昵称、头像、会员状态都不丢', async () => {
    respondByUrl({ '/auth/wechat/login': LOGIN_RESULT, '/auth/refresh': REFRESH_RESULT });
    const store = useAuthStore();
    await store.silentLogin();

    await store.refresh();

    expect(store.displayName).toBe('小明');
    expect(store.userInfo?.avatarUrl).toBe('https://cdn.example.com/avatar.webp');
    expect(store.isMember).toBe(true);
  });

  it('刷新后令牌确实被更新为新值', async () => {
    respondByUrl({ '/auth/wechat/login': LOGIN_RESULT, '/auth/refresh': REFRESH_RESULT });
    const store = useAuthStore();
    await store.silentLogin();

    await store.refresh();

    expect(store.accessToken).toBe('access_token_2');
    expect(store.refreshToken).toBe('refresh_token_2');
  });
});

describe('fetchUserInfo：把 MeView 归一化为统一用户形状', () => {
  it('从 profile 块推导 hasProfile 与 mbtiType（MeView 没有顶层字段）', async () => {
    respondByUrl({ '/users/me': ME_VIEW });
    const store = useAuthStore();

    await store.fetchUserInfo();

    expect(store.userInfo?.hasProfile).toBe(true);
    expect(store.userInfo?.mbtiType).toBe('INFP');
  });

  it('显式请求 profile 与 membership 扩展块（默认不返回）', async () => {
    const { urls } = respondByUrl({ '/users/me': ME_VIEW });
    const store = useAuthStore();

    await store.fetchUserInfo();

    /**
     * ⚠ 这里**不能断言 `urls[0]`**。
     *
     * 请求层在"还没有令牌"时会先等首轮静默登录结束（冷启动竞态修复），
     * 因此未登录状态下**第一个请求是 `/auth/wechat/login`**，`/users/me` 在其后。
     * 原来的 `urls[0]` 写法在修复前恰好成立 —— 因为那时 `fetchUserInfo` 会在
     * **没有令牌**的情况下直接打 `/users/me`（真实环境就是一次 401，只是被 mock 盖住了）。
     */
    const meUrl = urls.find((url) => url.includes('/users/me'));

    expect(meUrl).toBeDefined();
    expect(meUrl).toContain('include=');
    expect(meUrl).toContain('profile');
    expect(meUrl).toContain('membership');
  });

  it('归一化后的会员摘要与登录响应同形（isActive / expiresAt / planCode）', async () => {
    respondByUrl({ '/users/me': ME_VIEW });
    const store = useAuthStore();

    await store.fetchUserInfo();

    expect(store.userInfo?.membership).toEqual({
      isActive: true,
      planCode: 'MEMBER_YEAR',
      expiresAt: '2027-10-12T00:00:00.000Z',
    });
  });

  it('没有画像块时 hasProfile 为 false，且不抛异常', async () => {
    respondByUrl({ '/users/me': { ...ME_VIEW, profile: undefined } });
    const store = useAuthStore();

    await store.fetchUserInfo();

    expect(store.userInfo?.hasProfile).toBe(false);
    expect(store.userInfo?.mbtiType).toBeNull();
  });

  it('没有会员块时降级为未开通，而不是崩在 undefined 上', async () => {
    respondByUrl({ '/users/me': { ...ME_VIEW, membership: undefined } });
    const store = useAuthStore();

    await store.fetchUserInfo();

    expect(store.userInfo?.membership.isActive).toBe(false);
    expect(store.userInfo?.membership.expiresAt).toBeNull();
    expect(store.isMember).toBe(false);
  });

  it('头像字段来自 MeView 的 avatarUrl', async () => {
    respondByUrl({ '/users/me': ME_VIEW });
    const store = useAuthStore();

    await store.fetchUserInfo();

    expect(store.userInfo?.avatarUrl).toBe('https://cdn.example.com/avatar.webp');
  });
});

/**
 * 性别引导的开关与保存（ADR-039）
 *
 * 这一组锁的是两个**静默失败**方向：
 *   · 该弹不弹 → 用户永远拿中性版场景，界面上完全看不出异常；
 *   · 不该弹却弹 → 选了"不想说"的人每次冷启动都被再问一遍。
 * 两者的区别只在 `genderDeclared` 一个字段上，而这字段只有 `/users/me` 才返回。
 */
describe('性别引导（ADR-039）', () => {
  /** 登录（`needsGenderSetup` 要求已登录）+ 拉一次 `/users/me` */
  const loginAndFetch = async (me: Record<string, unknown>): Promise<ReturnType<typeof useAuthStore>> => {
    respondByUrl({ '/auth/wechat/login': LOGIN_RESULT, '/users/me': me });
    const store = useAuthStore();
    await store.silentLogin();
    await store.fetchUserInfo();
    return store;
  };

  it('【关键】genderDeclared=false 时才需要引导', async () => {
    const store = await loginAndFetch({ ...ME_VIEW, gender: 'UNKNOWN', genderDeclared: false });

    expect(store.isLoggedIn).toBe(true);
    expect(store.needsGenderSetup).toBe(true);
  });

  it('【关键】选过「不想说」的人（gender=UNKNOWN 但问过了）不再被问', async () => {
    const store = await loginAndFetch({ ...ME_VIEW, gender: 'UNKNOWN', genderDeclared: true });

    expect(store.needsGenderSetup).toBe(false);
  });

  it('已选性别的人不需要引导', async () => {
    const store = await loginAndFetch(ME_VIEW);

    expect(store.needsGenderSetup).toBe(false);
  });

  it('【关键】还不知道（登录响应里没有该字段）时**不弹**，避免冷启动闪一下弹窗', async () => {
    respondByUrl({ '/auth/wechat/login': LOGIN_RESULT });
    const store = useAuthStore();
    await store.silentLogin();

    // 登录响应（AuthUserView）不带 genderDeclared → undefined ≠ false
    expect(store.isLoggedIn).toBe(true);
    expect(store.userInfo?.genderDeclared).toBeUndefined();
    expect(store.needsGenderSetup).toBe(false);
  });

  it('saveGender 会落服务端并把结果写回本地（「不想说」也发请求）', async () => {
    const PATC_H_RESULT = {
      id: 'user-1',
      nickname: '小明',
      avatarUrl: null,
      gender: 'UNKNOWN',
      genderDeclared: true,
      birthday: null,
      ageRange: null,
      version: 4,
      updatedAt: '2026-10-15T00:00:00.000Z',
    };

    const { urls } = respondByUrl({ '/auth/wechat/login': LOGIN_RESULT, '/users/me': PATC_H_RESULT });
    const store = useAuthStore();
    await store.silentLogin();

    await store.saveGender('UNKNOWN');

    expect(urls.some((url) => url.includes('/users/me'))).toBe(true);
    // 本地状态跟随**服务端返回值**，而不是自己写一个 genderDeclared=true
    expect(store.userInfo?.gender).toBe('UNKNOWN');
    expect(store.userInfo?.genderDeclared).toBe(true);
    expect(store.needsGenderSetup).toBe(false);
  });

  it('genderText 只区分男女，其余一律显示未设置', async () => {
    const store = await loginAndFetch({ ...ME_VIEW, gender: 'MALE' });
    expect(store.genderText).toBe('男生');

    store.patchUserInfo({ gender: 'FEMALE' });
    expect(store.genderText).toBe('女生');

    store.patchUserInfo({ gender: 'UNKNOWN' });
    expect(store.genderText).toBe('未设置');
  });
});
