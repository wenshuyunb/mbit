/**
 * 角色服务测试（契约 §3.14.9.7 / §3.14.9.8）
 *
 * 聚焦「改错权限会直接造成越权或自锁死」这类后果：
 *   · 列表必须能区分 `SUPER_ADMIN`（不可编辑、权限为 `*`）与其它角色
 *   · `allPermissions` 的分组、文案与总数必须与契约逐条一致（前端据此渲染配置界面）
 *   · PATCH 是**覆盖语义**，before/after 与 delta 必须准确（前端与审计都依赖它）
 *   · 改超管、非白名单权限点、内置角色改名 → 一律拒绝，且**不得写库**
 *   · 改动会导致「没有任何账号还能管理角色」→ 拒绝（自锁死护栏）
 *   · 成功时必须撤销受影响管理员的会话（本仓库权限即时生效的唯一手段）并写审计
 *   · 审计里不得出现任何密码/凭据
 *
 * 手写 Prisma 桩（参照 `personality.service.spec.ts` 的做法）：不连数据库、
 * 不依赖 testcontainers，使这些安全用例能在任何环境（含 CI 无 DB）里跑。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import type { BusinessException } from '../../../common/errors/business.exception';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import { AdminAuditService, type AdminAuditEntry } from '../audit/admin-audit.service';
import type { AdminTokenService } from '../auth/admin-token.service';
import { ALL_ADMIN_PERMISSIONS } from '../rbac/admin-permission.constants';
import {
  AdminRoleService,
  type AdminPermissionItemView,
  type AdminRoleListView,
  type AdminRoleUpdateContext,
} from './admin-role.service';
import type { AdminRoleUpdateDto } from './dto/admin-role.dto';

// ============================================================================
// 夹具
// ============================================================================

const SUPER_ROLE_ID = '0195f3a2-2ad0-7f42-8b57-e5ca2d3e4b2f';
const ROLE_ID = '0195f3a2-2be1-7a53-9c68-f6db3e4f5c3a';
const CUSTOM_ROLE_ID = '0195f3a2-2cf2-7b64-8d79-a7ec4f5a6d4b';
const OPERATOR_ADMIN_ID = '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a';
const OTHER_ADMIN_ID = '0195f3a2-09cf-7bfd-9c68-e4bf1c2d3a1f';

const ROLE_WRITE = 'system:role:write';
const ROLE_READ = 'system:role:read';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-02-14T22:30:00.000Z');

/** 权限点码 → Prisma 的嵌套 select 形态 */
const toRolePermissions = (codes: readonly string[]): Array<{ permission: { code: string } }> =>
  codes.map((code) => ({ permission: { code } }));

const roleRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ROLE_ID,
  code: 'OPERATOR',
  name: '客服运营',
  description: '用户与内容只读 + 客服操作（封禁/解封）',
  isSystem: true,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  permissions: [],
  ...overrides,
});

/** 全部权限点在 `permissions` 表里的映射（id 用 `perm:<code>` 便于断言） */
const permissionRows = (codes: readonly string[] = ALL_ADMIN_PERMISSIONS): Array<{ id: string; code: string }> =>
  codes.map((code) => ({ id: `perm:${code}`, code }));

const dto = (overrides: Partial<AdminRoleUpdateDto> = {}): AdminRoleUpdateDto => ({
  permissions: [],
  reason: '调整客服运营的权限映射以支持审计自查',
  ...overrides,
});

const context: AdminRoleUpdateContext = {
  operatorAdminId: OPERATOR_ADMIN_ID,
  ip: '10.0.0.1',
  userAgent: 'jest-agent',
  requestId: 'req_01HQ8Z3K7M2XQ9V4T6B1NDCFA5',
};

/** 取回业务异常（避免 `rejects.toMatchObject` 无法断言 code/status 之外的信息） */
const catchError = async (promise: Promise<unknown>): Promise<BusinessException> => {
  try {
    await promise;
  } catch (error) {
    return error as BusinessException;
  }

  throw new Error('预期抛出 BusinessException，但调用成功返回了');
};

// ============================================================================
// Prisma 桩
// ============================================================================

/** 事务客户端桩：只包含服务在事务里用到的两张表 */
interface TxStub {
  role: { update: jest.Mock };
  rolePermission: { deleteMany: jest.Mock; createMany: jest.Mock };
}

interface PrismaStub {
  /** 测试可按需改写的关联数据（用于区分"影响面"与"护栏"两次查询的返回） */
  state: { affectedAdmins: Array<Record<string, unknown>>; writeHolders: Array<Record<string, unknown>> };
  tx: TxStub;
  role: { findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  permission: { findMany: jest.Mock };
  adminUserRole: { groupBy: jest.Mock; findMany: jest.Mock };
  adminUser: { count: jest.Mock; findUnique: jest.Mock };
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const state: PrismaStub['state'] = {
    affectedAdmins: [],
    writeHolders: [],
  };

  const tx: TxStub = {
    role: { update: jest.fn().mockResolvedValue({ ...roleRow(), updatedAt: UPDATED_AT }) },
    rolePermission: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  const prisma: PrismaStub = {
    state,
    tx,
    role: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    permission: {
      findMany: jest
        .fn()
        .mockImplementation((args: { where: { code: { in: string[] } } }) =>
          Promise.resolve(permissionRows().filter((row) => args.where.code.in.includes(row.code))),
        ),
    },
    adminUserRole: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockImplementation((args: { select?: Record<string, unknown> }) =>
        // 影响面查询会 select 关联的 adminUser；护栏查询只 select adminUserId
        Promise.resolve(args?.select?.['adminUser'] ? state.affectedAdmins : state.writeHolders),
      ),
    },
    adminUser: {
      // 默认"存在超管"：护栏大多数用例不该被触发，需要触发的用例显式改 0
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue({ username: 'root', nickname: '超级管理员', isSuperAdmin: true }),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };

  return prisma;
};

/** 被测服务与其全部替身的组合 */
interface Harness {
  prisma: PrismaStub;
  tx: TxStub;
  redis: { key: jest.Mock; sCard: jest.Mock };
  tokens: { revokeAllSessions: jest.Mock };
  audit: AdminAuditService;
  /** `AdminAuditService.log` 的 spy（保留真实 buildDiffSummary，只替换写库那一跳） */
  auditLog: jest.SpyInstance<Promise<boolean>, [entry: AdminAuditEntry]>;
  service: AdminRoleService;
}

const createHarness = (): Harness => {
  const prisma = createPrismaStub();

  // 用**真实**的 AdminAuditService（只依赖 Prisma），这样 buildDiffSummary 也一起被测到
  const audit = new AdminAuditService(prisma as unknown as PrismaService);
  const auditLog = jest.spyOn(audit, 'log').mockResolvedValue(true);

  const redis = {
    key: jest.fn((...parts: Array<string | number>) => parts.join(':')),
    sCard: jest.fn().mockResolvedValue(0),
  };

  const tokens = { revokeAllSessions: jest.fn().mockResolvedValue(1) };

  const service = new AdminRoleService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    tokens as unknown as AdminTokenService,
    audit,
  );

  return { prisma, tx: prisma.tx, redis, tokens, audit, auditLog, service };
};

/** 从分组结果里按权限点码取一条 */
const findPermissionItem = (view: AdminRoleListView, code: string): AdminPermissionItemView | undefined => {
  for (const group of view.allPermissions) {
    const item = group.items.find((candidate) => candidate.permission === code);
    if (item) return item;
  }
  return undefined;
};

// ============================================================================
// 测试
// ============================================================================

describe('AdminRoleService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  // ==========================================================================
  // GET /admin/roles
  // ==========================================================================

  describe('listRoles', () => {
    it('SUPER_ADMIN 的 isEditable 为 false 且权限为通配符，其余角色可编辑', async () => {
      harness.prisma.role.findMany.mockResolvedValue([
        roleRow({
          id: SUPER_ROLE_ID,
          code: 'SUPER_ADMIN',
          name: '超级管理员',
          description: '拥有全部权限，仅限创始人使用',
          isSystem: true,
          permissions: [],
        }),
        roleRow({
          id: ROLE_ID,
          code: 'OPERATOR',
          permissions: toRolePermissions(['user:user:read', 'payment:order:read']),
        }),
        roleRow({ id: CUSTOM_ROLE_ID, code: 'CUSTOM_CS', name: '自定义客服', isSystem: false, permissions: [] }),
      ]);
      harness.prisma.adminUserRole.groupBy.mockResolvedValue([
        { roleId: SUPER_ROLE_ID, _count: { _all: 1 } },
        { roleId: ROLE_ID, _count: { _all: 2 } },
      ]);

      const view = await harness.service.listRoles();

      expect(view.roles[0]).toMatchObject({
        roleId: SUPER_ROLE_ID,
        roleCode: 'SUPER_ADMIN',
        isSystem: true,
        isEditable: false,
        // 与 AdminRbacService.resolve 的口径一致：超管权限是 `*`，不读 role_permissions
        permissions: ['*'],
        adminCount: 1,
      });
      // 其它内置角色可编辑（契约 §3.14.9.7 的示例中 OPERATOR 就是 isEditable: true）
      expect(view.roles[1]).toMatchObject({ roleCode: 'OPERATOR', isEditable: true, adminCount: 2 });
      // 权限点排序稳定，便于前端 diff 与审计对比
      expect(view.roles[1]?.['permissions']).toEqual(['payment:order:read', 'user:user:read']);
      // 自定义角色同样可编辑；groupBy 没有它的行 → 0 而不是 undefined
      expect(view.roles[2]).toMatchObject({ roleCode: 'CUSTOM_CS', isEditable: true, adminCount: 0 });

      expect(view.totalRoles).toBe(3);
      // 时间统一为 ISO 字符串（契约示例即 ISO）
      expect(view.roles[0]?.['createdAt']).toBe(CREATED_AT.toISOString());
    });

    it('只查未软删的角色，且 adminCount 只统计未软删管理员（一次 groupBy，无 N+1）', async () => {
      await harness.service.listRoles();

      expect(harness.prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } }),
      );
      expect(harness.prisma.adminUserRole.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['roleId'], where: { adminUser: { deletedAt: null } } }),
      );
      expect(harness.prisma.adminUserRole.groupBy).toHaveBeenCalledTimes(1);
    });

    it('allPermissions：8 个领域按契约顺序分组，权限点总数为代码里的 25（契约写 24）', async () => {
      const view = await harness.service.listRoles();

      expect(view.allPermissions.map((group) => group.domain)).toEqual([
        'user',
        'test',
        'ai',
        'payment',
        'relationship',
        'report',
        'system',
        'dashboard',
      ]);
      expect(view.allPermissions.map((group) => group.domainName)).toEqual([
        '用户',
        '测试与题库',
        'AI',
        '支付与资金',
        '关系',
        '报告',
        '系统治理',
        '数据看板',
      ]);

      // 分组内的条目总数必须等于真实权限点总数，一个都不能漏
      const totalItems = view.allPermissions.reduce((sum, group) => sum + group.items.length, 0);
      expect(totalItems).toBe(ALL_ADMIN_PERMISSIONS.length);
      expect(view.totalPermissions).toBe(ALL_ADMIN_PERMISSIONS.length);
      // 契约 §3.14.9.7 写的是 24，代码是 25 —— 以代码为准，此处把这个差异钉住
      expect(view.totalPermissions).toBe(25);

      expect(view.permissionNamingRule).toBe('<domain>:<resource>:<action>（架构 9.3）');
    });

    it('allPermissions：逐条照抄契约的 name / severity / description', async () => {
      const view = await harness.service.listRoles();

      expect(findPermissionItem(view, 'user:user:read')).toEqual({
        permission: 'user:user:read',
        name: '查看用户',
        severity: 'NORMAL',
        description: '查询用户列表与详情（敏感字段脱敏）',
      });
      expect(findPermissionItem(view, 'user:user:write')).toEqual({
        permission: 'user:user:write',
        name: '修改用户',
        // 契约 §3.14.9.7 标 CRITICAL、§3.14.9.3 审计表标 SENSITIVE —— 这里按前者
        severity: 'CRITICAL',
        description: '封禁/解封用户',
      });
      expect(findPermissionItem(view, 'payment:order:refund')).toEqual({
        permission: 'payment:order:refund',
        name: '发起退款',
        severity: 'CRITICAL',
        description: '全额/部分退款并撤销权益',
      });
      expect(findPermissionItem(view, 'payment:order:export')?.['severity']).toBe('CRITICAL');
      expect(findPermissionItem(view, 'ai:prompt:publish')?.['severity']).toBe('CRITICAL');
      expect(findPermissionItem(view, 'system:role:write')).toMatchObject({
        name: '管理角色',
        severity: 'CRITICAL',
        description: '修改角色权限映射',
      });
      expect(findPermissionItem(view, 'system:audit:read')?.['severity']).toBe('SENSITIVE');
      expect(findPermissionItem(view, 'dashboard:metrics:read')).toMatchObject({
        name: '查看指标看板',
        severity: 'NORMAL',
      });

      // 每一项都必须有中文名与说明，否则配置界面会出现空白选项
      for (const group of view.allPermissions) {
        for (const item of group.items) {
          expect(item.name.length).toBeGreaterThan(0);
          expect(item.description.length).toBeGreaterThan(0);
          expect(['NORMAL', 'SENSITIVE', 'CRITICAL']).toContain(item.severity);
        }
      }
    });
  });

  // ==========================================================================
  // PATCH /admin/roles/{id}
  // ==========================================================================

  describe('updateRole', () => {
    it('覆盖语义：before/after、added/removed 与 delta 正确，落盘为"先清空再写入"', async () => {
      const before = ['user:user:read', 'user:user:write', 'payment:order:refund'];
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: toRolePermissions(before) }));

      const after = ['user:user:read', 'payment:order:refund', 'system:audit:read'];
      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: after }), context);

      expect(view.permissionsBefore).toEqual([...before].sort());
      expect(view.permissionsAfter).toEqual([...after].sort());
      expect(view.addedPermissions).toEqual(['system:audit:read']);
      expect(view.removedPermissions).toEqual(['user:user:write']);
      expect(view.permissionDelta).toEqual({ added: 1, removed: 1, before: 3, after: 3 });
      expect(view.updatedAt).toBe(UPDATED_AT.toISOString());
      expect(view.auditLogId).toBeNull();

      // 覆盖语义 = 先删干净再插入（增量更新会留下并发漂移）
      expect(harness.tx.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: ROLE_ID } });
      const created = harness.tx.rolePermission.createMany.mock.calls[0]?.[0] as {
        data: Array<{ roleId: string; permissionId: string }>;
      };
      expect(created.data.map((row) => row.permissionId).sort()).toEqual(
        [...after].sort().map((code) => `perm:${code}`),
      );
    });

    it('permissions 去重：重复项被静默合并，不报错也不重复写关联', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));

      const view = await harness.service.updateRole(
        ROLE_ID,
        dto({ permissions: ['user:user:read', 'user:user:read', 'user:user:read'] }),
        context,
      );

      expect(view.permissionsAfter).toEqual(['user:user:read']);
      expect(view.permissionDelta).toEqual({ added: 1, removed: 0, before: 0, after: 1 });
    });

    it('传空数组表示清空该角色的全部权限', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: toRolePermissions(['user:user:read']) }));

      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: [] }), context);

      expect(view.permissionsAfter).toEqual([]);
      expect(view.permissionDelta).toEqual({ added: 0, removed: 1, before: 1, after: 0 });
      expect(harness.tx.rolePermission.createMany).not.toHaveBeenCalled();
      // 空集合不必查 permissions 表（少一次无意义的查询）
      expect(harness.prisma.permission.findMany).not.toHaveBeenCalled();
    });

    it('【关键】修改 SUPER_ADMIN 角色被拒绝（403 / 20009），且不写库', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(
        roleRow({ id: SUPER_ROLE_ID, code: 'SUPER_ADMIN', name: '超级管理员', isSystem: true, permissions: [] }),
      );

      const error = await catchError(
        harness.service.updateRole(SUPER_ROLE_ID, dto({ permissions: ['user:user:read'] }), context),
      );

      expect(error.code).toBe(ErrorCode.PERMISSION_DENIED);
      expect(error.getStatus()).toBe(403);
      expect(error.userMessage).toContain('超级管理员');
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('角色不存在或已软删 → 404 / 20023', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(null);

      const error = await catchError(harness.service.updateRole(ROLE_ID, dto(), context));

      expect(error.code).toBe(ErrorCode.ROLE_NOT_FOUND);
      expect(error.getStatus()).toBe(404);
      // 查询必须限定 deletedAt: null，软删角色不得被改回来
      expect(harness.prisma.role.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ROLE_ID, deletedAt: null } }),
      );
    });

    it('非法 UUID → 20023 而不是 Prisma 报错变成 500', async () => {
      const error = await catchError(harness.service.updateRole('not-a-uuid', dto(), context));

      expect(error.code).toBe(ErrorCode.ROLE_NOT_FOUND);
      expect(error.getStatus()).toBe(404);
      // 连查库都不该发生
      expect(harness.prisma.role.findFirst).not.toHaveBeenCalled();
    });

    it('【关键】白名单外的权限点被拒绝（400 / 10001），且不写库', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));

      const error = await catchError(
        harness.service.updateRole(
          ROLE_ID,
          dto({ permissions: ['user:user:read', 'user:user:ban', 'system:role:drop'] }),
          context,
        ),
      );

      expect(error.code).toBe(ErrorCode.PARAM_INVALID);
      expect(error.getStatus()).toBe(400);
      // 明细要指出具体是哪些权限点非法（否则前端无从提示）
      expect(error.userMessage).toContain('user:user:ban');
      expect(error.userMessage).toContain('system:role:drop');
      expect(error.details?.map((detail) => detail.value)).toEqual(['user:user:ban', 'system:role:drop']);
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('权限点表缺行（seed 漂移）→ 10001 报错，不静默丢弃权限', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: toRolePermissions(['user:user:read']) }));
      // 模拟 permissions 表尚未 seed：白名单里有、表里没有
      harness.prisma.permission.findMany.mockResolvedValue([]);

      const error = await catchError(
        harness.service.updateRole(ROLE_ID, dto({ permissions: ['user:user:read'] }), context),
      );

      expect(error.code).toBe(ErrorCode.PARAM_INVALID);
      expect(error.userMessage).toContain('未初始化');
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('【关键】内置角色改 roleName 被拒绝（10001）；回传同名不算修改', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ isSystem: true, name: '客服运营', permissions: [] }));

      const error = await catchError(harness.service.updateRole(ROLE_ID, dto({ roleName: '超级管理员' }), context));

      expect(error.code).toBe(ErrorCode.PARAM_INVALID);
      expect(error.getStatus()).toBe(400);
      expect(error.userMessage).toContain('内置角色');
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();

      // 客户端把当前名称原样回传（常见做法）不应报错
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ isSystem: true, name: '客服运营', permissions: [] }));
      const view = await harness.service.updateRole(ROLE_ID, dto({ roleName: '客服运营' }), context);
      expect(view.roleName).toBe('客服运营');
    });

    it('自定义角色可以改 roleName 与 description', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(
        roleRow({ id: CUSTOM_ROLE_ID, code: 'CUSTOM_CS', name: '自定义客服', isSystem: false, permissions: [] }),
      );

      const view = await harness.service.updateRole(
        CUSTOM_ROLE_ID,
        dto({ roleName: '一线客服', description: '只负责工单' }),
        context,
      );

      expect(view.roleName).toBe('一线客服');
      expect(view.description).toBe('只负责工单');
      expect(harness.tx.role.update).toHaveBeenCalledWith({
        where: { id: CUSTOM_ROLE_ID },
        data: { name: '一线客服', description: '只负责工单' },
      });
    });

    it('未传 description 时保留原描述（不把字段置空）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(
        roleRow({ description: '原描述', permissions: toRolePermissions(['user:user:read']) }),
      );

      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: ['user:user:read'] }), context);

      expect(view.description).toBe('原描述');
    });

    // ------------------------------------------------------------------ 自锁死
    it('【关键】覆盖后 system:role:write 无任何持有者 → 403 / 10008，且不写库', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(
        roleRow({ permissions: toRolePermissions([ROLE_WRITE, 'user:user:read']) }),
      );
      // 没有超管
      harness.prisma.adminUser.count.mockResolvedValue(0);
      // 其它角色也没有人持有 role:write
      harness.prisma.role.findMany.mockResolvedValue([]);
      harness.prisma.state.writeHolders = [];

      const error = await catchError(
        harness.service.updateRole(ROLE_ID, dto({ permissions: ['user:user:read'] }), context),
      );

      expect(error.code).toBe(ErrorCode.OPERATION_FORBIDDEN);
      expect(error.getStatus()).toBe(403);
      expect(error.userMessage).toContain('没有任何账号能继续管理角色');
      // 被拦下的改动绝不能落库
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
      expect(harness.tokens.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('存在超管时不触发护栏（超管经由 * 恒持有该权限）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: toRolePermissions([ROLE_WRITE]) }));
      harness.prisma.adminUser.count.mockResolvedValue(1);
      harness.prisma.state.writeHolders = [];

      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: ['user:user:read'] }), context);

      expect(view.removedPermissions).toEqual([ROLE_WRITE]);
      expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('其它角色的管理员仍持有该权限时不触发护栏', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: toRolePermissions([ROLE_WRITE]) }));
      harness.prisma.adminUser.count.mockResolvedValue(0);
      harness.prisma.role.findMany.mockResolvedValue([{ id: CUSTOM_ROLE_ID }]);
      harness.prisma.state.writeHolders = [{ adminUserId: OTHER_ADMIN_ID }];

      await expect(
        harness.service.updateRole(ROLE_ID, dto({ permissions: ['user:user:read'] }), context),
      ).resolves.toMatchObject({ permissionDelta: { removed: 1 } });

      // 护栏只应统计"其它角色"的持有者，必须排除被修改的角色本身
      expect(harness.prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
            id: { not: ROLE_ID },
            permissions: { some: { permission: { code: ROLE_WRITE } } },
          }),
        }),
      );
    });

    it('本次修改没有移除 role:write 时不查护栏（避免把既有数据异常变成"无法修复"）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: toRolePermissions(['user:user:read']) }));
      harness.prisma.adminUser.count.mockResolvedValue(0);
      harness.prisma.state.writeHolders = [];

      await expect(
        harness.service.updateRole(ROLE_ID, dto({ permissions: ['user:user:read', 'test:question:read'] }), context),
      ).resolves.toBeDefined();

      expect(harness.prisma.adminUser.count).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------ 影响面
    it('返回受影响管理员（displayName 取 nickname ?? username，在线状态读会话集合键）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));
      harness.prisma.state.affectedAdmins = [
        { adminUserId: OTHER_ADMIN_ID, adminUser: { username: 'cs01', nickname: '客服一号' } },
        { adminUserId: OPERATOR_ADMIN_ID, adminUser: { username: 'cs02', nickname: null } },
      ];
      harness.redis.sCard.mockImplementation((key: string) => Promise.resolve(key.endsWith(OTHER_ADMIN_ID) ? 2 : 0));

      const view = await harness.service.updateRole(ROLE_ID, dto(), context);

      expect(view.affectedAdmins).toEqual([
        { adminId: OTHER_ADMIN_ID, displayName: '客服一号', isCurrentlyOnline: true },
        { adminId: OPERATOR_ADMIN_ID, displayName: 'cs02', isCurrentlyOnline: false },
      ]);
      expect(view.affectedAdminCount).toBe(2);
      // 读的是 AdminTokenService 的会话集合键（sm:admin:sessions:{adminUserId}）
      expect(harness.redis.sCard).toHaveBeenCalledWith(`admin:sessions:${OTHER_ADMIN_ID}`);
    });

    it('Redis 不可用时 isCurrentlyOnline 保守返回 false，不影响权限变更', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));
      harness.prisma.state.affectedAdmins = [
        { adminUserId: OTHER_ADMIN_ID, adminUser: { username: 'cs01', nickname: null } },
      ];
      harness.redis.sCard.mockRejectedValue(new Error('redis down'));

      const view = await harness.service.updateRole(ROLE_ID, dto(), context);

      expect(view.affectedAdmins).toEqual([{ adminId: OTHER_ADMIN_ID, displayName: 'cs01', isCurrentlyOnline: false }]);
    });

    // ------------------------------------------------------------------ 即时生效
    it('【关键】成功后撤销每个受影响管理员的全部会话，并声明需要重新登录', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));
      harness.prisma.state.affectedAdmins = [
        { adminUserId: OTHER_ADMIN_ID, adminUser: { username: 'cs01', nickname: '客服一号' } },
        { adminUserId: OPERATOR_ADMIN_ID, adminUser: { username: 'cs02', nickname: null } },
      ];

      const view = await harness.service.updateRole(ROLE_ID, dto(), context);

      expect(harness.tokens.revokeAllSessions).toHaveBeenCalledTimes(2);
      expect(harness.tokens.revokeAllSessions).toHaveBeenCalledWith(OTHER_ADMIN_ID, 'role_permissions_changed');
      expect(harness.tokens.revokeAllSessions).toHaveBeenCalledWith(OPERATOR_ADMIN_ID, 'role_permissions_changed');
      // 契约写 false，本仓库写 true（权限烧进令牌，只能靠撤销会话即时生效）
      expect(view.requiresReLogin).toBe(true);
      expect(view.permissionCacheInvalidated).toBe(true);
      expect(view.note).toContain('撤销');
      expect(view.note).toContain('重新登录');
    });

    it('单个管理员撤会话失败不影响整体成功（DB 变更已提交，不应回滚成 500）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));
      harness.prisma.state.affectedAdmins = [
        { adminUserId: OTHER_ADMIN_ID, adminUser: { username: 'cs01', nickname: null } },
      ];
      harness.tokens.revokeAllSessions.mockRejectedValue(new Error('redis down'));

      const view = await harness.service.updateRole(ROLE_ID, dto(), context);

      expect(view.requiresReLogin).toBe(true);
      expect(view.affectedAdminCount).toBe(1);
    });

    // ------------------------------------------------------------------ 审计
    it('【关键】写入审计：UPDATE / ROLE / 角色 id，含 before/after 完整 diff 与 reason', async () => {
      const before = ['user:user:read', 'payment:order:refund'];
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: toRolePermissions(before) }));
      harness.prisma.adminUser.findUnique.mockResolvedValue({
        username: 'root',
        nickname: '超级管理员',
        isSuperAdmin: true,
      });

      await harness.service.updateRole(
        ROLE_ID,
        dto({
          permissions: ['user:user:read', 'system:audit:read'],
          reason: '客服团队需要查看自身操作审计记录以自查合规',
        }),
        context,
      );

      const entry = harness.auditLog.mock.calls[0]?.[0] as unknown as Record<string, unknown>;

      expect(harness.auditLog).toHaveBeenCalledTimes(1);
      expect(entry['action']).toBe('UPDATE');
      expect(entry['resourceType']).toBe('ROLE');
      expect(entry['resourceId']).toBe(ROLE_ID);
      expect(entry['adminUserId']).toBe(OPERATOR_ADMIN_ID);
      expect(entry['adminUsername']).toBe('root');
      expect(entry['reason']).toBe('客服团队需要查看自身操作审计记录以自查合规');
      expect(entry['ip']).toBe('10.0.0.1');
      expect(entry['userAgent']).toBe('jest-agent');
      expect(entry['requestId']).toBe(context.requestId);
      expect(entry['beforeData']).toEqual({
        roleName: '客服运营',
        description: '用户与内容只读 + 客服操作（封禁/解封）',
        permissions: [...before].sort(),
      });
      expect(entry['afterData']).toEqual({
        roleName: '客服运营',
        description: '用户与内容只读 + 客服操作（封禁/解封）',
        permissions: ['system:audit:read', 'user:user:read'],
      });
      expect(String(entry['diffSummary'])).toContain('permissions');
      expect(entry['success']).toBe(true);

      // 审计里绝不能出现密码 / 令牌 / 会话等凭据
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('token');
      expect(serialized).not.toContain('jti');
    });

    it('updatedBy 取操作者昵称（无昵称时退回登录名）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));
      harness.prisma.adminUser.findUnique.mockResolvedValue({
        username: 'cs02',
        nickname: null,
        isSuperAdmin: false,
      });

      const view = await harness.service.updateRole(ROLE_ID, dto(), context);

      expect(view.updatedBy).toEqual({ adminId: OPERATOR_ADMIN_ID, displayName: 'cs02' });
      expect(view.reason).toBe(dto().reason);
    });

    // ------------------------------------------------------------------ 风险提示
    it('【关键】移除 CRITICAL 权限点时给出 CRITICAL_PERMISSION_REMOVED 警告', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(
        roleRow({ permissions: toRolePermissions(['user:user:read', 'payment:order:refund']) }),
      );

      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: ['user:user:read'] }), context);

      expect(view.riskWarnings).toEqual([
        expect.objectContaining({
          code: 'CRITICAL_PERMISSION_REMOVED',
          message: expect.stringContaining('payment:order:refund'),
        }),
      ]);
      expect(view.riskWarnings[0]?.message).toContain('CRITICAL 级权限');
    });

    it('授予 CRITICAL 权限点时给出 CRITICAL_PERMISSION_GRANTED 警告', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));

      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: ['ai:prompt:publish'] }), context);

      expect(view.riskWarnings.map((warning) => warning.code)).toEqual(['CRITICAL_PERMISSION_GRANTED']);
      expect(view.riskWarnings[0]?.message).toContain('ai:prompt:publish');
    });

    it('只增删非 CRITICAL 权限点时 riskWarnings 为空数组（不是 null）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(
        roleRow({ permissions: toRolePermissions(['user:user:read', 'test:question:read']) }),
      );

      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: ['user:user:read'] }), context);

      expect(view.riskWarnings).toEqual([]);
      expect(view.addedPermissions).toEqual([]);
      expect(view.removedPermissions).toEqual(['test:question:read']);
    });

    it('操作者本人因本次修改失去 role:write 时追加 OPERATOR_LOSES_ROLE_WRITE 警告（仍放行）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(
        roleRow({ permissions: toRolePermissions([ROLE_WRITE, ROLE_READ]) }),
      );
      harness.prisma.adminUser.count.mockResolvedValue(1); // 还有超管 → 不触发自锁死护栏
      harness.prisma.adminUser.findUnique.mockResolvedValue({
        username: 'cs02',
        nickname: null,
        isSuperAdmin: false,
      });
      harness.prisma.state.affectedAdmins = [
        { adminUserId: OPERATOR_ADMIN_ID, adminUser: { username: 'cs02', nickname: null } },
      ];

      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: [ROLE_READ] }), context);

      expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(view.riskWarnings.map((warning) => warning.code)).toContain('OPERATOR_LOSES_ROLE_WRITE');
      // role:write 是 CRITICAL，移除它的常规警告也应同时存在
      expect(view.riskWarnings.map((warning) => warning.code)).toContain('CRITICAL_PERMISSION_REMOVED');
    });

    it('操作者是超管时不追加自锁提示（他经由 * 恒持有该权限）', async () => {
      harness.prisma.role.findFirst.mockResolvedValue(roleRow({ permissions: toRolePermissions([ROLE_WRITE]) }));
      harness.prisma.adminUser.findUnique.mockResolvedValue({
        username: 'root',
        nickname: '超级管理员',
        isSuperAdmin: true,
      });
      harness.prisma.state.affectedAdmins = [
        { adminUserId: OPERATOR_ADMIN_ID, adminUser: { username: 'root', nickname: null } },
      ];

      const view = await harness.service.updateRole(ROLE_ID, dto({ permissions: [] }), context);

      expect(view.riskWarnings.map((warning) => warning.code)).not.toContain('OPERATOR_LOSES_ROLE_WRITE');
    });
  });
});
