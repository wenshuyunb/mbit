/**
 * AdminRoleService — 角色与权限点管理（契约 §3.14.9.7 / §3.14.9.8）
 *
 * ## 数据模型真相（契约与 schema 不一致，按 schema 落地）
 *
 * 契约 §3.14.9.7 的响应里有 `isEditable`，但 `roles` 表**没有**这一列
 * （只有 `code/name/description/isSystem/sortOrder/deletedAt`）。因此这里用规则推导：
 *   · `code === 'SUPER_ADMIN'` → `isEditable: false`（契约示例即如此，权限恒为 `*`）
 *   · 其余（含其它内置角色）→ `isEditable: true`
 * 持久化一个 `is_editable` 列反而更糟：它会与「SUPER_ADMIN 不可修改」这条业务规则
 * 各存一份，两者一旦不同步就会有人绕过限制。
 *
 * ## 「权限即时生效」的实现真相（务必读完再改）
 *
 * 契约 §3.14.9.8 规则 2 声称「权限在 Guard 层实时查询缓存，无需重新登录」。
 * **本仓库不是这样实现的**：`AdminAuthService` 登录/刷新时把 `roles` 与 `permissions`
 * **烧进了管理员 JWT**（见 `AdminTokenService.issueTokens` 与 `assertPayloadUsable`），
 * 而 `AdminAuthGuard` 只校验「会话仍然存在」，**不会重新查库**。
 * 也就是说：只改数据库的话，已登录管理员在 access token 有效期内（1h）仍持旧权限。
 *
 * 若要真正即时生效，只有一条路（本服务采用）：**撤销受影响管理员的全部会话**，
 * 让他们重新登录后拿到新权限集合。代价是受影响的账号要被踢下线一次，因此响应里
 * `requiresReLogin: true`、`note` 写明原因 —— 这是**刻意与契约不同**的地方，
 * 不是实现没做对。
 *
 * ## 自锁死护栏
 *
 * `PATCH` 是**覆盖语义**，一次误操作就可能让全系统再也没有任何账号持有
 * `system:role:write` —— 届时时任何人都进不了角色管理页，只能改数据库救场。
 * 因此提交前必须统计「修改后仍持有 `system:role:write` 的账号数」，为 0 直接拒绝。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminTokenService } from '../auth/admin-token.service';
import { ADMIN_PERMISSIONS, ALL_ADMIN_PERMISSIONS, PERMISSION_WILDCARD } from '../rbac/admin-permission.constants';
import {
  ADMIN_PERMISSION_CATALOG,
  ADMIN_PERMISSION_DOMAIN_NAMES,
  ADMIN_PERMISSION_DOMAIN_ORDER,
  type AdminPermissionSeverity,
} from './admin-role.permission-catalog';
import type { AdminRoleUpdateDto } from './dto/admin-role.dto';

/** 超管角色码（与 `ADMIN_ROLES` 里的 SUPER_ADMIN 一致） */
const SUPER_ADMIN_ROLE_CODE = 'SUPER_ADMIN';

/** 权限点命名规范（契约 §3.14.9.7 的原文，含架构章节号） */
const PERMISSION_NAMING_RULE = '<domain>:<resource>:<action>（架构 9.3）';

/** 权限变更后撤销会话的理由（写入 `AdminTokenService` 的日志，便于追溯谁被踢下线） */
const REVOKE_REASON = 'role_permissions_changed';

/**
 * UUID 格式校验
 *
 * 为什么要自己校验：`roles.id` 是 `@db.Uuid` 列，把一个非 UUID 字符串传给 Prisma 会抛
 * `P2023`（列数据不一致）→ 变成 500，而契约要求「角色不存在」应为 `20023`/404。
 * 在入口处收敛，才能保证「随便传个 id」得到的是 404 而不是服务异常。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 全部权限点集合（白名单校验用；一次性构建，避免每次请求重建 Set） */
const KNOWN_PERMISSION_CODES: ReadonlySet<string> = new Set<string>(ALL_ADMIN_PERMISSIONS);

// ============================================================================
// 视图类型（Controller 直接返回，由全局 TransformInterceptor 包成 {code,message,data}）
// ============================================================================

export interface AdminPermissionItemView {
  permission: string;
  name: string;
  severity: AdminPermissionSeverity;
  description: string;
}

export interface AdminPermissionGroupView {
  domain: string;
  domainName: string;
  items: AdminPermissionItemView[];
}

export interface AdminRoleView {
  roleId: string;
  roleCode: string;
  roleName: string;
  description: string | null;
  isSystem: boolean;
  /** 推导值：`SUPER_ADMIN` 不可编辑，其余角色可编辑（见文件头说明） */
  isEditable: boolean;
  /** `SUPER_ADMIN` 返回 `['*']`，与 `AdminRbacService.resolve` 的口径一致 */
  permissions: string[];
  adminCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRoleListView {
  roles: AdminRoleView[];
  allPermissions: AdminPermissionGroupView[];
  totalRoles: number;
  /** 实际权限点总数（以 `ALL_ADMIN_PERMISSIONS` 为准，契约写的 24 与代码不一致） */
  totalPermissions: number;
  permissionNamingRule: string;
}

/** 风险提示码；前两个来自契约示例，第三个是本实现补充的（详见 `buildRiskWarnings`） */
export type AdminRiskWarningCode =
  'CRITICAL_PERMISSION_REMOVED' | 'CRITICAL_PERMISSION_GRANTED' | 'OPERATOR_LOSES_ROLE_WRITE';

export interface AdminRiskWarning {
  code: AdminRiskWarningCode;
  message: string;
}

export interface AffectedAdminView {
  adminId: string;
  displayName: string;
  isCurrentlyOnline: boolean;
}

export interface AdminRoleUpdateView {
  roleId: string;
  roleCode: string;
  roleName: string;
  description: string | null;
  permissionsBefore: string[];
  permissionsAfter: string[];
  addedPermissions: string[];
  removedPermissions: string[];
  permissionDelta: { added: number; removed: number; before: number; after: number };
  affectedAdmins: AffectedAdminView[];
  affectedAdminCount: number;
  /** 本仓库恒为 `true`：权限烧进令牌，只能靠撤销会话即时生效 */
  requiresReLogin: boolean;
  permissionCacheInvalidated: boolean;
  note: string;
  riskWarnings: AdminRiskWarning[];
  reason: string;
  updatedAt: string;
  updatedBy: { adminId: string; displayName: string };
  /**
   * 审计记录 id
   *
   * 本仓库恒为 `null`：审计走 `AdminAuditService.log()`，它的返回值是 `boolean`
   * （审计是旁路，失败不影响业务，见该服务文件头），拿不到插入行 id。
   * 要拿到 id 只能绕过该服务直接写 `admin_audit_logs` —— 那会让审计出现两条口径，
   * 故这里返回 null，并在报告中标注该字段暂不可用。
   */
  auditLogId: string | null;
}

/** 写操作上下文（ip / userAgent / requestId 取不到时传 null） */
export interface AdminRoleUpdateContext {
  operatorAdminId: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

@Injectable()
export class AdminRoleService {
  private readonly logger = new Logger(AdminRoleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokens: AdminTokenService,
    private readonly audit: AdminAuditService,
  ) {}

  // ==========================================================================
  // GET /admin/roles
  // ==========================================================================

  /**
   * 角色列表 + 全部权限点清单
   *
   * `adminCount` 用**一次 `groupBy`** 批量统计，而不是在循环里对每个角色查一次
   * （角色通常只有个位数，但 N+1 是那种"今天没事、明天加了 50 个自定义角色就慢"的写法）。
   */
  async listRoles(): Promise<AdminRoleListView> {
    const [roles, adminCountRows] = await Promise.all([
      this.prisma.role.findMany({
        where: { deletedAt: null }, // 软删角色不得出现在配置界面，否则会被误当成可用角色
        // 内置角色在前（配置界面先展示系统角色），其余按 sortOrder / 创建时间稳定排序
        orderBy: [{ isSystem: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          isSystem: true,
          createdAt: true,
          updatedAt: true,
          permissions: { select: { permission: { select: { code: true } } } },
        },
      }),
      this.prisma.adminUserRole.groupBy({
        by: ['roleId'],
        // 已软删管理员不计入影响面：他们不再持有任何权限
        where: { adminUser: { deletedAt: null } },
        _count: { _all: true },
      }),
    ]);

    const adminCountByRoleId = new Map<string, number>();
    for (const row of adminCountRows) {
      adminCountByRoleId.set(row.roleId, row._count._all);
    }

    return {
      roles: roles.map((role) => this.toRoleView(role, adminCountByRoleId.get(role.id) ?? 0)),
      allPermissions: this.buildAllPermissions(),
      totalRoles: roles.length,
      totalPermissions: ALL_ADMIN_PERMISSIONS.length,
      permissionNamingRule: PERMISSION_NAMING_RULE,
    };
  }

  // ==========================================================================
  // PATCH /admin/roles/{id}
  // ==========================================================================

  /**
   * 修改角色的权限集合（覆盖语义）与名称/描述
   *
   * 步骤刻意保持这个顺序：**先做全部校验 → 再写库 → 最后撤销会话 + 写审计**。
   * 任何校验失败都必须发生在写库之前，否则会出现「接口报错但权限已被改掉」。
   */
  async updateRole(
    roleId: string,
    dto: AdminRoleUpdateDto,
    context: AdminRoleUpdateContext,
  ): Promise<AdminRoleUpdateView> {
    if (!UUID_PATTERN.test(roleId)) {
      // 非 UUID 一律按「角色不存在」处理，避免把参数格式问题暴露成 500
      throw BusinessException.notFound(ErrorCode.ROLE_NOT_FOUND, '角色不存在');
    }

    const role = await this.prisma.role.findFirst({
      where: { id: roleId, deletedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        isSystem: true,
        permissions: { select: { permission: { select: { code: true } } } },
      },
    });

    if (!role) {
      throw BusinessException.notFound(ErrorCode.ROLE_NOT_FOUND, '角色不存在');
    }

    // 契约 §3.14.9.8 规则 4：防「先建高权角色再赋给自己」的提权链
    if (role.code === SUPER_ADMIN_ROLE_CODE) {
      throw BusinessException.forbidden(ErrorCode.PERMISSION_DENIED, '超级管理员角色不可修改');
    }

    const permissionsBefore = this.normalizePermissionCodes(role.permissions.map((rp) => rp.permission.code));
    const permissionsAfter = this.assertPermissionsAllowed(dto.permissions);

    const nextName = this.resolveNextRoleName(role, dto.roleName);
    const nextDescription = dto.description === undefined ? role.description : dto.description;

    const added = permissionsAfter.filter((code) => !permissionsBefore.includes(code));
    const removed = permissionsBefore.filter((code) => !permissionsAfter.includes(code));

    // 自锁死护栏必须在写库**之前**判定，否则拦下来的是"已经改坏"的状态
    await this.assertStillManageable(role.id, permissionsBefore, permissionsAfter);

    const permissionIds = await this.resolvePermissionIds(permissionsAfter);

    const updatedAt = await this.prisma.$transaction(async (tx) => {
      /**
       * 即使只改了权限点也照常更新角色行：`updated_at` 是 `@updatedAt` 自动维护的，
       * 不更新角色行的话「权限变了但 `updatedAt` 没变」，前端与审计都无法据此判断
       * 这条角色配置最后一次变更发生在什么时候。
       */
      const updated = await tx.role.update({
        where: { id: role.id },
        data: { name: nextName, description: nextDescription },
      });

      // 覆盖语义：先清空再落盘，等价于「集合替换」。增量更新会留下并发修改的漂移，
      // 这正是契约选择覆盖语义的原因。
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });

      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })),
        });
      }

      return updated.updatedAt;
    });

    const affectedAdmins = await this.findAffectedAdmins(role.id);

    /**
     * 撤销会话 = 本仓库实现「权限即时生效」的唯一手段（见文件头）。
     *
     * 单个管理员撤销失败只记日志、不让整个请求失败：数据库变更已经提交，
     * 把它变成 500 只会让调用方重试并重复写审计；而漏撤的会话会在
     * RefreshToken 旋转时重新解析权限（`AdminAuthService.refresh`），
     * 影响窗口不超过 access token 的 1 小时寿命。
     */
    const revokedSessionCount = await this.revokeAffectedSessions(affectedAdmins, role.id);

    const riskWarnings = this.buildRiskWarnings(added, removed);
    await this.appendOperatorSelfLockWarning(riskWarnings, {
      operatorAdminId: context.operatorAdminId,
      permissionsBefore,
      permissionsAfter,
      affectedAdmins,
    });

    const operator = await this.prisma.adminUser.findUnique({
      where: { id: context.operatorAdminId },
      select: { username: true, nickname: true },
    });

    const beforeData = {
      roleName: role.name,
      description: role.description,
      permissions: permissionsBefore,
    };
    const afterData = {
      roleName: nextName,
      description: nextDescription,
      permissions: permissionsAfter,
    };

    await this.audit.log({
      adminUserId: context.operatorAdminId,
      // 账号被删后审计仍要能追责，故冗余存储用户名（与 AdminAuditService 的约定一致）
      adminUsername: operator?.username ?? '(unknown)',
      action: 'UPDATE',
      resourceType: 'ROLE',
      resourceId: role.id,
      beforeData,
      afterData,
      diffSummary: this.audit.buildDiffSummary(beforeData, afterData) ?? '角色配置未发生实质变化',
      reason: dto.reason,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
      success: true,
    });

    this.logger.log(
      `角色权限已更新 roleId=${role.id} roleCode=${role.code} added=${added.length} removed=${removed.length} affectedAdmins=${affectedAdmins.length} revokedSessions=${revokedSessionCount}`,
    );

    return {
      roleId: role.id,
      roleCode: role.code,
      roleName: nextName,
      description: nextDescription,
      permissionsBefore,
      permissionsAfter,
      addedPermissions: added,
      removedPermissions: removed,
      permissionDelta: {
        added: added.length,
        removed: removed.length,
        before: permissionsBefore.length,
        after: permissionsAfter.length,
      },
      affectedAdmins,
      affectedAdminCount: affectedAdmins.length,
      requiresReLogin: true,
      permissionCacheInvalidated: true,
      note: this.buildNote(),
      riskWarnings,
      reason: dto.reason,
      updatedAt: updatedAt.toISOString(),
      updatedBy: {
        adminId: context.operatorAdminId,
        // 与受影响管理员同一口径：优先昵称，其次登录名
        displayName: operator?.nickname ?? operator?.username ?? '(unknown)',
      },
      auditLogId: null,
    };
  }

  // ==========================================================================
  // 校验
  // ==========================================================================

  /**
   * 权限点白名单与数量校验
   *
   * 数量上限取 `ALL_ADMIN_PERMISSIONS.length`（本仓库为 25，契约写 24）。
   * 注意：这条上限在**白名单校验通过后其实不可达**（全部是白名单内的码，去重后
   * 天然 ≤ 25）。仍然保留，是为了在权限点被扩充、或未来放开白名单时有一道兜底 ——
   * 契约里的 `10016`（超过 24 个）在本仓库的错误码表中不存在，统一用 `10001`。
   */
  private assertPermissionsAllowed(input: readonly string[]): string[] {
    const unique = [...new Set(input)];

    if (unique.length > ALL_ADMIN_PERMISSIONS.length) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `permissions 去重后不能超过 ${ALL_ADMIN_PERMISSIONS.length} 个`,
      );
    }

    const unknown = unique.filter((code) => !KNOWN_PERMISSION_CODES.has(code));

    if (unknown.length > 0) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `存在不在白名单内的权限点：${unknown.join('、')}`,
        unknown.map((code) => ({ field: 'permissions', issue: '权限点不在白名单内', value: code })),
      );
    }

    // 排序后再落盘与返回：同一集合不因传入顺序不同而产生不同的 before/after 文本，
    // 审计 diff 与「幂等」语义才成立
    return unique.sort();
  }

  /**
   * 角色名称变更校验
   *
   * 内置角色的名称与前端菜单映射耦合（前端按 `roleCode` 选图标与入口，按名称展示），
   * 允许改名会让「运营」变成「超级管理员」这类视觉欺骗，因此只有自定义角色可改名。
   * 传入与现值相同的名称视为「没改」，不报错 —— 客户端回传完整对象是常见做法。
   */
  private resolveNextRoleName(role: { name: string; isSystem: boolean }, requested?: string): string {
    if (requested === undefined || requested === role.name) {
      return role.name;
    }

    if (role.isSystem) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '内置角色名称不可修改');
    }

    return requested;
  }

  /**
   * 自锁死护栏
   *
   * 判定式（修改后仍能管理角色的账号数）：
   *   1. `isSuperAdmin = true` 且未软删的管理员 —— 他们经由 `*` **恒**持有
   *      `system:role:write`（`AdminRbacService.resolve` 不查角色表，见该服务注释）；
   *   2. 关联到「权限集合含 `system:role:write`」的**其它**角色的未软删管理员；
   *   3. 若本次修改后的集合仍含 `system:role:write`，本角色现有的未软删管理员也算。
   * 三者合计为 0 则拒绝。
   *
   * ⚠ 本判定**只检查「是否由本次修改造成」**：若改动前后都不含 `system:role:write`
   *   （例如给一个无关角色加权限），说明系统在修改前就已经没有管理角色的入口了，
   *   此时拦截只会让管理员连修复的机会都没有 —— 那不是护栏，是把人锁在门外。
   *
   * ⚠ 口径说明：这里不区分 `admin_user_roles.expiresAt` 是否已过期（与列表接口的
   *   `adminCount` 一致，都以关联行为准）。过期授予会在 `AdminRbacService.resolve`
   *   侧失效，若库里积累了大量未清理的过期授予，本护栏会偏宽松，运维应定期清理。
   */
  private async assertStillManageable(
    roleId: string,
    permissionsBefore: readonly string[],
    permissionsAfter: readonly string[],
  ): Promise<void> {
    const beforeHad = permissionsBefore.includes(ADMIN_PERMISSIONS.ROLE_WRITE);
    const afterHas = permissionsAfter.includes(ADMIN_PERMISSIONS.ROLE_WRITE);

    // 没有「移除」这个权限点，就不可能出现由本次修改导致的自锁死
    if (!beforeHad || afterHas) {
      return;
    }

    const [superAdminCount, otherHolderIds] = await Promise.all([
      this.prisma.adminUser.count({ where: { isSuperAdmin: true, deletedAt: null } }),
      this.findAdminsHoldingRoleWriteExcluding(roleId),
    ]);

    if (superAdminCount + otherHolderIds.size > 0) {
      return;
    }

    throw BusinessException.forbidden(
      ErrorCode.OPERATION_FORBIDDEN,
      '该修改会导致没有任何账号能继续管理角色与权限，已阻止',
    );
  }

  /**
   * 除本角色外，还有哪些（未软删）管理员通过其它角色持有 `system:role:write`
   *
   * 用「角色 → 权限」反查再取管理员，而不是取全部关联行到内存里过滤：
   * 前者只回传可能相关的那几个角色，后者会随管理员数量线性增长。
   */
  private async findAdminsHoldingRoleWriteExcluding(roleId: string): Promise<Set<string>> {
    const rolesWithWrite = await this.prisma.role.findMany({
      where: {
        deletedAt: null,
        id: { not: roleId },
        permissions: { some: { permission: { code: ADMIN_PERMISSIONS.ROLE_WRITE } } },
      },
      select: { id: true },
    });

    if (rolesWithWrite.length === 0) {
      return new Set<string>();
    }

    const grants = await this.prisma.adminUserRole.findMany({
      where: {
        roleId: { in: rolesWithWrite.map((item) => item.id) },
        adminUser: { deletedAt: null },
      },
      select: { adminUserId: true },
    });

    // 同一管理员可能持多个角色，去重后才是「账号数」
    return new Set(grants.map((grant) => grant.adminUserId));
  }

  /**
   * 权限点码 → id
   *
   * 白名单里有、但 `permissions` 表里没有，说明代码与 seed 发生了漂移。
   * 这种情况**必须报错**而不是静默跳过：静默跳过会让管理员看到「保存成功」，
   * 而角色实际上少了几个权限 —— 之后排查「为什么这个按钮点不动」会非常痛苦。
   */
  private async resolvePermissionIds(permissionCodes: readonly string[]): Promise<string[]> {
    if (permissionCodes.length === 0) {
      return [];
    }

    const rows = await this.prisma.permission.findMany({
      where: { code: { in: [...permissionCodes] } },
      select: { id: true, code: true },
    });

    const idByCode = new Map(rows.map((row) => [row.code, row.id]));
    const missing = permissionCodes.filter((code) => !idByCode.has(code));

    if (missing.length > 0) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `权限点数据未初始化：${missing.join('、')}（请先执行 prisma:seed）`,
      );
    }

    return permissionCodes.map((code) => {
      const id = idByCode.get(code);
      // 上面已经确认存在；这里显式抛错是为了让类型收窄到 string（而非 string | undefined）
      if (!id) {
        throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `权限点数据未初始化：${code}`);
      }
      return id;
    });
  }

  // ==========================================================================
  // 影响面、风险提示、审计
  // ==========================================================================

  /**
   * 受影响的（未软删）管理员
   *
   * `isCurrentlyOnline` 直接**读** `AdminTokenService` 的会话集合键
   * （`sm:admin:sessions:{adminUserId}`，键名约定见该服务的 `adminSessionsKey`）。
   * 为什么不调它的私有方法或新增公开方法：那需要修改既有文件（本次任务不允许），
   * 而「只读地复用键格式」不会改变任何既有行为；风险是键格式若变更此处会静默失效 ——
   * 表现为 `isCurrentlyOnline` 恒为 false（只是一个展示字段，不会影响权限判定）。
   * Redis 不可用时同样保守返回 `false`，绝不因为缓存故障让整个接口 500。
   */
  private async findAffectedAdmins(roleId: string): Promise<AffectedAdminView[]> {
    const grants = await this.prisma.adminUserRole.findMany({
      where: { roleId, adminUser: { deletedAt: null } },
      select: { adminUserId: true, adminUser: { select: { username: true, nickname: true } } },
    });

    const uniqueAdmins = new Map<string, string>();
    for (const grant of grants) {
      if (uniqueAdmins.has(grant.adminUserId)) continue;
      uniqueAdmins.set(grant.adminUserId, grant.adminUser.nickname ?? grant.adminUser.username);
    }

    return Promise.all(
      [...uniqueAdmins.entries()].map(async ([adminId, displayName]) => ({
        adminId,
        displayName,
        isCurrentlyOnline: await this.isAdminOnline(adminId),
      })),
    );
  }

  private async isAdminOnline(adminUserId: string): Promise<boolean> {
    try {
      const sessionCount = await this.redis.sCard(this.redis.key('admin', 'sessions', adminUserId));
      return sessionCount > 0;
    } catch (error) {
      this.logger.warn(
        `查询管理员在线状态失败（保守返回 false）adminUserId=${adminUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /** 撤销全部受影响管理员的会话（权限即时生效的实现手段，见文件头） */
  private async revokeAffectedSessions(affectedAdmins: AffectedAdminView[], roleId: string): Promise<number> {
    let revoked = 0;

    for (const admin of affectedAdmins) {
      try {
        revoked += await this.tokens.revokeAllSessions(admin.adminId, REVOKE_REASON);
      } catch (error) {
        this.logger.error(
          `撤销管理员会话失败（其令牌上的旧权限将保留至过期）adminUserId=${admin.adminId} roleId=${roleId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return revoked;
  }

  /**
   * CRITICAL 级权限的增删提示
   *
   * `severity` 取 `allPermissions` 表（契约 §3.14.9.7）里的值，与界面展示同源 ——
   * 否则会出现「界面标红、接口不提示」的不一致。未知权限点（例如有人给角色手工配了
   * 通配符 `*`）没有等级，静默跳过：它不是 CRITICAL 权限点的增删事件。
   */
  private buildRiskWarnings(added: readonly string[], removed: readonly string[]): AdminRiskWarning[] {
    const warnings: AdminRiskWarning[] = [];

    for (const code of removed) {
      if (this.severityOf(code) !== 'CRITICAL') continue;
      warnings.push({
        code: 'CRITICAL_PERMISSION_REMOVED',
        message: `本次移除了 ${code}（CRITICAL 级权限），该角色将无法再执行对应操作，请确认是否为预期调整。`,
      });
    }

    for (const code of added) {
      if (this.severityOf(code) !== 'CRITICAL') continue;
      warnings.push({
        code: 'CRITICAL_PERMISSION_GRANTED',
        message: `本次授予了 ${code}（CRITICAL 级权限），使用该角色的账号将获得高风险能力，请确认是否为预期调整。`,
      });
    }

    return warnings;
  }

  /**
   * 操作者本人失去 `system:role:write` 时的额外提示
   *
   * 护栏只在「全系统无人可管理角色」时拦截；只要还有人持有该权限，操作者把自己
   * 锁在外面是**允许**的（可能是刻意的交接），但必须明确告知 —— 保存成功的那一刻
   * 他的会话就被撤销了，再点任何管理接口都会 403，没有提示会以为系统坏了。
   *
   * 用的是契约两个码之外的第三个码：这两种情形（"角色少了一个权限" vs
   * "操作者自己失去入口"）在前端需要不同的引导文案，混用同一个码会让前端无法区分。
   */
  private async appendOperatorSelfLockWarning(
    warnings: AdminRiskWarning[],
    input: {
      operatorAdminId: string;
      permissionsBefore: readonly string[];
      permissionsAfter: readonly string[];
      affectedAdmins: readonly AffectedAdminView[];
    },
  ): Promise<void> {
    const removesWrite = input.permissionsBefore.includes(ADMIN_PERMISSIONS.ROLE_WRITE);
    const stillHasWrite = input.permissionsAfter.includes(ADMIN_PERMISSIONS.ROLE_WRITE);

    if (!removesWrite || stillHasWrite) return;

    // 超管通过 `*` 恒持有该权限，把角色权限清空也不影响他自己
    const operator = await this.prisma.adminUser.findUnique({
      where: { id: input.operatorAdminId },
      select: { isSuperAdmin: true },
    });
    if (operator?.isSuperAdmin) return;

    const holdsThisRole = input.affectedAdmins.some((admin) => admin.adminId === input.operatorAdminId);
    if (!holdsThisRole) return;

    warnings.push({
      code: 'OPERATOR_LOSES_ROLE_WRITE',
      message:
        '本次修改会让你本人失去 system:role:write 权限，保存后你的全部会话将被撤销，重新登录后也将无法再进入角色管理，请确认是否已完成交接。',
    });
  }

  /** 权限即时生效的说明文案（契约与实现的差异写在这里，供前端直接展示给管理员） */
  private buildNote(): string {
    return [
      '本仓库把角色与权限点写进了管理员令牌，鉴权守卫只校验会话存在、不会重新查库，',
      '因此权限变更通过**撤销受影响管理员的全部会话**实现即时生效：受影响账号需重新登录',
      '后才会拿到新的权限集合。契约 §3.14.9.8 规则 2 假设权限在守卫层实时查询缓存，',
      '故契约中该字段为 false，本实现返回 true，属刻意的实现差异。',
    ].join('');
  }

  // ==========================================================================
  // 纯函数工具
  // ==========================================================================

  /**
   * 规范化权限点集合：去重 + 排序
   *
   * 排序是为了让 before/after 在日志、审计与响应里保持一致形态；
   * 去重是为了防御 `role_permissions` 里出现同一权限点的重复行（唯一约束保证不会，
   * 但显式去重的成本为零，且能让 diff 计算不产生空集假象）。
   */
  private normalizePermissionCodes(codes: readonly string[]): string[] {
    return [...new Set(codes)].sort();
  }

  private severityOf(code: string): AdminPermissionSeverity | null {
    if (!this.isKnownPermission(code)) return null;
    return ADMIN_PERMISSION_CATALOG[code].severity;
  }

  private isKnownPermission(code: string): code is keyof typeof ADMIN_PERMISSION_CATALOG {
    return KNOWN_PERMISSION_CODES.has(code);
  }

  /**
   * 角色 → 视图
   *
   * `SUPER_ADMIN` 的权限固定返回通配符 `['*']`，而不是它在 `role_permissions` 里
   * 实际关联的行：seed 刻意不为超管写映射（`*` 不是真实权限点），而
   * `AdminRbacService.resolve` 对 `isSuperAdmin` 的管理员也直接给 `*`。
   * 两边口径必须一致，否则界面显示超管"没有权限"，与事实完全相反。
   */
  private toRoleView(
    role: {
      id: string;
      code: string;
      name: string;
      description: string | null;
      isSystem: boolean;
      createdAt: Date;
      updatedAt: Date;
      permissions: Array<{ permission: { code: string } }>;
    },
    adminCount: number,
  ): AdminRoleView {
    const isSuperAdminRole = role.code === SUPER_ADMIN_ROLE_CODE;

    return {
      roleId: role.id,
      roleCode: role.code,
      roleName: role.name,
      description: role.description,
      isSystem: role.isSystem,
      isEditable: !isSuperAdminRole,
      permissions: isSuperAdminRole
        ? [PERMISSION_WILDCARD]
        : this.normalizePermissionCodes(role.permissions.map((rp) => rp.permission.code)),
      adminCount,
      createdAt: role.createdAt.toISOString(),
      updatedAt: role.updatedAt.toISOString(),
    };
  }

  /**
   * 全部权限点按领域分组
   *
   * 领域取自权限点码的前缀（`<domain>:<resource>:<action>`），而不是另存一张表：
   * 前缀就是领域定义本身，多存一份必然漂移。未知领域（新增权限点引入了契约之外的
   * 领域）会被**追加在最后**而不是丢弃 —— 界面上少一项权限点意味着"配不了"，
   * 比"排在了最后"严重得多。
   */
  private buildAllPermissions(): AdminPermissionGroupView[] {
    const itemsByDomain = new Map<string, AdminPermissionItemView[]>();

    for (const code of ALL_ADMIN_PERMISSIONS) {
      const domain = code.split(':')[0];
      const items = itemsByDomain.get(domain) ?? [];
      items.push(this.toPermissionItemView(code));
      itemsByDomain.set(domain, items);
    }

    const domainRank = (domain: string): number => {
      const index = ADMIN_PERMISSION_DOMAIN_ORDER.indexOf(domain);
      return index === -1 ? ADMIN_PERMISSION_DOMAIN_ORDER.length : index;
    };

    return [...itemsByDomain.keys()]
      .sort((a, b) => domainRank(a) - domainRank(b))
      .map((domain) => ({
        domain,
        domainName: ADMIN_PERMISSION_DOMAIN_NAMES[domain] ?? domain,
        items: itemsByDomain.get(domain) ?? [],
      }));
  }

  private toPermissionItemView(code: string): AdminPermissionItemView {
    if (!this.isKnownPermission(code)) {
      // 代码与常量表漂移时不给界面编造等级，但仍把权限点列出来
      return { permission: code, name: code, severity: 'NORMAL', description: '未登记的权限点' };
    }

    const meta = ADMIN_PERMISSION_CATALOG[code];

    return { permission: code, name: meta.name, severity: meta.severity, description: meta.description };
  }
}
