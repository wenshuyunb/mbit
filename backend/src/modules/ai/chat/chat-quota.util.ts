/**
 * AI 配额纯逻辑（无 I/O、可 100% 单测）
 *
 * 契约依据：§3.7.8 业务规则 1/3/6（配额优先级、计数器存储、UTC+8 自然日）。
 *
 * ## 时区口径：**UTC+8 自然日**
 *
 * 本模块按契约 §3.7.8 规则 6 使用 **UTC+8** 自然日，与 `admin/ai-stats` 的
 * UTC 口径**刻意不一致**，原因：
 *   · 契约对 AI 对话配额明确写了「每日配额按 UTC+8（`Asia/Shanghai`）自然日重置」，
 *     这是**对用户可见**的语义（"今天还能聊几次"），必须与用户感知一致；
 *   · `admin/ai-stats` 的 UTC 口径是为**命中 `[usageDate, taskType]` 索引**而做的
 *     聚合优化，那是后台看板口径，用户看不到。
 *
 * ⚠ 副作用（属契约与数据模型的冲突，已在简报标注）：`ai_usage_logs.usage_date` 是
 * `@db.Date`，Prisma 按 **UTC** 截断写入。因此实测一个 UTC 自然日内可能出现两次
 * "北京时间新的一天"，即日配额在 UTC 跨日时会被多算一天。真正的修复方式是给
 * `ai_usage_logs` 增加"北京时间日期"列或改用 UTC+8 口径写入 `usage_date` ——
 * 两者都动 schema（禁止修改），故此处如实标注而不绕过。
 */

import type { SafetyResource } from './chat.types';

/** UTC+8 偏移（毫秒） */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Redis 键前缀（契约 §3.7.8 规则 3：`sm:ai:quota:{userId}:{yyyyMMdd}`） */
export const QUOTA_KEY_PREFIX = 'ai:quota';

/** 幂等键前缀（`X-Idempotency-Key` 的请求级幂等） */
export const IDEMPOTENCY_KEY_PREFIX = 'ai:idem';

/** 幂等结果保留时长（秒）—— 覆盖"用户重试/网络重发"的时间窗，不是业务有效期 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** 并发 SSE 计数键前缀 */
export const STREAM_COUNT_KEY_PREFIX = 'ai:streams';

/** 用户维度限流计数键前缀（与全局 `ThrottlerGuard` 的 IP 计数区分开） */
export const RATE_LIMIT_KEY_PREFIX = 'ai:ratelimit';

/** 并发 SSE 计数键 TTL（秒）—— 兜底：进程崩溃时计数键不会永久占用名额 */
export const STREAM_COUNT_TTL_SECONDS = 300;

/** 60s 限流窗口内允许的 AI 请求数（契约 §3.7.5 `50002`：单用户 60s 内 ≤ 10 次） */
export const RATE_LIMIT_MAX_REQUESTS = 10;

/** 限流窗口（秒） */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** 会话创建限流窗口（秒）：24h 内 10 次（契约 §3.7.1） */
export const CONVERSATION_CREATE_WINDOW_SECONDS = 24 * 60 * 60;

/** 会话创建窗口内上限（契约 §3.7.1 `10010`：24h 内 10 次） */
export const MAX_CONVERSATIONS_PER_DAY = 10;

/** SSE 流式超时（毫秒）：首 token ≤ 20s、总时长 ≤ 180s（契约 §3.7.6 规则 1） */
export const STREAM_FIRST_TOKEN_TIMEOUT_MS = 20_000;
export const STREAM_TOTAL_TIMEOUT_MS = 180_000;

/** 非流式超时（毫秒，契约 §3.7.5 异步列：60s） */
export const MESSAGE_TIMEOUT_MS = 60_000;

/** SSE 心跳默认间隔（毫秒，契约 §3.7.6 `heartbeatMs` 默认 15000） */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** SSE 心跳允许区间（毫秒，契约 §3.7.6） */
export const MIN_HEARTBEAT_MS = 5_000;
export const MAX_HEARTBEAT_MS = 30_000;

/** 单用户并发 SSE 上限（契约 §3.7.6 `50017`：≤ 3） */
export const MAX_CONCURRENT_STREAMS = 3;

/** `quota.limitedBy`（契约 §3.7.8 规则 1） */
export type QuotaLimitSource = 'DAILY_LIMIT' | 'CREDITS' | 'FREE_QUOTA' | 'NONE';

/** `plan.type`（契约 §3.7.8） */
export type QuotaPlanType = 'MEMBERSHIP_ACTIVE' | 'AI_CREDITS' | 'FREE' | 'NONE';

/** UTC+8 的日期键 `yyyyMMdd`（Redis 键与"今天是哪一天"的唯一判定点） */
export const shanghaiDateKey = (now: Date): string => {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);

  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
};

/** UTC+8 日期键的展示形态 `yyyy-MM-dd`（契约 `usage.today.date`） */
export const shanghaiIsoDate = (now: Date): string => {
  const key = shanghaiDateKey(now);

  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
};

/**
 * 下一次配额重置时刻（UTC+8 次日零点，以 UTC 时间戳表述）
 *
 * 契约 `quota.resetAt` 是 UTC 时间戳（示例 `"2026-02-15T00:00:00.000Z"` 看似是 UTC 零点，
 * 但结合"按 UTC+8 自然日重置"的规则，正确语义是 **UTC+8 次日 00:00 对应的 UTC 时刻**，
 * 即 `2026-02-14T16:00:00.000Z`）。这里按**规则**实现，因为 `resetInSeconds` 必须与
 * 它自洽 —— 若按 UTC 零点算，北京时间 20:00 的用户会看到"4 小时后重置"，
 * 但实际那时额度还没回来。
 */
export const nextQuotaResetAt = (now: Date): Date => {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const nextDayShanghaiMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );

  return new Date(nextDayShanghaiMidnight - SHANGHAI_OFFSET_MS);
};

/** `quota.resetInSeconds`（至少为 0） */
export const secondsUntilReset = (now: Date): number =>
  Math.max(0, Math.floor((nextQuotaResetAt(now).getTime() - now.getTime()) / 1000));

/** 会员权益的日额度解析输入 */
export interface DailyQuotaInput {
  /** 是否为生效中的会员（**必须**来自 `EntitlementService`，见 `ChatQuotaService`） */
  readonly isMember: boolean;
  /** 会员每日额度（`system_configs.memberAiDailyLimit`，读不到用 `fallbackDailyLimit`） */
  readonly memberDailyLimit: number;
  /** 今日已用次数（Redis 计数器；Redis 不可用时由 DB 日聚合兜底） */
  readonly usedToday: number;
  /** 可用的 `AI_CREDITS` 余额（次数包剩余次数之和） */
  readonly creditBalance: number;
  /** 免费用户总额度（`system_configs.freeAiQuotaTotal`） */
  readonly freeQuotaTotal: number;
  /** 免费用户已用总额度（按 `ai_usage_logs` 全量统计） */
  readonly freeQuotaUsed: number;
  /** 会员额度读不到时的兜底值（来自 `MembershipPlan.dailyAiQuota` 或硬编码默认） */
  readonly fallbackDailyLimit: number;
  /** 当前时刻（注入以便测试确定性） */
  readonly now: Date;
}

/** 配额视图（契约 §3.7.8 `data.quota`） */
export interface QuotaView {
  readonly hasQuota: boolean;
  readonly limitedBy: QuotaLimitSource;
  readonly remainingToday: number;
  readonly dailyLimit: number;
  readonly usedToday: number;
  readonly resetAt: string;
  readonly resetInSeconds: number;
  readonly creditBalance: number;
  readonly freeQuota: {
    readonly totalLimit: number;
    readonly used: number;
    readonly remaining: number;
    readonly exhausted: boolean;
  };
}

/** 由配额视图推导的**简短**形态（会话接口里的 `quota` 字段，契约 §3.7.1/§3.7.2/§3.7.3/§3.7.5） */
export interface QuotaSummary {
  readonly plan: QuotaPlanType;
  readonly remainingToday: number;
  readonly dailyLimit: number;
  readonly creditBalance: number;
  readonly resetAt: string;
}

/**
 * 解析配额（契约 §3.7.8 规则 1：`MEMBERSHIP_ACTIVE` → `AI_CREDITS` → 免费总额度）
 *
 * 返回的 `limitedBy` 标识**当前生效的限制来源**：这是给前端做文案分支用的
 * （"今日额度已用完，明天再来" vs "次数包已用完，去购买" vs "免费额度已用完，开通会员"），
 * 三种情况的升级路径完全不同，所以不能只回一个 `exhausted: true`。
 *
 * `hasQuota = false` 时 `limitedBy` 一定是具体来源（不会是 `NONE`）——
 * `NONE` 只用于"确实没有任何限制"（会员额度无限或额度充足到不构成限制）的场景。
 */
export const resolveQuota = (input: DailyQuotaInput): QuotaView => {
  // 会员额度读不到时回落到 `MembershipPlan.dailyAiQuota`；两者都为 0 说明套餐没配日额度，
  // 此时按"会员不限额"处理（0 = 不限，见 DATABASE_DESIGN §membership_plans.dailyAiQuota 注释）
  const rawDailyLimit = input.memberDailyLimit > 0 ? input.memberDailyLimit : input.fallbackDailyLimit;
  const unlimitedDaily = input.isMember && rawDailyLimit <= 0;
  const dailyLimit = input.isMember ? Math.max(0, Math.trunc(rawDailyLimit)) : 0;

  const usedToday = Math.max(0, Math.trunc(input.usedToday));
  const remainingToday = unlimitedDaily ? 0 : Math.max(0, dailyLimit - usedToday);

  const creditBalance = Math.max(0, Math.trunc(input.creditBalance));
  const freeQuotaTotal = Math.max(0, Math.trunc(input.freeQuotaTotal));
  const freeQuotaUsed = Math.max(0, Math.trunc(input.freeQuotaUsed));
  const freeRemaining = Math.max(0, freeQuotaTotal - freeQuotaUsed);

  const common = {
    dailyLimit: unlimitedDaily ? 0 : dailyLimit,
    usedToday,
    creditBalance,
    freeQuotaTotal,
    freeQuotaUsed,
    freeRemaining,
    now: input.now,
  };

  // 优先级 ①：会员每日额度（含"会员不限额"）
  if (input.isMember && (unlimitedDaily || remainingToday > 0)) {
    return buildView({
      ...common,
      hasQuota: true,
      limitedBy: 'DAILY_LIMIT',
      // 不限额时 `remainingToday` 与 `dailyLimit` 都是 0 —— 这个组合的语义是"不限"。
      // 不用 `Number.MAX_SAFE_INTEGER`：它出现在 JSON 里会吓到前端，也可能被客户端
      // 拿去做数值运算后溢出。前端已有对应分支（`pkgChat/pages/index.vue` 的
      // `remaining === null ? '次数不限' : ...` 同族语义）。
      remainingToday: unlimitedDaily ? 0 : remainingToday,
    });
  }

  // 优先级 ②：次数包（AI_CREDITS）——会员日额度用尽后仍可用次数包
  if (creditBalance > 0) {
    return buildView({ ...common, hasQuota: true, limitedBy: 'CREDITS', remainingToday });
  }

  // 优先级 ③：免费总额度（仅非会员）
  if (!input.isMember && freeRemaining > 0) {
    return buildView({
      ...common,
      hasQuota: true,
      limitedBy: 'FREE_QUOTA',
      remainingToday: freeRemaining,
      // 免费用户的"今日额度"语义就是**总额度**：契约 §3.7.8 的 `remainingToday`
      // 对免费用户返回的是总剩余（`frontend/miniapp/src/api/chat.ts` 的注释也这么写）
      dailyLimit: freeQuotaTotal,
      usedToday: freeQuotaUsed,
    });
  }

  /**
   * 全部耗尽：`limitedBy` 落到**最贴近用户的一条**，前端据此选升级入口。
   * 会员先撞日额度（明天回来即可），非会员先撞免费总额度（需要付费）。
   */
  const exhaustedBy: QuotaLimitSource = input.isMember ? 'DAILY_LIMIT' : freeQuotaTotal > 0 ? 'FREE_QUOTA' : 'CREDITS';

  return buildView({ ...common, hasQuota: false, limitedBy: exhaustedBy, remainingToday });
};

/** 内部：视图组装（把"计算"与"组装"分开，避免 resolveQuota 里出现四份重复对象字面量） */
const buildView = (params: {
  hasQuota: boolean;
  limitedBy: QuotaLimitSource;
  remainingToday: number;
  dailyLimit: number;
  usedToday: number;
  creditBalance: number;
  freeQuotaTotal: number;
  freeQuotaUsed: number;
  freeRemaining: number;
  now: Date;
}): QuotaView => ({
  hasQuota: params.hasQuota,
  limitedBy: params.limitedBy,
  remainingToday: params.remainingToday,
  dailyLimit: params.dailyLimit,
  usedToday: params.usedToday,
  resetAt: nextQuotaResetAt(params.now).toISOString(),
  resetInSeconds: secondsUntilReset(params.now),
  creditBalance: params.creditBalance,
  freeQuota: {
    totalLimit: params.freeQuotaTotal,
    used: params.freeQuotaUsed,
    remaining: params.freeRemaining,
    exhausted: params.freeRemaining <= 0 && params.freeQuotaTotal > 0,
  },
});

/** 配额视图 → `plan.type`（契约 §3.7.8 的 `plan.type` 取值域很窄，只能表达"当前靠什么在支撑"） */
export const quotaPlanTypeOf = (quota: QuotaView, isMember: boolean): QuotaPlanType => {
  if (isMember) return 'MEMBERSHIP_ACTIVE';
  if (quota.limitedBy === 'CREDITS') return 'AI_CREDITS';
  if (quota.limitedBy === 'FREE_QUOTA') return 'FREE';
  return 'NONE';
};

/** 配额视图 → 接口内嵌的简短形态（契约 §3.7.1 `quota` 字段） */
export const toQuotaSummary = (quota: QuotaView, isMember: boolean): QuotaSummary => ({
  plan: quotaPlanTypeOf(quota, isMember),
  remainingToday: quota.remainingToday,
  dailyLimit: quota.dailyLimit,
  creditBalance: quota.creditBalance,
  resetAt: quota.resetAt,
});

/** 配额耗尽原因（契约 §3.7.8 规则 2 的 `nextActions.reason`） */
export const quotaExhaustedReason = (quota: QuotaView): string | null => {
  if (quota.hasQuota) return null;

  switch (quota.limitedBy) {
    case 'FREE_QUOTA':
      return 'FREE_QUOTA_EXHAUSTED';
    case 'CREDITS':
      return 'CREDITS_EXHAUSTED';
    case 'DAILY_LIMIT':
      return 'DAILY_LIMIT_REACHED';
    case 'NONE':
      return null;
  }
};

/**
 * 从 `disclaimer.safetyResources` 的 JSON 值里读出热线清单
 *
 * 配置是 `Json` 列，手工修数或历史数据都可能让形状偏离（数组里混进字符串/对象缺字段）。
 * 这里逐项校验并**丢弃**非法项，而不是抛错：一份有 2 条热线可用的配置，
 * 比"因为第 3 条格式错而整块资源卡不显示"要好得多。
 */
export const parseSafetyResources = (raw: unknown): readonly SafetyResource[] => {
  if (!Array.isArray(raw)) return [];

  const result: SafetyResource[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;

    const record = item as Record<string, unknown>;
    const name = record['name'];
    const phone = record['phone'];
    if (typeof name !== 'string' || name.length === 0 || typeof phone !== 'string' || phone.length === 0) continue;

    const available = record['available'];

    result.push({
      name,
      phone,
      available: typeof available === 'string' && available.length > 0 ? available : '24 小时',
    });
  }

  return result;
};
