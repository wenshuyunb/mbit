/**
 * LLM Provider 工厂
 *
 * 职责：按配置装配三家 Provider，并向上提供「取一个可用 Provider」的稳定入口。
 *
 * 为什么需要工厂而不是让调用方 new：
 *   · **降级**：首选 Provider 未配置或不可用时，应能回落到其他已配置的 Provider，
 *     而不是让整个 AI 功能不可用（架构 §15.2 降级策略）
 *   · **配置集中**：baseUrl / 模型名 / 超时 / 重试策略只在这里读一次，
 *     避免各处 `configService.get('ai.deepseek.apiKey')` 散落
 *   · **可测**：单测直接构造工厂即可换掉全部 Provider，不需要 mock 网络
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { AppConfig } from '../../../config/config.type';
import { OpenAiCompatibleProvider, type ProviderPolicy, type ProviderSettings } from './openai-compatible.provider';
import type { LlmProvider, LlmProviderKey, LlmProviderName } from './llm-provider.types';

/** Provider 名 → 配置键（下划线风格的环境变量命名） */
const PROVIDER_CONFIG_KEYS: Readonly<Record<LlmProviderName, LlmProviderKey>> = {
  DEEPSEEK: 'deepseek',
  OPENAI: 'openai',
  QWEN: 'qwen',
};

/** DeepSeek 实现（OpenAI 兼容协议） */
class DeepSeekProvider extends OpenAiCompatibleProvider {
  readonly name = 'DEEPSEEK' as const;
}

/** OpenAI 实现 */
class OpenAiProvider extends OpenAiCompatibleProvider {
  readonly name = 'OPENAI' as const;
}

/** 通义千问实现（DashScope 的 OpenAI 兼容模式） */
class QwenProvider extends OpenAiCompatibleProvider {
  readonly name = 'QWEN' as const;
}

@Injectable()
export class LlmProviderFactory {
  private readonly logger = new Logger(LlmProviderFactory.name);
  private readonly providers: Map<LlmProviderName, LlmProvider>;
  /** 配置里的首选 Provider（`AI_DEFAULT_PROVIDER`） */
  private readonly preferred: LlmProviderName;

  constructor(configService: ConfigService<AppConfig, true>) {
    const ai = configService.get('ai', { infer: true });

    const policy: ProviderPolicy = { timeoutMs: ai.timeoutMs, maxRetries: ai.maxRetries };

    const settingsOf = (key: LlmProviderKey): ProviderSettings => {
      const section = ai[key];
      return {
        apiKey: section.apiKey,
        baseUrl: section.baseUrl,
        defaultModel: section.defaultModel,
        // 仅 openai 配置带 enabled 开关
        ...(key === 'openai' ? { enabled: ai.openai.enabled } : {}),
      };
    };

    this.providers = new Map<LlmProviderName, LlmProvider>([
      ['DEEPSEEK', new DeepSeekProvider(settingsOf('deepseek'), policy, new Logger('Llm:DEEPSEEK'))],
      ['OPENAI', new OpenAiProvider(settingsOf('openai'), policy, new Logger('Llm:OPENAI'))],
      ['QWEN', new QwenProvider(settingsOf('qwen'), policy, new Logger('Llm:QWEN'))],
    ]);

    this.preferred = ai.defaultProvider.toUpperCase() as LlmProviderName;

    // 启动即打印可用 Provider：配置漏填时不必等到第一次调用才发现
    const configured = this.listConfigured();
    if (configured.length === 0) {
      this.logger.warn('没有任何已配置的 LLM Provider，AI 相关功能将不可用');
    } else {
      this.logger.log(`可用 LLM Provider: ${configured.join(', ')}（首选 ${this.preferred}）`);
    }
  }

  /** 按名取 Provider（未配置也返回实例，`isConfigured()` 会返回 false） */
  get(name: LlmProviderName): LlmProvider {
    const provider = this.providers.get(name);
    if (provider === undefined) {
      // 类型上不可达，但 provider 名单可能随枚举变化 —— 显式失败好过 undefined
      throw new BusinessException(ErrorCode.AI_PROVIDER_UNAVAILABLE);
    }
    return provider;
  }

  /** 已配置（且有 Key）的 Provider 列表 */
  listConfigured(): LlmProviderName[] {
    return [...this.providers.values()].filter((p) => p.isConfigured()).map((p) => p.name);
  }

  /** 配置键（供日志与后台展示，如 `deepseek`） */
  configKeyOf(name: LlmProviderName): LlmProviderKey {
    return PROVIDER_CONFIG_KEYS[name];
  }

  /**
   * 取一个**可用**的 Provider
   *
   * 选择顺序：显式指定 → 配置的首选 → 任意已配置。
   * 显式指定但不可用时**不静默回落**：调用方明确要求某家 Provider
   * （例如安全审核必须用境内模型），擅自换成另一家会造成合规问题。
   */
  resolveAvailable(preferred?: LlmProviderName): LlmProvider {
    if (preferred !== undefined) {
      const provider = this.get(preferred);
      if (!provider.isConfigured()) {
        throw new BusinessException(ErrorCode.AI_PROVIDER_AUTH_FAILED, '指定的 AI 服务未配置，请联系客服');
      }
      return provider;
    }

    const first = this.get(this.preferred);
    if (first.isConfigured()) return first;

    const fallback = this.listConfigured()[0];
    if (fallback !== undefined) {
      this.logger.warn(`首选 Provider ${this.preferred} 未配置，回落到 ${fallback}`);
      return this.get(fallback);
    }

    throw new BusinessException(ErrorCode.AI_PROVIDER_UNAVAILABLE);
  }
}
