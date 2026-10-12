/**
 * AdminAuditService — 管理端操作审计
 *
 * 契约 §3.14「核心契约」第 4 条：**所有写操作**都要写 `admin_audit_logs`
 * （谁、何时、对什么、`before/after` diff，架构 14.1）；登录成功与失败同样要记
 * （§3.14.1.1 业务规则 5，保留 1 年）。
 *
 * ## 审计写入绝不抛错
 *
 * 审计是**旁路**：它失败不应该让业务操作失败（用户点了「封禁」，因为审计表写不进去
 * 就返回 500，是更糟的结果）。因此这里吞掉异常并打 error 日志 —— 但也因此
 * **不能**用审计的成功与否判断业务是否执行。
 *
 * 需要强一致的场景（如退款）应在业务事务内直接写审计表，而不是依赖本服务。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { AdminAuditAction, Prisma } from '@prisma/client';
import { Prisma as PrismaNamespace } from '@prisma/client';

import { PrismaService } from '../../../infra/prisma/prisma.service';

/** 审计条目 */
export interface AdminAuditEntry {
  /** 管理员 ID；登录失败时可能为 null（账号不存在） */
  adminUserId?: string | null;
  /** 管理员用户名（**必填**：账号被删后仍要能追责，故冗余存储） */
  adminUsername: string;
  action: AdminAuditAction;
  /** 被操作的资源类型，如 `user` / `order` / `prompt` */
  resourceType: string;
  resourceId?: string | null;
  /** 被操作的用户（用于按用户追溯后台操作记录） */
  targetUserId?: string | null;
  beforeData?: Prisma.InputJsonValue | null;
  afterData?: Prisma.InputJsonValue | null;
  /** 人类可读的变更摘要（列表页直接展示，避免前端解析 JSON） */
  diffSummary?: string | null;
  /** 操作原因（敏感操作建议必填） */
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  success?: boolean;
  /** 失败时的错误码字符串（如 `'20012'`） */
  errorCode?: string | null;
  latencyMs?: number | null;
}

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 写入一条审计记录
   *
   * @returns 是否写入成功（调用方可记录指标，但**不应**据此改变业务结果）
   */
  async log(entry: AdminAuditEntry): Promise<boolean> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminUserId: entry.adminUserId ?? null,
          adminUsername: entry.adminUsername,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          targetUserId: entry.targetUserId ?? null,
          // JsonB 列：显式区分「没有值」与「JSON null」
          beforeData: this.toJson(entry.beforeData),
          afterData: this.toJson(entry.afterData),
          diffSummary: this.truncate(entry.diffSummary, 1024),
          reason: this.truncate(entry.reason, 256),
          ip: this.truncate(entry.ip, 64),
          userAgent: this.truncate(entry.userAgent, 256),
          requestId: this.truncate(entry.requestId, 64),
          success: entry.success ?? true,
          errorCode: this.truncate(entry.errorCode, 32),
          latencyMs: entry.latencyMs ?? null,
        },
      });

      return true;
    } catch (error) {
      // 审计失败不能影响业务结果，但必须留下痕迹以便运维发现审计链路故障
      this.logger.error(
        `写入管理端审计失败 action=${entry.action} resource=${entry.resourceType} admin=${entry.adminUsername}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * 生成变更摘要
   *
   * 只列出**真正发生变化**的字段，且每个值截断到 60 字符 ——
   * 审计列表是给人看的，整段 JSON 反而没人读。
   */
  buildDiffSummary(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string | null {
    if (!before || !after) return null;

    const changes: string[] = [];

    for (const key of Object.keys(after)) {
      const from = before[key];
      const to = after[key];

      if (this.sameValue(from, to)) continue;

      changes.push(`${key}: ${this.describe(from)} → ${this.describe(to)}`);
    }

    return changes.length > 0 ? changes.join('; ') : null;
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  /**
   * 未提供即为 `DbNull`（SQL NULL），而不是 JSON 的 `null`
   *
   * 参数类型刻意收窄为 `Prisma.InputJsonValue`：审计数据必须可序列化，
   * 用 `unknown` 会把这个约束推迟到运行时（写库时才因不可序列化而失败）。
   */
  private toJson(
    value: Prisma.InputJsonValue | null | undefined,
  ): Prisma.InputJsonValue | typeof PrismaNamespace.DbNull {
    if (value === undefined || value === null) return PrismaNamespace.DbNull;
    return value;
  }

  private truncate(value: string | null | undefined, max: number): string | null {
    if (value === null || value === undefined) return null;
    return value.length > max ? value.slice(0, max) : value;
  }

  private sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    // 对象/数组用 JSON 比较：审计场景下足够，且不引入深比较依赖
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /** 单个值的可读展示；超长截断，避免摘要被一个长文本撑爆 */
  private describe(value: unknown): string {
    if (value === null || value === undefined) return '空';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return this.ellipsis(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }

    if (typeof value === 'object') {
      try {
        return this.ellipsis(JSON.stringify(value));
      } catch {
        return '[不可序列化对象]';
      }
    }

    // symbol / function：审计里出现即属异常，不给它们编造展示形式
    return '[不支持的值类型]';
  }

  private ellipsis(text: string): string {
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  }
}
