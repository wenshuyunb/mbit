/**
 * 全局异常过滤器 — 所有异常的最终出口
 *
 * 职责：
 *   1. 统一错误响应结构（与成功响应同构：code / message / data / requestId / timestamp）
 *   2. 把框架异常（HttpException、ValidationPipe）、数据库异常、未知异常
 *      归一到 BusinessException 契约
 *   3. 结构化日志：4xx 记 warn，5xx 记 error（含堆栈），并带上 requestId / userId
 *   4. 生产环境绝不把内部错误细节返回给客户端
 *
 * 分层约定：common 层不依赖 Prisma 运行时，因此这里用结构化类型守卫识别数据库错误
 * （见 isPrismaKnownError），避免基础设施耦合到公共层。
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Response } from 'express';
import { ErrorCode, messageOf } from '../errors/error-code';
import { BusinessException, type ErrorDetail } from '../errors/business.exception';
import type { RequestWithContext } from '../types/request.type';

/** Prisma 已知错误的结构化形状（避免 common 层 import @prisma/client） */
interface PrismaKnownErrorLike {
  code: string;
  meta?: Record<string, unknown>;
  message: string;
}

const isPrismaKnownError = (e: unknown): e is PrismaKnownErrorLike => {
  if (typeof e !== 'object' || e === null) return false;
  const candidate = e as { name?: unknown; code?: unknown };
  return (
    typeof candidate.name === 'string' &&
    candidate.name.startsWith('PrismaClient') &&
    typeof candidate.code === 'string' &&
    /^P\d{4}$/.test(candidate.code)
  );
};

/** Prisma 错误码 → 业务错误码映射 */
const mapPrismaError = (code: string): { code: number; message: string; status: number } => {
  switch (code) {
    case 'P2002': // 唯一约束冲突
      return { code: ErrorCode.RESOURCE_CONFLICT, message: '数据已存在，请勿重复提交', status: HttpStatus.CONFLICT };
    case 'P2003': // 外键约束失败
      return { code: ErrorCode.PARAM_INVALID, message: '关联数据不存在', status: HttpStatus.BAD_REQUEST };
    case 'P2025': // 记录不存在
      return { code: ErrorCode.RESOURCE_NOT_FOUND, message: '请求的资源不存在', status: HttpStatus.NOT_FOUND };
    case 'P1001':
    case 'P1002':
      return {
        code: ErrorCode.DATABASE_ERROR,
        message: '数据服务暂时不可用',
        status: HttpStatus.SERVICE_UNAVAILABLE,
      };
    case 'P2024': // 连接池超时
      return {
        code: ErrorCode.DATABASE_ERROR,
        message: '服务繁忙，请稍后重试',
        status: HttpStatus.SERVICE_UNAVAILABLE,
      };
    default:
      return { code: ErrorCode.DATABASE_ERROR, message: messageOf(ErrorCode.DATABASE_ERROR), status: 500 };
  }
};

/** HTTP 状态码 → 兜底业务错误码映射 */
const FALLBACK_CODE_BY_STATUS: ReadonlyMap<number, number> = new Map([
  [HttpStatus.BAD_REQUEST, ErrorCode.PARAM_INVALID],
  [HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED],
  [HttpStatus.FORBIDDEN, ErrorCode.PERMISSION_DENIED],
  [HttpStatus.NOT_FOUND, ErrorCode.RESOURCE_NOT_FOUND],
  [HttpStatus.CONFLICT, ErrorCode.RESOURCE_CONFLICT],
  [HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.PAYLOAD_TOO_LARGE],
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE],
  [HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED],
  [HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE],
  [HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR],
]);

interface NormalizedError {
  code: number;
  message: string;
  status: number;
  details?: ErrorDetail[];
  /** 是否需要打印堆栈（5xx / 未知异常） */
  severe: boolean;
  logContext?: Record<string, unknown>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithContext>();

    const normalized = this.normalize(exception);

    const body = {
      code: normalized.code,
      message: normalized.message,
      data: null,
      requestId: request?.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
      ...(normalized.details && normalized.details.length > 0 ? { details: normalized.details } : {}),
    };

    const logPayload = {
      requestId: request?.requestId,
      userId: request?.principal?.userId,
      method: request?.method,
      url: request?.originalUrl,
      status: normalized.status,
      code: normalized.code,
      latencyMs: request?.startedAt ? Date.now() - request.startedAt : undefined,
      ...normalized.logContext,
    };

    if (normalized.severe) {
      this.logger.error({ ...logPayload, err: this.serializeError(exception) }, `请求处理失败: ${normalized.message}`);
    } else {
      this.logger.warn(logPayload, `请求被拒绝: ${normalized.message}`);
    }

    // 响应已发出（如 SSE 流中途出错）时不再重复写入
    if (response.headersSent) {
      return;
    }

    response.status(normalized.status).json(body);
  }

  // ------------------------------------------------------------------ 归一化

  private normalize(exception: unknown): NormalizedError {
    // 1) 业务异常
    if (exception instanceof BusinessException) {
      return {
        code: exception.code,
        message: exception.userMessage,
        status: exception.getStatus(),
        details: exception.details,
        severe: exception.getStatus() >= 500,
        logContext: exception.logContext,
      };
    }

    // 2) 框架 HTTP 异常（含 ValidationPipe 抛出的 BadRequestException）
    if (exception instanceof HttpException) {
      return this.normalizeHttpException(exception);
    }

    // 3) 数据库异常
    if (isPrismaKnownError(exception)) {
      const mapped = mapPrismaError(exception.code);
      return {
        code: mapped.code,
        message: mapped.message,
        status: mapped.status,
        severe: mapped.status >= 500,
        logContext: { prismaCode: exception.code, prismaMeta: exception.meta },
      };
    }

    // 4) 未知异常：对外只给通用文案，细节仅进日志
    return {
      code: ErrorCode.INTERNAL_ERROR,
      message: messageOf(ErrorCode.INTERNAL_ERROR),
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      severe: true,
    };
  }

  private normalizeHttpException(exception: HttpException): NormalizedError {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    // ValidationPipe 的标准输出：{ statusCode, message: string[], error }
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;

      // 已是统一错误结构（如自定义守卫抛出）
      if (typeof record.code === 'number') {
        return {
          code: record.code,
          message: typeof record.message === 'string' ? record.message : messageOf(record.code),
          status,
          details: Array.isArray(record.details) ? (record.details as ErrorDetail[]) : undefined,
          severe: status >= 500,
        };
      }

      const rawMessage = record.message;
      const messages = Array.isArray(rawMessage) ? rawMessage.map(String) : [];

      if (messages.length > 0) {
        return {
          code: ErrorCode.PARAM_INVALID,
          message: '请求参数不合法',
          status,
          details: messages.map((issue) => ({ issue })),
          severe: false,
        };
      }

      return {
        code: this.defaultCodeForStatus(status),
        message: typeof rawMessage === 'string' ? rawMessage : messageOf(this.defaultCodeForStatus(status)),
        status,
        severe: status >= 500,
      };
    }

    return {
      code: this.defaultCodeForStatus(status),
      message: typeof payload === 'string' ? payload : messageOf(this.defaultCodeForStatus(status)),
      status,
      severe: status >= 500,
    };
  }

  /** HTTP 状态码 → 兜底业务错误码（用查表替代 switch，避免枚举比较的类型噪音） */
  private defaultCodeForStatus(status: number): number {
    const mapped = FALLBACK_CODE_BY_STATUS.get(status);
    if (mapped !== undefined) return mapped;

    return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.PARAM_INVALID;
  }

  private serializeError(exception: unknown): Record<string, unknown> {
    if (exception instanceof Error) {
      return {
        name: exception.name,
        message: exception.message,
        stack: exception.stack,
      };
    }
    return { message: String(exception) };
  }
}
