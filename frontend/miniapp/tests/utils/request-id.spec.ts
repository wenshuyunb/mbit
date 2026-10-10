/**
 * 请求追踪 ID 与幂等键测试
 *
 * 关键约束：服务端 RequestIdMiddleware 用 ^[A-Za-z0-9_-]{8,64}$ 校验客户端传入的
 * X-Request-Id，不符合则丢弃并重新生成。若客户端生成的 ID 不合规，链路追踪就断了，
 * 因此这里把该格式约束固化为可执行测试。
 */

import { describe, expect, it } from 'vitest';

import { createIdempotencyKey, createRequestId } from '@/utils/request-id';

/** 与服务端 middleware 保持一致的正则 */
const SERVER_ACCEPTED_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

describe('createRequestId', () => {
  it('生成的 ID 必须被服务端接受', () => {
    for (let index = 0; index < 50; index += 1) {
      const id = createRequestId();
      expect(id).toMatch(SERVER_ACCEPTED_PATTERN);
      // 额外校验：长度不超过 64，避免被服务端判定为非法
      expect(id.length).toBeLessThanOrEqual(64);
    }
  });

  it('带 req_ 前缀，便于日志检索', () => {
    expect(createRequestId().startsWith('req_')).toBe(true);
  });

  it('连续生成 1000 个不重复', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      ids.add(createRequestId());
    }
    expect(ids.size).toBe(1000);
  });

  it('crypto.randomUUID 不可用时仍生成合规 ID（回退分支）', () => {
    const originalCrypto = (globalThis as { crypto?: unknown }).crypto;

    // 模拟低版本基础库：无 crypto.randomUUID
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });

    try {
      const id = createRequestId();
      expect(id).toMatch(SERVER_ACCEPTED_PATTERN);
      expect(id.startsWith('req_')).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    }
  });

  it('crypto.randomUUID 抛异常时走回退分支而不是崩溃', () => {
    const originalCrypto = (globalThis as { crypto?: unknown }).crypto;

    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: () => {
          throw new Error('not allowed in this context');
        },
      },
      configurable: true,
    });

    try {
      expect(() => createRequestId()).not.toThrow();
      expect(createRequestId()).toMatch(SERVER_ACCEPTED_PATTERN);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    }
  });
});

describe('createIdempotencyKey', () => {
  it('格式合规（服务端按字符串存储并要求唯一）', () => {
    const key = createIdempotencyKey();
    expect(key).toMatch(SERVER_ACCEPTED_PATTERN);
  });

  it('每次调用生成不同值（同一业务操作需复用同一 key，由调用方保证）', () => {
    expect(createIdempotencyKey()).not.toBe(createIdempotencyKey());
  });
});
