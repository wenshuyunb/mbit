/**
 * axios 请求层单元测试（vi.mock 模拟 axios）
 *
 * 覆盖重点（请求层的全部契约，出问题会直接影响全站可用性）：
 *   1. 请求拦截器：注入 X-Request-Id、X-Platform: admin、Bearer 令牌（无令牌时不注入）
 *   2. 响应拦截器：解包统一包络 { code, message, data }；非包络响应原样返回
 *   3. 业务错误码（HTTP 200 且 code ≠ 0）→ 抛出 ApiError，并携带追踪 ID
 *   4. HTTP 401 / 认证类错误码 → 触发未授权处理器（清理登录态并跳登录页）
 *   5. 403 无权限（20009）**不得**跳登录页（否则会把已登录用户踢出）
 *   6. silent: true 的请求不触发全局错误提示
 *   7. 网络不可达 / 非 axios 异常统一归一化为 ApiError
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 拦截器处理器容器（vi.mock 会被提升到 import 之前，因此用 vi.hoisted 提前创建） */
const mocks = vi.hoisted(() => {
  type RequestHandler = (config: unknown) => unknown;
  interface ResponseHandlerPair {
    onFulfilled: (response: unknown) => unknown;
    onRejected: (error: unknown) => unknown;
  }

  const requestHandlers: RequestHandler[] = [];
  const responseHandlers: ResponseHandlerPair[] = [];
  /** axios.create 的调用参数（clearMocks 会清空 vi.fn 记录，故自行留存） */
  const createdConfigs: unknown[] = [];

  const instance = {
    interceptors: {
      request: {
        use: (onFulfilled: RequestHandler): number => {
          requestHandlers.push(onFulfilled);
          return requestHandlers.length;
        },
      },
      response: {
        use: (onFulfilled: (response: unknown) => unknown, onRejected: (error: unknown) => unknown): number => {
          responseHandlers.push({ onFulfilled, onRejected });
          return responseHandlers.length;
        },
      },
    },
  };

  const create = vi.fn((config?: unknown) => {
    createdConfigs.push(config);
    return instance;
  });

  return { requestHandlers, responseHandlers, createdConfigs, instance, create };
});

vi.mock('axios', () => ({
  default: {
    create: mocks.create,
    isAxiosError: (error: unknown): boolean =>
      typeof error === 'object' && error !== null && (error as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

import {
  DEFAULT_TIMEOUT_MS,
  httpClient,
  setErrorNotifier,
  setTokenProvider,
  setUnauthorizedHandler,
} from '@/api/client';
import { ApiError } from '@/api/types';
import { ErrorCode } from '@/constants';
import { isValidRequestId } from '@/utils/request-id';

/** 伪造请求配置：headers 使用与 AxiosHeaders 相同的 set(name, value) 接口 */
interface FakeHeaders {
  set: (name: string, value: string) => void;
}

interface FakeRequestConfig {
  url?: string;
  headers: FakeHeaders;
  silent?: boolean;
}

interface FakeResponse {
  data: unknown;
  status: number;
  headers: Record<string, string>;
  config: FakeRequestConfig;
}

/** 创建一个请求配置并保留 headers 记录，便于断言请求头注入 */
const createRequest = (silent = false): { config: FakeRequestConfig; headers: Map<string, string> } => {
  const headers = new Map<string, string>();
  const config: FakeRequestConfig = {
    url: '/admin/dashboard/metrics',
    silent,
    headers: {
      set: (name: string, value: string): void => {
        headers.set(name, value);
      },
    },
  };
  return { config, headers };
};

/** 执行请求拦截器（返回 axios 的请求配置） */
const runRequestInterceptor = (config: FakeRequestConfig): FakeRequestConfig => {
  const handler = mocks.requestHandlers[0];
  if (!handler) throw new Error('请求拦截器未注册');
  return (handler as unknown as (value: FakeRequestConfig) => FakeRequestConfig)(config);
};

/** 执行响应拦截器的成功分支 */
const runResponseFulfilled = (response: FakeResponse): unknown => {
  const pair = mocks.responseHandlers[0];
  if (!pair) throw new Error('响应拦截器未注册');
  return pair.onFulfilled(response);
};

/**
 * 执行响应拦截器的失败分支，并返回其产生的错误对象。
 *
 * axios 的 onRejected 允许两种等价写法：同步 `throw new ApiError(...)`，
 * 或 `return Promise.reject(new ApiError(...))`。两者在 axios 内部行为一致，
 * 因此这里做归一化处理，避免测试断言绑定到某一种实现细节。
 *
 * 注意：归一化不会削弱断言强度 —— 若 onRejected 既没抛错也没返回错误对象，
 * 调用方随后的 `toBeInstanceOf(ApiError)` 依然会失败。
 */
const runResponseRejected = async (error: unknown): Promise<unknown> => {
  const pair = mocks.responseHandlers[0];
  if (!pair) throw new Error('响应拦截器未注册');

  try {
    return await pair.onRejected(error);
  } catch (thrown) {
    return thrown;
  }
};

/** 构造响应包络 */
const envelope = (code: number, message: string, data: unknown = null): Record<string, unknown> => ({
  code,
  message,
  data,
});

/** 构造响应对象 */
const createResponse = (options: {
  data: unknown;
  status?: number;
  silent?: boolean;
  requestId?: string;
}): FakeResponse => ({
  data: options.data,
  status: options.status ?? 200,
  headers: options.requestId === undefined ? {} : { 'x-request-id': options.requestId },
  config: createRequest(options.silent ?? false).config,
});

/** 断言表达式同步抛出 ApiError 并返回它 */
const captureApiError = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('预期抛出 ApiError，但未抛出');
};

describe('api/client —— axios 实例初始化', () => {
  it('使用环境变量中的 baseURL 与默认超时创建单例实例', () => {
    const config = mocks.createdConfigs[0] as { baseURL?: unknown; timeout?: unknown } | undefined;

    expect(mocks.createdConfigs).toHaveLength(1);
    expect(typeof config?.baseURL).toBe('string');
    expect(config?.baseURL).not.toBe('');
    expect(config?.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('httpClient 暴露为 axios 单例', () => {
    expect(httpClient as unknown).toBe(mocks.instance);
  });
});

describe('api/client —— 请求拦截器', () => {
  beforeEach(() => {
    setTokenProvider(() => null);
    setUnauthorizedHandler((): void => undefined);
    setErrorNotifier((): void => undefined);
  });

  it('注入 X-Platform: admin、X-Request-Id 与 Bearer 令牌', () => {
    setTokenProvider(() => 'test-access-token');
    const { config, headers } = createRequest();

    const returned = runRequestInterceptor(config);

    expect(returned).toBe(config);
    expect(headers.get('X-Platform')).toBe('admin');
    expect(headers.get('Authorization')).toBe('Bearer test-access-token');
    expect(isValidRequestId(headers.get('X-Request-Id') ?? '')).toBe(true);
  });

  it('未登录（无令牌）时不注入 Authorization，但仍生成追踪 ID', () => {
    const { config, headers } = createRequest();

    runRequestInterceptor(config);

    expect(headers.has('Authorization')).toBe(false);
    expect(isValidRequestId(headers.get('X-Request-Id') ?? '')).toBe(true);
  });

  it('每次请求生成不同的 X-Request-Id（可独立追踪单次调用）', () => {
    const first = createRequest();
    const second = createRequest();

    runRequestInterceptor(first.config);
    runRequestInterceptor(second.config);

    const firstId = first.headers.get('X-Request-Id');
    expect(firstId).toBeDefined();
    expect(second.headers.get('X-Request-Id')).not.toBe(firstId);
  });
});

describe('api/client —— 响应拦截器（成功分支）', () => {
  beforeEach(() => {
    setTokenProvider(() => null);
    setUnauthorizedHandler((): void => undefined);
    setErrorNotifier((): void => undefined);
  });

  it('解包统一包络，直接返回 data', () => {
    const response = createResponse({ data: envelope(ErrorCode.SUCCESS, 'ok', { total: 3 }) });

    expect(runResponseFulfilled(response)).toEqual({ total: 3 });
  });

  it('data 为 null 时返回 null（成功但无数据）', () => {
    const response = createResponse({ data: envelope(ErrorCode.SUCCESS, 'ok', null) });

    expect(runResponseFulfilled(response)).toBeNull();
  });

  it('非包络响应（文件流 / 网关兜底页）原样返回响应体', () => {
    const payload = '<html>502 Bad Gateway</html>';
    const response = createResponse({ data: payload, status: 502 });

    expect(runResponseFulfilled(response)).toBe(payload);
  });
});

describe('api/client —— 响应拦截器（业务错误码）', () => {
  let notifier: ReturnType<typeof vi.fn> = vi.fn();
  let unauthorized: ReturnType<typeof vi.fn> = vi.fn();

  beforeEach(() => {
    notifier = vi.fn();
    unauthorized = vi.fn();
    setTokenProvider(() => null);
    setErrorNotifier(notifier);
    setUnauthorizedHandler(unauthorized);
  });

  it('HTTP 200 + code ≠ 0 时抛出 ApiError，并携带错误码 / 追踪 ID / 明细', () => {
    const response = createResponse({
      data: {
        code: ErrorCode.PARAM_INVALID,
        message: '请求参数不合法',
        data: null,
        details: [{ field: 'pageSize', issue: '最大值 100' }],
      },
      requestId: 'req_from-header',
    });

    const error = captureApiError(() => runResponseFulfilled(response));

    expect(error.code).toBe(ErrorCode.PARAM_INVALID);
    expect(error.message).toBe('请求参数不合法');
    expect(error.httpStatus).toBe(200);
    expect(error.requestId).toBe('req_from-header');
    expect(error.details).toEqual([{ field: 'pageSize', issue: '最大值 100' }]);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(error);
  });

  it('403 无权限（20009）不触发跳登录，只提示错误', () => {
    const response = createResponse({ data: envelope(ErrorCode.PERMISSION_DENIED, '无权限执行该操作') });

    const error = captureApiError(() => runResponseFulfilled(response));

    expect(error.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(error.isAuthError).toBe(false);
    expect(unauthorized).not.toHaveBeenCalled();
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('认证类错误码（20001）即使 HTTP 为 200 也触发未授权处理', () => {
    const response = createResponse({ data: envelope(ErrorCode.TOKEN_EXPIRED, '登录状态已过期，请重新登录') });

    const error = captureApiError(() => runResponseFulfilled(response));

    expect(error.isAuthError).toBe(true);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('silent: true 的业务错误不触发全局提示', () => {
    const response = createResponse({
      data: envelope(ErrorCode.ADMIN_CREDENTIALS_INVALID, '管理员账号或密码错误'),
      silent: true,
    });

    captureApiError(() => runResponseFulfilled(response));

    expect(notifier).not.toHaveBeenCalled();
  });

  it('后端未返回 message 时回退到错误码内置文案', () => {
    const response = createResponse({ data: { code: ErrorCode.ORDER_NOT_FOUND, message: '   ', data: null } });

    const error = captureApiError(() => runResponseFulfilled(response));

    expect(error.message).toBe('订单不存在');
  });
});

describe('api/client —— 响应拦截器（HTTP 失败分支）', () => {
  let notifier: ReturnType<typeof vi.fn> = vi.fn();
  let unauthorized: ReturnType<typeof vi.fn> = vi.fn();

  beforeEach(() => {
    notifier = vi.fn();
    unauthorized = vi.fn();
    setTokenProvider(() => null);
    setErrorNotifier(notifier);
    setUnauthorizedHandler(unauthorized);
  });

  it('HTTP 401 触发未授权处理，并归一化为 ApiError', async () => {
    const result = await runResponseRejected({
      isAxiosError: true,
      message: 'Request failed with status code 401',
      code: 'ERR_BAD_REQUEST',
      config: createRequest().config,
      response: {
        status: 401,
        data: envelope(ErrorCode.TOKEN_INVALID, '登录凭证无效，请重新登录'),
        headers: { 'x-request-id': 'req_401' },
        config: createRequest().config,
      },
    });

    expect(result).toBeInstanceOf(ApiError);
    const error = result as ApiError;
    expect(error.code).toBe(ErrorCode.TOKEN_INVALID);
    expect(error.httpStatus).toBe(401);
    expect(error.isAuthError).toBe(true);
    expect(error.requestId).toBe('req_401');
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('HTTP 503（响应体非包络）使用兜底文案并提示', async () => {
    const result = await runResponseRejected({
      isAxiosError: true,
      message: 'Request failed with status code 503',
      code: 'ERR_BAD_RESPONSE',
      config: createRequest().config,
      response: { status: 503, data: 'Service Unavailable', headers: {}, config: createRequest().config },
    });

    const error = result as ApiError;
    expect(error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(error.message).toBe('服务暂时不可用，请稍后重试');
    expect(unauthorized).not.toHaveBeenCalled();
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('网络不可达（无 response）归一化为 ApiError，不触发跳登录', async () => {
    const result = await runResponseRejected({
      isAxiosError: true,
      message: 'Network Error',
      code: 'ERR_NETWORK',
      config: createRequest().config,
    });

    const error = result as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(error.httpStatus).toBe(0);
    expect(error.message).toBe('网络连接失败，请检查网络后重试');
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('请求超时给出可读提示', async () => {
    const result = await runResponseRejected({
      isAxiosError: true,
      message: 'timeout of 15000ms exceeded',
      code: 'ECONNABORTED',
      config: createRequest().config,
    });

    expect((result as ApiError).message).toBe('请求超时，请稍后重试');
  });

  it('silent: true 的失败请求不触发全局提示', async () => {
    const result = await runResponseRejected({
      isAxiosError: true,
      message: 'Request failed with status code 401',
      code: 'ERR_BAD_REQUEST',
      config: createRequest(true).config,
      response: {
        status: 401,
        data: envelope(ErrorCode.UNAUTHORIZED, '请先登录'),
        headers: {},
        config: createRequest(true).config,
      },
    });

    expect(result).toBeInstanceOf(ApiError);
    expect(notifier).not.toHaveBeenCalled();
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('非 axios 异常（代码缺陷/第三方库）统一包装为 ApiError', async () => {
    const result = await runResponseRejected(new TypeError('x is not a function'));

    const error = result as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(error.message).toBe('x is not a function');
    expect(notifier).toHaveBeenCalledTimes(1);
  });
});
