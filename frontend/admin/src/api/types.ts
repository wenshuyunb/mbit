/**
 * 接口通用类型：统一响应包络、分页结构、错误对象、类型守卫
 *
 * 契约来源：docs/PROJECT_ARCHITECTURE.md §6.2（统一响应包络与分页结构）、
 *          backend/src/common/dto/api-response.dto.ts（后端 DTO 实现）
 *
 * 禁止使用 `any`：所有外部输入一律以 `unknown` 接收，经类型守卫收敛后再使用。
 */

import { errorMessageOf, isAuthErrorCode } from '@/constants/error-code';

/** 字段级错误明细（仅参数校验失败时返回） */
export interface ErrorDetail {
  /** 出错字段名 */
  field: string;
  /** 具体问题描述 */
  issue: string;
}

/**
 * 后端统一响应包络
 *
 * 成功：`{ code: 0, message: 'ok', data }`
 * 失败：`{ code: <非0>, message: '<中文提示>', data: null, details? }`
 *
 * `requestId` / `timestamp` 按后端契约必然返回；此处声明为可选，
 * 以兼容「非包络响应」（如文件流、网关兜底页）与降级场景。
 */
export interface ApiResponse<T> {
  /** 业务错误码，0 表示成功（见 src/constants/error-code.ts） */
  code: number;
  /** 提示信息（中文，可直接展示） */
  message: string;
  /** 业务数据，失败时为 null */
  data: T | null;
  /** 请求追踪 ID，与响应头 X-Request-Id 一致 */
  requestId?: string;
  /** 服务端响应时间（ISO 8601 UTC） */
  timestamp?: string;
  /** 字段级错误明细 */
  details?: ErrorDetail[];
}

/** 分页数据结构（响应包络中的 data 字段） */
export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

/** 分页请求参数（pageSize ≤ 100，架构 §6.2） */
export interface PageQuery {
  page: number;
  pageSize: number;
  sortBy?: string;
  order?: 'asc' | 'desc';
}

/** 是否普通对象（非 null、非数组） */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 判定是否为后端统一响应包络 */
export const isApiResponse = <T>(value: unknown): value is ApiResponse<T> =>
  isRecord(value) && typeof value.code === 'number' && typeof value.message === 'string' && 'data' in value;

/** 判定是否为分页数据结构 */
export const isPaginatedData = <T>(value: unknown): value is PaginatedData<T> =>
  isRecord(value) && Array.isArray(value.items) && typeof value.total === 'number';

/** 构造 ApiError 的入参 */
export interface ApiErrorOptions {
  /** 业务错误码（0 以外的值） */
  code: number;
  /** 后端返回的原始提示信息，可为空 */
  message?: string;
  /** HTTP 状态码；无响应（网络不可达）时为 0 */
  httpStatus?: number;
  /** 请求追踪 ID（排障用） */
  requestId?: string;
  /** 字段级错误明细 */
  details?: ErrorDetail[];
}

/**
 * 业务错误对象
 *
 * 统一承载「错误码 + 中文提示 + HTTP 状态 + 追踪 ID」，
 * 调用方通过 `instanceof ApiError` 收敛 `unknown`，避免到处写类型断言。
 */
export class ApiError extends Error {
  /** 业务错误码 */
  readonly code: number;
  /** HTTP 状态码（0 = 无响应） */
  readonly httpStatus: number;
  /** 请求追踪 ID（为空字符串表示后端未回传） */
  readonly requestId: string;
  /** 字段级错误明细 */
  readonly details: ErrorDetail[];

  constructor(options: ApiErrorOptions) {
    const rawMessage = options.message?.trim() ?? '';
    // 后端 message 更具体（如「还有 3 道题未作答」），优先使用；为空时回退到本地错误码文案
    super(rawMessage !== '' ? rawMessage : errorMessageOf(options.code));
    this.name = 'ApiError';
    this.code = options.code;
    this.httpStatus = options.httpStatus ?? 0;
    this.requestId = options.requestId ?? '';
    this.details = options.details ?? [];
  }

  /** 是否属于「登录态失效」类错误（应跳登录页；403 无权限不算） */
  get isAuthError(): boolean {
    return this.httpStatus === 401 || isAuthErrorCode(this.code);
  }

  /** 便于日志上报与错误监控序列化 */
  toJSON(): {
    name: string;
    code: number;
    httpStatus: number;
    requestId: string;
    message: string;
    details: ErrorDetail[];
  } {
    return {
      name: this.name,
      code: this.code,
      httpStatus: this.httpStatus,
      requestId: this.requestId,
      message: this.message,
      details: this.details,
    };
  }
}
