/**
 * 请求追踪 ID 中间件
 *
 * 规则（见 PROJECT_ARCHITECTURE.md §15.1）：
 *   - 优先复用上游传入的 X-Request-Id（网关/客户端生成），便于跨服务串联
 *   - 无则生成 UUIDv7（时间有序，便于日志按时间排序定位）
 *   - 写入 req.requestId，并通过响应头回传给客户端（客服排障凭据）
 */

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import type { RequestWithContext } from '../types/request.type';

const REQUEST_ID_HEADER = 'x-request-id';

/** 客户端传入的 requestId 需做长度与字符白名单校验，防止日志注入 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

    const requestId =
      typeof candidate === 'string' && CLIENT_ID_PATTERN.test(candidate) ? candidate : `req_${uuidv7()}`;

    req.requestId = requestId;
    req.startedAt = Date.now();
    res.setHeader('X-Request-Id', requestId);

    next();
  }
}
