/**
 * AI 管家接口层测试（ADR-038 阶段 5）
 *
 * ## 锁死的两件事
 *
 *   1. **`ALL_MODULES` 真的发出去了**：管家"读三个模块"完全依赖这个字段。
 *      它曾在实现里被传给**建会话**接口（`CreateConversationDto` 没有该字段，
 *      全局管道 `forbidNonWhitelisted` 直接 `400 / 10001`），
 *      也可能被顺手删掉而不报任何错 —— 后者会让功能静默退化成"普通助手"。
 *   2. **幂等键真的带上了**：`POST /ai/conversations` 与
 *      `POST .../messages` 的 `@IdempotencyKey()` 默认必填，
 *      缺头直接 `400 IDEMPOTENCY_KEY_MISSING`。旧版 chat.ts 只在显式传入时
 *      才写这个头（`idempotencyKey: undefined`），即"点一次发送必然 400"。
 *      这不属于类型问题（tsc 不校验请求头），只能靠这层断言。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createConversation, sendMessage } from '@/api/chat';

interface CapturedRequest {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: unknown;
}

let captured: CapturedRequest[] = [];

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

const CONVERSATION_ID = '01a139ca-f3ff-7132-af15-953c9b59016e';

const minimalTurn = {
  conversationId: CONVERSATION_ID,
  blocked: false,
  blockedReason: null,
  userMessage: { messageId: 'm1', role: 'USER', content: '你好' },
  assistantMessage: { messageId: 'm2', role: 'ASSISTANT', content: '你好，我是你的管家' },
};

beforeEach(() => {
  captured = [];
  vi.mocked(uni.request).mockReset();
});

describe('sendMessage：管家必须带 ALL_MODULES 上下文', () => {
  it('默认携带 contextHints: [ALL_MODULES]（否则管家读不到三个模块）', async () => {
    respondWith(minimalTurn);

    await sendMessage(CONVERSATION_ID, '帮我总结一下');

    expect(captured[0]?.data).toMatchObject({ contextHints: ['ALL_MODULES'] });
  });

  it('contextHints 是**发消息**的参数，不是建会话的（建会话传它会 400/10001）', async () => {
    respondWith({ conversationId: CONVERSATION_ID });

    await createConversation({ title: 'AI 管家', mode: 'COMPANION' });

    expect(captured[0]?.data).not.toHaveProperty('contextHints');
  });

  it('命中非流式发消息路径，且透传 content', async () => {
    respondWith(minimalTurn);

    await sendMessage(CONVERSATION_ID, '我最近有点累');

    expect(captured[0]?.url).toContain(`/ai/conversations/${CONVERSATION_ID}/messages`);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.data).toMatchObject({ content: '我最近有点累' });
  });

  it('可以覆盖 contextHints（例如只要最近报告）', async () => {
    respondWith(minimalTurn);

    await sendMessage(CONVERSATION_ID, '看看我的报告', { contextHints: ['RECENT_REPORT'] });

    expect(captured[0]?.data).toMatchObject({ contextHints: ['RECENT_REPORT'] });
  });
});

describe('写接口的幂等键约定（缺头即 400）', () => {
  it('发消息必须带 X-Idempotency-Key', async () => {
    respondWith(minimalTurn);

    await sendMessage(CONVERSATION_ID, '你好');

    expect(captured[0]?.header['X-Idempotency-Key']).toBeTruthy();
  });

  it('建会话必须带 X-Idempotency-Key（旧版漏了，核心流程 100% 失败）', async () => {
    respondWith({ conversationId: CONVERSATION_ID });

    await createConversation({ mode: 'COMPANION' });

    expect(captured[0]?.header['X-Idempotency-Key']).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it('同一条消息重试复用同一个幂等键（否则会多发一条、多扣一次额度）', async () => {
    respondWith(minimalTurn);

    await sendMessage(CONVERSATION_ID, '同一句话', { idempotencyKey: 'retry_same_message_0001' });

    expect(captured[0]?.header['X-Idempotency-Key']).toBe('retry_same_message_0001');
  });

  it('两次不同的发送使用不同的幂等键（不同意图不该被去重）', async () => {
    respondWith(minimalTurn);
    await sendMessage(CONVERSATION_ID, '第一句');
    respondWith(minimalTurn);
    await sendMessage(CONVERSATION_ID, '第二句');

    expect(captured[0]?.header['X-Idempotency-Key']).not.toBe(captured[1]?.header['X-Idempotency-Key']);
  });
});
