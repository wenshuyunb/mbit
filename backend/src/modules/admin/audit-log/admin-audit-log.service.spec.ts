/**
 * 审计日志服务测试（`docs/API_DESIGN.md` §3.14.9.3）
 *
 * 手写 Prisma mock（与 `personality.service.spec.ts` 同一手法），聚焦四类**高风险分支**：
 *   · **参数边界**：范围 > 90 天、时间逆序、非法 ISO、非白名单排序 —— 这些必须在**发 SQL 之前**
 *     就被拦住（否则一次全表扫的 count 就能把库拖垮）；
 *   · **派生字段反推**：权限点 / 风险等级 / 目标类型全部由 `(resourceType, action)` 推出，
 *     反推错了页面会给出**看起来合理但错误**的合规信息，比报错更危险；
 *   · **过滤条件与统计口径必须一致**：`result=DENIED` 的过滤条件与 `deniedCount`、
 *     `severity=NORMAL` 的过滤条件与 `normalCount` 若不一致，就会出现
 *     「列表 0 条但摘要 18 条」这类自相矛盾的界面；
 *   · **降级不崩**：管理员被软删（`adminUser` 查不到）时必须回退到审计行冗余的用户名，
 *     审计接口因某个操作人被删而整体 500 是不可接受的。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  RETENTION_NOTICE,
  displayTargetType,
  resolveAuditAction,
  severityFilterPairs,
} from './admin-audit-log.constants';
import { AdminAuditLogService } from './admin-audit-log.service';
import type { AdminAuditLogQueryDto } from './dto/admin-audit-log-query.dto';
import type { AdminAuditLogItemDto } from './dto/admin-audit-log-response.dto';

// ============================================================================
// 夹具
// ============================================================================

const ADMIN_ID = '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a';
const ADMIN_ID_2 = '0195f3a2-08be-7aec-8b57-d3ae0b1c2f0b';
const ORDER_ID = '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89';

/** 契约示例的时间范围：2026-02-01 ~ 2026-02-14（14 天，满足 ≤ 90 天） */
const START_TIME = '2026-02-01T00:00:00.000Z';
const END_TIME = '2026-02-14T23:59:59.999Z';

type WhereInput = Record<string, unknown>;

interface PrismaStub {
  adminAuditLog: { count: jest.Mock; findMany: jest.Mock; groupBy: jest.Mock };
  adminUser: { findMany: jest.Mock };
  adminUserRole: { findMany: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  adminAuditLog: {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  adminUser: { findMany: jest.fn().mockResolvedValue([]) },
  adminUserRole: { findMany: jest.fn().mockResolvedValue([]) },
});

/** 查询参数（字段齐全，避免 `undefined` 掩盖默认值分支） */
const query = (overrides: Partial<AdminAuditLogQueryDto> = {}): AdminAuditLogQueryDto =>
  ({
    page: 1,
    pageSize: 20,
    startTime: START_TIME,
    endTime: END_TIME,
    ...overrides,
  }) as AdminAuditLogQueryDto;

/** 审计行（字段齐全：缺字段会让 `??` 兜底掩盖真实逻辑） */
const auditRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '0195f3a2-2527-7a20-9b1c-acdb9e0f1c95',
  adminUserId: ADMIN_ID,
  adminUsername: 'admin@soulmap.cn',
  action: 'REFUND',
  resourceType: 'order',
  resourceId: ORDER_ID,
  beforeData: { orderStatus: 'FULFILLED', refundedAmount: 0 },
  afterData: { orderStatus: 'REFUNDED', refundedAmount: 9900 },
  diffSummary: 'orderStatus: FULFILLED → REFUNDED',
  reason: '用户投诉报告生成失败，客服核实后全额退款',
  ip: '203.0.113.42',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  requestId: 'req_01HQ8Z3K7M2XQ9V4T6B1NDCFA8',
  success: true,
  errorCode: null,
  latencyMs: 128,
  createdAt: new Date('2026-02-14T21:10:05.000Z'),
  ...overrides,
});

/** 首屏主查询的 `where`（第 1 次 `findMany` 即列表主查询，第 2 次是趋势窗口） */
const capturedWhere = (prisma: PrismaStub): WhereInput => {
  const args = prisma.adminAuditLog.findMany.mock.calls[0]?.[0] as { where: WhereInput } | undefined;

  if (args === undefined) throw new Error('findMany 未被调用：测试夹具有问题，不是被测代码的问题');

  return args.where;
};

/** `AND` 数组里所有 `OR` 条件 */
const orClauses = (where: WhereInput): unknown[] =>
  ((where['AND'] ?? []) as WhereInput[]).flatMap((condition) => (condition['OR'] ?? []) as unknown[]);

/** `AND` 数组里的单维度条件（不含 `OR` / `NOT` 的那些，例如 `resourceType: { in: [...] }`） */
const plainClauses = (where: WhereInput): WhereInput[] =>
  ((where['AND'] ?? []) as WhereInput[]).filter(
    (condition) => condition['OR'] === undefined && condition['NOT'] === undefined,
  );

/** 所有 `count` 调用的 `where`（用于核对统计口径与过滤口径是否同源） */
const countWheres = (prisma: PrismaStub): WhereInput[] =>
  prisma.adminAuditLog.count.mock.calls.map((call) => (call[0] as { where: WhereInput }).where);

// ============================================================================
// 测试
// ============================================================================

describe('AdminAuditLogService', () => {
  let prisma: PrismaStub;
  let service: AdminAuditLogService;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new AdminAuditLogService(prisma as unknown as PrismaService);
  });

  // ==========================================================================
  // 参数校验（必须在发 SQL 之前完成）
  // ==========================================================================

  describe('时间范围校验', () => {
    it('【关键】范围 > 90 天 → 10001，且不发出任何查询', async () => {
      const promise = service.list(query({ startTime: '2025-01-01T00:00:00.000Z', endTime: END_TIME }));

      await expect(promise).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
      // 契约原文的 10016 在本仓库不存在，故统一 10001；关键点是**先校验再查库**
      expect(prisma.adminAuditLog.count).not.toHaveBeenCalled();
      expect(prisma.adminAuditLog.findMany).not.toHaveBeenCalled();
    });

    it('恰好 90 天是允许的（边界值不能误拒）', async () => {
      await expect(
        service.list(query({ startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-04-01T00:00:00.000Z' })),
      ).resolves.toBeDefined();
    });

    it('endTime 不晚于 startTime → 10001', async () => {
      await expect(service.list(query({ startTime: END_TIME, endTime: START_TIME }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });

      await expect(service.list(query({ endTime: START_TIME }))).rejects.toBeInstanceOf(BusinessException);
    });

    it('非法 ISO 串 / 缺失时间 → 10001', async () => {
      await expect(service.list(query({ startTime: 'not-a-time' }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
      await expect(service.list(query({ endTime: 'yesterday' }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
      await expect(service.list({ page: 1, pageSize: 20 } as AdminAuditLogQueryDto)).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('contract 的 endTime 为闭区间（示例给到 23:59:59.999Z，用 lte 而不是 lt）', async () => {
      await service.list(query());

      expect(capturedWhere(prisma)['AND']).toContainEqual({
        createdAt: { gte: new Date(START_TIME), lte: new Date(END_TIME) },
      });
    });
  });

  describe('排序与 ID 过滤校验', () => {
    it('sortBy 白名单只有 createdAt（越界 → 10001，而不是 405 的 10004）', async () => {
      await expect(service.list(query({ sortBy: 'updatedAt' as never }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('默认按 createdAt desc（审计页最新在前）', async () => {
      await service.list(query());

      expect(prisma.adminAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it('order=asc 时按升序（追溯事件发生顺序）', async () => {
      await service.list(query({ order: 'asc' }));

      expect(prisma.adminAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
      );
    });

    it('operatorAdminId 必须是 UUID（非 UUID 会被 PostgreSQL 判为非法输入 → 500）', async () => {
      await expect(service.list(query({ operatorAdminId: 'not-a-uuid' }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('targetId 必须是 UUID（契约写 ≤64 字符，但 resource_id 是 uuid 列：明确拒绝而非静默返回空列表）', async () => {
      await expect(service.list(query({ targetId: 'MBTI_REPORT' }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });
  });

  // ==========================================================================
  // 派生维度的过滤翻译
  // ==========================================================================

  describe('action 反推过滤', () => {
    it('【关键】权限点 → (action, resourceType) 候选对（payment:order:refund）', async () => {
      await service.list(query({ action: ['payment:order:refund'] }));

      expect(orClauses(capturedWhere(prisma))).toEqual(
        expect.arrayContaining([{ action: 'REFUND', resourceType: { in: expect.arrayContaining(['order']) } }]),
      );
    });

    it('一个权限点对应多个动作时全部展开（system:config:write → CONFIG_CHANGE 与 UPDATE）', async () => {
      await service.list(query({ action: ['system:config:write'] }));

      const clauses = orClauses(capturedWhere(prisma));

      expect(clauses).toEqual(
        expect.arrayContaining([
          { action: 'CONFIG_CHANGE', resourceType: { in: expect.arrayContaining(['config']) } },
          { action: 'UPDATE', resourceType: { in: expect.arrayContaining(['system_config']) } },
        ]),
      );
    });

    it('裸动作名按动作过滤（不限资源类型）', async () => {
      await service.list(query({ action: ['refund'] }));

      expect(orClauses(capturedWhere(prisma))).toEqual(expect.arrayContaining([{ action: 'REFUND' }]));
    });

    it('多值（逗号分隔）是 OR 关系，不只取第一个', async () => {
      await service.list(query({ action: ['payment:order:refund', 'ai:prompt:publish'] }));

      const clauses = orClauses(capturedWhere(prisma));

      expect(clauses).toEqual(
        expect.arrayContaining([
          { action: 'REFUND', resourceType: { in: expect.arrayContaining(['order']) } },
          { action: 'PUBLISH', resourceType: { in: expect.arrayContaining(['prompt']) } },
        ]),
      );
    });

    it('反推不出来时按 resourceType 精确匹配，并展开别名（admin → admin_user）', async () => {
      await service.list(query({ action: ['admin'] }));

      expect(orClauses(capturedWhere(prisma))).toContainEqual({
        resourceType: { in: expect.arrayContaining(['admin', 'admin_user']) },
      });
    });

    it('完全陌生的取值同样退化为 resourceType 精确匹配（宁多给不空手）', async () => {
      await service.list(query({ action: ['coupon'] }));

      expect(orClauses(capturedWhere(prisma))).toContainEqual({ resourceType: { in: ['coupon'] } });
    });

    it('空的 action 列表不产生条件（避免 OR: [] 让 Prisma 报错）', async () => {
      await service.list(query({ action: [] }));

      expect(orClauses(capturedWhere(prisma))).toEqual([]);
    });
  });

  describe('severity 过滤', () => {
    it('CRITICAL 展开为资金/权限/合规相关的候选对', async () => {
      await service.list(query({ severity: 'CRITICAL' }));

      const clauses = orClauses(capturedWhere(prisma));

      expect(clauses).toEqual(
        expect.arrayContaining([
          { action: 'REFUND', resourceType: { in: expect.arrayContaining(['order']) } },
          { action: 'UPDATE', resourceType: { in: expect.arrayContaining(['role']) } },
          { action: 'CREATE', resourceType: { in: expect.arrayContaining(['admin_user']) } },
          { action: 'CONFIG_CHANGE', resourceType: { in: expect.arrayContaining(['config']) } },
        ]),
      );
    });

    it('SENSITIVE 展开为内容与用户数据相关的候选对', async () => {
      await service.list(query({ severity: 'SENSITIVE' }));

      expect(orClauses(capturedWhere(prisma))).toEqual(
        expect.arrayContaining([
          { action: 'PUBLISH', resourceType: { in: expect.arrayContaining(['prompt']) } },
          { action: 'UPDATE', resourceType: { in: expect.arrayContaining(['user_profile']) } },
        ]),
      );
    });

    it('【关键】NORMAL 是补集（NOT(CRITICAL OR SENSITIVE)），不会与另两级重叠', async () => {
      await service.list(query({ severity: 'NORMAL' }));

      const clause = ((capturedWhere(prisma)['AND'] ?? []) as WhereInput[]).find(
        (condition) => condition['NOT'] !== undefined,
      );

      expect(clause).toBeDefined();

      const excluded = (clause?.['NOT'] as WhereInput)['OR'] as unknown[];

      expect(excluded).toEqual(
        expect.arrayContaining([
          { action: 'REFUND', resourceType: { in: expect.arrayContaining(['order']) } },
          { action: 'PUBLISH', resourceType: { in: expect.arrayContaining(['prompt']) } },
        ]),
      );
    });

    it('CRITICAL / SENSITIVE 的候选对非空（否则过滤会退化成空 OR 而静默失效）', () => {
      expect(severityFilterPairs('CRITICAL').length).toBeGreaterThan(0);
      expect(severityFilterPairs('SENSITIVE').length).toBeGreaterThan(0);
    });
  });

  describe('result 过滤与反解', () => {
    it('【关键】result=DENIED 归到 errorCode=20009（越权被拒）', async () => {
      await service.list(query({ result: 'DENIED' }));

      expect(capturedWhere(prisma)['AND']).toContainEqual({ success: false, errorCode: '20009' });
    });

    it('【关键】summary 的 deniedCount 与过滤条件同源（口径不一致会出现「列表 0 条、摘要 18 条」）', async () => {
      await service.list(query({ result: 'DENIED' }));

      expect(countWheres(prisma)).toContainEqual(
        expect.objectContaining({
          AND: expect.arrayContaining([{ success: false, errorCode: '20009' }]),
        }),
      );
    });

    it('【关键】result=FAILED 必须把 error_code 为 NULL 的行算进来（Prisma 的 not 不含 NULL）', async () => {
      await service.list(query({ result: 'FAILED' }));

      expect(capturedWhere(prisma)['AND']).toContainEqual({
        success: false,
        OR: [{ errorCode: null }, { errorCode: { not: '20009' } }],
      });
    });

    it('SUCCESS 只看 success = true', async () => {
      await service.list(query({ result: 'SUCCESS' }));

      expect(capturedWhere(prisma)['AND']).toContainEqual({ success: true });
    });

    it('行结果反解：success/errorCode → SUCCESS / DENIED / FAILED', async () => {
      prisma.adminAuditLog.findMany.mockResolvedValueOnce([
        auditRow({ id: 'log-success', success: true, errorCode: null }),
        auditRow({ id: 'log-denied', success: false, errorCode: '20009' }),
        auditRow({ id: 'log-failed', success: false, errorCode: '70013' }),
        // 失败且没写错误码的行同样必须归到 FAILED，而不是被静默丢掉
        auditRow({ id: 'log-failed-null', success: false, errorCode: null }),
      ]);

      const view = await service.list(query());
      const resultOf = (id: string): string | undefined => view.items.find((item) => item.auditLogId === id)?.result;

      expect(resultOf('log-success')).toBe('SUCCESS');
      expect(resultOf('log-denied')).toBe('DENIED');
      expect(resultOf('log-failed')).toBe('FAILED');
      expect(resultOf('log-failed-null')).toBe('FAILED');
    });
  });

  describe('targetType / keyword 过滤', () => {
    it('targetType 由 resourceType 别名集合表达（枚举 ADMIN → admin_user）', async () => {
      await service.list(query({ targetType: 'ADMIN' }));

      expect(plainClauses(capturedWhere(prisma))).toContainEqual({
        resourceType: { in: expect.arrayContaining(['admin', 'admin_user']) },
      });
    });

    it('keyword 在 changeNote 来源列（reason / diff_summary）内做包含匹配', async () => {
      await service.list(query({ keyword: '退款' }));

      expect(orClauses(capturedWhere(prisma))).toEqual(
        expect.arrayContaining([
          { diffSummary: { contains: '退款', mode: 'insensitive' } },
          { reason: { contains: '退款', mode: 'insensitive' } },
        ]),
      );
    });

    it('keyword 恰好是权限点时按该动作匹配（action 是枚举列，无法做文本包含）', async () => {
      await service.list(query({ keyword: 'payment:order:refund' }));

      expect(orClauses(capturedWhere(prisma))).toEqual(
        expect.arrayContaining([{ action: 'REFUND', resourceType: { in: expect.arrayContaining(['order']) } }]),
      );
    });
  });

  // ==========================================================================
  // 分页
  // ==========================================================================

  describe('分页', () => {
    it('【关键】hasNext = page * pageSize < total', async () => {
      prisma.adminAuditLog.count.mockResolvedValue(186);

      const secondPage = await service.list(query({ page: 2, pageSize: 20 }));

      expect(prisma.adminAuditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
      expect(secondPage).toMatchObject({ total: 186, page: 2, pageSize: 20, hasNext: true });

      prisma.adminAuditLog.findMany.mockClear();

      // 186 / 20 = 9.3 → 第 10 页是最后一页，没有下一页
      const lastPage = await service.list(query({ page: 10, pageSize: 20 }));

      expect(lastPage).toMatchObject({ page: 10, hasNext: false });
    });

    it('缺省分页参数时按契约默认值 1 / 20', async () => {
      const view = await service.list({ startTime: START_TIME, endTime: END_TIME } as AdminAuditLogQueryDto);

      expect(prisma.adminAuditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
      expect(view).toMatchObject({ page: 1, pageSize: 20 });
    });

    it('绕过管道的非法分页参数 → 10001（不能静默夹取，更不能让负 skip 变成 500）', async () => {
      await expect(service.list(query({ page: 0 }))).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
      await expect(service.list(query({ pageSize: 0 }))).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
      await expect(service.list(query({ pageSize: 101 }))).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
      expect(prisma.adminAuditLog.findMany).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 派生字段展示
  // ==========================================================================

  describe('派生字段反推', () => {
    it('【关键】severity / action / actionLabel / targetType 由 (resourceType, action) 反推', async () => {
      prisma.adminAuditLog.findMany.mockResolvedValueOnce([
        auditRow({ id: 'l1', action: 'CONFIG_CHANGE', resourceType: 'config' }),
        auditRow({ id: 'l2', action: 'LOGIN', resourceType: 'admin_user' }),
        auditRow({ id: 'l3', action: 'PUBLISH', resourceType: 'prompt' }),
        auditRow({ id: 'l4', action: 'ROLLBACK', resourceType: 'prompt' }),
        auditRow({ id: 'l5', action: 'UPDATE', resourceType: 'user_profile' }),
        auditRow({ id: 'l6', action: 'EXPORT', resourceType: 'order' }),
        auditRow({ id: 'l7', action: 'UPDATE', resourceType: 'coupon' }),
      ]);

      const view = await service.list(query());
      const itemOf = (id: string): AdminAuditLogItemDto | undefined =>
        view.items.find((item) => item.auditLogId === id);

      expect(itemOf('l1')).toMatchObject({
        action: 'system:config:write',
        actionLabel: '修改系统配置',
        severity: 'CRITICAL',
        targetType: 'CONFIG',
      });
      // 登录不是资金/内容类操作，按契约语义留在 NORMAL（否则「敏感」信号会被稀释）
      expect(itemOf('l2')).toMatchObject({
        action: 'admin:auth:login',
        actionLabel: '管理员登录',
        severity: 'NORMAL',
        targetType: 'ADMIN',
      });
      expect(itemOf('l3')).toMatchObject({
        action: 'ai:prompt:publish',
        actionLabel: '发布 Prompt 版本',
        severity: 'SENSITIVE',
        targetType: 'PROMPT',
      });
      expect(itemOf('l4')).toMatchObject({
        action: 'ai:prompt:publish',
        actionLabel: '回滚 Prompt 版本',
        severity: 'SENSITIVE',
      });
      expect(itemOf('l5')).toMatchObject({
        action: 'user:user:write',
        severity: 'SENSITIVE',
        targetType: 'USER',
      });
      expect(itemOf('l6')).toMatchObject({ action: 'payment:order:export', severity: 'CRITICAL' });
      // 未登记的组合不猜权限点：回退为 `${resourceType}:${action}` 且等级 NORMAL，目标类型原样透出
      expect(itemOf('l7')).toMatchObject({
        action: 'coupon:update',
        actionLabel: '更新',
        severity: 'NORMAL',
        targetType: 'coupon',
      });
    });

    it('changeNote = reason ?? diffSummary；metadata 只在有真实来源时给出', async () => {
      prisma.adminAuditLog.findMany.mockResolvedValueOnce([
        auditRow({ id: 'with-reason', reason: '客服核实后全额退款', diffSummary: 'orderStatus → REFUNDED' }),
        auditRow({ id: 'no-reason', reason: null, diffSummary: 'orderStatus → REFUNDED', latencyMs: null }),
      ]);

      const view = await service.list(query());
      const itemOf = (id: string): AdminAuditLogItemDto | undefined =>
        view.items.find((item) => item.auditLogId === id);

      expect(itemOf('with-reason')?.['changeNote']).toBe('客服核实后全额退款');
      expect(itemOf('with-reason')?.['targetSummary']).toBe('orderStatus → REFUNDED');
      expect(itemOf('with-reason')?.['metadata']).toEqual({ latencyMs: 128 });
      expect(itemOf('no-reason')?.['changeNote']).toBe('orderStatus → REFUNDED');
      // 没有 latency_ms 就给 null，不编造 confirmPasswordVerified 这类表里不存在的字段
      expect(itemOf('no-reason')?.['metadata']).toBeNull();
    });

    it('before / after 原样透出（审计的核心：改了什么是不可裁剪的）', async () => {
      prisma.adminAuditLog.findMany.mockResolvedValueOnce([auditRow()]);

      const view = await service.list(query());

      expect(view.items[0]?.before).toEqual({ orderStatus: 'FULFILLED', refundedAmount: 0 });
      expect(view.items[0]?.after).toEqual({ orderStatus: 'REFUNDED', refundedAmount: 9900 });
      expect(view.items[0]?.createdAt).toBe('2026-02-14T21:10:05.000Z');
    });
  });

  // ==========================================================================
  // 操作人补齐 / 降级
  // ==========================================================================

  describe('operator 补齐与降级', () => {
    it('批量补齐展示名与角色（一次 in 查询，不用 AdminRbacService 逐行查）', async () => {
      prisma.adminAuditLog.findMany.mockResolvedValueOnce([auditRow({ adminUserId: ADMIN_ID })]);
      prisma.adminUser.findMany.mockResolvedValue([
        { id: ADMIN_ID, username: 'ops@soulmap.cn', nickname: null, realName: '运营小李', isSuperAdmin: false },
      ]);
      prisma.adminUserRole.findMany.mockResolvedValue([
        { adminUserId: ADMIN_ID, role: { code: 'OPERATOR', deletedAt: null } },
        { adminUserId: ADMIN_ID, role: { code: 'FINANCE', deletedAt: null } },
        // 已软删的角色不产生角色码
        { adminUserId: ADMIN_ID, role: { code: 'GONE', deletedAt: new Date('2026-01-01T00:00:00.000Z') } },
      ]);

      const view = await service.list(query());

      expect(view.items[0]?.operator).toEqual({
        adminId: ADMIN_ID,
        // nickname 缺失 → realName（与 AdminAuthService 的展示口径一致）
        displayName: '运营小李',
        username: 'ops@soulmap.cn',
        roles: ['FINANCE', 'OPERATOR'],
      });
      expect(prisma.adminUser.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.adminUserRole.findMany).toHaveBeenCalledTimes(1);
      // 临时授权过期即失效（与 AdminRbacService.resolve 同一口径）
      expect(prisma.adminUserRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            adminUserId: { in: [ADMIN_ID] },
            OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
          }),
        }),
      );
    });

    it('超管的 roles 恒为 ["SUPER_ADMIN"]（权限来自 *，不依赖角色表配置）', async () => {
      prisma.adminAuditLog.findMany.mockResolvedValueOnce([auditRow({ adminUserId: ADMIN_ID })]);
      prisma.adminUser.findMany.mockResolvedValue([
        { id: ADMIN_ID, username: 'admin@soulmap.cn', nickname: '超级管理员', realName: null, isSuperAdmin: true },
      ]);

      const view = await service.list(query());

      expect(view.items[0]?.operator.roles).toEqual(['SUPER_ADMIN']);
    });

    it('【关键】管理员被软删/不存在时不崩：回退审计行冗余的用户名，roles 为空', async () => {
      prisma.adminAuditLog.findMany.mockResolvedValueOnce([auditRow({ adminUserId: ADMIN_ID })]);
      prisma.adminUser.findMany.mockResolvedValue([]);

      const view = await service.list(query());

      expect(view.items[0]?.operator).toEqual({
        adminId: ADMIN_ID,
        displayName: 'admin@soulmap.cn',
        username: 'admin@soulmap.cn',
        roles: [],
      });
    });

    it('登录失败且账号不存在（adminUserId = null）时展示名同样不崩，且一次库都不查', async () => {
      prisma.adminAuditLog.findMany.mockResolvedValueOnce([
        auditRow({
          adminUserId: null,
          adminUsername: 'ghost@soulmap.cn',
          action: 'LOGIN_FAILED',
          resourceType: 'admin_user',
          success: false,
          errorCode: '20012',
        }),
      ]);

      const view = await service.list(query());

      expect(view.items[0]?.operator).toEqual({
        adminId: null,
        displayName: 'ghost@soulmap.cn',
        username: 'ghost@soulmap.cn',
        roles: [],
      });
      expect(prisma.adminUser.findMany).not.toHaveBeenCalled();
      expect(view.items[0]?.result).toBe('FAILED');
    });
  });

  // ==========================================================================
  // 摘要统计
  // ==========================================================================

  describe('summary（基于当前过滤条件，不拉全表）', () => {
    it('【关键】计数、Top 榜与 7 天趋势', async () => {
      prisma.adminAuditLog.count
        .mockResolvedValueOnce(186) // 主查询 total
        .mockResolvedValueOnce(12) // CRITICAL
        .mockResolvedValueOnce(48) // SENSITIVE
        .mockResolvedValueOnce(4) // FAILED
        .mockResolvedValueOnce(18); // DENIED

      prisma.adminAuditLog.groupBy
        .mockResolvedValueOnce([
          { action: 'REFUND', resourceType: 'order', _count: { _all: 4 } },
          { action: 'CONFIG_CHANGE', resourceType: 'config', _count: { _all: 6 } },
          { action: 'UPDATE', resourceType: 'system_config', _count: { _all: 2 } },
          { action: 'LOGIN', resourceType: 'admin_user', _count: { _all: 142 } },
        ])
        .mockResolvedValueOnce([
          { adminUserId: ADMIN_ID, _count: { _all: 142 } },
          { adminUserId: ADMIN_ID_2, _count: { _all: 32 } },
        ]);

      prisma.adminAuditLog.findMany
        .mockResolvedValueOnce([]) // 主查询（本用例只关心摘要）
        .mockResolvedValueOnce([
          { createdAt: new Date('2026-02-08T09:00:00.000Z'), action: 'CONFIG_CHANGE', resourceType: 'config' },
          { createdAt: new Date('2026-02-14T10:00:00.000Z'), action: 'REFUND', resourceType: 'order' },
          { createdAt: new Date('2026-02-14T11:00:00.000Z'), action: 'LOGIN', resourceType: 'admin_user' },
        ]);

      prisma.adminUser.findMany.mockResolvedValue([
        { id: ADMIN_ID, username: 'admin@soulmap.cn', nickname: '超级管理员', realName: null, isSuperAdmin: true },
        { id: ADMIN_ID_2, username: 'editor@soulmap.cn', nickname: '内容编辑', realName: null, isSuperAdmin: true },
      ]);

      const view = await service.list(query());
      const summary = view.summary;

      expect(summary.totalLogs).toBe(186);
      expect(summary.criticalCount).toBe(12);
      expect(summary.sensitiveCount).toBe(48);
      // NORMAL 用减法：保证 12 + 48 + 126 = 186（与契约示例完全一致）
      expect(summary.normalCount).toBe(126);
      expect(summary.failedCount).toBe(4);
      expect(summary.deniedCount).toBe(18);

      // byAction 按**权限点**合并（CONFIG_CHANGE 6 + UPDATE 2 → system:config:write 8）
      expect(summary.byAction[0]).toEqual({ action: 'admin:auth:login', count: 142 });
      expect(summary.byAction).toContainEqual({ action: 'system:config:write', count: 8 });
      expect(summary.byAction).toContainEqual({ action: 'payment:order:refund', count: 4 });

      expect(summary.byOperator).toEqual([
        { adminId: ADMIN_ID, displayName: '超级管理员', count: 142 },
        { adminId: ADMIN_ID_2, displayName: '内容编辑', count: 32 },
      ]);

      // 趋势：endTime 所在 UTC 日（2026-02-14）往前 7 天，缺数据的日子补 0
      expect(summary.weeklyTrend.map((point) => point.date)).toEqual([
        '2026-02-08',
        '2026-02-09',
        '2026-02-10',
        '2026-02-11',
        '2026-02-12',
        '2026-02-13',
        '2026-02-14',
      ]);
      expect(summary.weeklyTrend[0]).toEqual({ date: '2026-02-08', count: 1, criticalCount: 1 });
      expect(summary.weeklyTrend[3]).toEqual({ date: '2026-02-11', count: 0, criticalCount: 0 });
      expect(summary.weeklyTrend[6]).toEqual({ date: '2026-02-14', count: 2, criticalCount: 1 });

      // 固定 SQL 条数：1(count) + 4(count) + 2(groupBy) + 2(findMany) —— 无 N+1、无全表扫描
      expect(prisma.adminAuditLog.count).toHaveBeenCalledTimes(5);
      expect(prisma.adminAuditLog.groupBy).toHaveBeenCalledTimes(2);
      expect(prisma.adminAuditLog.findMany).toHaveBeenCalledTimes(2);
    });

    it('byOperator 排除 adminUserId 为 NULL 的记录（无法归属到具体管理员）', async () => {
      await service.list(query());

      expect(prisma.adminAuditLog.groupBy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          by: ['adminUserId'],
          where: expect.objectContaining({
            AND: expect.arrayContaining([{ adminUserId: { not: null } }]),
          }),
        }),
      );
    });

    it('趋势查询限制在 7 天窗口内（不是整个 90 天范围）', async () => {
      await service.list(query());

      const trendArgs = prisma.adminAuditLog.findMany.mock.calls[1]?.[0] as { where: WhereInput; select: unknown };

      expect(trendArgs.where['AND']).toContainEqual({
        createdAt: {
          gte: new Date('2026-02-08T00:00:00.000Z'),
          lt: new Date('2026-02-15T00:00:00.000Z'),
        },
      });
      // 只取分桶需要的 3 列
      expect(trendArgs.select).toEqual({ createdAt: true, action: true, resourceType: true });
    });

    it('summary 的数字基于过滤条件（而不是当前页）：过滤条数变小时摘要跟着变小', async () => {
      prisma.adminAuditLog.count.mockResolvedValue(3);

      const view = await service.list(query({ severity: 'CRITICAL' }));

      expect(view).toMatchObject({ total: 3 });
      expect(view.summary.totalLogs).toBe(3);
      // criticalCount / sensitiveCount 同 mock 值 3 → NORMAL 补集被夹到 0，不会出现负数
      expect(view.summary.normalCount).toBe(0);
    });

    it('retentionNotice 为契约原文（保留 1 年）', async () => {
      const view = await service.list(query());

      expect(view.retentionNotice).toBe(RETENTION_NOTICE);
      expect(RETENTION_NOTICE).toBe('审计日志保留 1 年（法定合规要求）；超过保留期的日志将归档至冷存储。');
    });
  });

  // ==========================================================================
  // 映射表本身（契约与 schema 的落差都集中在这里）
  // ==========================================================================

  describe('映射表（契约 §3.14.9.3 ↔ admin_audit_logs）', () => {
    it('覆盖契约要求的全部组合', () => {
      expect(resolveAuditAction('config', 'CONFIG_CHANGE').permission).toBe('system:config:write');
      expect(resolveAuditAction('CONFIG', 'UPDATE').permission).toBe('system:config:write');
      expect(resolveAuditAction('system_config', 'UPDATE').permission).toBe('system:config:write');

      expect(resolveAuditAction('admin_user', 'CREATE').permission).toBe('system:admin:write');
      expect(resolveAuditAction('admin_user', 'UPDATE').permission).toBe('system:admin:write');
      expect(resolveAuditAction('admin_user', 'LOGIN').permission).toBe('admin:auth:login');
      expect(resolveAuditAction('admin_user', 'LOGOUT').permission).toBe('admin:auth:logout');
      expect(resolveAuditAction('admin_user', 'LOGIN_FAILED').permission).toBe('admin:auth:login');

      expect(resolveAuditAction('role', 'UPDATE').permission).toBe('system:role:write');

      expect(resolveAuditAction('prompt', 'PUBLISH').permission).toBe('ai:prompt:publish');
      expect(resolveAuditAction('prompt', 'ROLLBACK').permission).toBe('ai:prompt:publish');

      expect(resolveAuditAction('order', 'REFUND').permission).toBe('payment:order:refund');
      expect(resolveAuditAction('order', 'EXPORT').permission).toBe('payment:order:export');

      expect(resolveAuditAction('user_profile', 'UPDATE').permission).toBe('user:user:write');
    });

    it('风险等级严格按契约业务规则 2（CRITICAL / SENSITIVE / 其余 NORMAL）', () => {
      expect(resolveAuditAction('order', 'REFUND').severity).toBe('CRITICAL');
      expect(resolveAuditAction('order', 'EXPORT').severity).toBe('CRITICAL');
      expect(resolveAuditAction('admin_user', 'UPDATE').severity).toBe('CRITICAL');
      expect(resolveAuditAction('role', 'UPDATE').severity).toBe('CRITICAL');
      expect(resolveAuditAction('config', 'CONFIG_CHANGE').severity).toBe('CRITICAL');

      expect(resolveAuditAction('prompt', 'PUBLISH').severity).toBe('SENSITIVE');
      expect(resolveAuditAction('user', 'UPDATE').severity).toBe('SENSITIVE');

      expect(resolveAuditAction('admin_user', 'LOGIN').severity).toBe('NORMAL');
      expect(resolveAuditAction('admin_user', 'LOGOUT').severity).toBe('NORMAL');
      // 未登记的组合 → 回退权限点 `order:import` 也不在契约的等级表里 → NORMAL
      expect(resolveAuditAction('order', 'IMPORT').severity).toBe('NORMAL');
    });

    it('targetType 归一：别名 → 契约枚举，未知值原样返回（不捏造）', () => {
      expect(displayTargetType('admin_user')).toBe('ADMIN');
      expect(displayTargetType('admin')).toBe('ADMIN');
      expect(displayTargetType('user_profile')).toBe('USER');
      expect(displayTargetType('system_config')).toBe('CONFIG');
      expect(displayTargetType('prompt_template')).toBe('PROMPT');
      expect(displayTargetType('MBTI_REPORT_UNKNOWN')).toBe('MBTI_REPORT_UNKNOWN');
    });
  });
});
