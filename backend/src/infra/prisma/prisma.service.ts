/**
 * PrismaService — 数据库连接的生命周期管理
 *
 * 职责：
 *   · 应用启动时显式 connect（fail-fast：数据库不可用则启动失败，不带病运行）
 *   · 关闭时 disconnect，配合优雅关闭避免连接泄漏
 *   · 慢查询告警（超过阈值打 warn 日志，便于早期发现 N+1 与缺索引）
 *
 * 约定：业务代码只注入 PrismaService，禁止在 Service 中 new PrismaClient()。
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/config.type';

/** 慢查询阈值（毫秒） */
const SLOW_QUERY_THRESHOLD_MS = 500;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(configService: ConfigService<AppConfig, true>) {
    const isProduction = configService.get('app.isProduction', { infer: true });

    super({
      datasources: {
        db: { url: configService.get('database.url', { infer: true }) },
      },
      log: isProduction
        ? [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
      errorFormat: isProduction ? 'minimal' : 'pretty',
    });

    this.registerLogHandlers(isProduction);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('数据库连接已建立');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('数据库连接已释放');
  }

  /**
   * 健康检查用：执行最小查询确认连接可用
   */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(`数据库健康检查失败: ${(error as Error).message}`);
      return false;
    }
  }

  private registerLogHandlers(isProduction: boolean): void {
    // Prisma 的事件类型定义较宽松，这里用结构化断言避免 any 扩散
    const client = this as unknown as {
      $on: (event: 'query' | 'warn' | 'error', cb: (payload: unknown) => void) => void;
    };

    client.$on('warn', (payload) => {
      this.logger.warn(`Prisma 警告: ${JSON.stringify(payload)}`);
    });

    client.$on('error', (payload) => {
      this.logger.error(`Prisma 错误: ${JSON.stringify(payload)}`);
    });

    if (isProduction) return;

    client.$on('query', (payload) => {
      const event = payload as { duration: number; query: string; params?: string };
      if (event.duration >= SLOW_QUERY_THRESHOLD_MS) {
        this.logger.warn(`慢查询 ${event.duration}ms: ${event.query}`);
      }
    });
  }
}

/** 导出 Prisma 命名空间，便于业务层引用类型（如 Prisma.TransactionClient） */
export { Prisma };
