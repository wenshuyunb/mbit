/**
 * 统一响应包装拦截器测试
 *
 * 关键行为：
 *   · 普通接口返回 { code: 0, message, data, requestId, timestamp }
 *   · undefined 归一为 null（前端可依赖 data 字段始终存在）
 *   · 204 保持空体
 *   · 标记 @RawResponse() 的接口（SSE / 文件流 / 支付回调）原样放行
 */

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { firstValueFrom, of } from 'rxjs';

import { RAW_RESPONSE_KEY, TransformInterceptor } from './transform.interceptor';
import type { RequestWithContext } from '../types/request.type';

const createContext = (
  handler: () => unknown,
  statusCode = 200,
): { ctx: ExecutionContext; res: { statusCode: number } } => {
  const res = { statusCode } as Response;
  const req = { requestId: 'req_test_0002' } as RequestWithContext;

  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;

  return { ctx, res: res as { statusCode: number } };
};

const createNext = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('TransformInterceptor', () => {
  let interceptor: TransformInterceptor<unknown>;

  beforeEach(() => {
    interceptor = new TransformInterceptor();
  });

  it('包装普通返回值', async () => {
    const { ctx } = createContext(() => undefined);
    const result = await firstValueFrom(interceptor.intercept(ctx, createNext({ id: 'r1', mbti: 'INTJ' })));

    expect(result).toEqual({
      code: 0,
      message: 'ok',
      data: { id: 'r1', mbti: 'INTJ' },
      requestId: 'req_test_0002',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('undefined 归一为 null，保证 data 字段始终存在', async () => {
    const { ctx } = createContext(() => undefined);
    const result = (await firstValueFrom(interceptor.intercept(ctx, createNext(undefined)))) as { data: unknown };

    expect(result.data).toBeNull();
  });

  it('204 No Content 保持空体', async () => {
    const { ctx } = createContext(() => undefined, 204);
    const result = await firstValueFrom(interceptor.intercept(ctx, createNext({ ignored: true })));

    expect(result).toBeUndefined();
  });

  it('数组返回值不被展开', async () => {
    const { ctx } = createContext(() => undefined);
    const result = (await firstValueFrom(interceptor.intercept(ctx, createNext([{ id: 1 }, { id: 2 }])))) as {
      data: unknown[];
    };

    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('标记 @RawResponse() 的接口原样放行（SSE / 支付回调）', async () => {
    const rawHandler = (): void => undefined;
    Reflect.defineMetadata(RAW_RESPONSE_KEY, true, rawHandler);

    const { ctx } = createContext(rawHandler);
    const result = await firstValueFrom(interceptor.intercept(ctx, createNext({ code: 'SUCCESS' })));

    expect(result).toEqual({ code: 'SUCCESS' });
  });
});
