/**
 * AdminUserService — 管理端「管理员账号」管理
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.9.4（列表）/ §3.14.9.5（新建）/ §3.14.9.6（重置密码）
 *
 * ## 这个模块本身就是攻击面
 *
 * 「能创建管理员」等价于「能给自己提权」，「能重置别人密码」等价于「能接管别人的账号」。
 * 因此三条护栏必须同时存在，缺一条整个模块都不安全：
 *
 *   1. **不允许创建 `SUPER_ADMIN`**（契约 §3.14.9.5 规则 3）——
 *      否则一个 `system:admin:write` 的账号可以一步拿到全权，授权模型就此失效；
 *   2. **不允许重置其他 `SUPER_ADMIN` 的密码**（契约 §3.14.9.6 规则 3）——
 *      否则同样是横向接管；重置**自己**是允许的（会撤销本人会话，属预期行为）；
 *   3. **角色码必须是数据库里真实存在的角色** ——
 *      否则可以构造任意角色码，一旦后续有代码按字符串前缀放行就会变成绕过。
 *
 * ## 数据模型与契约不一致之处（按 schema 落地，逐条在下方注明）
 *
 * | 契约字段 | 实际落地 |
 * | --- | --- |
 * | `displayName` | `admin_users.nickname`（缺失回退 `username`） |
 * | `loginCount30d` | 审计表 `LOGIN` + `success` 的近 30 天 `groupBy` 计数 |
 * | `operationStats7d` | 审计表近 7 天 `groupBy` 统计（`readActions` 口径见下） |
 * | `createdBy` | 该管理员 `CREATE` 审计的 `adminUsername`；查不到按 `SYSTEM_SEED` / `null` 归因 |
 * | `ipWhitelist` | 🚫 **无此列**：落到 `system_configs`（仅留痕，登录链路尚未强制执行） |
 * | `initialPassword.expiresInHours = 24` | 🚫 **无密码过期列**：该有效期目前未强制执行 |
 * | `auditLogId` | 恒为 `null`（`AdminAuditService.log` 只回传 `boolean`，本次不允许改它） |
 *
 * ## 统计查询失败不阻断列表
 *
 * `operationStats7d` / `loginCount30d` / `createdBy` 都来自审计表，属**附加信息**。
 * 审计表异常（或后续归档导致查询失败）时若直接 500，会让管理员连「有谁」都看不到，
 * 这与 `personality.service.ts`「配置读取失败用兜底文案」的取舍一致：
 * 降级为全 0 并打 warn 日志，先保证列表可读。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { AdminUserStatus, Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { buildPaginated } from '../../../common/dto/api-response.dto';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminTokenService } from '../auth/admin-token.service';
import { PasswordService } from '../auth/password.service';
import { ADMIN_ROLES, ALL_ADMIN_PERMISSIONS, PERMISSION_WILDCARD } from '../rbac/admin-permission.constants';
import { AdminRbacService } from '../rbac/admin-rbac.service';
import type {
  AdminCreateResultDto,
  AdminOperationStatsDto,
  AdminPasswordResetResultDto,
  AdminUserListDto,
  AdminUserListItemDto,
  AdminUserListQueryDto,
  CreateAdminUserDto,
  ResetAdminPasswordDto,
} from './dto/admin-user.dto';
import {
  emptyOperationStats,
  generateOneTimePassword,
  INITIAL_PASSWORD_NOTE,
  isAdminUserStatus,
  isCriticalAuditPair,
  isLoginAuditAction,
  isStrongAdminPassword,
  isUniqueConstraintViolation,
  isUuid,
  isWriteAuditAction,
  ONE_TIME_PASSWORD_EXPIRES_HOURS,
  parseCsvValues,
  RESET_PASSWORD_NOTE,
  type AdminUserStatusValue,
} from './admin-user.util';
// ============================================================================
// 常量
// ============================================================================

/** 审计资源类型（契约约定的取值；与 `admin-auth.service.ts` 的 `admin_user` 并存，见工具文件的口径说明） */
const RESOURCE_TYPE_ADMIN = 'ADMIN';

/** 创建者归因时也要认 `admin_user`：该值是认证链路对同一实体的另一种写法 */
const RESOURCE_TYPE_ADMIN_ALIAS = 'admin_user';

/** 超级管理员角色码（创建时禁止授予，见文件头护栏 1） */
const SUPER_ADMIN_ROLE_CODE = 'SUPER_ADMIN';

/** 无法归因到具体操作者的账号（种子导入 / 部署侧初始化） */
const SYSTEM_SEED_CREATOR = 'SYSTEM_SEED';

/** 新建管理员时的审计原因（契约请求体无 `reason` 字段，这里给出固定可读原因） */
const CREATE_AUDIT_REASON = '通过管理端接口新建管理员账号';

/** IP 白名单在 `system_configs` 里的分组与键前缀 */
const IP_WHITELIST_CONFIG_GROUP = 'SECURITY';
const ipWhitelistConfigKey = (adminId: string): string => `admin.ipWhitelist.${adminId}`;

/** 统计窗口 */
const OPERATION_STATS_WINDOW_DAYS = 7;
const LOGIN_STATS_WINDOW_DAYS = 30;

/** 会话撤销原因（写入日志，便于与登出/改密区分） */
const PASSWORD_RESET_REVOKE_REASON = 'admin_password_reset';

/**
 * 列表查询字段白名单
 *
 * 🚫 刻意**不**用 `findMany()` 全字段：`passwordHash` 一旦进入返回值，
 * 任何一次「顺手带上 ...row」都会把它写进响应（契约 §3.14.9.4 规则 1 明令禁止）。
 * 白名单让泄漏在类型层面就不可能发生。
 */
const ADMIN_USER_LIST_SELECT = {
  id: true,
  username: true,
  nickname: true,
  status: true,
  isSuperAdmin: true,
  mustChangePassword: true,
  passwordUpdatedAt: true,
  failedLoginCount: true,
  lockedUntil: true,
  lastLoginAt: true,
  lastLoginIp: true,
  createdAt: true,
} as const satisfies Prisma.AdminUserSelect;

/** 列表行的结构（与上面的 select 白名单一一对应） */
interface AdminUserListRow {
  id: string;
  username: string;
  nickname: string | null;
  status: AdminUserStatus;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  passwordUpdatedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  createdAt: Date;
}

/**
 * 操作者上下文（由 Controller 从请求注入）
 *
 * `adminUserId` 来自 `@CurrentUser('userId')`，其余字段用于审计留痕；
 * `jti` 一并采集是为了在「同一管理员多设备登录」时能从日志定位到具体会话 ——
 * 重置**自己**的密码会连当前会话一起撤销，事后复盘需要知道当时用的是哪条会话。
 */
export interface AdminOperatorContext {
  adminUserId: string;
  jti?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/** 审计统计聚合结果（审计表异常时全为空 Map，即全 0 降级） */
interface AdminAuditStats {
  loginCount30d: Map<string, number>;
  operationStats7d: Map<string, AdminOperationStatsDto>;
  createdBy: Map<string, string | null>;
}

/**
 * 统计累加的中间形态
 *
 * `loginActions` 是**内部中间量**，不对外输出：登录类动作既不是读也不是写，
 * 但它会出现在审计表里，若不在总数中扣除就会把「每天登录 50 次」误判成「高频读取」。
 */
interface OperationStatsBucket extends AdminOperationStatsDto {
  loginActions: number;
}

@Injectable()
export class AdminUserService {
  private readonly logger = new Logger(AdminUserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly rbac: AdminRbacService,
    private readonly tokens: AdminTokenService,
    private readonly audit: AdminAuditService,
  ) {}

  // ==========================================================================
  // §3.14.9.4 管理员列表
  // ==========================================================================

  async listAdmins(query: AdminUserListQueryDto): Promise<AdminUserListDto> {
    const now = new Date();

    // 分页参数不信任 DTO 的 getter：直接 `new` 出来的对象（单测、内部调用）没有走
    // 全局 ValidationPipe，getter 会算出 NaN 并让 Prisma 抛错
    const page = Number.isInteger(query.page) && query.page >= 1 ? query.page : 1;
    const pageSize =
      Number.isInteger(query.pageSize) && query.pageSize >= 1 && query.pageSize <= 100 ? query.pageSize : 20;

    const statuses = this.parseStatuses(query.status);
    const roleCodes = parseCsvValues(query.roleCode);
    const keyword = query.keyword?.trim() ?? '';

    // 非法角色码 → 10001（契约 §3.14.9.4 错误码表）
    if (roleCodes.length > 0) {
      await this.assertRoleCodesExist(roleCodes);
    }

    const baseWhere = this.buildListWhere({ statuses, roleCodes, keyword, now });

    const [total, rows, statusGroups, byRole] = await Promise.all([
      this.prisma.adminUser.count({ where: baseWhere }),
      this.prisma.adminUser.findMany({
        where: baseWhere,
        select: ADMIN_USER_LIST_SELECT,
        // `id` 作为次序 tiebreaker：uuid(7) 随时间单调递增，
        // 同一毫秒创建的两条记录才有稳定顺序，否则翻页会漏行/重复行
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adminUser.groupBy({ by: ['status'], where: baseWhere, _count: { _all: true } }),
      this.loadRoleDistribution(baseWhere, now),
    ]);

    const items = await this.buildListItems(rows, now);

    return {
      // 统一分页包络：hasNext 的算法只应有一处实现（`page * pageSize < total`）
      ...buildPaginated(items, total, page, pageSize),
      summary: {
        totalAdmins: total,
        activeCount: this.countByStatus(statusGroups, 'ACTIVE'),
        // 口径说明：登录失败锁定由 `registerFailure` **同时**写入
        // `status = LOCKED` 与 `lockedUntil`，重置/改密又同时清掉二者，
        // 因此「按 status 计数」与逐条的 `isLocked` 在现有写入路径下必然一致
        lockedCount: this.countByStatus(statusGroups, 'LOCKED'),
        disabledCount: this.countByStatus(statusGroups, 'DISABLED'),
        byRole,
      },
    };
  }

  /** 组装列表查询条件（筛选条件同时供 `count` / `findMany` / 摘要使用，保证口径一致） */
  private buildListWhere(input: {
    statuses: AdminUserStatusValue[];
    roleCodes: string[];
    keyword: string;
    now: Date;
  }): Prisma.AdminUserWhereInput {
    const { statuses, roleCodes, keyword, now } = input;

    return {
      // 软删账号不进列表：它们既不能登录，也不该出现在「谁有权限」的复核清单里
      deletedAt: null,
      ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
      // 角色筛选走 `admin_user_roles` 关联，并排除已过期的临时授予 ——
      // 否则「临时给过的角色」会被当成「当前拥有的角色」
      ...(roleCodes.length > 0
        ? {
            userRoles: { some: { role: { code: { in: roleCodes }, deletedAt: null }, ...this.activeGrantFilter(now) } },
          }
        : {}),
      ...(keyword.length > 0
        ? {
            OR: [
              { username: { contains: keyword, mode: 'insensitive' } },
              { nickname: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  /** 临时授予的过期条件（未设置 `expiresAt` 表示永久授予） */
  private activeGrantFilter(now: Date): { OR: Prisma.AdminUserRoleWhereInput[] } {
    return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  }

  /** 摘要中的状态计数（`groupBy` 结果折叠成 Map 后取值） */
  private countByStatus(groups: Array<{ status: AdminUserStatus; _count: { _all: number } }>, status: string): number {
    return groups.find((group) => group.status === status)?._count._all ?? 0;
  }

  /**
   * `byRole` 分布（一次查询拿全部角色的计数，避免「每个角色一次 count」）
   *
   * 覆盖全部内置角色码并对缺失项补 0：前端角色筛选器需要稳定的键集合，
   * 直接返回稀疏对象会让「ANALYST 为 0」这类信息消失。
   *
   * 为什么用 `findMany` + 关系 select 而不是 `groupBy({ by: ['roleId'] })`：
   * 后者需要在 `groupBy` 的 `where` 里放**关系过滤**（`adminUser`），
   * 是该 ORM 里较少被使用的组合；一旦运行时不支持，整个列表接口会 500。
   * 而管理端账号总量在数十量级（权限模型失控才会更多），关联行合计数百，
   * 聚合到内存的成本可以忽略 —— 用确定性换掉这点内存是完全值得的。
   */
  private async loadRoleDistribution(where: Prisma.AdminUserWhereInput, now: Date): Promise<Record<string, number>> {
    const distribution: Record<string, number> = {};
    for (const code of ADMIN_ROLES) {
      distribution[code] = 0;
    }

    const links = await this.prisma.adminUserRole.findMany({
      where: {
        adminUser: where,
        role: { deletedAt: null },
        ...this.activeGrantFilter(now),
      },
      select: { role: { select: { code: true } } },
    });

    for (const link of links) {
      // 非内置角色也被计入（数据里存在自定义角色时不应静默丢掉）
      distribution[link.role.code] = (distribution[link.role.code] ?? 0) + 1;
    }

    return distribution;
  }

  /** 把列表行 + RBAC + 审计统计组装成响应条目 */
  private async buildListItems(rows: AdminUserListRow[], now: Date): Promise<AdminUserListItemDto[]> {
    if (rows.length === 0) return [];

    // 角色与权限一律以 RBAC 服务的解析结果为准（与登录/`me` 接口同源），
    // 保证「列表里看到的权限」就是「实际生效的权限」
    const grants = await Promise.all(rows.map((row) => this.rbac.resolve(row.id, row.isSuperAdmin)));
    const stats = await this.loadAuditStats(rows, now);

    return rows.map((row, index) => {
      const grant = grants[index];
      const isLocked =
        row.status === 'LOCKED' || (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime());

      return {
        adminId: row.id,
        username: row.username,
        // 契约的 `displayName` 落到 `nickname`；历史上只填了 username 的老账号回退到用户名
        displayName: row.nickname ?? row.username,
        status: row.status,
        roles: grant.roleBriefs.map((brief) => ({ roleCode: brief.roleCode, roleName: brief.roleName })),
        permissionCount: this.countPermissions(grant.permissions),
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        lastLoginIp: row.lastLoginIp,
        loginCount30d: stats.loginCount30d.get(row.id) ?? 0,
        passwordUpdatedAt: row.passwordUpdatedAt?.toISOString() ?? null,
        mustChangePassword: row.mustChangePassword,
        isLocked,
        // 未锁定时明确给 null（而不是省略字段）：前端 `isLocked ? lockedUntil : ...`
        // 的两分支都能拿到确定值，不必区分 undefined
        lockedUntil: isLocked && row.lockedUntil !== null ? row.lockedUntil.toISOString() : null,
        failedLoginCount: row.failedLoginCount,
        createdAt: row.createdAt.toISOString(),
        createdBy: stats.createdBy.get(row.id) ?? null,
        operationStats7d: stats.operationStats7d.get(row.id) ?? emptyOperationStats(),
      };
    });
  }

  /** `*` 通配符代表全部权限点，对外展示应折算成具体数量 */
  private countPermissions(permissions: string[]): number {
    return permissions.includes(PERMISSION_WILDCARD) ? ALL_ADMIN_PERMISSIONS.length : permissions.length;
  }

  /**
   * 批量加载审计派生信息（近 30 天登录数 / 近 7 天操作统计 / 创建者）
   *
   * 全部按「本页的管理员 ID」批量查询，不做 per-admin 循环查询：
   * 20 条一页若逐个统计就是 60 次查询，列表接口会被自己的统计拖垮。
   */
  private async loadAuditStats(rows: AdminUserListRow[], now: Date): Promise<AdminAuditStats> {
    const degraded: AdminAuditStats = {
      loginCount30d: new Map(),
      operationStats7d: new Map(),
      createdBy: new Map(),
    };

    const adminIds = rows.map((row) => row.id);

    try {
      const [loginGroups, actionGroups, earliestGroups, createLogs] = await Promise.all([
        this.prisma.adminAuditLog.groupBy({
          by: ['adminUserId'],
          where: {
            adminUserId: { in: adminIds },
            action: 'LOGIN',
            success: true,
            createdAt: { gte: this.daysAgo(now, LOGIN_STATS_WINDOW_DAYS) },
          },
          _count: { _all: true },
        }),
        // 按 (admin, action, resourceType) 分组：CRITICAL 判定需要同时看动作与资源类型
        this.prisma.adminAuditLog.groupBy({
          by: ['adminUserId', 'action', 'resourceType'],
          where: { adminUserId: { in: adminIds }, createdAt: { gte: this.daysAgo(now, OPERATION_STATS_WINDOW_DAYS) } },
          _count: { _all: true },
        }),
        // 每个管理员最早的一条审计：用于判定「这个账号在出现任何操作记录之前就存在」（即种子账号）
        this.prisma.adminAuditLog.groupBy({
          by: ['adminUserId'],
          where: { adminUserId: { in: adminIds } },
          _min: { createdAt: true },
        }),
        this.prisma.adminAuditLog.findMany({
          where: {
            resourceType: { in: [RESOURCE_TYPE_ADMIN, RESOURCE_TYPE_ADMIN_ALIAS] },
            resourceId: { in: adminIds },
            action: 'CREATE',
          },
          select: { resourceId: true, adminUsername: true },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      const loginCount30d = new Map<string, number>();
      for (const group of loginGroups) {
        if (group.adminUserId === null) continue;
        loginCount30d.set(group.adminUserId, group._count._all);
      }

      const buckets = new Map<string, OperationStatsBucket>();
      for (const group of actionGroups) {
        if (group.adminUserId === null) continue;

        const bucket: OperationStatsBucket = buckets.get(group.adminUserId) ?? {
          ...emptyOperationStats(),
          loginActions: 0,
        };
        const count = group._count._all;

        bucket.totalActions += count;
        if (isWriteAuditAction(group.action)) bucket.writeActions += count;
        if (isLoginAuditAction(group.action)) bucket.loginActions += count;
        if (isCriticalAuditPair(group.resourceType, group.action)) bucket.criticalActions += count;

        buckets.set(group.adminUserId, bucket);
      }

      const operationStats7d = new Map<string, AdminOperationStatsDto>();
      for (const [adminUserId, bucket] of buckets) {
        operationStats7d.set(adminUserId, {
          totalActions: bucket.totalActions,
          criticalActions: bucket.criticalActions,
          writeActions: bucket.writeActions,
          /**
           * `readActions` 由减法反推，**不是**实测值：`AdminAuditAction` 枚举里没有 `READ`，
           * 读接口无法入账（本模块的列表接口也刻意不写读审计 —— 用 `EXPORT` 之类的动作
           * 兜底会把「导出订单」这类真正需要审计的行为淹没）。
           *
           * 因此该值是**近似值**：在只有登录与写操作审计的正常流量下为 0，
           * 少数既非写也非登录的动作（如 `EXPORT`，契约未把它算作写类）会落在差额里。
           * 这里不编造读操作数字，只如实反映「总数减去可归类的部分」。
           */
          readActions: Math.max(0, bucket.totalActions - bucket.writeActions - bucket.loginActions),
        });
      }

      const createdBy = new Map<string, string | null>();
      // 升序取首条：同一账号理论上只有一条 CREATE 审计，重复时以最早那条为准
      for (const log of createLogs) {
        if (log.resourceId === null || createdBy.has(log.resourceId)) continue;
        createdBy.set(log.resourceId, log.adminUsername);
      }

      const earliestAuditAt = new Map<string, Date>();
      for (const group of earliestGroups) {
        if (group.adminUserId === null || group._min.createdAt === null) continue;
        earliestAuditAt.set(group.adminUserId, group._min.createdAt);
      }

      for (const row of rows) {
        if (createdBy.has(row.id)) continue;

        /**
         * 无 `CREATE` 审计记录时的归因规则（契约 §3.14.9.4 的 `SYSTEM_SEED`）：
         *   · 超管一律视为种子账号（它的创建不可能经由本接口 —— 创建接口禁止授予超管）；
         *   · 密码设置时间早于该账号**任何**审计记录 → 账号在接入审计之前就存在；
         *   · 其余情况诚实返回 `null`，不编造一个操作者。
         */
        const earliest = earliestAuditAt.get(row.id) ?? null;
        const isSeedAccount =
          row.isSuperAdmin ||
          (row.passwordUpdatedAt !== null &&
            (earliest === null || row.passwordUpdatedAt.getTime() < earliest.getTime()));

        createdBy.set(row.id, isSeedAccount ? SYSTEM_SEED_CREATOR : null);
      }

      return { loginCount30d, operationStats7d, createdBy };
    } catch (error) {
      // 审计派生字段属附加信息：宁可降级为全 0，也不让「有谁在后台」这件事查不出来
      this.logger.warn(
        `管理员列表的审计统计失败，已降级为全 0：${error instanceof Error ? error.message : String(error)}`,
      );
      return degraded;
    }
  }

  private daysAgo(from: Date, days: number): Date {
    return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
  }

  /** `status` 逗号分隔解析；非法值 → 10001（契约错误码表明确要求） */
  private parseStatuses(raw?: string): AdminUserStatusValue[] {
    const values = parseCsvValues(raw);
    const invalid = values.filter((value) => !isAdminUserStatus(value));

    if (invalid.length > 0) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `status 含非法值：${invalid.join('、')}`,
        invalid.map((value) => ({ field: 'status', issue: '仅支持 ACTIVE / DISABLED / LOCKED', value })),
      );
    }

    // 用类型守卫过滤而不是 `as`：新增状态值时这里会编译期提醒，而不是静默放过
    return values.filter(isAdminUserStatus);
  }

  // ==========================================================================
  // §3.14.9.5 新建管理员
  // ==========================================================================

  async createAdmin(dto: CreateAdminUserDto, operator: AdminOperatorContext): Promise<AdminCreateResultDto> {
    const startedAt = Date.now();
    const operatorAdmin = await this.loadOperator(operator.adminUserId);

    const username = dto.username.trim();
    const displayName = dto.displayName.trim();
    // 去重后逐个精确匹配数据库角色码（大小写敏感）：`ANALYST` 与 `analyst` 是两个不同的键，
    // 在这里「纠正大小写」会让「传错了但没报错」的行为掩盖前端的契约不一致
    const roleCodes = [...new Set(dto.roleCodes.map((code) => code.trim()))];

    /**
     * 护栏 1（契约 §3.14.9.5 规则 3）：禁止通过接口授予 `SUPER_ADMIN`。
     *
     * 这不是「权限不足」而是「该路径不提供此能力」——超管只能在初始化种子或
     * 人工介入的部署流程里设置，否则本接口就是一个一步到位的提权通道。
     */
    if (roleCodes.includes(SUPER_ADMIN_ROLE_CODE)) {
      /**
       * 只记 warn 日志、**不写审计**：审计的 `CREATE/ADMIN` 行是「创建者归因」的数据源
       * （见 `loadAuditStats`），被拒绝的尝试写进去会让归因查询面对语义混杂的行。
       * 提权尝试属于安全事件，留给日志告警链路而不是审计表。
       */
      this.logger.warn(
        `拒绝创建超级管理员：operator=${operatorAdmin.adminId} username=${username} ip=${operator.ip ?? '-'}`,
      );
      throw BusinessException.forbidden(
        ErrorCode.OPERATION_FORBIDDEN,
        '不允许通过接口创建超级管理员，请在初始化种子或部署流程中设置',
      );
    }

    // 护栏 3：角色码必须真实存在（`assertRoleCodesExist` 同时返回 roleId 供建关联使用）
    const roles = await this.assertRoleCodesExist(roleCodes);

    // 登录名唯一性：🚫 不带 `deletedAt: null` —— `username` 是全局唯一列，
    // 软删账号仍占用该登录名，放行会在 create 时撞唯一约束（500 而不是 409）
    const existing = await this.prisma.adminUser.findFirst({ where: { username }, select: { id: true } });
    if (existing) {
      // 契约原文为 `10012`（用户名已存在），本仓库无此码 → 用 `10003` RESOURCE_CONFLICT
      throw BusinessException.conflict(ErrorCode.RESOURCE_CONFLICT, '该登录名已被占用，请更换');
    }

    if (dto.initialPassword !== undefined && !isStrongAdminPassword(dto.initialPassword)) {
      // DTO 已校验过一遍；这里是服务层兜底（内部调用/未来新增入口不会绕过强密码约束）
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        'initialPassword 需 12–64 位且同时包含大小写字母、数字与符号',
      );
    }

    const generated = dto.initialPassword === undefined;
    const plainPassword = dto.initialPassword ?? generateOneTimePassword();
    // 默认强制首次登录改密：初始密码经过转交环节，不可长期有效
    const mustChangePassword = dto.mustChangePassword ?? true;
    const ipWhitelist = dto.ipWhitelist ?? [];
    const passwordHash = await this.passwords.hash(plainPassword);
    const now = new Date();

    const created = await this.createAdminRecords({
      username,
      displayName,
      passwordHash,
      mustChangePassword,
      remark: dto.remark ?? null,
      roleIds: roles.map((role) => role.id),
      operatorAdminId: operatorAdmin.adminId,
      ipWhitelist,
      now,
    });

    if (ipWhitelist.length > 0) {
      this.logger.log(`管理员 ${created.id} 已登记 IP 白名单 ${ipWhitelist.length} 条（登录链路尚未强制校验）`);
    }

    // 权限并集以 RBAC 解析为准（与列表/登录同源），而不是自己按角色拼装
    const grant = await this.rbac.resolve(created.id, false);
    const permissions = grant.permissions;

    /**
     * 审计（`CRITICAL` 级，契约规则 5：`before` 为 `null`）。
     *
     * 🚫 `afterData` 只含**非敏感**的账号属性：任何密码/哈希都不得进入审计表 ——
     * 审计是「可被最多人读取」的表（`system:audit:read` 即可查看），
     * 把初始密码写进去等于把它扩散给所有能看审计的人。
     */
    await this.audit.log({
      adminUserId: operatorAdmin.adminId,
      adminUsername: operatorAdmin.username,
      action: 'CREATE',
      resourceType: RESOURCE_TYPE_ADMIN,
      resourceId: created.id,
      beforeData: null,
      afterData: {
        username,
        displayName,
        status: 'ACTIVE',
        roleCodes,
        mustChangePassword,
        ipWhitelist,
        remark: dto.remark ?? null,
      },
      diffSummary: `新建管理员 ${username}（角色：${roleCodes.join('、')}，强制改密：${mustChangePassword ? '是' : '否'}）`,
      reason: CREATE_AUDIT_REASON,
      ip: operator.ip ?? null,
      userAgent: operator.userAgent ?? null,
      requestId: operator.requestId ?? null,
      latencyMs: Date.now() - startedAt,
      success: true,
    });

    this.logger.log(
      `新建管理员 id=${created.id} username=${username} operator=${operatorAdmin.adminId} jti=${operator.jti ?? '-'}`,
    );

    return {
      adminId: created.id,
      username,
      displayName,
      status: 'ACTIVE',
      roles: grant.roleBriefs.map((brief) => ({ roleCode: brief.roleCode, roleName: brief.roleName })),
      permissions,
      permissionCount: this.countPermissions(permissions),
      mustChangePassword,
      ipWhitelist,
      remark: dto.remark ?? null,
      initialPassword: {
        generated,
        // 明文只在此响应出现一次；服务端只留 Argon2id 哈希（契约规则 1）
        password: plainPassword,
        note: INITIAL_PASSWORD_NOTE,
        expiresInHours: ONE_TIME_PASSWORD_EXPIRES_HOURS,
      },
      createdAt: created.createdAt.toISOString(),
      createdBy: { adminId: operatorAdmin.adminId, displayName: operatorAdmin.displayName },
      // `AdminAuditService.log` 只回传 `boolean`，不回传 id（本次不允许改它）
      auditLogId: null,
    };
  }

  /**
   * 创建管理员的三张写入（账号 / 角色关联 / IP 白名单）放在**同一事务**
   *
   * 半成品账号是最糟的结果：账号建好了但角色没挂上，会出现一个「能登录但什么都做不了」
   * 且没人知道该给它什么权限的账号（审计里也只有半条记录）。
   */
  private async createAdminRecords(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    mustChangePassword: boolean;
    remark: string | null;
    roleIds: string[];
    operatorAdminId: string;
    ipWhitelist: string[];
    now: Date;
  }): Promise<{ id: string; createdAt: Date }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const admin = await tx.adminUser.create({
          data: {
            username: input.username,
            passwordHash: input.passwordHash,
            // 契约的 `displayName` 落在 `nickname`
            nickname: input.displayName,
            status: 'ACTIVE',
            // 超管标记**只能**由种子/部署流程设置：本接口恒为 false（护栏 1 的落库侧保证）
            isSuperAdmin: false,
            mustChangePassword: input.mustChangePassword,
            passwordUpdatedAt: input.now,
            remark: input.remark,
          },
          select: { id: true, createdAt: true },
        });

        await tx.adminUserRole.createMany({
          data: input.roleIds.map((roleId) => ({
            adminUserId: admin.id,
            roleId,
            grantedByAdminId: input.operatorAdminId,
          })),
        });

        if (input.ipWhitelist.length > 0) {
          /**
           * ⚠️ `admin_users` **没有** `ipWhitelist` 列，契约字段无处可放。
           * 落 `system_configs` 的 `JSON` 值是最小改动方案：不新增表、不改 schema，
           * 且 `(group = 'SECURITY', isPublic = false)` 表达了「安全配置、不对外」的语义。
           *
           * 🚫 但必须明确：**登录链路尚未读取它**（登录用的是全局 `ADMIN_IP_WHITELIST`
           * 环境变量，见 `admin-auth.service.ts` 的 `assertIpAllowed`）。
           * 因此这里的值目前只是「登记的意图」，真正强制执行需要改登录逻辑（不在本次范围）。
           */
          const value = JSON.stringify(input.ipWhitelist);
          await tx.systemConfig.upsert({
            where: { key: ipWhitelistConfigKey(admin.id) },
            create: {
              key: ipWhitelistConfigKey(admin.id),
              value,
              valueType: 'JSON',
              group: IP_WHITELIST_CONFIG_GROUP,
              description: `管理员 ${input.username} 的登录 IP 白名单（登录链路尚未强制校验）`,
              isPublic: false,
              // 不允许在配置管理界面直接改：它必须由本接口维护，
              // 否则「配置页改的值」与「账号管理页回显的值」会不一致
              isEditable: false,
              updatedByAdminId: input.operatorAdminId,
            },
            update: { value, updatedByAdminId: input.operatorAdminId },
          });
        }

        return admin;
      });
    } catch (error) {
      /**
       * 并发创建同一登录名时，前面的「先查后插」会双双通过，最终由唯一约束拦下。
       * 必须把 `P2002` 翻译成 409，否则并发场景返回 500 —— 同一语义两种状态码，
       * 前端无法统一处理。
       */
      if (isUniqueConstraintViolation(error)) {
        throw BusinessException.conflict(ErrorCode.RESOURCE_CONFLICT, '该登录名已被占用，请更换');
      }
      throw error;
    }
  }

  // ==========================================================================
  // §3.14.9.6 重置管理员密码
  // ==========================================================================

  async resetAdminPassword(
    targetAdminId: string,
    dto: ResetAdminPasswordDto,
    operator: AdminOperatorContext,
  ): Promise<AdminPasswordResetResultDto> {
    const startedAt = Date.now();

    /**
     * 必须先校验 UUID 形态：非法字面量会被拼进 SQL 由 PostgreSQL 拒绝，
     * 表现为 500（数据库异常）而非「参数不合法」。
     *
     * ⚠ 契约 §3.14.9.6 对非法 `id` 要求返回 `10003`，但本仓库的 `10003` 是
     * `RESOURCE_CONFLICT`（409，语义已被占用），因此统一用 `10001`（400）。
     */
    if (!isUuid(targetAdminId)) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'id 不是合法的管理员 UUID');
    }

    const operatorAdmin = await this.loadOperator(operator.adminUserId);

    const target = await this.prisma.adminUser.findFirst({
      where: { id: targetAdminId, deletedAt: null },
      select: {
        id: true,
        username: true,
        nickname: true,
        status: true,
        isSuperAdmin: true,
        failedLoginCount: true,
        passwordUpdatedAt: true,
        lockedUntil: true,
      },
    });

    if (!target) {
      throw BusinessException.notFound(ErrorCode.ADMIN_NOT_FOUND, '管理员不存在');
    }

    /**
     * 护栏 2（契约 §3.14.9.6 规则 3）：禁止重置**其他** `SUPER_ADMIN` 的密码。
     *
     * 重置谁就等于能登录谁，若允许超管互相重置，一个拿到 `system:admin:write`
     * 的账号就能横向接管全部超管账号，`SUPER_ADMIN` 保护形同虚设。
     * 重置**自己**允许：那只是本人改密，代价是自己被登出（预期行为）。
     */
    if (target.isSuperAdmin && target.id !== operatorAdmin.adminId) {
      this.logger.warn(
        `拒绝重置其他超级管理员的密码：operator=${operatorAdmin.adminId} target=${target.id} ip=${operator.ip ?? '-'}`,
      );
      throw BusinessException.forbidden(
        ErrorCode.PERMISSION_DENIED,
        '不允许重置其他超级管理员的密码，超管忘记密码需走部署侧应急流程',
      );
    }

    const plainPassword = generateOneTimePassword();
    const passwordHash = await this.passwords.hash(plainPassword);
    const mustChangePassword = dto.mustChangePassword ?? true;
    const revokeSessions = dto.revokeSessions ?? true;
    const now = new Date();

    const previousFailedLoginCount = target.failedLoginCount;
    const unlocked =
      target.status === 'LOCKED' || (target.lockedUntil !== null && target.lockedUntil.getTime() > now.getTime());

    await this.prisma.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: target.id },
        data: {
          passwordHash,
          passwordUpdatedAt: now,
          mustChangePassword,
          /**
           * 解锁必须与改密**同一事务**（契约规则 1）。分开写会出现
           * 「密码已换新但账号仍锁定」的中间态：用户拿着正确的新密码也登不进去，
           * 而锁定还会按 15 分钟自动计时 —— 表现为「重置完还是不能用」。
           */
          failedLoginCount: 0,
          lockedUntil: null,
          status: target.status === 'LOCKED' ? 'ACTIVE' : target.status,
        },
      });
    });

    /**
     * 会话撤销放在**事务提交之后**：会话状态在 Redis，与 Postgres 不是同一资源，
     * 放进事务并不能获得原子性（Redis 没有回滚），反而会制造
     * 「DB 已回滚但会话已被删」的不一致。撤销失败时最坏结果是旧会话多存活
     * ≤1 小时（access token TTL），而密码已换新，属可接受的降级 ——
     * 因此这里吞掉异常并记 error，不让「撤销没成功」把「改密成功」变成 500。
     */
    const revokedSessions = revokeSessions ? await this.revokeAllSessionsSafely(target.id) : 0;

    const beforeData = {
      passwordUpdatedAt: target.passwordUpdatedAt?.toISOString() ?? null,
      failedLoginCount: previousFailedLoginCount,
    };
    const afterData = {
      passwordUpdatedAt: now.toISOString(),
      mustChangePassword,
      failedLoginCount: 0,
      revokedSessions,
    };

    // 🚫 审计 before/after 只含上述字段：**绝不含**密码或哈希（契约规则 5 明确要求）
    await this.audit.log({
      adminUserId: operatorAdmin.adminId,
      adminUsername: operatorAdmin.username,
      action: 'UPDATE',
      resourceType: RESOURCE_TYPE_ADMIN,
      resourceId: target.id,
      beforeData,
      afterData,
      diffSummary:
        this.audit.buildDiffSummary(beforeData, afterData) ??
        `重置管理员 ${target.username} 的密码（撤销 ${revokedSessions} 个会话）`,
      reason: dto.reason,
      ip: operator.ip ?? null,
      userAgent: operator.userAgent ?? null,
      requestId: operator.requestId ?? null,
      latencyMs: Date.now() - startedAt,
      success: true,
    });

    this.logger.log(
      `重置管理员密码 target=${target.id} operator=${operatorAdmin.adminId} jti=${operator.jti ?? '-'} revokedSessions=${revokedSessions} selfReset=${target.id === operatorAdmin.adminId}`,
    );

    return {
      adminId: target.id,
      username: target.username,
      displayName: target.nickname ?? target.username,
      reason: dto.reason,
      mustChangePassword,
      revokedSessions,
      unlocked,
      previousFailedLoginCount,
      newPassword: {
        // 本接口不接受调用方指定密码（契约请求体无该字段），恒定由服务端生成
        generated: true,
        password: plainPassword,
        note: RESET_PASSWORD_NOTE,
        expiresInHours: ONE_TIME_PASSWORD_EXPIRES_HOURS,
      },
      passwordUpdatedAt: now.toISOString(),
      resetBy: { adminId: operatorAdmin.adminId, displayName: operatorAdmin.displayName },
      auditLogId: null,
    };
  }

  /** 撤销全部会话并吞掉异常（额度不足/Redis 不可用时不应把改密判为失败） */
  private async revokeAllSessionsSafely(adminUserId: string): Promise<number> {
    try {
      return await this.tokens.revokeAllSessions(adminUserId, PASSWORD_RESET_REVOKE_REASON);
    } catch (error) {
      this.logger.error(
        `撤销管理员 ${adminUserId} 的会话失败（密码已更新，旧会话将在 access TTL 内自然过期）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /**
   * 校验角色码全部存在，并返回 `id` / `code`
   *
   * 空数组视为非法：调用的两个场景（创建必须 ≥1 个角色；列表筛选只在非空时调用）
   * 都不应接受空集合，静默放行会让「创建了一个无任何角色的账号」这种半成品漏过去。
   */
  private async assertRoleCodesExist(roleCodes: string[]): Promise<Array<{ id: string; code: string }>> {
    if (roleCodes.length === 0) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'roleCodes 至少需要 1 个角色');
    }

    const roles = await this.prisma.role.findMany({
      where: { code: { in: roleCodes }, deletedAt: null },
      select: { id: true, code: true },
    });

    const found = new Set(roles.map((role) => role.code));
    const missing = roleCodes.filter((code) => !found.has(code));

    if (missing.length > 0) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `角色码不存在或已停用：${missing.join('、')}`,
        missing.map((code) => ({ field: 'roleCodes', issue: '角色不存在或已停用', value: code })),
      );
    }

    return roles;
  }

  /**
   * 载入操作者资料
   *
   * 响应里的 `createdBy` / `resetBy` 需要**显示名**，而令牌载荷里没有它，
   * 因此必须查一次库。查不到说明账号在请求处理期间被删除 —— 守卫链刚刚还放过它，
   * 属于凭证失效，返回 401 引导重新登录，而不是 500。
   */
  private async loadOperator(adminId: string): Promise<{
    adminId: string;
    username: string;
    displayName: string;
  }> {
    const operator = await this.prisma.adminUser.findFirst({
      where: { id: adminId, deletedAt: null },
      select: { id: true, username: true, nickname: true },
    });

    if (!operator) {
      throw BusinessException.unauthorized(ErrorCode.TOKEN_INVALID, '当前登录管理员不存在，请重新登录');
    }

    return {
      adminId: operator.id,
      username: operator.username,
      displayName: operator.nickname ?? operator.username,
    };
  }
}
