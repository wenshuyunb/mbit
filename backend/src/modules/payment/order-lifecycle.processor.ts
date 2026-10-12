/**
 * 订单生命周期处理器（契约 §3.9.5 规则 4 / §3.9.7 规则 2 / §3.9.10 规则 3）
 *
 * 两个定时任务，各自承担一条**不能缺失**的兜底链路：
 *
 * | job                      | 周期   | 缺了会怎样                                                |
 * | ------------------------ | ------ | --------------------------------------------------------- |
 * | `order.timeout-close`    | 60s    | 未支付订单永不关闭 → 用户可在"过期"后继续支付，状态口径全乱 |
 * | `refund.reconcile`       | 60s    | 微信退款是**异步出款**，没有退款回调时 `PENDING` 永不结算   |
 *
 * 🚫 本处理器**不接收 HTTP 请求**，只由 Worker 进程加载（见 `payment-jobs.module.ts`）。
 *
 * ## job name 必须过滤
 *
 * 队列上可能挂多个处理器（BullMQ 按队列分发、不按 job name 过滤），
 * 不过滤会让别人的任务被本处理器"读成不认识 → 正常 return → 标记完成"吞掉。
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { OrderQueryService } from './order-query.service';
import { QUEUE_ORDER_LIFECYCLE, REFUND_RECONCILE_JOB, ORDER_TIMEOUT_CLOSE_JOB } from './payment-jobs.constants';
import { RefundService } from './refund.service';

/**
 * 并发固定为 1
 *
 * 两个任务都是"扫描 + 逐单处理"的批处理：并发跑没有吞吐收益（瓶颈在微信接口），
 * 却会让同一批订单被两个实例重复扫描。串行执行时数据库条件更新仍能保证正确性，
 * 但会白白增加微信调用次数与告警噪声。
 */
const LIFECYCLE_CONCURRENCY = 1;

/** 单批扫描上限（与 Service 的默认值一致，集中在此便于运维调整） */
const TIMEOUT_BATCH_SIZE = 200;
const RECONCILE_BATCH_SIZE = 100;

@Processor(QUEUE_ORDER_LIFECYCLE, { concurrency: LIFECYCLE_CONCURRENCY })
export class OrderLifecycleProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderLifecycleProcessor.name);

  constructor(
    private readonly orders: OrderQueryService,
    private readonly refunds: RefundService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case ORDER_TIMEOUT_CLOSE_JOB: {
        const result = await this.orders.closeExpiredOrders(TIMEOUT_BATCH_SIZE);

        if (result.scanned > 0) {
          this.logger.log(
            `超时关单 scanned=${result.scanned} closed=${result.closed} wechatClosed=${result.wechatClosed} wechatFailed=${result.wechatFailed}`,
          );
        }

        return;
      }

      case REFUND_RECONCILE_JOB: {
        const result = await this.refunds.reconcilePendingRefunds(RECONCILE_BATCH_SIZE);

        if (result.scanned > 0) {
          this.logger.log(
            `退款对账 scanned=${result.scanned} settled=${result.settled} failed=${result.failed} stillPending=${result.stillPending}`,
          );
        }

        return;
      }

      default: {
        // 不认识的 job：直接返回（不抛错，避免无意义的重试）
        this.logger.warn(`收到未知的订单生命周期任务，已跳过 name=${job.name}`);
      }
    }
  }
}
