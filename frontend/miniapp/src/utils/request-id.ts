/**
 * 请求追踪 ID 生成
 *
 * 与服务端 RequestIdMiddleware 的校验规则保持一致：
 *   格式 ^[A-Za-z0-9_-]{8,64}$
 * 若客户端生成的 ID 不符合该规则，服务端会丢弃并重新生成，链路就断了。
 *
 * 优先使用 crypto.randomUUID（小程序基础库 2.30+ 提供），
 * 环境不支持时回退到时间戳 + 随机串。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 生成一个符合服务端校验规则的请求 ID */
export const createRequestId = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

  if (cryptoApi?.randomUUID) {
    try {
      const uuid = cryptoApi.randomUUID();
      if (UUID_PATTERN.test(uuid)) {
        return `req_${uuid}`;
      }
    } catch {
      // 忽略，走下面的回退逻辑
    }
  }

  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12);
  return `req_${timestamp}${random}`;
};

/**
 * 生成幂等键（用于必须幂等的写接口：下单、提交测试、创建邀请等）
 *
 * 语义：同一业务操作重复提交时携带相同 key，服务端据此去重。
 * 因此幂等键必须在「用户触发操作时生成一次并复用」，不能每次重试都换新值。
 */
export const createIdempotencyKey = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};
