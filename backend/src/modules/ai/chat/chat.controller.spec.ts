/**
 * `POST /ai/conversations/:conversationId/messages` 的响应包络契约（§3.7.5）
 *
 * ## 守的是什么
 *
 * 本方法**自己**就构造完整包络（`envelope(...)`；危险内容拦截分支手写信封），
 * 所以它必须标 `@RawResponse()` 跳过全局 `TransformInterceptor`。
 *
 * 此前漏了这个装饰器，于是响应被**套了两层**（实测 `data.data.assistantMessage`）：
 *
 *   1. 小程序 `request.ts` 只解一层包络（`return result.body.data`），
 *      拿到的会是**内层信封**，`assistantMessage` 恒为 `undefined`；
 *   2. 更严重的是危险内容拦截要求**顶层 `code = 50008`**，被重新包成顶层
 *      `code = 0` 之后，前端会当成功响应处理 ——
 *      「渲染关怀文案与资源卡、禁止弹错误 Toast」这条**安全契约整体失效**，
 *      而它恰恰是自伤高危内容出现时的那条路径。
 *
 * ## 为什么必须测行为而不只测装饰器
 *
 * 只断言 `RAW_RESPONSE_KEY === true` 的话，一旦有人换成 `@Res()` 手写响应、
 * 或改成返回 `ApiResponseDto`，断言会失效但缺陷会回来。
 * 因此下面的用例**真的把控制器调起来**，并断言返回值是**单层**信封。
 */

import { HttpStatus, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { RAW_RESPONSE_KEY } from '../../../common/interceptors/transform.interceptor';
import { ChatController } from './chat.controller';

const CONVERSATION_ID = '01a1342e-d306-7f20-be30-48a592e17aa5';
const REQUEST_ID = 'req_01a1342e-d306-7f20-be30-48a592e17aa5';

/** 非拦截路径的轮次结果（形状取自 `ChatTurnResult`，只保留断言用到的字段） */
const OK_RESULT = {
  conversationId: CONVERSATION_ID,
  blocked: false,
  blockedReason: null,
  matchedCategory: null,
  resources: [],
  userMessage: { messageId: 'u-1', role: 'USER', content: '你好', tokens: 3 },
  assistantMessage: { messageId: 'a-1', role: 'ASSISTANT', content: '真实回复内容', tokens: 42 },
  usage: { totalTokens: 45 },
  quota: { consumed: 1, remainingToday: 9, dailyLimit: 10, creditBalance: 0 },
};

/** 危险内容拦截路径：不调用模型，顶层必须是 50008 */
const BLOCKED_RESULT = {
  conversationId: CONVERSATION_ID,
  blocked: true,
  blockedReason: 'SAFETY_KEYWORD_MATCH',
  matchedCategory: 'SELF_HARM',
  resources: [{ name: '全国心理援助热线', phone: '12356', available: '24 小时' }],
  userMessage: { messageId: 'u-2', role: 'USER', content: '我觉得活着没意思', tokens: 8 },
  assistantMessage: {
    messageId: 'a-2',
    role: 'ASSISTANT',
    content: '谢谢你愿意说出来',
    tokens: 0,
    isSafetyResponse: true,
  },
  usage: { totalTokens: 0 },
  quota: { consumed: 0, remainingToday: 10, dailyLimit: 10, creditBalance: 0 },
};

/** 取返回值里最外层信封的 `data`（用宽松类型读，便于断言"没有内层信封"） */
const outerDataOf = (response: unknown): Record<string, unknown> =>
  (response as { data: Record<string, unknown> }).data;

interface Harness {
  controller: ChatController;
  runTurn: jest.Mock;
}

const createHarness = (result: unknown): Harness => {
  const runTurn = jest.fn().mockResolvedValue(result);
  const controller = new ChatController(
    {} as never,
    {} as never,
    { runTurn } as never,
    { enforceRateLimit: jest.fn().mockResolvedValue(undefined) } as never,
  );

  return { controller, runTurn };
};

/**
 * 调用被守卫保护的方法
 *
 * `RequestWithContext` 是 Express `Request` 的扩展（100+ 个成员），
 * 测试里只需要 `requestId` 一个字段 —— 因此**只对这一处**做断言转换。
 */
const send = (harness: Harness, content = '你好'): Promise<unknown> =>
  harness.controller.sendMessage('user-1', { conversationId: CONVERSATION_ID }, { content }, 'idem-key-12345678', {
    requestId: REQUEST_ID,
  } as Parameters<ChatController['sendMessage']>[4]);

describe('ChatController.sendMessage —— 响应包络契约（§3.7.5）', () => {
  it('【关键】必须标 @RawResponse()，否则全局拦截器会再包一层', () => {
    expect(Reflect.getMetadata(RAW_RESPONSE_KEY, ChatController.prototype['sendMessage'])).toBe(true);
  });

  it('路由元数据：POST /ai/conversations/:conversationId/messages，显式 201', () => {
    const handler = ChatController.prototype['sendMessage'];

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('conversations/:conversationId/messages');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.CREATED);
    // 控制器基础路径必须是 ai（与小程序 `/ai/conversations/...` 对齐）
    expect(Reflect.getMetadata(PATH_METADATA, ChatController)).toBe('ai');
  });

  it('【关键】正常路径返回**单层**信封：data.assistantMessage 可直接读到，且没有 data.data', async () => {
    const harness = createHarness(OK_RESULT);

    const response = (await send(harness)) as Record<string, unknown>;
    const data = outerDataOf(response);

    expect(response.code).toBe(0);
    expect(data.blocked).toBe(false);
    // 这两条是缺陷的正面证据：字段在 data 一级，而不是 data.data 二级
    expect((data.assistantMessage as { content: string }).content).toBe('真实回复内容');
    expect(data.data).toBeUndefined();
  });

  it('【关键·安全路径】危险内容拦截必须让**顶层** code = 50008（而非被降级成内层字段）', async () => {
    const harness = createHarness(BLOCKED_RESULT);

    const response = (await send(harness, '我觉得活着没意思')) as Record<string, unknown>;
    const data = outerDataOf(response);

    // 契约：HTTP 200 + 顶层 code=50008，前端据此按正常消息渲染关怀卡片、不弹错误 Toast
    expect(response.code).toBe(50008);
    expect(data.blocked).toBe(true);
    expect((data.resources as unknown[]).length).toBeGreaterThan(0);
    expect(data.data).toBeUndefined();
  });

  it('拦截路径**不消耗配额**（配额对象里的 consumed 必须是 0）', async () => {
    const harness = createHarness(BLOCKED_RESULT);

    const data = outerDataOf(await send(harness, '我觉得活着没意思'));

    expect((data.quota as { consumed: number }).consumed).toBe(0);
  });

  it('幂等键被透传给 runTurn（重放语义由服务层保证，控制器不得吞掉它）', async () => {
    const harness = createHarness(OK_RESULT);

    await send(harness);

    expect(harness.runTurn).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'idem-key-12345678' }));
  });
});
