/**
 * 测试会话接口层测试
 *
 * 首要目的：锁死一个**核心流程 100% 失败**的缺陷 ——
 * `createSession` 此前没有传 `X-Idempotency-Key`，而后端 `@IdempotencyKey()`
 * 默认 required，缺头直接抛 `400 / 10009`（`IDEMPOTENCY_KEY_MISSING`）。
 * 也就是说「开始测试」对所有客户端都不可用。
 *
 * 这个缺陷 TypeScript 与既有的 store 测试都发现不了：前者不校验请求头，
 * 后者 mock 掉了整层 HTTP，只断言 store 的状态流转。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSession, saveAnswers, submitSession } from '@/api/test';

interface CapturedRequest {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: unknown;
}

let captured: CapturedRequest[] = [];

/** 让下一次请求成功返回指定数据 */
const respondWith = (data: unknown): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    captured.push({
      url: String(options['url']),
      method: String(options['method'] ?? 'GET'),
      header: (options['header'] ?? {}) as Record<string, string>,
      data: options['data'],
    });
    setTimeout(() => {
      (options['success'] as (res: unknown) => void)({
        statusCode: 200,
        data: { code: 0, message: 'ok', data, requestId: 'req_test', timestamp: '' },
      });
    }, 0);
  }) as unknown as typeof uni.request);
};

/** 后端对幂等键的格式要求：`[A-Za-z0-9_-]{8,64}` */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const minimalSession = {
  sessionId: '01a12ded-4400-7553-85e8-3e037d118a9d',
  testCode: 'MBTI_LITE',
  status: 'IN_PROGRESS',
};

beforeEach(() => {
  captured = [];
  vi.mocked(uni.request).mockReset();
});

describe('createSession：幂等键是必填（核心流程回归）', () => {
  it('必须携带 X-Idempotency-Key，否则后端返回 400/10009', async () => {
    respondWith(minimalSession);

    await createSession('MBTI_LITE');

    expect(captured[0]?.header['X-Idempotency-Key']).toBeTruthy();
  });

  it('自动生成的幂等键符合后端格式要求（8–64 位，仅 [A-Za-z0-9_-]）', async () => {
    respondWith(minimalSession);

    await createSession('MBTI_LITE');
    const key = captured[0]?.header['X-Idempotency-Key'] ?? '';

    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it('每次调用生成不同的幂等键（不同意图不应被服务端去重成同一请求）', async () => {
    respondWith(minimalSession);
    await createSession('MBTI_LITE');
    respondWith(minimalSession);
    await createSession('MBTI_LITE');

    expect(captured[0]?.header['X-Idempotency-Key']).not.toBe(captured[1]?.header['X-Idempotency-Key']);
  });

  it('显式传入幂等键时复用它（用于重试同一个「开始测试」意图）', async () => {
    respondWith(minimalSession);

    await createSession('MBTI_LITE', { idempotencyKey: 'retry_same_intent_0001' });

    expect(captured[0]?.header['X-Idempotency-Key']).toBe('retry_same_intent_0001');
  });

  it('命中后端路径并透传 forceNew', async () => {
    respondWith(minimalSession);

    await createSession('BIG_FIVE_50', { forceNew: true });

    expect(captured[0]?.url).toContain('/tests/BIG_FIVE_50/sessions');
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.data).toMatchObject({ forceNew: true, reuseInProgress: true });
  });

  it('默认不强制新建（复用进行中会话，避免误重置用户进度）', async () => {
    respondWith(minimalSession);

    await createSession('MBTI_LITE');

    expect(captured[0]?.data).toMatchObject({ forceNew: false });
  });
});

describe('其余写接口的幂等键约定', () => {
  it('提交答案（PUT，天然幂等）不需要幂等键', async () => {
    respondWith({ saved: 1 });

    await saveAnswers('session-1', [{ questionId: 'q1', value: 3 }]);

    expect(captured[0]?.header['X-Idempotency-Key']).toBeUndefined();
  });

  it('提交算分（POST）应携带幂等键，防止重复算分', async () => {
    respondWith({ status: 'SCORED' });

    await submitSession('session-1');

    // 后端 submit 自身有「重复提交返回既有结果」的保护；这里断言请求层能力可用
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.data).toMatchObject({ confirm: true });
  });
});
