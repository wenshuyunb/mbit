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
    personalityProfile: { findFirst: jest.Mock };
    aiReport: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; findFirst: jest.Mock };
    reportSection: { findMany: jest.Mock };
  };
  queue: { add: jest.Mock };
  prompts: { getTemplateMeta: jest.Mock };
}

const createHarness = (): Harness => {
  const prisma = {
    personalityProfile: {
      findFirst: jest.fn().mockResolvedValue({ id: PROFILE_ID, version: 3, engineVersion: '1.0.0' }),
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
});
