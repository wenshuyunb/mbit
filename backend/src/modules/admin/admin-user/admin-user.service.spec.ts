/**
 * AdminUserService 测试
 *
 * 覆盖两类风险，都是「出事就是事故」的类型：
 *
 *   A. **权限提升 / 横向接管**：创建 `SUPER_ADMIN`、重置其他超管的密码、
 *      挂不存在的角色码 —— 这三条护栏一旦被绕过，`system:admin:write`
 *      就等价于「全权」。
 *   B. **凭证泄漏**：列表泄漏 `passwordHash`、审计里写入明文密码或哈希、
 *      响应里回显不该有的字段 —— 审计表是「能看审计的人都能读」的表，
 *      泄漏面比业务表大得多。
 *
 * 另外验证「重置密码 = 解锁 + 撤销会话 + 同事务」这条复合语义：
 * 只做一半（改了密码却没解锁）会表现为「重置完仍然登不进去」，
 * 而这种半成品状态在人工回归时极难复现。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { AdminAuditService } from '../audit/admin-audit.service';
import type { AdminTokenService } from '../auth/admin-token.service';
import type { PasswordService } from '../auth/password.service';
import type { AdminRbacService } from '../rbac/admin-rbac.service';
import { AdminUserService, type AdminOperatorContext } from './admin-user.service';
import type { AdminUserListQueryDto, CreateAdminUserDto, ResetAdminPasswordDto } from './dto/admin-user.dto';

// ============================================================================
// 夹具
// ============================================================================

const OPERATOR_ID = '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a';
const TARGET_ID = '0195f3a2-09cf-7bfd-9c68-e4bf1c2d3a1f';
const NEW_ADMIN_ID = '0195f3a2-0ad0-7c0e-8d79-f5ca2d3e4b20';
const ANALYST_ROLE_ID = '0195f3a2-1111-7aaa-8bbb-cccccccccccc';

const FIXED_NOW = new Date('2026-02-14T22:00:00.000Z');

const OPERATOR_ROW = {
  id: OPERATOR_ID,
  username: 'admin@soulmap.cn',
  nickname: '超级管理员',
};

/** 列表行夹具：**故意带上 `passwordHash`**，验证服务端真的是字段白名单而不是「恰好没查到」 */
const listRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: OPERATOR_ID,
  username: 'admin@soulmap.cn',
  nickname: '超级管理员',
  status: 'ACTIVE',
  isSuperAdmin: false,
  mustChangePassword: false,
  passwordUpdatedAt: new Date('2026-01-05T08:20:00.000Z'),
  failedLoginCount: 0,
  lockedUntil: null,
  lastLoginAt: new Date('2026-02-14T19:00:00.000Z'),
  lastLoginIp: '203.0.113.42',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  /** 绝不允许出现在响应里的字段 */
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$deadbeef',
  ...overrides,
});

/** RBAC 解析结果的替身形状（`AdminRbacService.resolve` 的返回值） */
interface GrantStub {
  roles: string[];
  permissions: string[];
  roleBriefs: Array<{ roleCode: string; roleName: string; permissionCount: number }>;
}

const grantFor = (roleCode = 'ANALYST', permissions: string[] = ['ai:stats:read', 'ai:calllog:read']): GrantStub => ({
  roles: [roleCode],
  permissions,
  roleBriefs: [{ roleCode, roleName: '数据分析', permissionCount: permissions.length }],
});

const createDto = (overrides: Partial<CreateAdminUserDto> = {}): CreateAdminUserDto => ({
  username: 'analyst@soulmap.cn',
  displayName: '数据分析师',
  roleCodes: ['ANALYST'],
  ...overrides,
});

const resetDto = (overrides: Partial<ResetAdminPasswordDto> = {}): ResetAdminPasswordDto => ({
  reason: '该账号疑似密码泄露，客服工单 TK-20260214-0091 申请重置',
  ...overrides,
});

const operatorContext = (overrides: Partial<AdminOperatorContext> = {}): AdminOperatorContext => ({
  adminUserId: OPERATOR_ID,
  jti: 'session-jti-1',
  ip: '203.0.113.42',
  userAgent: 'jest-agent',
  requestId: 'req_test_admin_user',
  ...overrides,
});

// ============================================================================
// 测试替身
// ============================================================================

/** Prisma 替身的形状（只声明被测服务真正会用到的委托方法） */
interface PrismaStub {
  adminUser: {
    count: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    groupBy: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  adminUserRole: { findMany: jest.Mock; createMany: jest.Mock };
  role: { findMany: jest.Mock };
  adminAuditLog: { groupBy: jest.Mock; findMany: jest.Mock };
  systemConfig: { upsert: jest.Mock };
  $transaction: jest.Mock;
}

interface Harness {
  service: AdminUserService;
  prisma: PrismaStub;
  passwords: { hash: jest.Mock; verify: jest.Mock };
  rbac: { resolve: jest.Mock };
  tokens: { revokeAllSessions: jest.Mock };
  audit: { log: jest.Mock; buildDiffSummary: jest.Mock };
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    adminUser: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    adminUserRole: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    role: { findMany: jest.fn().mockResolvedValue([]) },
    adminAuditLog: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    systemConfig: { upsert: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };

  // 交互式事务：把同一个替身当作 tx 传回，测试即可断言「事务内」的写入
  stub.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
    callback(stub),
  );

  return stub;
};

const createHarness = (): Harness => {
  const prisma = createPrismaStub();

  const passwords = {
    // 用可识别的「哈希」形式，便于断言「落库的不是明文」
    hash: jest.fn(async (plain: string) => `argon2id$hashed$${plain.length}`),
    verify: jest.fn().mockResolvedValue(true),
  };
  const rbac = { resolve: jest.fn().mockResolvedValue(grantFor()) };
  const tokens = { revokeAllSessions: jest.fn().mockResolvedValue(2) };
  const audit = {
    log: jest.fn().mockResolvedValue(true),
    buildDiffSummary: jest.fn().mockReturnValue('passwordUpdatedAt: 旧 → 新'),
  };

  const service = new AdminUserService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
    rbac as unknown as AdminRbacService,
    tokens as unknown as AdminTokenService,
    audit as unknown as AdminAuditService,
  );

  return { service, prisma, passwords, rbac, tokens, audit };
};

/** 让列表的审计统计返回可控数据（默认全 0） */
const mockAuditStats = (
  h: Harness,
  fixtures: {
    loginGroups?: Array<{ adminUserId: string | null; _count: { _all: number } }>;
    actionGroups?: Array<{
      adminUserId: string | null;
      action: string;
      resourceType: string;
      _count: { _all: number };
    }>;
    earliestGroups?: Array<{ adminUserId: string | null; _min: { createdAt: Date | null } }>;
    createLogs?: Array<{ resourceId: string | null; adminUsername: string }>;
  },
): void => {
  h.prisma.adminAuditLog.groupBy.mockImplementation(async (args: any) => {
    // 按参数形态分流：三个统计查询的结构互不相同，无需依赖调用顺序
    if (Array.isArray(args.by) && args.by.length === 3) return fixtures.actionGroups ?? [];
    if (args._min) return fixtures.earliestGroups ?? [];
    if (args.where?.action === 'LOGIN') return fixtures.loginGroups ?? [];
    return [];
  });
  h.prisma.adminAuditLog.findMany.mockResolvedValue(fixtures.createLogs ?? []);
};

const listQuery = (overrides: Partial<AdminUserListQueryDto> = {}): AdminUserListQueryDto =>
  ({ page: 1, pageSize: 20, ...overrides }) as AdminUserListQueryDto;

// ============================================================================
// 测试
// ============================================================================

describe('AdminUserService', () => {
  let h: Harness;

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
    h = createHarness();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ==========================================================================
  // §3.14.9.4 列表
  // ==========================================================================

  describe('listAdmins', () => {
    it('分页包络为 { items, total, page, pageSize, hasNext }，且 hasNext 由 page*pageSize<total 决定', async () => {
      h.prisma.adminUser.count.mockResolvedValue(25);
      h.prisma.adminUser.findMany.mockResolvedValue([listRow()]);

      const result = await h.service.listAdmins(listQuery({ page: 1, pageSize: 10 }));

      expect(result.total).toBe(25);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      expect(result.hasNext).toBe(true);
      expect(result.items).toHaveLength(1);
    });

    it('最后一页 hasNext 为 false，且 skip/take 按页码正确计算', async () => {
      h.prisma.adminUser.count.mockResolvedValue(25);
      h.prisma.adminUser.findMany.mockResolvedValue([listRow()]);

      const result = await h.service.listAdmins(listQuery({ page: 3, pageSize: 10 }));

      expect(result.hasNext).toBe(false);
      const args: { skip: number; take: number } = h.prisma.adminUser.findMany.mock.calls[0]?.[0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });

    it('【关键】不泄漏 passwordHash：查询字段是白名单，响应条目里也没有该字段', async () => {
      h.prisma.adminUser.count.mockResolvedValue(1);
      h.prisma.adminUser.findMany.mockResolvedValue([listRow()]);

      const result = await h.service.listAdmins(listQuery());

      const args: { select: Record<string, boolean> } = h.prisma.adminUser.findMany.mock.calls[0]?.[0];
      expect(args.select['passwordHash']).toBeUndefined();
      expect(Object.keys(args.select)).not.toContain('passwordHash');

      // 即便数据层「多给了」一行 passwordHash，响应里也不能出现
      expect(result.items[0]).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(result)).not.toContain('argon2id');
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });

    it('条目字段与契约一致：displayName 回退 username、isLocked/lockedUntil 同口径、createdBy 归因', async () => {
      h.prisma.adminUser.count.mockResolvedValue(1);
      h.prisma.adminUser.findMany.mockResolvedValue([
        listRow({
          nickname: null,
          status: 'LOCKED',
          failedLoginCount: 5,
          lockedUntil: new Date('2026-02-14T22:20:00.000Z'),
          isSuperAdmin: true,
        }),
      ]);
      h.rbac.resolve.mockResolvedValue(grantFor('SUPER_ADMIN', ['*']));
      mockAuditStats(h, {
        loginGroups: [{ adminUserId: OPERATOR_ID, _count: { _all: 42 } }],
      });

      const result = await h.service.listAdmins(listQuery());
      const item = result.items[0];

      expect(item.displayName).toBe('admin@soulmap.cn');
      expect(item.isLocked).toBe(true);
      expect(item.lockedUntil).toBe('2026-02-14T22:20:00.000Z');
      expect(item.failedLoginCount).toBe(5);
      expect(item.loginCount30d).toBe(42);
      expect(item.lastLoginAt).toBe('2026-02-14T19:00:00.000Z');
      // 超管：持通配符，权限数折算为全部权限点
      expect(item.permissionCount).toBeGreaterThan(1);
      // 无 CREATE 审计 + 超管 → 归因为种子账号
      expect(item.createdBy).toBe('SYSTEM_SEED');
      expect(item.roles[0].roleCode).toBe('SUPER_ADMIN');
    });

    it('status 非法枚举值 → 10001（契约明确要求）', async () => {
      await expect(h.service.listAdmins(listQuery({ status: 'ACTIVE,BOGUS' }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });

      // 非法参数不应打到数据库
      expect(h.prisma.adminUser.findMany).not.toHaveBeenCalled();
    });

    it('status 逗号分隔多值被正确解析为 in 条件', async () => {
      h.prisma.adminUser.findMany.mockResolvedValue([]);

      await h.service.listAdmins(listQuery({ status: 'ACTIVE, LOCKED' }));

      const args: { where: { status?: { in: string[] } } } = h.prisma.adminUser.findMany.mock.calls[0]?.[0];
      expect(args.where.status).toEqual({ in: ['ACTIVE', 'LOCKED'] });
    });

    it('roleCode 含不存在的角色码 → 10001', async () => {
      h.prisma.role.findMany.mockResolvedValue([{ id: ANALYST_ROLE_ID, code: 'ANALYST' }]);

      await expect(h.service.listAdmins(listQuery({ roleCode: 'ANALYST,NOT_A_ROLE' }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('summary 基于当前筛选条件，且 byRole 覆盖全部内置角色码（缺失补 0）', async () => {
      h.prisma.adminUser.count.mockResolvedValue(3);
      h.prisma.adminUser.findMany.mockResolvedValue([]);
      h.prisma.adminUser.groupBy.mockResolvedValue([
        { status: 'ACTIVE', _count: { _all: 2 } },
        { status: 'LOCKED', _count: { _all: 1 } },
      ]);
      h.prisma.adminUserRole.findMany.mockResolvedValue([{ role: { code: 'ANALYST' } }]);

      const result = await h.service.listAdmins(listQuery());

      expect(result.summary).toEqual({
        totalAdmins: 3,
        activeCount: 2,
        lockedCount: 1,
        disabledCount: 0,
        byRole: { SUPER_ADMIN: 0, OPERATOR: 0, CONTENT_EDITOR: 0, FINANCE: 0, ANALYST: 1 },
      });
    });

    it('operationStats7d 按「总数 − 写类 − 登录类」拆分（读操作无枚举可记，只能反推）', async () => {
      h.prisma.adminUser.count.mockResolvedValue(1);
      h.prisma.adminUser.findMany.mockResolvedValue([listRow()]);
      mockAuditStats(h, {
        actionGroups: [
          { adminUserId: OPERATOR_ID, action: 'LOGIN', resourceType: 'admin_user', _count: { _all: 10 } },
          { adminUserId: OPERATOR_ID, action: 'UPDATE', resourceType: 'user', _count: { _all: 6 } },
          { adminUserId: OPERATOR_ID, action: 'EXPORT', resourceType: 'ORDER', _count: { _all: 2 } },
          { adminUserId: OPERATOR_ID, action: 'LOGOUT', resourceType: 'admin_user', _count: { _all: 3 } },
        ],
      });

      const result = await h.service.listAdmins(listQuery());
      const stats = result.items[0].operationStats7d;

      expect(stats.totalActions).toBe(21);
      // 写类只算契约列出的那些动作：EXPORT **不在**其中（这是契约给定的口径）
      expect(stats.writeActions).toBe(6);
      // ORDER/EXPORT 命中 CRITICAL 集合（与 writeActions 的集合不同，属契约口径）
      expect(stats.criticalActions).toBe(2);
      // 反推出 21 − 6 − 13 = 2：EXPORT 既不算写也不算登录，落进差额
      // （读操作本身无枚举可记，该值是近似值，不编造）
      expect(stats.readActions).toBe(2);
    });

    it('【降级】审计统计查询失败时列表仍可用，统计全 0 而不是 500', async () => {
      h.prisma.adminUser.count.mockResolvedValue(1);
      h.prisma.adminUser.findMany.mockResolvedValue([listRow()]);
      h.prisma.adminAuditLog.groupBy.mockRejectedValue(new Error('audit table unavailable'));

      const result = await h.service.listAdmins(listQuery());

      expect(result.items).toHaveLength(1);
      expect(result.items[0].operationStats7d).toEqual({
        totalActions: 0,
        criticalActions: 0,
        readActions: 0,
        writeActions: 0,
      });
      expect(result.items[0].loginCount30d).toBe(0);
      expect(result.items[0].createdBy).toBeNull();
    });

    it('createdBy 取该管理员 CREATE 审计的操作者用户名', async () => {
      h.prisma.adminUser.count.mockResolvedValue(1);
      h.prisma.adminUser.findMany.mockResolvedValue([listRow()]);
      mockAuditStats(h, { createLogs: [{ resourceId: OPERATOR_ID, adminUsername: 'root@soulmap.cn' }] });

      const result = await h.service.listAdmins(listQuery());

      expect(result.items[0].createdBy).toBe('root@soulmap.cn');
    });

    it('非超管且密码设置时间晚于最早审计记录 → createdBy 为 null（不编造操作者）', async () => {
      h.prisma.adminUser.count.mockResolvedValue(1);
      h.prisma.adminUser.findMany.mockResolvedValue([
        listRow({ passwordUpdatedAt: new Date('2026-02-01T00:00:00.000Z') }),
      ]);
      mockAuditStats(h, {
        earliestGroups: [{ adminUserId: OPERATOR_ID, _min: { createdAt: new Date('2026-01-01T00:00:00.000Z') } }],
      });

      const result = await h.service.listAdmins(listQuery());

      expect(result.items[0].createdBy).toBeNull();
    });

    it('空结果集不触发逐条组装（也不会去查 RBAC）', async () => {
      h.prisma.adminUser.count.mockResolvedValue(0);
      h.prisma.adminUser.findMany.mockResolvedValue([]);

      const result = await h.service.listAdmins(listQuery());

      expect(result.items).toEqual([]);
      expect(result.hasNext).toBe(false);
      expect(h.rbac.resolve).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // §3.14.9.5 新建管理员
  // ==========================================================================

  describe('createAdmin', () => {
    const arrangeCreate = (h2: Harness): void => {
      h2.prisma.adminUser.findFirst.mockImplementation(async (args: any) =>
        'username' in (args.where ?? {}) ? null : OPERATOR_ROW,
      );
      h2.prisma.role.findMany.mockResolvedValue([{ id: ANALYST_ROLE_ID, code: 'ANALYST' }]);
      h2.prisma.adminUser.create.mockResolvedValue({ id: NEW_ADMIN_ID, createdAt: FIXED_NOW });
    };

    it('【护栏】roleCodes 含 SUPER_ADMIN 被拒绝（10008），且不落库', async () => {
      arrangeCreate(h);

      await expect(
        h.service.createAdmin(createDto({ roleCodes: ['SUPER_ADMIN'] }), operatorContext()),
      ).rejects.toMatchObject({ code: ErrorCode.OPERATION_FORBIDDEN });

      expect(h.prisma.adminUser.create).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it('【护栏】roleCodes 含不存在的角色码 → 10001，且不落库', async () => {
      arrangeCreate(h);
      h.prisma.role.findMany.mockResolvedValue([]);

      await expect(
        h.service.createAdmin(createDto({ roleCodes: ['NOT_A_ROLE'] }), operatorContext()),
      ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });

      expect(h.prisma.adminUser.create).not.toHaveBeenCalled();
    });

    it('username 已存在 → 409（10003，契约原文 10012 在本仓库不存在）', async () => {
      arrangeCreate(h);
      h.prisma.adminUser.findFirst.mockImplementation(async (args: any) =>
        'username' in (args.where ?? {}) ? { id: TARGET_ID } : OPERATOR_ROW,
      );

      await expect(h.service.createAdmin(createDto(), operatorContext())).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_CONFLICT,
      });

      expect(h.prisma.adminUser.create).not.toHaveBeenCalled();
    });

    it('并发创建撞唯一约束（P2002）同样翻译成 409，而不是 500', async () => {
      arrangeCreate(h);
      h.prisma.adminUser.create.mockRejectedValue({ code: 'P2002' });

      await expect(h.service.createAdmin(createDto(), operatorContext())).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    });

    it('【关键】密码只以哈希落库，明文仅出现在响应里；默认强制首登改密', async () => {
      arrangeCreate(h);
      h.rbac.resolve.mockResolvedValue(grantFor('ANALYST', ['ai:stats:read']));

      const result = await h.service.createAdmin(createDto(), operatorContext());

      const created: { data: Record<string, unknown> } = h.prisma.adminUser.create.mock.calls[0]?.[0];

      // 1) 落库的是哈希，而不是明文
      expect(typeof created.data['passwordHash']).toBe('string');
      expect(created.data['passwordHash']).toBe(`argon2id$hashed$${result.initialPassword.password.length}`);
      expect(JSON.stringify(created.data)).not.toContain(result.initialPassword.password);
      expect(created.data['passwordHash']).not.toBe(result.initialPassword.password);

      // 2) 明文只在响应里出现一次
      expect(result.initialPassword.generated).toBe(true);
      expect(result.initialPassword.password).toHaveLength(16);
      expect(result.initialPassword.expiresInHours).toBe(24);
      expect(result.initialPassword.note).toContain('仅在此响应中返回一次');

      // 3) 默认 mustChangePassword = true，且超管标记恒为 false
      expect(created.data['mustChangePassword']).toBe(true);
      expect(result.mustChangePassword).toBe(true);
      expect(created.data['isSuperAdmin']).toBe(false);

      // 4) displayName 落到 nickname
      expect(created.data['nickname']).toBe('数据分析师');

      // 5) 角色关联带上授权人
      const roleLinks: { data: Array<Record<string, unknown>> } = h.prisma.adminUserRole.createMany.mock.calls[0]?.[0];
      expect(roleLinks.data).toEqual([
        { adminUserId: NEW_ADMIN_ID, roleId: ANALYST_ROLE_ID, grantedByAdminId: OPERATOR_ID },
      ]);
    });

    it('调用方指定 initialPassword 时 generated=false，且响应回显权限并集', async () => {
      arrangeCreate(h);
      h.rbac.resolve.mockResolvedValue(grantFor('ANALYST', ['ai:stats:read', 'ai:calllog:read']));

      const result = await h.service.createAdmin(
        createDto({ initialPassword: 'Str0ng#Pass2026', mustChangePassword: false }),
        operatorContext(),
      );

      expect(result.initialPassword.generated).toBe(false);
      expect(result.initialPassword.password).toBe('Str0ng#Pass2026');
      expect(result.mustChangePassword).toBe(false);
      expect(result.permissions).toEqual(['ai:stats:read', 'ai:calllog:read']);
      expect(result.permissionCount).toBe(2);
      expect(result.createdBy).toEqual({ adminId: OPERATOR_ID, displayName: '超级管理员' });
      expect(result.auditLogId).toBeNull();
    });

    it('服务端兜底拒绝弱 initialPassword（内部调用绕过 DTO 校验时依然安全）', async () => {
      arrangeCreate(h);

      await expect(
        h.service.createAdmin(createDto({ initialPassword: 'weakpassword1' }), operatorContext()),
      ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
    });

    it('ipWhitelist 落到 system_configs（数据模型无该列），键为 admin.ipWhitelist.{adminId}', async () => {
      arrangeCreate(h);

      const result = await h.service.createAdmin(
        createDto({ ipWhitelist: ['203.0.113.0/24', '198.51.100.7'] }),
        operatorContext(),
      );

      const upsert: { where: { key: string }; create: Record<string, unknown> } =
        h.prisma.systemConfig.upsert.mock.calls[0]?.[0];

      expect(upsert.where.key).toBe(`admin.ipWhitelist.${NEW_ADMIN_ID}`);
      expect(upsert.create['valueType']).toBe('JSON');
      expect(upsert.create['group']).toBe('SECURITY');
      expect(upsert.create['isPublic']).toBe(false);
      expect(upsert.create['isEditable']).toBe(false);
      expect(JSON.parse(upsert.create['value'] as string)).toEqual(['203.0.113.0/24', '198.51.100.7']);
      expect(result.ipWhitelist).toEqual(['203.0.113.0/24', '198.51.100.7']);
    });

    it('未传 ipWhitelist 时不写 system_configs，响应回显空数组', async () => {
      arrangeCreate(h);

      const result = await h.service.createAdmin(createDto(), operatorContext());

      expect(h.prisma.systemConfig.upsert).not.toHaveBeenCalled();
      expect(result.ipWhitelist).toEqual([]);
    });

    it('【关键】审计记录 CREATE/ADMIN，且 🚫 不含任何密码或哈希', async () => {
      arrangeCreate(h);

      const result = await h.service.createAdmin(createDto(), operatorContext());
      const entry: Record<string, unknown> = h.audit.log.mock.calls[0]?.[0];
      const serialized = JSON.stringify(entry);

      expect(entry['action']).toBe('CREATE');
      expect(entry['resourceType']).toBe('ADMIN');
      expect(entry['resourceId']).toBe(NEW_ADMIN_ID);
      expect(entry['adminUserId']).toBe(OPERATOR_ID);
      expect(entry['beforeData']).toBeNull();
      expect(entry['afterData']).toMatchObject({ username: 'analyst@soulmap.cn', roleCodes: ['ANALYST'] });

      expect(serialized).not.toContain(result.initialPassword.password);
      expect(serialized.toLowerCase()).not.toContain('passwordhash');
      expect(serialized).not.toContain('argon2id');
    });

    it('操作者账号在请求期间被删除 → 401，不落库', async () => {
      arrangeCreate(h);
      h.prisma.adminUser.findFirst.mockResolvedValue(null);

      await expect(h.service.createAdmin(createDto(), operatorContext())).rejects.toMatchObject({
        code: ErrorCode.TOKEN_INVALID,
      });
    });
  });

  // ==========================================================================
  // §3.14.9.6 重置密码
  // ==========================================================================

  describe('resetAdminPassword', () => {
    const arrangeReset = (h2: Harness, targetOverrides: Record<string, unknown> = {}): void => {
      h2.prisma.adminUser.findFirst.mockImplementation(async (args: any) =>
        (args.where ?? {}).id === OPERATOR_ID
          ? OPERATOR_ROW
          : {
              id: TARGET_ID,
              username: 'finance@soulmap.cn',
              nickname: '财务专员',
              status: 'LOCKED',
              isSuperAdmin: false,
              failedLoginCount: 5,
              passwordUpdatedAt: new Date('2026-02-01T08:00:00.000Z'),
              lockedUntil: new Date('2026-02-14T22:20:00.000Z'),
              ...targetOverrides,
            },
      );
    };

    it('目标不存在 → 404（20022）', async () => {
      h.prisma.adminUser.findFirst.mockImplementation(async (args: any) =>
        (args.where ?? {}).id === OPERATOR_ID ? OPERATOR_ROW : null,
      );

      await expect(h.service.resetAdminPassword(TARGET_ID, resetDto(), operatorContext())).rejects.toMatchObject({
        code: ErrorCode.ADMIN_NOT_FOUND,
      });

      expect(h.prisma.adminUser.update).not.toHaveBeenCalled();
      expect(h.tokens.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('id 非法 UUID → 10001，且不打数据库（否则 Prisma 会把非法字面量拼进 SQL 变 500）', async () => {
      await expect(h.service.resetAdminPassword('not-a-uuid', resetDto(), operatorContext())).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });

      expect(h.prisma.adminUser.findFirst).not.toHaveBeenCalled();
    });

    it('【护栏】目标是其他 SUPER_ADMIN → 403（20009），禁止横向接管', async () => {
      arrangeReset(h, { isSuperAdmin: true, status: 'ACTIVE', lockedUntil: null });

      await expect(h.service.resetAdminPassword(TARGET_ID, resetDto(), operatorContext())).rejects.toMatchObject({
        code: ErrorCode.PERMISSION_DENIED,
      });

      expect(h.prisma.adminUser.update).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it('重置**自己**（同为超管）是允许的 —— 代价是本人会话被撤销，属预期', async () => {
      h.prisma.adminUser.findFirst.mockResolvedValue({
        id: OPERATOR_ID,
        username: 'admin@soulmap.cn',
        nickname: '超级管理员',
        status: 'ACTIVE',
        isSuperAdmin: true,
        failedLoginCount: 0,
        passwordUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
        lockedUntil: null,
      });

      const result = await h.service.resetAdminPassword(OPERATOR_ID, resetDto(), operatorContext());

      expect(result.adminId).toBe(OPERATOR_ID);
      expect(result.unlocked).toBe(false);
      expect(h.tokens.revokeAllSessions).toHaveBeenCalledWith(OPERATOR_ID, 'admin_password_reset');
    });

    it('【关键】改密同时解锁（status LOCKED→ACTIVE、计数清零、lockedUntil 置空），并在单事务内完成', async () => {
      arrangeReset(h);

      const result = await h.service.resetAdminPassword(TARGET_ID, resetDto(), operatorContext());
      const update: { where: { id: string }; data: Record<string, unknown> } =
        h.prisma.adminUser.update.mock.calls[0]?.[0];

      expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(update.where.id).toBe(TARGET_ID);
      expect(update.data['status']).toBe('ACTIVE');
      expect(update.data['failedLoginCount']).toBe(0);
      expect(update.data['lockedUntil']).toBeNull();
      expect(update.data['mustChangePassword']).toBe(true);
      expect(update.data['passwordUpdatedAt']).toEqual(FIXED_NOW);

      expect(result.unlocked).toBe(true);
      expect(result.previousFailedLoginCount).toBe(5);
      expect(result.mustChangePassword).toBe(true);
      expect(result.passwordUpdatedAt).toBe('2026-02-14T22:00:00.000Z');
      expect(result.displayName).toBe('财务专员');
      expect(result.resetBy).toEqual({ adminId: OPERATOR_ID, displayName: '超级管理员' });
      expect(result.reason).toBe(resetDto().reason);
      expect(result.auditLogId).toBeNull();
    });

    it('未锁定的账号解锁标志为 false，且 status 不被擅自改动', async () => {
      arrangeReset(h, { status: 'DISABLED', lockedUntil: null, failedLoginCount: 0 });

      const result = await h.service.resetAdminPassword(TARGET_ID, resetDto(), operatorContext());
      const update: { data: Record<string, unknown> } = h.prisma.adminUser.update.mock.calls[0]?.[0];

      expect(result.unlocked).toBe(false);
      expect(update.data['status']).toBe('DISABLED');
    });

    it('【关键】revokeSessions 默认 true：撤销全部会话并把条数作为 revokedSessions', async () => {
      arrangeReset(h);
      h.tokens.revokeAllSessions.mockResolvedValue(3);

      const result = await h.service.resetAdminPassword(TARGET_ID, resetDto(), operatorContext());

      expect(h.tokens.revokeAllSessions).toHaveBeenCalledWith(TARGET_ID, 'admin_password_reset');
      expect(result.revokedSessions).toBe(3);
    });

    it('revokeSessions=false 时不撤销会话', async () => {
      arrangeReset(h);

      const result = await h.service.resetAdminPassword(
        TARGET_ID,
        resetDto({ revokeSessions: false }),
        operatorContext(),
      );

      expect(h.tokens.revokeAllSessions).not.toHaveBeenCalled();
      expect(result.revokedSessions).toBe(0);
    });

    it('【降级】会话撤销失败不影响改密结果（密码已换新，旧会话最多存活一个 access TTL）', async () => {
      arrangeReset(h);
      h.tokens.revokeAllSessions.mockRejectedValue(new Error('redis down'));

      const result = await h.service.resetAdminPassword(TARGET_ID, resetDto(), operatorContext());

      expect(result.revokedSessions).toBe(0);
      expect(result.passwordUpdatedAt).toBe('2026-02-14T22:00:00.000Z');
    });

    it('【关键】审计 before/after 只含约定字段，🚫 绝不含密码或哈希', async () => {
      arrangeReset(h);

      const result = await h.service.resetAdminPassword(TARGET_ID, resetDto(), operatorContext());
      const entry: Record<string, unknown> = h.audit.log.mock.calls[0]?.[0];
      const serialized = JSON.stringify(entry);

      expect(entry['action']).toBe('UPDATE');
      expect(entry['resourceType']).toBe('ADMIN');
      expect(entry['resourceId']).toBe(TARGET_ID);
      expect(entry['adminUserId']).toBe(OPERATOR_ID);
      expect(entry['reason']).toBe(resetDto().reason);
      expect(entry['ip']).toBe('203.0.113.42');
      expect(entry['userAgent']).toBe('jest-agent');
      expect(entry['requestId']).toBe('req_test_admin_user');

      expect(entry['beforeData']).toEqual({
        passwordUpdatedAt: '2026-02-01T08:00:00.000Z',
        failedLoginCount: 5,
      });
      expect(entry['afterData']).toEqual({
        passwordUpdatedAt: '2026-02-14T22:00:00.000Z',
        mustChangePassword: true,
        failedLoginCount: 0,
        revokedSessions: 2,
      });

      expect(serialized).not.toContain(result.newPassword.password);
      expect(serialized.toLowerCase()).not.toContain('passwordhash');
      expect(serialized).not.toContain('argon2id');
    });

    it('新密码为服务端生成的一次性强密码，落库的只有哈希', async () => {
      arrangeReset(h);

      const result = await h.service.resetAdminPassword(TARGET_ID, resetDto(), operatorContext());
      const update: { data: Record<string, unknown> } = h.prisma.adminUser.update.mock.calls[0]?.[0];

      expect(result.newPassword.generated).toBe(true);
      expect(result.newPassword.password).toHaveLength(16);
      expect(result.newPassword.password).toMatch(/[a-z]/);
      expect(result.newPassword.password).toMatch(/[A-Z]/);
      expect(result.newPassword.password).toMatch(/\d/);
      expect(result.newPassword.password).toMatch(/[^A-Za-z0-9]/);
      expect(result.newPassword.expiresInHours).toBe(24);

      expect(update.data['passwordHash']).not.toBe(result.newPassword.password);
      expect(JSON.stringify(update.data)).not.toContain(result.newPassword.password);
    });

    it('mustChangePassword=false 被如实透传（契约允许，默认仍为 true）', async () => {
      arrangeReset(h);

      const result = await h.service.resetAdminPassword(
        TARGET_ID,
        resetDto({ mustChangePassword: false }),
        operatorContext(),
      );
      const update: { data: Record<string, unknown> } = h.prisma.adminUser.update.mock.calls[0]?.[0];

      expect(update.data['mustChangePassword']).toBe(false);
      expect(result.mustChangePassword).toBe(false);
    });
  });
});
