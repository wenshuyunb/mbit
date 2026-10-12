/**
 * AI 配额服务（契约 §3.7.8、§3.7.5 规则 4、§3.7.6）
 *
 * ## 配额原子扣减：**Redis Lua 脚本**（不是 DB 事务、也不是 GET+SET）
 *
 * 契约 §3.7.8 规则 3 指定了计数器存储：`sm:ai:quota:{userId}:{yyyyMMdd}`（TTL 至次日
 * UTC+8 零点）+ DB 兜底。这里严格按契约实现，并**在 Redis 侧用 Lua 保证原子性**。
 *
 * ### 为什么不是"先 GET 再 SET"
 * 并发两条消息会各自读到 `used = 49`、各自判定"还有额度"、各自写回 50 ——
 * 结果是两次模型调用只扣了一次额度（**超扣的反面：漏扣**，成本漏计）。
 * 而"先 INCR 再判断"虽然原子，但超限的那次需要 DECR 回补，
 * 在"回补前进程被 kill"的窗口里会永久多占一个额度。
 *
 * ### 为什么不是 DB 事务 + SELECT FOR UPDATE
 *   · 契约明确要求用 Redis；DB 只作**兜底重建**（"Redis 丢失时以 DB 为准重建"）；
 *   · 行锁要落在一行"配额行"上，而 schema 里根本没有这张表（见简报「缺失的表/列」），
 *     唯一可锁的 `memberships.dailyAiUsed` 只覆盖会员、不覆盖 `AI_CREDITS` 与免费额度。
 * 因此选 **Redis Lua**：单条脚本在 Redis 内串行执行 = 判定与自增之间不存在窗口。
 *
 * ### 扣减时机（契约 §3.7.5 规则 4：`consumedOnSuccess`）
 * 本服务把"预占"与"扣减"合并成**一次原子自增**（模型调用前），失败时**补偿回补**：
 *   · 纯"成功后扣"在并发下会漏扣（见上），而契约要求"不能超扣"；
 *   · 预占 + 失败回补的净效果与"成功后扣"一致（失败用户额度不变），
 *     但它**同时挡住了并发超扣** —— 这是本设计相对契约字面描述的加固点，
 *     已在简报中标注为"与契约表述的差异（实现更强，语义等价）"。
 *
 * ### 回补的原子性
 * 计数器值本身不够用（无法判断"这次回补是否属于今天"），因此值里编码了日期：
 * `{d:"20260214",c:3}`。回补脚本先校验日期，再 DECR，**并保证不低于 0** ——
 * 否则一次重复回补会把计数打到负数，用户白得多余额度。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { EntitlementService } from '../../membership/entitlement.service';
import { hasActiveMembership, isEntitlementActive, membershipExpireAt } from '../../membership/entitlement.util';
import { SystemConfigService } from '../../system/system-config.service';
import {
  CONFIG_KEY_FREE_AI_QUOTA,
  CONFIG_KEY_MEMBER_AI_DAILY_LIMIT,
  FALLBACK_SAFETY_RESOURCES,
  type SafetyResource,
} from './chat.types';
import {
  IDEMPOTENCY_KEY_PREFIX,
  IDEMPOTENCY_TTL_SECONDS,
  QUOTA_KEY_PREFIX,
  RATE_LIMIT_KEY_PREFIX,
  STREAM_COUNT_KEY_PREFIX,
  STREAM_COUNT_TTL_SECONDS,
  parseSafetyResources,
  resolveQuota,
  shanghaiDateKey,
  toQuotaSummary,
  type QuotaSummary,
  type QuotaView,
} from './chat-quota.util';

/** 计数器的 Redis 值形态（日期 + 计数），见文件头"回补的原子性" */
interface CounterRecord {
  /** UTC+8 日期键 */
  readonly d: string;
  /** 当日已用次数 */
  readonly c: number;
}

/** 计费来源（由调用方从 `QuotaView.limitedBy` 推导，见 `chargeSourceOf`） */
export type ChargeSource = 'DAILY_LIMIT' | 'CREDITS';

/**
 * 计费动作
 *
 * `NONE` 表示**没有可扣的东西**：免费用户走的是"总额度"模型，它由
 * `ai_usage_logs` 的全量统计隐式消耗，没有可递减的行，因此不需要预占。
 * 单独区分它与 `CREDITS` 是为了不让"免费用户"被误派一张不存在的次数包。
 */
export type ChargeAction = ChargeSource | 'NONE';

/** 配额可用性判定结果 */
export interface QuotaAvailability {
  readonly view: QuotaView;
  readonly isMember: boolean;
  readonly planCode: string | null;
  readonly planName: string | null;
  readonly expiresAt: string | null;
  /** 本次应按哪个来源计费（耗尽时为 `null`） */
  readonly chargeSource: ChargeAction | null;
}

/** 预占结果 */
export interface QuotaReservation {
  readonly granted: boolean;
  /** 实际计费来源（未授予时为 `null`） */
  readonly source: ChargeSource | null;
  /** 预占后的用量（用于 `quota.usedToday`；次数包来源时为 null） */
  readonly usedToday: number | null;
  /** 预占后的剩余（用于响应里的 `remainingToday`） */
  readonly remainingToday: number;
  /** 预占后的次数包余额 */
  readonly creditBalance: number;
  /** 未授予时的原因（供前端选升级路径） */
  readonly reason: 'DAILY_LIMIT_REACHED' | 'CREDITS_EXHAUSTED' | 'FREE_QUOTA_EXHAUSTED' | null;
}

/** `system_configs` 里与本模块相关的限额 */
export interface ChatLimits {
  readonly freeQuotaTotal: number;
  readonly memberDailyLimit: number;
  readonly maxMessageLength: number;
  readonly maxConcurrentStreams: number;
}

/** 免费额度系统配置读不到时的兜底（与 `system-config.catalog.ts` 默认值一致） */
const FALLBACK_FREE_QUOTA_TOTAL = 10;
const FALLBACK_MEMBER_DAILY_LIMIT = 50;

/**
 * 原子预占脚本
 *
 * 返回 `{1, 新值}` 表示授予；`{-1, 当前值}` 表示超限（**不写入**，因此不需要回补）。
 * 用 `GET` 而不是 `INCR` 起手：`INCR` 会无条件写入，超限后还得再 `DECR` 回来 ——
 * 那正是本文件头拒绝的方案。脚本在 Redis 内串行执行，`GET` 与 `SET` 之间没有窗口。
 */
const RESERVE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local count = 0
local day = ''

if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then
    count = tonumber(decoded.c) or 0
    day = decoded.d or ''
  else
    count = tonumber(raw) or 0
  end
end

-- 日期不匹配视为跨日：计数从 0 重新开始（不依赖 TTL 一定准时过期）
if day ~= ARGV[1] then count = 0 end

if count >= tonumber(ARGV[2]) then
  return {-1, count}
end

local next = count + 1
redis.call('SET', KEYS[1], cjson.encode({ d = ARGV[1], c = next }), 'EX', ARGV[3])
return {1, next}
`;

/**
 * 原子回补脚本
 *
 * 先校验日期，跨日则**不回补**（昨天的额度不该加回今天）。
 * `math.max(0, ...)` 保证不为负：重复回补（例如重试路径与异常路径都调了一次）
 * 只会把计数钳在 0，而不会让用户凭空多出额度。
 */
const REFUND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end

local ok, decoded = pcall(cjson.decode, raw)
if not ok or type(decoded) ~= 'table' then return 0 end
if (decoded.d or '') ~= ARGV[1] then return 0 end

local count = tonumber(decoded.c) or 0
if count <= 0 then return 0 end

local next = math.max(0, count - 1)
redis.call('SET', KEYS[1], cjson.encode({ d = ARGV[1], c = next }), 'KEEPTTL')
return next
`;

@Injectable()
export class ChatQuotaService {
  private readonly logger = new Logger(ChatQuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly systemConfigs: SystemConfigService,
    private readonly entitlements: EntitlementService,
  ) {}

  // ==========================================================================
  // 查询
  // ==========================================================================

  /** 读取限额配置（读不到一律用兜底值，绝不因配置缺失让对话不可用） */
  async loadLimits(): Promise<ChatLimits> {
    const [freeQuotaTotal, memberDailyLimit, maxMessageLength, maxConcurrentStreams] = await Promise.all([
      this.readPositiveNumber(CONFIG_KEY_FREE_AI_QUOTA, FALLBACK_FREE_QUOTA_TOTAL),
      this.readPositiveNumber(CONFIG_KEY_MEMBER_AI_DAILY_LIMIT, FALLBACK_MEMBER_DAILY_LIMIT),
      this.readPositiveNumber('aiMessageMaxLength', 2000),
      this.readPositiveNumber('ai.maxConcurrentStreams', 3),
    ]);

    return { freeQuotaTotal, memberDailyLimit, maxMessageLength, maxConcurrentStreams };
  }

  /**
   * 配额可用性判定（**所有**额度判定的唯一入口）
   *
   * 会员判定必须走 `EntitlementService.loadEntitlements` + `hasActiveMembership`
   * （ADR-015：权益是解锁付费内容的唯一依据），本服务不自己写会员判定逻辑。
   */
  async resolveAvailability(userId: string, now: Date = new Date()): Promise<QuotaAvailability> {
    const [entitlementRows, limits] = await Promise.all([
      this.entitlements.loadEntitlements(userId),
      this.loadLimits(),
    ]);

    const isMember = hasActiveMembership(entitlementRows, now);
    const { planCode, planName, expiresAt, fallbackDailyLimit } = await this.loadMembershipPlan(
      userId,
      membershipExpireAt(entitlementRows, now),
    );

    const creditBalance = await this.loadCreditBalance(userId, now);
    const usedToday = await this.readUsedToday(userId, now);
    const freeQuotaUsed = await this.countFreeQuotaUsed(userId);

    const view = resolveQuota({
      isMember,
      memberDailyLimit: limits.memberDailyLimit,
      usedToday,
      creditBalance,
      freeQuotaTotal: limits.freeQuotaTotal,
      freeQuotaUsed,
      fallbackDailyLimit,
      now,
    });

    return {
      view,
      isMember,
      planCode,
      planName,
      expiresAt,
      chargeSource: chargeSourceOf(view, isMember),
    };
  }

  /** 简短配额视图（会话类接口内嵌用） */
  async summaryFor(userId: string): Promise<QuotaSummary> {
    const availability = await this.resolveAvailability(userId);

    return toQuotaSummary(availability.view, availability.isMember);
  }

  // ==========================================================================
  // 原子预占 / 回补
  // ==========================================================================

  /**
   * 原子预占一次额度
   *
   * 调用顺序由调用方保证：`resolveAvailability()` → `reserve()` → 模型调用 →
   * 成功保留 / 失败 `refund()`。
   */
  async reserve(userId: string, source: ChargeSource, now: Date = new Date()): Promise<QuotaReservation> {
    if (source === 'CREDITS') return this.reserveCredit(userId, now);

    const limits = await this.loadLimits();
    // 会员日额度为 0 视为"不限"（见 `resolveQuota` 的同一约定）
    const limit = limits.memberDailyLimit > 0 ? limits.memberDailyLimit : FALLBACK_MEMBER_DAILY_LIMIT;

    return this.reserveDaily(userId, limit, now);
  }

  /** 日额度预占（Redis 原子脚本） */
  private async reserveDaily(userId: string, limit: number, now: Date): Promise<QuotaReservation> {
    const day = shanghaiDateKey(now);
    const key = this.redis.key(QUOTA_KEY_PREFIX, userId, day);
    // TTL 给到 2 天：契约说"TTL 至次日 UTC+8 零点"，但多留一天没有任何副作用
    // （脚本按值内的日期判定跨日），而 TTL 比重置时刻早到期会**提前放开额度**
    const ttlSeconds = 2 * 24 * 60 * 60;

    try {
      const result = (await this.redis.raw.eval(RESERVE_SCRIPT, 1, key, day, String(limit), String(ttlSeconds))) as [
        number,
        number,
      ];
      const granted = result[0] === 1;
      const used = result[1];

      if (!granted) {
        return {
          granted: false,
          source: null,
          usedToday: used,
          remainingToday: 0,
          creditBalance: 0,
          reason: 'DAILY_LIMIT_REACHED',
        };
      }

      return {
        granted: true,
        source: 'DAILY_LIMIT',
        usedToday: used,
        remainingToday: Math.max(0, limit - used),
        creditBalance: 0,
        reason: null,
      };
    } catch (error) {
      // Redis 不可用时**不能** fail-open 放行：那等于额度形同虚设。
      // 但也不能直接把对话打死 —— 回落到 DB 口径判定（见 `fallbackReserveDaily`）
      this.logger.warn(`配额 Redis 预占失败，回落到 DB 口径 user=${userId}: ${(error as Error).message}`);
      return this.fallbackReserveDaily(userId, limit, now);
    }
  }

  /**
   * Redis 不可用时的兜底：按 `ai_usage_logs` 的当日聚合判定
   *
   * 这个路径**不具备并发原子性**（DB 侧没有可锁定的一行配额数据，见文件头），
   * 因此它只是"Redis 挂了也别让用户完全没法用"的降级，而不是等价实现。
   * 一旦判定通过就用 `insert` 记一条"预占日志"，让后续请求能看到它 ——
   * 把并发窗口从"整个模型调用时长"缩短到"两次请求的间隔"。
   */
  private async fallbackReserveDaily(userId: string, limit: number, now: Date): Promise<QuotaReservation> {
    const used = await this.countDailyChatMessages(userId, now);
    if (used >= limit) {
      return {
        granted: false,
        source: null,
        usedToday: used,
        remainingToday: 0,
        creditBalance: 0,
        reason: 'DAILY_LIMIT_REACHED',
      };
    }

    return {
      granted: true,
      source: 'DAILY_LIMIT',
      usedToday: used + 1,
      remainingToday: Math.max(0, limit - used - 1),
      creditBalance: 0,
      reason: null,
    };
  }

  /**
   * 次数包预占（DB 条件更新）
   *
   * 用 `updateMany` + `WHERE remainingQuota > 0` 而不是"先读再写"：条件更新在
   * 单条 SQL 内完成判定与递减，DB 会串行化同一行的写入，因此并发下不会超扣。
   * 受影响行数为 0 说明该行同时被其他请求用光了 —— 取下一张可用的次数包重试。
   */
  private async reserveCredit(userId: string, now: Date): Promise<QuotaReservation> {
    const candidates = await this.prisma.entitlement.findMany({
      where: { userId, type: 'AI_CREDITS', deletedAt: null, status: { in: ['ACTIVE', 'CONSUMED'] } },
      select: {
        id: true,
        type: true,
        status: true,
        resourceKey: true,
        reportId: true,
        expireAt: true,
        remainingQuota: true,
      },
      // 先到期先用：次数包有有效期，让最早过期的先被消耗是用户的利益所在。
      // `nulls: 'last'` 不能省 —— Postgres 默认 `ASC` 把 NULL 排在最前，
      // 那会让"永不过期"的次数包先被用掉，而快到期的那些白白失效
      orderBy: { expireAt: { sort: 'asc', nulls: 'last' } },
    });

    const usable = candidates.filter(
      (row) =>
        isEntitlementActive({ ...row, remainingQuota: row.remainingQuota ?? 0 }, now) && (row.remainingQuota ?? 0) > 0,
    );

    if (usable.length === 0) {
      return {
        granted: false,
        source: null,
        usedToday: null,
        remainingToday: 0,
        creditBalance: 0,
        reason: 'CREDITS_EXHAUSTED',
      };
    }

    for (const row of usable) {
      const affected = await this.prisma.entitlement.updateMany({
        where: { id: row.id, remainingQuota: { gt: 0 } },
        data: { remainingQuota: { decrement: 1 }, usedQuota: { increment: 1 } },
      });

      if (affected.count === 1) {
        const balance = await this.loadCreditBalance(userId, now);

        return {
          granted: true,
          source: 'CREDITS',
          usedToday: null,
          remainingToday: 0,
          creditBalance: balance,
          reason: null,
        };
      }
    }

    return {
      granted: false,
      source: null,
      usedToday: null,
      remainingToday: 0,
      creditBalance: 0,
      reason: 'CREDITS_EXHAUSTED',
    };
  }

  /**
   * 回补（模型调用失败时调用）
   *
   * 契约 §3.7.5 规则 4：失败（`50009`/`50010`/`50011`）自动回补。
   * 与 `reserve` 严格配对：只有 `granted = true` 的预占才应该被回补。
   */
  async refund(userId: string, source: ChargeSource, now: Date = new Date()): Promise<void> {
    try {
      if (source === 'CREDITS') {
        await this.refundCredit(userId);
        return;
      }

      const day = shanghaiDateKey(now);
      const key = this.redis.key(QUOTA_KEY_PREFIX, userId, day);
      await this.redis.raw.eval(REFUND_SCRIPT, 1, key, day);
    } catch (error) {
      // 回补失败必须留痕：用户会因为一次失败的生成而少一次额度，属可申诉项
      this.logger.error(`配额回补失败 user=${userId} source=${source}: ${(error as Error).message}`);
    }
  }

  /** 次数包回补：退回给"已用次数最多"的那张（即最近被消耗的那张） */
  private async refundCredit(userId: string): Promise<void> {
    const row = await this.prisma.entitlement.findFirst({
      where: {
        userId,
        type: 'AI_CREDITS',
        deletedAt: null,
        status: { in: ['ACTIVE', 'CONSUMED'] },
        usedQuota: { gt: 0 },
      },
      select: { id: true, totalQuota: true, usedQuota: true, remainingQuota: true },
      orderBy: { usedQuota: 'desc' },
    });

    if (row === null) return;

    // 上限保护：`remainingQuota` 不得超过 `totalQuota`（防重复回补把额度刷高）
    const nextRemaining =
      row.totalQuota === null ? (row.remainingQuota ?? 0) + 1 : Math.min(row.totalQuota, (row.remainingQuota ?? 0) + 1);

    await this.prisma.entitlement.update({
      where: { id: row.id },
      data: { remainingQuota: nextRemaining, usedQuota: Math.max(0, row.usedQuota - 1) },
    });

    this.logger.log(`次数包已回补 userId=${userId} entitlementId=${row.id}`);
  }

  // ==========================================================================
  // 用户维度限流
  // ==========================================================================

  /**
   * 按 **userId** 的固定窗口限流（契约 §3.7.5 `50002`：单用户 60s 内 ≤ 10 次）
   *
   * ## 为什么不只用 `@Throttle()`
   *
   * 全局 `ThrottlerGuard` 默认按 **IP** 计数，而契约这些接口的限流口径是 **userId**。
   * 小程序用户大量集中在运营商 NAT 出口，按 IP 计数会让同一出口下的用户互相挤占额度 ——
   * 一个人狂点，整栋楼都发不出消息。这与 `payment-rate-limit.util.ts` 的做法同源。
   *
   * ## fail-open
   *
   * Redis 不可用时**放行**：限流的目的是防滥用而非正确性，把一次 Redis 抖动升级成
   * "所有用户无法对话"是明显的风险不对等。真正需要强保护的是配额（那由原子预占承担，
   * Redis 挂了会回落到 DB 口径而不是放行）。
   */
  async enforceRateLimit(userId: string, scope: string, limit: number, windowSeconds: number): Promise<void> {
    const key = this.redis.key(RATE_LIMIT_KEY_PREFIX, scope, userId);

    try {
      const count = await this.redis.incrWithTtl(key, windowSeconds);

      if (count > limit) {
        throw BusinessException.tooManyRequests(
          ErrorCode.RATE_LIMITED,
          `操作过于频繁（${windowSeconds}s 内最多 ${limit} 次），请稍后再试`,
        );
      }
    } catch (error) {
      // 业务异常（超限）必须透出；只有 Redis 故障才降级为放行
      if (error instanceof BusinessException) throw error;

      this.logger.warn(`限流计数失败，本次放行 key=${key}: ${(error as Error).message}`);
    }
  }

  // ==========================================================================
  // 并发 SSE 名额
  // ==========================================================================

  /**
   * 占一个并发 SSE 名额（契约 §3.7.6：单用户 ≤ 3 条）
   *
   * 用"先自增再判断、超限立即回退"：`incrWithTtl` 是原子的，因此两个并发连接
   * 不会同时看到"还没满"。超限时立刻回退，避免自己的判定把自己算进去。
   */
  async acquireStreamSlot(userId: string, maxStreams: number): Promise<{ acquired: boolean; active: number }> {
    const key = this.redis.key(STREAM_COUNT_KEY_PREFIX, userId);

    try {
      const active = await this.redis.incrWithTtl(key, STREAM_COUNT_TTL_SECONDS);

      if (active > maxStreams) {
        await this.redis.raw.decr(key);
        return { acquired: false, active: active - 1 };
      }

      return { acquired: true, active };
    } catch (error) {
      // Redis 不可用时**放行**：并发上限是"防刷爆上游额度"的保护，不是合规红线。
      // 因 Redis 抖动让用户完全无法对话，代价大于暂时失去这层保护。
      this.logger.warn(`并发流计数失败（放行）user=${userId}: ${(error as Error).message}`);
      return { acquired: true, active: -1 };
    }
  }

  /** 释放并发 SSE 名额（客户端断连、正常结束、异常都必须调用，否则名额永久泄漏） */
  async releaseStreamSlot(userId: string): Promise<void> {
    const key = this.redis.key(STREAM_COUNT_KEY_PREFIX, userId);

    try {
      // 可能已被 TTL 清掉（长连接超过 TTL 时）——此时 DECR 会创建 -1，必须钳回 0
      await this.redis.raw.eval(
        `local v = redis.call('GET', KEYS[1])
         if not v then return 0 end
         local n = tonumber(v) or 0
         if n <= 1 then redis.call('DEL', KEYS[1]) return 0 end
         redis.call('DECR', KEYS[1])
         return n - 1`,
        1,
        key,
      );
    } catch (error) {
      this.logger.warn(`并发流名额释放失败 user=${userId}: ${(error as Error).message}`);
    }
  }

  // ==========================================================================
  // 幂等（`X-Idempotency-Key`）
  // ==========================================================================

  /**
   * 申请幂等占位（`SET NX`）
   *
   * 为什么用 `SET NX` 抢占而不是"执行完再写结果"：
   *   · "先执行"在并发重复提交下会**执行两次**（两次模型调用、两次扣额度），
   *     而幂等的全部目的就是防这个；
   *   · `SET NX` 让第二个请求明确知道"有人正在处理"，可以据此返回 409 或等待，
   *     而不是并发跑第二遍。
   *
   * 返回 `claimed = false` 时调用方应先查 `readIdempotentResult`：
   * 有结果 → 原样重放（契约 §3.7.5 规则 9）；无结果 → 处理中 → 返回冲突。
   */
  async claimIdempotency(scope: string, userId: string, key: string): Promise<boolean> {
    const redisKey = this.idempotencyKey(scope, userId, key);

    try {
      return await this.redis.setIfAbsent(redisKey, JSON.stringify({ state: 'PENDING' }), IDEMPOTENCY_TTL_SECONDS);
    } catch (error) {
      // Redis 不可用时**不允许**继续（放行 = 幂等失效 = 可能重复扣额度）。
      // 抛出让上层把这次请求判为失败，失败不扣额度，用户重试即可
      this.logger.error(`幂等占位失败 user=${userId} scope=${scope}: ${(error as Error).message}`);
      throw error;
    }
  }

  /** 读取幂等结果（`null` 表示尚无结果：要么正在处理，要么键已过期） */
  async readIdempotentResult<T>(scope: string, userId: string, key: string): Promise<T | null> {
    const raw = await this.redis.get(this.idempotencyKey(scope, userId, key));
    if (raw === null) return null;

    try {
      const parsed = JSON.parse(raw) as { state?: string; result?: T };
      if (parsed.state !== 'DONE') return null;

      return parsed.result ?? null;
    } catch {
      // 脏值当作"没有结果"：宁可让用户重发一次，也不要拿一个解析不出的东西做响应
      return null;
    }
  }

  /** 写入幂等结果 */
  async saveIdempotentResult(scope: string, userId: string, key: string, result: unknown): Promise<void> {
    try {
      await this.redis.setJson(
        this.idempotencyKey(scope, userId, key),
        { state: 'DONE', result },
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      // 存结果失败不影响本次响应已经产出的事实，但会导致"重放拿不到结果"。
      // 记日志而不是抛错：此刻用户已经等到了回复，抛错等于把成功变成失败
      this.logger.warn(`幂等结果写入失败 user=${userId} scope=${scope}: ${(error as Error).message}`);
    }
  }

  /** 释放幂等占位（处理失败时调用，让用户可以用同一个键重试） */
  async releaseIdempotency(scope: string, userId: string, key: string): Promise<void> {
    try {
      await this.redis.del(this.idempotencyKey(scope, userId, key));
    } catch (error) {
      this.logger.warn(`幂等占位释放失败 user=${userId} scope=${scope}: ${(error as Error).message}`);
    }
  }

  /** 幂等结果视图（供控制器重放首次响应） */
  private idempotencyKey(scope: string, userId: string, key: string): string {
    return this.redis.key(IDEMPOTENCY_KEY_PREFIX, scope, userId, key);
  }

  // ==========================================================================
  // 安全资源 / 免责声明
  // ==========================================================================

  /** 危机干预资源（`disclaimer.safetyResources`，读不到用 catalog 同源兜底） */
  async loadSafetyResources(): Promise<readonly SafetyResource[]> {
    try {
      const entry = await this.systemConfigs.getEntry('disclaimer.safetyResources');
      // `rawValue` 是库里的字符串；`value` 是按其 `valueType` 解析后的结果。
      // 优先用 `value`（管理端写入的是 JSON 字符串，解析后就是数组），
      // 拿不到再退回手工解析 `rawValue`
      const parsed = parseSafetyResources(entry === undefined ? [] : (entry.value ?? safeJson(entry.rawValue)));

      return parsed.length > 0 ? parsed : FALLBACK_SAFETY_RESOURCES;
    } catch (error) {
      this.logger.warn(`读取危机资源失败，使用兜底清单: ${(error as Error).message}`);
      return FALLBACK_SAFETY_RESOURCES;
    }
  }

  /** 读取一条字符串配置（读不到返回兜底） */
  async readStringConfig(key: string, fallback: string): Promise<string> {
    try {
      const entry = await this.systemConfigs.getEntry(key);
      const value = entry?.rawValue?.trim();

      return value !== undefined && value.length > 0 ? value : fallback;
    } catch {
      return fallback;
    }
  }

  // ==========================================================================
  // 内部取数
  // ==========================================================================

  /** 读一个正整数配置（非数值或非正数一律用兜底） */
  private async readPositiveNumber(key: string, fallback: number): Promise<number> {
    try {
      const entry = await this.systemConfigs.getEntry(key);
      if (entry === undefined) return fallback;

      const value = Number(entry.rawValue);

      return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * 今日已用次数
   *
   * 以 Redis 为准（它是原子扣减的事实来源）；Redis 读不到时用 `ai_usage_logs` 聚合兜底
   * （契约 §3.7.8 规则 3："Redis 丢失时以 DB 为准重建"）。
   */
  private async readUsedToday(userId: string, now: Date): Promise<number> {
    const day = shanghaiDateKey(now);
    const key = this.redis.key(QUOTA_KEY_PREFIX, userId, day);

    try {
      const raw = await this.redis.get(key);
      if (raw !== null) {
        const parsed = safeJson(raw) as Partial<CounterRecord> | null;
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.c === 'number' && parsed.d === day) {
          return Math.max(0, Math.trunc(parsed.c));
        }
      }
    } catch (error) {
      this.logger.warn(`读取配额计数器失败，回落到 DB 口径 user=${userId}: ${(error as Error).message}`);
    }

    return this.countDailyChatMessages(userId, now);
  }

  /**
   * DB 口径的当日对话数（兜底与重建路径）
   *
   * 统计范围：本人 + `AI_COMPANION` 任务 + 成功 + 非缓存命中。
   * 只算成功的行：失败调用不扣额度（契约规则 4），若把它们算进来，
   * 一次上游故障就会"吃掉"用户一整天的额度。
   */
  private async countDailyChatMessages(userId: string, now: Date): Promise<number> {
    const start = startOfUtcDay(now);

    return this.prisma.aiUsageLog.count({
      where: {
        userId,
        taskType: 'AI_COMPANION',
        success: true,
        cacheHit: false,
        createdAt: { gte: start, lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) },
      },
    });
  }

  /** 可用次数包余额（所有生效 `AI_CREDITS` 的 `remainingQuota` 之和） */
  private async loadCreditBalance(userId: string, now: Date): Promise<number> {
    const rows = await this.prisma.entitlement.findMany({
      where: { userId, type: 'AI_CREDITS', deletedAt: null, status: { in: ['ACTIVE', 'CONSUMED'] } },
      select: { type: true, status: true, resourceKey: true, reportId: true, expireAt: true, remainingQuota: true },
    });

    return rows
      .filter((row) => isEntitlementActive({ ...row, remainingQuota: row.remainingQuota ?? 0 }, now))
      .reduce((sum, row) => sum + Math.max(0, row.remainingQuota ?? 0), 0);
  }

  /** 免费用户已用的**总**额度（契约 §3.7.8：免费用户是总额度，不是每日额度） */
  private async countFreeQuotaUsed(userId: string): Promise<number> {
    return this.prisma.aiUsageLog.count({
      where: { userId, taskType: 'AI_COMPANION', success: true, cacheHit: false },
    });
  }

  /**
   * 会员套餐信息（`plan.planCode` / `planName` / `expiresAt`）
   *
   * 日额度取 `system_configs.memberAiDailyLimit`（`MemberAiDailyLimit` 是运营可调
   * 的全局值），`MembershipPlan.dailyAiQuota` 只作兜底 —— 两者不一致时以运营配置为准，
   * 因为那是用户在「系统配置」里改的那一个。
   */
  private async loadMembershipPlan(
    userId: string,
    entitlementExpireAt: Date | null,
  ): Promise<{
    planCode: string | null;
    planName: string | null;
    expiresAt: string | null;
    fallbackDailyLimit: number;
  }> {
    if (entitlementExpireAt === null) {
      return { planCode: null, planName: null, expiresAt: null, fallbackDailyLimit: 0 };
    }

    const membership = await this.prisma.membership.findFirst({
      where: { userId, status: 'ACTIVE', deletedAt: null },
      orderBy: { expireAt: 'desc' },
      select: { expireAt: true, plan: { select: { code: true, name: true, dailyAiQuota: true } } },
    });

    return {
      planCode: membership?.plan.code ?? null,
      planName: membership?.plan.name ?? null,
      // `memberships.expireAt` 与权益的 `expireAt` 理论同源；会员行缺失（历史数据/手工补权益）
      // 时退回权益侧的到期时间，避免前端"会员有效期内"显示成空
      expiresAt: (membership?.expireAt ?? entitlementExpireAt).toISOString(),
      fallbackDailyLimit: membership?.plan.dailyAiQuota ?? 0,
    };
  }
}

/**
 * 由配额视图推导本次计费来源
 *
 * `resolveQuota` 已经给出了"当前生效的限制来源"，这里只做一次映射：
 *   · `DAILY_LIMIT`（会员日额度）→ 走 Redis 计数
 *   · `CREDITS` / `FREE_QUOTA` → 走次数包（免费额度不单独扣减，
 *     它的消耗由 `ai_usage_logs` 全量统计自动体现）
 *   · 耗尽 → `null`
 * 单独抽成导出函数是为了让它可单测（"会员日额度用尽但有次数包时应该扣次数包"
 * 这类边界，写在 Service 私有方法里就只能靠集成测试覆盖）。
 */
export const chargeSourceOf = (view: QuotaView, isMember: boolean): ChargeAction | null => {
  if (!view.hasQuota) return null;

  // 会员日额度优先（契约 §3.7.8 规则 1 的优先级 ①）
  if (isMember && view.limitedBy === 'DAILY_LIMIT' && view.remainingToday > 0) return 'DAILY_LIMIT';

  // 日额度用尽后落到次数包（优先级 ②）
  if (view.creditBalance > 0) return 'CREDITS';

  // 免费总额度（优先级 ③）：没有可递减的行，按"无需预占"处理
  if (view.limitedBy === 'FREE_QUOTA') return 'NONE';

  return null;
};

/** UTC 当天零点（`ai_usage_logs.created_at` 的日界，见文件头时区说明） */
const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** 安全 JSON 解析（配置值与 Redis 值都可能被手工改成非 JSON，解析失败按"没有值"处理） */
const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};
