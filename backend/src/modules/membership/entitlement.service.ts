/**
 * 权益服务（契约 §2.4/§3.5；架构 §13）
 *
 * 全部判定逻辑都在 `entitlement.util.ts`（纯函数、已单测）；本服务只负责**取数**。
 * 这样拆分的原因：权益判定错一次就是"用户没付钱却看到了付费内容"或
 * "付了钱却被挡住"，两类都是必须能 100% 回归的问题，而它们不该依赖数据库替身。
 */

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  NO_UNLOCK,
  hasActiveMembership,
  isReportUnlocked,
  membershipExpireAt,
  resolveReportUnlock,
  type EntitlementLike,
  type ReportUnlockState,
} from './entitlement.util';

/** 会员状态视图（前端据此展示"会员有效期至 …"） */
export interface MembershipView {
  readonly isMember: boolean;
  readonly expireAt: string | null;
  /** 距离到期天数（未开通为 null；已到期为 0） */
  readonly remainingDays: number | null;
}

/** 报告解锁上下文的字段（`ReportService` 侧只需要这些） */
export interface ReportUnlockStateWithMembership extends ReportUnlockState {
  readonly membership: MembershipView;
}

@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 读取用户的全部有效权益
   *
   * **一次查完再在内存里判定**，而不是按报告逐条查：报告列表一次最多 100 条，
   * 逐条查就是 100 次往返。单个用户的权益行数量很小（个位数到几十），
   * 全量取回的成本远低于 N+1。
   *
   * 过滤条件里只做粗筛（未删除、未撤销），精细的有效性判定留给纯函数 ——
   * 把"`expireAt` 是否过期"写进 SQL 会让同一条规则在 SQL 与 TS 里各有一份，
   * 而两处的边界（`<` 还是 `<=`）极易不一致。
   */
  async loadEntitlements(userId: string): Promise<readonly EntitlementLike[]> {
    const rows = await this.prisma.entitlement.findMany({
      where: { userId, deletedAt: null, status: { in: ['ACTIVE', 'CONSUMED'] } },
      select: {
        type: true,
        status: true,
        resourceKey: true,
        reportId: true,
        expireAt: true,
        remainingQuota: true,
      },
    });

    return rows;
  }

  /** 某份报告的解锁状态（详情接口用；同时带出会员状态供前端展示） */
  async resolveReportUnlock(userId: string, reportId: string): Promise<ReportUnlockStateWithMembership> {
    const entitlements = await this.loadEntitlements(userId);
    const now = new Date();

    return {
      ...resolveReportUnlock(entitlements, reportId, now),
      membership: this.toMembershipView(entitlements, now),
    };
  }

  /**
   * 报告列表的解锁上下文
   *
   * 列表只需要"逐条是否解锁"与汇总，不需要每条的 `source`，
   * 因此返回一个判定函数 + 会员状态，避免为 100 条报告各建一个对象。
   */
  async buildListUnlockContext(userId: string): Promise<{
    isUnlocked: (reportId: string) => boolean;
    countUnlocked: (reportIds: readonly string[]) => number;
    membership: MembershipView;
  }> {
    const entitlements = await this.loadEntitlements(userId);
    const now = new Date();
    const membership = this.toMembershipView(entitlements, now);

    return {
      isUnlocked: (reportId: string): boolean => membership.isMember || isReportUnlocked(entitlements, reportId, now),
      countUnlocked: (reportIds: readonly string[]): number =>
        membership.isMember
          ? reportIds.length
          : reportIds.filter((reportId) => isReportUnlocked(entitlements, reportId, now)).length,
      membership,
    };
  }

  /** 会员状态（`GET /membership` 用） */
  async getMembership(userId: string): Promise<MembershipView> {
    const entitlements = await this.loadEntitlements(userId);

    return this.toMembershipView(entitlements, new Date());
  }

  /** 解锁状态的兜底值（无法读到权益时使用，见下方说明） */
  static readonly fallbackUnlock: ReportUnlockState = NO_UNLOCK;

  private toMembershipView(entitlements: readonly EntitlementLike[], now: Date): MembershipView {
    if (!hasActiveMembership(entitlements, now)) {
      return { isMember: false, expireAt: null, remainingDays: null };
    }

    const expireAt = membershipExpireAt(entitlements, now);
    if (expireAt === null) {
      return { isMember: false, expireAt: null, remainingDays: null };
    }

    const remainingDays = Math.max(0, Math.ceil((expireAt.getTime() - now.getTime()) / 86_400_000));

    return { isMember: true, expireAt: expireAt.toISOString(), remainingDays };
  }
}
