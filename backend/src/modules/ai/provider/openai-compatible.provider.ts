/**
 * OpenAI 兼容 Provider 基类
 *
 * 关键观察：DeepSeek、通义千问（compatible-mode）、OpenAI **都实现 OpenAI 的
 * `/chat/completions` 协议**，请求体与响应体形状一致。因此三家的差异只有
 * 4 个：baseUrl、apiKey、默认模型、以及个别厂商是否支持 `response_format`。
 *
 * 与其写三份几乎相同的 HTTP 代码（然后在新需求下各自漂移），
 * 不如抽一个基类承载全部协议细节与错误映射，子类只提供配置。
 *
 * 统一到接口边界的承诺（上层不必关心厂商差异）：
 *   · 错误一律转成 `BusinessException` + 统一的 AI 错误码
 *   · token 计量字段名归一（各家 `usage` 字段名有差异）
 *   · JSON 模式的解析失败归一为 `AI_OUTPUT_INVALID`
 *   · 可重试错误自动退避重试，重试耗尽才抛出
 */

import type { Logger } from '@nestjs/common';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
  LlmProviderName,
  LlmUsage,
} from './llm-provider.types';

/** Provider 配置（来自环境变量，见 config.type.ts 的 `ai.*`） */
export interface ProviderSettings {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /**
   * 显式启用开关（默认启用）
   *
   * 用于 `OPENAI_ENABLED=false` 这类场景：合规要求优先境内 LLM（ADR-013），
   * 因此需要一个「即便配了 Key 也不启用」的开关，而不是靠不填 Key 来表达。
   */
  readonly enabled?: boolean;
}

/** 调用策略（重试与超时） */
export interface ProviderPolicy {
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/** 基类可重试的错误分类 */
type RetryableReason = 'timeout' | 'rate_limited' | 'unavailable' | 'output_invalid';

/** 重试退避基数（毫秒） */
const RETRY_BASE_DELAY_MS = 300;

/** 退避上限（毫秒）——避免长退避把一次报告生成拖到分钟级 */
const RETRY_MAX_DELAY_MS = 3000;

/** 默认最大输出 token（未显式指定时使用） */
const DEFAULT_MAX_TOKENS = 2048;

/** 默认温度（报告解读类任务需要稳定输出，取偏低值） */
const DEFAULT_TEMPERATURE = 0.6;

/** OpenAI 兼容的响应体（只声明用到的字段，其余忽略） */
interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

export abstract class OpenAiCompatibleProvider implements LlmProvider {
  abstract readonly name: LlmProviderName;

  constructor(
    protected readonly settings: ProviderSettings,
    private readonly policy: ProviderPolicy,
    private readonly logger: Logger,
  ) {}

  get defaultModel(): string {
    return this.settings.defaultModel;
  }

  isConfigured(): boolean {
    return this.settings.enabled !== false && this.settings.apiKey.length > 0;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    if (!this.isConfigured()) {
      // 配置缺失属部署问题，重试无益 —— 直接失败并提示联系客服
      throw new BusinessException(ErrorCode.AI_PROVIDER_AUTH_FAILED, 'AI 服务未配置，请联系客服');
    }

    const model = request.model ?? this.settings.defaultModel;
    const timeoutMs = request.timeoutMs ?? this.policy.timeoutMs;
    const maxAttempts = Math.max(1, this.policy.maxRetries + 1);

    let lastError: BusinessException | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();

      try {
        const response = await this.callOnce(request, model, timeoutMs, startedAt);
        return response;
      } catch (error) {
        const classification = this.classify(error);

        if (classification === null) {
          // 不可重试（鉴权失败、参数错误等）：立即抛出，避免无谓消耗配额
          throw error;
        }

        lastError = error as BusinessException;

        if (attempt >= maxAttempts) break;

        const delay = this.backoffDelay(attempt);
        this.logger.warn(
          `AI 调用失败将重试 provider=${this.name} model=${model} attempt=${attempt}/${maxAttempts} reason=${classification} delay=${delay}ms`,
        );
        await this.sleep(delay);
      }
    }

    this.logger.error(`AI 调用重试耗尽 provider=${this.name} model=${model} attempts=${maxAttempts}`);

    throw lastError ?? new BusinessException(ErrorCode.AI_PROVIDER_UNAVAILABLE);
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 单次调用 */
  private async callOnce(
    request: LlmCompletionRequest,
    model: string,
    timeoutMs: number,
    startedAt: number,
  ): Promise<LlmCompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.chatCompletionsUrl(), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(request, model)),
      });

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        throw this.httpError(response.status, await this.readErrorDetail(response));
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      return this.parseResponse(payload, model, latencyMs, request.responseFormat === 'json');
    } catch (error) {
      if (error instanceof BusinessException) throw error;

      const reason = (error as Error).name;
      if (reason === 'AbortError') {
        throw new BusinessException(ErrorCode.AI_PROVIDER_TIMEOUT);
      }

      // 网络层失败（DNS / 连接重置）：按「服务不可用」处理，可重试
      this.logger.warn(`AI 网络请求异常 provider=${this.name}: ${(error as Error).message}`);
      throw new BusinessException(ErrorCode.AI_PROVIDER_UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 拼接对话补全地址
   *
   * 三家配置的 baseUrl 形态不同（`https://api.deepseek.com`、
   * `https://api.openai.com/v1`、`https://dashscope.aliyuncs.com/compatible-mode/v1`），
   * 但都指向「在此之后拼 `/chat/completions`」——因此只需去掉尾部斜杠。
   */
  private chatCompletionsUrl(): string {
    return `${this.settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  /** 组装请求体（只放必要字段，避免厂商不支持的参数导致 400） */
  private buildRequestBody(request: LlmCompletionRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? DEFAULT_TEMPERATURE,
      // 用 `max_tokens` 而非 `max_completion_tokens`：前者被三家共同支持
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: false,
    };

    if (request.responseFormat === 'json') {
      // 调用方仍需在 prompt 里明确要求 JSON —— 该参数只保证「输出是合法 JSON 对象」，
      // 不保证字段符合预期（字段校验在结构化抽取层做）
      body['response_format'] = { type: 'json_object' };
    }

    return body;
  }

  /** 解析响应体，归一为内部结果 */
  private parseResponse(
    payload: ChatCompletionResponse,
    model: string,
    latencyMs: number,
    wantsJson: boolean,
  ): LlmCompletionResult {
    const content = payload.choices?.[0]?.message?.content ?? '';

    if (typeof content !== 'string' || content.trim().length === 0) {
      this.logger.error(`AI 返回空内容 provider=${this.name} model=${model}`);
      throw new BusinessException(ErrorCode.AI_OUTPUT_INVALID);
    }

    const usage = this.parseUsage(payload);

    return {
      provider: this.name,
      model: payload.model ?? model,
      content,
      json: wantsJson ? this.parseJsonContent(content) : null,
      usage,
      latencyMs,
      finishReason: payload.choices?.[0]?.finish_reason ?? null,
      providerRequestId: payload.id ?? null,
    };
  }

  /**
   * 解析 JSON 模式的输出
   *
   * 即使请求了 `response_format: json_object`，仍要做三层容错：
   *   ① 部分兼容实现直接忽略该参数，模型会包上 ```json 代码块
   *   ② 输出可能是数组或标量（要求「对象」但模型给了数组）
   *   ③ 截断的输出（`finish_reason: length`）必然不是合法 JSON
   * 三者都归一为 `AI_OUTPUT_INVALID`（可重试），而不是让 JSON.parse 的
   * 原始异常冒到上层。
   */
  private parseJsonContent(content: string): Record<string, unknown> {
    const stripped = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      this.logger.warn(`AI JSON 模式输出无法解析 provider=${this.name} length=${content.length}`);
      throw new BusinessException(ErrorCode.AI_OUTPUT_INVALID);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.logger.warn(`AI JSON 模式输出不是对象 provider=${this.name}`);
      throw new BusinessException(ErrorCode.AI_OUTPUT_INVALID);
    }

    return parsed as Record<string, unknown>;
  }

  /**
   * 归一 token 计量
   *
   * 部分兼容实现不返回 `total_tokens`，或字段缺失 —— 一律自己算，
   * 避免成本核算里出现 `NaN`（NaN 会让预算比较静默失效）。
   */
  private parseUsage(payload: ChatCompletionResponse): LlmUsage {
    const promptTokens = this.toNonNegativeInt(payload.usage?.prompt_tokens);
    const completionTokens = this.toNonNegativeInt(payload.usage?.completion_tokens);
    const totalTokens = this.toNonNegativeInt(payload.usage?.total_tokens);

    return {
      promptTokens,
      completionTokens,
      totalTokens: totalTokens > 0 ? totalTokens : promptTokens + completionTokens,
    };
  }

  private toNonNegativeInt(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /** HTTP 状态 → 统一错误码 */
  private httpError(status: number, detail: string): BusinessException {
    if (status === 401 || status === 403) {
      this.logger.error(`AI 鉴权失败 provider=${this.name} status=${status}`);
      return new BusinessException(ErrorCode.AI_PROVIDER_AUTH_FAILED);
    }

    if (status === 429) {
      return new BusinessException(ErrorCode.AI_PROVIDER_RATE_LIMITED);
    }

    if (status === 400 || status === 422) {
      // **我们的请求**被拒（如模型名不存在、max_tokens 超限）：重试不会变好。
      // 与「模型答错了」（AI_OUTPUT_INVALID，可重试）严格区分 ——
      // 二者都用可重试码会让每个配置错误白耗 N 次配额与 1s+ 延迟。
      this.logger.error(`AI 请求被拒绝 provider=${this.name} status=${status} detail=${detail.slice(0, 200)}`);
      return new BusinessException(ErrorCode.AI_REQUEST_REJECTED);
    }

    if (status >= 500) {
      return new BusinessException(ErrorCode.AI_PROVIDER_UNAVAILABLE);
    }

    this.logger.error(`AI 返回未预期状态 provider=${this.name} status=${status} detail=${detail.slice(0, 200)}`);
    return new BusinessException(ErrorCode.AI_PROVIDER_UNAVAILABLE);
  }

  /** 读取错误详情（只取前 500 字符，避免把整段 HTML 错误页写进日志） */
  private async readErrorDetail(response: Response): Promise<string> {
    try {
      return (await response.text()).slice(0, 500);
    } catch {
      return '';
    }
  }

  /**
   * 错误分类：返回 `null` 表示**不可重试**
   *
   * 只有限流、超时、服务端故障、输出格式异常值得重试；
   * 鉴权失败与参数错误重试只是浪费配额与时间。
   */
  private classify(error: unknown): RetryableReason | null {
    if (!(error instanceof BusinessException)) return null;

    switch (error.code) {
      case ErrorCode.AI_PROVIDER_TIMEOUT:
        return 'timeout';
      case ErrorCode.AI_PROVIDER_RATE_LIMITED:
        return 'rate_limited';
      case ErrorCode.AI_PROVIDER_UNAVAILABLE:
        return 'unavailable';
      case ErrorCode.AI_OUTPUT_INVALID:
        return 'output_invalid';
      default:
        return null;
    }
  }

  /** 指数退避 + 抖动（抖动避免多实例同时重试造成二次冲击） */
  private backoffDelay(attempt: number): number {
    const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    return exponential + Math.floor(Math.random() * 100);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
