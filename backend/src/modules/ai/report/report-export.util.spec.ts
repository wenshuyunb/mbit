/**
 * PDF 导出纯逻辑测试（契约 §3.5.8）与**渲染器缺口**的显式断言
 *
 * 最后一组用例刻意断言"渲染入口当前一定抛 `90008`"：
 * 这是本次交付唯一未完成的部分，把它写成测试而不是留一句注释，
 * 是为了让"接入渲染库"这件事必须显式改代码 + 改测试，而不会被误认为已完成。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import {
  PDF_EXPORT_DAILY_LIMIT,
  PDF_REUSE_WINDOW_MS,
  PDF_SIGNED_URL_TTL_SECONDS,
  buildPdfFileName,
  buildPdfObjectKey,
  buildWatermarkText,
  formatPdfDate,
  isExportTaskExpired,
  isReusableTask,
  isRetryableExportError,
  pdfReuseFingerprint,
  queuePositionOf,
  readBusinessErrorCode,
  type ReportExportTaskState,
} from './report-export.util';
import {
  SHARE_CARD_COMPLIANCE_TEXT,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  generateMiniAppCode,
  renderReportPdf,
  renderShareCardImage,
} from './report-render.util';

const NOW = new Date('2026-02-14T14:25:00.000Z');

const taskOf = (overrides: Partial<ReportExportTaskState> = {}): ReportExportTaskState => ({
  taskId: 'task-1',
  reportId: 'report-1',
  userId: 'user-1',
  queue: 'export.pdf',
  status: 'SUCCEEDED',
  stage: 'DONE',
  progress: 100,
  template: 'CLASSIC',
  includeCharts: true,
  includeAnswers: false,
  watermark: true,
  objectKey: 'report-pdf/user-1/report-1-classic.pdf',
  fileName: 'soulmap-report-INFJ-20260214.pdf',
  sizeBytes: 1024,
  pageCount: 14,
  generatedAt: '2026-02-14T14:25:11.000Z',
  createdAt: '2026-02-14T14:25:00.000Z',
  expiresAt: '2026-02-21T14:25:00.000Z',
  startedAt: null,
  finishedAt: '2026-02-14T14:25:11.000Z',
  errorCode: null,
  errorMessage: null,
  consumed: { entitlementId: null, windowQuota: true },
  ...overrides,
});

describe('对象键与文件名', () => {
  it('对象键落在存储策略声明的 report-pdf 前缀下，且按模板区分', () => {
    expect(buildPdfObjectKey('user-1', 'report-1', 'CLASSIC')).toBe('report-pdf/user-1/report-1-classic.pdf');
    expect(buildPdfObjectKey('user-1', 'report-1', 'MAGAZINE')).toBe('report-pdf/user-1/report-1-magazine.pdf');
  });

  it('文件名按契约示例格式；缺 MBTI 时用报告 ID 前 8 位兜底', () => {
    expect(buildPdfFileName('INFJ', '0195f3a2-b24e-7a86', new Date('2026-02-14T00:00:00.000Z'))).toBe(
      'soulmap-report-INFJ-20260214.pdf',
    );
    expect(buildPdfFileName(null, '0195f3a2-b24e-7a86', new Date('2026-02-14T00:00:00.000Z'))).toBe(
      'soulmap-report-0195f3a2-20260214.pdf',
    );
  });

  it('日期格式为 YYYYMMDD', () => {
    expect(formatPdfDate(new Date('2026-02-14T23:59:00.000Z'))).toBe('20260214');
  });
});

describe('复用与过期判定（契约规则 3/4）', () => {
  it('24h 内生成且未过期的成功任务可复用', () => {
    expect(isReusableTask(taskOf(), NOW)).toBe(true);
  });

  it('超过 24h 不再复用（即便源文件还在）', () => {
    expect(isReusableTask(taskOf(), new Date('2026-02-15T15:00:00.000Z'))).toBe(false);
    expect(PDF_REUSE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('未成功 / 无生成时间 / 已过期都不可复用', () => {
    expect(isReusableTask(taskOf({ status: 'FAILED' }), NOW)).toBe(false);
    expect(isReusableTask(taskOf({ generatedAt: null }), NOW)).toBe(false);
    expect(isReusableTask(taskOf(), new Date('2026-02-22T00:00:00.000Z'))).toBe(false);
  });

  it('任务过期按 expiresAt 判定（源文件 7 天）', () => {
    expect(isExportTaskExpired(taskOf(), NOW)).toBe(false);
    expect(isExportTaskExpired(taskOf(), new Date('2026-02-22T00:00:00.000Z'))).toBe(true);
  });

  it('签名 URL 有效期 24h、每日上限 5 次（契约数值）', () => {
    expect(PDF_SIGNED_URL_TTL_SECONDS).toBe(86_400);
    expect(PDF_EXPORT_DAILY_LIMIT).toBe(5);
  });
});

describe('复用指纹与队列位置', () => {
  it('任一渲染参数变化都会改变指纹（否则会复用出"参数不符"的旧文件）', () => {
    const base = {
      reportId: 'report-1',
      template: 'CLASSIC' as const,
      includeCharts: true,
      includeAnswers: false,
      watermark: true,
    };

    const fingerprints = new Set([
      pdfReuseFingerprint(base),
      pdfReuseFingerprint({ ...base, template: 'MAGAZINE' }),
      pdfReuseFingerprint({ ...base, includeCharts: false }),
      pdfReuseFingerprint({ ...base, includeAnswers: true }),
      pdfReuseFingerprint({ ...base, watermark: false }),
    ]);

    expect(fingerprints.size).toBe(5);
  });

  it('队列位置至少为 1', () => {
    expect(queuePositionOf(0)).toBe(1);
    expect(queuePositionOf(3)).toBe(4);
  });
});

describe('水印与错误处理', () => {
  it('水印含昵称与生成日期，且**不含手机号等敏感信息的形态**', () => {
    const text = buildWatermarkText('小明', new Date('2026-02-14T00:00:00.000Z'));

    expect(text).toBe('小明 · 2026-02-14 · 仅供个人参考');
    expect(text).not.toMatch(/\d{11}/);
  });

  it('无昵称时用兜底称呼而不是空白', () => {
    expect(buildWatermarkText(null, new Date('2026-02-14T00:00:00.000Z'))).toContain('SoulMap 用户');
  });

  it('只有基础设施类错误值得重试（配置缺失与内容问题重试无意义）', () => {
    expect(isRetryableExportError(ErrorCode.FILE_UPLOAD_FAILED)).toBe(true);
    expect(isRetryableExportError(ErrorCode.CONFIG_MISSING)).toBe(false);
    expect(isRetryableExportError(ErrorCode.AI_OUTPUT_INVALID)).toBe(false);
  });

  it('能从普通 Error 之外的结构里取出错误码（不依赖 instanceof）', () => {
    expect(readBusinessErrorCode({ code: 80002 })).toBe(80002);
    expect(readBusinessErrorCode({ code: '90004' })).toBe(90004);
    expect(readBusinessErrorCode(new Error('boom'))).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

describe('【关键】渲染器缺口（本次交付唯一未完成的部分）', () => {
  it('PDF 渲染入口当前抛 90008，绝不返回占位文件', async () => {
    await expect(
      renderReportPdf({
        reportId: 'report-1',
        title: '标题',
        mbtiType: 'INFJ',
        mbtiTypeName: '提倡者',
        engineVersion: 'pe-v1.0.0',
        template: 'CLASSIC',
        includeCharts: true,
        includeAnswers: false,
        watermark: true,
        watermarkText: '小明 · 2026-02-14',
        generatedAt: new Date('2026-02-14T00:00:00.000Z'),
        disclaimer: 'AI 内容仅供参考',
        sections: [{ title: '核心画像', content: null, order: 1 }],
        dimensions: null,
        bigFive: null,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFIG_MISSING });
  });

  it('分享卡渲染入口当前抛 90008，绝不返回占位图', async () => {
    await expect(
      renderShareCardImage({
        reportId: 'report-1',
        template: 'TYPE_CARD',
        mbtiType: 'INFJ',
        mbtiTypeName: '提倡者',
        displayName: '一位 INFJ',
        quote: null,
        dimensions: null,
        bigFive: null,
        qrCodeImage: null,
        complianceText: SHARE_CARD_COMPLIANCE_TEXT,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFIG_MISSING });
  });

  it('小程序码入口按契约"失败降级"返回 null（不阻断分享）', async () => {
    await expect(generateMiniAppCode({ scene: 'report_0195f3a2', pagePath: '/pages/index/index' })).resolves.toBeNull();
  });

  it('分享卡规格与合规文案符合契约（750×1334 / 固定微缩文案）', () => {
    expect(SHARE_CARD_WIDTH).toBe(750);
    expect(SHARE_CARD_HEIGHT).toBe(1334);
    expect(SHARE_CARD_COMPLIANCE_TEXT).toBe('AI 内容由模型生成，仅供自我探索参考');
  });
});
