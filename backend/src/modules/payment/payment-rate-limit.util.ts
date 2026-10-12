/**
 * 用户维度限流（契约 §3.9.3 ~ §3.9.10 的「限流」列）
 *
 * ## 为什么不用 `@Throttle()`
 *
 * `ThrottlerGuard` 默认按 **IP** 计数，而契约给这些接口的限流口径是
 * **userId**（如「userId 5 次/24h」）。小程序用户大量集中在运营商 NAT 出口，
 * 按 IP 计数会让同一出口下的用户互相挤占配额 —— 一个用户狂点退款，
 * 整栋楼的用户都退不了款。因此这里按 `userId`（必要时叠加 `orderId`）在 Redis 计数。
 *
 * ## 失败开放（fail-open）
 *
 * Redis 不可用时**放行**而不是拒绝。理由：限流的目的是防滥用，而不是正确性；
 * 把 Redis 抖动升级成「所有用户无法取消订单」是明显的风险不对等。
 * 真正需要强保护的是资金安全，那由数据库层的条件更新承担（见 `RefundService`）。
 */

import { Logger } from '@nestjs/common';

import { ErrorCode } from '../../common/errors/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import type { RedisService } from '../../infra/redis/redis.service';

const logger = new Logger('PaymentRateLimit');

/** 固定窗口计数限流；超限抛 `10007`（429） */
export const enforceRateLimit = async (params: {
  redis: RedisService;
  /** 计数键的构成部分（会拼进统一命名空间） */
  keyParts: readonly (string | number)[];
  limit: number;
  ttlSeconds: number;
  /** 超限时给用户的中文提示 */
  message: string;
}): Promise<void> => {
  const key = `pay:ratelimit:${params.keyParts.join(':')}`;

  try {
    const count = await params.redis.incrWithTtl(key, params.ttlSeconds);

    if (count > params.limit) {
      throw BusinessException.tooManyRequests(ErrorCode.RATE_LIMITED, params.message);
    }
  } catch (error) {
    // 业务异常必须透出；只有 Redis 层面的故障才降级为放行
    if (error instanceof BusinessException) throw error;

    logger.warn(`限流计数失败，本次放行 key=${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
