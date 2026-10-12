/**
 * AI 用量日志与调用审计（契约 §3.7.5 规则 10，架构 P6 / §10.6）
 *
 * ## 为什么审计表里存的是"指纹"而不是全文
 *
 * `ai_call_audits` 的用途是排障（"这次为什么慢/为什么失败"）与合规留痕
 * （"这个用户当时确实发起过请求"）。存全文会带来两个问题：
 *   · 对话正文会以**第二份副本**的形式散落在审计表里，而用户行使删除权时
 *     只清 `ai_messages` —— 审计表里那份就变成了"删不掉的聊天记录"；
 *   · 审计表是只追加、无 TTL 的表，体积会随对话量线性膨胀。
 *
 * 因此这里只记 `promptFingerprint`（sha256 前 32 位）+ 长度。指纹足以做
 * "同一输入是否重复出现"的判定，却不含任何可读正文。
 * `redactedSample` 字段保留但**不填正文** —— 契约明确要求"不存全文"。
 *
 * ## 为什么失败也要写用量日志
 *
 * 与 `report-generation.service.ts` 同一理由：失败/中断的调用同样消耗了 token。
 * 只在成功时记账会让成本看板系统性低估，而成本看板的用途正是发现异常。
 * 流式被中断的场景还额外记 `success = false` 且**保留 latencyMs**，
 * 这样"用户频繁断连导致成本上升"这类问题才看得出来。
 */

import { createHash } from 'node:crypto';

import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { estimateCostCents } from '../provider/llm-pricing';
import type { LlmProviderName, LlmUsage } from '../provider/llm-provider.types';

/** 用量日志写入入参 */
export interface ChatUsageLogInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly usage: LlmUsage;
  readonly latencyMs: number | null;
  /** 成功或失败（失败来自重试耗尽/超时/熔断；流式中断也是失败） */
  readonly success: boolean;
  /** 是否命中缓存（对话场景通常无缓存，保留字段以对齐契约） */
  readonly cacheHit?: boolean;
  /** 厂商侧请求 id（排障） */
  readonly providerRequestId?: string | null;
}

/** 调用审计写入入参 */
export interface ChatCallAuditInput {
  readonly requestId: string;
  readonly userId: string;
  readonly provider: LlmProviderName;
  readonly model: string;
  /** 已渲染的 Prompt（本函数只取其指纹与长度，**不落全文**） */
  readonly promptText: string;
  readonly responseLength: number;
  readonly cacheHit: boolean;
  readonly status: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'CIRCUIT_OPEN' | 'BLOCKED' | 'CACHE_HIT';
  readonly httpStatus: number | null;
  readonly errorCode: number | null;
  readonly errorMessage: string | null;
  readonly latencyMs: number | null;
}

/**
 * 写入用量日志
 *
 * 记账失败**不抛错**（只记日志）：此刻消息已经落库、用户已经看到回复，
 * 因为一条统计记录失败而把成功返回变成异常，是把"统计问题"升级成"用户问题"。
 * 用量日志是事后可补算的（`ai_messages` 里也有同源计量字段）。
 */
export const writeChatUsageLog = async (prisma: PrismaService, input: ChatUsageLogInput): Promise<void> => {
  try {
    await prisma.aiUsageLog.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        taskType: 'AI_COMPANION',
        provider: input.provider as never,
        model: input.model,
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        totalTokens: input.usage.totalTokens,
        costAmount: estimateCostCents(input.provider, input.model, input.usage),
        cacheHit: input.cacheHit ?? false,
        success: input.success,
        latencyMs: input.latencyMs,
        ...(input.providerRequestId !== null && input.providerRequestId !== undefined
          ? { requestId: input.providerRequestId.slice(0, 64) }
          : {}),
        // `usage_date` 是 `@db.Date`，Prisma 按 UTC 截断（见 `chat-quota.util.ts` 的时区说明）
        usageDate: new Date(),
      },
    });
  } catch {
    // 静默：调用方已有自己的错误处理路径，这里再抛会让错误归因错位
  }
};

/**
 * 写入调用审计
 *
 * 同样不抛错：审计是观测手段，不是业务路径的一环。
 * 但**错误码与状态必须写对** —— 后台的熔断监控与失败率看板都读这两个字段，
 * 写错等于让监控失灵。
 */
export const writeChatCallAudit = async (prisma: PrismaService, input: ChatCallAuditInput): Promise<void> => {
  try {
    await prisma.aiCallAudit.create({
      data: {
        requestId: input.requestId.slice(0, 64),
        userId: input.userId,
        taskType: 'AI_COMPANION',
        provider: input.provider as never,
        model: input.model,
        promptFingerprint: fingerprintOf(input.promptText),
        promptLength: input.promptText.length,
        responseLength: input.responseLength,
        // 契约要求"不存全文"；这里显式不写 `redactedSample`
        cacheHit: input.cacheHit,
        status: input.status as never,
        httpStatus: input.httpStatus,
        errorCode: input.errorCode === null ? null : String(input.errorCode).slice(0, 32),
        errorMessage: input.errorMessage === null ? null : input.errorMessage.slice(0, 512),
        latencyMs: input.latencyMs,
      },
    });
  } catch {
    // 同上：审计失败不影响业务
  }
};

/**
 * 无依赖的 sha256（只用于指纹）
 *
 * 不用 `CryptoService`：那个服务在构造时读取密钥材料（用于手机号加密），
 * 而指纹只需要一个稳定哈希。为了一个纯哈希把整个加密服务塞进对话链路，
 * 会让单测需要准备密钥环境。
 *
 * 截取 32 位（128 bit）：碰撞概率对"同一 Prompt 是否重复出现"这一用途足够，
 * 而长度减半意味着索引与存储都更省。
 */
const fingerprintOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
