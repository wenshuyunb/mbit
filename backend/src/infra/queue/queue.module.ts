/**
 * 队列模块（全局）
 *
 * 架构依据：§6.4 队列划分、§17.1 部署形态（HTTP 与 Worker 同镜像、不同启动命令）。
 *
 * 连接复用：BullMQ 直接复用 `RedisModule` 提供的原生 ioredis 实例
 * （该实例已按 BullMQ 要求设置 `maxRetriesPerRequest: null`）。
 * 不新建连接的意义不只是省资源 —— 多一个连接就多一处需要同步配置的
 * 超时/重连/认证参数，迟早会出现「业务写进去、Worker 读不到」的环境差异。
 *
 * 本轮只注册 `export.data` 队列的生产者；消费者（Processor）随各自业务落地：
 *   · `export.data`      数据导出（Phase 1c）
 *   · `ai.report`        AI 报告生成（Phase 3）
 *   · `compatibility.calc` 匹配算分（Phase 4）
 *   · `maintenance.cleanup` 孤儿对象与旧头像清理（Phase 1c-4 已投递事件）
 */

import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

import type { AppConfig } from '../../config/config.type';
import { REDIS_CLIENT } from '../redis/redis.module';

/** 数据导出队列名（契约 §3.2.7 规则 1 指定的 `export.data`） */
export const QUEUE_EXPORT_DATA = 'export.data';

/** AI 报告生成队列名（架构 §6.4 的 `ai.report`） */
export const QUEUE_AI_REPORT = 'ai.report';

/** 匹配算分队列名（架构 §6.4 的 `compatibility.calc`） */
export const QUEUE_COMPATIBILITY_CALC = 'compatibility.calc';

/** 导出任务的重试次数（契约 §3.2.7 规则 1：重试 2 次） */
const EXPORT_JOB_ATTEMPTS = 2;

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [REDIS_CLIENT, ConfigService],
      useFactory: (
        connection: Redis,
        configService: ConfigService<AppConfig, true>,
      ): { connection: Redis; prefix: string; defaultJobOptions: Record<string, unknown> } => ({
        connection,
        // 带环境前缀：同一 Redis 实例上多环境互不干扰
        prefix: `bull:${configService.get('queue.prefix', { infer: true })}`,
        defaultJobOptions: {
          attempts: EXPORT_JOB_ATTEMPTS,
          // 指数退避：外部依赖（OSS）抖动时避免立刻重试造成二次冲击
          backoff: { type: 'exponential', delay: 2000 },
          // 成功任务留 1 天便于排障；失败任务留 7 天便于复盘
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 604_800 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_EXPORT_DATA },
      { name: QUEUE_AI_REPORT },
      { name: QUEUE_COMPATIBILITY_CALC },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
