/**
 * LLM Provider 抽象 — 类型定义
 *
 * 架构依据：§13.2（多 Provider 抽象）、ADR-013（优先境内 LLM）。
 *
 * 设计要点：**不在接口里暴露任何厂商特有概念**。
 * 上层（报告生成 / AI 助手 / 结构化抽取）只依赖 `LlmProvider.complete()`，
 * 因此新增一家厂商只需要加一个 subclass，而不必改动任何业务代码。
 */

/** 支持的 Provider（与 Prisma `AiProvider` 枚举一致） */
export const LLM_PROVIDERS = ['DEEPSEEK', 'OPENAI', 'QWEN'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/** 配置中的小写标识（环境变量用 `deepseek` / `openai` / `qwen`） */
export type LlmProviderKey = 'deepseek' | 'openai' | 'qwen';

/** 对话消息 */
export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** 调用请求 */
export interface LlmCompletionRequest {
  readonly messages: readonly LlmMessage[];
  /** 覆盖默认模型（不传则用配置的 `defaultModel`） */
  readonly model?: string;
  readonly temperature?: number;
  /**
   * 最大输出 token
   *
   * 必须显式设置：不设上限时模型可能生成超长内容，
   * 既拖慢响应也让成本不可预测（架构 §13.3 成本控制）。
   */
  readonly maxTokens?: number;
  /**
   * 期望的输出形态
   *
   * `json` 会让 Provider 要求模型返回 JSON 对象，并在解析失败时归一为
   * `AI_OUTPUT_INVALID` —— 上层不必各自处理「模型没按格式回答」。
   */
  readonly responseFormat?: 'text' | 'json';
  /** 请求级超时（毫秒），不传用配置默认值 */
  readonly timeoutMs?: number;
}

/** token 计量 */
export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** 调用结果 */
export interface LlmCompletionResult {
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly content: string;
  /** `responseFormat: 'json'` 时已解析为对象；否则为 null */
  readonly json: Record<string, unknown> | null;
  readonly usage: LlmUsage;
  readonly latencyMs: number;
  readonly finishReason: string | null;
  /** 厂商侧的请求 id（排障时用于向厂商追查） */
  readonly providerRequestId: string | null;
}

/**
 * LLM Provider 接口
 *
 * `complete()` 的契约：**要么返回规范化结果，要么抛 `BusinessException`**，
 * 绝不向上泄露厂商的原始响应或异常 —— 上层只需按错误码分支。
 */
export interface LlmProvider {
  readonly name: LlmProviderName;
  /** 配置是否完整（缺 API Key 时为 false，调用前应先判断） */
  isConfigured(): boolean;
  /** 当前默认模型 */
  readonly defaultModel: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}
