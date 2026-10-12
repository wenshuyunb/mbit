/**
 * PaymentJobsModule — 订单生命周期**队列处理器**（仅在 Worker 进程加载）
 *
 * 为什么不放进 `PaymentModule`：处理器一旦被 HTTP 进程加载，就会在同进程内开始
 * 消费队列 ——「Worker 扩容」于是变成「HTTP 扩容顺带消费队列」，任务并发、
 * 内存占用与部署形态全部失控。用户端数据导出（`UserJobsModule`）与管理端订单导出
 * （`AdminOrderJobsModule`）采用同一模式。
 *
 * ## 定时任务在这里注册，而不是在 HTTP 进程
 *
 * BullMQ 的 repeatable job 只是 Redis 里的一条调度记录，**真正的执行依赖有 Worker
 * 在监听该队列**。如果由 HTTP 进程注册而 Worker 没接线，任务会不断堆积在 `wait`
 * 队列里却没人消费 —— 那比"没注册"更难排查。因此调度与消费放在同一个模块里：
 * 接线即生效，未接线则明确地什么都不做。
 *
 * ## 幂等
 *
 * 定时任务天然可能被重复触发（多副本 Worker、调度漂移）。两个任务都设计成幂等：
 *   · 超时关单：条件更新 `status IN (CREATED, PENDING_PAY)`，重复执行只会得到 `count = 0`
 *   · 退款对账：结算用 `status = 'PENDING'` 作为前置条件，重复触发不会重复结算
 */

import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { QueueModule } from '../../infra/queue/queue.module';
import { OrderLifecycleProcessor } from './order-lifecycle.processor';
import {
  LIFECYCLE_INTERVAL_MS,
  ORDER_TIMEOUT_CLOSE_JOB,
  QUEUE_ORDER_LIFECYCLE,
  REFUND_RECONCILE_JOB,
} from './payment-jobs.constants';
import { PaymentModule } from './payment.module';

/**
 * 定时任务注册器
 *
 * `jobId` 固定同名：BullMQ 用 `name + repeat 配置` 作为 repeatable job 的键，
 * 固定 `jobId` 让"重启后重复注册"变成一次幂等的覆盖，而不是新建一份调度
 * （否则每次部署都会多出一份每分钟任务，N 次部署后微信调用量放大 N 倍）。
 */
@Injectable()
export class OrderLifecycleScheduler implements OnModuleInit {
  private readonly logger = new Logger(OrderLifecycleScheduler.name);

  constructor(@InjectQueue(QUEUE_ORDER_LIFECYCLE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.register(ORDER_TIMEOUT_CLOSE_JOB, '超时自动关单');
    await this.register(REFUND_RECONCILE_JOB, '退款对账');
  }

  private async register(jobName: string, label: string): Promise<void> {
    try {
      await this.queue.add(
        jobName,
        {},
        {
          repeat: { every: LIFECYCLE_INTERVAL_MS },
          jobId: jobName,
          // 定时任务的执行历史没有保留价值：一次成功执行留 1 小时便于排查，
          // 失败留 1 天（避免同一故障每分钟堆一条失败记录把 Redis 撑满）
          removeOnComplete: { age: 3_600 },
          removeOnFail: { age: 86_400 },
          // 定时任务不重试：下一分钟本来就会再跑一次，重试只会让"卡住的批次"更卡
          attempts: 1,
        },
      );

      this.logger.log(`已注册定时任务「${label}」 name=${jobName} 周期=${String(LIFECYCLE_INTERVAL_MS / 1000)}s`);
    } catch (error) {
      // 调度注册失败不能拖垮 Worker 启动：其他队列仍然要工作，
      // 而且下一轮重启会再试一次
      this.logger.error(`注册定时任务失败 name=${jobName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

@Module({
  // 处理器与调度器都依赖 `PaymentModule` **导出**的服务实例：
  // 若在这里重复 provide，会得到第二份 Service 实例（各自持有独立的 Logger 与
  // 连接引用），排障时会看到"同一个类在不同模块里行为不同"这种诡异现象
  imports: [PaymentModule, QueueModule, BullModule.registerQueue({ name: QUEUE_ORDER_LIFECYCLE })],
  providers: [OrderLifecycleProcessor, OrderLifecycleScheduler],
})
export class PaymentJobsModule {}
