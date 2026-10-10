/**
 * LLM 成本核算（纯函数，可 100% 单测）
 *
 * 架构依据：§13.3 成本控制、`ai_usage_logs` 表要求逐次计量。
 *
 * 为什么这件事必须做成纯函数：成本是**财务口径**，一旦算错，
 * 后台的成本看板、预算熔断（`AI_COST_BUDGET_EXCEEDED`）与定价决策全部失真。
 * 而它又只依赖「provider + model + token 数」三个输入，完全可确定性验证。
 *
 * ⚠ 价格表是**运营数据**，不是业务逻辑：厂商调价时必须更新本文件。
 *    未知模型的兜底策略见 `resolvePricing`。
 */

import type { LlmProviderName, LlmUsage } from './llm-provider.types';

/** 单价（单位：分 / 每 1K token） */
export interface ModelPricing {
  readonly centsPer1kInput: number;
  readonly centsPer1kOutput: number;
}

/**
 * 价格表（分 / 1K token）
 *
 * 数值来源于各家公开定价（人民币口径，OpenAI 按汇率折算），
 * 仅用于**内部成本观测**，不作为对外报价依据。
 */
const PRICING_TABLE: Readonly<Record<string, ModelPricing>> = {
  // DeepSeek：输入约 1 元/百万，输出约 2 元/百万
  'DEEPSEEK:deepseek-chat': { centsPer1kInput: 0.1, centsPer1kOutput: 0.2 },
  'DEEPSEEK:deepseek-reasoner': { centsPer1kInput: 0.4, centsPer1kOutput: 1.6 },
  // 通义千问 qwen-plus：输入约 0.8 元/百万，输出约 2 元/百万
  'QWEN:qwen-plus': { centsPer1kInput: 0.08, centsPer1kOutput: 0.2 },
  'QWEN:qwen-turbo': { centsPer1kInput: 0.03, centsPer1kOutput: 0.06 },
  'QWEN:qwen-max': { centsPer1kInput: 2.4, centsPer1kOutput: 9.6 },
  // OpenAI gpt-4o-mini：输入 $0.15/百万，输出 $0.60/百万（按 1:7.2 折算）
  'OPENAI:gpt-4o-mini': { centsPer1kInput: 0.108, centsPer1kOutput: 0.432 },
  'OPENAI:gpt-4o': { centsPer1kInput: 1.8, centsPer1kOutput: 7.2 },
};

/**
 * 未知模型的兜底单价
 *
 * 取价格表中的**最高档**（qwen-max），而不是平均值或最低档。
 * 理由：低估成本会让预算熔断失效（实际已超支但系统认为还有额度），
 * 而高估只会让成本看板偏保守 —— 两者代价不对称，因此选择偏高兜底。
 */
export const FALLBACK_PRICING: ModelPricing = { centsPer1kInput: 2.4, centsPer1kOutput: 9.6 };

/** 价格表键（provider + model） */
export const pricingKeyOf = (provider: LlmProviderName, model: string): string => `${provider}:${model}`;

/** 解析单价；未知模型走偏高兜底 */
export const resolvePricing = (provider: LlmProviderName, model: string): ModelPricing =>
  PRICING_TABLE[pricingKeyOf(provider, model)] ?? FALLBACK_PRICING;

/** 该模型是否已登记价格（供后台提示「成本按兜底价估算」） */
export const hasExplicitPricing = (provider: LlmProviderName, model: string): boolean =>
  PRICING_TABLE[pricingKeyOf(provider, model)] !== undefined;

/**
 * 计算单次调用成本（单位：分，整数）
 *
 * 用 `Math.ceil` 而非 `Math.round`：单次调用不足 1 分时也要记 1 分。
 * 理由同样是代价不对称 —— 四舍五入会让大量「半分级」调用在账面上归零，
 * 而成本看板的用途正是发现「调用量上去了」。向上取整最多高估 1 分/次。
 */
export const estimateCostCents = (provider: LlmProviderName, model: string, usage: LlmUsage): number => {
  const pricing = resolvePricing(provider, model);

  const inputCents = (usage.promptTokens / 1000) * pricing.centsPer1kInput;
  const outputCents = (usage.completionTokens / 1000) * pricing.centsPer1kOutput;

  return Math.ceil(inputCents + outputCents);
};

/** 估算单价的展示文案（后台成本页用） */
export const describePricing = (provider: LlmProviderName, model: string): string => {
  const pricing = resolvePricing(provider, model);
  const suffix = hasExplicitPricing(provider, model) ? '' : '（兜底价，建议补录）';

  return `输入 ${pricing.centsPer1kInput} 分/1K，输出 ${pricing.centsPer1kOutput} 分/1K${suffix}`;
};
