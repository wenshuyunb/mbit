/**
 * 报告相关的配额扣减（契约 §3.5.7 / §3.5.8 / §3.5.9）
 *
 * ## 为什么配额要单独成服务，而不是散在各接口里
 *
 * 三处配额（重生成 3 次/日、PDF 导出 5 次/日、分享卡 10 次/小时）都要求
 * **原子扣减 + 可补偿**。把它们收敛到一个地方才有两件保证：
 *   ① 「先扣后做」与「失败回滚」的配对不会漏（少一处回滚就是白扣用户一次额度）；
 *   ② 计数与业务判定分开，业务代码不需要知道用的是 Redis 计数器还是权益行。
 *
 * ## 两类配额的本质差异
 *
 * | 类型             | 载体                        | 原子性来源                        |
 * | ---------------- | --------------------------- | --------------------------------- |
 * | 时间窗次数配额   | Redis 计数器（`INCR`）      | Redis 单命令原子 + 键含窗口标识    |
 * | 权益次数配额     | `entitlements.remainingQuota` | **一条 `UPDATE ... WHERE` 语句**  |
 *
 * 权益配额刻意不做"先读再写"：`read → check → write` 之间只要有一次并发点击，
 * 两个请求就会读到同一个余量并各自扣一次 —— 表现为"买了 3 次却导出了 4 次"。
 * 条件更新（`WHERE remaining_quota > 0`）把"判断"和"扣减"放进同一条语句，
 * 由数据库的行锁保证只有一个请求能扣到 0。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';

/** 一天的秒数 */
const SECONDS_PER_DAY = 24 * 60 * 60;

/** 配额计数键前缀（按用途再分一层，避免不同用途互相污染） */
const QUOTA_PREFIX = 'report:quota';

/** 一次配额扣减的结果（供响应体展示"还剩几次"） */
export interface QuotaState {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  /** 窗口重置时刻（ISO 字符串） */
  readonly resetAt: string;
}

/** 时间窗配额的窗口定义 */
export type QuotaWindow = { readonly kind: 'utc-day' } | { readonly kind: 'seconds'; readonly seconds: number };

/**
 * 窗口的键后缀与 TTL
 *
 * `utc-day` 用「UTC 自然日」而不是「距首次请求 24 小时」：契约 §3.5.7 的响应示例
 * 给出 `resetAt: 2026-02-15T00:00:00.000Z`（次日零点），说明产品预期是**自然日**语义 ——
 * 用户能预期"明天零点额度恢复"，而滚动窗口下"什么时候恢复"永远说不清。
 */
export const resolveQuotaWindow = (
  window: QuotaWindow,
  now: Date,
): { bucket: string; ttlSeconds: number; resetAt: Date } => {
  if (window.kind === 'seconds') {
    const resetAt = new Date(now.getTime() + window.seconds * 1000);

    return { bucket: 'window', ttlSeconds: window.seconds, resetAt };
  }

  const bucket = now.toISOString().slice(0, 10);
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  // 至少 1s：恰好在 23:59:59.999 计算时会得到 0，TTL=0 在 Redis 里表示"永不过期"，
  // 那会把当天的计数永久留在键里，第二天所有用户都被判超限
  const ttlSeconds = Math.max(1, Math.min(SECONDS_PER_DAY, Math.ceil((nextMidnight - now.getTime()) / 1000)));

  return { bucket, ttlSeconds, resetAt: new Date(nextMidnight) };
};

@Injectable()
export class ReportQuotaService {
  private readonly logger = new Logger(ReportQuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 扣一次时间窗配额（超限即抛 429）
   *
   * `subject` 是配额的"对象"（如 `reportId`），使「同一报告的 3 次重生成」与
   * 「用户全局的 5 次导出」可以用同一个方法表达。
   */
  async consumeWindowQuota(input: {
    scope: string;
    userId: string;
    subject?: string;
    limit: number;
    window: QuotaWindow;
    now?: Date;
    message?: string;
  }): Promise<QuotaState> {
    const now = input.now ?? new Date();
    const { bucket, ttlSeconds, resetAt } = resolveQuotaWindow(input.window, now);
    const key = this.keyOf(input.scope, bucket, input.userId, input.subject);

    const used = await this.redis.incrWithTtl(key, ttlSeconds);

    if (used > input.limit) {
      // 超限时**立刻退回**本次自增：否则用户每被拒一次，计数就涨一次，
      // 窗口内永远不可能再通过（哪怕额度已被后台调大）
      await this.decrement(key);

      throw BusinessException.tooManyRequests(
        ErrorCode.RATE_LIMITED,
        input.message ?? `操作过于频繁，已达上限（${input.limit} 次），请稍后再试`,
        [{ field: 'resetAt', issue: resetAt.toISOString() }],
      );
    }

    return { used, limit: input.limit, remaining: Math.max(0, input.limit - used), resetAt: resetAt.toISOString() };
  }

  /** 读当前配额用量（无副作用，用于响应体的 `remainingCount`） */
  async readWindowQuota(input: {
    scope: string;
    userId: string;
    subject?: string;
    limit: number;
    window: QuotaWindow;
    now?: Date;
  }): Promise<QuotaState> {
    const now = input.now ?? new Date();
    const { bucket, resetAt } = resolveQuotaWindow(input.window, now);
    const used = await this.redis.getCount(this.keyOf(input.scope, bucket, input.userId, input.subject));

    return { used, limit: input.limit, remaining: Math.max(0, input.limit - used), resetAt: resetAt.toISOString() };
  }

  /**
   * 归还一次时间窗配额（补偿）
   *
   * 用于"扣了配额但任务最终失败"的场景。不做"归还后变负"的保护：负数只可能出现在
   * 重复归还（编码错误）时，让它暴露在监控里比悄悄夹到 0 更好排查。
   */
  async refundWindowQuota(input: {
    scope: string;
    userId: string;
    subject?: string;
    window: QuotaWindow;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const { bucket } = resolveQuotaWindow(input.window, now);

    await this.decrement(this.keyOf(input.scope, bucket, input.userId, input.subject));
  }

  /**
   * 原子扣减 `PDF_EXPORT` 权益的一次额度
   *
   * @returns 扣减成功时返回权益行 id（供失败补偿）；没有任何可用权益时返回 null
   *
   * `remainingQuota` 为 `null` 表示"时间窗内不限次"（见 `entitlement.util.ts` 的说明），
   * 此时不递减但仍要计入 `usedQuota` —— 后台需要看到真实消耗。
   */
  async consumePdfExportEntitlement(userId: string, now = new Date()): Promise<string | null> {
    const candidate = await this.prisma.entitlement.findFirst({
      where: {
        userId,
        type: 'PDF_EXPORT',
        // `CONSUMED` 仍视为有效（与 `isEntitlementActive` 一致）：一次性权益"用掉"后
        // 状态会变成 CONSUMED，但用户买的是访问权，不是"一次查看"
        status: { in: ['ACTIVE', 'CONSUMED'] },
        deletedAt: null,
        OR: [{ expireAt: null }, { expireAt: { gt: now } }],
      },
      // 先到期先用：避免用户手里的短窗权益被长期权益"挡住"而过期作废
      orderBy: { expireAt: 'asc' },
      select: { id: true },
    });

    if (candidate === null) return null;

    const updated = await this.prisma.entitlement.updateMany({
      where: {
        id: candidate.id,
        // 判断与扣减在同一条 SQL 里：`remaining_quota > 0 OR IS NULL`
        OR: [{ remainingQuota: null }, { remainingQuota: { gt: 0 } }],
      },
      // `decrement` 作用在 NULL 列上仍是 NULL（SQL 语义），因此不限次的权益不会被误扣成 -1
      data: { remainingQuota: { decrement: 1 }, usedQuota: { increment: 1 } },
    });

    if (updated.count === 0) {
      // 并发下被别的请求吃光了：返回 null 让调用方按"无可用权益"处理
      this.logger.log(`PDF_EXPORT 权益已被并发消耗殆尽 entitlementId=${candidate.id}`);
      return null;
    }

    return candidate.id;
  }

  /** 归还一次 `PDF_EXPORT` 权益额度（终端失败时补偿） */
  async refundPdfExportEntitlement(entitlementId: string): Promise<void> {
    try {
      await this.prisma.entitlement.updateMany({
        where: { id: entitlementId },
        data: { remainingQuota: { increment: 1 }, usedQuota: { decrement: 1 } },
      });
    } catch (error) {
      // 补偿失败只记日志：用户已看到"导出失败"，再抛错会把这个事实覆盖成 500
      this.logger.warn(`归还 PDF_EXPORT 权益失败 entitlementId=${entitlementId}: ${(error as Error).message}`);
    }
  }

  private keyOf(scope: string, bucket: string, userId: string, subject?: string): string {
    return this.redis.key(QUOTA_PREFIX, scope, bucket, userId, subject ?? 'all');
  }

  private async decrement(key: string): Promise<void> {
    try {
      await this.redis.raw.decr(key);
    } catch (error) {
      this.logger.warn(`归还配额失败 key=${key}: ${(error as Error).message}`);
    }
  }
}
