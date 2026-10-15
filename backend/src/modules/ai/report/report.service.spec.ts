/**
 * 报告服务测试（契约 §3.5）
 *
 * 两组核心主张：
 *   · **创建幂等**：命中成功的报告直接复用，不入队 —— 不为同一内容付两次费
 *   · **详情裁剪**：未解锁段落的正文不出现在返回对象里（付费墙的安全边界）
 */

import type { Queue } from 'bullmq';

import { ErrorCode } from '../../../common/errors/error-code';
import type { CryptoService } from '../../../infra/crypto/crypto.service';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { PromptService } from '../prompt/prompt.service';
import { ReportService, type CreateReportInput } from './report.service';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const REPORT_ID = 'report-1';
const PROFILE_ID = 'profile-1';
const PAID_CONTENT = '这是付费段的正文，未解锁时绝不能下发到客户端。';

const createInput = (overrides: Partial<CreateReportInput> = {}): CreateReportInput => ({
  userId: USER_ID,
  type: 'MBTI_REPORT',
  ...overrides,
});

interface Harness {
  service: ReportService;
  prisma: {
    personalityProfile: { findFirst: jest.Mock; findMany: jest.Mock };
    aiReport: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; findFirst: jest.Mock };
    reportSection: { findMany: jest.Mock };
    systemConfig: { findMany: jest.Mock };
  };
  queue: { add: jest.Mock };
  prompts: { getTemplateMeta: jest.Mock };
}

/**
 * 详情页要用的**人格画像行**（`getDetail` 的 select 形状）
 *
 * ⚠ 与 Prisma 的 select 逐字段对齐：`buildProfileSnapshot` 直接消费这些字段，
 * 少一个就是 `NaN` 宽度条或 `undefined` 字段混进响应 —— 这类错在 mock 里
 * 不会报错，只会在真机上表现成"条形图不显示"。
 */
const PERSONALITY_PROFILE_ROW = {
  mbtiType: 'INFJ',
  engineVersion: '1.0.0',
  mbtiConfidence: 0.82,
  eiPercent: 38,
  snPercent: 24,
  tfPercent: 71,
  jpPercent: 66,
  openness: 78,
  conscientiousness: 64,
  extraversion: 32,
  agreeableness: 70,
  neuroticism: 45,
  consistencyScore: 88,
};

/** 详情页要用的**情感画像行** */
const EMOTION_PROFILE_ROW = {
  attachmentStyle: 'ANXIOUS',
  attachmentAnxiety: 52.38,
  attachmentAvoidance: 0,
  loveLanguageScores: { LOVE_TIME: 62.07, LOVE_GIFTS: 6.25, LOVE_TOUCH: 63.16, LOVE_WORDS: 60, LOVE_SERVICE: 4.55 },
  primaryLoveLanguages: ['LOVE_TOUCH', 'LOVE_TIME'],
  conflictStyle: 'CONFLICT_COLLABORATING',
  conflictScores: {
    CONFLICT_AVOIDING: 0,
    CONFLICT_COMPETING: 20,
    CONFLICT_COMPROMISING: 20,
    CONFLICT_ACCOMMODATING: 50,
    CONFLICT_COLLABORATING: 100,
  },
  completionRate: 100,
  consistencyScore: 100,
};

const createHarness = (): Harness => {
  const prisma = {
    personalityProfile: {
      findFirst: jest.fn().mockResolvedValue({ id: PROFILE_ID, version: 3, engineVersion: '1.0.0' }),
      // 成长报告用：默认给两版（够创建），各用例按需覆盖
      findMany: jest.fn().mockResolvedValue([{ id: 'profile-v2' }, { id: PROFILE_ID }]),
    },
    aiReport: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: REPORT_ID }),
      update: jest.fn().mockResolvedValue({ id: REPORT_ID }),
      findFirst: jest.fn().mockResolvedValue({
        id: REPORT_ID,
        type: 'MBTI_REPORT',
        status: 'SUCCEEDED',
        title: 'INFJ 提倡者 深度解读',
        summary: '引言',
        sectionCount: 2,
        createdAt: new Date('2026-10-10T00:00:00.000Z'),
        generationFinishedAt: new Date('2026-10-10T00:01:00.000Z'),
        progress: 100,
        errorCode: null,
        errorMessage: null,
        profile: PERSONALITY_PROFILE_ROW,
        emotionProfile: null,
      }),
    },
    reportSection: {
      findMany: jest.fn().mockResolvedValue([
        {
          sectionKey: 'overview',
          title: '整体印象',
          content: '免费正文',
          order: 0,
          isFreePreview: true,
        },
        {
          sectionKey: 'strengths',
          title: '核心优势',
          content: PAID_CONTENT,
          order: 1,
          isFreePreview: false,
        },
      ]),
    },
    // 依恋阈值（详情页画中线用）：默认读不到 → 回落 50/50，各用例按需覆盖
    systemConfig: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const queue = { add: jest.fn().mockResolvedValue({ id: REPORT_ID }) };

  const prompts = {
    getTemplateMeta: jest.fn().mockResolvedValue({
      templateKey: 'report.mbti',
      versionId: 'ver-1',
      version: 1,
      provider: 'DEEPSEEK',
      model: 'deepseek-chat',
      temperature: 0.6,
      maxTokens: 2048,
      outputSchema: null,
    }),
  };

  // 真实的 CryptoService 只为 sha256，用一个确定性替身即可
  const crypto = {
    sha256: (value: string) => `hash(${value})`,
  } as unknown as CryptoService;

  const service = new ReportService(
    prisma as unknown as PrismaService,
    crypto,
    prompts as unknown as PromptService,
    queue as unknown as Queue,
  );

  return { service, prisma, queue, prompts };
};

const lastCreateData = (harness: Harness): Record<string, unknown> =>
  (harness.prisma.aiReport.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;

describe('ReportService.createReport', () => {
  it('新报告落库为 QUEUED 并以 reportId 作为 jobId 入队（同名 job 天然去重）', async () => {
    const harness = createHarness();

    const view = await harness.service.createReport(createInput());

    expect(view).toMatchObject({ reportId: REPORT_ID, status: 'QUEUED', isReused: false });
    expect(view.pollUrl).toBe(`/api/v1/reports/${REPORT_ID}/progress`);
    expect(lastCreateData(harness)).toMatchObject({
      userId: USER_ID,
      type: 'MBTI_REPORT',
      status: 'QUEUED',
      profileId: PROFILE_ID,
      promptTemplateKey: 'report.mbti',
      promptVersionId: 'ver-1',
    });
    expect(harness.queue.add).toHaveBeenCalledWith('generate', { reportId: REPORT_ID }, { jobId: REPORT_ID });
  });

  it('【关键】缓存命中已成功的报告时直接复用且不入队（不为同一内容付两次费）', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findUnique.mockResolvedValue({ id: 'old-report', status: 'SUCCEEDED' });

    const view = await harness.service.createReport(createInput());

    expect(view).toMatchObject({ reportId: 'old-report', isReused: true });
    expect(harness.prisma.aiReport.create).not.toHaveBeenCalled();
    expect(harness.queue.add).not.toHaveBeenCalled();
  });

  it('现有报告为失败态时重置状态而非新建（cacheKey 唯一）', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findUnique.mockResolvedValue({ id: REPORT_ID, status: 'FAILED' });

    await harness.service.createReport(createInput());

    expect(harness.prisma.aiReport.create).not.toHaveBeenCalled();
    expect(harness.prisma.aiReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cacheKey: expect.any(String) },
        data: expect.objectContaining({ status: 'QUEUED', progress: 0, errorCode: null }),
      }),
    );
    expect(harness.queue.add).toHaveBeenCalledTimes(1);
  });

  it('【关键】cacheKey 由画像版本与模板版本共同决定（二者变化即产生新报告）', async () => {
    const harness = createHarness();

    await harness.service.createReport(createInput());
    const firstKey = lastCreateData(harness).cacheKey;

    const other = createHarness();
    other.prisma.personalityProfile.findFirst.mockResolvedValue({
      id: PROFILE_ID,
      version: 4,
      engineVersion: '1.0.0',
    });
    await other.service.createReport(createInput());

    expect(lastCreateData(other).cacheKey).not.toBe(firstKey);
  });

  it('无画像时抛 40010 并给出可操作的提示（引导先测评）', async () => {
    const harness = createHarness();
    harness.prisma.personalityProfile.findFirst.mockResolvedValue(null);

    try {
      await harness.service.createReport(createInput());
      throw new Error('期望抛出错误');
    } catch (error) {
      const exception = error as { code: number; userMessage: string };
      expect(exception.code).toBe(ErrorCode.PERSONALITY_PROFILE_NOT_FOUND);
      expect(exception.userMessage).toContain('测评');
    }
    expect(harness.prisma.aiReport.create).not.toHaveBeenCalled();
  });

  it('不支持的报告类型抛 10001', async () => {
    const harness = createHarness();

    await expect(harness.service.createReport(createInput({ type: 'UNKNOWN' as never }))).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID,
    });
  });

  it('【关键】入队失败时报告标记为 FAILED 并抛出队列错误（不留"永远排队"的假象）', async () => {
    const harness = createHarness();
    harness.queue.add.mockRejectedValue(new Error('redis down'));

    await expect(harness.service.createReport(createInput())).rejects.toMatchObject({
      code: ErrorCode.QUEUE_ERROR,
    });
    expect(harness.prisma.aiReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: String(ErrorCode.QUEUE_ERROR) }),
      }),
    );
  });

  /**
   * 成长回顾报告（`GROWTH_SUMMARY`）
   *
   * 它的上下文是**画像版本序列**，因此创建侧有两条额外责任：
   *   ① 没有两次以上测评时明确报错 —— 一版画像没有"变化"可言，
   *      让模型对着一版编出成长轨迹是最糟的产物；
   *   ② `cacheKey` 必须覆盖**整个序列** —— 只哈希锚定画像的话，
   *      两个不同的序列会算出同一个 key，于是"输入变了却复用旧报告"。
   */
  describe('成长回顾报告', () => {
    /** 三版画像（按版本升序，与 `loadGrowthSequenceIds` 的返回一致） */
    const sequence = [{ id: 'profile-v1' }, { id: 'profile-v2' }, { id: PROFILE_ID }];

    it('【关键】至少两版画像才允许创建（一版没有变化可言）', async () => {
      const harness = createHarness();
      harness.prisma.personalityProfile.findMany.mockResolvedValue([{ id: PROFILE_ID }]);

      await expect(harness.service.createReport(createInput({ type: 'GROWTH_SUMMARY' }))).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
      expect(harness.prisma.aiReport.create).not.toHaveBeenCalled();
    });

    it('【关键】cacheKey 覆盖整个序列（序列不同 → key 不同，不会错误复用）', async () => {
      const first = createHarness();
      first.prisma.personalityProfile.findMany.mockResolvedValue(sequence);
      await first.service.createReport(createInput({ type: 'GROWTH_SUMMARY' }));
      const keyOfThreeVersions = lastCreateData(first).cacheKey;

      const second = createHarness();
      second.prisma.personalityProfile.findMany.mockResolvedValue([sequence[1], sequence[2]]);
      await second.service.createReport(createInput({ type: 'GROWTH_SUMMARY' }));
      const keyOfTwoVersions = lastCreateData(second).cacheKey;

      expect(keyOfThreeVersions).not.toBe(keyOfTwoVersions);
    });

    it('按"锚定版本及之前"取序列，最多 12 版、按版本降序取再反转', async () => {
      const harness = createHarness();

      await harness.service.createReport(createInput({ type: 'GROWTH_SUMMARY' }));

      expect(harness.prisma.personalityProfile.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, deletedAt: null, version: { lte: 3 } },
        orderBy: { version: 'desc' },
        take: 12,
        select: { id: true },
      });
    });

    it('成长报告绑定**锚定画像**（生成时靠它的版本号推导同一个序列）', async () => {
      const harness = createHarness();

      await harness.service.createReport(createInput({ type: 'GROWTH_SUMMARY' }));

      expect(lastCreateData(harness)).toMatchObject({
        type: 'GROWTH_SUMMARY',
        profileId: PROFILE_ID,
        promptTemplateKey: 'report.growth',
      });
    });

    it('非成长报告不查序列（避免给每条创建路径多加一次查询）', async () => {
      const harness = createHarness();

      await harness.service.createReport(createInput());

      expect(harness.prisma.personalityProfile.findMany).not.toHaveBeenCalled();
    });
  });
});

describe('ReportService.getProgress', () => {
  it('返回进度与时间信息', async () => {
    const harness = createHarness();

    const view = await harness.service.getProgress(USER_ID, REPORT_ID);

    expect(view).toMatchObject({ reportId: REPORT_ID, status: 'SUCCEEDED', progress: 100 });
    expect(view.finishedAt).toBe('2026-10-10T00:01:00.000Z');
  });

  it('查询时限定归属用户', async () => {
    const harness = createHarness();

    await harness.service.getProgress(USER_ID, REPORT_ID);

    expect(harness.prisma.aiReport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: REPORT_ID, userId: USER_ID, deletedAt: null } }),
    );
  });

  it('【关键】不存在或不属于当前用户时返回同一错误码（不确认 id 是否存在）', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findFirst.mockResolvedValue(null);

    await expect(harness.service.getProgress(USER_ID, REPORT_ID)).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_NOT_FOUND,
    });
  });
});

describe('ReportService.getDetail', () => {
  const locked = { allUnlocked: false, unlockedSectionKeys: new Set<string>() };
  const unlocked = { allUnlocked: true, unlockedSectionKeys: new Set<string>() };

  it('【关键】未解锁段落不下发正文，且整个响应不含付费内容', async () => {
    const harness = createHarness();

    const view = await harness.service.getDetail(USER_ID, REPORT_ID, locked);

    expect(view.sections[0].content).toBe('免费正文');
    expect(view.sections[1].content).toBeNull();
    expect(JSON.stringify(view)).not.toContain(PAID_CONTENT);
    expect(view.visibility).toMatchObject({ totalSections: 2, unlockedSections: 1, lockedSections: 1 });
  });

  it('整体解锁时全部下发', async () => {
    const harness = createHarness();

    const view = await harness.service.getDetail(USER_ID, REPORT_ID, unlocked);

    expect(view.sections.every((section) => section.content !== null)).toBe(true);
    expect(view.visibility.isFullyUnlocked).toBe(true);
  });

  it('生成中时返回 50017（前端据此继续轮询）', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findFirst.mockResolvedValue({
      id: REPORT_ID,
      type: 'MBTI_REPORT',
      status: 'GENERATING',
      title: null,
      summary: null,
      sectionCount: 0,
      createdAt: new Date(),
      generationFinishedAt: null,
    });

    await expect(harness.service.getDetail(USER_ID, REPORT_ID, locked)).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_GENERATING,
    });
  });

  it('生成失败时返回 50018', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findFirst.mockResolvedValue({
      id: REPORT_ID,
      type: 'MBTI_REPORT',
      status: 'FAILED',
      title: null,
      summary: null,
      sectionCount: 0,
      createdAt: new Date(),
      generationFinishedAt: new Date(),
    });

    await expect(harness.service.getDetail(USER_ID, REPORT_ID, locked)).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_GENERATION_FAILED,
    });
  });

  it('【关键】一段都不可读时抛 50019，不下发空壳报告', async () => {
    const harness = createHarness();
    harness.prisma.reportSection.findMany.mockResolvedValue([
      { sectionKey: 'a', title: 'A', content: '正文', order: 0, isFreePreview: false },
    ]);

    await expect(harness.service.getDetail(USER_ID, REPORT_ID, locked)).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_NOT_UNLOCKED,
    });
  });

  it('报告不存在时抛 50016', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findFirst.mockResolvedValue(null);

    await expect(harness.service.getDetail(USER_ID, REPORT_ID, locked)).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_NOT_FOUND,
    });
  });

  /**
   * 画像快照（详情页画条形图用）
   *
   * 用户的实测反馈是「点开一看全是字，我是用户我看都不想看」——
   * 而这份报告本来就有数字（焦虑轴 52、身体的接触 63……），只是全埋在正文里。
   * 快照把这些**生成报告时用的画像数值**结构化下发，前端才能画出来。
   *
   * 这一组盯住三件事：**按报告类型取哪份画像**、**取不到就给 null 不编造**、
   * 以及**它绝不能绕过付费墙**（快照里不含任何段落正文）。
   */
  describe('画像快照（profileSnapshot）', () => {
    it('人格报告 → PERSONALITY：四维与大五逐字段对齐，供前端画条', async () => {
      const harness = createHarness();

      const view = await harness.service.getDetail(USER_ID, REPORT_ID, locked);

      expect(view.profileSnapshot).toMatchObject({
        kind: 'PERSONALITY',
        mbtiType: 'INFJ',
        mbtiConfidence: 0.82,
        dimensions: { EI: 38, SN: 24, TF: 71, JP: 66 },
        bigFive: { openness: 78, conscientiousness: 64, extraversion: 32, agreeableness: 70, neuroticism: 45 },
        consistencyScore: 88,
      });
    });

    it('情感报告 → EMOTION：两轴 + 五项爱语 + 五种冲突 + 确定性结论', async () => {
      const harness = createHarness();
      harness.prisma.aiReport.findFirst.mockResolvedValue({
        id: REPORT_ID,
        type: 'EMOTION_REPORT',
        status: 'SUCCEEDED',
        title: '情感测评报告｜焦虑型依恋',
        summary: '引言',
        sectionCount: 2,
        createdAt: new Date('2026-10-10T00:00:00.000Z'),
        generationFinishedAt: new Date('2026-10-10T00:01:00.000Z'),
        profile: null,
        emotionProfile: EMOTION_PROFILE_ROW,
      });

      const view = await harness.service.getDetail(USER_ID, REPORT_ID, locked);
      const snapshot = view.profileSnapshot;

      expect(snapshot).toMatchObject({
        kind: 'EMOTION',
        attachmentStyle: 'ANXIOUS',
        attachmentAnxiety: 52.38,
        attachmentAvoidance: 0,
        primaryLoveLanguages: ['LOVE_TOUCH', 'LOVE_TIME'],
        conflictStyle: 'CONFLICT_COLLABORATING',
      });

      if (snapshot?.kind !== 'EMOTION') throw new Error('期望情感快照');

      // JSONB 列经 `parseScoreMap` 收窄后仍逐项保留
      expect(snapshot.loveLanguageScores['LOVE_TOUCH']).toBe(63.16);
      expect(snapshot.conflictScores['CONFLICT_COLLABORATING']).toBe(100);
      // 结论与结果页**同一个纯函数**：同一份画像必须得到同一段话
      expect(snapshot.conclusion.headline).toContain('被冷落');
      expect(snapshot.conclusion.needs).toContain('身体的接触');
      expect(snapshot.conclusion.suggestions.length).toBeGreaterThanOrEqual(3);
    });

    it('阈值：配置有值时用配置，读不到时回落 50/50（与引擎口径一致）', async () => {
      const strict = createHarness();
      strict.prisma.aiReport.findFirst.mockResolvedValue({
        id: REPORT_ID,
        type: 'EMOTION_REPORT',
        status: 'SUCCEEDED',
        title: null,
        summary: null,
        sectionCount: 2,
        createdAt: new Date(),
        generationFinishedAt: new Date(),
        profile: null,
        emotionProfile: EMOTION_PROFILE_ROW,
      });
      strict.prisma.systemConfig.findMany.mockResolvedValue([
        { key: 'attachment_threshold_anxiety', value: '60' },
        { key: 'attachment_threshold_avoidance', value: '40' },
      ]);

      const strictView = await strict.service.getDetail(USER_ID, REPORT_ID, locked);

      expect(strictView.profileSnapshot?.kind === 'EMOTION' && strictView.profileSnapshot.thresholds).toEqual({
        anxiety: 60,
        avoidance: 40,
      });

      // 默认 harness 的 systemConfig 返回空数组 → 兜底
      const fallback = createHarness();
      fallback.prisma.aiReport.findFirst.mockResolvedValue({
        id: REPORT_ID,
        type: 'EMOTION_REPORT',
        status: 'SUCCEEDED',
        title: null,
        summary: null,
        sectionCount: 2,
        createdAt: new Date(),
        generationFinishedAt: new Date(),
        profile: null,
        emotionProfile: EMOTION_PROFILE_ROW,
      });

      const fallbackView = await fallback.service.getDetail(USER_ID, REPORT_ID, locked);

      expect(fallbackView.profileSnapshot?.kind === 'EMOTION' && fallbackView.profileSnapshot.thresholds).toEqual({
        anxiety: 50,
        avoidance: 50,
      });
    });

    it('【关键】没有挂画像时返回 null（关系/成长报告本来就没有单一画像，不许编造）', async () => {
      const harness = createHarness();
      harness.prisma.aiReport.findFirst.mockResolvedValue({
        id: REPORT_ID,
        type: 'RELATIONSHIP_REPORT',
        status: 'SUCCEEDED',
        title: null,
        summary: null,
        sectionCount: 2,
        createdAt: new Date(),
        generationFinishedAt: new Date(),
        profile: null,
        emotionProfile: null,
      });

      const view = await harness.service.getDetail(USER_ID, REPORT_ID, locked);

      expect(view.profileSnapshot).toBeNull();
    });

    it('【关键】快照不含任何段落正文（付费墙边界不因为多下发一段元数据而松动）', async () => {
      const harness = createHarness();

      const view = await harness.service.getDetail(USER_ID, REPORT_ID, locked);

      expect(JSON.stringify(view.profileSnapshot)).not.toContain(PAID_CONTENT);
    });
  });
});
