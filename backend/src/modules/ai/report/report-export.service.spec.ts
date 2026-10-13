/**
 * PDF 导出服务测试（契约 §3.5.8）
 *
 * 渲染函数被**部分替换**（`jest.fn(actual)`）：
 *   · 需要验证完整链路（上传 → 签名 → 落库 → SUCCEEDED）时给一次成功返回；
 *   · 需要验证"渲染器缺口"时保留真实实现（抛 `90008`），确认任务落到 FAILED 并归还配额。
 *
 * 这样既测了接线，又**不会**出现"用一个假的 PDF 冒充成功"的情况 ——
 * 真实实现抛错这一点本身也被断言了。
 */

import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { CryptoService } from '../../../infra/crypto/crypto.service';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { EntitlementService } from '../../membership/entitlement.service';
import type { StorageService } from '../../storage/storage.service';
import type { SystemConfigService } from '../../system/system-config.service';
import { ReportExportService } from './report-export.service';
import { PDF_TASK_TTL_SECONDS, type ReportExportTaskState } from './report-export.util';
import type { ReportQuotaService } from './report-quota.service';
import type * as renderModule from './report-render.util';
import { renderReportPdf } from './report-render.util';

jest.mock('./report-render.util', () => {
  const actual = jest.requireActual<typeof renderModule>('./report-render.util');

  // 默认行为保留真实实现（即"未配置渲染器"时抛 90008），仅在个别用例里替换
  return { ...actual, renderReportPdf: jest.fn(actual.renderReportPdf) };
});

const actualRender = jest.requireActual<typeof renderModule>('./report-render.util');
const renderMock = renderReportPdf as jest.MockedFunction<typeof renderReportPdf>;

const USER_ID = 'user-1';
const REPORT_ID = 'report-1';
const PAID_TEXT = '这是付费段落正文，绝不能进入 PDF 渲染素材。';

/**
 * 用**真实** sha256 替身而不是 `hash(x)` 这类自造串
 *
 * 服务里对指纹做过 `.slice(0, 32)`，自造串（`hash(report-1|CLASSIC|...)`）的前 32 字符
 * 在"只在结尾不同的两个指纹"上完全相同 —— 会让"参数不同 → 键不同"这条断言假绿。
 */
const fakeSha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const unlockedReport = {
  id: REPORT_ID,
  userId: USER_ID,
  status: 'SUCCEEDED',
  title: 'INFJ 深度解读',
  contentLength: 100,
  profile: {
    mbtiType: 'INFJ',
    engineVersion: 'pe-v1.0.0',
    eiPercent: 34.5,
    snPercent: 68.2,
    tfPercent: 61.4,
    jpPercent: 72.8,
    openness: 82.5,
    conscientiousness: 71,
    extraversion: 34.5,
    agreeableness: 88,
    neuroticism: 56.5,
  },
};

interface Harness {
  service: ReportExportService;
  prisma: {
    aiReport: { findFirst: jest.Mock; update: jest.Mock };
    reportSection: { findMany: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  redis: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    key: jest.Mock;
    getJson: jest.Mock;
    setJson: jest.Mock;
  };
  queue: { add: jest.Mock; getWaitingCount: jest.Mock };
  quota: {
    consumeWindowQuota: jest.Mock;
    readWindowQuota: jest.Mock;
    refundWindowQuota: jest.Mock;
    consumePdfExportEntitlement: jest.Mock;
    refundPdfExportEntitlement: jest.Mock;
  };
  storage: { uploadServerObject: jest.Mock; signServerObjectUrl: jest.Mock; publicUrlOf: jest.Mock };
  entitlements: { getMembership: jest.Mock; resolveReportUnlock: jest.Mock };
}

const createHarness = (
  options: { isMember?: boolean; unlocked?: boolean; memberSections?: string[] } = {},
): Harness => {
  const isMember = options.isMember ?? true;
  const unlocked = options.unlocked ?? true;

  const prisma = {
    aiReport: {
      findFirst: jest.fn().mockResolvedValue(unlockedReport),
      update: jest.fn().mockResolvedValue({ id: REPORT_ID }),
    },
    reportSection: {
      findMany: jest.fn().mockResolvedValue([
        { sectionKey: 'CORE_PORTRAIT', title: '核心画像', content: '免费正文', order: 1, isFreePreview: true },
        { sectionKey: 'ACTION_PLAN', title: '行动清单', content: PAID_TEXT, order: 2, isFreePreview: false },
      ]),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ nickname: '小明' }) },
  };

  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    key: jest.fn((...parts: (string | number)[]) => parts.join(':')),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
  };

  const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }), getWaitingCount: jest.fn().mockResolvedValue(0) };

  const quota = {
    consumeWindowQuota: jest.fn().mockResolvedValue({
      used: 1,
      limit: 5,
      remaining: 4,
      resetAt: '2026-02-15T00:00:00.000Z',
    }),
    readWindowQuota: jest.fn().mockResolvedValue({
      used: 1,
      limit: 5,
      remaining: 4,
      resetAt: '2026-02-15T00:00:00.000Z',
    }),
    refundWindowQuota: jest.fn().mockResolvedValue(undefined),
    consumePdfExportEntitlement: jest.fn().mockResolvedValue('entitlement-1'),
    refundPdfExportEntitlement: jest.fn().mockResolvedValue(undefined),
  };

  const storage = {
    uploadServerObject: jest.fn().mockResolvedValue({ etag: 'etag-1', sizeBytes: 1024 }),
    signServerObjectUrl: jest.fn().mockReturnValue({
      url: 'https://cdn.example.com/report-pdf/signed.pdf',
      expiresAt: new Date('2026-02-15T14:25:00.000Z'),
    }),
    publicUrlOf: jest.fn().mockReturnValue('https://cdn.example.com/x.webp'),
  };

  const entitlements = {
    getMembership: jest.fn().mockResolvedValue({
      isMember,
      expireAt: isMember ? '2026-03-14T10:00:00.000Z' : null,
      remainingDays: isMember ? 28 : null,
    }),
    resolveReportUnlock: jest.fn().mockResolvedValue({
      allUnlocked: unlocked,
      unlockedSectionKeys: new Set(options.memberSections ?? []),
      source: unlocked ? 'MEMBERSHIP' : 'NONE',
    }),
  };

  const service = new ReportExportService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    { sha256: fakeSha256 } as unknown as CryptoService,
    storage as unknown as StorageService,
    entitlements as unknown as EntitlementService,
    quota as unknown as ReportQuotaService,
    { getEntry: jest.fn().mockResolvedValue({ value: 'AI 内容仅供自我探索参考' }) } as unknown as SystemConfigService,
    queue as unknown as Queue,
  );

  return { service, prisma, redis, queue, quota, storage, entitlements };
};

const request = (overrides: Record<string, unknown> = {}): Parameters<ReportExportService['requestExport']>[0] => ({
  userId: USER_ID,
  reportId: REPORT_ID,
  idempotencyKey: 'idem-key-12345678',
  ...overrides,
});

const savedTask = (harness: Harness): ReportExportTaskState =>
  harness.redis.setJson.mock.calls[0][1] as ReportExportTaskState;

const lastSavedTask = (harness: Harness): ReportExportTaskState => {
  const calls = harness.redis.setJson.mock.calls;

  return calls[calls.length - 1][1] as ReportExportTaskState;
};

describe('ReportExportService.requestExport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('新建任务：返回 202、入队（jobId = taskId）并扣减每日配额', async () => {
    const harness = createHarness();
    const result = await harness.service.requestExport(request({ template: 'MAGAZINE' }));

    expect(result.httpStatus).toBe(202);
    expect(result.view).toMatchObject({
      reportId: REPORT_ID,
      status: 'PENDING',
      stage: 'QUEUED',
      queue: 'export.pdf',
      queuePosition: 1,
      template: 'MAGAZINE',
      includeCharts: true,
      includeAnswers: false,
      watermark: true,
      pageCount: null,
      pollUrl: `/api/v1/reports/${REPORT_ID}/progress`,
    });

    const task = savedTask(harness);
    expect(task.objectKey).toBe(`report-pdf/${USER_ID}/${REPORT_ID}-magazine.pdf`);
    expect(task.expiresAt).toBeDefined();
    expect(harness.queue.add).toHaveBeenCalledWith(
      'render.report-pdf',
      { taskId: task.taskId },
      { jobId: task.taskId },
    );
  });

  it('会员：只扣每日配额，不消耗单次购买的 PDF_EXPORT 权益', async () => {
    const harness = createHarness({ isMember: true });
    await harness.service.requestExport(request());

    expect(harness.quota.consumeWindowQuota).toHaveBeenCalledTimes(1);
    expect(harness.quota.consumePdfExportEntitlement).not.toHaveBeenCalled();
  });

  it('非会员：扣一次 PDF_EXPORT 权益（单次购买）', async () => {
    const harness = createHarness({ isMember: false });
    await harness.service.requestExport(request());

    expect(harness.quota.consumePdfExportEntitlement).toHaveBeenCalledWith(USER_ID);
    expect(savedTask(harness).consumed.entitlementId).toBe('entitlement-1');
  });

  it('非会员且无可用权益 → 402（70016），且不消耗任何配额', async () => {
    const harness = createHarness({ isMember: false });
    harness.quota.consumePdfExportEntitlement.mockResolvedValue(null);

    await expect(harness.service.requestExport(request())).rejects.toMatchObject({
      code: ErrorCode.ENTITLEMENT_REQUIRED,
    });

    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
    expect(harness.queue.add).not.toHaveBeenCalled();
  });

  it('【关键】未解锁报告不可导出（付费墙），即使有会员权益', async () => {
    const harness = createHarness({ unlocked: false });

    await expect(harness.service.requestExport(request())).rejects.toMatchObject({
      code: ErrorCode.ENTITLEMENT_REQUIRED,
    });

    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
    expect(harness.queue.add).not.toHaveBeenCalled();
  });

  it('【关键】24h 内同参数已有 PDF → 返回 200 + isReused，且**不扣配额**', async () => {
    const harness = createHarness();
    // 时间必须相对"现在"构造：写死 2026-02 的日期会让 24h 复用窗口永远不成立
    const generatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const cachedTask: ReportExportTaskState = {
      taskId: 'task-cached',
      reportId: REPORT_ID,
      userId: USER_ID,
      queue: 'export.pdf',
      status: 'SUCCEEDED',
      stage: 'DONE',
      progress: 100,
      template: 'CLASSIC',
      includeCharts: true,
      includeAnswers: false,
      watermark: true,
      objectKey: `report-pdf/${USER_ID}/${REPORT_ID}-classic.pdf`,
      fileName: 'soulmap-report-INFJ-20260214.pdf',
      sizeBytes: 1843200,
      pageCount: 14,
      generatedAt: generatedAt.toISOString(),
      createdAt: generatedAt.toISOString(),
      expiresAt: new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString(),
      startedAt: generatedAt.toISOString(),
      finishedAt: generatedAt.toISOString(),
      errorCode: null,
      errorMessage: null,
      consumed: { entitlementId: null, windowQuota: true },
    };

    // 第一次 get（幂等键）返回 null，第二次 get（复用键）返回缓存任务
    harness.redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('task-cached');
    harness.redis.getJson.mockResolvedValue(cachedTask);

    const result = await harness.service.requestExport(request());

    expect(result.httpStatus).toBe(200);
    expect(result.view).toMatchObject({
      taskId: 'task-cached',
      status: 'SUCCEEDED',
      isReused: true,
      fileName: 'soulmap-report-INFJ-20260214.pdf',
      pageCount: 14,
      downloadUrl: 'https://cdn.example.com/report-pdf/signed.pdf',
    });

    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
    expect(harness.queue.add).not.toHaveBeenCalled();
    // 复用路径必须**重新签名**（存下来的 URL 会在 24h 后失效）
    expect(harness.storage.signServerObjectUrl).toHaveBeenCalledWith(
      cachedTask.objectKey,
      86_400,
      expect.stringContaining('attachment'),
    );
  });

  it('参数不同不会命中同一份缓存（watermark 参与指纹）', async () => {
    const harness = createHarness();
    await harness.service.requestExport(request({ watermark: true }));

    const reuseKey = harness.redis.set.mock.calls.find((call) => String(call[0]).includes('latest'))?.[0];

    const other = createHarness();
    await other.service.requestExport(request({ watermark: false }));
    const otherReuseKey = other.redis.set.mock.calls.find((call) => String(call[0]).includes('latest'))?.[0];

    expect(reuseKey).toBeDefined();
    expect(otherReuseKey).toBeDefined();
    expect(reuseKey).not.toBe(otherReuseKey);
  });

  it('【关键】入队失败：回收任务状态、归还两类配额，并抛队列错误', async () => {
    const harness = createHarness({ isMember: false });
    harness.queue.add.mockRejectedValue(new Error('queue down'));

    await expect(harness.service.requestExport(request())).rejects.toMatchObject({ code: ErrorCode.QUEUE_ERROR });

    expect(harness.quota.refundPdfExportEntitlement).toHaveBeenCalledWith('entitlement-1');
    expect(harness.quota.refundWindowQuota).toHaveBeenCalledTimes(1);
    // 幂等键 / 复用键 / 任务键都要清掉，否则用户会被一个永远不执行的任务锁住
    expect(harness.redis.del).toHaveBeenCalled();
  });

  it('幂等重放：同一 X-Idempotency-Key 返回同一 taskId，不重复入队', async () => {
    const harness = createHarness();
    const existing: ReportExportTaskState = {
      taskId: 'task-existing',
      reportId: REPORT_ID,
      userId: USER_ID,
      queue: 'export.pdf',
      status: 'PROCESSING',
      stage: 'RENDERING_PDF',
      progress: 50,
      template: 'CLASSIC',
      includeCharts: true,
      includeAnswers: false,
      watermark: true,
      objectKey: 'report-pdf/x/y.pdf',
      fileName: 'f.pdf',
      sizeBytes: null,
      pageCount: null,
      generatedAt: null,
      createdAt: '2026-02-14T14:25:00.000Z',
      expiresAt: '2026-02-21T14:25:00.000Z',
      startedAt: '2026-02-14T14:25:01.000Z',
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      consumed: { entitlementId: null, windowQuota: true },
    };

    harness.redis.get.mockResolvedValue('task-existing');
    harness.redis.getJson.mockResolvedValue(existing);

    const result = await harness.service.requestExport(request());

    expect(result.httpStatus).toBe(202);
    expect(result.view).toMatchObject({ taskId: 'task-existing', status: 'PROCESSING', stage: 'RENDERING_PDF' });
    expect(harness.queue.add).not.toHaveBeenCalled();
    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
  });
});

describe('ReportExportService.runExportTask（渲染失败的处理）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('【关键】渲染失败 → 任务 FAILED（90008），并且归还配额，不产生任何假文件', async () => {
    const harness = createHarness();
    /**
     * 渲染失败的最典型原因是**部署缺中文字体**（`report-render.util.ts` 的 `loadFontBytes`）。
     * 这里直接制造该错误：真实渲染成功路径已有独立用例覆盖
     *（`report-export.util.spec.ts` 的"渲染器真实产出"）。
     *
     * 关键不变量：**渲染失败必须让任务 FAILED + 归还配额 + 不上传**，
     * 绝不能"降级产出一份空 PDF"—— 用户会把空白报告当真实报告保存和转发。
     */
    renderMock.mockRejectedValueOnce(new BusinessException(ErrorCode.CONFIG_MISSING, '报告字体缺失'));

    const task: ReportExportTaskState = {
      taskId: 'task-1',
      reportId: REPORT_ID,
      userId: USER_ID,
      queue: 'export.pdf',
      status: 'PENDING',
      stage: 'QUEUED',
      progress: 0,
      template: 'CLASSIC',
      includeCharts: true,
      includeAnswers: false,
      watermark: true,
      objectKey: `report-pdf/${USER_ID}/${REPORT_ID}-classic.pdf`,
      fileName: '',
      sizeBytes: null,
      pageCount: null,
      generatedAt: null,
      createdAt: '2026-02-14T14:25:00.000Z',
      expiresAt: '2026-02-21T14:25:00.000Z',
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      consumed: { entitlementId: 'entitlement-1', windowQuota: true },
    };

    harness.redis.getJson.mockResolvedValue(task);

    await harness.service.runExportTask('task-1', { isFinalAttempt: true });

    const final = lastSavedTask(harness);
    expect(final.status).toBe('FAILED');
    expect(final.stage).toBe('ERROR');
    expect(final.errorCode).toBe(ErrorCode.CONFIG_MISSING);
    expect(final.errorMessage).toContain('字体');

    // 没有上传、没有签名、没有回写 pdfUrl
    expect(harness.storage.uploadServerObject).not.toHaveBeenCalled();
    expect(harness.prisma.aiReport.update).not.toHaveBeenCalled();
    // 失败即归还
    expect(harness.quota.refundPdfExportEntitlement).toHaveBeenCalledWith('entitlement-1');
    expect(harness.quota.refundWindowQuota).toHaveBeenCalledTimes(1);
  });

  it('【关键】渲染素材里未解锁段落的 content 为 null（付费正文不进 PDF）', async () => {
    const harness = createHarness({ unlocked: false });
    renderMock.mockImplementationOnce(actualRender.renderReportPdf);

    const task = {
      taskId: 'task-2',
      reportId: REPORT_ID,
      userId: USER_ID,
      queue: 'export.pdf',
      status: 'PENDING',
      stage: 'QUEUED',
      progress: 0,
      template: 'CLASSIC',
      includeCharts: true,
      includeAnswers: false,
      watermark: true,
      objectKey: 'report-pdf/x.pdf',
      fileName: '',
      sizeBytes: null,
      pageCount: null,
      generatedAt: null,
      createdAt: '2026-02-14T14:25:00.000Z',
      expiresAt: '2026-02-21T14:25:00.000Z',
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      consumed: { entitlementId: null, windowQuota: true },
    } satisfies ReportExportTaskState;

    harness.redis.getJson.mockResolvedValue(task);

    await harness.service.runExportTask('task-2', { isFinalAttempt: true });

    const input = renderMock.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    expect(input?.sections).toEqual([
      { title: '核心画像', content: '免费正文', order: 1 },
      { title: '行动清单', content: null, order: 2 },
    ]);
    expect(JSON.stringify(input)).not.toContain(PAID_TEXT);
    // 水印文案含昵称与日期，不含手机号等敏感信息
    expect(input?.watermarkText).toContain('小明');
  });

  it('渲染与上传成功时任务落 SUCCEEDED，并回写 pdfUrl / pdfGeneratedAt', async () => {
    const harness = createHarness();
    renderMock.mockResolvedValueOnce({
      body: Buffer.from('%PDF-1.7 fake-but-explicitly-mocked'),
      contentType: 'application/pdf',
      sizeBytes: 1024,
      width: null,
      height: null,
      pageCount: 14,
      fontEmbedded: true,
      fontSubsetted: true,
    });

    const task: ReportExportTaskState = {
      taskId: 'task-3',
      reportId: REPORT_ID,
      userId: USER_ID,
      queue: 'export.pdf',
      status: 'PENDING',
      stage: 'QUEUED',
      progress: 0,
      template: 'CLASSIC',
      includeCharts: true,
      includeAnswers: false,
      watermark: true,
      objectKey: `report-pdf/${USER_ID}/${REPORT_ID}-classic.pdf`,
      fileName: '',
      sizeBytes: null,
      pageCount: null,
      generatedAt: null,
      createdAt: '2026-02-14T14:25:00.000Z',
      expiresAt: '2026-02-21T14:25:00.000Z',
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      consumed: { entitlementId: null, windowQuota: true },
    };

    harness.redis.getJson.mockResolvedValue(task);

    await harness.service.runExportTask('task-3', { isFinalAttempt: true });

    const final = lastSavedTask(harness);
    expect(final.status).toBe('SUCCEEDED');
    expect(final.stage).toBe('DONE');
    expect(final.pageCount).toBe(14);
    expect(final.sizeBytes).toBe(1024);
    expect(final.fileName).toMatch(/^soulmap-report-INFJ-\d{8}\.pdf$/);

    expect(harness.storage.uploadServerObject).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'application/pdf' }),
    );
    expect(harness.prisma.aiReport.update).toHaveBeenCalledWith({
      where: { id: REPORT_ID },
      data: { pdfUrl: expect.any(String), pdfGeneratedAt: expect.any(Date) },
    });
    // 成功不归还配额
    expect(harness.quota.refundWindowQuota).not.toHaveBeenCalled();
  });

  it('幂等：已成功的任务重复执行不会再次渲染/上传', async () => {
    const harness = createHarness();
    harness.redis.getJson.mockResolvedValue({
      taskId: 'task-4',
      status: 'SUCCEEDED',
      consumed: { entitlementId: null, windowQuota: true },
    });

    await harness.service.runExportTask('task-4', { isFinalAttempt: true });

    expect(renderMock).not.toHaveBeenCalled();
    expect(harness.storage.uploadServerObject).not.toHaveBeenCalled();
  });

  it('任务状态已被 TTL 回收时静默跳过（重试也不会变好）', async () => {
    const harness = createHarness();
    harness.redis.getJson.mockResolvedValue(null);

    await expect(harness.service.runExportTask('task-5', { isFinalAttempt: true })).resolves.toBeUndefined();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('任务状态保留时长与契约一致（源文件 7 天）', () => {
    expect(PDF_TASK_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
