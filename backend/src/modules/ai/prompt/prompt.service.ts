/**
 * Prompt 服务（契约 §3.5；ADR-014：Prompt 存数据库 + 版本化）
 *
 * 职责：按 key 取模板 → 选定生效版本 → 渲染 → 返回可直接交给 LLM 的参数。
 *
 * 缓存策略（这是本模块最容易做错的地方）：
 *   · **按 `versionId` 缓存版本内容**，而不是按 key 缓存「当前生效版本」。
 *     版本行一经发布即视为不可变，因此以 versionId 为键的缓存**永不需要失效** ——
 *     发布新版本会自然产生新的缓存键，旧键随 TTL 过期即可。
 *   · 「哪个版本生效」的指针查询**不缓存**：它是一次带索引的单行查询，
 *     缓存它反而引入「后台改了 prompt 但线上仍用旧版」的困惑，而热更正是 ADR-014 的核心诉求。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import type { LlmProviderName } from '../provider/llm-provider.types';
import { renderPromptVersion } from './prompt-renderer';
import { selectWeightedVersion, sortVersionsNewestFirst } from './prompt-version-selector';

/** 版本内容缓存时长（秒） */
const VERSION_CACHE_TTL_SECONDS = 3600;

/** 版本内容缓存键前缀 */
const VERSION_CACHE_PREFIX = 'prompt:version';

/** 缓存中的版本内容（不含易变的指针信息） */
interface CachedPromptVersion {
  versionId: string;
  version: number;
  systemPrompt: string;
  userPromptTemplate: string;
  provider: LlmProviderName | null;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  /** 结构化输出声明（段落键/免费预览标记由此读取，供 ADR-004 分段落库） */
  outputSchema: unknown;
}

/** 解析结果：可直接交给 LLM Provider 调用 */
export interface ResolvedPrompt {
  readonly templateKey: string;
  readonly versionId: string;
  readonly version: number;
  readonly system: string;
  readonly user: string;
  /** 本次实际使用的变量（用于排查与用量统计） */
  readonly usedVariables: readonly string[];
  readonly provider: LlmProviderName | null;
  readonly model: string | null;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  /** 结构化输出声明（`PromptVersion.outputSchema` 原样透传，形状由调用方解释） */
  readonly outputSchema: unknown;
}

/** `getPrompt` 选项 */
export interface GetPromptOptions {
  /** 注入随机源（AB 分流）；不传用 `Math.random` */
  readonly random?: () => number;
}

@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 取模板并渲染
   *
   * 失败语义（上层可按码分支）：
   *   · 模板不存在 / 已停用 / 无可用版本 → `50011`
   *   · 缺必需变量 → `50012`
   */
  async getPrompt(
    key: string,
    variables: Readonly<Record<string, string>>,
    options: GetPromptOptions = {},
  ): Promise<ResolvedPrompt> {
    const template = await this.loadTemplate(key);
    const version = await this.resolveVersion(template, options);
    const rendered = renderPromptVersion(
      { systemPrompt: version.systemPrompt, userPromptTemplate: version.userPromptTemplate },
      variables,
    );

    return {
      templateKey: template.key,
      versionId: version.versionId,
      version: version.version,
      system: rendered.system,
      user: rendered.user,
      usedVariables: rendered.usedVariables,
      provider: version.provider,
      model: version.model,
      temperature: version.temperature,
      maxTokens: version.maxTokens,
      outputSchema: version.outputSchema,
    };
  }

  /**
   * 只解析生效版本与调用参数，**不渲染**
   *
   * 用途：报告创建时需要知道「用哪个模板版本 + 哪个模型」来算 `cacheKey`，
   * 但那时还没有组装 Prompt 变量。若为取元信息而传空变量去渲染，会因缺变量失败 ——
   * 这是"用错了接口"，不是"数据有问题"，因此单独提供一个语义明确的入口。
   */
  async getTemplateMeta(
    key: string,
    options: GetPromptOptions = {},
  ): Promise<Omit<ResolvedPrompt, 'system' | 'user' | 'usedVariables'>> {
    const template = await this.loadTemplate(key);
    const version = await this.resolveVersion(template, options);

    return {
      templateKey: template.key,
      versionId: version.versionId,
      version: version.version,
      provider: version.provider,
      model: version.model,
      temperature: version.temperature,
      maxTokens: version.maxTokens,
      outputSchema: version.outputSchema,
    };
  }

  /** 清除某版本的缓存（后台发布/回滚后调用，保证线上立即生效） */
  async invalidateVersion(versionId: string): Promise<void> {
    await this.redis.del(this.redis.key(VERSION_CACHE_PREFIX, versionId));
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 按 key 定位启用中的模板（不存在即 50011） */
  private async loadTemplate(key: string): Promise<{ id: string; key: string; activeVersionId: string | null }> {
    const template = await this.prisma.promptTemplate.findFirst({
      where: { key, isActive: true, deletedAt: null },
      select: { id: true, key: true, activeVersionId: true },
    });

    if (template === null) {
      this.logger.error(`Prompt 模板不存在或已停用 key=${key}`);
      throw new BusinessException(ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND);
    }

    return template;
  }

  /**
   * 选定生效版本
   *
   * 优先级：模板显式指定的 `activeVersionId` → 多个 `ACTIVE` 版本按权重分流。
   * 显式指定优先是刻意的：它给了运营一个「钉住某个版本」的手段，
   * 用于灰度回滚（把 activeVersionId 指回上一版即可，无需改权重）。
   */
  private async resolveVersion(
    template: {
      id: string;
      key: string;
      activeVersionId: string | null;
    },
    options: GetPromptOptions,
  ): Promise<CachedPromptVersion> {
    if (template.activeVersionId !== null) {
      const pinned = await this.loadVersionById(template.activeVersionId);

      if (pinned !== null) return pinned;

      // 指针指向了一个查不到的版本（数据被手工改动）：
      // 不直接失败，而是回落到按状态选择 —— 线上报告生成不应因一条脏指针整体不可用
      this.logger.warn(`模板 ${template.key} 的 activeVersionId 指向不存在的版本，回落到按状态选择`);
    }

    const candidates = await this.prisma.promptVersion.findMany({
      where: { templateId: template.id, status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, trafficWeight: true },
    });

    const selected = selectWeightedVersion(sortVersionsNewestFirst(candidates), this.randomOf(options));

    if (selected === null) {
      this.logger.error(`Prompt 模板 ${template.key} 没有可用的 ACTIVE 版本`);
      throw new BusinessException(ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND);
    }

    const version = await this.loadVersionById(selected.id);

    if (version === null) {
      throw new BusinessException(ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND);
    }

    return version;
  }

  /** 按 id 加载版本内容（命中缓存则不查库） */
  private async loadVersionById(versionId: string): Promise<CachedPromptVersion | null> {
    const cacheKey = this.redis.key(VERSION_CACHE_PREFIX, versionId);
    const cached = await this.redis.getJson<CachedPromptVersion>(cacheKey);

    // 只认结构完整的缓存：早期版本或人工写入的脏值会让下游拿到 undefined，
    // 那时错误会出现在渲染层，离根因很远
    if (cached !== null && typeof cached.systemPrompt === 'string' && typeof cached.userPromptTemplate === 'string') {
      return cached;
    }

    const row = await this.prisma.promptVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        version: true,
        systemPrompt: true,
        userPromptTemplate: true,
        provider: true,
        model: true,
        temperature: true,
        maxTokens: true,
        outputSchema: true,
      },
    });

    if (row === null) return null;

    const content: CachedPromptVersion = {
      versionId: row.id,
      version: row.version,
      systemPrompt: row.systemPrompt,
      userPromptTemplate: row.userPromptTemplate,
      // Prisma 的 AiProvider 枚举与内部 LlmProviderName 取值一致，直接透传即可
      provider: row.provider,
      model: row.model,
      temperature: row.temperature,
      maxTokens: row.maxTokens,
      outputSchema: row.outputSchema,
    };

    await this.redis.setJson(cacheKey, content, VERSION_CACHE_TTL_SECONDS);

    return content;
  }

  /** 随机源（可注入以便测试确定性分流） */
  private randomOf(options: GetPromptOptions): () => number {
    return options.random ?? Math.random;
  }
}
