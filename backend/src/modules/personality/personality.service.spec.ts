/**
 * 人格画像服务测试
 *
 * 聚焦「展示错误会误导用户」与「安全边界」两类分支：
 *   · 尚无画像 / 指定版本不存在 → 明确的 404 语义（不返回空对象让前端崩）
 *   · 算法版本不兼容 → 引导重测，而不是用旧字段语义给出错误解读
 *   · 维度视图的极性/对立极/强度必须自洽（percent 与 pole 不得矛盾）
 *   · dimension 参数与 metric 不匹配 → 拒绝（否则返回永远为空的曲线，属隐性错误）
 *   · 免责声明优先读系统配置，缺失时用兜底文案
 *   · 趋势在无上一版本时为 null（不编造对比数据）
 */

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { PersonalityService } from './personality.service';
import { ENGINE_VERSION } from './engine/personality-engine.types';

// ============================================================================
// 夹具
// ============================================================================

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';

/** 画像行（字段齐全，避免可选字段缺失导致 `??` 兜底掩盖真实逻辑） */
const profileRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'profile-3',
  userId: USER_ID,
  version: 3,
  isCurrent: true,
  engineVersion: ENGINE_VERSION,
  mbtiType: 'INFJ',
  mbtiConfidence: 78.4,
  eiPercent: 34.5,
  snPercent: 68.2,
  tfPercent: 61.4,
  jpPercent: 72.8,
  openness: 82.5,
  conscientiousness: 71,
  extraversion: 34.5,
  agreeableness: 88,
  neuroticism: 56.5,
  attachmentStyle: 'ANXIOUS',
  loveLanguages: ['QUALITY_TIME', 'WORDS_OF_AFFIRMATION'],
  conflictStyle: 'ACCOMMODATING',
  consistencyScore: 82.1,
  completionRate: 100,
  avgResponseMs: 10132,
  computedAt: new Date('2026-02-14T13:38:12.000Z'),
  testResult: { sessionId: 'session-1', definitionCode: 'MBTI_LITE' },
  ...overrides,
});

interface PrismaStub {
  personalityProfile: { findFirst: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  personalitySnapshot: { findMany: jest.Mock };
  systemConfig: { findUnique: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  personalityProfile: {
    findFirst: jest.fn().mockResolvedValue(profileRow()),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  personalitySnapshot: { findMany: jest.fn().mockResolvedValue([]) },
  systemConfig: { findUnique: jest.fn().mockResolvedValue(null) },
});

const snapshotRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  capturedAt: new Date('2026-01-18T14:02:55.000Z'),
  mbtiType: 'INFP',
  bigFive: { openness: 78, conscientiousness: 66, extraversion: 41, agreeableness: 82, neuroticism: 49 },
  sourceSessionId: 'session-old',
  profile: { version: 1, mbtiConfidence: 62.7, eiPercent: 42, snPercent: 61, tfPercent: 58, jpPercent: 66 },
  sourceSession: { definitionCode: 'MBTI_LITE' },
  ...overrides,
});

// ============================================================================
// 测试
// ============================================================================

describe('PersonalityService', () => {
  let prisma: PrismaStub;
  let service: PersonalityService;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new PersonalityService(prisma as unknown as PrismaService);
  });

  // ==========================================================================
  // 画像读取
  // ==========================================================================

  describe('getProfile', () => {
    it('返回完整画像（MBTI / 大五 / 关系风格 / 质量）', async () => {
      const view = await service.getProfile(USER_ID);

      expect(view.profileId).toBe('profile-3');
      expect(view.version).toBe(3);
      expect(view.engineVersion).toBe(ENGINE_VERSION);
      expect(view.mbti.type).toBe('INFJ');
      expect(view.mbti.confidence).toBe(78.4);
      expect(view.bigFive.openness).toBe(82.5);
      expect(view.relationshipStyle.attachment).toBe('ANXIOUS');
      expect(view.quality.consistencyScore).toBe(82.1);
    });

    it('维度视图包含对立极与强度档位，且二者自洽', async () => {
      const view = await service.getProfile(USER_ID);
      const ei = view.mbti.dimensions['EI'];

      // EI = 34.5 < 50 → 负极 I；对立极 E 为 65.5
      expect(ei).toEqual({
        percent: 34.5,
        pole: 'I',
        oppositePercent: 65.5,
        oppositePole: 'E',
        strength: 'MODERATE',
      });
      // percent + oppositePercent 恒为 100
      expect((ei?.percent ?? 0) + (ei?.oppositePercent ?? 0)).toBe(100);
    });

    it('percent ≥ 50 时取正极字母', async () => {
      const view = await service.getProfile(USER_ID);

      expect(view.mbti.dimensions['SN']?.pole).toBe('S');
      expect(view.mbti.dimensions['SN']?.oppositePole).toBe('N');
      expect(view.mbti.dimensions['TF']?.pole).toBe('T');
      expect(view.mbti.dimensions['JP']?.pole).toBe('J');
    });

    it('默认返回当前画像（isCurrent = true）', async () => {
      await service.getProfile(USER_ID);

      const args = prisma.personalityProfile.findFirst.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      expect(args.where['isCurrent']).toBe(true);
      expect(args.where['userId']).toBe(USER_ID);
    });

    it('指定 version 时按版本查询', async () => {
      await service.getProfile(USER_ID, { version: 2 });

      const args = prisma.personalityProfile.findFirst.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      expect(args.where['version']).toBe(2);
      expect(args.where['isCurrent']).toBeUndefined();
    });

    it('【语义区分】从未测试 → 提示先完成测评', async () => {
      prisma.personalityProfile.findFirst.mockResolvedValue(null);

      try {
        await service.getProfile(USER_ID);
        throw new Error('应当抛出异常');
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessException);
        expect((error as BusinessException).code).toBe(ErrorCode.PERSONALITY_PROFILE_NOT_FOUND);
        expect((error as BusinessException).userMessage).toContain('还没有人格画像');
      }
    });

    it('【语义区分】指定版本不存在 → 提示版本无效（而不是「尚未测试」）', async () => {
      prisma.personalityProfile.findFirst.mockResolvedValue(null);

      try {
        await service.getProfile(USER_ID, { version: 99 });
        throw new Error('应当抛出异常');
      } catch (error) {
        expect((error as BusinessException).userMessage).toContain('未找到版本 99');
      }
    });

    it('【兼容性】算法主版本不被支持 → 引导重新测试', async () => {
      prisma.personalityProfile.findFirst.mockResolvedValue(profileRow({ engineVersion: 'pe-v0.9.0' }));

      await expect(service.getProfile(USER_ID)).rejects.toMatchObject({
        code: ErrorCode.ENGINE_VERSION_UNSUPPORTED,
      });
    });

    it('同一主版本的小版本差异仍被接受（向后兼容）', async () => {
      prisma.personalityProfile.findFirst.mockResolvedValue(profileRow({ engineVersion: 'pe-v1.2.3' }));

      await expect(service.getProfile(USER_ID)).resolves.toBeDefined();
    });

    it('无法解析的版本号按不兼容处理（不给出错误解读）', async () => {
      prisma.personalityProfile.findFirst.mockResolvedValue(profileRow({ engineVersion: 'legacy' }));

      await expect(service.getProfile(USER_ID)).rejects.toMatchObject({
        code: ErrorCode.ENGINE_VERSION_UNSUPPORTED,
      });
    });

    it('isLatest 标识是否为最新版本', async () => {
      // 第一次 findFirst 取目标画像，第二次取最新版本号
      prisma.personalityProfile.findFirst
        .mockResolvedValueOnce(profileRow({ version: 2 }))
        .mockResolvedValueOnce({ version: 3 });

      const view = await service.getProfile(USER_ID, { version: 2 });

      expect(view.isLatest).toBe(false);
    });

    it('summary 来自类型模板且标记为非 AI 生成', async () => {
      const view = await service.getProfile(USER_ID);

      expect(view.summary.isAiGenerated).toBe(false);
      expect(view.summary.headline.length).toBeGreaterThan(0);
      expect(view.summary.strengths).toHaveLength(3);
      expect(view.summary.watchouts).toHaveLength(3);
    });

    it('来源会话与测试编码来自 testResult 关联', async () => {
      const view = await service.getProfile(USER_ID);

      expect(view.sourceSessionId).toBe('session-1');
      expect(view.sourceTestCode).toBe('MBTI_LITE');
    });

    it('无关联会话时来源字段为 null（不抛异常）', async () => {
      prisma.personalityProfile.findFirst
        .mockResolvedValueOnce(profileRow({ testResult: null }))
        .mockResolvedValueOnce({ version: 3 });

      const view = await service.getProfile(USER_ID);

      expect(view.sourceSessionId).toBeNull();
      expect(view.sourceTestCode).toBeNull();
    });

    it('质量块包含置信度档位与提示文案', async () => {
      const view = await service.getProfile(USER_ID);

      expect(view.quality.confidenceLevel).toBe('HIGH');
      expect(view.quality.notice).toBeNull();
    });

    it('一致性偏低时给出提示文案且档位为 LOW', async () => {
      prisma.personalityProfile.findFirst.mockResolvedValue(profileRow({ consistencyScore: 45 }));

      const view = await service.getProfile(USER_ID);

      expect(view.quality.confidenceLevel).toBe('LOW');
      expect(view.quality.notice).toContain('置信度偏低');
    });

    describe('免责声明', () => {
      it('优先读取系统配置（合规文案可热更）', async () => {
        prisma.systemConfig.findUnique.mockResolvedValue({ value: '自定义免责声明文案' });

        const view = await service.getProfile(USER_ID);

        expect(view.disclaimer).toBe('自定义免责声明文案');
      });

      it('配置缺失时使用兜底文案', async () => {
        prisma.systemConfig.findUnique.mockResolvedValue(null);

        const view = await service.getProfile(USER_ID);

        expect(view.disclaimer).toContain('仅供自我探索参考');
        expect(view.disclaimer).toContain('不构成');
      });

      it('配置为空字符串时也使用兜底文案', async () => {
        prisma.systemConfig.findUnique.mockResolvedValue({ value: '   ' });

        const view = await service.getProfile(USER_ID);

        expect(view.disclaimer).toContain('仅供自我探索参考');
      });

      it('配置读取失败不阻断画像展示', async () => {
        prisma.systemConfig.findUnique.mockRejectedValue(new Error('db down'));

        await expect(service.getProfile(USER_ID)).resolves.toMatchObject({
          disclaimer: expect.stringContaining('仅供自我探索参考'),
        });
      });
    });

    describe('趋势对比', () => {
      it('无上一版本时 trend 为 null（不编造对比）', async () => {
        prisma.personalityProfile.findFirst
          .mockResolvedValueOnce(profileRow())
          .mockResolvedValueOnce({ version: 3 }) // isLatest
          .mockResolvedValueOnce(null); // previous

        const view = await service.getProfile(USER_ID);

        expect(view.trend).toBeNull();
      });

      it('includeTrend=false 时跳过趋势查询', async () => {
        const view = await service.getProfile(USER_ID, { includeTrend: false });

        expect(view.trend).toBeNull();
      });

      it('有上一版本时返回各维度差值与类型变化标记', async () => {
        prisma.personalityProfile.findFirst
          .mockResolvedValueOnce(profileRow())
          .mockResolvedValueOnce({ version: 3 })
          .mockResolvedValueOnce(
            profileRow({
              version: 2,
              mbtiType: 'INFP',
              mbtiConfidence: 74.1,
              eiPercent: 38.1,
              snPercent: 64.8,
              tfPercent: 58.9,
              jpPercent: 70.2,
              computedAt: new Date('2026-02-10T08:21:03.000Z'),
            }),
          );

        const view = await service.getProfile(USER_ID);

        expect(view.trend?.comparedWithVersion).toBe(2);
        expect(view.trend?.mbtiChanged).toBe(true);
        expect(view.trend?.confidenceDelta).toBe(4.3);
        expect(view.trend?.dimensionDelta).toHaveLength(4);
      });
    });
  });

  // ==========================================================================
  // 历史版本
  // ==========================================================================

  describe('listHistory', () => {
    it('默认按 version 倒序', async () => {
      prisma.personalityProfile.findMany.mockResolvedValue([
        {
          id: 'p3',
          version: 3,
          engineVersion: ENGINE_VERSION,
          mbtiType: 'INFJ',
          mbtiConfidence: 78.4,
          computedAt: new Date(),
        },
        {
          id: 'p2',
          version: 2,
          engineVersion: ENGINE_VERSION,
          mbtiType: 'INFP',
          mbtiConfidence: 74.1,
          computedAt: new Date(),
        },
      ]);
      prisma.personalityProfile.findFirst.mockResolvedValue({ version: 3 });

      const result = await service.listHistory(USER_ID, { page: 1, pageSize: 20, skip: 0, take: 20 });

      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.isLatest).toBe(true);
      expect(result.items[1]?.isLatest).toBe(false);

      const args = prisma.personalityProfile.findMany.mock.calls[0]?.[0] as {
        orderBy: Record<string, string>;
      };
      expect(args.orderBy).toEqual({ version: 'desc' });
    });

    it('支持按 generatedAt 排序', async () => {
      await service.listHistory(USER_ID, {
        page: 1,
        pageSize: 20,
        skip: 0,
        take: 20,
        sortBy: 'generatedAt',
        order: 'asc',
      });

      const args = prisma.personalityProfile.findMany.mock.calls[0]?.[0] as {
        orderBy: Record<string, string>;
      };
      expect(args.orderBy).toEqual({ computedAt: 'asc' });
    });

    it('支持按算法版本筛选', async () => {
      await service.listHistory(USER_ID, {
        page: 1,
        pageSize: 20,
        skip: 0,
        take: 20,
        engineVersion: ENGINE_VERSION,
      });

      const args = prisma.personalityProfile.findMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      expect(args.where['engineVersion']).toBe(ENGINE_VERSION);
    });

    it('返回分页元信息与 hasNext', async () => {
      prisma.personalityProfile.count.mockResolvedValue(25);

      const result = await service.listHistory(USER_ID, { page: 2, pageSize: 20, skip: 20, take: 20 });

      expect(result.total).toBe(25);
      expect(result.page).toBe(2);
      expect(result.hasNext).toBe(false); // 2 * 20 = 40 > 25
    });

    it('历史条目包含类型中文名（前端无需再查百科）', async () => {
      prisma.personalityProfile.findMany.mockResolvedValue([
        {
          id: 'p3',
          version: 3,
          engineVersion: ENGINE_VERSION,
          mbtiType: 'INFJ',
          mbtiConfidence: 78.4,
          computedAt: new Date(),
        },
      ]);

      const result = await service.listHistory(USER_ID, { page: 1, pageSize: 20, skip: 0, take: 20 });

      expect(result.items[0]?.mbtiTypeName.length).toBeGreaterThan(0);
      expect(result.items[0]?.mbtiTypeName).not.toBe('INFJ'); // 应为中文名而非类型码
    });
  });

  // ==========================================================================
  // 成长曲线
  // ==========================================================================

  describe('getSnapshots', () => {
    it('默认返回大五全部五维', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([snapshotRow()]);

      const result = await service.getSnapshots(USER_ID);

      expect(result.metric).toBe('BIG_FIVE');
      expect(result.granularity).toBe('RAW');
      expect(result.range).toBe('90D');
      expect(result.availableDimensions).toHaveLength(5);
      expect(result.points[0]?.values).toHaveProperty('openness', 78);
    });

    it('【隐性错误防护】dimension 与 metric 不匹配 → 拒绝', async () => {
      await expect(service.getSnapshots(USER_ID, { metric: 'BIG_FIVE', dimension: 'EI' })).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('MBTI_DIMENSIONS 指标从画像关系取值', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([snapshotRow()]);

      const result = await service.getSnapshots(USER_ID, { metric: 'MBTI_DIMENSIONS' });

      expect(result.points[0]?.values).toEqual({ EI: 42, SN: 61, TF: 58, JP: 66 });
      expect(result.availableDimensions).toEqual(['EI', 'SN', 'TF', 'JP']);
    });

    it('CONFIDENCE 指标只返回置信度', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([snapshotRow()]);

      const result = await service.getSnapshots(USER_ID, { metric: 'CONFIDENCE' });

      expect(result.points[0]?.values).toEqual({ confidence: 62.7 });
    });

    it('指定单维时只返回该维度', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([snapshotRow()]);

      const result = await service.getSnapshots(USER_ID, { metric: 'BIG_FIVE', dimension: 'openness' });

      expect(result.points[0]?.values).toEqual({ openness: 78 });
      expect(result.availableDimensions).toEqual(['openness']);
    });

    it('画像关联缺失时不产生全空的数据点', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([snapshotRow({ profile: null })]);

      const result = await service.getSnapshots(USER_ID, { metric: 'CONFIDENCE' });

      expect(result.points).toHaveLength(0);
    });

    it('大五数据缺失的也跳过（不产生空点）', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([snapshotRow({ bigFive: {} })]);

      const result = await service.getSnapshots(USER_ID, { metric: 'BIG_FIVE' });

      expect(result.points).toHaveLength(0);
    });

    it('range=ALL 时不施加时间过滤', async () => {
      await service.getSnapshots(USER_ID, { range: 'ALL' });

      const args = prisma.personalitySnapshot.findMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      expect(args.where['capturedAt']).toBeUndefined();
    });

    it('指定时间范围时按 capturedAt 过滤', async () => {
      await service.getSnapshots(USER_ID, { range: '30D' });

      const args = prisma.personalitySnapshot.findMany.mock.calls[0]?.[0] as {
        where: { capturedAt?: { gte: Date } };
      };
      expect(args.where.capturedAt?.gte).toBeInstanceOf(Date);
    });

    it('WEEK 聚合把同周的点合并并给出 sampleCount', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([
        snapshotRow({ capturedAt: new Date('2026-01-19T10:00:00.000Z'), bigFive: { openness: 70 } }),
        snapshotRow({ capturedAt: new Date('2026-01-21T10:00:00.000Z'), bigFive: { openness: 90 } }),
      ]);

      const result = await service.getSnapshots(USER_ID, { granularity: 'WEEK' });

      expect(result.points).toHaveLength(1);
      expect(result.points[0]?.values['openness']).toBe(80);
      expect(result.points[0]?.sampleCount).toBe(2);
    });

    it('每个点带出来源会话与测试编码（前端可跳转到对应报告）', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([snapshotRow()]);

      const result = await service.getSnapshots(USER_ID);

      expect(result.points[0]).toMatchObject({
        sessionId: 'session-old',
        testCode: 'MBTI_LITE',
        profileVersion: 1,
        mbtiType: 'INFP',
        confidence: 62.7,
      });
    });

    it('无快照时返回空点集（不抛异常）', async () => {
      prisma.personalitySnapshot.findMany.mockResolvedValue([]);

      const result = await service.getSnapshots(USER_ID);

      expect(result.points).toEqual([]);
      expect(result.rangeStart).toBeDefined();
      expect(result.rangeEnd).toBeDefined();
    });
  });

  // ==========================================================================
  // 类型百科
  // ==========================================================================

  describe('getTypeInfo', () => {
    it('返回指定类型的百科内容', async () => {
      const profile = service.getTypeInfo({ mbti: 'INFJ' });

      expect(profile.type).toBe('INFJ');
      expect(profile.typeName.length).toBeGreaterThan(0);
      expect(profile.dimensionProfile).toHaveLength(4);
      expect(profile.strengths).toHaveLength(4);
      expect(profile.blindSpots).toHaveLength(3);
      expect(profile.relationshipTips).toHaveLength(3);
    });

    it('类型参数大小写不敏感', async () => {
      expect(service.getTypeInfo({ mbti: 'infj' }).type).toBe('INFJ');
    });

    it('全部 16 种类型都有百科内容', async () => {
      const types = service.listTypeProfiles();

      expect(types).toHaveLength(16);
      expect(new Set(types.map((item) => item.type)).size).toBe(16);
    });

    it('未知类型 → 404（40012）', async () => {
      await expect(async () => service.getTypeInfo({ mbti: 'XXXX' })).rejects.toMatchObject({
        code: ErrorCode.MBTI_TYPE_INVALID,
      });
    });
  });
});
