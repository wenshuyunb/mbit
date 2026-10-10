/**
 * 权益（Entitlement）纯逻辑（无 I/O、可 100% 单测）
 *
 * 契约 §2.4/§3.5；架构 §13（付费与权益）。
 *
 * ## `resourceKey` 的编码约定
 *
 * `entitlements` 表用 `@@unique([userId, type, resourceKey])` 做幂等，
 * `resourceKey` 是**通用资源标识**。这里约定两种形态：
 *
 * ```
 * report:{reportId}                 整份报告解锁（单份购买）
 * report:{reportId}#{sectionKey}    单段解锁（按段购买）
 * ```
 *
 * 用 `#` 而不是 `:` 分隔段落键：`reportId` 是 UUID（只含十六进制与连字符），
 * 不会含 `#`；而 `:` 在日志与 Redis 键里到处都是，混用会让"到底是几段"
 * 变得需要数分隔符。约定写在这里而不是散落在 Service 里 ——
 * 编码与解码必须成对演进，分开放置迟早出现"写进去的格式读不出来"。
 */

import type { EntitlementStatus, EntitlementType } from '@prisma/client';

/** `resourceKey` 前缀（整份报告） */
const REPORT_RESOURCE_PREFIX = 'report:';

/** 段落分隔符 */
const SECTION_SEPARATOR = '#';

/** 构造「整份报告」的资源键 */
export const reportResourceKey = (reportId: string): string => `${REPORT_RESOURCE_PREFIX}${reportId}`;

/** 构造「单段报告」的资源键 */
export const reportSectionResourceKey = (reportId: string, sectionKey: string): string =>
  `${REPORT_RESOURCE_PREFIX}${reportId}${SECTION_SEPARATOR}${sectionKey}`;

/** 解析结果：`sectionKey` 为 null 表示整份报告 */
export interface ParsedReportResourceKey {
  readonly reportId: string;
  readonly sectionKey: string | null;
}

/**
 * 解析报告资源键
 *
 * 无法识别时返回 `null` 而不是抛错：这个方法会在批量解析权益时被调用成百次，
 * 抛错会让一条脏数据（例如历史遗留的旧格式）把整次查询打挂。调用方按
 * "识别不了就跳过"处理即可 —— 跳过最多是少解锁一段，而不是整页 500。
 */
export const parseReportResourceKey = (resourceKey: string | null): ParsedReportResourceKey | null => {
  if (resourceKey === null || !resourceKey.startsWith(REPORT_RESOURCE_PREFIX)) return null;

  const rest = resourceKey.slice(REPORT_RESOURCE_PREFIX.length);
  const separatorIndex = rest.indexOf(SECTION_SEPARATOR);

  if (separatorIndex === -1) {
    return rest.length === 0 ? null : { reportId: rest, sectionKey: null };
  }

  const reportId = rest.slice(0, separatorIndex);
  const sectionKey = rest.slice(separatorIndex + 1);
  if (reportId.length === 0 || sectionKey.length === 0) return null;

  return { reportId, sectionKey };
};

/** 权益有效性判定的输入（只声明用到的字段） */
export interface EntitlementLike {
  readonly type: EntitlementType;
  readonly status: EntitlementStatus;
  readonly resourceKey: string | null;
  readonly reportId: string | null;
  readonly expireAt: Date | null;
  readonly remainingQuota: number | null;
}

/**
 * 权益是否当前有效
 *
 * 三条规则各自都有真实的踩坑点：
 *
 * ① **`CONSUMED` 仍然算已解锁**（见 Prisma 枚举注释）。一次性权益在"用掉"之后
 *    状态会变成 `CONSUMED`，但用户买的是**内容访问权**，不是"一次查看"——
 *    若把 `CONSUMED` 判为无效，用户刷新一次报告就又被付费墙挡住。
 *    `REVOKED`（退款）才是真正要收回的。
 *
 * ② **`expireAt` 为 null 表示永不过期**，不能当成"已过期"。
 *
 * ③ **配额型权益（`AI_CREDITS` / `PDF_EXPORT`）额外看 `remainingQuota`**：
 *    次数用完即失效。`remainingQuota` 为 null 时按"不限次"处理（如会员期内无限次）。
 */
export const isEntitlementActive = (entitlement: EntitlementLike, now: Date): boolean => {
  // 退款撤销：立刻失效，与是否在有效期内无关
  if (entitlement.status === 'REVOKED') return false;
  if (entitlement.status === 'EXPIRED') return false;

  // 时间窗
  if (entitlement.expireAt !== null && entitlement.expireAt.getTime() <= now.getTime()) return false;

  // 计数型配额的递减只对这两种类型有意义；报告解锁与会员不看配额
  if (entitlement.type === 'AI_CREDITS' || entitlement.type === 'PDF_EXPORT') {
    if (entitlement.remainingQuota !== null && entitlement.remainingQuota <= 0) return false;
  }

  return true;
};

/** 报告解锁判定结果 */
export interface ReportUnlockState {
  /** 整份报告已解锁（会员或单份购买） */
  readonly allUnlocked: boolean;
  /** 已单独解锁的段落键 */
  readonly unlockedSectionKeys: ReadonlySet<string>;
  /** 解锁来源（用于前端展示"你为什么能看"与后台排查） */
  readonly source: ReportUnlockSource;
}

/** 解锁来源 */
export type ReportUnlockSource = 'MEMBERSHIP' | 'REPORT_PURCHASE' | 'SECTION_PURCHASE' | 'NONE';

/** 未解锁时的空状态（供 `resolveUnlockState` 的兜底与测试复用） */
export const NO_UNLOCK: ReportUnlockState = {
  allUnlocked: false,
  unlockedSectionKeys: new Set<string>(),
  source: 'NONE',
};

/**
 * 解析某份报告的解锁状态
 *
 * **会员优先返回 `MEMBERSHIP`**：会员期内所有报告都不该再显示付费墙。
 * 若先判单份购买，会员看到的 `source` 会是 `REPORT_PURCHASE`，
 * 前端就可能展示"你已购买本报告"而不是"会员权益已覆盖"，
 * 让用户以为自己付了两次钱。
 *
 * 归属校验由调用方完成（传进来的权益必须是该用户的）；这里只做纯判定。
 */
export const resolveReportUnlock = (
  entitlements: readonly EntitlementLike[],
  reportId: string,
  now: Date,
): ReportUnlockState => {
  const valid = entitlements.filter((entitlement) => isEntitlementActive(entitlement, now));

  if (valid.some((entitlement) => entitlement.type === 'MEMBERSHIP_ACTIVE')) {
    return { allUnlocked: true, unlockedSectionKeys: new Set<string>(), source: 'MEMBERSHIP' };
  }

  // 整份解锁：要么 `resourceKey` 是 `report:{id}`，要么 `reportId` 直接指向本报告
  // （两种写法历史上都存在，且 `reportId` 是结构化外键、`resourceKey` 是通用键，
  //  两个来源都要认，否则会出现"权益在库里但用户看不到"）
  const wholeReport = valid.some((entitlement) => {
    if (entitlement.type !== 'REPORT_UNLOCK') return false;
    if (entitlement.reportId === reportId) return true;

    const parsed = parseReportResourceKey(entitlement.resourceKey);

    return parsed !== null && parsed.reportId === reportId && parsed.sectionKey === null;
  });

  if (wholeReport) {
    return { allUnlocked: true, unlockedSectionKeys: new Set<string>(), source: 'REPORT_PURCHASE' };
  }

  const sectionKeys = new Set<string>();
  for (const entitlement of valid) {
    if (entitlement.type !== 'REPORT_UNLOCK') continue;

    const parsed = parseReportResourceKey(entitlement.resourceKey);
    if (parsed !== null && parsed.reportId === reportId && parsed.sectionKey !== null) {
      sectionKeys.add(parsed.sectionKey);
    }
  }

  if (sectionKeys.size > 0) {
    return { allUnlocked: false, unlockedSectionKeys: sectionKeys, source: 'SECTION_PURCHASE' };
  }

  return NO_UNLOCK;
};

/** 判断某份报告是否（整体或部分）解锁 —— 列表页的 `isUnlocked` 用它 */
export const isReportUnlocked = (entitlements: readonly EntitlementLike[], reportId: string, now: Date): boolean => {
  const state = resolveReportUnlock(entitlements, reportId, now);

  return state.allUnlocked || state.unlockedSectionKeys.size > 0;
};

/**
 * 会员是否有效
 *
 * `MEMBERSHIP_ACTIVE` 是时间窗权益（架构 §13.2）：`expireAt` 必须存在，
 * 否则等于永久会员 —— 而"永久"从来不是商品定义里的一档。
 * 缺 `expireAt` 时按无效处理（宁可少给，也不能因为脏数据白送终身会员）。
 */
export const hasActiveMembership = (entitlements: readonly EntitlementLike[], now: Date): boolean =>
  entitlements.some(
    (entitlement) =>
      entitlement.type === 'MEMBERSHIP_ACTIVE' &&
      entitlement.expireAt !== null &&
      isEntitlementActive(entitlement, now),
  );

/** 会员到期时间（多份会员权益时取最晚的一份） */
export const membershipExpireAt = (entitlements: readonly EntitlementLike[], now: Date): Date | null => {
  const active = entitlements.filter(
    (entitlement) =>
      entitlement.type === 'MEMBERSHIP_ACTIVE' &&
      entitlement.expireAt !== null &&
      isEntitlementActive(entitlement, now),
  );

  if (active.length === 0) return null;

  return active.reduce<Date>((latest, entitlement) => {
    const expireAt = entitlement.expireAt as Date;

    return expireAt.getTime() > latest.getTime() ? expireAt : latest;
  }, active[0]?.expireAt as Date);
};
