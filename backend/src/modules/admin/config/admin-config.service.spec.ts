/**
 * AdminConfigService 单测
 *
 * 配置写接口的风险集中在「校验放过不该放过的东西」与「写成功但前台读不到」两点上，
 * 因此测试围绕三条线：
 *   1. 拒绝路径：不存在的键、环境变量锁定键、只读键、类型/区间非法值（必须在事务外拒绝）；
 *   2. 成功路径：单事务写入、缓存失效、审计 before/after 完整、configVersion 更新；
 *   3. 试运行：不写库、不失效缓存。
 */

import { ConfigValueType } from '@prisma/client';

import type { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { ResolvedConfigEntry, ConfigSnapshot } from '../../system/system-config.service';
import { AdminConfigService, type AdminConfigActor } from './admin-config.service';

/**
 * 捕获业务异常
 *
 * 用「捕获后断言 code 与 HTTP 状态」而不是 `rejects.toMatchObject({ status })`：
 * `HttpException` 的 `status` 是 TS 私有字段，靠它断言会在升级框架时静默失效，
 * 而 `getStatus()` 是公开 API。
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<BusinessException> => {
  try {
    await promise;
  } catch (error) {
    return error as BusinessException;
  }

  throw new Error('期望抛出 BusinessException，但调用成功返回了');
};

const entry = (key: string, value: unknown, extra: Partial<ResolvedConfigEntry> = {}): ResolvedConfigEntry => ({
  key,
  group: 'LIMIT',
  groupName: '限额与限流',
  label: key,
  valueType: ConfigValueType.STRING,
  value,
  rawValue: String(value),
  description: `${key} 的说明`,
  isEditable: true,
  requiresConfirmPassword: false,
  envOverride: null,
  impactScope: 'GLOBAL',
  isPublic: true,
  min: null,
  max: null,
  updatedAt: null,
  updatedByAdminId: null,
  isKnown: true,
  ...extra,
});

const actor: AdminConfigActor = {
  adminUserId: '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a',
  ip: '203.0.113.42',
  userAgent: 'jest',
  requestId: 'req_test',
};

interface Harness {
  service: AdminConfigService;
  prisma: {
    adminUser: { findFirst: jest.Mock; findMany: jest.Mock };
    adminAuditLog: { findMany: jest.Mock };
    systemConfig: { upsert: jest.Mock };
    $transaction: jest.Mock;
  };
  systemConfigs: { getSnapshot: jest.Mock; invalidate: jest.Mock };
  audit: { log: jest.Mock; buildDiffSummary: jest.Mock };
}

const createHarness = (): Harness => {
  const tx = { systemConfig: { upsert: jest.fn().mockResolvedValue({}) } };

  const prisma = {
    adminUser: {
      findFirst: jest.fn().mockResolvedValue({ username: 'admin@soulmap.cn', nickname: '超级管理员' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    adminAuditLog: { findMany: jest.fn().mockResolvedValue([]) },
    systemConfig: tx.systemConfig,
    // $transaction 回调式用法：把事务客户端交给回调，测试里只看调用参数
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>): Promise<void> => callback(tx)),
  };

  const systemConfigs = {
    getSnapshot: jest.fn(),
    invalidate: jest.fn().mockResolvedValue(['sm:system:config']),
  };

  const audit = {
    log: jest.fn().mockResolvedValue(true),
    buildDiffSummary: jest.fn().mockReturnValue('reportFreePreviewRatio: 0.2 → 0.25'),
  };

  const service = new AdminConfigService(prisma as never, systemConfigs as never, audit as never);

  return { service, prisma, systemConfigs, audit };
};

const snapshotOf = (version: string, entries: ResolvedConfigEntry[]): ConfigSnapshot => ({
  version,
  generatedAt: '2026-02-14T18:00:00.000Z',
  entries,
});

describe('AdminConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('list', () => {
    it('按分组返回配置项并给出可编辑/环境锁定统计', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-20260214-aaaa1111', [
          entry('FEATURE_PAYMENT', true, {
            group: 'FEATURE_FLAG',
            groupName: '功能开关',
            valueType: ConfigValueType.BOOLEAN,
            isEditable: false,
            envOverride: 'FEATURE_PAYMENT',
            requiresConfirmPassword: true,
          }),
          entry('reportFreePreviewRatio', 0.2, {
            valueType: ConfigValueType.NUMBER,
            min: 0,
            max: 1,
            requiresConfirmPassword: true,
          }),
        ]),
      );

      const result = await harness.service.list({});

      expect(result.configVersion).toBe('sv-20260214-aaaa1111');
      expect(result.totalItems).toBe(2);
      expect(result.editableItems).toBe(1);
      expect(result.envLockedItems).toBe(1);
      expect(result.envLockedNote).toContain('环境变量');

      const groups = result.groups as Array<{ group: string; items: Array<Record<string, unknown>> }>;
      expect(groups.map((group) => group.group)).toEqual(['FEATURE_FLAG', 'LIMIT']);

      const ratioItem = groups[1].items[0];
      expect(ratioItem.min).toBe(0);
      expect(ratioItem.max).toBe(1);
      // 文案类配置不下发 min/max，避免前端对字符串渲染滑块
      expect(groups[0].items[0].min).toBeUndefined();
    });

    it('group 支持逗号分隔，ALL 表示不过滤', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-1', [
          entry('FEATURE_PAYMENT', true, { group: 'FEATURE_FLAG' }),
          entry('reportFreePreviewRatio', 0.2, { group: 'LIMIT' }),
        ]),
      );

      const onlyLimit = await harness.service.list({ group: 'LIMIT' });
      const all = await harness.service.list({ group: 'ALL' });

      expect((onlyLimit.groups as Array<{ group: string }>).map((group) => group.group)).toEqual(['LIMIT']);
      expect(all.totalItems).toBe(2);
    });

    it('group 非法值直接 400，而不是静默忽略（否则调用方以为查了全部）', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(snapshotOf('sv-1', []));

      await expect(harness.service.list({ group: 'NOT_A_GROUP' })).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('keys 超过 50 个报 400（契约 §3.14.9.1 的 10016 语义）', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(snapshotOf('sv-1', []));
      const keys = Array.from({ length: 51 }, (_value, index) => `k${index}`).join(',');

      await expect(harness.service.list({ keys })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
    });

    it('更新人展示名批量解析：命中取昵称，账号已删为「未知管理员」，从未改过为「系统」', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-1', [
          entry('a', 1, { updatedByAdminId: 'admin-1' }),
          entry('b', 2, { updatedByAdminId: 'admin-2' }),
          entry('c', 3),
        ]),
      );
      harness.prisma.adminUser.findMany.mockResolvedValue([
        { id: 'admin-1', username: 'admin@soulmap.cn', nickname: '超级管理员' },
      ]);

      const result = await harness.service.list({});
      const items = (result.groups as Array<{ items: Array<Record<string, unknown>> }>)[0].items;

      // 三种情况必须可区分：改过且账号在（昵称）、改过但账号已删（未知管理员）、
      // 从未被后台改过（沿用兜底值，展示为「系统」）
      expect(items.map((item) => item.updatedBy)).toEqual(['超级管理员', '未知管理员', '系统']);
    });

    it('includeHistory 从审计还原最近 5 次变更（与审计同源，不另建历史表）', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(snapshotOf('sv-1', [entry('reportFreePreviewRatio', 0.2)]));
      harness.prisma.adminAuditLog.findMany.mockResolvedValue([
        {
          adminUsername: 'admin@soulmap.cn',
          createdAt: new Date('2026-02-14T22:00:00.000Z'),
          beforeData: { items: [{ key: 'reportFreePreviewRatio', value: 0.15 }] },
          afterData: { items: [{ key: 'reportFreePreviewRatio', value: 0.2, changeNote: '提升体验完整度' }] },
        },
        {
          adminUsername: 'admin@soulmap.cn',
          createdAt: new Date('2026-02-10T10:00:00.000Z'),
          beforeData: { items: [{ key: 'reportFreePreviewRatio', value: 0.1 }] },
          afterData: { items: [{ key: 'reportFreePreviewRatio', value: 0.15, changeNote: null }] },
        },
      ]);

      const result = await harness.service.list({ includeHistory: true });
      const item = (result.groups as Array<{ items: Array<Record<string, unknown>> }>)[0].items[0];
      const history = item.history as Array<Record<string, unknown>>;

      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({
        at: '2026-02-14T22:00:00.000Z',
        by: 'admin@soulmap.cn',
        before: 0.15,
        after: 0.2,
        changeNote: '提升体验完整度',
      });
    });

    it('不传 includeHistory 时不查审计表（列表接口不应附带额外查询）', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(snapshotOf('sv-1', []));

      await harness.service.list({});

      expect(harness.prisma.adminAuditLog.findMany).not.toHaveBeenCalled();
    });
  });

  describe('update 拒绝路径', () => {
    it('key 不存在 → 404（90008 语义：配置缺失）', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(snapshotOf('sv-1', []));

      const error = await rejectionOf(harness.service.update({ items: [{ key: 'nope', value: 1 }] }, actor));

      expect(error.code).toBe(ErrorCode.CONFIG_MISSING);
      expect(error.getStatus()).toBe(404);
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('环境变量锁定项 → 403 并提示走部署流程', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-1', [
          entry('FEATURE_PAYMENT', true, { envOverride: 'FEATURE_PAYMENT', isEditable: false, group: 'FEATURE_FLAG' }),
        ]),
      );

      const error = await rejectionOf(
        harness.service.update({ items: [{ key: 'FEATURE_PAYMENT', value: false }] }, actor),
      );

      expect(error.code).toBe(ErrorCode.OPERATION_FORBIDDEN);
      expect(error.getStatus()).toBe(403);
      expect(error.userMessage).toContain('FEATURE_PAYMENT');
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('只读键（目录外）→ 403', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-1', [entry('legacy.internalSwitch', 'on', { isEditable: false, isKnown: false })]),
      );

      await expect(
        harness.service.update({ items: [{ key: 'legacy.internalSwitch', value: 'off' }] }, actor),
      ).rejects.toMatchObject({ code: ErrorCode.OPERATION_FORBIDDEN });
    });

    it('值类型不符 → 400 且带字段级明细', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-1', [
          entry('FEATURE_VOICE_INPUT', false, { group: 'FEATURE_FLAG', valueType: ConfigValueType.BOOLEAN }),
        ]),
      );

      const error = await rejectionOf(
        harness.service.update({ items: [{ key: 'FEATURE_VOICE_INPUT', value: 'true' }] }, actor),
      );

      expect(error.code).toBe(ErrorCode.PARAM_INVALID);
      expect(error.getStatus()).toBe(400);
      expect(error.details?.[0]?.field).toBe('FEATURE_VOICE_INPUT');
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('值超出 min/max → 400', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-1', [
          entry('reportFreePreviewRatio', 0.2, { valueType: ConfigValueType.NUMBER, min: 0, max: 1 }),
        ]),
      );

      await expect(
        harness.service.update({ items: [{ key: 'reportFreePreviewRatio', value: 1.5 }] }, actor),
      ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
    });
  });

  describe('update 成功路径', () => {
    it('单事务 upsert + 失效缓存 + 写审计 + 返回新旧版本号', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot
        .mockResolvedValueOnce(
          snapshotOf('sv-20260214-aaaa1111', [
            entry('reportFreePreviewRatio', 0.2, { valueType: ConfigValueType.NUMBER, min: 0, max: 1 }),
          ]),
        )
        .mockResolvedValueOnce(
          snapshotOf('sv-20260214-bbbb2222', [
            entry('reportFreePreviewRatio', 0.25, { valueType: ConfigValueType.NUMBER, min: 0, max: 1 }),
          ]),
        );

      const result = await harness.service.update(
        {
          items: [{ key: 'reportFreePreviewRatio', value: 0.25, changeNote: '提升到 25%' }],
        },
        actor,
      );

      // 写库值是归一化后的字符串，而不是原始 number
      expect(harness.prisma.systemConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'reportFreePreviewRatio' },
          update: expect.objectContaining({ value: '0.25', deletedAt: null, version: { increment: 1 } }),
        }),
      );

      expect(harness.systemConfigs.invalidate).toHaveBeenCalledTimes(1);
      expect(result.updatedCount).toBe(1);
      expect(result.previousConfigVersion).toBe('sv-20260214-aaaa1111');
      expect(result.configVersion).toBe('sv-20260214-bbbb2222');

      const items = result.items as Array<Record<string, unknown>>;
      expect(items[0].before).toBe(0.2);
      expect(items[0].after).toBe(0.25);
      expect(items[0].changeNote).toBe('提升到 25%');
      expect(items[0].validation).toEqual({ isValid: true, errors: [] });

      // 审计必须同时含 before 与 after，且带上操作人上下文
      expect(harness.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUserId: actor.adminUserId,
          action: 'CONFIG_CHANGE',
          resourceType: 'CONFIG',
          beforeData: { items: [{ key: 'reportFreePreviewRatio', value: 0.2 }] },
          afterData: { items: [{ key: 'reportFreePreviewRatio', value: 0.25, changeNote: '提升到 25%' }] },
          reason: 'reportFreePreviewRatio: 提升到 25%',
          ip: '203.0.113.42',
          requestId: 'req_test',
        }),
      );
    });

    it('invalidateCaches=false 时不失效缓存，并在说明里讲清生效时机', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot
        .mockResolvedValueOnce(
          snapshotOf('sv-1', [entry('reportFreePreviewRatio', 0.2, { valueType: ConfigValueType.NUMBER })]),
        )
        .mockResolvedValueOnce(
          snapshotOf('sv-2', [entry('reportFreePreviewRatio', 0.3, { valueType: ConfigValueType.NUMBER })]),
        );

      const result = await harness.service.update(
        { items: [{ key: 'reportFreePreviewRatio', value: 0.3 }], invalidateCaches: false },
        actor,
      );

      expect(harness.systemConfigs.invalidate).not.toHaveBeenCalled();
      const cacheInvalidation = result.cacheInvalidation as { invalidatedKeys: string[]; note: string };
      expect(cacheInvalidation.invalidatedKeys).toEqual([]);
      expect(cacheInvalidation.note).toContain('未失效');
    });

    it('impactAssessment 逐项说明影响（运营必须知道老报告不会回溯）', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot
        .mockResolvedValueOnce(
          snapshotOf('sv-1', [entry('reportFreePreviewRatio', 0.2, { valueType: ConfigValueType.NUMBER })]),
        )
        .mockResolvedValueOnce(
          snapshotOf('sv-2', [entry('reportFreePreviewRatio', 0.3, { valueType: ConfigValueType.NUMBER })]),
        );

      const result = await harness.service.update({ items: [{ key: 'reportFreePreviewRatio', value: 0.3 }] }, actor);
      const impact = result.impactAssessment as { notes: string[]; estimatedClientPropagationMinutes: number };

      expect(impact.notes[0]).toContain('不回溯调整');
      expect(impact.estimatedClientPropagationMinutes).toBe(60);
    });
  });

  describe('update dryRun', () => {
    it('试运行不写库、不失效缓存，但返回 before/after 对比', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-20260214-aaaa1111', [
          entry('reportFreePreviewRatio', 0.2, { valueType: ConfigValueType.NUMBER, min: 0, max: 1 }),
        ]),
      );

      const result = await harness.service.update(
        { items: [{ key: 'reportFreePreviewRatio', value: 0.25 }], dryRun: true },
        actor,
      );

      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
      expect(harness.systemConfigs.invalidate).not.toHaveBeenCalled();
      expect(harness.audit.log).not.toHaveBeenCalled();
      expect(result.dryRun).toBe(true);
      // 试运行不算「已更新」，另用 wouldUpdateCount 表达
      expect(result.updatedCount).toBe(0);
      expect(result.wouldUpdateCount).toBe(1);
      expect(result.configVersion).toBe('sv-20260214-aaaa1111');
      expect((result.items as Array<Record<string, unknown>>)[0].after).toBe(0.25);
    });

    it('试运行同样执行校验（避免「试运行通过、正式提交被拒」）', async () => {
      const harness = createHarness();
      harness.systemConfigs.getSnapshot.mockResolvedValue(
        snapshotOf('sv-1', [
          entry('reportFreePreviewRatio', 0.2, { valueType: ConfigValueType.NUMBER, min: 0, max: 1 }),
        ]),
      );

      await expect(
        harness.service.update({ items: [{ key: 'reportFreePreviewRatio', value: 2 }], dryRun: true }, actor),
      ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
    });
  });
});
