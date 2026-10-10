/**
 * 统一请求层（Axios 语义的小程序实现）
 *
 * 架构决策 ADR-006：小程序没有 XHR，axios 需要额外 adapter 且体积偏大，
 * 因此自研本模块，对外提供与 axios 一致的开发体验：
 *   · 拦截器式处理：请求前注入凭证，响应后解包统一包络
 *   · 401 自动续期（single-flight，防止并发风暴）
 *   · 超时 / 幂等 GET 重试 / 请求取消
 *   · 统一错误对象 ApiError（页面可按错误码分支）
 *   · loading 引用计数
 *
 * 依赖方向：本模块不 import 任何 store（避免循环依赖），
 *           而是通过 registerRequestHooks 由 auth store 反向注册回调。
 */

import { env, timeout as timeoutConfig } from '@/config/env';
import { toast } from '@/utils/toast';
import { createRequestId } from '@/utils/request-id';
import { ApiError, ERROR_CODES, type ApiResponse, type RequestOptions } from './types';

// ============================================================================
// 外部钩子：由 store/auth 注册，避免 api ←→ store 循环依赖
// ============================================================================

interface RequestHooks {
  /** 获取当前 accessToken；未登录返回 null */
  getAccessToken: () => string | null;
  /** 刷新登录态；返回新的 accessToken，失败返回 null */
  refreshAccessToken: () => Promise<string | null>;
  /** 登录态彻底失效时的回调（跳转登录页、清理状态） */
  onUnauthorized: () => void;
}

const hooks: RequestHooks = {
  getAccessToken: () => null,
  refreshAccessToken: async () => null,
  onUnauthorized: () => undefined,
};

export const registerRequestHooks = (partial: Partial<RequestHooks>): void => {
  Object.assign(hooks, partial);
};

// ============================================================================
// 请求取消：同一 cancelKey 的后发请求会取消先发请求（如搜索联想、切页加载）
// ============================================================================

const pendingTasks = new Map<string, UniApp.RequestTask>();

const registerTask = (cancelKey: string, task: UniApp.RequestTask): void => {
  const previous = pendingTasks.get(cancelKey);
  if (previous) {
    try {
      previous.abort();
    } catch {
      // abort 失败无需处理（任务可能已完成）
    }
  }
  pendingTasks.set(cancelKey, task);
};

const clearTask = (cancelKey: string, task: UniApp.RequestTask): void => {
  if (pendingTasks.get(cancelKey) === task) {
    pendingTasks.delete(cancelKey);
  }
};

/** 主动取消某个 cancelKey 对应的在途请求（页面 onUnload 时调用） */
export const cancelRequest = (cancelKey: string): void => {
  const task = pendingTasks.get(cancelKey);
  if (!task) return;
  try {
    task.abort();
  } catch {
    // 忽略
  }
  pendingTasks.delete(cancelKey);
};

/**
 * 收到 401 时**不应**尝试续期的错误码：
 * 这些表示凭证已被服务端判定失效（refresh token 失效/被复用/账号封禁），
 * 继续刷新只会产生无效请求，正确做法是直接登出。
 */
const NON_REFRESHABLE_CODES: readonly number[] = [
  ERROR_CODES.REFRESH_TOKEN_INVALID,
  ERROR_CODES.REFRESH_TOKEN_REUSED,
  ERROR_CODES.TOKEN_REVOKED,
  ERROR_CODES.ACCOUNT_BANNED,
];

// ============================================================================
// 401 续期：single-flight，多个并发 401 只触发一次刷新
// ============================================================================

let refreshPromise: Promise<string | null> | null = null;

const refreshOnce = async (): Promise<string | null> => {
  if (!refreshPromise) {
    refreshPromise = hooks
      .refreshAccessToken()
      .catch(() => null)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
};

// ============================================================================
// loading 引用计数（与 utils/toast 的 withLoading 独立，用于请求级 loading）
// ============================================================================

let requestLoadingCount = 0;

const showRequestLoading = (title: string): void => {
  if (requestLoadingCount === 0) {
    uni.showLoading({ title, mask: true });
  }
  requestLoadingCount += 1;
};

const hideRequestLoading = (): void => {
  requestLoadingCount = Math.max(0, requestLoadingCount - 1);
  if (requestLoadingCount === 0) {
    uni.hideLoading();
  }
};

// ============================================================================
// URL 与请求头组装
// ============================================================================

const isAbsoluteUrl = (url: string): boolean => /^https?:\/\//i.test(url);

const buildUrl = (url: string, data?: unknown, method?: string): string => {
  const fullUrl = isAbsoluteUrl(url) ? url : `${env.baseUrl}${url.startsWith('/') ? url : `/${url}`}`;

  if (method !== 'GET' || !data || typeof data !== 'object') {
    return fullUrl;
  }

  const query = Object.entries(data as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      // 数组按重复键序列化（与后端 query parser 的默认行为一致）
      if (Array.isArray(value)) {
        return value.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`).join('&');
      }
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    })
    .filter(Boolean)
    .join('&');

  return query ? `${fullUrl}${fullUrl.includes('?') ? '&' : '?'}${query}` : fullUrl;
};

/**
 * 组装请求头
 *
 * @param explicitToken 显式指定的凭证。401 续期后的重放必须显式传入新 token，
 *                      不能依赖 getAccessToken() —— 否则 store 尚未持久化完成时会拿到旧值。
 */
const buildHeaders = (
  options: RequestOptions,
  requestId: string,
  explicitToken?: string | null,
): Record<string, string> => {
  const needAuth = options.needAuth !== false;
  const token = needAuth ? (explicitToken !== undefined ? explicitToken : hooks.getAccessToken()) : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Request-Id': requestId,
    'X-Platform': env.platform,
    'X-Client-Version': env.clientVersion,
    ...options.header,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.idempotencyKey) {
    headers['X-Idempotency-Key'] = options.idempotencyKey;
  }

  return headers;
};

// ============================================================================
// 底层单次请求
// ============================================================================

interface RawResult {
  statusCode: number;
  body: ApiResponse<unknown> | null;
  /** 网络层错误信息（超时、断网等） */
  networkError?: string;
}

const rawRequest = (params: {
  url: string;
  method: string;
  data?: unknown;
  headers: Record<string, string>;
  timeoutMs: number;
  cancelKey?: string;
}): Promise<RawResult> =>
  new Promise<RawResult>((resolve) => {
    const task = uni.request({
      url: params.url,
      method: params.method as UniApp.RequestOptions['method'],
      data: params.method === 'GET' ? undefined : (params.data as Record<string, unknown> | undefined),
      header: params.headers,
      timeout: params.timeoutMs,
      dataType: 'json',
      success: (res) => {
        const body = res.data as ApiResponse<unknown> | null;
        resolve({ statusCode: res.statusCode, body });
      },
      fail: (err) => {
        resolve({ statusCode: 0, body: null, networkError: err.errMsg || '网络请求失败' });
      },
      complete: () => {
        if (params.cancelKey) {
          clearTask(params.cancelKey, task);
        }
      },
    });

    if (params.cancelKey) {
      registerTask(params.cancelKey, task);
    }
  });

// ============================================================================
// 错误归一化
// ============================================================================

const toApiError = (result: RawResult): ApiError => {
  // 网络层失败（无 HTTP 响应）
  if (result.statusCode === 0) {
    const isTimeout = (result.networkError ?? '').includes('timeout');
    return new ApiError({
      code: ERROR_CODES.UNKNOWN,
      message: isTimeout ? '请求超时，请检查网络后重试' : '网络连接失败，请检查网络设置',
      httpStatus: 0,
      isNetworkError: true,
    });
  }

  const body = result.body;

  // 服务端返回了非包络结构（网关错误、HTML 错误页等）
  if (!body || typeof body.code !== 'number') {
    return new ApiError({
      code: ERROR_CODES.UNKNOWN,
      message: result.statusCode >= 500 ? '服务开小差了，请稍后重试' : '请求失败，请稍后重试',
      httpStatus: result.statusCode,
    });
  }

  return new ApiError({
    code: body.code,
    message: body.message || '请求失败',
    httpStatus: result.statusCode,
    requestId: body.requestId,
    details: body.details,
  });
};

// ============================================================================
// 主请求方法
// ============================================================================

const MAX_GET_RETRY = 1;

const execute = async (options: RequestOptions): Promise<unknown> => {
  const method = options.method ?? 'GET';
  const requestId = createRequestId();
  const timeoutMs = options.timeout ?? timeoutConfig.default;
  const url = buildUrl(options.url, options.data, method);

  const loadingTitle = typeof options.loading === 'string' ? options.loading : '加载中';
  const showLoading = options.loading === true || typeof options.loading === 'string';
  if (showLoading) {
    showRequestLoading(loadingTitle);
  }

  // 幂等的 GET 允许自动重试；写请求绝不自动重试（避免重复下单/重复提交）
  const maxRetry = method === 'GET' ? (options.retry ?? MAX_GET_RETRY) : (options.retry ?? 0);

  /**
   * 本次请求实际使用的凭证。
   *
   * 之所以要显式跟踪，是为了正确处理「并发 401」：
   * 若续期完成得很快（例如本地缓存命中、极低网络延迟），后续请求回到 401 分支时
   * hooks 里的 token 已经变了，此时应当**直接复用新凭证重放**，而不是再发起一次续期。
   * 这既避免了续期风暴，也修复了「续期比 401 到达更快时重复刷新」的真实竞态。
   */
  let tokenUsed: string | null | undefined = options.needAuth === false ? null : hooks.getAccessToken();

  try {
    let attempt = 0;

    for (;;) {
      const headers = buildHeaders(options, requestId, tokenUsed);
      const result = await rawRequest({
        url,
        method,
        data: options.data,
        headers,
        timeoutMs,
        cancelKey: options.cancelKey,
      });

      // ---------------- 成功 ----------------
      if (result.statusCode >= 200 && result.statusCode < 300 && result.body?.code === ERROR_CODES.SUCCESS) {
        return result.body.data;
      }

      const error = toApiError(result);

      // ---------------- 网络错误重试 ----------------
      if (error.isNetworkError && attempt < maxRetry) {
        attempt += 1;
        // 指数退避 + 抖动，避免瞬时故障下的重试风暴
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt + Math.random() * 200));
        continue;
      }

      // ---------------- 401 自动续期 ----------------
      if (error.isUnauthorized) {
        const refreshable = !NON_REFRESHABLE_CODES.includes(error.code);

        if (refreshable) {
          const latestToken = hooks.getAccessToken();
          const alreadyRefreshedByOthers = Boolean(latestToken) && latestToken !== (tokenUsed ?? null);

          // 情况一：其他并发请求已经完成续期 —— 直接复用，不再刷新
          // 情况二：需要自己发起续期（single-flight，多个并发只会有一次真实请求）
          const newToken = alreadyRefreshedByOthers ? latestToken : await refreshOnce();

          if (newToken) {
            tokenUsed = newToken;

            // 用新凭证重放一次（不再重试，避免死循环）
            const replayHeaders = buildHeaders(options, requestId, newToken);
            const replay = await rawRequest({
              url,
              method,
              data: options.data,
              headers: replayHeaders,
              timeoutMs,
              cancelKey: options.cancelKey,
            });

            if (replay.statusCode >= 200 && replay.statusCode < 300 && replay.body?.code === ERROR_CODES.SUCCESS) {
              return replay.body.data;
            }
            throw toApiError(replay);
          }
        }

        hooks.onUnauthorized();
      }

      throw error;
    }
  } finally {
    if (showLoading) {
      hideRequestLoading();
    }
  }
};

/**
 * 发起请求并返回业务数据（已解包）
 *
 * @throws {ApiError} 业务失败或网络失败
 */
export const request = async <T>(options: RequestOptions): Promise<T> => {
  try {
    const data = await execute(options);
    return data as T;
  } catch (error) {
    const apiError =
      error instanceof ApiError
        ? error
        : new ApiError({ code: ERROR_CODES.UNKNOWN, message: '请求失败，请稍后重试', httpStatus: 0 });

    // 统一错误提示；调用方可传 showError: false 自行处理
    if (options.showError !== false) {
      toast.error(apiError.message);
    }

    throw apiError;
  }
};

/** 便捷方法 */
export const http = {
  get: <T>(url: string, data?: Record<string, unknown>, options?: Partial<RequestOptions>): Promise<T> =>
    request<T>({ url, method: 'GET', data, ...options }),

  post: <T>(url: string, data?: unknown, options?: Partial<RequestOptions>): Promise<T> =>
    request<T>({ url, method: 'POST', data, ...options }),

  put: <T>(url: string, data?: unknown, options?: Partial<RequestOptions>): Promise<T> =>
    request<T>({ url, method: 'PUT', data, ...options }),

  patch: <T>(url: string, data?: unknown, options?: Partial<RequestOptions>): Promise<T> =>
    request<T>({ url, method: 'PATCH', data, ...options }),

  delete: <T>(url: string, data?: unknown, options?: Partial<RequestOptions>): Promise<T> =>
    request<T>({ url, method: 'DELETE', data, ...options }),
};

/**
 * 分页请求便捷封装
 * 后端分页响应结构为 data: { items, total, page, pageSize, hasNext }
 */
export const httpPage = async <T>(
  url: string,
  query: { page?: number; pageSize?: number } & Record<string, unknown> = {},
  options?: Partial<RequestOptions>,
): Promise<import('./types').PaginatedData<T>> => {
  const result = await request<import('./types').PaginatedData<T>>({
    url,
    method: 'GET',
    data: { page: 1, pageSize: 20, ...query },
    ...options,
  });

  // 防御：服务端契约异常时归一为空分页，避免页面崩溃
  if (!result || !Array.isArray(result.items)) {
    return { items: [], total: 0, page: query.page ?? 1, pageSize: query.pageSize ?? 20, hasNext: false };
  }

  return result;
};
