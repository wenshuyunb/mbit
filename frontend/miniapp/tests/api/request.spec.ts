/**
 * 请求层测试
 *
 * 覆盖架构文档 §7.1 中承诺的每一项能力：
 *   · 请求头注入（凭证、追踪 ID、平台标识、幂等键）
 *   · 统一响应包络解包
 *   · 业务错误 → ApiError 归一化
 *   · 401 自动续期（single-flight，并发只刷新一次）
 *   · 幂等 GET 的网络错误重试
 *   · 写请求绝不自动重试（防止重复下单）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ERROR_CODES } from '@/api/types';
import { http, registerRequestHooks, request } from '@/api/request';

interface MockResponse {
  statusCode?: number;
  body?: unknown;
  /** 模拟网络层失败 */
  networkError?: string;
}

/** 记录每次 uni.request 的入参，便于断言请求头与 URL */
interface CapturedRequest {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: unknown;
  timeout?: number;
}

let captured: CapturedRequest[] = [];
let queue: MockResponse[] = [];

/** 配置下一次（或多次）请求的响应 */
const enqueue = (...responses: MockResponse[]): void => {
  queue.push(...responses);
};

/** 安装 uni.request Mock */
const installRequestMock = (): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    captured.push({
      url: String(options['url']),
      method: String(options['method']),
      header: (options['header'] ?? {}) as Record<string, string>,
      data: options['data'],
      timeout: options['timeout'] as number | undefined,
    });

    const next = queue.shift() ?? { statusCode: 200, body: { code: 0, message: 'ok', data: null } };

    // 异步回调，贴近真实时序（避免同步回调掩盖竞态问题）
    setTimeout(() => {
      if (next.networkError !== undefined) {
        (options['fail'] as (res: { errMsg: string }) => void)({ errMsg: next.networkError });
      } else {
        (options['success'] as (res: { statusCode: number; data: unknown }) => void)({
          statusCode: next.statusCode ?? 200,
          data: next.body,
        });
      }
      (options['complete'] as () => void)?.();
    }, 0);

    return { abort: vi.fn() };
  }) as unknown as typeof uni.request);
};

const okBody = <T>(data: T): MockResponse => ({
  statusCode: 200,
  body: { code: 0, message: 'ok', data, requestId: 'req_test', timestamp: new Date().toISOString() },
});

const errorBody = (code: number, message: string, statusCode = 400): MockResponse => ({
  statusCode,
  body: { code, message, data: null, requestId: 'req_test', timestamp: new Date().toISOString() },
});

describe('请求层', () => {
  beforeEach(() => {
    captured = [];
    queue = [];
    installRequestMock();

    // 默认不登录；个别用例再覆盖
    registerRequestHooks({
      getAccessToken: () => null,
      refreshAccessToken: async () => null,
      onUnauthorized: () => undefined,
    });
  });

  describe('响应解包', () => {
    it('成功响应只返回 data 字段', async () => {
      enqueue(okBody({ id: 'u1', mbti: 'INTJ' }));

      const result = await request<{ id: string; mbti: string }>({ url: '/users/me' });

      expect(result).toEqual({ id: 'u1', mbti: 'INTJ' });
    });

    it('data 为 null 时返回 null 而不是抛错', async () => {
      enqueue({ statusCode: 200, body: { code: 0, message: 'ok', data: null, requestId: 'r', timestamp: '' } });

      await expect(request({ url: '/auth/session' })).resolves.toBeNull();
    });
  });

  describe('请求头注入', () => {
    it('注入追踪 ID、平台与客户端版本', async () => {
      enqueue(okBody({}));

      await request({ url: '/system/config' });

      const headers = captured[0]?.header ?? {};
      expect(headers['X-Request-Id']).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(headers['X-Platform']).toBe('miniapp');
      expect(headers['X-Client-Version']).toBe('1.0.0');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('已登录时注入 Bearer Token', async () => {
      registerRequestHooks({ getAccessToken: () => 'access-token-abc' });
      enqueue(okBody({}));

      await request({ url: '/users/me' });

      expect(captured[0]?.header['Authorization']).toBe('Bearer access-token-abc');
    });

    it('needAuth=false 时不携带 Token（公开接口）', async () => {
      registerRequestHooks({ getAccessToken: () => 'access-token-abc' });
      enqueue(okBody({}));

      await request({ url: '/auth/wechat/login', method: 'POST', needAuth: false });

      expect(captured[0]?.header['Authorization']).toBeUndefined();
    });

    it('携带幂等键（下单等写接口要求）', async () => {
      enqueue(okBody({}));

      await request({ url: '/orders', method: 'POST', idempotencyKey: 'idem-12345678' });

      expect(captured[0]?.header['X-Idempotency-Key']).toBe('idem-12345678');
    });
  });

  describe('URL 与参数组装', () => {
    it('GET 参数拼接为查询串，并跳过空值', async () => {
      enqueue(okBody({ items: [] }));

      await http.get('/reports', { page: 1, pageSize: 20, type: undefined, keyword: '' });

      const url = captured[0]?.url ?? '';
      expect(url).toContain('/reports?');
      expect(url).toContain('page=1');
      expect(url).toContain('pageSize=20');
      expect(url).not.toContain('type=');
      expect(url).not.toContain('keyword=');
    });

    it('GET 请求体不重复传输参数（参数已在 URL）', async () => {
      enqueue(okBody({}));

      await http.get('/tests', { page: 1 });

      expect(captured[0]?.data).toBeUndefined();
    });

    it('POST 参数放在请求体', async () => {
      enqueue(okBody({}));

      await http.post('/orders', { productCode: 'REPORT_MBTI' });

      expect(captured[0]?.data).toEqual({ productCode: 'REPORT_MBTI' });
    });
  });

  describe('错误归一化', () => {
    it('业务错误码 → ApiError，携带 code 与中文文案', async () => {
      // 两次调用两次响应（第一次用于断言 rejects，第二次用于断言字段）
      enqueue(
        errorBody(ERROR_CODES.TEST_ANSWER_INCOMPLETE, '还有 3 道题未作答'),
        errorBody(ERROR_CODES.TEST_ANSWER_INCOMPLETE, '还有 3 道题未作答'),
      );

      await expect(request({ url: '/tests/sessions/1/submit', method: 'POST', showError: false })).rejects.toThrow(
        ApiError,
      );

      try {
        await request({ url: '/tests/sessions/1/submit', method: 'POST', showError: false });
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.code).toBe(ERROR_CODES.TEST_ANSWER_INCOMPLETE);
        expect(apiError.message).toBe('还有 3 道题未作答');
        expect(apiError.isNetworkError).toBe(false);
      }
    });

    it('网络失败 → isNetworkError = true，文案区分超时与断网', async () => {
      enqueue({ networkError: 'request:fail timeout' }, { networkError: 'request:fail timeout' });

      try {
        await request({ url: '/users/me', retry: 0, showError: false });
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.isNetworkError).toBe(true);
        expect(apiError.httpStatus).toBe(0);
        expect(apiError.message).toContain('超时');
      }
    });

    it('网关返回非包络结构（如 502 HTML）也能归一', async () => {
      enqueue({ statusCode: 502, body: '<html>Bad Gateway</html>' });

      try {
        await request({ url: '/users/me', showError: false });
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.httpStatus).toBe(502);
        expect(apiError.code).toBe(ERROR_CODES.UNKNOWN);
        expect(apiError.message).toBe('服务开小差了，请稍后重试');
      }
    });

    it('未解锁报告错误可被业务分支识别', async () => {
      enqueue(errorBody(ERROR_CODES.AI_REPORT_NOT_UNLOCKED, '该报告尚未解锁', 403));

      try {
        await request({ url: '/reports/1', showError: false });
      } catch (error) {
        expect((error as ApiError).isPaymentRequired).toBe(true);
      }
    });
  });

  describe('重试策略', () => {
    it('GET 网络错误自动重试一次后成功', async () => {
      enqueue({ networkError: 'request:fail' }, okBody({ recovered: true }));

      const result = await request<{ recovered: boolean }>({ url: '/system/config', showError: false });

      expect(result).toEqual({ recovered: true });
      expect(captured).toHaveLength(2);
    });

    it('写请求默认不重试（防止重复下单）', async () => {
      enqueue({ networkError: 'request:fail' }, okBody({ shouldNotReach: true }));

      await expect(request({ url: '/orders', method: 'POST', showError: false })).rejects.toThrow(ApiError);

      // 只应发出一次请求
      expect(captured).toHaveLength(1);
    });
  });

  describe('401 自动续期', () => {
    it('并发多个 401 只触发一次刷新（single-flight）', async () => {
      // 真实的 token 提供方是「有状态的」：续期成功后 getAccessToken 返回新值。
      // 用静态 mock 会掩盖并发复用逻辑，因此这里刻意模拟真实行为。
      let currentToken = 'expired-token';
      const refreshAccessToken = vi.fn(async () => {
        currentToken = 'new-token';
        return currentToken;
      });
      registerRequestHooks({ getAccessToken: () => currentToken, refreshAccessToken });

      // 三个并发请求都先返回 401，再各自重放成功
      enqueue(
        errorBody(ERROR_CODES.TOKEN_EXPIRED, '登录状态已过期', 401),
        errorBody(ERROR_CODES.TOKEN_EXPIRED, '登录状态已过期', 401),
        errorBody(ERROR_CODES.TOKEN_EXPIRED, '登录状态已过期', 401),
        okBody({ id: 'u1' }),
        okBody({ id: 'u2' }),
        okBody({ id: 'u3' }),
      );

      const results = await Promise.all([
        request<{ id: string }>({ url: '/a', showError: false }),
        request<{ id: string }>({ url: '/b', showError: false }),
        request<{ id: string }>({ url: '/c', showError: false }),
      ]);

      expect(results.map((item) => item.id)).toEqual(['u1', 'u2', 'u3']);
      // 关键断言：并发场景下 refreshToken 只被调用一次
      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    });

    it('刷新失败时调用 onUnauthorized 并抛出原始错误', async () => {
      const onUnauthorized = vi.fn();
      registerRequestHooks({
        getAccessToken: () => 'expired-token',
        refreshAccessToken: async () => null,
        onUnauthorized,
      });

      enqueue(errorBody(ERROR_CODES.TOKEN_EXPIRED, '登录状态已过期', 401));

      await expect(request({ url: '/users/me', showError: false })).rejects.toThrow(ApiError);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('refreshToken 已失效时不尝试刷新（避免无效请求）', async () => {
      const refreshAccessToken = vi.fn(async () => 'new-token');
      const onUnauthorized = vi.fn();
      registerRequestHooks({ getAccessToken: () => 'expired', refreshAccessToken, onUnauthorized });

      enqueue(errorBody(ERROR_CODES.REFRESH_TOKEN_INVALID, '登录续期凭证无效', 401));

      await expect(request({ url: '/users/me', showError: false })).rejects.toThrow(ApiError);
      expect(refreshAccessToken).not.toHaveBeenCalled();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('重放成功时返回新数据且不再二次刷新', async () => {
      let currentToken = 'expired';
      const refreshAccessToken = vi.fn(async () => {
        currentToken = 'new-token';
        return currentToken;
      });
      registerRequestHooks({ getAccessToken: () => currentToken, refreshAccessToken });

      enqueue(errorBody(ERROR_CODES.TOKEN_EXPIRED, '过期', 401), okBody({ nickname: '新昵称' }));

      const result = await request<{ nickname: string }>({ url: '/users/me', showError: false });

      expect(result.nickname).toBe('新昵称');
      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
      // 重放请求必须使用续期后的新 Token（即使 store 尚未完成持久化也不能用旧值）
      expect(captured[1]?.header['Authorization']).toBe('Bearer new-token');
    });
  });

  describe('分页封装', () => {
    it('返回标准分页结构', async () => {
      enqueue(okBody({ items: [{ id: 'r1' }], total: 1, page: 1, pageSize: 20, hasNext: false }));

      const { httpPage } = await import('@/api/request');
      const result = await httpPage<{ id: string }>('/reports', { page: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.hasNext).toBe(false);
    });

    it('服务端契约异常时归一为空分页，避免页面崩溃', async () => {
      enqueue(okBody({ unexpected: true }));

      const { httpPage } = await import('@/api/request');
      const result = await httpPage('/reports', { page: 2, pageSize: 10 });

      expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 10, hasNext: false });
    });
  });
});
