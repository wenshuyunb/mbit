/**
 * 健康检查模块
 *
 * 探针语义（见 PROJECT_ARCHITECTURE.md §15.3）：
 *   GET /health/live    —— 存活探针：仅确认进程存活，不查依赖（避免依赖抖动导致容器被误杀）
 *   GET /health/ready   —— 就绪探针：检查 PostgreSQL 与 Redis，任一不可用返回 503
 *   GET /health/version —— 版本信息：便于确认线上实际部署的 commit
 *
 * 注意：健康检查路径不带 /api/v1 前缀（由 main.ts 全局前缀排除），
 *       便于 LB / K8s / Docker HEALTHCHECK 使用固定路径。
 */

import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Public, RawResponse } from '../common/decorators';
import type { AppConfig } from '../config/config.type';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';

interface HealthStatus {
  status: 'ok' | 'degraded';
  service: string;
  env: string;
  timestamp: string;
  uptimeSeconds: number;
  checks?: Record<string, { status: 'up' | 'down'; latencyMs?: number; message?: string }>;
}

@ApiTags('系统-健康检查')
@ApiExcludeController(false)
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  @Get('live')
  @Public()
  @RawResponse()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '存活探针', description: '仅检查进程是否存活，不检查任何外部依赖。' })
  @ApiResponse({ status: 200, description: '进程存活' })
  live(): HealthStatus {
    return {
      status: 'ok',
      service: this.configService.get('app.name', { infer: true }),
      env: this.configService.get('app.env', { infer: true }),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get('ready')
  @Public()
  @RawResponse()
  @ApiOperation({
    summary: '就绪探针',
    description: '检查 PostgreSQL 与 Redis 连通性；任一不可用则返回 503，负载均衡应停止转发流量。',
  })
  @ApiResponse({ status: 200, description: '依赖全部就绪' })
  @ApiResponse({ status: 503, description: '存在不可用依赖' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthStatus> {
    const checks: Record<string, { status: 'up' | 'down'; latencyMs?: number; message?: string }> = {};

    const dbStart = Date.now();
    const dbOk = await this.prisma.ping();
    checks['database'] = {
      status: dbOk ? 'up' : 'down',
      latencyMs: Date.now() - dbStart,
      ...(dbOk ? {} : { message: 'PostgreSQL 连接不可用' }),
    };

    const redisStart = Date.now();
    const redisOk = await this.redis.ping();
    checks['redis'] = {
      status: redisOk ? 'up' : 'down',
      latencyMs: Date.now() - redisStart,
      ...(redisOk ? {} : { message: 'Redis 连接不可用' }),
    };

    const allUp = dbOk && redisOk;
    // 就绪探针需要让 LB 直接感知 503，因此显式设置 HTTP 状态码（不经过异常过滤器）
    res.status(allUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: allUp ? 'ok' : 'degraded',
      service: this.configService.get('app.name', { infer: true }),
      env: this.configService.get('app.env', { infer: true }),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  @Get('version')
  @Public()
  @RawResponse()
  @ApiOperation({ summary: '版本信息', description: '返回服务版本与构建信息，用于确认线上实际部署版本。' })
  version(): {
    service: string;
    env: string;
    nodeVersion: string;
    gitSha: string;
    buildTime: string;
    uptimeSeconds: number;
  } {
    return {
      service: this.configService.get('app.name', { infer: true }),
      env: this.configService.get('app.env', { infer: true }),
      nodeVersion: process.version,
      gitSha: this.configService.get('app.gitSha', { infer: true }),
      buildTime: this.configService.get('app.buildTime', { infer: true }),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}
