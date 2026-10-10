/**
 * LLM Provider 层测试（成本核算 + 协议实现 + 工厂）
 *
 * 本层是**所有 AI 功能的唯一出口**，因此测试重点是「归一化」是否彻底：
 * 上层不应该看到任何厂商差异，也不该看到原始异常。
 * 网络用 `global.fetch` 替身，不发起真实请求。
 */

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { AppConfig } from '../../../config/config.type';
import {
  describePricing,
  estimateCostCents,
  FALLBACK_PRICING,
  hasExplicitPricing,
  resolvePricing,
} from './llm-pricing';
import { LlmProviderFactory } from './llm-provider.factory';
import type { LlmProviderName } from './llm-provider.types';
import { OpenAiCompatibleProvider, type ProviderPolicy, type ProviderSettings } from './openai-compatible.provider';

// ============================================================================
// 成本核算
// ============================================================================

describe('llm-pricing', () => {
  it('按 provider + model 命中价格表', () => {
    // DeepSeek deepseek-chat：输入 0.1 分/1K，输出 0.2 分/1K
    expect(
      estimateCostCents('DEEPSEEK', 'deepseek-chat', { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 }),
    ).toBe(1);
    expect(hasExplicitPricing('DEEPSEEK', 'deepseek-chat')).toBe(true);
  });

  it('【关键】不足 1 分也记 1 分（向上取整，避免大量小额调用在账面上归零）', () => {
    expect(estimateCostCents('QWEN', 'qwen-turbo', { promptTokens: 1, completionTokens: 1, totalTokens: 2 })).toBe(1);
  });

  it('零 token 计 0 分（不产生虚假成本）', () => {
    expect(
      estimateCostCents('DEEPSEEK', 'deepseek-chat', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    ).toBe(0);
  });

  it('【关键】未知模型走偏高兜底（低估会让预算熔断失效）', () => {
    const pricing = resolvePricing('OPENAI', 'gpt-future-unknown');

    expect(hasExplicitPricing('OPENAI', 'gpt-future-unknown')).toBe(false);
    expect(pricing).toEqual(FALLBACK_PRICING);
    // 兜底价必须不低于任何已登记档位
    expect(FALLBACK_PRICING.centsPer1kOutput).toBeGreaterThanOrEqual(9.6);
  });

  it('同一模型在不同 Provider 下价格不同（键含 provider）', () => {
    expect(resolvePricing('QWEN', 'qwen-plus')).not.toEqual(resolvePricing('DEEPSEEK', 'qwen-plus'));
  });

  it('展示文案对未登记模型给出补录提示', () => {
    expect(describePricing('DEEPSEEK', 'deepseek-chat')).not.toContain('兜底价');
    expect(describePricing('DEEPSEEK', 'unknown-model')).toContain('兜底价');
  });
});

// ============================================================================
// Provider 协议实现
// ============================================================================

/** 暴露 protected 构造的测试子类 */
class TestProvider extends OpenAiCompatibleProvider {
  readonly name: LlmProviderName;

  constructor(
    name: LlmProviderName,
    settings: ProviderSettings,
    policy: ProviderPolicy = { timeoutMs: 1000, maxRetries: 0 },
  ) {
    super(settings, policy, new Logger('TestLlm'));
    this.name = name;
  }
}

const SETTINGS: ProviderSettings = {
  apiKey: 'sk-test-key',
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-chat',
};

/** 构造一个成功的 OpenAI 兼容响应 */
const okResponse = (
  content: string,
  extra: Record<string, unknown> = {},
): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} => ({
  ok: true,
  status: 200,
  json: async () => ({
    id: 'chatcmpl-1',
    model: 'deepseek-chat',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    ...extra,
  }),
  text: async () => '',
});

const errorResponse = (
  status: number,
  body = 'error',
): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} => ({ ok: false, status, json: async () => ({}), text: async () => body });

describe('OpenAiCompatibleProvider', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  const request = { messages: [{ role: 'user' as const, content: '你好' }] };

  it('成功调用：返回内容、计量与耗时', async () => {
    fetchMock.mockResolvedValue(okResponse('你好，我是 SoulMap'));

    const result = await new TestProvider('DEEPSEEK', SETTINGS).complete(request);

    expect(result.content).toBe('你好，我是 SoulMap');
    expect(result.provider).toBe('DEEPSEEK');
    expect(result.model).toBe('deepseek-chat');
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    expect(result.finishReason).toBe('stop');
    expect(result.providerRequestId).toBe('chatcmpl-1');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('请求地址正确拼接（baseUrl 末尾有斜杠也不产生双斜杠）', async () => {
    fetchMock.mockResolvedValue(okResponse('x'));

    await new TestProvider('DEEPSEEK', { ...SETTINGS, baseUrl: 'https://api.deepseek.com///' }).complete(request);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
  });

  it('携带 Bearer 鉴权头且请求体含模型与消息', async () => {
    fetchMock.mockResolvedValue(okResponse('x'));

    await new TestProvider('DEEPSEEK', SETTINGS).complete(request);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(init.headers['Authorization']).toBe('Bearer sk-test-key');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body['model']).toBe('deepseek-chat');
    expect(body['messages']).toEqual(request.messages);
    expect(body['stream']).toBe(false);
    // 必须显式设置输出上限（否则成本不可预测）
    expect(body['max_tokens']).toBeGreaterThan(0);
  });

  it('显式参数覆盖默认值', async () => {
    fetchMock.mockResolvedValue(okResponse('x'));

    await new TestProvider('DEEPSEEK', SETTINGS).complete({
      ...request,
      model: 'deepseek-reasoner',
      temperature: 0.1,
      maxTokens: 512,
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(body['model']).toBe('deepseek-reasoner');
    expect(body['temperature']).toBe(0.1);
    expect(body['max_tokens']).toBe(512);
  });

  it('【关键】未配置 API Key 时立即失败且不发起请求', async () => {
    const provider = new TestProvider('DEEPSEEK', { ...SETTINGS, apiKey: '' });

    expect(provider.isConfigured()).toBe(false);
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: ErrorCode.AI_PROVIDER_AUTH_FAILED,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enabled 为 false 时即便有 Key 也视为未配置（合规关停开关）', async () => {
    const provider = new TestProvider('OPENAI', { ...SETTINGS, enabled: false });

    expect(provider.isConfigured()).toBe(false);
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: ErrorCode.AI_PROVIDER_AUTH_FAILED,
    });
  });

  describe('错误映射', () => {
    it('401 → 鉴权失败，且不重试', async () => {
      fetchMock.mockResolvedValue(errorResponse(401));
      const provider = new TestProvider('DEEPSEEK', SETTINGS, { timeoutMs: 1000, maxRetries: 2 });

      await expect(provider.complete(request)).rejects.toMatchObject({
        code: ErrorCode.AI_PROVIDER_AUTH_FAILED,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('400 → 请求被拒（50021），且不重试（重试只是浪费配额）', async () => {
      fetchMock.mockResolvedValue(errorResponse(400, 'invalid model'));
      const provider = new TestProvider('DEEPSEEK', SETTINGS, { timeoutMs: 1000, maxRetries: 2 });

      await expect(provider.complete(request)).rejects.toMatchObject({
        code: ErrorCode.AI_REQUEST_REJECTED,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('【关键】429 → 限流，可重试并耗尽次数', async () => {
      fetchMock.mockResolvedValue(errorResponse(429));
      const provider = new TestProvider('DEEPSEEK', SETTINGS, { timeoutMs: 1000, maxRetries: 1 });

      await expect(provider.complete(request)).rejects.toMatchObject({
        code: ErrorCode.AI_PROVIDER_RATE_LIMITED,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('【关键】5xx → 服务不可用，可重试', async () => {
      fetchMock.mockResolvedValue(errorResponse(503));
      const provider = new TestProvider('DEEPSEEK', SETTINGS, { timeoutMs: 1000, maxRetries: 1 });

      await expect(provider.complete(request)).rejects.toMatchObject({
        code: ErrorCode.AI_PROVIDER_UNAVAILABLE,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('【关键】首次限流后重试成功时对上层透明（瞬时抖动被吸收）', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(429)).mockResolvedValueOnce(okResponse('重试成功'));
      const provider = new TestProvider('DEEPSEEK', SETTINGS, { timeoutMs: 1000, maxRetries: 1 });

      await expect(provider.complete(request)).resolves.toMatchObject({ content: '重试成功' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('网络异常 → 服务不可用（不泄露底层异常）', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      await expect(new TestProvider('DEEPSEEK', SETTINGS).complete(request)).rejects.toMatchObject({
        code: ErrorCode.AI_PROVIDER_UNAVAILABLE,
      });
    });

    it('【关键】超时 → 归一为 50001，且异常名不是 AbortError', async () => {
      fetchMock.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      );
      const provider = new TestProvider('DEEPSEEK', SETTINGS, { timeoutMs: 20, maxRetries: 0 });

      await expect(provider.complete(request)).rejects.toMatchObject({
        code: ErrorCode.AI_PROVIDER_TIMEOUT,
      });
    });
  });

  describe('响应归一', () => {
    it('【关键】缺少 total_tokens 时自行相加（避免成本核算出现 NaN）', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 30, completion_tokens: 20 },
        }),
        text: async () => '',
      });

      const result = await new TestProvider('DEEPSEEK', SETTINGS).complete(request);

      expect(result.usage.totalTokens).toBe(50);
    });

    it('usage 缺失或含非法值时归零而非 NaN', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: -5, completion_tokens: 'abc' },
        }),
        text: async () => '',
      });

      const result = await new TestProvider('DEEPSEEK', SETTINGS).complete(request);

      expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it('空内容 → 50004（可重试）', async () => {
      fetchMock.mockResolvedValue(okResponse('   '));
      const provider = new TestProvider('DEEPSEEK', SETTINGS, { timeoutMs: 1000, maxRetries: 1 });

      await expect(provider.complete(request)).rejects.toMatchObject({
        code: ErrorCode.AI_OUTPUT_INVALID,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('choices 缺失时按空内容处理', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
      });

      await expect(new TestProvider('DEEPSEEK', SETTINGS).complete(request)).rejects.toMatchObject({
        code: ErrorCode.AI_OUTPUT_INVALID,
      });
    });
  });

  describe('JSON 模式', () => {
    it('返回合法 JSON 对象时解析到 json 字段', async () => {
      fetchMock.mockResolvedValue(okResponse('{"score":80,"tags":["严谨"]}'));

      const result = await new TestProvider('DEEPSEEK', SETTINGS).complete({
        ...request,
        responseFormat: 'json',
      });

      expect(result.json).toEqual({ score: 80, tags: ['严谨'] });
    });

    it('请求体带 response_format', async () => {
      fetchMock.mockResolvedValue(okResponse('{}'));

      await new TestProvider('DEEPSEEK', SETTINGS).complete({ ...request, responseFormat: 'json' });

      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
      expect(body['response_format']).toEqual({ type: 'json_object' });
    });

    it('文本模式不带 response_format（避免厂商不支持的参数导致 400）', async () => {
      fetchMock.mockResolvedValue(okResponse('普通文本'));

      const result = await new TestProvider('DEEPSEEK', SETTINGS).complete(request);

      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
      expect(body['response_format']).toBeUndefined();
      expect(result.json).toBeNull();
    });

    it('【关键】兼容被 ```json 包裹的输出（部分兼容实现忽略 response_format）', async () => {
      fetchMock.mockResolvedValue(okResponse('```json\n{"ok":true}\n```'));

      const result = await new TestProvider('DEEPSEEK', SETTINGS).complete({
        ...request,
        responseFormat: 'json',
      });

      expect(result.json).toEqual({ ok: true });
    });

    it('【关键】输出不是合法 JSON 时归一为 50004（不让 JSON.parse 异常冒到上层）', async () => {
      fetchMock.mockResolvedValue(okResponse('这不是 JSON'));

      await expect(
        new TestProvider('DEEPSEEK', SETTINGS).complete({ ...request, responseFormat: 'json' }),
      ).rejects.toMatchObject({ code: ErrorCode.AI_OUTPUT_INVALID });
    });

    it('输出是数组时同样拒绝（要求的是对象）', async () => {
      fetchMock.mockResolvedValue(okResponse('[1,2,3]'));

      await expect(
        new TestProvider('DEEPSEEK', SETTINGS).complete({ ...request, responseFormat: 'json' }),
      ).rejects.toMatchObject({ code: ErrorCode.AI_OUTPUT_INVALID });
    });

    it('输出为 null 字面量时拒绝', async () => {
      fetchMock.mockResolvedValue(okResponse('null'));

      await expect(
        new TestProvider('DEEPSEEK', SETTINGS).complete({ ...request, responseFormat: 'json' }),
      ).rejects.toMatchObject({ code: ErrorCode.AI_OUTPUT_INVALID });
    });
  });

  it('抛出的始终是 BusinessException（上层只按错误码分支）', async () => {
    fetchMock.mockResolvedValue(errorResponse(500));

    try {
      await new TestProvider('DEEPSEEK', SETTINGS).complete(request);
      throw new Error('期望抛出错误');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessException);
    }
  });
});

// ============================================================================
// 工厂
// ============================================================================

const aiConfig = (
  overrides: {
    defaultProvider?: 'deepseek' | 'openai' | 'qwen';
    deepseekKey?: string;
    openaiKey?: string;
    openaiEnabled?: boolean;
    qwenKey?: string;
  } = {},
): AppConfig['ai'] => ({
  defaultProvider: overrides.defaultProvider ?? 'deepseek',
  maxRetries: 1,
  timeoutMs: 30_000,
  streamFirstTokenTimeoutMs: 10_000,
  streamTotalTimeoutMs: 120_000,
  dailyCostBudgetCents: 10_000,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 60_000,
  deepseek: {
    apiKey: overrides.deepseekKey ?? '',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
  },
  openai: {
    enabled: overrides.openaiEnabled ?? false,
    apiKey: overrides.openaiKey ?? '',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  qwen: {
    apiKey: overrides.qwenKey ?? '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
});

const factoryWith = (config: AppConfig['ai']): LlmProviderFactory =>
  new LlmProviderFactory({
    get: (path: string): unknown => (path === 'ai' ? config : undefined),
  } as unknown as ConfigService<AppConfig, true>);

describe('LlmProviderFactory', () => {
  it('只把「有 Key 且已启用」的 Provider 列为可用', () => {
    const factory = factoryWith(aiConfig({ deepseekKey: 'k', openaiKey: 'k2', openaiEnabled: false }));

    expect(factory.listConfigured()).toEqual(['DEEPSEEK']);
  });

  it('OPENAI_ENABLED=true 且配了 Key 时才纳入（ADR-013 合规关停）', () => {
    expect(factoryWith(aiConfig({ openaiKey: 'k2', openaiEnabled: true })).listConfigured()).toContain('OPENAI');
  });

  it('默认 Provider 可用时直接返回它', () => {
    const factory = factoryWith(aiConfig({ deepseekKey: 'k' }));

    expect(factory.resolveAvailable().name).toBe('DEEPSEEK');
  });

  it('【关键】默认 Provider 未配置时回落到其他已配置 Provider（降级而非全不可用）', () => {
    const factory = factoryWith(aiConfig({ defaultProvider: 'deepseek', qwenKey: 'qk' }));

    expect(factory.resolveAvailable().name).toBe('QWEN');
  });

  it('【关键】显式指定但未配置时**不静默回落**（合规要求某家时必须失败）', () => {
    const factory = factoryWith(aiConfig({ qwenKey: 'qk' }));

    expect(() => factory.resolveAvailable('DEEPSEEK')).toThrow(BusinessException);
    try {
      factory.resolveAvailable('DEEPSEEK');
    } catch (error) {
      expect((error as BusinessException).code).toBe(ErrorCode.AI_PROVIDER_AUTH_FAILED);
    }
  });

  it('全部未配置时抛 50000（上层可据此提示服务不可用）', () => {
    expect(() => factoryWith(aiConfig()).resolveAvailable()).toThrow(BusinessException);
  });

  it('配置键映射与 Prisma 枚举一致', () => {
    const factory = factoryWith(aiConfig());

    expect(factory.configKeyOf('DEEPSEEK')).toBe('deepseek');
    expect(factory.configKeyOf('OPENAI')).toBe('openai');
    expect(factory.configKeyOf('QWEN')).toBe('qwen');
  });

  it('get 返回的实例默认模型来自配置', () => {
    const factory = factoryWith(aiConfig({ qwenKey: 'qk' }));

    expect(factory.get('QWEN').defaultModel).toBe('qwen-plus');
  });
});
