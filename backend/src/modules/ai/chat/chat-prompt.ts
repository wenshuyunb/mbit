/**
 * 对话 Prompt 装配（契约 §3.7.1 业务规则 3/4，架构 §10.4）
 *
 * ## 本文件解决的核心矛盾：契约键名 ≠ 库内键名
 *
 * 契约 §3.7.1 规则 4 给出的映射是**语义键**（`COMPANION → AI_COMPANION`、
 * `ANALYSIS → RELATIONSHIP_REPORT`），而 `prompt_templates.key` 在现网（`prisma/seed`）
 * 只有 `report.mbti` / `report.relationship` 两个，**没有任何 `AI_COMPANION` 模板**。
 *
 * 处理方式：
 *   · **响应里的 `promptKey` 始终回契约键名**（它是对外契约字段，前端可能据此埋点）；
 *   · 库内查找走 `resolvePromptTemplateKey` 的候选链，找到哪个用哪个，并把实际键
 *     记进日志（`promptKeyResolved`），便于运维发现"模板还没建"；
 *   · 候选链全部落空时抛 `AI_PROMPT_TEMPLATE_NOT_FOUND`（`50011` → 契约 `50020`），
 *     **绝不静默回落**到某个不相关的模板 —— 那会产出一段"报告腔"的聊天回复，
 *     比明确报错更难排查，也更伤用户。
 *
 * ## 变量契约（运营建模板时必须知道的占位符）
 *
 * 模板可以按需引用下列占位符（未引用的会被忽略，渲染器只校验"用到但没给"）：
 *
 * | 占位符 | 内容 |
 * | --- | --- |
 * | `{{myPersona}}` | 我的人格画像（≤400 token，可能被裁剪） |
 * | `{{partnerPersona}}` | 对方人格画像（≤400 token，可能被裁剪） |
 * | `{{memorySummary}}` | 历史滚动摘要（≤800 token） |
 * | `{{memoryAndHints}}` | 历史摘要 + 报告/测试摘要的合并块 |
 * | `{{recentMessages}}` | 最近 10 轮原始对话（预算内） |
 * | `{{reportContext}}` | `contextHints` 命中的报告/测试摘要 |
 * | `{{userInput}}` | **已定界包裹**的用户本轮输入（`<user_data>…</user_data>`） |
 * | `{{toneInstruction}}` | 按 `tone` 生成的语气指令 |
 * | `{{modeInstruction}}` | 按 `mode` 生成的附加指令（`PRACTICE` 的话术要求等） |
 * | `{{personaAvailability}}` | 画像启用/禁用说明（禁用时提示不要引用测评结论） |
 * | `{{userName}}` / `{{partnerName}}` | 用户昵称 / 对方昵称 |
 *
 * 用户自由文本只经 `{{userInput}}` 进入 Prompt，且**已经在代码里被定界包裹并中和了
 * 定界符**（见 `chat-context.util.ts` 的 `wrapUserInput`）—— 模板作者**不要**
 * 自己再拼一遍，也不要把 `{{userInput}}` 放在定界符之外。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { PromptService, ResolvedPrompt } from '../prompt/prompt.service';
import { wrapUserInput, type ChatContextAssembly } from './chat-context.util';
import { PERSONA_DISABLED_INSTRUCTION, buildModeInstruction, buildToneInstruction } from './chat-persona.util';
import { PROMPT_KEY_BY_MODE, type ConversationMode, type ConversationTone } from './chat.types';

/**
 * 契约键名 → 库内候选键名（按顺序尝试）
 *
 * `AI_COMPANION` 的两个候选名（点号风格与下划线风格）是因为 `report.mbti` 用的是
 * **点号小写**风格，而契约用**大写下划线**风格 —— 运营建模板时两种都有人会用，
 * 与其规定一种然后让另一种的模板"建了却不生效"，不如都认。
 */
const TEMPLATE_KEY_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  AI_COMPANION: ['AI_COMPANION', 'ai.companion', 'ai_companion'],
  RELATIONSHIP_REPORT: ['RELATIONSHIP_REPORT', 'report.relationship'],
};

/** 模板不可用时的错误（契约 §3.7.5 错误码表 `50020` Prompt 模板不可用） */
const promptTemplateNotFound = (contractKey: string, tried: readonly string[]): BusinessException =>
  new BusinessException(ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND, 'AI 助手暂不可用，请稍后重试', {
    // 把"试过哪些键"写进 logContext：运维看一眼日志就知道该在后台建哪个 key
    logContext: { contractKey, tried: tried.join(', ') },
  });

/** 渲染失败/缺变量的统一错误（契约 `50021` Prompt 变量缺失） */
const promptRenderFailed = (contractKey: string, cause: unknown): BusinessException =>
  new BusinessException(ErrorCode.AI_PROMPT_VARIABLE_MISSING, 'AI 助手暂不可用，请稍后重试', {
    logContext: { contractKey, cause: cause instanceof Error ? cause.message : String(cause) },
  });

/** 装配输入 */
export interface ChatPromptInput {
  readonly mode: ConversationMode;
  readonly tone: ConversationTone;
  readonly includePersona: boolean;
  /** 用户本轮输入（**原始文本**，本函数负责定界包裹） */
  readonly userInput: string;
  readonly context: ChatContextAssembly;
  readonly userName: string;
  readonly partnerName: string | null;
}

/** 装配结果 */
export interface ChatPromptAssembly {
  /** 契约键名（响应 `promptKey` 用这个） */
  readonly contractKey: string;
  /** 实际命中的库内键名（日志与排障用） */
  readonly templateKey: string;
  readonly versionId: string;
  readonly version: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  /** System 消息（已渲染） */
  readonly system: string;
  /** User 消息（已渲染） */
  readonly user: string;
  /** 本次实际使用的变量名 */
  readonly usedVariables: readonly string[];
}

/** 契约键名 → 候选库内键名 */
export const templateKeyCandidatesOf = (contractKey: string): readonly string[] =>
  TEMPLATE_KEY_CANDIDATES[contractKey] ?? [contractKey];

/** 会话模式 → 契约 Prompt 键名（契约 §3.7.1 规则 4） */
export const promptKeyOf = (mode: ConversationMode): string => PROMPT_KEY_BY_MODE[mode];

/**
 * 渲染对话 Prompt
 *
 * 依次尝试候选键名，第一个存在且可渲染的即采用。**只对"模板不存在"继续尝试**：
 * 一旦模板存在但渲染失败（缺变量），立即失败 —— 那说明运营写的模板引用了
 * 我们没提供的占位符，继续尝试下一个键只会把同一个配置错误掩盖成另一种报错。
 */
export const assembleChatPrompt = async (
  prompts: PromptService,
  input: ChatPromptInput,
): Promise<ChatPromptAssembly> => {
  const contractKey = promptKeyOf(input.mode);
  const candidates = templateKeyCandidatesOf(contractKey);

  const variables = buildPromptVariables(input);

  for (const candidate of candidates) {
    try {
      const resolved: ResolvedPrompt = await prompts.getPrompt(candidate, variables);

      return {
        contractKey,
        templateKey: resolved.templateKey,
        versionId: resolved.versionId,
        version: resolved.version,
        provider: resolved.provider,
        model: resolved.model,
        temperature: resolved.temperature,
        maxTokens: resolved.maxTokens,
        system: resolved.system,
        user: resolved.user,
        usedVariables: resolved.usedVariables,
      };
    } catch (error) {
      // 只对"模板不存在"继续尝试下一个候选键；模板存在但渲染失败（缺变量）
      // 说明运营写的模板引用了我们没提供的占位符，继续尝试只会把同一个配置错误
      // 掩盖成另一种报错，因此立即失败
      if (!isTemplateNotFound(error)) throw promptRenderFailed(candidate, error);
    }
  }

  throw promptTemplateNotFound(contractKey, candidates);
};

/**
 * 组装渲染变量
 *
 * 所有变量**无条件存在**（缺失时为空串）：渲染器 `renderPromptVersion` 对
 * "模板里写了占位符但没给值"是**硬失败**，若这里按需省略键，一份引用了
 * `{{partnerPersona}}` 的模板在没有对方的会话里会直接渲染不出来 ——
 * 而"没有对方"是完全正常的会话形态（个人倾诉）。给空串让模板自然渲染成一句
 * 空行，比整个会话建不出来要好。
 */
export const buildPromptVariables = (input: ChatPromptInput): Record<string, string> => {
  const { context } = input;

  return {
    myPersona: context.blocks['myPersona'] ?? '',
    partnerPersona: context.blocks['partnerPersona'] ?? '',
    memorySummary: context.blocks['memorySummary'] ?? '',
    memoryAndHints: context.blocks['memoryAndHints'] ?? '',
    recentMessages: context.blocks['recentMessages'] ?? '',
    reportContext: context.blocks['reportContext'] ?? '',
    // 用户输入只在这里进入，并且已经包裹定界符（见文件头）
    userInput: wrapUserInput(input.userInput),
    toneInstruction: buildToneInstruction(input.tone),
    modeInstruction: buildModeInstruction(input.mode),
    personaAvailability: input.includePersona ? '' : PERSONA_DISABLED_INSTRUCTION,
    userName: input.userName,
    partnerName: input.partnerName ?? '',
  };
};

/**
 * 判定异常是否为"模板不存在"
 *
 * 只认错误码而不认异常类型：Provider 层与渲染层之间可能被拦截器/SDK 包装，
 * 结构判断（读 `code`）比 `instanceof` 稳（与 `report-generation.service.ts`
 * 的 `readErrorCode` 同一思路）。
 * `AI_PROMPT_TEMPLATE_NOT_FOUND`（`50011`）同时覆盖"模板不存在""已停用""无 ACTIVE 版本"
 * 三种情况 —— 三者对调用方而言都是"这个键没有可用模板"，都应继续尝试下一个候选键。
 */
const isTemplateNotFound = (error: unknown): boolean => {
  if (error instanceof BusinessException) return error.code === ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND;

  if (typeof error === 'object' && error !== null) {
    const raw = (error as { code?: unknown }).code;
    if (typeof raw === 'number') return raw === ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw) === ErrorCode.AI_PROMPT_TEMPLATE_NOT_FOUND;
  }

  return false;
};
