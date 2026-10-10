/**
 * axios 实例与统一请求层
 *
 * 职责（与架构 §7.1 小程序请求层语义对齐，Admin 端使用真正的 axios）：
 *   1. 注入 `Authorization: Bearer <AdminAccessToken>`、`X-Request-Id`、`X-Platform: admin`
 *      —— `X-Platform` 让后端校验 jwt realm 是否匹配（API_DESIGN §2.2 / §2.7.1）。
 *   2. 解包后端统一响应包络 `{ code, message, data }`，业务错误码统一抛 `ApiError`。
 *   3. 登录态失效（HTTP 401 或认证类错误码）触发**未授权处理器**：清理内存中的令牌并跳登录页。
 *   4. 全局错误提示：可通过 `silent: true` 在单次请求上关闭（例如登录页需要页内提示）。
 *
 * 架构约束（§9.2）：管理员 AccessToken / RefreshToken **仅存内存**，
 * 因此本模块不读写 localStorage，而是通过 `setTokenProvider` 从 auth store 取值，
 * 这样 api 层不反向依赖 store，避免循环依赖。
 */

import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { ADMIN_PLATFORM, ErrorCode, errorMessageOf } from '@/constants';
import { REQUEST_ID_HEADER, generateRequestId } from '@/utils/request-id';
import { ApiError, isApiResponse, isRecord, type ErrorDetail } from './types';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /**
     * 静默请求：不触发全局错误提示，由调用方自行处理（如登录页的页内错误提示）。
     * 默认为 false，即所有失败都会经 `setErrorNotifier` 注册的通知器提示用户。
     */
    silent?: boolean;
  }
}

/** 未配置 VITE_API_BASE_URL 时的兜底地址（后端统一前缀 /api/v1，架构 §19.2） */
export const DEFAULT_API_BASE_URL = '/api/v1';

/** 默认超时（普通管理接口 15s；AI 相关长任务接口在 Phase 7 单独放宽） */
export const DEFAULT_TIMEOUT_MS = 15000;

/** 令牌提供者：由 auth store 注册，返回内存中的 AccessToken */
export type TokenProvider = () => string | null;

/** 未授权处理器：由 router 层注册（清理登录态 + 跳登录页） */
export type UnauthorizedHandler = () => void;

/** 全局错误通知器：由 main.ts 注册（Element Plus ElMessage） */
export type ErrorNotifier = (error: ApiError) => void;

let tokenProvider: TokenProvider = () => null;
let unauthorizedHandler: UnauthorizedHandler = defaultUnauthorizedHandler;
let errorNotifier: ErrorNotifier = () => undefined;

/**
 * 注册 AccessToken 提供者。
 * 在 main.ts 中注册：`setTokenProvider(() => useAuthStore().accessToken)`。
 */
export const setTokenProvider = (provider: TokenProvider): void => {
  tokenProvider = provider;
};

/**
 * 注册未授权处理器（401 / 认证类错误码）。
 * 在 router/index.ts 中注册：清理内存登录态并跳转 /login?redirect=...
 * 之所以用「注册」而不是在本文件直接 import router，是为了避免 api ↔ router ↔ store 循环依赖。
 */
export const setUnauthorizedHandler = (handler: UnauthorizedHandler): void => {
  unauthorizedHandler = handler;
};

/** 注册全局错误通知器 */
export const setErrorNotifier = (notifier: ErrorNotifier): void => {
  errorNotifier = notifier;
};

/**
 * 兜底未授权处理：未注册处理器时整页跳转登录页。
 * 该分支正常不会命中（应用启动即注册 router 处理器），仅在非 SPA 集成或测试环境中兜底。
 */
function defaultUnauthorizedHandler(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.location.replace === 'function') {
      window.location.replace('/login');
    }
  } catch {
    // 非浏览器环境（SSR / 单元测试）无法跳转，忽略
  }
}

/** 读取当前生效的接口基础地址 */
const resolveBaseUrl = (): string => {
  const configured: unknown = import.meta.env.VITE_API_BASE_URL;
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : DEFAULT_API_BASE_URL;
};

/** 从响应头读取服务端回显的 requestId */
const readResponseRequestId = (response: AxiosResponse): string => {
  const headers: unknown = response.headers;
  if (isRecord(headers)) {
    const value = headers['x-request-id'];
    if (typeof value === 'string') return value;
  }
  return '';
};

const notifyError = (error: ApiError, silent: boolean): void => {
  if (silent) return;
  try {
    errorNotifier(error);
  } catch {
    // 通知器自身异常不得影响请求链路
  }
};

const handleUnauthorized = (): void => {
  try {
    unauthorizedHandler();
  } catch {
    // 处理器自身异常不得影响请求链路
  }
};

/** 解包成功响应：命中业务错误码时抛出 ApiError */
const unwrapResponse = (response: AxiosResponse): AxiosResponse => {
  const payload: unknown = response.data;

  // 非包络响应（文件流、网关兜底页、非标准接口）原样返回响应体，交由调用方自行处理
  if (!isApiResponse(payload)) return payload as unknown as AxiosResponse;

  const silent = response.config.silent === true;
  const requestId = readResponseRequestId(response) || payload.requestId || '';

  if (payload.code !== ErrorCode.SUCCESS) {
    const envelopeError = new ApiError({
      code: payload.code,
      message: payload.message,
      httpStatus: response.status,
      requestId,
      details: toErrorDetails(payload.details),
    });
    // 网关可能以 HTTP 200 返回认证失败（如 20001），因此业务错误码同样需要走未授权分支
    if (envelopeError.isAuthError) handleUnauthorized();
    notifyError(envelopeError, silent);
    throw envelopeError;
  }

  // 拦截器已解包：运行时的返回值是业务数据 `data`，
  // 但 axios 的拦截器签名要求返回 AxiosResponse，故此处做一次显式收敛（见下方 http 帮助函数的类型声明）。
  return payload.data as unknown as AxiosResponse;
};

/** 根据 HTTP 状态推导兜底提示文案（响应体不是包络时使用） */
const resolveFallbackMessage = (error: AxiosError, status: number): string => {
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return '请求超时，请稍后重试';
  if (status === 0) return '网络连接失败，请检查网络后重试';
  if (status === 401) return errorMessageOf(ErrorCode.UNAUTHORIZED);
  if (status === 403) return errorMessageOf(ErrorCode.PERMISSION_DENIED);
  if (status === 404) return '请求的接口不存在，请确认后端服务版本';
  if (status === 429) return errorMessageOf(ErrorCode.RATE_LIMITED);
  if (status >= 500) return errorMessageOf(ErrorCode.SERVICE_UNAVAILABLE);
  return error.message;
};

/** 把任意异常收敛为 ApiError */
const normalizeError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;

  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 0;
    const payload: unknown = error.response?.data;
    const silent = error.config?.silent === true;
    const requestId = error.response ? readResponseRequestId(error.response) : '';

    const apiError = isApiResponse(payload)
      ? new ApiError({
          code: payload.code,
          message: payload.message,
          httpStatus: status,
          requestId: requestId || (payload.requestId ?? ''),
          details: toErrorDetails(payload.details),
        })
      : new ApiError({
          code: status === 401 ? ErrorCode.UNAUTHORIZED : ErrorCode.SERVICE_UNAVAILABLE,
          message: resolveFallbackMessage(error, status),
          httpStatus: status,
          requestId,
        });

    if (apiError.isAuthError) handleUnauthorized();
    notifyError(apiError, silent);
    return apiError;
  }

  // 非 axios 异常（代码缺陷或第三方库抛出）：统一包装，避免调用方拿到裸 Error
  const fallback = new ApiError({
    code: ErrorCode.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : '请求失败，请稍后重试',
  });
  notifyError(fallback, false);
  return fallback;
};

/** axios 实例：全局单例 */
export const httpClient: AxiosInstance = axios.create({
  baseURL: resolveBaseUrl(),
  timeout: DEFAULT_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ---------------------------------------------------------------- 请求拦截器

httpClient.interceptors.request.use((config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
  // 每个请求都生成新的追踪 ID，便于在服务端日志中定位单次调用
  config.headers.set(REQUEST_ID_HEADER, generateRequestId());
  // 声明调用端，服务端据此校验 jwt realm（管理员 token 才能访问 /admin/**）
  config.headers.set('X-Platform', ADMIN_PLATFORM);

  const token = tokenProvider();
  if (token) config.headers.set('Authorization', `Bearer ${token}`);

  return config;
});

// ---------------------------------------------------------------- 响应拦截器

httpClient.interceptors.response.use(
  (response: AxiosResponse): AxiosResponse => unwrapResponse(response),
  (error: unknown): Promise<never> => Promise.reject(normalizeError(error)),
);

// ---------------------------------------------------------------- 类型化请求方法

/** 请求配置（等价于 AxiosRequestConfig，额外支持 silent） */
export type RequestConfig = AxiosRequestConfig;

/**
 * 发送请求。
 * 响应拦截器已把包络解包为业务数据，因此这里的返回类型即为调用方声明的 `T`。
 */
const send = async <T>(config: AxiosRequestConfig): Promise<T> => {
  const response = await httpClient.request<unknown, AxiosResponse>(config);
  return response as unknown as T;
};

/**
 * 类型化请求方法集合
 *
 * @example
 * const data = await http.get<PaginatedData<AdminUserItem>>('/admin/users', { params: { page: 1, pageSize: 20 } });
 */
export const http = {
  get: <T>(url: string, config?: AxiosRequestConfig): Promise<T> => send<T>({ ...config, url, method: 'GET' }),
  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> =>
    send<T>({ ...config, url, data, method: 'POST' }),
  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> =>
    send<T>({ ...config, url, data, method: 'PUT' }),
  patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> =>
    send<T>({ ...config, url, data, method: 'PATCH' }),
  delete: <T>(url: string, config?: AxiosRequestConfig): Promise<T> => send<T>({ ...config, url, method: 'DELETE' }),
};

/** 供错误分支使用：把任意 unknown 收敛为 ErrorDetail[] */
export const toErrorDetails = (value: unknown): ErrorDetail[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ErrorDetail => isRecord(item) && typeof item.field === 'string' && typeof item.issue === 'string',
  );
};

export default httpClient;
