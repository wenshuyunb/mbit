/**
 * SystemConfigService 单测
 *
 * 这个服务是「后台写、前台读」的唯一交汇点，因此测试重点不是覆盖率，而是四件事：
 *   1. 目录默认值 / 数据库值 / 环境变量锁定项的优先级（错一个就会出现「改了没生效」）；
 *   2. 缓存命中与失效（错一个就会出现「改了三天没生效」）；
 *   3. 公开响应的字段口径（含小程序已消费的别名，错一个前端就白屏）；
 *   4. 依赖故障时的降级（缓存宕机、价格表查询失败都不能让首屏 500）。
 */

import { ConfigValueType } from '@prisma/client';

import { ConfigRequestError, SystemConfigService, type ResolvedConfigEntry } from './system-config.service';

/** 构造一条解析后的配置（只填断言需要的字段） */
const entry = (key: string, value: unknown, extra: Partial<ResolvedConfigEntry> = {}): ResolvedConfigEntry => ({
  key,
  group: 'LIMIT',
  groupName: '限额与限流',
  label: key,
  valueType: typeof value === 'boolean' ? ConfigValueType.BOOLEAN : ConfigValueType.STRING,
  value,
  rawValue: String(value),
  description: `${key} 说明`,
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

interface Harness {
  service: SystemConfigService;
  prisma: {
    systemConfig: { findMany: jest.Mock };
    membershipPlan: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
  };
  redis: {
    key: jest.Mock;
    getJson: jest.Mock;
    setJson: jest.Mock;
    del: jest.Mock;
    delByPattern: jest.Mock;
  };
  configService: { get: jest.Mock };
  /** 环境变量基线（ConfigService 路径 → 值） */
  baselines: Record<string, unknown>;
}

const createHarness = (): Harness => {
  const prisma = {
    systemConfig: { findMany: jest.fn().mockResolvedValue([]) },
    membershipPlan: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const redis = {
    key: jest.fn((...parts: Array<string | number>) => ['sm', ...parts.map(String)].join(':')),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    delByPattern: jest.fn().mockResolvedValue(0),
  };

  const baselines: Record<string, unknown> = {
    'features.payment': true,
    'features.coupleMatch': true,
    'features.aiChat': true,
    'quota.freeAiMessages': 10,
    'quota.memberDailyAiMessages': 50,
    'quota.reportFreePreviewRatio': 0.2,
    'quota.orderExpireMinutes': 30,
    'oss.cdnDomain': '',
  };

  const configService = { get: jest.fn((path: unknown) => baselines[path as string]) };

  const service = new SystemConfigService(prisma as never, redis as never, configService as never);

  return { service, prisma, redis, configService, baselines };
};

describe('SystemConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('数据来源优先级', () => {
    it('库中无配置时使用环境变量基线', async () => {
      const harness = createHarness();

      const entries = await harness.service.getEntries();
      const freeQuota = entries.find((item) => item.key === 'freeAiQuotaTotal');

      expect(freeQuota?.value).toBe(10);
      expect(freeQuota?.isEditable).toBe(true);
    });

    it('环境变量锁定项（envOverride 非空）取值来自环境且后台只读', async () => {
      const harness = createHarness();
      harness.baselines['features.payment'] = false;

      const entries = await harness.service.getEntries();
      const payment = entries.find((item) => item.key === 'FEATURE_PAYMENT');

      expect(payment?.value).toBe(false);
      expect(payment?.isEditable).toBe(false);
      expect(payment?.envOverride).toBe('FEATURE_PAYMENT');
    });

    it('数据库行优先于环境基线（可热改项）', async () => {
      const harness = createHarness();
      harness.prisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'reportFreePreviewRatio',
          value: '0.35',
          valueType: ConfigValueType.NUMBER,
          group: 'LIMIT',
          description: null,
          isPublic: true,
          isEditable: true,
          updatedAt: new Date('2026-02-01T03:00:00.000Z'),
          updatedByAdminId: '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a',
        },
      ]);

      const entries = await harness.service.getEntries();
      const ratio = entries.find((item) => item.key === 'reportFreePreviewRatio');

      expect(ratio?.value).toBe(0.35);
      expect(ratio?.updatedAt).toBe('2026-02-01T03:00:00.000Z');
      expect(ratio?.updatedByAdminId).toBe('0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a');
    });

    it('环境变量锁定项即使库中有行也不采用库值（配置即环境变量）', async () => {
      const harness = createHarness();
      harness.baselines['features.aiChat'] = true;
      harness.prisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'FEATURE_AI_CHAT',
          value: 'false',
          valueType: ConfigValueType.BOOLEAN,
          group: 'FEATURE_FLAG',
          description: null,
          isPublic: true,
          isEditable: true,
          updatedAt: new Date(),
          updatedByAdminId: null,
        },
      ]);

      const entries = await harness.service.getEntries();
      expect(entries.find((item) => item.key === 'FEATURE_AI_CHAT')?.value).toBe(true);
    });

    it('目录之外的键以只读方式下发（后台看不到语义，不允许改）', async () => {
      const harness = createHarness();
      harness.prisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'legacy.internalSwitch',
          value: 'on',
          valueType: ConfigValueType.STRING,
          group: 'SECURITY',
          description: null,
          isPublic: false,
          isEditable: true,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedByAdminId: null,
        },
      ]);

      const entries = await harness.service.getEntries();
      const legacy = entries.find((item) => item.key === 'legacy.internalSwitch');

      expect(legacy?.isKnown).toBe(false);
      expect(legacy?.isEditable).toBe(false);
      expect(legacy?.isPublic).toBe(false);
    });
  });

  describe('缓存', () => {
    it('缓存命中时不查库', async () => {
      const harness = createHarness();
      harness.redis.getJson.mockResolvedValue({
        version: 'sv-20260214-deadbeef',
        generatedAt: '2026-02-14T18:00:00.000Z',
        entries: [entry('disclaimer.aiContent', '缓存中的声明')],
      });

      const config = await harness.service.getPublicConfig({});

      expect(harness.prisma.systemConfig.findMany).not.toHaveBeenCalled();
      expect(config.configVersion).toBe('sv-20260214-deadbeef');
      expect((config.disclaimers as Record<string, unknown>).aiContent).toBe('缓存中的声明');
    });

    it('缓存未命中时查库并回填（TTL 与响应头 max-age 一致）', async () => {
      const harness = createHarness();

      await harness.service.getSnapshot();

      expect(harness.prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
      expect(harness.redis.setJson).toHaveBeenCalledWith('sm:system:config', expect.anything(), 300);
    });

    it('invalidate 同时清理基准键与按版本命名的键', async () => {
      const harness = createHarness();

      const keys = await harness.service.invalidate('测试');

      expect(keys).toEqual(['sm:system:config']);
      expect(harness.redis.del).toHaveBeenCalledWith('sm:system:config');
      expect(harness.redis.delByPattern).toHaveBeenCalledWith('sm:system:config:*');
    });

    it('Redis 故障时降级直查数据库（首屏不能因缓存宕机白屏）', async () => {
      const harness = createHarness();
      harness.redis.getJson.mockRejectedValue(new Error('redis down'));
      harness.redis.setJson.mockRejectedValue(new Error('redis down'));

      const config = await harness.service.getPublicConfig({});

      expect(harness.prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
      expect(typeof config.configVersion).toBe('string');
    });

    it('invalidate 失败时返回空数组并留痕，不抛错（配置已落库，不能因缓存故障让写操作失败）', async () => {
      const harness = createHarness();
      harness.redis.del.mockRejectedValue(new Error('redis down'));

      await expect(harness.service.invalidate('测试')).resolves.toEqual([]);
    });
  });

  describe('getPublicConfig', () => {
    it('下发契约字段与小程序已消费的别名（两套字段同源）', async () => {
      const harness = createHarness();
      harness.prisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'disclaimer.aiContent',
          value: '自定义 AI 声明',
          valueType: ConfigValueType.STRING,
          group: 'DISCLAIMER',
          description: null,
          isPublic: true,
          isEditable: true,
          updatedAt: new Date('2026-02-10T00:00:00.000Z'),
          updatedByAdminId: null,
        },
        {
          key: 'app.support.wechatId',
          value: 'soulmap-service',
          valueType: ConfigValueType.STRING,
          group: 'APP',
          description: null,
          isPublic: true,
          isEditable: true,
          updatedAt: new Date('2026-02-10T00:00:00.000Z'),
          updatedByAdminId: null,
        },
      ]);

      const config = await harness.service.getPublicConfig({ clientVersion: '1.4.2' });

      const features = config.features as Record<string, unknown>;
      expect(features.FEATURE_PAYMENT).toBe(true);
      expect(features.payment).toBe(true);
      expect(features.maintenanceMode).toBe(false);

      const disclaimers = config.disclaimers as Record<string, unknown>;
      expect(disclaimers.aiContent).toBe('自定义 AI 声明');
      // 别名与契约字段同源：都读 disclaimer.aiContent / disclaimer.personality
      expect(disclaimers.reportFooter).toBe(disclaimers.assessment);

      expect((config.support as Record<string, unknown>).wechatId).toBe('soulmap-service');
      expect(config.version).toBe(config.configVersion);
      expect((config.app as Record<string, unknown>).version).toBe('1.4.2');
      expect(config.reportFreePreviewRatio).toBe(0.2);
      expect(config.serverTime).toBeDefined();
    });

    it('platform=ADMIN 时不返回分享文案（精简配置）', async () => {
      const harness = createHarness();

      const config = await harness.service.getPublicConfig({ platform: 'ADMIN' });

      expect(config.share).toBeUndefined();
    });

    it('clientVersion 低于 minClientVersion 时置强更标记', async () => {
      const harness = createHarness();
      harness.prisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'app.minClientVersion',
          value: '1.2.0',
          valueType: ConfigValueType.STRING,
          group: 'APP',
          description: null,
          isPublic: true,
          isEditable: true,
          updatedAt: new Date(),
          updatedByAdminId: null,
        },
      ]);

      const outdated = await harness.service.getPublicConfig({ clientVersion: '1.1.0' });
      const current = await harness.service.getPublicConfig({ clientVersion: '1.4.2' });

      expect((outdated.app as Record<string, unknown>).forceUpdate).toBe(true);
      expect((current.app as Record<string, unknown>).forceUpdate).toBe(false);
    });

    it('维护模式仍返回 200 且带 maintenanceMode 标记（不能让维护期拉不到配置）', async () => {
      const harness = createHarness();
      harness.prisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'maintenanceMode',
          value: 'true',
          valueType: ConfigValueType.BOOLEAN,
          group: 'FEATURE_FLAG',
          description: null,
          isPublic: true,
          isEditable: true,
          updatedAt: new Date(),
          updatedByAdminId: null,
        },
      ]);

      const config = await harness.service.getPublicConfig({});

      expect((config.features as Record<string, unknown>).maintenanceMode).toBe(true);
    });

    it('policies.currentVersions 与 user 模块读取的 policy.version.* 同源', async () => {
      const harness = createHarness();
      harness.prisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'policy.version.PRIVACY_POLICY',
          value: '3.0.0',
          valueType: ConfigValueType.STRING,
          group: 'COMPLIANCE',
          description: null,
          isPublic: true,
          isEditable: true,
          updatedAt: new Date(),
          updatedByAdminId: null,
        },
      ]);

      const config = await harness.service.getPublicConfig({});
      const policies = config.policies as { currentVersions: Record<string, string> };

      expect(policies.currentVersions.PRIVACY_POLICY).toBe('3.0.0');
    });

    it('keys 白名单只裁剪配置项，不裁剪免责声明（合规文案任何情况下都要下发）', async () => {
      const harness = createHarness();

      const config = await harness.service.getPublicConfig({ keys: 'FEATURE_PAYMENT' });
      const features = config.features as Record<string, unknown>;
      const disclaimers = config.disclaimers as Record<string, unknown>;

      expect(features.FEATURE_PAYMENT).toBe(true);
      expect(features.FEATURE_AI_CHAT).toBeUndefined();
      expect(disclaimers.aiContent).toBeDefined();
    });

    it('keys 白名单不得让别名变成 false（否则「按需拉取」会变成「按需关闭功能」）', async () => {
      const harness = createHarness();

      // 白名单里没有支付开关：契约字段被裁掉，但别名必须仍是真值 true
      const config = await harness.service.getPublicConfig({ keys: 'reportFreePreviewRatio' });
      const features = config.features as Record<string, unknown>;

      expect(features.FEATURE_PAYMENT).toBeUndefined();
      expect(features.payment).toBe(true);
      expect(features.aiChat).toBe(true);
    });

    it('keys 数量超过上限时抛 ConfigRequestError（由控制器转 400）', async () => {
      const harness = createHarness();
      const keys = Array.from({ length: 101 }, (_value, index) => `k${index}`).join(',');

      await expect(harness.service.getPublicConfig({ keys })).rejects.toBeInstanceOf(ConfigRequestError);
    });

    it('价格表查询失败时下发空数组而不是让首屏 500', async () => {
      const harness = createHarness();
      harness.prisma.membershipPlan.findMany.mockRejectedValue(new Error('db down'));

      const config = await harness.service.getPublicConfig({});
      const pricing = config.pricing as { membershipPlans: unknown[] };

      expect(pricing.membershipPlans).toEqual([]);
    });

    it('套餐价格按「分」折算并标注单位', async () => {
      const harness = createHarness();
      harness.prisma.membershipPlan.findMany.mockResolvedValue([
        {
          code: 'MEMBER_MONTHLY',
          name: '月度会员',
          priceAmount: 3900,
          durationDays: 30,
          isRecommended: false,
          currency: 'CNY',
        },
      ]);

      const config = await harness.service.getPublicConfig({});
      const plans = (config.pricing as { membershipPlans: Array<Record<string, unknown>> }).membershipPlans;

      expect(plans[0].priceDisplay).toBe('¥39.00');
      expect((config.pricing as Record<string, unknown>).amountUnit).toBe('CENT');
    });
  });

  describe('getDisclaimers', () => {
    it('按场景返回对应文案，ALL 场景带危机资源', async () => {
      const harness = createHarness();

      const all = await harness.service.getDisclaimers({ scene: 'ALL' });
      const report = await harness.service.getDisclaimers({ scene: 'REPORT' });

      expect(Array.isArray(all.items)).toBe(true);
      expect(all.crisisResources).not.toBeNull();
      // REPORT 场景不需要危机资源（只有 AI 对话强绑定）
      expect(report.crisisResources).toBeNull();

      const reportItems = report.items as Array<{ key: string }>;
      expect(reportItems.map((item) => item.key)).toEqual([
        'AI_CONTENT_DISCLAIMER',
        'ASSESSMENT_DISCLAIMER',
        'AI_GENERATED_NOTICE',
        'CONFIDENCE_NOTICE',
      ]);
      expect(String(report.version).startsWith('dl-')).toBe(true);
    });

    it('required 文案恒为 true（前端不可绕过）', async () => {
      const harness = createHarness();

      const result = await harness.service.getDisclaimers({ scene: 'REPORT' });
      const items = result.items as Array<{ required: boolean; content: string }>;

      expect(items[0].required).toBe(true);
      expect(items[0].content.length).toBeGreaterThan(0);
    });

    it('language=en-US 时如实返回 zh-CN（不伪装已支持英文）', async () => {
      const harness = createHarness();

      const result = await harness.service.getDisclaimers({ scene: 'ALL', language: 'en-US' });

      expect(result.language).toBe('zh-CN');
    });

    it('scene 缺省为 ALL，language 缺省为 zh-CN', async () => {
      const harness = createHarness();

      const result = await harness.service.getDisclaimers({});

      expect(result.scene).toBe('ALL');
      expect(result.language).toBe('zh-CN');
    });
  });
});
