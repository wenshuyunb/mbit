/**
 * 业务异常 — 所有可预期的业务错误都必须抛出 BusinessException
 *
 * 使用示例：
 *   throw new BusinessException(ErrorCode.TEST_SESSION_EXPIRED);
 *   throw new BusinessException(ErrorCode.TEST_ANSWER_INCOMPLETE, '还有 3 道题未作答');
 *   throw BusinessException.notFound(ErrorCode.REPORT_NOT_FOUND);
 *
 * 约定：
 *   - 默认 HTTP 状态码由错误码推导（见 error-code.ts）
 *   - details 仅用于字段级校验错误等结构化补充信息，不得包含敏感数据
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, httpStatusOf, messageOf } from './error-code';

export interface ErrorDetail {
  field?: string;
  issue: string;
  value?: unknown;
}

export class BusinessException extends HttpException {
  /** 业务错误码（对外暴露，前端据此做逻辑分支） */
  public readonly code: number;

  /** 面向用户的中文提示 */
  public readonly userMessage: string;

  /** 结构化补充信息（如字段校验明细） */
  public readonly details?: ErrorDetail[];

  /** 附加日志上下文（不会返回给客户端） */
  public readonly logContext?: Record<string, unknown>;

  constructor(
    code: number,
    userMessage?: string,
    options?: { details?: ErrorDetail[]; logContext?: Record<string, unknown>; httpStatus?: number },
  ) {
    const status = options?.httpStatus ?? httpStatusOf(code);
    super(
      {
        code,
        message: userMessage ?? messageOf(code),
        details: options?.details,
      },
      status,
    );
    this.code = code;
    this.userMessage = userMessage ?? messageOf(code);
    this.details = options?.details;
    this.logContext = options?.logContext;
  }

  // ---------------------------------------------------------------- 便捷构造

  static badRequest(
    code: number = ErrorCode.PARAM_INVALID,
    message?: string,
    details?: ErrorDetail[],
  ): BusinessException {
    return new BusinessException(code, message, { details, httpStatus: HttpStatus.BAD_REQUEST });
  }

  static unauthorized(code: number = ErrorCode.UNAUTHORIZED, message?: string): BusinessException {
    return new BusinessException(code, message, { httpStatus: HttpStatus.UNAUTHORIZED });
  }

  static forbidden(code: number = ErrorCode.PERMISSION_DENIED, message?: string): BusinessException {
    return new BusinessException(code, message, { httpStatus: HttpStatus.FORBIDDEN });
  }

  static notFound(code: number, message?: string): BusinessException {
    return new BusinessException(code, message, { httpStatus: HttpStatus.NOT_FOUND });
  }

  static conflict(code: number, message?: string, details?: ErrorDetail[]): BusinessException {
    return new BusinessException(code, message, { details, httpStatus: HttpStatus.CONFLICT });
  }

  static tooManyRequests(
    code: number = ErrorCode.RATE_LIMITED,
    message?: string,
    details?: ErrorDetail[],
  ): BusinessException {
    return new BusinessException(code, message, { details, httpStatus: HttpStatus.TOO_MANY_REQUESTS });
  }

  static internal(
    code: number = ErrorCode.INTERNAL_ERROR,
    message?: string,
    logContext?: Record<string, unknown>,
  ): BusinessException {
    return new BusinessException(code, message, { httpStatus: HttpStatus.INTERNAL_SERVER_ERROR, logContext });
  }

  static unavailable(code: number = ErrorCode.SERVICE_UNAVAILABLE, message?: string): BusinessException {
    return new BusinessException(code, message, { httpStatus: HttpStatus.SERVICE_UNAVAILABLE });
  }
}
