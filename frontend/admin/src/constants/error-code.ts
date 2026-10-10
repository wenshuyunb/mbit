/**
 * 管理端错误码常量（子集）
 *
 * 来源：`backend/src/common/errors/error-code.ts`
 *   —— 后端实现是错误码的**唯一权威**来源；本文件只摘录「管理后台会出现、且前端需要分支处理」的码值。
 *   编码规范见 docs/PROJECT_ARCHITECTURE.md §6.2：AABBB = 模块(2位) + 序号(3位)，
 *   0 表示成功，其余任何非 0 值都必须在 UI 上给出可读提示。
 *
 * ⚠️ 待确认（Phase 1 前必须收敛）：docs/API_DESIGN.md §2.4.2 的错误码表与 backend 实现整体错位，
 *   例如「管理员账号或密码错误」在 API_DESIGN 记为 20013、在 backend 为 20012；
 *   「登录凭证类型不匹配（双 realm）」在 API_DESIGN 记为 20015、在 backend 为 20013。
 *   本文件一律以 **backend 实现** 为准，避免前端按文档写死后无法命中真实错误码。
 */

export const ErrorCode = {
  // ---------------------------------------------------------------- 通用 10
  /** 成功 */
  SUCCESS: 0,
  /** 未知错误（后端兜底） */
  UNKNOWN: 10000,
  /** 请求参数不合法 */
  PARAM_INVALID: 10001,
  /** 请求的资源不存在 */
  RESOURCE_NOT_FOUND: 10002,
  /** 数据已存在，请勿重复提交 */
  RESOURCE_CONFLICT: 10003,
  /** 请求过于频繁，请稍后重试 */
  RATE_LIMITED: 10007,
  /** 幂等键冲突，请勿重复提交相同请求 */
  IDEMPOTENCY_CONFLICT: 10010,
  /** 数据版本已过期（乐观锁冲突） */
  VERSION_OUTDATED: 10011,

  // ------------------------------------------------------------ 认证鉴权 20
  /** 未登录 */
  UNAUTHORIZED: 20000,
  /** 登录状态已过期（AccessToken exp 已过） */
  TOKEN_EXPIRED: 20001,
  /** 登录凭证无效（签名错误 / 被篡改 / aud 不符） */
  TOKEN_INVALID: 20002,
  /** 登录凭证已被撤销（管理员已登出） */
  TOKEN_REVOKED: 20003,
  /** RefreshToken 无效（不在白名单） */
  REFRESH_TOKEN_INVALID: 20004,
  /** 检测到 RefreshToken 复用，已撤销全部会话 */
  REFRESH_TOKEN_REUSED: 20005,
  /** 无权限执行该操作（RBAC 权限点校验失败） */
  PERMISSION_DENIED: 20009,
  /** 管理员账号已被禁用 */
  ACCOUNT_BANNED: 20010,
  /** 登录失败次数过多，账号已锁定 */
  LOGIN_TOO_MANY_ATTEMPTS: 20011,
  /** 管理员账号或密码错误 */
  ADMIN_CREDENTIALS_INVALID: 20012,
  /** 登录凭证类型不匹配（双 realm 隔离） */
  REALM_MISMATCH: 20013,

  // ---------------------------------------------------------------- 用户 30
  /** 用户不存在 */
  USER_NOT_FOUND: 30000,

  // ------------------------------------------------------- 测试与人格 40
  /** 测试定义不存在 */
  TEST_DEFINITION_NOT_FOUND: 40000,
  /** 题目不存在 */
  QUESTION_NOT_FOUND: 40009,
  /** 人格画像不存在 */
  PERSONALITY_PROFILE_NOT_FOUND: 40010,

  // ------------------------------------------------------------------ AI 50
  /** LLM 服务不可用 */
  AI_PROVIDER_UNAVAILABLE: 50000,
  /** LLM 调用超时 */
  AI_PROVIDER_TIMEOUT: 50001,
  /** Prompt 模板不存在 */
  AI_PROMPT_TEMPLATE_NOT_FOUND: 50011,
  /** Prompt 模板变量缺失 */
  AI_PROMPT_VARIABLE_MISSING: 50012,
  /** Prompt 模板渲染失败 */
  AI_PROMPT_RENDER_FAILED: 50013,
  /** 报告不存在 */
  AI_REPORT_NOT_FOUND: 50016,
  /** 报告生成中 */
  AI_REPORT_GENERATING: 50017,
  /** 报告生成失败 */
  AI_REPORT_GENERATION_FAILED: 50018,

  // ------------------------------------------------------------ 支付会员 70
  /** 商品不存在 */
  PRODUCT_NOT_FOUND: 70000,
  /** 订单不存在 */
  ORDER_NOT_FOUND: 70002,
  /** 订单状态不允许该操作 */
  ORDER_STATUS_INVALID: 70004,
  /** 订单已支付 */
  ORDER_ALREADY_PAID: 70006,
  /** 金额与服务端不一致 */
  PAYMENT_AMOUNT_MISMATCH: 70011,
  /** 当前状态不允许退款 */
  REFUND_NOT_ALLOWED: 70012,
  /** 退款失败 */
  REFUND_FAILED: 70013,

  // ------------------------------------------------------------ 系统第三方 90
  /** 服务内部错误 */
  INTERNAL_ERROR: 90000,
  /** 服务暂时不可用 */
  SERVICE_UNAVAILABLE: 90001,
  /** 数据库错误 */
  DATABASE_ERROR: 90002,
  /** 队列错误 */
  QUEUE_ERROR: 90004,
  /** 系统维护中 */
  MAINTENANCE_MODE: 90007,
  /** 服务端配置缺失 */
  CONFIG_MISSING: 90008,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * 需要「跳转登录页」的错误码：登录态缺失或凭证失效。
 * 注意：PERMISSION_DENIED(20009) 属于「已登录但无权限」，**不得**触发跳登录，否则会把用户踢出。
 */
const AUTH_ERROR_CODES: readonly number[] = [
  ErrorCode.UNAUTHORIZED,
  ErrorCode.TOKEN_EXPIRED,
  ErrorCode.TOKEN_INVALID,
  ErrorCode.TOKEN_REVOKED,
  ErrorCode.REFRESH_TOKEN_INVALID,
  ErrorCode.REFRESH_TOKEN_REUSED,
  ErrorCode.REALM_MISMATCH,
];

/** 判断错误码是否属于「登录态失效」类（应跳登录页） */
export const isAuthErrorCode = (code: number): boolean => AUTH_ERROR_CODES.includes(code);

/** 客户端本地构造的错误码（不来自后端）：网络不可达 / 请求超时 */
export const CLIENT_ERROR_CODE = {
  /** 网络不可达（无 HTTP 响应） */
  NETWORK_ERROR: ErrorCode.SERVICE_UNAVAILABLE,
  /** 请求超时 */
  TIMEOUT: ErrorCode.SERVICE_UNAVAILABLE,
} as const;

/** 错误码 → 中文文案（仅收录上面的子集；未收录时由后端返回的 message 兜底） */
export const ERROR_CODE_MESSAGES: Readonly<Record<number, string>> = {
  [ErrorCode.UNKNOWN]: '未知错误，请稍后重试',
  [ErrorCode.PARAM_INVALID]: '请求参数不合法',
  [ErrorCode.RESOURCE_NOT_FOUND]: '请求的资源不存在',
  [ErrorCode.RESOURCE_CONFLICT]: '数据已存在，请勿重复提交',
  [ErrorCode.RATE_LIMITED]: '请求过于频繁，请稍后重试',
  [ErrorCode.IDEMPOTENCY_CONFLICT]: '请勿重复提交相同请求',
  [ErrorCode.VERSION_OUTDATED]: '数据已被他人修改，请刷新后重试',

  [ErrorCode.UNAUTHORIZED]: '请先登录',
  [ErrorCode.TOKEN_EXPIRED]: '登录状态已过期，请重新登录',
  [ErrorCode.TOKEN_INVALID]: '登录凭证无效，请重新登录',
  [ErrorCode.TOKEN_REVOKED]: '登录凭证已失效，请重新登录',
  [ErrorCode.REFRESH_TOKEN_INVALID]: '登录凭证已失效，请重新登录',
  [ErrorCode.REFRESH_TOKEN_REUSED]: '检测到异常登录，已退出全部会话',
  [ErrorCode.PERMISSION_DENIED]: '无权限执行该操作',
  [ErrorCode.ACCOUNT_BANNED]: '账号已被禁用',
  [ErrorCode.LOGIN_TOO_MANY_ATTEMPTS]: '登录失败次数过多，账号已锁定，请稍后重试',
  [ErrorCode.ADMIN_CREDENTIALS_INVALID]: '管理员账号或密码错误',
  [ErrorCode.REALM_MISMATCH]: '登录凭证类型不匹配，请重新登录',

  [ErrorCode.USER_NOT_FOUND]: '用户不存在',
  [ErrorCode.TEST_DEFINITION_NOT_FOUND]: '测试定义不存在',
  [ErrorCode.QUESTION_NOT_FOUND]: '题目不存在',
  [ErrorCode.PERSONALITY_PROFILE_NOT_FOUND]: '人格画像不存在',

  [ErrorCode.AI_PROVIDER_UNAVAILABLE]: 'AI 服务暂时不可用，请稍后重试',
  [ErrorCode.AI_PROVIDER_TIMEOUT]: 'AI 服务响应超时，请稍后重试',
  [ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND]: 'Prompt 模板不存在',
  [ErrorCode.AI_PROMPT_VARIABLE_MISSING]: 'Prompt 模板变量缺失',
  [ErrorCode.AI_PROMPT_RENDER_FAILED]: 'Prompt 模板渲染失败',
  [ErrorCode.AI_REPORT_NOT_FOUND]: '报告不存在',
  [ErrorCode.AI_REPORT_GENERATING]: '报告正在生成中，请稍后查看',
  [ErrorCode.AI_REPORT_GENERATION_FAILED]: '报告生成失败',

  [ErrorCode.PRODUCT_NOT_FOUND]: '商品不存在',
  [ErrorCode.ORDER_NOT_FOUND]: '订单不存在',
  [ErrorCode.ORDER_STATUS_INVALID]: '当前订单状态不支持该操作',
  [ErrorCode.ORDER_ALREADY_PAID]: '订单已支付，请勿重复操作',
  [ErrorCode.PAYMENT_AMOUNT_MISMATCH]: '金额与服务端不一致，请刷新后重试',
  [ErrorCode.REFUND_NOT_ALLOWED]: '当前订单状态不允许退款',
  [ErrorCode.REFUND_FAILED]: '退款失败，请稍后重试',

  [ErrorCode.INTERNAL_ERROR]: '服务异常，请稍后重试',
  [ErrorCode.SERVICE_UNAVAILABLE]: '服务暂时不可用，请稍后重试',
  [ErrorCode.DATABASE_ERROR]: '服务繁忙，请稍后重试',
  [ErrorCode.QUEUE_ERROR]: '任务队列异常，请稍后重试',
  [ErrorCode.MAINTENANCE_MODE]: '系统维护中，请稍后重试',
  [ErrorCode.CONFIG_MISSING]: '服务端配置缺失，请联系管理员',
};

/**
 * 取错误码对应的中文文案
 * @param code 错误码
 * @param fallback 未收录时使用的兜底文案（通常传后端返回的 message）
 */
export const errorMessageOf = (code: number, fallback?: string): string =>
  ERROR_CODE_MESSAGES[code] ?? fallback ?? ERROR_CODE_MESSAGES[ErrorCode.UNKNOWN] ?? '请求失败';
