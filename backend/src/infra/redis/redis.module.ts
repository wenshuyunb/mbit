import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { REDIS_CLIENT, RedisService, redisClientProvider } from './redis.service';

export { REDIS_CLIENT, RedisService };

/**
 * Redis 模块（全局）
 *
 * 同时导出：
 *   · RedisService —— 业务层统一入口（缓存 / 限流 / 锁）
 *   · REDIS_CLIENT  —— 原生 ioredis 实例（供 BullMQ 等基础设施使用）
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [redisClientProvider, RedisService],
  exports: [RedisService, REDIS_CLIENT],
})
export class RedisModule {}
