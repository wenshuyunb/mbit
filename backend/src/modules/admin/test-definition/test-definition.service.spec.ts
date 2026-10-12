/**
 * AdminTestDefinitionService 单测
 *
 * 重点覆盖三类**容易写错且后果明确**的行为：
 *   1. 查询映射：契约 `category`（2 个取值）→ `TestCategory`（4 个取值）的过滤与回显
 *   2. 就绪判定：`readiness.blockers` 必须与运行期「按定义名下题目下发试卷」的判据一致，
 *      否则会出现「后台显示就绪、用户一点就报 40011」
 *   3. 题目转移的连带影响：抽取其他定义的题目会把那些定义打挂，必须拒绝
 *
 * 这里用**手写 mock** 而不是 `Test.createTestingModule`：Service 只依赖两个能力
 * （Prisma 查询 + 审计写入），真实 Prisma 类型会让 mock 变成一大坨类型体操，
 * 而测试要断言的只是「查询条件是否正确」「校验是否拦住」。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { ENGINE_VERSION } from '../../personality/engine/personality-engine.types';
import type { AdminAuditService } from '../audit/admin-audit.service';
import { ListTestDefinitionsQueryDto, type CreateTestDefinitionDto } from './dto/test-definition.dto';
import { AdminTestDefinitionService } from './test-definition.service';

// ============================================================================
// 测试替身
// ============================================================================

const ADMIN_ROW = { id: 'admin-1', username: 'root', nickname: '超级管理员', realName: null };

/** 一行的默认形态（各用例按需覆盖） */
const definitionRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'def-1',
  code: 'MBTI_LITE',
  name: 'MBTI 精简版',
  description: '基于荣格类型学的四维度人格速测，约 5 分钟完成。',
  version: '1.3.0',
  questionCount: 32,
  estimatedMinutes: 5,
  sortOrder: 10,
  isActive: true,
  status: 'ACTIVE',
  category: 'MBTI',
  dimensionQuotas: null,
  scoringConfig: { scoringModel: 'MBTI_DIMENSION', engineVersion: ENGINE_VERSION },
  resultTemplate: { subtitle: '32 题 · 约 5 分钟', isFree: true, requiredEntitlement: null },
  createdAt: new Date('2026-01-05T02:00:00.000Z'),
  updatedAt: new Date('2026-02-01T07:20:00.000Z'),
  ...overrides,
});

const createDto = (overrides: Partial<CreateTestDefinitionDto> = {}): CreateTestDefinitionDto => ({
  code: 'MBTI_TEEN',
  name: 'MBTI 青少年版',
  subtitle: '36 题 · 约 6 分钟',
  description: '面向 14–17 岁用户的简化测评，题干用词更日常，用于自我探索（不做恋爱匹配）。',
  category: 'PERSONALITY',
  version: '1.0.0',
  questionCount: 36,
  estimatedMinutes: 6,
  scoringModel: 'MBTI_DIMENSION',
  quotaConfig: [
    { dimension: 'EI', quota: 9 },
    { dimension: 'SN', quota: 9 },
    { dimension: 'TF', quota: 9 },
    { dimension: 'JP', quota: 9 },
  ],
  ...overrides,
});

const listQuery = (overrides: Partial<ListTestDefinitionsQueryDto> = {}): ListTestDefinitionsQueryDto =>
  // 复用 DTO 自身的默认值（page=1 / pageSize=20），避免测试里再写一遍默认分页
  Object.assign(new ListTestDefinitionsQueryDto(), overrides);

interface Harness {
  service: AdminTestDefinitionService;
  prisma: {
    adminUser: { findFirst: jest.Mock };
    adminAuditLog: { findFirst: jest.Mock };
    testDefinition: { count: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock };
    question: { findMany: jest.Mock; groupBy: jest.Mock; updateMany: jest.Mock };
    testSession: { groupBy: jest.Mock };
    $transaction: jest.Mock;
  };
  audit: { log: jest.Mock };
}

const createHarness = (): Harness => {
  const prisma = {
    adminUser: { findFirst: jest.fn().mockResolvedValue(ADMIN_ROW) },
    adminAuditLog: { findFirst: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    testDefinition: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    question: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    testSession: { groupBy: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };

  // 落地的事务替身：把 tx 原样交给回调，让被测代码走真实分支
  const tx = {
    testDefinition: { create: prisma.testDefinition.create },
    question: { updateMany: prisma.question.updateMany },
  };
  prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));

  const audit = { log: jest.fn().mockResolvedValue(true) };

  const service = new AdminTestDefinitionService(
    prisma as unknown as PrismaService,
    audit as unknown as AdminAuditService,
  );

  return { service, prisma, audit };
};

// ============================================================================
// GET /api/v1/admin/test-definitions
// ============================================================================

describe('AdminTestDefinitionService.list', () => {
  it('契约 category 映射到数据库的多取值集合（PERSONALITY → MBTI/BIG_FIVE/COMPREHENSIVE）', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.findMany.mockResolvedValue([definitionRow()]);

    await harness.service.list(listQuery({ category: 'PERSONALITY', isActive: true }));

    expect(harness.prisma.testDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          isActive: true,
          category: { in: ['MBTI', 'BIG_FIVE', 'COMPREHENSIVE'] },
        },
      }),
    );
  });

  it('RELATIONSHIP 只映射 RELATIONSHIP_STYLE', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.findMany.mockResolvedValue([]);

    await harness.service.list(listQuery({ category: 'RELATIONSHIP' }));

    expect(harness.prisma.testDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, category: { in: ['RELATIONSHIP_STYLE'] } } }),
    );
  });

  it('分页参数生效，hasNext 按 total 计算', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.count.mockResolvedValue(45);
    harness.prisma.testDefinition.findMany.mockResolvedValue([definitionRow()]);

    const result = await harness.service.list(listQuery({ page: 2, pageSize: 20 }));

    expect(harness.prisma.testDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
    expect(result).toMatchObject({ page: 2, pageSize: 20, total: 45, hasNext: true });
  });

  it('sessionStats 由会话状态聚合得出（完成率与平均时长）', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.findMany.mockResolvedValue([definitionRow()]);
    harness.prisma.testSession.groupBy
      // 第一次：按状态计数
      .mockResolvedValueOnce([
        { testDefinitionId: 'def-1', status: 'REPORT_READY', _count: { _all: 6000 } },
        { testDefinitionId: 'def-1', status: 'SCORED', _count: { _all: 2376 } },
        { testDefinitionId: 'def-1', status: 'ABANDONED', _count: { _all: 2016 } },
      ])
      // 第二次：已完成会话的平均时长
      .mockResolvedValueOnce([{ testDefinitionId: 'def-1', _avg: { durationMs: 444_000 } }]);

    const result = await harness.service.list(listQuery());

    expect(result.items[0].sessionStats).toEqual({
      totalSessions: 10_392,
      completedSessions: 8376,
      completionRate: 0.806,
      averageMinutes: 7.4,
    });
  });

  it('【关键】quotaConfig 的 isSufficient 与题库实际可用量比较，任一不足即为风险', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.findMany.mockResolvedValue([
      definitionRow({
        dimensionQuotas: { EI: 9, SN: 9, TF: 9, JP: 9 },
        questionCount: 36,
      }),
    ]);
    harness.prisma.question.groupBy.mockResolvedValue([
      { testDefinitionId: 'def-1', dimension: 'EI', _count: { _all: 10 } },
      { testDefinitionId: 'def-1', dimension: 'SN', _count: { _all: 8 } },
      { testDefinitionId: 'def-1', dimension: 'TF', _count: { _all: 10 } },
      { testDefinitionId: 'def-1', dimension: 'JP', _count: { _all: 10 } },
    ]);

    const result = await harness.service.list(listQuery());
    const quotaConfig = result.items[0].quotaConfig;

    expect(quotaConfig).toHaveLength(4);
    expect(quotaConfig.find((item) => item.dimension === 'EI')).toEqual({
      dimension: 'EI',
      quota: 9,
      availableCount: 10,
      isSufficient: true,
    });
    // SN 只有 8 题但配额 9 → 不足
    expect(quotaConfig.find((item) => item.dimension === 'SN')).toEqual({
      dimension: 'SN',
      quota: 9,
      availableCount: 8,
      isSufficient: false,
    });
  });

  it('未配置维度配额时 quotaConfig 为空数组（不臆造配额）', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.findMany.mockResolvedValue([definitionRow({ dimensionQuotas: null })]);

    const result = await harness.service.list(listQuery());

    expect(result.items[0].quotaConfig).toEqual([]);
  });

  it('questionIds 仅在 includeQuestionIds=true 时返回', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.findMany.mockResolvedValue([definitionRow()]);

    const withoutIds = await harness.service.list(listQuery());
    expect(withoutIds.items[0].questionIds).toBeUndefined();

    harness.prisma.question.findMany.mockResolvedValue([{ id: 'q-1', testDefinitionId: 'def-1' }]);
    const withIds = await harness.service.list(listQuery({ includeQuestionIds: true }));

    expect(withIds.items[0].questionIds).toEqual(['q-1']);
  });

  it('summary 为全局口径（与分页结果无关）', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.count.mockResolvedValue(4);
    harness.prisma.testDefinition.findMany.mockResolvedValueOnce([definitionRow()]).mockResolvedValueOnce([
      { id: 'def-1', dimensionQuotas: { EI: 100 } },
      { id: 'def-2', dimensionQuotas: { EI: 1 } },
    ]);
    harness.prisma.question.groupBy.mockResolvedValue([
      { testDefinitionId: 'def-1', dimension: 'EI', _count: { _all: 8 } },
      { testDefinitionId: 'def-2', dimension: 'EI', _count: { _all: 5 } },
    ]);

    const result = await harness.service.list(listQuery());

    expect(result.items).toHaveLength(1);
    expect(result.summary).toEqual({
      totalDefinitions: 4,
      activeDefinitions: 4,
      insufficientQuotaDefinitions: 1,
    });
  });

  it('未配置任何维度配额时汇总不做无谓的题库统计', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.findMany.mockResolvedValue([definitionRow()]);

    await harness.service.list(listQuery());

    // 第一次 findMany 是列表页，第二次是汇总里的「有配额的定义」
    expect(harness.prisma.testDefinition.findMany).toHaveBeenCalledTimes(2);
    expect(harness.prisma.testDefinition.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { deletedAt: null, NOT: { dimensionQuotas: { equals: expect.anything() } } } }),
    );
  });
});

// ============================================================================
// POST /api/v1/admin/test-definitions
// ============================================================================

describe('AdminTestDefinitionService.create', () => {
  const setupCreate = (harness: Harness, poolCounts: Record<string, number> = { EI: 9, SN: 9, TF: 9, JP: 9 }): void => {
    harness.prisma.testDefinition.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      definitionRow({
        ...data,
        id: 'def-new',
        createdAt: new Date('2026-02-14T20:00:00.000Z'),
        updatedAt: new Date('2026-02-14T20:00:00.000Z'),
      }),
    );
    harness.prisma.question.groupBy.mockResolvedValue(
      Object.entries(poolCounts).map(([dimension, count]) => ({
        testDefinitionId: 'def-new',
        dimension,
        _count: { _all: count },
      })),
    );
  };

  it('新建默认下线：status=DRAFT、isActive=false、statusLabel=未启用（草稿）', async () => {
    const harness = createHarness();
    setupCreate(harness);

    const result = await harness.service.create(createDto(), 'admin-1', {});

    expect(harness.prisma.testDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'MBTI_TEEN',
          category: 'MBTI',
          status: 'DRAFT',
          isActive: false,
          selectionMode: 'DIMENSION_QUOTA',
        }),
      }),
    );
    expect(result).toMatchObject({
      isActive: false,
      statusLabel: '未启用（草稿）',
      category: 'PERSONALITY',
      engineVersion: ENGINE_VERSION,
      createdBy: '超级管理员',
      auditLogId: 'audit-1',
      cacheInvalidated: false,
    });
  });

  it('【关键】题量不足时 readiness 阻塞启用（与运行期下发试卷的判据一致）', async () => {
    const harness = createHarness();
    setupCreate(harness, { EI: 1, SN: 1, TF: 1, JP: 1 });

    const result = await harness.service.create(createDto(), 'admin-1', {});

    expect(result.readiness.isReady).toBe(false);
    expect(result.readiness.blockers.join('\n')).toContain('少于 questionCount=36');
  });

  it('【关键】配额合计 ≠ questionCount 直接拒绝（400/10001）', async () => {
    const harness = createHarness();
    setupCreate(harness);

    await expect(
      harness.service.create(
        createDto({
          quotaConfig: [
            { dimension: 'EI', quota: 9 },
            { dimension: 'SN', quota: 9 },
          ],
        }),
        'admin-1',
        {},
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
  });

  it('【关键】计分模型与维度不匹配直接拒绝（BIG_FIVE_SUM 不接受 EI）', async () => {
    const harness = createHarness();
    setupCreate(harness);

    await expect(
      harness.service.create(createDto({ scoringModel: 'BIG_FIVE_SUM' }), 'admin-1', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
  });

  it('付费定义缺少 requiredEntitlement 直接拒绝', async () => {
    const harness = createHarness();
    setupCreate(harness);

    await expect(harness.service.create(createDto({ isFree: false }), 'admin-1', {})).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID,
    });
  });

  it('付费定义写明权益后通过，并把权益落进 result_template', async () => {
    const harness = createHarness();
    setupCreate(harness);

    const result = await harness.service.create(
      createDto({ isFree: false, requiredEntitlement: 'MEMBERSHIP_ACTIVE' }),
      'admin-1',
      {},
    );

    expect(harness.prisma.testDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resultTemplate: { subtitle: '36 题 · 约 6 分钟', isFree: false, requiredEntitlement: 'MEMBERSHIP_ACTIVE' },
        }),
      }),
    );
    expect(result.isFree).toBe(false);
  });

  it('code 已存在返回 409（含软删除行：唯一约束覆盖它们）', async () => {
    const harness = createHarness();
    setupCreate(harness);
    harness.prisma.testDefinition.findFirst.mockResolvedValue({ id: 'def-old' });

    await expect(harness.service.create(createDto(), 'admin-1', {})).rejects.toMatchObject({
      code: ErrorCode.RESOURCE_CONFLICT,
    });
    expect(harness.prisma.testDefinition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'MBTI_TEEN' } }),
    );
  });

  it('questionIds 含不存在/停用题目时拒绝并列出缺失项', async () => {
    const harness = createHarness();
    setupCreate(harness);
    harness.prisma.question.findMany.mockResolvedValue([{ id: 'q-1', testDefinitionId: 'def-1' }]);

    await expect(
      harness.service.create(createDto({ questionIds: ['q-1', 'q-missing'] }), 'admin-1', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
  });

  it('【关键】抽取题目会让来源定义题量不足时拒绝（不能一次新建打挂另一个在架测试）', async () => {
    const harness = createHarness();
    setupCreate(harness);
    harness.prisma.question.findMany.mockResolvedValue([
      { id: 'q-1', testDefinitionId: 'def-1' },
      { id: 'q-2', testDefinitionId: 'def-1' },
    ]);
    harness.prisma.testDefinition.findMany.mockResolvedValue([{ id: 'def-1', code: 'MBTI_LITE', questionCount: 32 }]);
    // 来源定义只有 33 题，抽走 2 题后剩 31 < 32
    harness.prisma.question.groupBy.mockResolvedValue([
      { testDefinitionId: 'def-1', dimension: 'EI', _count: { _all: 33 } },
    ]);

    await expect(
      harness.service.create(createDto({ questionIds: ['q-1', 'q-2'] }), 'admin-1', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
  });

  it('题目转移在事务内完成，并在 readiness 中提示来源定义', async () => {
    const harness = createHarness();
    setupCreate(harness);
    harness.prisma.question.findMany.mockResolvedValue([{ id: 'q-1', testDefinitionId: 'def-1' }]);
    harness.prisma.testDefinition.findMany.mockResolvedValue([{ id: 'def-1', code: 'MBTI_LITE', questionCount: 32 }]);
    harness.prisma.question.groupBy.mockResolvedValue([
      { testDefinitionId: 'def-1', dimension: 'EI', _count: { _all: 40 } },
      { testDefinitionId: 'def-new', dimension: 'EI', _count: { _all: 9 } },
      { testDefinitionId: 'def-new', dimension: 'SN', _count: { _all: 9 } },
      { testDefinitionId: 'def-new', dimension: 'TF', _count: { _all: 9 } },
      { testDefinitionId: 'def-new', dimension: 'JP', _count: { _all: 9 } },
    ]);

    const result = await harness.service.create(createDto({ questionIds: ['q-1'] }), 'admin-1', {});

    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.prisma.question.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['q-1'] } },
      data: { testDefinitionId: 'def-new' },
    });
    expect(result.readiness.warnings.join('\n')).toContain('MBTI_LITE');
  });

  it('写审计时记录 before/after（新建的 beforeData 为 null）', async () => {
    const harness = createHarness();
    setupCreate(harness);

    await harness.service.create(createDto(), 'admin-1', { ip: '10.0.0.1', requestId: 'req-1' });

    expect(harness.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: 'admin-1',
        adminUsername: 'root',
        action: 'CREATE',
        resourceType: 'test_definition',
        resourceId: 'def-new',
        beforeData: null,
        afterData: expect.objectContaining({ code: 'MBTI_TEEN', scoringModel: 'MBTI_DIMENSION' }),
        ip: '10.0.0.1',
        requestId: 'req-1',
      }),
    );
  });

  it('审计写入失败不影响业务结果（auditLogId 为 null）', async () => {
    const harness = createHarness();
    setupCreate(harness);
    harness.audit.log.mockResolvedValue(false);

    const result = await harness.service.create(createDto(), 'admin-1', {});

    expect(result.auditLogId).toBeNull();
    expect(result.testDefinitionId).toBe('def-new');
  });

  it('管理员不存在时返回 20022（避免审计写入无主体）', async () => {
    const harness = createHarness();
    setupCreate(harness);
    harness.prisma.adminUser.findFirst.mockResolvedValue(null);

    await expect(harness.service.create(createDto(), 'ghost', {})).rejects.toThrow(BusinessException);
  });
});
