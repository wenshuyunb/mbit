/**
 * AdminAuditLogService — 管理端审计日志查询（契约 §3.14.9.3）
 *
 * ## 这是一张「派生视图」，不是三张表的直读
 *
 * `admin_audit_logs` 只存 `(resourceType, action枚举, success, errorCode, …)`，
 * 而契约要返回 `action`（权限点）/ `actionLabel` / `severity` / `targetType` 这些
 * **表里没有的字段**。因此本服务做三件事：
 *   ① **展示**：逐行反推派生字段（唯一真相来源是 `admin-audit-log.constants.ts`）；
 *   ② **过滤**：把契约的派生维度（`action` 权限点、`severity`、`targetType`）**翻译**
 *      成 SQL 能表达的条件（`(action, resourceType)` 的 OR 组合），否则过滤会"看起来生效、
 *      实则无效"；
 *   ③ **统计**：`summary` 的每个数字都必须是 `count` / `groupBy` 得来的，不把整表拉进内存。
 *
 * ## 固定 11 条 SQL，无 N+1
 *
 * 主查询 2 条（`count` + `findMany`）+ 摘要 7 条（4 个 `count` + 2 个 `groupBy` +
 * 1 个 7 天窗口 `findMany`）+ 操作人补齐 2 条（`adminUser` / `adminUserRole` 各一次 `in` 查询）。
 * 一页最多 100 行，逐行补操作人信息会变成 200 次往返 —— 后台列表页尤其容易这样被拖垮。
 *
 * ## 只读接口不写审计
 *
 * `AdminAuditAction` 枚举里**没有 `READ`**，也没有「读取审计」对应的动作语义；
 * 硬套 `EXPORT` / `UPDATE` 去记一条"某人看过审计页"等于往合规表里写伪造数据
 * （契约业务规则 1：审计仅追加、不可篡改）。若日后确实要记，应新增枚举成员 + 迁移，
 * 而不是在这里将就。
 */

import { Injectable } from '@nestjs/common';
import type { AdminAuditAction, Prisma } from '@prisma/client';

import { buildPaginated } from '../../../common/dto/api-response.dto';
import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  AUDIT_MAX_RANGE_DAYS,
  AUDIT_MAX_RANGE_MS,
  AUDIT_SORT_FIELDS,
  AUDIT_SUMMARY_TOP_N,
  AUDIT_TREND_DAYS,
  DAY_MS,
  DENIED_ERROR_CODE,
  RETENTION_NOTICE,
  TARGET_TYPE_RESOURCE_TYPES,
  UUID_PATTERN,
  displayTargetType,
  parseAuditActionName,
  permissionFilterPairs,
  resolveAuditAction,
  resolveAuditResult,
  resourceTypeAliasesOf,
  severityFilterPairs,
  startOfUtcDay,
  toUtcDateKey,
  type AuditFilterPair,
  type AuditResult,
  type AuditSeverity,
  type AuditSortOrder,
} from './admin-audit-log.constants';
import type { AdminAuditLogQueryDto } from './dto/admin-audit-log-query.dto';
import type {
  AdminAuditLogItemDto,
  AdminAuditLogListDto,
  AuditLogActionCountDto,
  AuditLogOperatorCountDto,
  AuditLogSummaryDto,
  AuditLogTrendPointDto,
} from './dto/admin-audit-log-response.dto';

/** 本页要展示的列（显式列出：`select` 全字段会把不该下发的数据也读进内存） */
const AUDIT_LOG_SELECT = {
  id: true,
  adminUserId: true,
  adminUsername: true,
  action: true,
  resourceType: true,
  resourceId: true,
  beforeData: true,
  afterData: true,
  diffSummary: true,
  reason: true,
  ip: true,
  userAgent: true,
  requestId: true,
  success: true,
  errorCode: true,
  latencyMs: true,
  createdAt: true,
} satisfies Prisma.AdminAuditLogSelect;

/** 一行审计记录（由上面的 select 推导，字段增减不会漏改） */
type AuditLogRow = Prisma.AdminAuditLogGetPayload<{ select: typeof AUDIT_LOG_SELECT }>;

/** 操作人展示信息（批量补齐用） */
interface OperatorProfile {
  readonly displayName: string;
  readonly username: string;
  readonly roles: readonly string[];
}

/** 已解析的时间范围 */
interface ResolvedRange {
  readonly start: Date;
  readonly end: Date;
}

/** `groupBy(['action', 'resourceType'])` 的一行 */
interface ActionGroupRow {
  readonly action: AdminAuditAction;
  readonly resourceType: string;
  readonly _count: { readonly _all: number };
}

/** `groupBy(['adminUserId'])` 的一行 */
interface OperatorGroupRow {
  readonly adminUserId: string | null;
  readonly _count: { readonly _all: number };
}

/** 管理员已被删除（或按 ID 查不到）时 `byOperator` 的展示名兜底，与 `admin-role.service.ts` 口径一致 */
const UNKNOWN_OPERATOR_NAME = '(unknown)';

/**
 * 两个条件相 AND
 *
 * Prisma 的 `AND` 可以嵌套条件对象（不必先手工合并），因此这里只做包装 —— 刻意不在
 * `where` 顶层平铺 `OR`：`action` / `keyword` 各自都需要 `OR`，平铺会**后者覆盖前者**，
 * 表现为「加了关键词过滤就丢掉了动作过滤」这类极难发现的缺陷。
 */
const andWhere = (
  base: Prisma.AdminAuditLogWhereInput,
  extra: Prisma.AdminAuditLogWhereInput,
): Prisma.AdminAuditLogWhereInput => ({ AND: [base, extra] });

/** 候选对 → OR 条件列表 */
const pairConditions = (pairs: readonly AuditFilterPair[]): Prisma.AdminAuditLogWhereInput[] =>
  pairs.map((pair) => ({ action: pair.action, resourceType: { in: [...pair.resourceTypes] } }));

/**
 * UUID 形态校验（`operatorAdminId` / `targetId`）
 *
 * 必须校验：两者最终都落到 `@db.Uuid` 列上，非 UUID 串会让 PostgreSQL 抛
 * `invalid input syntax for type uuid`（表现为 500），而不是「查不到」。
 * 不校验**版本号**：Prisma 的 `@default(uuid(7))` 生成 v7，而 class-validator 的
 * `isUUID` 只认 v1–v5，用它会把合法主键全部拒掉。
 */
const assertUuid = (value: string, field: string): string => {
  const trimmed = value.trim();

  if (!UUID_PATTERN.test(trimmed)) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `${field} 必须是合法的 UUID`);
  }

  return trimmed;
};

/**
 * `result` → where 条件
 *
 * 表里没有 `result` 列，只有 `success` + `errorCode`：`DENIED`（越权被拒）靠
 * 错误码 `20009` 识别（契约业务规则 3），其余失败一律 `FAILED`。
 */
const auditResultCondition = (result: AuditResult): Prisma.AdminAuditLogWhereInput => {
  if (result === 'SUCCESS') return { success: true };

  if (result === 'DENIED') return { success: false, errorCode: DENIED_ERROR_CODE };

  /**
   * `FAILED`：失败但**不是**越权。
   * ⚠ 不能简写成 `{ errorCode: { not: '20009' } }` —— Prisma 对**可空列**的 `not`
   * 不会把 `NULL` 行算进来（SQL 三值逻辑），而失败的审计行 `error_code` 完全可能是
   * `NULL`（写入方只填了 `success: false`）。必须显式把 `null` 并进来。
   */
  return { success: false, OR: [{ errorCode: null }, { errorCode: { not: DENIED_ERROR_CODE } }] };
};

/**
 * `severity` → where 条件
 *
 * `CRITICAL` / `SENSITIVE` 由映射表展开成 `OR`；`NORMAL` 是**补集**，
 * 用 `NOT (CRITICAL OR SENSITIVE)` 表达。二者必须来自同一张表，否则会出现
 * 「按 NORMAL 过滤能查到、按 CRITICAL 过滤也能查到」的重叠，或三项之和 ≠ totalLogs。
 */
const auditSeverityCondition = (severity: AuditSeverity): Prisma.AdminAuditLogWhereInput => {
  if (severity === 'CRITICAL') return { OR: pairConditions(severityFilterPairs('CRITICAL')) };
  if (severity === 'SENSITIVE') return { OR: pairConditions(severityFilterPairs('SENSITIVE')) };

  return {
    NOT: {
      OR: [...pairConditions(severityFilterPairs('CRITICAL')), ...pairConditions(severityFilterPairs('SENSITIVE'))],
    },
  };
};

/**
 * `action` → where 条件列表
 *
 * 契约的 `action` 是**权限点**（如 `payment:order:refund`），也可能是裸动作名。
 * 表里没有权限点列，只能反推：
 *   ① 含 `:` → 按权限点展开成 `(action, resourceType)` 候选对；
 *   ② 裸动作名（`refund` / `REFUND`）→ 直接按动作枚举过滤（不限资源类型）；
 *   ③ 都反推不出来 → 当作 `resourceType` 精确匹配（并展开别名，保证"只多不少"）。
 * 第 ③ 种是刻意的宽容：宁可在界面上多给几条让人自己判断，也不要因为一个陌生取值
 * 返回空列表（用户会以为"这段时间没有这条日志"，从而误判合规状态）。
 */
const auditActionConditions = (tokens: readonly string[]): Prisma.AdminAuditLogWhereInput[] => {
  const conditions: Prisma.AdminAuditLogWhereInput[] = [];

  for (const raw of tokens) {
    const token = raw.trim();
    if (token.length === 0) continue;

    if (token.includes(':')) {
      const pairs = permissionFilterPairs(token);
      if (pairs.length > 0) {
        conditions.push(...pairConditions(pairs));
        continue;
      }
    } else {
      const action = parseAuditActionName(token);
      if (action !== null) {
        conditions.push({ action });
        continue;
      }
    }

    conditions.push({ resourceType: { in: [...resourceTypeAliasesOf(token)] } });
  }

  return conditions;
};

/**
 * `keyword` → where 条件列表
 *
 * 契约说按 `changeNote` / `action` 搜索。`changeNote` 由 `reason ?? diff_summary` 派生，
 * 两列都能做包含匹配；但 `action` 是 **PostgreSQL 枚举列**，Prisma 的枚举过滤只有
 * `equals` / `in` / `notIn`（没有 `contains`），而且契约的 `action` 是权限点（派生值，
 * 库里根本不存在该字符串），所以「在动作上做模糊搜索」在 SQL 层无法完成。
 * 折中：关键词恰好等于某个权限点或动作名时按该动作过滤，否则只搜文本列。
 * 不采用「拉全表再内存过滤」：审计表是长期增长的表，那样做等于把库拖垮。
 */
const keywordConditions = (keyword: string): Prisma.AdminAuditLogWhereInput[] => {
  const conditions: Prisma.AdminAuditLogWhereInput[] = [
    { diffSummary: { contains: keyword, mode: 'insensitive' } },
    { reason: { contains: keyword, mode: 'insensitive' } },
  ];

  const pairs = permissionFilterPairs(keyword);
  if (pairs.length > 0) {
    conditions.push(...pairConditions(pairs));
    return conditions;
  }

  const action = parseAuditActionName(keyword);
  if (action !== null) conditions.push({ action });

  return conditions;
};

/** 趋势窗口条件（`endTime` 所在 UTC 日往前 7 天，右端取次日零点避免依赖毫秒精度） */
const trendWindowCondition = (range: ResolvedRange): Prisma.AdminAuditLogWhereInput => {
  const windowStart = new Date(startOfUtcDay(range.end).getTime() - (AUDIT_TREND_DAYS - 1) * DAY_MS);

  return { createdAt: { gte: windowStart, lt: new Date(startOfUtcDay(range.end).getTime() + DAY_MS) } };
};

@Injectable()
export class AdminAuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查询审计日志（契约 §3.14.9.3）
   *
   * @param query 已由全局 `ValidationPipe` 校验过的查询参数；服务层再校验一遍，
   *   因为「非法 ISO / 范围超 90 天 / 排序字段越界」这类规则必须在**没有 HTTP 层**
   *   的调用路径上也成立（单测与内部调用直接 new 服务时不受管道保护）
   */
  async list(query: AdminAuditLogQueryDto): Promise<AdminAuditLogListDto> {
    const range = this.resolveTimeRange(query);
    const where = this.buildWhere(query, range);
    const order = this.resolveOrder(query);
    const { page, pageSize } = this.resolvePagination(query);

    const [total, rows] = await Promise.all([
      this.prisma.adminAuditLog.count({ where }),
      this.prisma.adminAuditLog.findMany({
        where,
        // 排序白名单只有 `createdAt`，且 `@@index([createdAt(sort: Desc)])` 正好支持它
        orderBy: { createdAt: order },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: AUDIT_LOG_SELECT,
      }),
    ]);

    const [operators, summary] = await Promise.all([
      this.loadOperators(rows.map((row) => row.adminUserId)),
      this.loadSummary(where, total, range),
    ]);

    return {
      ...buildPaginated(
        rows.map((row) => this.toItem(row, operators)),
        total,
        page,
        pageSize,
      ),
      summary,
      retentionNotice: RETENTION_NOTICE,
    };
  }

  // ==========================================================================
  // 参数校验
  // ==========================================================================

  /** 解析并校验时间范围（必填、合法 ISO、正序、≤ 90 天） */
  private resolveTimeRange(query: AdminAuditLogQueryDto): ResolvedRange {
    const start = this.parseIso(query.startTime, 'startTime');
    const end = this.parseIso(query.endTime, 'endTime');

    /**
     * 逆序或零宽区间一律拒绝：契约要求「范围 ≤ 90 天」且两端必填，
     * 而 `endTime == startTime` 在实际使用中几乎都是「把两个参数写反了」，
     * 静默返回空列表会让人以为"这段时间没有操作记录"。
     */
    if (end.getTime() <= start.getTime()) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'endTime 必须晚于 startTime');
    }

    /**
     * ⚠ 契约错误表把「时间范围 > 90 天」写作 `10016`，但本仓库 `error-code.ts` 里
     * **没有 10016**，且本次改动不允许新增错误码 → 统一用 `PARAM_INVALID`（`10001`，400）。
     * 同理契约里的 `10001 / 10002 → 400`：仓库的 `10002` 是 `RESOURCE_NOT_FOUND`（404），
     * 语义不符，只用 `10001`。
     */
    if (end.getTime() - start.getTime() > AUDIT_MAX_RANGE_MS) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `查询时间范围不得超过 ${AUDIT_MAX_RANGE_DAYS} 天`);
    }

    return { start, end };
  }

  /** 解析 ISO 时间串；缺失或非法一律 `10001` */
  private parseIso(value: string | undefined, field: string): Date {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `${field} 为必填参数（ISO 8601 时间）`);
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `${field} 不是合法的 ISO 8601 时间`);
    }

    return parsed;
  }

  /**
   * 解析分页参数
   *
   * 契约默认 `1 / 20`、`pageSize ≤ 100`，DTO 层（`PaginationQueryDto`）已经校验过；
   * 这里再校验一次是为了挡住**绕过 HTTP 管道**的调用路径：`page = 0` 会算出负的 `skip`，
   * Prisma 会直接抛错（表现为 500），而「参数不合法」应当是 10001。
   * 刻意**不夹取**（不把 0 悄悄改成 1）：静默纠正会让调用方以为自己的参数被接受了。
   */
  private resolvePagination(query: AdminAuditLogQueryDto): { page: number; pageSize: number } {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    if (!Number.isInteger(page) || page < 1) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'page 必须是 ≥ 1 的整数');
    }

    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'pageSize 必须是 1–100 的整数');
    }

    return { page, pageSize };
  }

  /**
   * 解析排序方向
   *
   * `sortBy` 白名单只有 `createdAt`（契约 §3.14.9.3）。越界取值用 `10001` 而不是
   * `10004` —— 仓库的 `10004` 是 `METHOD_NOT_ALLOWED`（405），语义完全不同。
   */
  private resolveOrder(query: AdminAuditLogQueryDto): AuditSortOrder {
    const sortBy = query.sortBy;

    if (sortBy !== undefined && !AUDIT_SORT_FIELDS.includes(sortBy)) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'sortBy 仅支持 createdAt（不在白名单内）');
    }

    const order = query.order ?? 'desc';

    if (order !== 'asc' && order !== 'desc') {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'order 必须是 asc 或 desc');
    }

    return order;
  }

  // ==========================================================================
  // 过滤条件
  // ==========================================================================

  /** 组装 Prisma 过滤条件（时间范围 + 各可选维度） */
  private buildWhere(query: AdminAuditLogQueryDto, range: ResolvedRange): Prisma.AdminAuditLogWhereInput {
    // 每条维度独立成项，最后统一 AND：见 `andWhere` 的说明（顶层 OR 会互相覆盖）
    const conditions: Prisma.AdminAuditLogWhereInput[] = [
      // 契约的 `endTime` 是闭区间语义（示例给到 23:59:59.999Z），故用 `lte`
      { createdAt: { gte: range.start, lte: range.end } },
    ];

    if (query.operatorAdminId !== undefined) {
      conditions.push({ adminUserId: assertUuid(query.operatorAdminId, 'operatorAdminId') });
    }

    if (query.action !== undefined) {
      const actionConditions = auditActionConditions(query.action);
      if (actionConditions.length > 0) conditions.push({ OR: actionConditions });
    }

    if (query.targetType !== undefined) {
      // 表里没有 `targetType` 列：把契约枚举展开为 `resourceType` 别名集合，
      // 这样 `ADMIN` 能命中写入方实际使用的 `admin_user`
      conditions.push({ resourceType: { in: [...TARGET_TYPE_RESOURCE_TYPES[query.targetType]] } });
    }

    if (query.targetId !== undefined) {
      /**
       * ⚠ 契约把 `targetId` 定义为「≤ 64 字符」（示例里甚至有 `MBTI_REPORT` 这类字符串 ID），
       * 但表里对应的 `resource_id` 是 `@db.Uuid` 列，**只能**按 UUID 过滤。
       * 两种处理都不完美，这里选择「明确拒绝」而非「静默返回空列表」：
       * 后者会让调用方以为"没有这条记录"，前者至少能立刻发现契约与数据模型的冲突。
       */
      conditions.push({
        resourceId: assertUuid(
          query.targetId,
          'targetId（审计表 resource_id 为 uuid 列，字符串型目标 ID 无法按此过滤）',
        ),
      });
    }

    if (query.result !== undefined) {
      conditions.push(auditResultCondition(query.result));
    }

    if (query.severity !== undefined) {
      conditions.push(auditSeverityCondition(query.severity));
    }

    if (query.keyword !== undefined) {
      conditions.push({ OR: keywordConditions(query.keyword) });
    }

    return { AND: conditions };
  }

  // ==========================================================================
  // 摘要统计
  // ==========================================================================

  /**
   * 摘要统计（契约 §3.14.9.3 的 `summary`）
   *
   * 全部基于**当前过滤条件**：翻到第 2 页时摘要不应变化，改了筛选条件时摘要必须跟着变。
   * 因此 4 个计数与 2 个分组都复用同一个 `where`，而不是对当前页做 `length`
   * （那会让"共 186 条"在第二页变成"共 20 条"）。
   */
  private async loadSummary(
    where: Prisma.AdminAuditLogWhereInput,
    total: number,
    range: ResolvedRange,
  ): Promise<AuditLogSummaryDto> {
    const [criticalCount, sensitiveCount, failedCount, deniedCount, actionGroups, operatorGroups, trendRows] =
      await Promise.all([
        this.prisma.adminAuditLog.count({ where: andWhere(where, auditSeverityCondition('CRITICAL')) }),
        this.prisma.adminAuditLog.count({ where: andWhere(where, auditSeverityCondition('SENSITIVE')) }),
        this.prisma.adminAuditLog.count({ where: andWhere(where, auditResultCondition('FAILED')) }),
        this.prisma.adminAuditLog.count({ where: andWhere(where, auditResultCondition('DENIED')) }),
        this.prisma.adminAuditLog.groupBy({
          by: ['action', 'resourceType'],
          where,
          _count: { _all: true },
        }),
        this.prisma.adminAuditLog.groupBy({
          by: ['adminUserId'],
          // 登录失败且账号不存在时 `admin_user_id` 为 NULL，无法归属到具体管理员，
          // 不纳入 `byOperator`（列表里仍然显示这些记录，只是不进 Top 榜）
          where: andWhere(where, { adminUserId: { not: null } }),
          _count: { _all: true },
        }),
        this.prisma.adminAuditLog.findMany({
          where: andWhere(where, trendWindowCondition(range)),
          // 只取分桶必需的 3 列
          select: { createdAt: true, action: true, resourceType: true },
        }),
      ]);

    return {
      totalLogs: total,
      criticalCount,
      sensitiveCount,
      /**
       * `NORMAL` = 总数 − CRITICAL − SENSITIVE（补集）。
       * 不再单独发一次 `NOT(...)` 的 count：两个数字已经在同一个 `where` 下算过，
       * 减法能保证「三项之和恒等于 totalLogs」（契约示例 12 + 48 + 126 = 186 也是这个口径），
       * 而三处独立查询在并发写入时可能因数据变化而互相对不上。
       */
      normalCount: Math.max(0, total - criticalCount - sensitiveCount),
      failedCount,
      deniedCount,
      byAction: this.aggregateByAction(actionGroups),
      byOperator: await this.aggregateByOperator(operatorGroups),
      weeklyTrend: this.buildWeeklyTrend(trendRows, range),
    };
  }

  /**
   * `byAction`：按**权限点**聚合，取 Top 10
   *
   * 表里只有 `(action 枚举, resourceType)`，契约要的是权限点，因此必须先把
   * `groupBy` 的结果在内存里按权限点合并（例如 `CONFIG_CHANGE` 与 `UPDATE` 都归到
   * `system:config:write`）。
   * 刻意**不在 SQL 里 `take: 10`**：合并前有 10 行以上时先截断会漏掉合并后的头部项
   * （两组合并后可能跃居第一）。(action, resourceType) 的基数很小（动作 16 个 ×
   * 有限的资源类型），全量分组后内存排序代价可忽略。
   */
  private aggregateByAction(groups: readonly ActionGroupRow[]): AuditLogActionCountDto[] {
    const counters = new Map<string, number>();

    for (const group of groups) {
      const { permission } = resolveAuditAction(group.resourceType, group.action);
      counters.set(permission, (counters.get(permission) ?? 0) + group._count._all);
    }

    return (
      [...counters.entries()]
        .map(([action, count]) => ({ action, count }))
        // 并列时按权限点字典序：`orderBy + take` 让数据库决定并列顺序时，
        // 同一份数据两次请求可能给出不同的 Top 10（界面上看起来像"数据在变"）
        .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action))
        .slice(0, AUDIT_SUMMARY_TOP_N)
    );
  }

  /** `byOperator`：按管理员聚合，取 Top 10，并批量补齐展示名 */
  private async aggregateByOperator(groups: readonly OperatorGroupRow[]): Promise<AuditLogOperatorCountDto[]> {
    const ranked = groups
      // `adminUserId` 非空由查询条件保证，这里再收窄一次类型（同时挡住数据库返回的意外 NULL）
      .filter((group): group is OperatorGroupRow & { adminUserId: string } => group.adminUserId !== null)
      .sort((left, right) => right._count._all - left._count._all || left.adminUserId.localeCompare(right.adminUserId))
      .slice(0, AUDIT_SUMMARY_TOP_N);

    const operators = await this.loadOperators(ranked.map((group) => group.adminUserId));

    return ranked.map((group) => ({
      adminId: group.adminUserId,
      // 管理员已软删/不存在时没有可用的展示名（审计行里的 `admin_username` 不在
      // 本次分组结果中），沿用 `admin-role.service.ts` 的 `(unknown)` 兜底口径
      displayName: operators.get(group.adminUserId)?.displayName ?? UNKNOWN_OPERATOR_NAME,
      count: group._count._all,
    }));
  }

  /**
   * `weeklyTrend`：`endTime` 所在 UTC 日往前 7 天，逐日统计
   *
   * 实现取舍：用**一次 `findMany` 取 7 天窗口内的 `(createdAt, action, resourceType)`
   * 后在内存分桶**，而不是对 7 天各发一次 `groupBy`：
   *   · 后者是 7 条 SQL，且「按 UTC 日期分桶」需要 `date_trunc` 之类的原生 SQL
   *     （本仓库禁止 `*Unsafe` 原生查询，参数化模板标签又拿不到类型安全的聚合结果）；
   *   · 窗口内只取 3 列，且管理端操作是人工触发（量级远低于用户端流量），
   *     7 天的行数完全可接受。
   * 若日后审计量级上来，应改为「按天预聚合物化视图 + 一次查询」，而不是把本函数改成 N 条 SQL。
   */
  private buildWeeklyTrend(
    rows: readonly Pick<AuditLogRow, 'createdAt' | 'action' | 'resourceType'>[],
    range: ResolvedRange,
  ): AuditLogTrendPointDto[] {
    const windowStart = new Date(startOfUtcDay(range.end).getTime() - (AUDIT_TREND_DAYS - 1) * DAY_MS);
    const buckets = new Map<string, AuditLogTrendPointDto>();

    for (let offset = 0; offset < AUDIT_TREND_DAYS; offset += 1) {
      const date = toUtcDateKey(new Date(windowStart.getTime() + offset * DAY_MS));
      // 先铺满 7 天：没有审计的日子必须出现（缺日会让前端曲线断档，看起来像数据丢失）
      buckets.set(date, { date, count: 0, criticalCount: 0 });
    }

    for (const row of rows) {
      const bucket = buckets.get(toUtcDateKey(row.createdAt));
      // 查询窗口与桶窗口相同，理论上取不到窗口外的行；防御性跳过而不是抛错
      if (bucket === undefined) continue;

      bucket.count += 1;

      if (resolveAuditAction(row.resourceType, row.action).severity === 'CRITICAL') {
        bucket.criticalCount += 1;
      }
    }

    return [...buckets.values()];
  }

  // ==========================================================================
  // 操作人 / 行映射
  // ==========================================================================

  /**
   * 批量查询操作人的展示信息（展示名 + 用户名 + 角色码）
   *
   * 一页最多 100 行、操作人通常只有几个，因此用两个 `in` 查询一次取全；
   * 逐行调用 `AdminRbacService.resolve()` 是最容易犯的错 —— 它按**单个管理员**
   * 查询角色与权限，50 个操作人就是 100 次往返（N+1）。这里只借用它的**语义**：
   *   · 超管直接给 `['SUPER_ADMIN']`（超管权限来自 `*`，不依赖角色表配置）；
   *   · 已软删的角色不产生任何角色码；
   *   · 临时授予（`expiresAt`）过期即失效。
   */
  private async loadOperators(adminUserIds: readonly (string | null)[]): Promise<Map<string, OperatorProfile>> {
    const ids = [...new Set(adminUserIds.filter((id): id is string => id !== null))];

    if (ids.length === 0) return new Map();

    const [admins, grants] = await Promise.all([
      // `deletedAt: null`：软删的管理员不再算"存在"，由调用方回退到审计行冗余的用户名
      this.prisma.adminUser.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, username: true, nickname: true, realName: true, isSuperAdmin: true },
      }),
      this.prisma.adminUserRole.findMany({
        where: {
          adminUserId: { in: ids },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { adminUserId: true, role: { select: { code: true, deletedAt: true } } },
      }),
    ]);

    const rolesByAdmin = new Map<string, Set<string>>();

    for (const grant of grants) {
      if (grant.role.deletedAt !== null) continue;

      const codes = rolesByAdmin.get(grant.adminUserId) ?? new Set<string>();
      codes.add(grant.role.code);
      rolesByAdmin.set(grant.adminUserId, codes);
    }

    return new Map(
      admins.map((admin): [string, OperatorProfile] => [
        admin.id,
        {
          // 展示名口径与 `AdminAuthService.getProfile` 一致（nickname → realName → username）：
          // 同一个人在顶栏与审计页必须显示同一个名字
          displayName: admin.nickname ?? admin.realName ?? admin.username,
          username: admin.username,
          roles: admin.isSuperAdmin ? ['SUPER_ADMIN'] : [...(rolesByAdmin.get(admin.id) ?? [])].sort(),
        },
      ]),
    );
  }

  /** 审计行 → 契约响应字段（派生字段的唯一出口，避免列表与详情两处口径漂移） */
  private toItem(row: AuditLogRow, operators: ReadonlyMap<string, OperatorProfile>): AdminAuditLogItemDto {
    const resolved = resolveAuditAction(row.resourceType, row.action);
    const profile = row.adminUserId === null ? undefined : operators.get(row.adminUserId);

    return {
      auditLogId: row.id,
      action: resolved.permission,
      actionLabel: resolved.actionLabel,
      severity: resolved.severity,
      result: resolveAuditResult(row.success, row.errorCode),
      operator: {
        adminId: row.adminUserId,
        // 管理员被删除（或登录时账号不存在）时回退到审计行**冗余存储**的 `admin_username` ——
        // 冗余存用户名正是为了让账号删除后审计记录仍然可追责
        displayName: profile?.displayName ?? row.adminUsername,
        username: profile?.username ?? row.adminUsername,
        roles: profile === undefined ? [] : [...profile.roles],
      },
      targetType: displayTargetType(row.resourceType),
      targetId: row.resourceId,
      targetSummary: row.diffSummary,
      before: row.beforeData ?? null,
      after: row.afterData ?? null,
      // 表里没有 `changeNote` 列：`reason` 是管理员手填的操作原因，比机器生成的
      // `diffSummary` 更接近契约中 `changeNote` 的语义，故优先取它
      changeNote: row.reason ?? row.diffSummary,
      // `metadata` 只在有真实来源时给出。契约示例里的 `ticketId` / `refundNo` /
      // `confirmPasswordVerified` 在表里没有任何列承载，编造（尤其是恒为 true 的
      // `confirmPasswordVerified`）等于让审计数据说谎
      metadata: row.latencyMs === null ? null : { latencyMs: row.latencyMs },
      ip: row.ip,
      userAgent: row.userAgent,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
