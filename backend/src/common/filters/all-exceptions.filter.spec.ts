/**
 * 全局异常过滤器测试
 *
 * 覆盖价值最高的行为：
 *   · 统一响应结构（code / message / data / requestId / timestamp）
 *   · 框架异常、业务异常、数据库异常、未知异常四类归一
 *   · 5xx 不泄露内部细节，同时日志中保留堆栈
 *   · 响应已发出（SSE 场景）时不再重复写入
 */

import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-code';
import type { RequestWithContext } from '../types/request.type';

interface MockResponse {
  statusCode: number;
  headersSent: boolean;
  status: jest.Mock;
  json: jest.Mock;
}

const createHost = (request: Partial<RequestWithContext> = {}): { host: ArgumentsHost; res: MockResponse } => {
  const res: MockResponse = {
    statusCode: 200,
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };

  const fullRequest = {
    requestId: 'req_test_0001',
    method: 'POST',
    originalUrl: '/api/v1/tests/sessions/1/submit',
    startedAt: Date.now() - 12,
    headers: {},
    ...request,
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => fullRequest,
    }),
  } as unknown as ArgumentsHost;

  return { host, res };
};

const createLogger = (): PinoLogger =>
  ({
    setContext: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }) as unknown as PinoLogger;

describe('AllExceptionsFilter', () => {
  let logger: PinoLogger;
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    logger = createLogger();
    filter = new AllExceptionsFilter(logger);
  });

  it('业务异常 → 使用业务错误码与中文文案', () => {
    const { host, res } = createHost();

    filter.catch(BusinessException.conflict(ErrorCode.ORDER_ALREADY_PAID), host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.ORDER_ALREADY_PAID,
        message: '订单已支付',
        data: null,
        requestId: 'req_test_0001',
      }),
    );
  });

  it('参数校验失败 → 归一为 PARAM_INVALID 并携带字段明细', () => {
    const { host, res } = createHost();

    filter.catch(
      new BadRequestException({
        statusCode: 400,
        message: ['page 必须是整数', 'pageSize 最大为 100'],
        error: 'Bad Request',
      }),
      host,
    );

    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const body = res.json.mock.calls[0]?.[0] as { code: number; details: Array<{ issue: string }> };
    expect(body.code).toBe(ErrorCode.PARAM_INVALID);
    expect(body.details).toEqual([{ issue: 'page 必须是整数' }, { issue: 'pageSize 最大为 100' }]);
  });

  it('框架 404 异常 → 映射为 RESOURCE_NOT_FOUND', () => {
    const { host, res } = createHost();

    filter.catch(new NotFoundException('Cannot GET /api/v1/nope'), host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = res.json.mock.calls[0]?.[0] as { code: number; message: string };
    expect(body.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
    expect(body.message).toBe('Cannot GET /api/v1/nope');
  });

  it('Prisma 唯一约束冲突（P2002）→ 409 且给出用户可读提示', () => {
    const { host, res } = createHost();

    const prismaError = Object.assign(new Error('Unique constraint failed on the fields: (`pair_key`)'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: ['pair_key'] },
    });

    filter.catch(prismaError, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    const body = res.json.mock.calls[0]?.[0] as { code: number; message: string };
    expect(body.code).toBe(ErrorCode.RESOURCE_CONFLICT);
    expect(body.message).toBe('数据已存在，请勿重复提交');
  });

  it('Prisma 记录不存在（P2025）→ 404', () => {
    const { host, res } = createHost();

    const prismaError = Object.assign(new Error('Record to update not found'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2025',
    });

    filter.catch(prismaError, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect((res.json.mock.calls[0]?.[0] as { code: number }).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it('未知异常 → 500 且不泄露内部信息，但日志保留堆栈', () => {
    const { host, res } = createHost();

    filter.catch(new Error('connect ETIMEDOUT 10.0.0.5:5432'), host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = res.json.mock.calls[0]?.[0] as { code: number; message: string };
    expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.message).toBe('服务开小差了，请稍后重试');
    expect(JSON.stringify(body)).not.toContain('ETIMEDOUT');

    expect(logger.error).toHaveBeenCalledTimes(1);
    const loggedPayload = (logger.error as jest.Mock).mock.calls[0]?.[0] as { err: { stack?: string } };
    expect(loggedPayload.err.stack).toContain('ETIMEDOUT');
  });

  it('4xx 走 warn 级别，不打印堆栈', () => {
    const { host } = createHost();

    filter.catch(BusinessException.forbidden(ErrorCode.PERMISSION_DENIED), host);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('响应已发出时不再写入（SSE 中途出错场景）', () => {
    const { host, res } = createHost();
    res.headersSent = true;

    filter.catch(new Error('stream aborted'), host);

    expect(res.json).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('日志携带 requestId / userId / 耗时等排障字段', () => {
    const { host } = createHost({
      principal: {
        userId: '0192f3c1-7a4b-7c3d-9e2f-1a2b3c4d5e6f',
        realm: 'user',
        roles: [],
        permissions: [],
        jti: 'jti_1',
      },
    });

    filter.catch(BusinessException.badRequest(), host);

    const payload = (logger.warn as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['requestId']).toBe('req_test_0001');
    expect(payload['userId']).toBe('0192f3c1-7a4b-7c3d-9e2f-1a2b3c4d5e6f');
    expect(typeof payload['latencyMs']).toBe('number');
  });
});
