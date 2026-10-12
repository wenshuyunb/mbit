/**
 * 报告生成的可变选项（当前只有「重新生成」用得上）
 *
 * ## 为什么需要有这么一个 Redis 小存储
 *
 * `regenerate` 契约允许用户换语气（`tone`）与换侧重（`focus`），这两个值最终要
 * 注入 Prompt 变量（模板里写着 `内容侧重：{{focus}}` / `语气偏好：{{tone}}`）。
 * 但生成是由**队列 Worker** 触发的，它只拿得到 `reportId`，而 `ai_reports` 表
 * 没有承载这两个值的列（`schema.prisma` 本轮冻结）。
 *
 * 于是把它们放在"生成任务的可变选项"里：写入方是 HTTP 进程（regenerate 接口），
 * 读取方是 Worker（`ReportGenerationService`）。这与实时进度通道同一思路 ——
 * **任务级、短生命周期、可丢**（丢了最坏情况是这次生成按默认语气走，不会损坏数据）。
 *
 * TTL 取 1 小时：足够覆盖排队 + 生成 + 一次重试，又不会在报告早已生成完的两天后
 * 被下一次（无关的）生成误读。
 */

import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../../../infra/redis/redis.service';

/** 选项键前缀 */
const OPTIONS_PREFIX = 'report:gen:options';

/** 选项保留时长（秒） */
const OPTIONS_TTL_SECONDS = 60 * 60;

/** 生成选项（全部可选：缺省即"按模板默认"） */
export interface ReportGenerationOptions {
  /** 语气短语（已由 `describeTone` 转成中文） */
  readonly tone?: string;
  /** 侧重短语（已由 `describeFocus` 转成中文） */
  readonly focus?: string;
}

@Injectable()
export class ReportGenerationOptionsService {
  private readonly logger = new Logger(ReportGenerationOptionsService.name);

  constructor(private readonly redis: RedisService) {}

  async save(reportId: string, options: ReportGenerationOptions): Promise<void> {
    await this.redis.setJson(this.keyOf(reportId), options, OPTIONS_TTL_SECONDS);
  }

  async read(reportId: string): Promise<ReportGenerationOptions | null> {
    try {
      return await this.redis.getJson<ReportGenerationOptions>(this.keyOf(reportId));
    } catch (error) {
      // 读不到就按默认语气生成：这比让整次生成失败要好得多
      this.logger.warn(`读取生成选项失败 reportId=${reportId}: ${(error as Error).message}`);
      return null;
    }
  }

  async clear(reportId: string): Promise<void> {
    try {
      await this.redis.del(this.keyOf(reportId));
    } catch (error) {
      this.logger.warn(`清理生成选项失败 reportId=${reportId}: ${(error as Error).message}`);
    }
  }

  private keyOf(reportId: string): string {
    return this.redis.key(OPTIONS_PREFIX, reportId);
  }
}
