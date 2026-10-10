/**
 * 请求追踪 ID 中间件测试
 *
 * 关键行为：
 *   · 复用上游合法 X-Request-Id（跨服务链路串联）
 *   · 非法/超长的客户端 ID 必须被丢弃并重新生成（防日志注入）
 *   · 生成的 ID 必须回写响应头（客服排障凭据）
 */

import type { NextFunction, Response } from 'express';
import { RequestIdMiddleware } from './request-id.middleware';
import type { RequestWithContext } from '../types/request.type';

const createResponse = (): { res: Response; headers: Record<string, string> } => {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (key: string, value: string) => {
      headers[key] = value;
      return res;
    },
  } as unknown as Response;
  return { res, headers };
};

const createRequest = (headers: Record<string, unknown> = {}): RequestWithContext =>
  ({ headers }) as unknown as RequestWithContext;

describe('RequestIdMiddleware', () => {
  let middleware: RequestIdMiddleware;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    middleware = new RequestIdMiddleware();
    next = jest.fn();
  });

  it('无传入 ID 时生成 req_ 前缀的 UUIDv7 并写入请求上下文与响应头', () => {
    const req = createRequest();
    const { res, headers } = createResponse();

    middleware.use(req, res, next);

    expect(req.requestId).toMatch(/^req_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(headers['X-Request-Id']).toBe(req.requestId);
    expect(typeof req.startedAt).toBe('number');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('复用上游传入的合法 X-Request-Id', () => {
    const req = createRequest({ 'x-request-id': 'trace-abc-12345678' });
    const { res, headers } = createResponse();

    middleware.use(req, res, next);

    expect(req.requestId).toBe('trace-abc-12345678');
    expect(headers['X-Request-Id']).toBe('trace-abc-12345678');
  });

  it.each([
    ['过短', 'abc'],
    ['含非法字符（换行注入）', 'trace-abc\n12345678'],
    ['含空格', 'trace abc 12345678'],
    ['超长（>64）', 'a'.repeat(65)],
  ])('丢弃非法 X-Request-Id：%s', (_label, value) => {
    const req = createRequest({ 'x-request-id': value });
    const { res } = createResponse();

    middleware.use(req, res, next);

    expect(req.requestId).not.toBe(value);
    expect(req.requestId).toMatch(/^req_/);
  });

  it('数组形式的头部取第一个值处理', () => {
    const req = createRequest({ 'x-request-id': ['trace-abc-12345678', 'trace-def-87654321'] });
    const { res } = createResponse();

    middleware.use(req, res, next);

    expect(req.requestId).toBe('trace-abc-12345678');
  });
});
