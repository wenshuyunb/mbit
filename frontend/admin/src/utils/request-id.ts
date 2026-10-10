/**
 * 请求追踪 ID（X-Request-Id）生成
 *
 * 契约来源：backend/src/common/middleware/request-id.middleware.ts
 *   - 客户端生成的请求 ID 必须匹配 `^[A-Za-z0-9_-]{8,64}$`，否则服务端会忽略并重新生成（不报错）；
 *   - 服务端会在响应头回显最终生效的 requestId，排障时凭它查日志（架构 §15.1）。
 *
 * 实现：优先使用 crypto.randomUUID()（浏览器原生、无依赖、随机源安全）；
 *      不可用时（老浏览器 / 非 HTTPS 的局域网环境）退化为「时间戳 + Math.random」的 UUID v4 形态，
 *      保证格式合法即可 —— 它只用于日志串联，不承担安全职责。
 */

/** 请求 ID 请求头名称（与后端 REQUEST_ID_HEADER 一致） */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 请求 ID 前缀（与后端 `req_${uuidv7()}` 风格保持一致） */
export const REQUEST_ID_PREFIX = 'req_';

/** 与后端 CLIENT_ID_PATTERN 完全一致的白名单校验 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** UUID v4 模板：x = 随机十六进制，y = 变体位（8/9/a/b） */
const UUID_V4_TEMPLATE = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';

const randomHex = (): string => Math.floor(Math.random() * 16).toString(16);

/** 退化的 UUID v4：无 crypto.randomUUID 时使用 */
const fallbackUuid = (): string =>
  UUID_V4_TEMPLATE.replace(/x/g, randomHex).replace(/y/g, (): string =>
    (Math.floor(Math.random() * 4) + 8).toString(16),
  );

const randomUuid = (): string => {
  const context: { randomUUID?: () => string } | undefined = globalThis.crypto;
  if (typeof context?.randomUUID === 'function') return context.randomUUID();
  return fallbackUuid();
};

/** 生成一个请求追踪 ID，形如 `req_0192f3c1-7a4b-7c3d-9e2f-1a2b3c4d5e6f` */
export const generateRequestId = (): string => `${REQUEST_ID_PREFIX}${randomUuid()}`;

/** 判定字符串是否符合后端允许的请求 ID 格式 */
export const isValidRequestId = (value: string): boolean => CLIENT_ID_PATTERN.test(value);
