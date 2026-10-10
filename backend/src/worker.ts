/**
 * SoulMap AI — 队列 Worker 进程入口
 *
 * 部署形态（见 PROJECT_ARCHITECTURE.md §17.1）：
 *   与 HTTP 服务使用 **同一镜像**，仅启动命令不同，便于独立扩缩容：
 *     HTTP   → node dist/main.js
 *     Worker → node dist/worker.js
 *
 * 职责边界：
 *   Worker 只消费队列任务，不对外暴露 HTTP 端口。
 *   任务处理器（BullMQ Processor）自 Phase 3 起接入：
 *     ai.report / ai.embedding / compatibility.calc / export.pdf /
 *     notify.subscribe / outbox.relay / maintenance.cleanup
 *
 * 关闭语义：收到 SIGTERM 后停止拉取新任务，等待当前任务完成（最长 30s）再断开连接，
 *           避免任务被硬杀导致「半成品」数据。
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';

import type { AppConfig } from './config/config.type';
import { WorkerModule } from './worker.module';

/** 等待当前任务完成的最长时间（毫秒） */
const WORKER_DRAIN_TIMEOUT_MS = 30_000;

async function bootstrapWorker(): Promise<void> {
  // 用 WorkerModule（= AppModule + 队列处理器）而非 AppModule：
  // 处理器只在 Worker 进程加载，HTTP 进程不会消费队列
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });

  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  const configService = app.get(ConfigService<AppConfig, true>);
  const queuePrefix = configService.get('queue.prefix', { infer: true });

  logger.log(`队列 Worker 已启动 | 前缀=${queuePrefix} | pid=${process.pid}`);
  logger.log('已注册处理器：export.data（数据导出）、ai.report（AI 报告）、compatibility.calc（匹配算分）');

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn(`Worker 收到 ${signal}，停止拉取新任务并等待在途任务完成（最长 ${WORKER_DRAIN_TIMEOUT_MS}ms）`);

    const timer = setTimeout(() => {
      logger.error('在途任务未在超时内完成，强制退出');
      process.exit(1);
    }, WORKER_DRAIN_TIMEOUT_MS);
    timer.unref();

    try {
      // BullMQ Worker 的 close() 会等待当前 job 结束；接入后在此显式调用
      await app.close();
      logger.log('Worker 已安全退出');
      process.exit(0);
    } catch (error) {
      logger.error(`Worker 关闭过程出错: ${(error as Error).message}`);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Worker 未处理的 Promise 拒绝');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Worker 未捕获异常，进程即将退出');
    process.exit(1);
  });
}

void bootstrapWorker().catch((error: unknown) => {
  // 启动阶段失败必须让编排系统感知（非 0 退出码），否则会静默跑一个空 Worker
  Logger.error(`Worker 启动失败: ${(error as Error).message}`, (error as Error).stack, 'Bootstrap');
  process.exit(1);
});
