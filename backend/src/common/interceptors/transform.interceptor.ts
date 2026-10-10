/**
 * 统一响应包装拦截器
 *
 * 把 Controller 返回的原始数据包装为 { code, message, data, requestId, timestamp }。
 * 若 Controller 已显式返回 ApiResponseDto 结构（例如 SSE、文件流场景），则原样放行。
 *
 * 注意：SSE 与文件下载接口不得被包装，需通过 @RawResponse() 装饰器标记跳过。
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import { ErrorCode } from '../errors/error-code';
import type { RequestWithContext } from '../types/request.type';

/** 标记该接口返回原始响应（SSE / 文件流 / 第三方回调），不做包络包装 */
export const RAW_RESPONSE_KEY = 'soulmap:raw_response';

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithContext>();
    const res = http.getResponse<Response>();

    // 原始响应接口（SSE / 文件流 / 支付回调等）直接放行
    const isRaw = Reflect.getMetadata(RAW_RESPONSE_KEY, context.getHandler()) === true;
    if (isRaw) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        // 204 无内容响应保持空体
        if (res.statusCode === 204) {
          return undefined;
        }

        return {
          code: ErrorCode.SUCCESS,
          message: 'ok',
          data: data === undefined ? null : data,
          requestId: req.requestId ?? 'unknown',
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
