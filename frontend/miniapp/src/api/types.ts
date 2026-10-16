/**
 * API 类型定义
 *
 * 与后端契约的对应关系见 docs/API_DESIGN.md：
 *   · 统一响应包络 { code, message, data, requestId, timestamp }
 *   · 分页响应 data: { items, total, page, pageSize, hasNext }
 *   · 业务错误码分段规则见 docs/PROJECT_ARCHITECTURE.md §6.2
 *
 * 后续可由 openapi-typescript 从后端 openapi.json 生成到 types/openapi.d.ts，
 * 本文件的「手写契约」用于生成物就绪前的开发，两者的结构必须保持一致。
 */

/** 统一响应包络 */
export interface ApiResponse<T> {
  /** 业务错误码，0 表示成功 */
  code: number;
  /** 中文提示信息，可直接展示 */
  message: string;
  /** 业务数据，失败时为 null */
  data: T | null;
  /** 请求追踪 ID（客服排障凭据） */
  requestId: string;
  /** 服务端时间（ISO 8601 UTC） */
  timestamp: string;
  /** 参数校验失败时的字段级明细 */
  details?: Array<{ field?: string; issue: string }>;
}

/** 分页数据体 */
export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

/** 分页请求参数 */
export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

/** HTTP 方法 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** 请求选项 */
export interface RequestOptions {
  /** 路径，如 /users/me（会与 baseUrl 拼接） */
  url: string;
  method?: HttpMethod;
  /** 请求体（POST/PUT/PATCH）或查询参数（GET） */
  data?: Record<string, unknown> | unknown;
  /** 附加请求头 */
  header?: Record<string, string>;
  /** 超时毫秒；AI 相关接口传 timeout.ai */
  timeout?: number;
  /** 是否需要携带登录态，默认 true */
  needAuth?: boolean;
  /** 失败时是否自动 toast，默认 true；需要自定义错误 UI 时传 false */
  showError?: boolean;
  /** 是否显示 loading；传字符串可自定义文案 */
  loading?: boolean | string;
  /** 幂等键（服务端要求的写接口必须携带） */
  idempotencyKey?: string;
  /** 额外重试次数（仅对幂等的 GET 生效） */
  retry?: number;
  /** 取消标识：同一 key 的后发请求会取消先发请求 */
  cancelKey?: string;
}

/** 业务错误对象：由请求层统一抛出，页面可按错误码分支处理 */
export class ApiError extends Error {
  /** 业务错误码（后端定义） */
  readonly code: number;

  /** HTTP 状态码；网络层失败时为 0 */
  readonly httpStatus: number;

  /** 请求追踪 ID */
  readonly requestId: string;

  /** 字段级错误明细 */
  readonly details: Array<{ field?: string; issue: string }>;

  /** 是否为网络/超时类错误（无后端响应） */
  readonly isNetworkError: boolean;

  constructor(params: {
    code: number;
    message: string;
    httpStatus: number;
    requestId?: string;
    details?: Array<{ field?: string; issue: string }>;
    isNetworkError?: boolean;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.requestId = params.requestId ?? '';
    this.details = params.details ?? [];
    this.isNetworkError = params.isNetworkError ?? false;
  }

  /** 登录态失效（需要重新登录） */
  get isUnauthorized(): boolean {
    return this.httpStatus === 401;
  }

  /** 需要付费解锁（单次购买报告 / 权益缺失） */
  get isPaymentRequired(): boolean {
    return (
      this.code === ERROR_CODES.AI_REPORT_NOT_UNLOCKED ||
      this.code === ERROR_CODES.ENTITLEMENT_REQUIRED ||
      this.code === ERROR_CODES.ENTITLEMENT_NOT_FOUND
    );
  }

  /** 需要会员权益（AI 次数用尽 / 会员过期） */
  get isMembershipRequired(): boolean {
    return this.code === ERROR_CODES.AI_QUOTA_EXCEEDED || this.code === ERROR_CODES.MEMBERSHIP_EXPIRED;
  }
}

/** 错误码常量（与后端 src/common/errors/error-code.ts 对齐，只保留小程序端会分支处理的） */
export const ERROR_CODES = {
  SUCCESS: 0,
  UNKNOWN: 10000,
  PARAM_INVALID: 10001,
  RATE_LIMITED: 10007,

  UNAUTHORIZED: 20000,
  TOKEN_EXPIRED: 20001,
  TOKEN_INVALID: 20002,
  TOKEN_REVOKED: 20003,
  REFRESH_TOKEN_INVALID: 20004,
  REFRESH_TOKEN_REUSED: 20005,
  ACCOUNT_BANNED: 20010,

  CONSENT_REQUIRED: 30002,
  AGE_RESTRICTED: 30009,
  /**
   * 尚未设置出生日期（星座运势的前置条件）
   *
   * 与后端 `error-code.ts` 的 `ZODIAC_BIRTHDAY_REQUIRED` 同步。
   * 星座页据此**精确分支**（弹出生日期选择器），而不是把所有 4xx 都当成"加载失败"。
   */
  ZODIAC_BIRTHDAY_REQUIRED: 30019,

  TEST_SESSION_EXPIRED: 40004,
  TEST_SESSION_ALREADY_SUBMITTED: 40005,
  TEST_ANSWER_INCOMPLETE: 40006,
  PERSONALITY_PROFILE_NOT_FOUND: 40010,

  AI_QUOTA_EXCEEDED: 50006,
  AI_SAFETY_INTERVENTION: 50014,
  AI_REPORT_NOT_FOUND: 50016,
  AI_REPORT_GENERATING: 50017,
  AI_REPORT_GENERATION_FAILED: 50018,
  AI_REPORT_NOT_UNLOCKED: 50019,
  /** 重新生成需要会员权益（Phase 6 前不会触发） */
  AI_REPORT_REGENERATE_FORBIDDEN: 50020,

  RELATIONSHIP_INVITE_EXPIRED: 60004,
  RELATIONSHIP_INVITE_SELF: 60006,
  COMPATIBILITY_PEER_NOT_READY: 60009,
  COMPATIBILITY_GENERATING: 60011,

  ORDER_EXPIRED: 70005,
  ORDER_ALREADY_PAID: 70006,
  MEMBERSHIP_EXPIRED: 70015,
  ENTITLEMENT_REQUIRED: 70016,
  ENTITLEMENT_NOT_FOUND: 70017,
} as const;
