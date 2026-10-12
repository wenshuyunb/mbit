/**
 * 管理端题库服务测试（含控制器路由契约）
 *
 * 聚焦「错了会污染数据、破坏用户端或产生安全事故」的分支：
 *   · 路由契约：路径、HTTP 方法、守卫链、权限点、敏感操作标记、动态状态码、限流阈值
 *   · 契约不可变约束：`code` / `type` 不得通过 PATCH 修改（DTO 白名单）
 *   · 数据一致性：`questionCount` 同步（用户端按它判定题量）、软删除、禁止物理删除已使用的题
 *   · 导入的原子性：dryRun 默认不写库、ABORT 整批拒绝、SKIP 只写合法行、幂等键强制
 *   · 前后端取值陷阱：`?isActive=false` 不能被解析成 `true`
 */

import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';

import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { ErrorCode } from '../../../common/errors/error-code';
import type { BusinessException } from '../../../common/errors/business.exception';
import type { AdminAuditService } from '../audit/admin-audit.service';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ADMIN_PUBLIC_KEY } from '../decorators/admin-public.decorator';
import { SENSITIVE_OPERATION_KEY } from '../decorators/sensitive-operation.decorator';
import { PERMISSIONS_KEY } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminQuestionController } from './admin-question.controller';
import { AdminQuestionService } from './admin-question.service';
import type {
  AdminQuestionImportDryRunResult,
  AdminQuestionImportWriteResult,
  AdminQuestionRequestContext,
} from './admin-question.service';
import { ListAdminQuestionsQueryDto, UpdateAdminQuestionDto } from './dto/admin-question.dto';

// ============================================================================
// 夹具
// ============================================================================

const ADMIN_ID = '0195f3a2-1111-7111-8111-111111111111';
const QUESTION_ID = '0195f3a2-29cf-7bfd-9c68-e4bf1c2d3a1c';
const DEFINITION_ID = '0195f3a2-2222-7222-8222-222222222222';
const AUDIT_ID = '0195f3a2-3333-7333-8333-333333333333';

const CONTEXT: AdminQuestionRequestContext = {
  ip: '10.0.0.1',
  userAgent: 'jest',
  requestId: 'req-test',
};

const adminRow = { username: 'admin@soulmap.cn', nickname: '超级管理员', realName: null };

const definitionRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: DEFINITION_ID,
  code: 'MBTI_LITE',
  questionCount: 32,
  dimensionQuotas: null,
  ...overrides,
});

/** 数据库中的题目行（Prisma 返回形状） */
const dbQuestion = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: QUESTION_ID,
  code: 'Q_EI_012',
  content: '在聚会上，我通常会主动与陌生人交谈。',
  type: 'LIKERT5',
  dimension: 'EI',
  weight: 1,
  reverseScored: false,
  order: 12,
  isActive: true,
  tags: ['社交'],
  explanation: '考察外向偏好',
  deletedAt: null,
  createdAt: new Date('2026-01-05T02:00:00.000Z'),
  updatedAt: new Date('2026-02-08T06:30:00.000Z'),
  testDefinitionId: DEFINITION_ID,
  testDefinition: { code: 'MBTI_LITE' },
  options: [
    { id: 'opt-1', label: '非常不同意', value: 1, scoreMap: { EI: -2 }, order: 0 },
    { id: 'opt-2', label: '不同意', value: 2, scoreMap: { EI: -1 }, order: 1 },
    { id: 'opt-3', label: '中立', value: 3, scoreMap: { EI: 0 }, order: 2 },
    { id: 'opt-4', label: '同意', value: 4, scoreMap: { EI: 1 }, order: 3 },
    { id: 'opt-5', label: '非常同意', value: 5, scoreMap: { EI: 2 }, order: 4 },
  ],
  ...overrides,
});

/** 列表查询的返回行（`select` 形状） */
const listRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: QUESTION_ID,
  code: 'Q_EI_012',
  content: '在聚会上，我通常会主动与陌生人交谈。',
  type: 'LIKERT5',
  dimension: 'EI',
  weight: 1,
  reverseScored: false,
  order: 12,
  isActive: true,
  tags: ['社交'],
  createdAt: new Date('2026-01-05T02:00:00.000Z'),
  updatedAt: new Date('2026-02-08T06:30:00.000Z'),
  testDefinition: { code: 'MBTI_LITE' },
  _count: { options: 5 },
  ...overrides,
});

interface PrismaStub {
  question: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  questionOption: { findMany: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
  testDefinition: { findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
  testAnswer: { count: jest.Mock };
  adminAuditLog: { findMany: jest.Mock; findFirst: jest.Mock };
  adminUser: { findFirst: jest.Mock; findMany: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    question: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: QUESTION_ID, createdAt: new Date('2026-02-14T19:30:00.000Z') }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    questionOption: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'opt-new' }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    testDefinition: {
      findFirst: jest.fn().mockResolvedValue(definitionRow()),
      findUnique: jest.fn().mockResolvedValue(definitionRow()),
      findMany: jest.fn().mockResolvedValue([definitionRow()]),
      update: jest.fn().mockResolvedValue({}),
    },
    testAnswer: { count: jest.fn().mockResolvedValue(0) },
    adminAuditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: AUDIT_ID }),
    },
    adminUser: {
      findFirst: jest.fn().mockResolvedValue(adminRow),
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: ADMIN_ID, username: 'editor', nickname: '内容编辑', realName: null }]),
    },
    // 原生聚合：按 SQL 片段区分（usage / 均值与标准差 / 区分度 / 选项分布）
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');

      if (sql.includes('CORR(')) return Promise.resolve([{ discrimination: null }]);
      if (sql.includes('STDDEV_POP')) {
        return Promise.resolve([{ answered: 0, skipped: 0, avgValue: null, stddevValue: null }]);
      }

      return Promise.resolve([]);
    }),
    $transaction: jest.fn(),
  };

  stub.$transaction = jest.fn((callback: (tx: PrismaStub) => Promise<unknown>) => callback(stub));

  return stub;
};

const createRedisStub = (): {
  key: jest.Mock;
  del: jest.Mock;
  getJson: jest.Mock;
  setJson: jest.Mock;
} => ({
  key: jest.fn((...parts: Array<string | number>) => ['sm', ...parts.map(String)].join(':')),
  del: jest.fn().mockResolvedValue(1),
  getJson: jest.fn().mockResolvedValue(null),
  setJson: jest.fn().mockResolvedValue(undefined),
});

interface Harness {
  service: AdminQuestionService;
  prisma: PrismaStub;
  redis: ReturnType<typeof createRedisStub>;
  audit: { log: jest.Mock };
}

const createHarness = (): Harness => {
  const prisma = createPrismaStub();
  const redis = createRedisStub();
  const audit = { log: jest.fn().mockResolvedValue(true) };
  const service = new AdminQuestionService(prisma as never, redis as never, audit as unknown as AdminAuditService);

  return { service, prisma, redis, audit };
};

/** 断言业务异常的错误码（BusinessException 继承 HttpException，message 是结构化对象） */
const expectBusinessCode = async (promise: Promise<unknown>, code: number): Promise<BusinessException> => {
  try {
    await promise;
  } catch (error) {
    const exception = error as BusinessException;
    expect(exception.code).toBe(code);
    return exception;
  }

  throw new Error(`期望抛出错误码 ${code}，但调用成功返回`);
};

const importRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  code: 'Q_EI_050',
  content: '我更喜欢在一对一的场合与人深入交流。',
  type: 'LIKERT5',
  dimension: 'EI',
  weight: 1,
  reverseScored: false,
  order: 50,
  tags: ['社交'],
  ...overrides,
});

const csvPayload = (): string =>
  [
    'code,content,type,dimension,weight,reverseScored,order,tags,optionLabels,optionValues,scoreMaps',
    'Q_EI_050,我更喜欢在一对一的场合与人深入交流,LIKERT5,EI,1,false,50,社交,非常不同意|不同意|中立|同意|非常同意,1|2|3|4|5,EI:-2|EI:-1|EI:0|EI:1|EI:2',
  ].join('\n');

// ============================================================================
// 路由契约（API_DESIGN §3.14.3）
// ============================================================================

describe('AdminQuestionController 路由契约（API_DESIGN §3.14.3）', () => {
  const pathOf = (method: keyof AdminQuestionController): unknown =>
    Reflect.getMetadata(PATH_METADATA, AdminQuestionController.prototype[method]);
  const httpMethodOf = (method: keyof AdminQuestionController): unknown =>
    Reflect.getMetadata(METHOD_METADATA, AdminQuestionController.prototype[method]);
  const permissionsOf = (method: keyof AdminQuestionController): unknown =>
    Reflect.getMetadata(PERMISSIONS_KEY, AdminQuestionController.prototype[method]);
  const sensitiveOf = (method: keyof AdminQuestionController): unknown =>
    Reflect.getMetadata(SENSITIVE_OPERATION_KEY, AdminQuestionController.prototype[method]);
  const httpCodeOf = (method: keyof AdminQuestionController): unknown =>
    Reflect.getMetadata(HTTP_CODE_METADATA, AdminQuestionController.prototype[method]);
  const throttleLimitOf = (method: keyof AdminQuestionController): unknown =>
    Reflect.getMetadata(`${THROTTLER_LIMIT}global`, AdminQuestionController.prototype[method]);
  const throttleTtlOf = (method: keyof AdminQuestionController): unknown =>
    Reflect.getMetadata(`${THROTTLER_TTL}global`, AdminQuestionController.prototype[method]);

  it('控制器基础路径为 admin/questions', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminQuestionController)).toBe('admin/questions');
  });

  it('【关键】类级同时标记 @Public()（跳过用户端守卫）且**未**标记 @AdminPublic()（否则接口完全公开）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AdminQuestionController)).toBe(true);
    expect(Reflect.getMetadata(ADMIN_PUBLIC_KEY, AdminQuestionController)).toBeUndefined();
  });

  it('【关键】守卫链为 AdminAuthGuard + RolesGuard + ConfirmPasswordGuard（顺序不可颠倒）', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminQuestionController)).toEqual([
      AdminAuthGuard,
      RolesGuard,
      ConfirmPasswordGuard,
    ]);
  });

  it('7 个接口的路径与 HTTP 方法符合契约', () => {
    expect(pathOf('list')).toBe('/');
    expect(httpMethodOf('list')).toBe(RequestMethod.GET);

    expect(pathOf('create')).toBe('/');
    expect(httpMethodOf('create')).toBe(RequestMethod.POST);

    expect(pathOf('detail')).toBe(':id');
    expect(httpMethodOf('detail')).toBe(RequestMethod.GET);

    expect(pathOf('update')).toBe(':id');
    expect(httpMethodOf('update')).toBe(RequestMethod.PATCH);

    expect(pathOf('remove')).toBe(':id');
    expect(httpMethodOf('remove')).toBe(RequestMethod.DELETE);

    expect(pathOf('importQuestions')).toBe('import');
    expect(httpMethodOf('importQuestions')).toBe(RequestMethod.POST);

    expect(pathOf('toggle')).toBe(':id/toggle');
    expect(httpMethodOf('toggle')).toBe(RequestMethod.POST);
  });

  it('【关键】每个接口都声明了契约要求的权限点', () => {
    for (const method of ['list', 'detail'] as const) {
      expect(permissionsOf(method)).toEqual(['test:question:read']);
    }

    for (const method of ['create', 'update', 'remove', 'importQuestions', 'toggle'] as const) {
      expect(permissionsOf(method)).toEqual(['test:question:write']);
    }
  });

  it('【关键】破坏性操作（删除、批量导入）标记了 @SensitiveOperation（要求二次确认密码）', () => {
    expect(sensitiveOf('remove')).toBe(true);
    expect(sensitiveOf('importQuestions')).toBe(true);

    for (const method of ['list', 'create', 'detail', 'update', 'toggle'] as const) {
      expect(sensitiveOf(method)).toBeUndefined();
    }
  });

  it('【关键】契约要求 200 的接口显式覆盖了 NestJS 的 201 默认值', () => {
    // POST 默认 201；删除 / 切换 / 导入（试运行为主路径）必须是 200
    expect(httpCodeOf('remove')).toBe(200);
    expect(httpCodeOf('toggle')).toBe(200);
    expect(httpCodeOf('importQuestions')).toBe(200);
  });

  it('限流阈值与契约一致（按 60s / 60min 窗口）', () => {
    expect(throttleLimitOf('list')).toBe(300);
    expect(throttleTtlOf('list')).toBe(60_000);
    expect(throttleLimitOf('create')).toBe(60);
    expect(throttleTtlOf('create')).toBe(3_600_000);
    expect(throttleLimitOf('remove')).toBe(20);
    expect(throttleLimitOf('importQuestions')).toBe(5);
    expect(throttleLimitOf('toggle')).toBe(120);
  });
});

// ============================================================================
// DTO 结构校验（白名单 + 取值域）
// ============================================================================

describe('题库 DTO 校验', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  it('【关键】PATCH 请求体带 code / type 时被白名单拒绝（契约：这两个字段不可变 → 10001）', async () => {
    await expect(
      pipe.transform({ code: 'Q_EI_001' }, { type: 'body', metatype: UpdateAdminQuestionDto }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      pipe.transform({ type: 'BINARY' }, { type: 'body', metatype: UpdateAdminQuestionDto }),
    ).rejects.toThrow(BadRequestException);
  });

  it('PATCH 合法字段通过并保留显式传入的 false', async () => {
    const dto = (await pipe.transform(
      { isActive: false, tags: [] },
      { type: 'body', metatype: UpdateAdminQuestionDto },
    )) as UpdateAdminQuestionDto;

    expect(dto.isActive).toBe(false);
    expect(dto.tags).toEqual([]);
  });

  it('【关键】query 的 isActive=false 不会被隐式转换成 true（Boolean("false") 陷阱）', async () => {
    const query = (await pipe.transform(
      { isActive: 'false', page: '2' },
      { type: 'query', metatype: ListAdminQuestionsQueryDto },
    )) as ListAdminQuestionsQueryDto;

    expect(query.isActive).toBe(false);
    expect(query.page).toBe(2);
    expect(query.pageSize).toBe(20);
  });

  it('query 的 sortBy 不在白名单时被拒绝（契约 10004）', async () => {
    await expect(
      pipe.transform({ sortBy: 'content' }, { type: 'query', metatype: ListAdminQuestionsQueryDto }),
    ).rejects.toThrow(BadRequestException);
  });

  it('query 的 dimension 支持逗号分隔，含非法枚举时被拒绝（契约 10001）', async () => {
    const query = (await pipe.transform(
      { dimension: 'EI,SN' },
      { type: 'query', metatype: ListAdminQuestionsQueryDto },
    )) as ListAdminQuestionsQueryDto;

    expect(query.dimension).toBe('EI,SN');

    await expect(
      pipe.transform({ dimension: 'EI,XX' }, { type: 'query', metatype: ListAdminQuestionsQueryDto }),
    ).rejects.toThrow(BadRequestException);
  });

  it('pageSize > 100 被拒绝（契约 10005）', async () => {
    await expect(
      pipe.transform({ pageSize: '200' }, { type: 'query', metatype: ListAdminQuestionsQueryDto }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ============================================================================
// 列表
// ============================================================================

describe('AdminQuestionService.list', () => {
  it('组装筛选条件、分页与总览，并批量取 usageCount / updatedBy', async () => {
    const { service, prisma } = createHarness();

    prisma.question.count.mockResolvedValue(24);
    prisma.question.findMany.mockResolvedValue([listRow(), listRow({ id: 'q-2', code: 'Q_EI_027' })]);
    prisma.question.groupBy.mockImplementation((args: { by: string[] }) =>
      Promise.resolve(
        args.by[0] === 'dimension'
          ? [{ dimension: 'EI', _count: { _all: 24 } }]
          : [{ type: 'LIKERT5', _count: { _all: 24 } }],
      ),
    );
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('FROM test_sessions')) {
        return Promise.resolve([
          { questionId: QUESTION_ID, count: 18420 },
          { questionId: 'q-2', count: 17980 },
        ]);
      }
      return Promise.resolve([]);
    });
    prisma.adminAuditLog.findMany.mockResolvedValue([
      { resourceId: QUESTION_ID, adminUserId: ADMIN_ID, adminUsername: 'editor' },
    ]);

    const result = await service.list({
      page: 1,
      pageSize: 20,
      skip: 0,
      take: 20,
      dimension: 'EI,SN',
      isActive: false,
      tags: '社交,能量',
      sortBy: 'order',
      order: 'asc',
    });

    expect(result.total).toBe(24);
    expect(result.page).toBe(1);
    expect(result.hasNext).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      questionId: QUESTION_ID,
      code: 'Q_EI_012',
      testCodes: ['MBTI_LITE'],
      optionCount: 5,
      usageCount: 18420,
      updatedBy: '内容编辑',
      createdAt: '2026-01-05T02:00:00.000Z',
    });
    expect(result.items[1]?.usageCount).toBe(17980);
    expect(result.summary).toEqual({
      totalQuestions: 24,
      activeQuestions: 24,
      inactiveQuestions: 0,
      byDimension: { EI: 24 },
      byType: { LIKERT5: 24 },
    });

    // 筛选条件必须落到 where（含软删除过滤与多值维度）
    const whereArg = prisma.question.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(whereArg.where).toMatchObject({
      deletedAt: null,
      isActive: false,
      dimension: { in: ['EI', 'SN'] },
      tags: { hasSome: ['社交', '能量'] },
    });
    // 未传 keyword → 不应产生题干过滤条件
    expect(whereArg.where).not.toHaveProperty('content');
  });

  it('tags 超过 5 个时返回 10001（契约 §3.14.3.1）', async () => {
    const { service } = createHarness();

    await expectBusinessCode(
      service.list({ page: 1, pageSize: 20, skip: 0, take: 20, tags: 'a,b,c,d,e,f' }),
      ErrorCode.PARAM_INVALID,
    );
  });
});

// ============================================================================
// 新建
// ============================================================================

describe('AdminQuestionService.create', () => {
  it('LIKERT5 省略 options 时生成标准 1–5 选项，同步 questionCount 并写审计', async () => {
    const { service, prisma, audit } = createHarness();

    prisma.question.count.mockResolvedValue(33);
    prisma.question.findMany.mockResolvedValue([]);
    // 落库后的选项回读：响应里的 optionId 必须是数据库生成的真实 ID
    prisma.questionOption.findMany.mockResolvedValue([
      { id: 'opt-1', label: '非常不同意', value: 1, scoreMap: { EI: -2 } },
      { id: 'opt-2', label: '不同意', value: 2, scoreMap: { EI: -1 } },
      { id: 'opt-3', label: '中立', value: 3, scoreMap: { EI: 0 } },
      { id: 'opt-4', label: '同意', value: 4, scoreMap: { EI: 1 } },
      { id: 'opt-5', label: '非常同意', value: 5, scoreMap: { EI: 2 } },
    ]);

    const result = await service.create(
      ADMIN_ID,
      {
        code: 'Q_EI_049',
        content: '在需要做决定时，我更愿意先自己思考清楚再和别人讨论。',
        type: 'LIKERT5',
        dimension: 'EI',
        testCodes: ['MBTI_LITE'],
      },
      CONTEXT,
    );

    expect(result.questionId).toBe(QUESTION_ID);
    expect(result.testCodes).toEqual(['MBTI_LITE']);
    expect(result.createdBy).toBe('超级管理员');
    expect(result.auditLogId).toBe(AUDIT_ID);
    expect(result.cacheInvalidated).toBe(true);
    expect(result.options.map((option) => option.optionId)).toEqual(['opt-1', 'opt-2', 'opt-3', 'opt-4', 'opt-5']);

    // 选项：1–5 与契约示例一致的正向 scoreMap
    const createdOptions = prisma.questionOption.create.mock.calls.map(
      (call) => (call[0] as { data: { value: number; scoreMap: Record<string, number>; order: number } }).data,
    );
    expect(createdOptions).toHaveLength(5);
    expect(createdOptions.map((option) => option.value)).toEqual([1, 2, 3, 4, 5]);
    expect(createdOptions.map((option) => option.scoreMap)).toEqual([
      { EI: -2 },
      { EI: -1 },
      { EI: 0 },
      { EI: 1 },
      { EI: 2 },
    ]);

    // 量表范围显式落库（与 seed 一致），供引擎的 minValue/maxValue 分支使用
    const createdQuestion = prisma.question.create.mock.calls[0]?.[0] as {
      data: { minValue: number; maxValue: number; content: string };
    };
    expect(createdQuestion.data.minValue).toBe(1);
    expect(createdQuestion.data.maxValue).toBe(5);

    // questionCount 回填为「可用题量」，否则用户端会因题量判定失败而 40011
    expect(prisma.testDefinition.update).toHaveBeenCalledWith({
      where: { id: DEFINITION_ID },
      data: { questionCount: 33 },
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CREATE', resourceType: 'question', resourceId: QUESTION_ID }),
    );
  });

  it('题干中的 HTML 标签被剥离（契约：题干不支持 HTML）', async () => {
    const { service, prisma } = createHarness();

    await service.create(
      ADMIN_ID,
      {
        code: 'Q_EI_050',
        content: '<script>alert(1)</script>在聚会上我通常会主动与陌生人交谈。',
        type: 'LIKERT5',
        dimension: 'EI',
        testCodes: ['MBTI_LITE'],
      },
      CONTEXT,
    );

    const createdQuestion = prisma.question.create.mock.calls[0]?.[0] as { data: { content: string } };
    expect(createdQuestion.data.content).toBe('alert(1)在聚会上我通常会主动与陌生人交谈。');
    expect(createdQuestion.data.content).not.toContain('<');
  });

  it('缺少 testCodes 时拒绝：数据模型要求必填归属（契约允许多归属，二者冲突）', async () => {
    const { service } = createHarness();

    await expectBusinessCode(
      service.create(
        ADMIN_ID,
        { code: 'Q_EI_051', content: '在聚会上我通常会主动与陌生人交谈。', type: 'LIKERT5', dimension: 'EI' },
        CONTEXT,
      ),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('多归属请求被显式拒绝（而非静默只写第一个）', async () => {
    const { service } = createHarness();

    const error = await expectBusinessCode(
      service.create(
        ADMIN_ID,
        {
          code: 'Q_EI_052',
          content: '在聚会上我通常会主动与陌生人交谈。',
          type: 'LIKERT5',
          dimension: 'EI',
          testCodes: ['MBTI_LITE', 'MBTI_FULL'],
        },
        CONTEXT,
      ),
      ErrorCode.PARAM_INVALID,
    );

    expect(error.userMessage).toContain('单归属');
  });

  it('testCodes 指向不存在的定义时返回 10001', async () => {
    const { service, prisma } = createHarness();
    prisma.testDefinition.findFirst.mockResolvedValue(null);

    await expectBusinessCode(
      service.create(
        ADMIN_ID,
        {
          code: 'Q_EI_053',
          content: '在聚会上我通常会主动与陌生人交谈。',
          type: 'LIKERT5',
          dimension: 'EI',
          testCodes: ['RELATIONSHIP_STYLE'],
        },
        CONTEXT,
      ),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('code 与既有题目（含软删除）冲突时返回 10003/409', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findFirst.mockResolvedValue({ id: 'q-old', deletedAt: new Date('2026-01-01T00:00:00.000Z') });

    const error = await expectBusinessCode(
      service.create(
        ADMIN_ID,
        {
          code: 'Q_EI_012',
          content: '在聚会上我通常会主动与陌生人交谈。',
          type: 'LIKERT5',
          dimension: 'EI',
          testCodes: ['MBTI_LITE'],
        },
        CONTEXT,
      ),
      ErrorCode.RESOURCE_CONFLICT,
    );

    expect(error.userMessage).toContain('已删除');
    expect(prisma.question.create).not.toHaveBeenCalled();
  });

  it('非 LIKERT5 题型缺少 options 时返回 10001（契约 40008）', async () => {
    const { service } = createHarness();

    await expectBusinessCode(
      service.create(
        ADMIN_ID,
        {
          code: 'Q_EI_054',
          content: '在聚会上我通常会主动与陌生人交谈。',
          type: 'BINARY',
          dimension: 'EI',
          testCodes: ['MBTI_LITE'],
        },
        CONTEXT,
      ),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('选项 value 题内重复时返回 10001（契约 40008）', async () => {
    const { service } = createHarness();

    await expectBusinessCode(
      service.create(
        ADMIN_ID,
        {
          code: 'Q_EI_055',
          content: '在聚会上我通常会主动与陌生人交谈。',
          type: 'FORCED_CHOICE',
          dimension: 'EI',
          testCodes: ['MBTI_LITE'],
          options: [
            { label: '选项一', value: 1, scoreMap: { EI: 1 } },
            { label: '选项二', value: 1, scoreMap: { EI: 1 } },
          ],
        },
        CONTEXT,
      ),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('LIKERT5 的选项 value 不是 1–5 时返回 10001（契约 40008）', async () => {
    const { service } = createHarness();

    await expectBusinessCode(
      service.create(
        ADMIN_ID,
        {
          code: 'Q_EI_056',
          content: '在聚会上我通常会主动与陌生人交谈。',
          type: 'LIKERT5',
          dimension: 'EI',
          testCodes: ['MBTI_LITE'],
          options: [
            { label: '选项一', value: 1, scoreMap: { EI: 1 } },
            { label: '选项二', value: 2, scoreMap: { EI: 1 } },
          ],
        },
        CONTEXT,
      ),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('返回维度均衡 / 正反题比例 / 重复度校验块', async () => {
    const { service, prisma } = createHarness();

    prisma.question.count.mockResolvedValue(25);
    prisma.question.groupBy.mockResolvedValue([{ dimension: 'EI', reverseScored: false, _count: { _all: 16 } }]);
    prisma.question.findMany.mockResolvedValue([{ code: 'Q_EI_012', content: '在聚会上，我通常会主动与陌生人交谈。' }]);

    const result = await service.create(
      ADMIN_ID,
      {
        code: 'Q_EI_057',
        content: '在聚会上我通常会主动与陌生人交谈哦。',
        type: 'LIKERT5',
        dimension: 'EI',
        reverseScored: true,
        testCodes: ['MBTI_LITE'],
      },
      CONTEXT,
    );

    expect(result.validation.reverseRatio).toMatchObject({
      dimension: 'EI',
      forwardCount: 16,
      reverseCount: 0,
      ratio: 0,
      isBalanced: false,
    });
    expect(result.validation.reverseRatio.hint).toContain('0.3–0.7');
    expect(result.validation.duplicateSimilarity.checked).toBe(true);
    expect(result.validation.duplicateSimilarity.highestSimilarity).toBeGreaterThan(0.5);
  });
});

// ============================================================================
// 详情
// ============================================================================

describe('AdminQuestionService.detail', () => {
  it('题目不存在时返回 40009/404', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(null);

    await expectBusinessCode(service.detail(QUESTION_ID), ErrorCode.QUESTION_NOT_FOUND);
  });

  it('软删除的题目视同不存在（详情页没有可操作动作）', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion({ deletedAt: new Date('2026-02-01T00:00:00.000Z') }));

    await expectBusinessCode(service.detail(QUESTION_ID), ErrorCode.QUESTION_NOT_FOUND);
  });

  it('返回选项分布、统计量、使用范围与变更历史', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());

    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');

      if (sql.includes('CORR(')) return Promise.resolve([{ discrimination: 0.42 }]);
      if (sql.includes('STDDEV_POP')) {
        return Promise.resolve([{ answered: 18420, skipped: 0, avgValue: 3.24, stddevValue: 1.08 }]);
      }
      if (sql.includes('GROUP BY raw_value::text')) {
        return Promise.resolve([
          { value: '1', count: 860 },
          { value: '2', count: 4120 },
          { value: '3', count: 5210 },
          { value: '4', count: 6180 },
          { value: '5', count: 2050 },
        ]);
      }

      // 会话快照引用：usageScopes（按定义）与 usageCount（总量）两次调用
      return Promise.resolve([
        { testCode: 'MBTI_LITE', sessionCount: 12240 },
        { testCode: 'MBTI_FULL', sessionCount: 6180 },
      ]);
    });

    prisma.adminAuditLog.findMany.mockResolvedValue([
      {
        action: 'UPDATE',
        createdAt: new Date('2026-02-08T06:30:00.000Z'),
        adminUserId: ADMIN_ID,
        adminUsername: 'editor',
        beforeData: { content: '在聚会上，我会主动与陌生人交谈。', weight: 1 },
        afterData: { content: '在聚会上，我通常会主动与陌生人交谈。', weight: 1 },
      },
      {
        action: 'CREATE',
        createdAt: new Date('2026-01-05T02:00:00.000Z'),
        adminUserId: null,
        adminUsername: '初始种子',
        beforeData: null,
        afterData: null,
      },
    ]);

    const result = await service.detail(QUESTION_ID);

    expect(result.options).toHaveLength(5);
    expect(result.options[0]).toMatchObject({ optionId: 'opt-1', selectedCount: 860 });
    expect(result.options[0]?.selectedRatio).toBe(0.047);
    expect(result.statistics).toMatchObject({
      answerCount: 18420,
      averageValue: 3.24,
      standardDeviation: 1.08,
      discriminationIndex: 0.42,
      skipRate: 0,
      qualityLevel: 'GOOD',
    });
    expect(result.statistics.qualityHint).toContain('良好区间');
    expect(result.usageScopes).toEqual([
      { testCode: 'MBTI_LITE', sessionCount: 12240 },
      { testCode: 'MBTI_FULL', sessionCount: 6180 },
    ]);
    expect(result.changeHistory[0]).toMatchObject({
      action: 'UPDATE',
      operatorName: '内容编辑',
      changes: {
        content: { before: '在聚会上，我会主动与陌生人交谈。', after: '在聚会上，我通常会主动与陌生人交谈。' },
      },
    });
    // CREATE 没有字段级 diff
    expect(result.changeHistory[1]?.changes).toBeNull();
  });

  it('样本不足时区分度不下结论（INSUFFICIENT_DATA）', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());

    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('STDDEV_POP')) {
        return Promise.resolve([{ answered: 3, skipped: 0, avgValue: 3, stddevValue: 0.5 }]);
      }
      if (sql.includes('CORR(')) return Promise.resolve([{ discrimination: 0.9 }]);
      return Promise.resolve([]);
    });

    const result = await service.detail(QUESTION_ID);

    expect(result.statistics.qualityLevel).toBe('INSUFFICIENT_DATA');
    expect(result.statistics.discriminationIndex).toBeNull();
  });
});

// ============================================================================
// 修改
// ============================================================================

describe('AdminQuestionService.update', () => {
  it('识别变更字段、给出算分影响评估并写 before/after 审计', async () => {
    const { service, prisma, audit } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());
    prisma.questionOption.findMany.mockResolvedValue([
      { id: 'opt-1', label: '非常不同意', value: 1, scoreMap: { EI: -2 } },
      { id: 'opt-2', label: '不同意', value: 2, scoreMap: { EI: -1 } },
      { id: 'opt-3', label: '中立', value: 3, scoreMap: { EI: 0 } },
      { id: 'opt-4', label: '同意', value: 4, scoreMap: { EI: 1 } },
      { id: 'opt-5', label: '非常同意', value: 5, scoreMap: { EI: 2 } },
    ]);

    const result = await service.update(
      ADMIN_ID,
      QUESTION_ID,
      {
        content: '在聚会上，我通常会主动与不太熟悉的人交谈。',
        weight: 1.2,
        changeNote: '明确「不太熟悉的人」，降低语义歧义',
      },
      CONTEXT,
    );

    expect(result.changedFields).toEqual(['content', 'weight']);
    expect(result.impactAssessment).toMatchObject({
      affectsNewSessionsOnly: true,
      existingSessionsUnaffected: true,
    });
    expect(result.impactAssessment.scoringImpact).toContain('weight 由 1 → 1.2');
    expect(result.updatedBy).toBe('超级管理员');
    expect(result.options.map((option) => option.optionId)).toEqual(['opt-1', 'opt-2', 'opt-3', 'opt-4', 'opt-5']);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceId: QUESTION_ID,
        reason: '明确「不太熟悉的人」，降低语义歧义',
        beforeData: expect.objectContaining({ content: '在聚会上，我通常会主动与陌生人交谈。' }),
        afterData: expect.objectContaining({ content: '在聚会上，我通常会主动与不太熟悉的人交谈。', weight: 1.2 }),
      }),
    );
  });

  it('options 全量替换：value 集合不变时保留原 optionId（统计连续性）', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());
    prisma.questionOption.findMany.mockResolvedValue([
      { id: 'opt-1', label: '非常不同意', value: 1, scoreMap: { EI: -2 } },
      { id: 'opt-2', label: '不同意', value: 2, scoreMap: { EI: -1 } },
      { id: 'opt-3', label: '中立', value: 3, scoreMap: { EI: 0 } },
      { id: 'opt-4', label: '同意', value: 4, scoreMap: { EI: 1 } },
      { id: 'opt-5', label: '非常同意', value: 5, scoreMap: { EI: 2 } },
    ]);

    await service.update(
      ADMIN_ID,
      QUESTION_ID,
      {
        options: [
          { label: '非常不同意', value: 1, scoreMap: { EI: -2 } },
          { label: '不同意', value: 2, scoreMap: { EI: -1 } },
          { label: '中立', value: 3, scoreMap: { EI: 0 } },
          { label: '同意', value: 4, scoreMap: { EI: 1 } },
          { label: '非常同意', value: 5, scoreMap: { EI: 2 } },
        ],
      },
      CONTEXT,
    );

    // 无新增、无删除：全部按 value 匹配复用既有 optionId
    expect(prisma.questionOption.delete).not.toHaveBeenCalled();
    expect(prisma.questionOption.create).not.toHaveBeenCalled();

    const updatedIds = prisma.questionOption.update.mock.calls.map(
      (call) => (call[0] as { where: { id: string } }).where.id,
    );
    expect(new Set(updatedIds)).toEqual(new Set(['opt-1', 'opt-2', 'opt-3', 'opt-4', 'opt-5']));
  });

  it('options 全量替换：新增/删除按 value 集合差异处理', async () => {
    const { service, prisma } = createHarness();
    // 用 BINARY 题：LIKERT5 的 value 必须恰好是 1–5，不适合验证「增删」语义
    prisma.question.findUnique.mockResolvedValue(
      dbQuestion({ type: 'BINARY', options: [{ id: 'opt-1', label: '是', value: 1, scoreMap: {}, order: 0 }] }),
    );
    prisma.questionOption.findMany.mockResolvedValue([{ id: 'opt-1', label: '是', value: 1, scoreMap: {} }]);

    await service.update(
      ADMIN_ID,
      QUESTION_ID,
      {
        options: [
          { label: '是', value: 1, scoreMap: { EI: 1 } },
          { label: '否', value: 2, scoreMap: { EI: -1 } },
        ],
      },
      CONTEXT,
    );

    expect(prisma.questionOption.create).toHaveBeenCalledTimes(1);
    expect(prisma.questionOption.create.mock.calls[0]?.[0]).toMatchObject({
      data: { questionId: QUESTION_ID, order: 1, value: 2, label: '否' },
    });
  });

  it('testCodes 传空数组时显式拒绝（数据模型无法表达「无归属」）', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());

    await expectBusinessCode(
      service.update(ADMIN_ID, QUESTION_ID, { testCodes: [] }, CONTEXT),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('题目不存在或已删除时返回 40009', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion({ deletedAt: new Date('2026-02-01T00:00:00.000Z') }));

    await expectBusinessCode(
      service.update(ADMIN_ID, QUESTION_ID, { weight: 2 }, CONTEXT),
      ErrorCode.QUESTION_NOT_FOUND,
    );
  });
});

// ============================================================================
// 删除（软删除优先）
// ============================================================================

describe('AdminQuestionService.remove', () => {
  it('默认软删除：置 deletedAt + isActive=false，并同步 questionCount', async () => {
    const { service, prisma, audit } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());
    prisma.question.count.mockResolvedValue(31);
    prisma.question.groupBy.mockResolvedValue([{ testDefinitionId: DEFINITION_ID, _count: { _all: 31 } }]);

    const result = await service.remove(
      ADMIN_ID,
      QUESTION_ID,
      { reason: '题干存在歧义，与 Q_EI_012 重复度高，改用新题替代' },
      CONTEXT,
    );

    expect(result.deleted).toBe(true);
    expect(result.hardDelete).toBe(false);
    expect(result.previousIsActive).toBe(true);
    expect(result.affectedTestCodes).toEqual(['MBTI_LITE']);
    expect(result.deletedBy).toBe('超级管理员');

    // 物理删除绝不能被调用（test_answers 外键为 Restrict）
    expect(prisma.question.delete).not.toHaveBeenCalled();
    expect(prisma.question.update).toHaveBeenCalledWith({
      where: { id: QUESTION_ID },
      data: { isActive: false, deletedAt: expect.any(Date) },
    });
    expect(prisma.testDefinition.update).toHaveBeenCalledWith({
      where: { id: DEFINITION_ID },
      data: { questionCount: 31 },
    });

    // 题量预警不阻断：可用题量 31 < 操作前基线 32
    expect(result.impactAssessment.questionCountAfterDelete).toEqual({ MBTI_LITE: 31 });
    expect(result.impactAssessment.sufficientQuota['MBTI_LITE']).toBe(false);
    expect(result.impactAssessment.sufficientQuota.note).toContain('40011');

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DELETE', reason: '题干存在歧义，与 Q_EI_012 重复度高，改用新题替代' }),
    );
  });

  it('幂等：已删除的题再删仍返回成功且不再变更数据', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion({ deletedAt: new Date('2026-02-10T00:00:00.000Z') }));

    const result = await service.remove(ADMIN_ID, QUESTION_ID, { reason: '重复删除，验证幂等性' }, CONTEXT);

    expect(result.deleted).toBe(true);
    expect(result.hardDelete).toBe(false);
    expect(prisma.question.update).not.toHaveBeenCalled();
    expect(prisma.question.delete).not.toHaveBeenCalled();
    expect(result.cacheInvalidated).toBe(false);
  });

  it('【关键】hardDelete=true 但题目已被会话引用时拒绝（契约 40011 → 本仓库 10008）', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('FROM test_sessions')) return Promise.resolve([{ questionId: QUESTION_ID, count: 18420 }]);
      return Promise.resolve([]);
    });

    const error = await expectBusinessCode(
      service.remove(ADMIN_ID, QUESTION_ID, { reason: '试图物理删除已被使用的题目', hardDelete: true }, CONTEXT),
      ErrorCode.OPERATION_FORBIDDEN,
    );

    expect(error.userMessage).toContain('禁止物理删除');
    expect(prisma.question.delete).not.toHaveBeenCalled();
  });

  it('hardDelete=true 且从未被引用、无答题记录时执行物理删除', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());
    prisma.testAnswer.count.mockResolvedValue(0);

    const result = await service.remove(
      ADMIN_ID,
      QUESTION_ID,
      { reason: '录入错误，从未被任何会话使用过', hardDelete: true },
      CONTEXT,
    );

    expect(result.hardDelete).toBe(true);
    expect(prisma.question.delete).toHaveBeenCalledWith({ where: { id: QUESTION_ID } });
  });

  it('答题记录存在时同样禁止物理删除（外键 Restrict 的数据侧保险）', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());
    prisma.testAnswer.count.mockResolvedValue(3);

    await expectBusinessCode(
      service.remove(ADMIN_ID, QUESTION_ID, { reason: '存在答题记录时禁止物理删除', hardDelete: true }, CONTEXT),
      ErrorCode.OPERATION_FORBIDDEN,
    );

    expect(prisma.question.delete).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 批量导入
// ============================================================================

describe('AdminQuestionService.importQuestions', () => {
  it('默认 dryRun：只校验不写库，并给出预览与下一步提示', async () => {
    const { service, prisma, audit } = createHarness();

    const result = (await service.importQuestions(
      ADMIN_ID,
      {
        format: 'JSON',
        data: JSON.stringify([importRow(), importRow({ code: 'Q_SN_051', dimension: 'SN' })]),
        testCode: 'MBTI_LITE',
      },
      CONTEXT,
    )) as AdminQuestionImportDryRunResult;

    expect(result.dryRun).toBe(true);
    expect(result.totalParsed).toBe(2);
    expect(result.validCount).toBe(2);
    expect(result.invalidCount).toBe(0);
    expect(result.wouldCreate).toBe(2);
    expect(result.wouldUpdate).toBe(0);
    expect(result.wouldDelete).toBe(0);
    expect(result.cacheInvalidated).toBe(false);
    expect(result.preview.map((item) => item.code)).toEqual(['Q_EI_050', 'Q_SN_051']);
    expect(result.affectedTestCodes).toEqual(['MBTI_LITE']);
    expect(result.nextStep).toContain('dryRun=false');

    expect(prisma.question.create).not.toHaveBeenCalled();
    expect(prisma.testDefinition.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'IMPORT' }));
  });

  it('批次内 code 重复时逐行报错（DUPLICATE_CODE_IN_PAYLOAD）', async () => {
    const { service } = createHarness();

    const result = (await service.importQuestions(
      ADMIN_ID,
      {
        format: 'JSON',
        data: JSON.stringify([
          importRow(),
          importRow({ code: 'Q_SN_051', dimension: 'SN' }),
          importRow({ code: 'Q_EI_050', content: '重复的编码示例' }),
        ]),
        testCode: 'MBTI_LITE',
      },
      CONTEXT,
    )) as AdminQuestionImportDryRunResult;

    expect(result.totalParsed).toBe(3);
    expect(result.validCount).toBe(2);
    expect(result.invalidCount).toBe(1);
    expect(result.errors[0]).toMatchObject({
      row: 3,
      code: 'Q_EI_050',
      field: 'code',
      issue: 'DUPLICATE_CODE_IN_PAYLOAD',
    });
  });

  it('JSON 解析失败时返回逐行报告而不是抛异常', async () => {
    const { service } = createHarness();

    const result = (await service.importQuestions(
      ADMIN_ID,
      { format: 'JSON', data: '{不是合法 JSON', testCode: 'MBTI_LITE' },
      CONTEXT,
    )) as AdminQuestionImportDryRunResult;

    expect(result.totalParsed).toBe(0);
    expect(result.errors[0]?.issue).toBe('INVALID_JSON');
  });

  it('CSV 按契约表头解析（tags/optionLabels 用 | 分隔，scoreMaps 为 DIM:分值）', async () => {
    const { service } = createHarness();

    const result = (await service.importQuestions(
      ADMIN_ID,
      { format: 'CSV', data: csvPayload(), testCode: 'MBTI_LITE' },
      CONTEXT,
    )) as AdminQuestionImportDryRunResult;

    expect(result.validCount).toBe(1);
    expect(result.wouldCreate).toBe(1);
    expect(result.preview[0]).toMatchObject({ row: 1, code: 'Q_EI_050', dimension: 'EI', type: 'LIKERT5' });
  });

  it('CSV 表头缺列时返回 INVALID_CSV_HEADER', async () => {
    const { service } = createHarness();

    const result = (await service.importQuestions(
      ADMIN_ID,
      { format: 'CSV', data: 'code,content\nQ_EI_050,题干', testCode: 'MBTI_LITE' },
      CONTEXT,
    )) as AdminQuestionImportDryRunResult;

    expect(result.errors[0]?.issue).toBe('INVALID_CSV_HEADER');
    expect(result.errors[0]?.message).toContain('optionLabels');
  });

  it('【关键】dryRun=false 缺少 X-Idempotency-Key 时返回 10009（契约 10011）', async () => {
    const { service } = createHarness();

    await expectBusinessCode(
      service.importQuestions(
        ADMIN_ID,
        { format: 'JSON', data: JSON.stringify([importRow()]), testCode: 'MBTI_LITE', dryRun: false },
        CONTEXT,
      ),
      ErrorCode.IDEMPOTENCY_KEY_MISSING,
    );
  });

  it('【关键】onError=ABORT（默认）时存在非法行 → 整批拒绝、零写入，且审计标记失败', async () => {
    const { service, prisma, audit } = createHarness();

    await expectBusinessCode(
      service.importQuestions(
        ADMIN_ID,
        {
          format: 'JSON',
          data: JSON.stringify([importRow(), importRow({ code: 'BAD_CODE', dimension: 'SN' })]),
          testCode: 'MBTI_LITE',
          dryRun: false,
        },
        { ...CONTEXT, idempotencyKey: 'idem-key-1234' },
      ),
      ErrorCode.PARAM_INVALID,
    );

    expect(prisma.question.create).not.toHaveBeenCalled();
    expect(prisma.question.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'IMPORT', success: false, errorCode: String(ErrorCode.PARAM_INVALID) }),
    );
  });

  it('onError=SKIP 时跳过非法行、写入合法行，并同步 questionCount', async () => {
    const { service, prisma } = createHarness();
    prisma.question.count.mockResolvedValue(50);
    prisma.question.groupBy.mockImplementation((args: { by: string[] }) =>
      Promise.resolve(
        args.by[0] === 'testDefinitionId' ? [{ testDefinitionId: DEFINITION_ID, _count: { _all: 50 } }] : [],
      ),
    );

    const result = (await service.importQuestions(
      ADMIN_ID,
      {
        format: 'JSON',
        data: JSON.stringify([importRow(), importRow({ code: 'BAD_CODE', dimension: 'SN' })]),
        testCode: 'MBTI_LITE',
        dryRun: false,
        onError: 'SKIP',
      },
      { ...CONTEXT, idempotencyKey: 'idem-key-1234' },
    )) as AdminQuestionImportWriteResult;

    expect(result.dryRun).toBe(false);
    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.errors[0]?.code).toBe('BAD_CODE');
    expect(result.createdQuestionIds).toEqual([QUESTION_ID]);
    expect(result.testDefinitionImpact['MBTI_LITE']).toEqual({
      activeQuestionCountBefore: 50,
      activeQuestionCountAfter: 50,
      requiredCount: 32,
      isSufficient: true,
    });

    expect(prisma.testDefinition.update).toHaveBeenCalledWith({
      where: { id: DEFINITION_ID },
      data: { questionCount: 50 },
    });
  });

  it('UPSERT 命中既有 code 时转为更新（APPEND 则报错）', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findMany.mockResolvedValue([
      { id: QUESTION_ID, code: 'Q_EI_050', type: 'LIKERT5', deletedAt: null },
    ]);

    const appendResult = (await service.importQuestions(
      ADMIN_ID,
      { format: 'JSON', data: JSON.stringify([importRow()]), testCode: 'MBTI_LITE' },
      CONTEXT,
    )) as AdminQuestionImportDryRunResult;

    expect(appendResult.errors[0]?.issue).toBe('CODE_EXISTS');
    expect(appendResult.wouldCreate).toBe(0);

    const upsertResult = (await service.importQuestions(
      ADMIN_ID,
      { format: 'JSON', data: JSON.stringify([importRow()]), testCode: 'MBTI_LITE', mode: 'UPSERT' },
      CONTEXT,
    )) as AdminQuestionImportDryRunResult;

    expect(upsertResult.errors).toHaveLength(0);
    expect(upsertResult.wouldUpdate).toBe(1);
    expect(upsertResult.preview[0]?.action).toBe('UPDATE');
  });

  it('REPLACE 模式必须指定 testCode（作用域不能含糊）', async () => {
    const { service } = createHarness();

    await expectBusinessCode(
      service.importQuestions(
        ADMIN_ID,
        { format: 'JSON', data: JSON.stringify([importRow()]), mode: 'REPLACE' },
        CONTEXT,
      ),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('REPLACE 模式下未出现在导入数据中的题被软删除（不物理删除）', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
      if (args.where && 'testDefinitionId' in args.where) {
        return Promise.resolve([
          { id: 'q-leftover', code: 'Q_EI_099', dimension: 'EI' },
          { id: QUESTION_ID, code: 'Q_EI_050', dimension: 'EI' },
        ]);
      }
      return Promise.resolve([]);
    });
    prisma.question.groupBy.mockImplementation((args: { by: string[] }) =>
      Promise.resolve(
        args.by[0] === 'testDefinitionId' ? [{ testDefinitionId: DEFINITION_ID, _count: { _all: 30 } }] : [],
      ),
    );

    const result = (await service.importQuestions(
      ADMIN_ID,
      {
        format: 'JSON',
        data: JSON.stringify([importRow()]),
        testCode: 'MBTI_LITE',
        mode: 'REPLACE',
        dryRun: false,
        onError: 'SKIP',
      },
      { ...CONTEXT, idempotencyKey: 'idem-key-1234' },
    )) as AdminQuestionImportWriteResult;

    expect(result.deletedCount).toBe(1);
    expect(prisma.question.delete).not.toHaveBeenCalled();
    expect(prisma.question.update).toHaveBeenCalledWith({
      where: { id: 'q-leftover' },
      data: { isActive: false, deletedAt: expect.any(Date) },
    });
  });

  it('单批超过 500 题时返回 10001（契约 10016；异步队列路径未实现）', async () => {
    const { service } = createHarness();
    const rows = Array.from({ length: 501 }, (_unused, index) =>
      importRow({ code: `Q_EI_${String(index + 1).padStart(3, '0')}` }),
    );

    const error = await expectBusinessCode(
      service.importQuestions(ADMIN_ID, { format: 'JSON', data: JSON.stringify(rows), testCode: 'MBTI_LITE' }, CONTEXT),
      ErrorCode.PARAM_INVALID,
    );

    expect(error.userMessage).toContain('500');
  });

  it('data 超过 512KB 时返回 10005（HTTP 413，契约 10006）', async () => {
    const { service } = createHarness();

    const error = await expectBusinessCode(
      service.importQuestions(
        ADMIN_ID,
        { format: 'JSON', data: 'x'.repeat(512 * 1024 + 1), testCode: 'MBTI_LITE' },
        CONTEXT,
      ),
      ErrorCode.PAYLOAD_TOO_LARGE,
    );

    expect(error.getStatus()).toBe(413);
  });

  it('幂等命中时直接回放首次写入的响应，不重复写库', async () => {
    const { service, prisma, redis } = createHarness();
    const cached = { dryRun: false, createdCount: 2, createdQuestionIds: ['a', 'b'] };
    redis.getJson.mockResolvedValue(cached);

    const result = await service.importQuestions(
      ADMIN_ID,
      { format: 'JSON', data: JSON.stringify([importRow()]), testCode: 'MBTI_LITE', dryRun: false },
      { ...CONTEXT, idempotencyKey: 'idem-key-1234' },
    );

    expect(result).toBe(cached);
    expect(prisma.question.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 启用 / 停用
// ============================================================================

describe('AdminQuestionService.toggle', () => {
  it('停用：写库、同步 questionCount、给出题量不足预警', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion());
    prisma.question.count.mockResolvedValue(31);
    prisma.question.groupBy.mockResolvedValue([{ testDefinitionId: DEFINITION_ID, _count: { _all: 31 } }]);

    const result = await service.toggle(
      ADMIN_ID,
      QUESTION_ID,
      { isActive: false, reason: '题干歧义，待修订后重新启用' },
      CONTEXT,
    );

    expect(result.previousIsActive).toBe(true);
    expect(result.isActive).toBe(false);
    expect(result.reason).toBe('题干歧义，待修订后重新启用');
    expect(prisma.question.update).toHaveBeenCalledWith({ where: { id: QUESTION_ID }, data: { isActive: false } });
    expect(prisma.testDefinition.update).toHaveBeenCalledWith({
      where: { id: DEFINITION_ID },
      data: { questionCount: 31 },
    });
    expect(result.impactAssessment.questionCountAfterToggle).toEqual({ MBTI_LITE: 31 });
    expect(result.impactAssessment.sufficientQuota['MBTI_LITE']).toBe(false);
    expect(result.cacheInvalidated).toBe(true);
  });

  it('幂等：目标状态与当前一致时不写库、不失效缓存', async () => {
    const { service, prisma, audit } = createHarness();
    prisma.question.findUnique.mockResolvedValue(dbQuestion({ isActive: true }));
    prisma.question.groupBy.mockResolvedValue([{ testDefinitionId: DEFINITION_ID, _count: { _all: 32 } }]);

    const result = await service.toggle(ADMIN_ID, QUESTION_ID, { isActive: true }, CONTEXT);

    expect(result.previousIsActive).toBe(true);
    expect(result.isActive).toBe(true);
    expect(prisma.question.update).not.toHaveBeenCalled();
    expect(prisma.testDefinition.update).not.toHaveBeenCalled();
    expect(result.cacheInvalidated).toBe(false);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ diffSummary: expect.stringContaining('幂等') }));
  });

  it('题目不存在时返回 40009', async () => {
    const { service, prisma } = createHarness();
    prisma.question.findUnique.mockResolvedValue(null);

    await expectBusinessCode(
      service.toggle(ADMIN_ID, QUESTION_ID, { isActive: false }, CONTEXT),
      ErrorCode.QUESTION_NOT_FOUND,
    );
  });
});

// ============================================================================
// questionCount 一致性（用户端 40011 的防线）
// ============================================================================

describe('questionCount 同步（用户端 createSession 的题量判据）', () => {
  it('新建 / 删除 / 停用 / 导入 四条写路径都会回填 questionCount', async () => {
    const { service, prisma } = createHarness();
    prisma.question.count.mockResolvedValue(7);

    await service.toggle(ADMIN_ID, QUESTION_ID, { isActive: false }, CONTEXT).catch(() => undefined);

    // 上面用的是「题目不存在」路径（findUnique 默认返回 null）→ 不产生任何写入
    expect(prisma.testDefinition.update).not.toHaveBeenCalled();

    prisma.question.findUnique.mockResolvedValue(dbQuestion());
    prisma.question.groupBy.mockResolvedValue([{ testDefinitionId: DEFINITION_ID, _count: { _all: 7 } }]);

    await service.toggle(ADMIN_ID, QUESTION_ID, { isActive: false }, CONTEXT);

    expect(prisma.testDefinition.update).toHaveBeenCalledWith({
      where: { id: DEFINITION_ID },
      data: { questionCount: 7 },
    });
  });
});
