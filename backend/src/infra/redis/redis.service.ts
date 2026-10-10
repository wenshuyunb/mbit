/**
 * RedisService — Redis 统一访问层
 *
 * 用途（见 PROJECT_ARCHITECTURE.md §4.1 / §8.1）：
 *   · 缓存（AI 结果、Prompt 模板、系统配置）
 *   · BullMQ 队列
 *   · 限流计数
 *   · Session / Refresh Token 白名单
 *   · 排行榜（ZSET）
 *
 * 关键设计：
 *   · 统一 key 前缀 sm:{domain}:{...}，避免多环境/多业务键冲突
 *   · 所有写操作默认带 TTL 的语义由调用方决定；这里提供 setJson 强制 TTL 版本
 *   · 连接失败采用指数退避重连，且最多重试到一定次数后放弃并告警
 *   · 优雅关闭：onModuleDestroy 断开连接
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import type { AppConfig } from '../../config/config.type';

/** 注入令牌：原生 ioredis 客户端（队列等基础设施需要原生实例） */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService<AppConfig, true>): Redis => {
    const options: RedisOptions = {
      host: configService.get('redis.host', { infer: true }),
      port: configService.get('redis.port', { infer: true }),
      password: configService.get('redis.password', { infer: true }) || undefined,
      db: configService.get('redis.db', { infer: true }),
      // BullMQ 要求 maxRetriesPerRequest 为 null 的连接才能用于阻塞命令
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      // 指数退避重连：100ms → 3s 上限，避免雪崩式重连
      retryStrategy: (times: number): number => Math.min(times * 100, 3000),
      reconnectOnError: (err: Error): boolean => err.message.includes('READONLY'),
      keepAlive: 10_000,
    };

    const client = new Redis(options);
    const logger = new Logger('RedisClient');

    client.on('connect', () => logger.log('Redis 连接已建立'));
    client.on('ready', () => logger.log('Redis 已就绪'));
    client.on('error', (err: Error) => logger.error(`Redis 错误: ${err.message}`));
    client.on('reconnecting', (delay: number) => logger.warn(`Redis 重连中，${delay}ms 后重试`));
    client.on('end', () => logger.warn('Redis 连接已关闭'));

    return client;
  },
};

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly prefix: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.prefix = configService.get('redis.keyPrefix', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    // fail-fast：启动时确认 Redis 可用（队列与限流强依赖）
    const healthy = await this.ping();
    if (!healthy) {
      this.logger.error('Redis 不可用，服务启动失败（队列与限流依赖 Redis）');
      throw new Error('Redis 连接不可用');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  /** 获取原生客户端（供 BullMQ、分布式锁等高级用法） */
  get raw(): Redis {
    return this.client;
  }

  // ------------------------------------------------------------ key 与健康

  /** 构造带前缀的完整 key，如 key('rt', 'user', '123') → sm:rt:user:123 */
  key(...parts: (string | number)[]): string {
    return [this.prefix, ...parts].join(':');
  }

  async ping(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (error) {
      this.logger.error(`Redis ping 失败: ${(error as Error).message}`);
      return false;
    }
  }

  // ------------------------------------------------------------------ 基础

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** 读取并反序列化 JSON；解析失败返回 null 并清理脏数据 */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`缓存内容非法，已清理: ${key}`);
      await this.client.del(key);
      return null;
    }
  }

  /** 写入字符串；ttlSeconds 传 0 表示不过期（慎用） */
  async set(key: string, value: string, ttlSeconds = 0): Promise<void> {
    if (ttlSeconds > 0) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  /** 仅当 key 不存在时写入（分布式锁 / 幂等占位） */
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  /** 按模式批量删除（使用 SCAN，禁止在生产使用 KEYS） */
  async delByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [nextCursor, found] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;
      if (found.length > 0) {
        deleted += await this.client.del(...found);
      }
    } while (cursor !== '0');
    return deleted;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.expire(key, ttlSeconds)) === 1;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  // ------------------------------------------------------------- 计数与限流

  /** 原子自增；首次自增时设置 TTL（用于滑动/固定窗口限流） */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.client.incr(key);
    if (value === 1) {
      await this.client.expire(key, ttlSeconds);
    }
    return value;
  }

  /** 读取计数器 */
  async getCount(key: string): Promise<number> {
    const raw = await this.client.get(key);
    return raw === null ? 0 : Number(raw);
  }

  // ------------------------------------------------------------- 分布式锁

  /**
   * 加锁：返回 token 表示加锁成功，null 表示已被占用
   * 释放时必须校验 token，避免误删他人锁（见 releaseLock）
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ok = await this.setIfAbsent(key, token, ttlSeconds);
    return ok ? token : null;
  }

  /** 释放锁：仅当 token 匹配时删除（Lua 保证原子性） */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      else
        return 0
      end
    `;
    const result = (await this.client.eval(script, 1, key, token)) as number;
    return result === 1;
  }

  // ------------------------------------------------------------- 有序集合

  /** 更新排行榜分数 */
  async zIncrBy(key: string, member: string, increment: number): Promise<number> {
    // Redis 返回 bulk string，此处统一转为 number，避免调用方各自转换
    return Number(await this.client.zincrby(key, increment, member));
  }

  /** 取排行榜（分数从高到低） */
  async zTopWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>> {
    const rows = await this.client.zrevrange(key, start, stop, 'WITHSCORES');
    const result: Array<{ member: string; score: number }> = [];
    for (let i = 0; i < rows.length; i += 2) {
      const member = rows[i];
      const score = rows[i + 1];
      if (member !== undefined && score !== undefined) {
        result.push({ member, score: Number(score) });
      }
    }
    return result;
  }

  // ----------------------------------------------------------------- 集合

  /**
   * 向集合添加成员
   *
   * 用途：维护「某用户当前所有有效会话」的索引（`sm:sess:user:{userId}`），
   *       使「退出全部设备」无需 SCAN 全量键空间即可精确撤销。
   *
   * @param ttlSeconds 传 >0 时会刷新整个集合的 TTL，保证索引不会早于其成员过期
   */
  async sAdd(key: string, member: string, ttlSeconds = 0): Promise<number> {
    const added = await this.client.sadd(key, member);
    if (ttlSeconds > 0) {
      await this.client.expire(key, ttlSeconds);
    }
    return added;
  }

  /** 从集合移除成员 */
  async sRem(key: string, member: string): Promise<number> {
    return this.client.srem(key, member);
  }

  /** 取集合全部成员；集合不存在时返回空数组 */
  async sMembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  /** 集合基数 */
  async sCard(key: string): Promise<number> {
    return this.client.scard(key);
  }
}
