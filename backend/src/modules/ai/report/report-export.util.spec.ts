/**
 * PDF 导出纯逻辑测试（契约 §3.5.8）与**渲染器真实产出**的断言
 *
 * 最后一组用例此前刻意断言"渲染入口一定抛 `90008`"（当时确实没接渲染库）。
 * 2026-10-13 接入 `pdf-lib` + `@napi-rs/canvas` 后，那组断言已改为
 * **验证真实产物**：产出的必须是真的 PDF / 真的图片，而不是"不抛错就算过"。
 * 唯一保留的失败路径是**字体缺失** —— 它必须仍然抛 `90008`，
 * 因为"配置不全"和"渲染成功"绝不能混为一谈（静默产出方块报告是更严重的错误）。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import * as nodeFs from 'node:fs';
import type { PDFFont } from 'pdf-lib';
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
  renderReportPdf,
  renderShareCardImage,
  resetFontCache,
  stripMarkdown,
  wrapText,
  type PdfRenderInput,
} from './report-render.util';

/**
 * 只替换 `existsSync`：用于模拟"部署包里没有字体"。
 * 其余 fs 能力保持真实 —— 下面的用例要真的读字体文件来做宽度度量。
 */
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof nodeFs>('node:fs');

  return { ...actual, existsSync: jest.fn(actual.existsSync) };
});

const fsExistsMock = nodeFs.existsSync as unknown as jest.Mock;

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

/** 渲染入参基线：正文一段解锁 + 一段未解锁，正好覆盖付费墙分支 */
const pdfInputOf = (overrides: Partial<PdfRenderInput> = {}): PdfRenderInput => ({
  reportId: 'report-1',
  title: '人格深度报告',
  mbtiType: 'INFJ',
  mbtiTypeName: '提倡者',
  engineVersion: 'pe-v1.0.0',
  template: 'CLASSIC',
  includeCharts: true,
  includeAnswers: false,
  watermark: true,
  watermarkText: '小明 · 2026-02-14',
  generatedAt: new Date('2026-02-14T00:00:00.000Z'),
  disclaimer: 'AI 内容由模型生成，仅供自我探索参考',
  sections: [
    { title: '核心画像', content: '你倾向于先确认一件事是否对味，再决定投入多少。', order: 1 },
    { title: '关系模式', content: null, order: 2 },
  ],
  dimensions: { EI: 40, SN: 62, TF: 55, JP: 71 },
  bigFive: { openness: 78, conscientiousness: 61, extraversion: 44, agreeableness: 72, neuroticism: 38 },
  ...overrides,
});

describe('渲染器真实产出（契约 §3.5.8 / §3.5.9）', () => {
  it('【关键】PDF 渲染产出**真的是 PDF**（文件头、字节数、页数都对）', async () => {
    const artifact = await renderReportPdf(pdfInputOf());

    expect(artifact.contentType).toBe('application/pdf');
    expect(artifact.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(artifact.sizeBytes).toBe(artifact.body.length);
    expect(artifact.sizeBytes).toBeGreaterThan(2000);
    expect(artifact.pageCount).toBeGreaterThanOrEqual(1);
    // PDF 的宽高是 null（页尺寸在文档内部，不在产物描述里）
    expect(artifact.width).toBeNull();
    expect(artifact.height).toBeNull();
    /**
     * 【关键】必须内嵌字体，且必须是子集
     *
     * 没内嵌字体的 PDF 在缺中文字体的阅读器上显示成方块 —— 而那时用户已经拿到
     * 一份"成功生成"的文件了。渲染器内部对这一点有硬闸门（`assertFontEmbedded`），
     * 这里再从产物元数据上守住它，防止有人把 `subset` 关掉或换掉嵌入方式。
     */
    expect(artifact.fontEmbedded).toBe(true);
    expect(artifact.fontSubsetted).toBe(true);
  });

  it('未解锁分段**不画正文**：同一份输入把该段解锁后，PDF 会明显变大', async () => {
    const locked = await renderReportPdf(pdfInputOf());
    const unlocked = await renderReportPdf(
      pdfInputOf({
        sections: [
          { title: '核心画像', content: '你倾向于先确认一件事是否对味，再决定投入多少。', order: 1 },
          {
            title: '关系模式',
            content: '你在关系里既想靠近也想保有自己。'.repeat(40),
            order: 2,
          },
        ],
      }),
    );

    // 付费墙在导出物里必须同样生效：内容不进 PDF，体积就不会涨
    expect(unlocked.sizeBytes).toBeGreaterThan(locked.sizeBytes);
  });

  it('长正文会分页（不是把内容画到页外丢掉）', async () => {
    const artifact = await renderReportPdf(
      pdfInputOf({
        sections: [{ title: '长文', content: '这是一段用于验证分页的中文正文。'.repeat(400), order: 1 }],
      }),
    );

    expect(artifact.pageCount).toBeGreaterThan(1);
  });

  it('三种模板都能渲染（主题色不同但都必须产出合法 PDF）', async () => {
    for (const template of ['CLASSIC', 'MAGAZINE', 'MINIMAL'] as const) {
      const artifact = await renderReportPdf(pdfInputOf({ template }));

      expect(artifact.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    }
  });

  it('图表数据缺失时不崩（dimensions / bigFive 为 null 也要能出 PDF）', async () => {
    const artifact = await renderReportPdf(pdfInputOf({ dimensions: null, bigFive: null }));

    expect(artifact.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('【关键】分享卡产出**真的是图片**，且规格等于契约的 750×1334', async () => {
    const artifact = await renderShareCardImage({
      reportId: 'report-1',
      template: 'TYPE_CARD',
      mbtiType: 'INFJ',
      mbtiTypeName: '提倡者',
      displayName: '一位 INFJ',
      quote: null,
      dimensions: { EI: 40, SN: 62, TF: 55, JP: 71 },
      bigFive: null,
      qrCodeImage: null,
      complianceText: SHARE_CARD_COMPLIANCE_TEXT,
    });

    expect(artifact.width).toBe(SHARE_CARD_WIDTH);
    expect(artifact.height).toBe(SHARE_CARD_HEIGHT);
    expect(artifact.pageCount).toBeNull();
    expect(artifact.sizeBytes).toBeGreaterThan(5000);

    // WebP 或 PNG 都必须在 SHARE_CARD 的 MIME 白名单内
    const magic = artifact.body.subarray(0, 8).toString('hex');
    const isPng = magic.startsWith('89504e470d0a1a0a');
    const isWebp =
      artifact.body.subarray(0, 4).toString('ascii') === 'RIFF' &&
      artifact.body.subarray(8, 12).toString('ascii') === 'WEBP';

    expect(isPng || isWebp).toBe(true);
    expect(['image/webp', 'image/png']).toContain(artifact.contentType);
  });

  it('三种分享卡模板都能渲染', async () => {
    for (const template of ['TYPE_CARD', 'RADAR_CARD', 'QUOTE_CARD'] as const) {
      const artifact = await renderShareCardImage({
        reportId: 'report-1',
        template,
        mbtiType: 'ENFP',
        mbtiTypeName: '竞选者',
        displayName: '一位 ENFP',
        quote: '你比自己以为的更有余地。',
        dimensions: { EI: 70, SN: 30, TF: 45, JP: 25 },
        bigFive: { openness: 88, conscientiousness: 40, extraversion: 76, agreeableness: 65, neuroticism: 52 },
        qrCodeImage: null,
        complianceText: SHARE_CARD_COMPLIANCE_TEXT,
      });

      expect(artifact.sizeBytes).toBeGreaterThan(5000);
    }
  });

  it('【关键】字体缺失时仍然抛 90008 —— 绝不静默产出方块报告', async () => {
    /**
     * 把 `existsSync` 打桩为 false 来模拟"部署包里没有字体"。
     * 这是**唯一**能在不破坏工作区的前提下触发该分支的办法：
     * 真去删字体文件会让并行的其他渲染用例一起失败。
     */
    fsExistsMock.mockReturnValue(false);
    resetFontCache();

    try {
      await expect(renderReportPdf(pdfInputOf())).rejects.toMatchObject({ code: ErrorCode.CONFIG_MISSING });
    } finally {
      fsExistsMock.mockReturnValue(true);
      resetFontCache();
    }
  });

  it('分享卡规格与合规文案符合契约（750×1334 / 固定微缩文案）', () => {
    expect(SHARE_CARD_WIDTH).toBe(750);
    expect(SHARE_CARD_HEIGHT).toBe(1334);
    expect(SHARE_CARD_COMPLIANCE_TEXT).toBe('AI 内容由模型生成，仅供自我探索参考');
  });
});

/**
 * 中文排版（PDF 正文的排版质量直接决定报告"能不能读"）
 *
 * 中文没有空格，按词折行会把整段挤成一行并溢出页面；这里的用例就是守住这一点。
 */
describe('中文排版', () => {
  /** 用真实嵌入字体测量（宽度必须是真字体的度量，不能拿字符数估算） */
  const embedFontForTest = async (): Promise<PDFFont> => {
    const { PDFDocument } = await import('pdf-lib');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fontkit = require('@pdf-lib/fontkit');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);

    return pdf.embedFont(readFileSync(join(process.cwd(), 'assets', 'fonts', 'NotoSansSC-Regular.otf')), {
      subset: true,
    });
  };

  it('去掉 markdown 标记（否则正文里会印出满屏星号与井号）', () => {
    expect(stripMarkdown('## 核心画像')).toBe('核心画像');
    expect(stripMarkdown('这是**重点**内容')).toBe('这是重点内容');
    expect(stripMarkdown('`code` 片段')).toBe('code 片段');
  });

  it('【关键】长中文段落必须被折成多行，且每行都不超宽', async () => {
    const font = await embedFontForTest();
    const text = '你在关系里既想靠近也想保有自己，这种拉扯本身并不矛盾。'.repeat(6);
    const maxWidth = 300;

    const lines = wrapText(text, font, 11, maxWidth);

    // 逐字折行生效 → 一定不止一行
    expect(lines.length).toBeGreaterThan(3);

    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 11)).toBeLessThanOrEqual(maxWidth + 0.01);
    }

    // 不能丢字：所有行拼起来应当还原原文
    expect(lines.join('')).toBe(text);
  });

  it('空行被保留为段落分隔（否则整篇会挤成一块）', async () => {
    const font = await embedFontForTest();

    const lines = wrapText('第一段\n\n第二段', font, 11, 300);

    expect(lines).toEqual(['第一段', '', '第二段']);
  });

  it('ASCII 单词不会被从中间切断', async () => {
    const font = await embedFontForTest();

    const lines = wrapText('前缀随便写点什么 SoulMapConfiguration 后缀', font, 11, 120);

    expect(lines.some((line) => line.includes('SoulMapConfiguration'))).toBe(true);
  });
});
