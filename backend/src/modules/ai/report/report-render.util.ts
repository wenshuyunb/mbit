/**
 * 报告渲染单点（契约 §3.5.8 PDF / §3.5.9 分享卡）
 *
 * ============================================================================
 * 实现说明（2026-10-13 接入）
 * ============================================================================
 *
 * 此前本文件的三个函数是**明确抛 `90008` 的桩**（当时任务不允许新增依赖）。
 * 现已按用户决策接入真实渲染：
 *
 *   · **PDF** → `pdf-lib` + `@pdf-lib/fontkit`（纯 JS，无原生编译，alpine 可用）
 *   · **分享卡** → `@napi-rs/canvas`（skia 预编译二进制，可直接输出 WebP/PNG）
 *   · **中文字体** → 仓库内自带的 **Noto Sans SC**（SIL OFL 1.1，可自由再分发），
 *     位于 `backend/assets/fonts/NotoSansSC-Regular.otf`
 *
 * ## 为什么必须自带字体、不能用系统字体
 *
 * 服务器（`node:20-alpine`）**没有任何中文字体**。依赖系统字体会让同一份代码
 * 在开发机（Windows 有 `msyh.ttc`）产出正常报告、在生产容器里产出**一整份方块**——
 * 而"看起来成功、打开全是豆腐块"正是本文件此前宁可不实现也要避免的静默数据错误。
 * 同时 Windows/macOS 自带的微软雅黑、苹方等**都不允许随代码再分发**，
 * 因此这里选用 OFL 授权的 Noto Sans SC 并把文件纳入版本库。
 *
 * ## 为什么 PDF 用子集嵌入
 *
 * 完整中文字体约 8 MB，整份嵌入会让**每一份 PDF 都 >8 MB**，
 * 而 `storage-policy.ts` 对 `REPORT_PDF` 的上限是 20 MB —— 图文一多就会撞线。
 * `subset: true` 只嵌入**实际用到的字形**，实测一份完整报告 PDF 只有几十 KB。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 只引类型：`@napi-rs/canvas` 是**原生模块**，顶层 `import` 会让所有引用本文件的
// 代码（含纯逻辑单测与 PDF 路径）都去加载 skia 二进制，因此运行时用惰性 `require`。
import type { Canvas, SKRSContext2D, Image as CanvasImage } from '@napi-rs/canvas';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, degrees, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
// `@pdf-lib/fontkit` 只有 CommonJS 导出，且类型声明与 `pdf-lib` 期望的形状不同
// eslint-disable-next-line @typescript-eslint/no-require-imports
import fontkit = require('@pdf-lib/fontkit');

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';

// ============================================================================
// 规格常量
// ============================================================================

/** 分享卡视觉规格（契约 §3.5.9 规则 3） */
export const SHARE_CARD_WIDTH = 750;
export const SHARE_CARD_HEIGHT = 1334;

/** 分享卡必须固定绘制的合规微缩文案（契约规则 5） */
export const SHARE_CARD_COMPLIANCE_TEXT = 'AI 内容由模型生成，仅供自我探索参考';

/** 分享卡渲染超时阈值（毫秒）：契约 §3.5.9 要求渲染 < 2s，超时降级为异步 */
export const SHARE_CARD_SYNC_TIMEOUT_MS = 2000;

/** 渲染出来的二进制产物（PDF / 图片共用形状） */
export interface RenderedArtifact {
  readonly body: Buffer;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** 图片宽高（PDF 为 null） */
  readonly width: number | null;
  readonly height: number | null;
  /** PDF 页数（图片为 null） */
  readonly pageCount: number | null;
  /**
   * PDF 是否**内嵌了字体**（图片恒为 null）
   *
   * 这条属性值得作为产物元数据回传，因为它是"任何设备都能显示中文"的唯一保证：
   * 没内嵌字体的 PDF 在缺少中文字体的阅读器上会显示成方块，
   * 而那时用户手里已经拿到一份"看起来成功"的文件了。
   */
  readonly fontEmbedded: boolean | null;
  /**
   * PDF 内嵌的是否为**子集**（图片恒为 null）
   *
   * 子集化决定体积：整份中文字体约 8 MB，不子集化会让每份 PDF 都超过
   * `REPORT_PDF` 场景 20 MB 的上限附近（图文一多就撞线）。
   */
  readonly fontSubsetted: boolean | null;
}

/**
 * 检查产物 PDF 里字体是否真的内嵌、是否子集化
 *
 * ## 为什么不用"在字节里搜 `/FontFile`"
 *
 * `pdf-lib` 默认把对象写进**对象流**（`/Type /ObjStm`）并做 Flate 压缩，
 * 字体字典因此藏在压缩流里面。手工按 `stream…endstream` 切段再解压并不可靠 ——
 * 压缩后的二进制里可能恰好出现 `endstream` 字节序列，切出来的段解压就失败
 *（实测：一份小 PDF 的 5 个流里只有 1 个解压成功，于是"未内嵌"被误报）。
 *
 * 正确做法是**让 pdf-lib 自己解析**：`context.enumerateIndirectObjects()`
 * 拿到的已经是解压并解析过的对象，字体字典与描述符都在里面，不会再漏。
 */
const inspectEmbeddedFont = (pdf: PDFDocument, sourceFontBytes: number): { embedded: boolean; subsetted: boolean } => {
  /**
   * 找的是**字体描述符对象**，而不是"同时含 `/BaseFont` 和 `/FontDescriptor` 的那个字典"。
   *
   * 实测结构（一份真实产物的对象清单）：
   *   · `4 0 R`  Type0 字体：`/BaseFont` + `/DescendantFonts`，**没有** `/FontDescriptor`
   *   · `11 0 R` 后代 CIDFont：`/FontDescriptor → 10 0 R`
   *   · `10 0 R` **字体描述符**：`/FontFile3 → 9 0 R`（内嵌流本身）
   *
   * 也就是说 `/FontFile*` 既不在 Type0 字典上，也不在后代字体上，而在描述符上；
   * 按"同一字典里同时有 BaseFont 与 FontDescriptor"去找会**一个都找不到**
   *（这个坑我在验证时实际踩过：检测恒报"未内嵌"，而文件其实完好）。
   * 直接找带 `/FontFile*` 的字典既简单又不会漏。
   */
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;

    for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
      const streamRef = object.get(PDFName.of(key));
      if (streamRef === undefined) continue;

      const stream = pdf.context.lookup(streamRef);
      if (!(stream instanceof PDFRawStream)) continue;

      /**
       * 子集化判据用**内嵌流的字节数**，而不是 PDF 规范里的 `ABCDEF+Name` 前缀：
       * `pdf-lib` 的子集命名是 `NotoSansSC-Regular-9086`（数字后缀），不符合那个约定，
       * 按规范判会把子集**误报成整份嵌入**。
       * 实测：一份 864 字中文报告的字体子集是 88 KB，而源字体 8.3 MB —— 相差两个数量级。
       */
      return { embedded: true, subsetted: stream.contents.length < sourceFontBytes / 2 };
    }
  }

  return { embedded: false, subsetted: false };
};

/**
 * 字体一致性自检（**不能让"看起来成功"的方块报告流出去**）
 *
 * 没内嵌字体的 PDF 在缺少中文字体的阅读器上会显示成方块，
 * 而那时用户已经拿到一份"成功生成"的文件了 —— 这正是本文件宁可不实现也要避免的失败模式。
 * 因此这里不把检测结果只当元数据，而是**失败即抛错**：
 * 任务会明确 FAILED 并归还配额，而不是交付一份读不了的报告。
 *
 * ⚠ 校验对象是**最终交付的那串字节**（重新 `PDFDocument.load` 回来解析），
 * 而不是 `save()` 之前的内存上下文 —— 字体描述符与内嵌流是在 `save()` 期间才写出来的，
 * 保存前查必然查不到（这是我实际踩过的第二个坑，第一个是"在原始字节里搜 `/FontFile`"）。
 */
const assertFontEmbedded = async (
  bytes: Buffer,
  sourceFontBytes: number,
): Promise<{ embedded: boolean; subsetted: boolean }> => {
  const parsed = await PDFDocument.load(bytes);
  const result = inspectEmbeddedFont(parsed, sourceFontBytes);

  if (!result.embedded) {
    throw new BusinessException(
      ErrorCode.AI_OUTPUT_INVALID,
      `PDF 渲染结果未内嵌字体（产物 ${bytes.length} 字节），中文可能无法显示，已中止导出（请联系管理员）`,
    );
  }

  return result;
};

/** PDF 渲染入参：**素材已备齐**，接入时不再需要回头改调用方 */
export interface PdfRenderInput {
  readonly reportId: string;
  readonly title: string;
  readonly mbtiType: string | null;
  readonly mbtiTypeName: string | null;
  readonly engineVersion: string | null;
  readonly template: 'CLASSIC' | 'MAGAZINE' | 'MINIMAL';
  readonly includeCharts: boolean;
  readonly includeAnswers: boolean;
  readonly watermark: boolean;
  /** 水印文案（昵称 + 生成日期；`watermark=false` 时忽略） */
  readonly watermarkText: string;
  /** 分页绘制用的日期 */
  readonly generatedAt: Date;
  /** 合规声明（来自 `system_configs`，必须绘制） */
  readonly disclaimer: string;
  /**
   * 已裁剪的正文分段
   *
   * ⚠ 调用方传入的是 `buildSectionViews` 的产物：**未解锁段落的 `content` 为 `null`**。
   * 渲染实现必须按 `content === null` 跳过正文（只画标题），绝不能自己去数据库重取内容 ——
   * 那等于绕过付费墙（契约 §3.5.8 规则 2）。
   */
  readonly sections: readonly { readonly title: string; readonly content: string | null; readonly order: number }[];
  /** 五维分数（`includeCharts = true` 时绘制） */
  readonly dimensions: {
    readonly EI: number | null;
    readonly SN: number | null;
    readonly TF: number | null;
    readonly JP: number | null;
  } | null;
  readonly bigFive: {
    readonly openness: number | null;
    readonly conscientiousness: number | null;
    readonly extraversion: number | null;
    readonly agreeableness: number | null;
    readonly neuroticism: number | null;
  } | null;
}

/** 分享卡渲染入参 */
export interface ShareCardRenderInput {
  readonly reportId: string;
  readonly template: 'TYPE_CARD' | 'RADAR_CARD' | 'QUOTE_CARD';
  readonly mbtiType: string | null;
  readonly mbtiTypeName: string | null;
  /** `showNickname=false` 时调用方已替换为脱敏文案（如「一位 INFJ」） */
  readonly displayName: string;
  /** `QUOTE_CARD` 的金句；**只可能来自免费预览段**（见 `report-share-card.service.ts`） */
  readonly quote: string | null;
  readonly dimensions: PdfRenderInput['dimensions'];
  readonly bigFive: PdfRenderInput['bigFive'];
  /** 小程序码 PNG；生成失败时为 `null`（渲染实现须按"无码"布局） */
  readonly qrCodeImage: Buffer | null;
  /** 合规微缩文案（固定绘制） */
  readonly complianceText: string;
}

// ============================================================================
// 字体
// ============================================================================

/**
 * 仓库自带字体（相对 `dist/modules/ai/report/` 回到 `backend/`）
 *
 * 刻意**不提供环境变量覆盖**：本项目禁止在 `config/` 与 `main.ts` 之外直接读
 * `process.env`（见 eslint `no-restricted-properties`），而为一个部署资产路径
 * 引入 ConfigService 会让这个纯函数模块被迫依赖 Nest DI。
 * 部署侧要做的是**把字体打进镜像**（见 `backend/Dockerfile` 的 `COPY /app/assets`）。
 */
const BUNDLED_FONT_RELATIVE = join('assets', 'fonts', 'NotoSansSC-Regular.otf');

/**
 * 找不到字体时的统一错误文案
 *
 * 仍然抛 `90008 CONFIG_MISSING`（与旧桩同码）：这是**部署配置问题**，
 * 不是用户错误，且必须让导出任务明确失败并把配额归还 ——
 * 绝不允许产出一份没有中文的报告文件。
 */
const FONT_MISSING_MESSAGE =
  `报告字体缺失：未找到中文字体文件 ${BUNDLED_FONT_RELATIVE}。` +
  '请确认部署包包含 backend/assets/fonts（Dockerfile 已 COPY /app/assets）';

/** 候选路径：`__dirname` 相对（dist 与 ts-jest 两种层级都试）+ 进程工作目录相对 */
const candidateFontPaths = (): string[] => [
  // `__dirname` 在 dist 下是 `dist/modules/ai/report`，在 ts-jest 下是 `src/modules/ai/report`
  join(__dirname, '..', '..', '..', BUNDLED_FONT_RELATIVE),
  join(process.cwd(), BUNDLED_FONT_RELATIVE),
];

let cachedFontBytes: Buffer | null = null;

/**
 * 读取中文字体字节（结果缓存）
 *
 * 字体约 8 MB，每次渲染都从磁盘读会让导出明显变慢；进程内缓存一次即可。
 */
const loadFontBytes = (): Buffer => {
  if (cachedFontBytes !== null) return cachedFontBytes;

  for (const candidate of candidateFontPaths()) {
    if (existsSync(candidate)) {
      cachedFontBytes = readFileSync(candidate);

      return cachedFontBytes;
    }
  }

  throw new BusinessException(ErrorCode.CONFIG_MISSING, FONT_MISSING_MESSAGE);
};

/** 供测试重置进程内字体缓存 */
export const resetFontCache = (): void => {
  cachedFontBytes = null;
};

// ============================================================================
// 中文排版
// ============================================================================

/** 不能出现在行首的标点（简易禁则处理） */
const NO_LINE_START = '。，、；：？！）］｝》」』】…—～·%”’ヽヾゝゞ々ー';

/** 不能出现在行尾的标点 */
const NO_LINE_END = '（［｛《「『【“‘';

/** 去掉 markdown 标记（`pdf-lib` 不支持富文本，保留标记只会让正文里出现一堆星号） */
export const stripMarkdown = (text: string): string =>
  text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .trim();

/**
 * 按给定宽度折行（**CJK 友好**）
 *
 * 中文没有空格，按词折行会把整段挤成一行；因此这里**逐字符**累加宽度，
 * 只对连续 ASCII 单词做整体换行，并做简易禁则处理（避免标点跑到行首）。
 */
export const wrapText = (text: string, font: PDFFont, size: number, maxWidth: number): string[] => {
  const lines: string[] = [];

  for (const rawParagraph of text.split('\n')) {
    const paragraph = rawParagraph.trimEnd();

    if (paragraph.trim() === '') {
      lines.push('');

      continue;
    }

    let current = '';
    // 以"字符簇"为单位推进：ASCII 单词整体作为一个不可分割单元
    const tokens = paragraph.match(/[A-Za-z0-9@._%+-]+|\s|[\s\S]/g) ?? [];

    for (const token of tokens) {
      const candidate = current + token;
      const width = font.widthOfTextAtSize(candidate, size);

      if (width <= maxWidth || current === '') {
        current = candidate;

        continue;
      }

      // 禁则：若下一个字符不能出现在行首，则把它一起挤进当前行（不让标点孤零零换行）
      if (NO_LINE_START.includes(token) && current.length > 1) {
        lines.push((current + token).trimEnd());
        current = '';

        continue;
      }

      // 禁则：若当前行以"不能结尾"的标点收尾，把该标点推到下一行
      let carry = '';
      const lastChar = current.slice(-1);
      if (NO_LINE_END.includes(lastChar) && current.length > 1) {
        carry = lastChar;
        current = current.slice(0, -1);
      }

      lines.push(current.trimEnd());
      current = carry + token;
    }

    if (current !== '') lines.push(current.trimEnd());
  }

  return lines;
};

// ============================================================================
// PDF 版式常量
// ============================================================================

/** A4 尺寸（pt） */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

/** 页边距 */
const MARGIN_X = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 64;

/** 字号 */
const SIZE_TITLE = 24;
const SIZE_SECTION = 16;
const SIZE_BODY = 11;
const SIZE_SMALL = 9;
const SIZE_TINY = 8;

/** 行距（倍字号） */
const LINE_HEIGHT_RATIO = 1.75;

/** 主题色（按模板区分，给用户"换了个样式"的可感知差异） */
const TEMPLATE_THEME: Readonly<
  Record<
    PdfRenderInput['template'],
    { accent: readonly [number, number, number]; cover: readonly [number, number, number] }
  >
> = {
  CLASSIC: { accent: [0.31, 0.27, 0.9], cover: [0.96, 0.96, 0.99] },
  MAGAZINE: { accent: [0.85, 0.33, 0.35], cover: [0.99, 0.96, 0.96] },
  MINIMAL: { accent: [0.2, 0.2, 0.22], cover: [0.97, 0.97, 0.97] },
};

const colorOf = (tuple: readonly [number, number, number]): ReturnType<typeof rgb> => rgb(tuple[0], tuple[1], tuple[2]);

/** 正文可用宽度 */
const CONTENT_WIDTH = A4_WIDTH - MARGIN_X * 2;

/** 大五维度中文标签（与 `report-context.builder.ts` 保持一致） */
const BIG_FIVE_LABELS: ReadonlyArray<{ key: keyof NonNullable<PdfRenderInput['bigFive']>; label: string }> = [
  { key: 'openness', label: '开放性' },
  { key: 'conscientiousness', label: '尽责性' },
  { key: 'extraversion', label: '外向性' },
  { key: 'agreeableness', label: '宜人性' },
  { key: 'neuroticism', label: '神经质' },
];

/** MBTI 四维中文说明 */
const MBTI_AXES: ReadonlyArray<{ key: 'EI' | 'SN' | 'TF' | 'JP'; left: string; right: string }> = [
  { key: 'EI', left: 'E 外向', right: 'I 内向' },
  { key: 'SN', left: 'S 实感', right: 'N 直觉' },
  { key: 'TF', left: 'T 思考', right: 'F 情感' },
  { key: 'JP', left: 'J 判断', right: 'P 知觉' },
];

// ============================================================================
// 绘制辅助
// ============================================================================

/** 页眉页脚：每页都要有，保证散页后仍能看出出处与合规声明 */
const drawPageFurniture = (
  page: PDFPage,
  font: PDFFont,
  input: PdfRenderInput,
  pageNumber: number,
  totalPagesHint: number,
): void => {
  const gray = rgb(0.45, 0.45, 0.5);

  page.drawLine({
    start: { x: MARGIN_X, y: MARGIN_BOTTOM - 14 },
    end: { x: A4_WIDTH - MARGIN_X, y: MARGIN_BOTTOM - 14 },
    thickness: 0.5,
    color: rgb(0.85, 0.85, 0.88),
  });

  page.drawText(`SoulMap AI · ${input.title}`, {
    x: MARGIN_X,
    y: MARGIN_BOTTOM - 28,
    size: SIZE_TINY,
    font,
    color: gray,
  });

  const pageLabel = `第 ${pageNumber} / ${totalPagesHint} 页`;
  page.drawText(pageLabel, {
    x: A4_WIDTH - MARGIN_X - font.widthOfTextAtSize(pageLabel, SIZE_TINY),
    y: MARGIN_BOTTOM - 28,
    size: SIZE_TINY,
    font,
    color: gray,
  });

  // 合规声明必须出现在**每一页**：用户可能只转发其中一页
  const disclaimerLines = wrapText(input.disclaimer, font, SIZE_TINY, CONTENT_WIDTH);
  disclaimerLines.forEach((line, index) => {
    page.drawText(line, {
      x: MARGIN_X,
      y: MARGIN_BOTTOM - 42 - index * (SIZE_TINY * 1.4),
      size: SIZE_TINY,
      font,
      color: gray,
    });
  });
};

/** 水印：斜向平铺，低透明度，不遮挡正文 */
const drawWatermark = (page: PDFPage, font: PDFFont, input: PdfRenderInput): void => {
  if (!input.watermark) return;

  const text = input.watermarkText.trim();
  if (text === '') return;

  const size = 20;
  const textWidth = font.widthOfTextAtSize(text, size);
  const stepX = textWidth + 90;
  const stepY = 130;

  for (let y = -40; y < A4_HEIGHT + stepY; y += stepY) {
    for (let x = -60; x < A4_WIDTH + stepX; x += stepX) {
      page.drawText(text, {
        x,
        y,
        size,
        font,
        color: rgb(0.55, 0.55, 0.6),
        opacity: 0.12,
        rotate: degrees(-28),
      });
    }
  }
};

/** 横向条形图：带标签与数值，用于 MBTI 四维 */
const drawBarChart = (
  page: PDFPage,
  font: PDFFont,
  y: number,
  title: string,
  rows: ReadonlyArray<{ label: string; value: number }>,
  accent: readonly [number, number, number],
): number => {
  let cursor = y;

  page.drawText(title, { x: MARGIN_X, y: cursor, size: 11, font, color: rgb(0.2, 0.2, 0.25) });
  cursor -= 18;

  const labelWidth = 74;
  const barWidth = CONTENT_WIDTH - labelWidth - 46;

  for (const row of rows) {
    const ratio = Math.max(0, Math.min(100, row.value)) / 100;

    page.drawText(row.label, { x: MARGIN_X, y: cursor, size: SIZE_SMALL, font, color: rgb(0.3, 0.3, 0.35) });

    // 轨道
    page.drawRectangle({
      x: MARGIN_X + labelWidth,
      y: cursor - 2,
      width: barWidth,
      height: 9,
      color: rgb(0.9, 0.9, 0.93),
    });

    // 数值条
    page.drawRectangle({
      x: MARGIN_X + labelWidth,
      y: cursor - 2,
      width: Math.max(2, barWidth * ratio),
      height: 9,
      color: colorOf(accent),
    });

    page.drawText(`${Math.round(row.value)}`, {
      x: MARGIN_X + labelWidth + barWidth + 8,
      y: cursor,
      size: SIZE_SMALL,
      font,
      color: rgb(0.35, 0.35, 0.4),
    });

    cursor -= 20;
  }

  return cursor - 6;
};

/** 雷达图：大五是五维，正好用五边形雷达（比五根条更符合"人格画像"的阅读预期） */
const drawRadarChart = (
  page: PDFPage,
  font: PDFFont,
  y: number,
  title: string,
  values: ReadonlyArray<{ label: string; value: number }>,
  accent: readonly [number, number, number],
): number => {
  const radius = 86;
  const centerX = A4_WIDTH / 2;
  const centerY = y - radius - 18;
  const axes = values.length;

  page.drawText(title, { x: MARGIN_X, y, size: 11, font, color: rgb(0.2, 0.2, 0.25) });

  const pointAt = (index: number, ratio: number): { x: number; y: number } => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / axes;

    return { x: centerX + Math.cos(angle) * radius * ratio, y: centerY + Math.sin(angle) * radius * ratio };
  };

  // 参考网格：25% / 50% / 75% / 100%
  for (const ratio of [0.25, 0.5, 0.75, 1]) {
    for (let index = 0; index < axes; index += 1) {
      page.drawLine({
        start: pointAt(index, ratio),
        end: pointAt((index + 1) % axes, ratio),
        thickness: 0.4,
        color: rgb(0.85, 0.85, 0.89),
      });
    }
  }

  // 轴线
  for (let index = 0; index < axes; index += 1) {
    page.drawLine({
      start: { x: centerX, y: centerY },
      end: pointAt(index, 1),
      thickness: 0.4,
      color: rgb(0.85, 0.85, 0.89),
    });
  }

  // 数据多边形
  for (let index = 0; index < axes; index += 1) {
    const current = values[index];
    const next = values[(index + 1) % axes];

    page.drawLine({
      start: pointAt(index, Math.max(0, Math.min(100, current.value)) / 100),
      end: pointAt((index + 1) % axes, Math.max(0, Math.min(100, next.value)) / 100),
      thickness: 1.6,
      color: colorOf(accent),
      opacity: 0.9,
    });
  }

  // 轴标签 + 数值
  values.forEach((entry, index) => {
    const outer = pointAt(index, 1.22);
    const label = `${entry.label} ${Math.round(entry.value)}`;

    page.drawText(label, {
      x: outer.x - font.widthOfTextAtSize(label, SIZE_SMALL) / 2,
      y: outer.y - 3,
      size: SIZE_SMALL,
      font,
      color: rgb(0.3, 0.3, 0.35),
    });
  });

  return centerY - radius - 34;
};

// ============================================================================
// PDF 渲染
// ============================================================================

/**
 * 渲染报告 PDF（契约 §3.5.8）
 *
 * 版式：封面头 → 图表（可选）→ 分段正文 → 页脚合规声明 + 页码。
 * 分段里 `content === null` 表示**该段未解锁**：只画标题与解锁提示，正文绝不出现。
 */
export const renderReportPdf = async (input: PdfRenderInput): Promise<RenderedArtifact> => {
  const fontBytes = loadFontBytes();
  const theme = TEMPLATE_THEME[input.template];

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const font = await pdf.embedFont(fontBytes, { subset: true });

  pdf.setTitle(input.title);
  pdf.setProducer('SoulMap AI');
  pdf.setCreator('SoulMap AI 报告渲染器');
  pdf.setSubject('人格测评深度报告');
  pdf.setCreationDate(input.generatedAt);

  const pages: PDFPage[] = [];
  let page = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
  pages.push(page);

  /**
   * 换页
   *
   * 页数在开始渲染时**还不知道**，因此页码先按 `总页数 = ?` 占位，
   * 全部画完后再统一回填（见函数末尾）—— 比"猜一个总页数"诚实。
   */
  const newPage = (): PDFPage => {
    const next = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
    pages.push(next);

    return next;
  };

  // ---- 封面头 ----
  const coverHeight = 132;
  page.drawRectangle({
    x: 0,
    y: A4_HEIGHT - coverHeight,
    width: A4_WIDTH,
    height: coverHeight,
    color: colorOf(theme.cover),
  });
  page.drawRectangle({ x: 0, y: A4_HEIGHT - 4, width: A4_WIDTH, height: 4, color: colorOf(theme.accent) });

  let y = A4_HEIGHT - MARGIN_TOP;

  page.drawText('SoulMap AI', { x: MARGIN_X, y, size: 10, font, color: colorOf(theme.accent) });
  y -= 30;

  for (const line of wrapText(input.title, font, SIZE_TITLE, CONTENT_WIDTH)) {
    page.drawText(line, { x: MARGIN_X, y, size: SIZE_TITLE, font, color: rgb(0.12, 0.12, 0.16) });
    y -= SIZE_TITLE * 1.35;
  }

  // 类型徽标行：MBTI + 引擎版本 + 生成日期
  const badgeParts: string[] = [];
  if (input.mbtiType !== null && input.mbtiType !== '') {
    badgeParts.push(input.mbtiTypeName === null ? input.mbtiType : `${input.mbtiType} · ${input.mbtiTypeName}`);
  }
  badgeParts.push(`生成于 ${input.generatedAt.toISOString().slice(0, 10)}`);
  if (input.engineVersion !== null && input.engineVersion !== '') badgeParts.push(`引擎 ${input.engineVersion}`);

  page.drawText(badgeParts.join('   |   '), { x: MARGIN_X, y, size: SIZE_SMALL, font, color: rgb(0.4, 0.4, 0.45) });

  y = A4_HEIGHT - coverHeight - 34;

  // ---- 图表 ----
  if (input.includeCharts) {
    const dimensionRows = MBTI_AXES.map((axis) => {
      const raw = input.dimensions?.[axis.key];

      return raw === null || raw === undefined
        ? null
        : { label: axis.left.split(' ')[0] + '–' + axis.right.split(' ')[0], value: raw };
    }).filter((row): row is { label: string; value: number } => row !== null);

    if (dimensionRows.length > 0) {
      y = drawBarChart(page, font, y, 'MBTI 四维度倾向（0–100）', dimensionRows, theme.accent);
      y -= 10;
    }

    const bigFiveRows = BIG_FIVE_LABELS.map((entry) => {
      const raw = input.bigFive?.[entry.key];

      return raw === null || raw === undefined ? null : { label: entry.label, value: raw };
    }).filter((row): row is { label: string; value: number } => row !== null);

    if (bigFiveRows.length >= 3) {
      y = drawRadarChart(page, font, y, '大五人格画像（0–100）', bigFiveRows, theme.accent);
    }
  }

  // ---- 作答明细：数据通路未打通，明确告知而不是静默忽略 ----
  if (input.includeAnswers) {
    page.drawText('（本次导出未包含逐题作答明细：该选项的数据通路尚未打通）', {
      x: MARGIN_X,
      y,
      size: SIZE_SMALL,
      font,
      color: rgb(0.65, 0.45, 0.2),
    });
    y -= 24;
  }

  // ---- 分段正文 ----
  const orderedSections = [...input.sections].sort((a, b) => a.order - b.order);

  for (const section of orderedSections) {
    if (y < MARGIN_BOTTOM + 90) {
      page = newPage();
      y = A4_HEIGHT - MARGIN_TOP;
    }

    // 段标题 + 左侧强调块
    page.drawRectangle({
      x: MARGIN_X - 12,
      y: y - 2,
      width: 3,
      height: SIZE_SECTION + 4,
      color: colorOf(theme.accent),
    });
    page.drawText(section.title, { x: MARGIN_X, y, size: SIZE_SECTION, font, color: rgb(0.12, 0.12, 0.16) });
    y -= SIZE_SECTION * 1.6;

    if (section.content === null) {
      /**
       * 未解锁段：**只画提示，绝不画正文**
       *
       * 契约 §3.5.8 规则 2 明确要求付费墙在导出物里同样生效；
       * 内容不在这份输入里（调用方已裁剪），因此这里也没有"漏画"的可能。
       */
      page.drawRectangle({
        x: MARGIN_X,
        y: y - 16,
        width: CONTENT_WIDTH,
        height: 40,
        color: rgb(0.96, 0.96, 0.98),
      });
      page.drawText('本段内容需解锁后阅读', {
        x: MARGIN_X + 12,
        y: y - 2,
        size: SIZE_BODY,
        font,
        color: rgb(0.5, 0.5, 0.55),
      });
      page.drawText('在 SoulMap AI 小程序内解锁本报告即可查看完整正文', {
        x: MARGIN_X + 12,
        y: y - 16,
        size: SIZE_SMALL,
        font,
        color: rgb(0.6, 0.6, 0.65),
      });
      y -= 42;

      continue;
    }

    const lineHeight = SIZE_BODY * LINE_HEIGHT_RATIO;

    for (const rawLine of stripMarkdown(section.content).split('\n')) {
      const trimmed = rawLine.trim();
      const isBullet = /^[-•*]\s+/.test(trimmed);
      const body = isBullet ? trimmed.replace(/^[-•*]\s+/, '') : trimmed;
      const indent = isBullet ? 14 : 0;

      if (body === '') {
        y -= lineHeight * 0.5;

        continue;
      }

      for (const line of wrapText(body, font, SIZE_BODY, CONTENT_WIDTH - indent)) {
        if (y < MARGIN_BOTTOM + 40) {
          page = newPage();
          y = A4_HEIGHT - MARGIN_TOP;
        }

        if (isBullet) {
          page.drawText('·', { x: MARGIN_X, y, size: SIZE_BODY, font, color: colorOf(theme.accent) });
        }

        page.drawText(line, { x: MARGIN_X + indent, y, size: SIZE_BODY, font, color: rgb(0.2, 0.2, 0.24) });
        y -= lineHeight;
      }
    }

    y -= 14;
  }

  // ---- 水印与页眉页脚（必须最后画：页数此时才确定） ----
  const totalPages = pages.length;
  pages.forEach((target, index) => {
    drawWatermark(target, font, input);
    drawPageFurniture(target, font, input, index + 1, totalPages);
  });

  const bytes = await pdf.save();
  const body = Buffer.from(bytes);

  // 自检基于**最终字节**（见 `assertFontEmbedded` 的说明）
  const fontCheck = await assertFontEmbedded(body, fontBytes.length);

  return {
    body,
    contentType: 'application/pdf',
    sizeBytes: body.length,
    width: null,
    height: null,
    pageCount: totalPages,
    fontEmbedded: fontCheck.embedded,
    fontSubsetted: fontCheck.subsetted,
  };
};

// ============================================================================
// 分享卡渲染
// ============================================================================

/** 卡片配色（按模板区分） */
const CARD_THEME: Readonly<
  Record<
    ShareCardRenderInput['template'],
    { from: string; to: string; accent: string; onDark: string; onLight: string }
  >
> = {
  TYPE_CARD: { from: '#312e81', to: '#0f172a', accent: '#a5b4fc', onDark: '#f8fafc', onLight: '#c7d2fe' },
  RADAR_CARD: { from: '#0f766e', to: '#082f49', accent: '#5eead4', onDark: '#f0fdfa', onLight: '#99f6e4' },
  QUOTE_CARD: { from: '#7c2d12', to: '#1c1917', accent: '#fdba74', onDark: '#fff7ed', onLight: '#fed7aa' },
};

/** 把文字按画布宽度折行（Canvas 版，逻辑同 PDF 的 `wrapText`） */
const wrapForCanvas = (ctx: SKRSContext2D, text: string, maxWidth: number): string[] => {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');

      continue;
    }

    let current = '';
    for (const char of paragraph) {
      if (ctx.measureText(current + char).width > maxWidth && current !== '') {
        lines.push(current);
        current = char;
      } else {
        current += char;
      }
    }

    if (current !== '') lines.push(current);
  }

  return lines;
};

/**
 * 渲染分享卡图片（契约 §3.5.9）
 *
 * 750×1334，**固定绘制合规微缩文案**（规则 5），小程序码缺失时按"无码"布局（规则 6）。
 * 优先输出 WebP（契约规则 3 指定格式），若当前 skia 构建不支持编码则降级为 PNG ——
 * 两种格式都在 `storage-policy.ts` 的 `SHARE_CARD` 白名单里。
 */
export const renderShareCardImage = async (input: ShareCardRenderInput): Promise<RenderedArtifact> => {
  // 原生模块按需加载：纯逻辑单测（不涉及渲染）不需要它，避免启动期就为它付出代价
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas') as {
    createCanvas: (width: number, height: number) => Canvas;
    GlobalFonts: { registerFromPath: (path: string, name?: string) => unknown };
    loadImage: (data: Buffer) => Promise<CanvasImage>;
  };

  const fontPath = candidateFontPaths().find((candidate) => existsSync(candidate));
  if (fontPath === undefined) {
    throw new BusinessException(ErrorCode.CONFIG_MISSING, FONT_MISSING_MESSAGE);
  }

  // 重复注册同一路径是幂等的（skia 会复用），但注册失败必须报错而不是画出方块
  GlobalFonts.registerFromPath(fontPath, 'SoulMapSans');

  const theme = CARD_THEME[input.template];
  const canvas = createCanvas(SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  const ctx = canvas.getContext('2d');

  // ---- 背景 ----
  const gradient = ctx.createLinearGradient(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  gradient.addColorStop(0, theme.from);
  gradient.addColorStop(1, theme.to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);

  const contentWidth = SHARE_CARD_WIDTH - 120;

  // ---- 品牌行 ----
  ctx.fillStyle = theme.accent;
  ctx.font = '26px SoulMapSans';
  ctx.fillText('SoulMap AI', 60, 84);

  ctx.fillStyle = theme.onLight;
  ctx.font = '24px SoulMapSans';
  ctx.fillText(input.displayName, 60, 126);

  ctx.fillStyle = theme.accent;
  ctx.fillRect(60, 158, 72, 4);

  // ---- 模板主体 ----
  if (input.template === 'TYPE_CARD') {
    ctx.fillStyle = theme.onDark;
    ctx.font = 'bold 132px SoulMapSans';
    ctx.fillText(input.mbtiType ?? 'SoulMap', 60, 330);

    if (input.mbtiTypeName !== null && input.mbtiTypeName !== '') {
      ctx.fillStyle = theme.accent;
      ctx.font = '38px SoulMapSans';
      ctx.fillText(input.mbtiTypeName, 62, 392);
    }

    // 四维度条
    let barY = 520;
    for (const axis of MBTI_AXES) {
      const value = input.dimensions?.[axis.key];
      if (value === null || value === undefined) continue;

      ctx.fillStyle = theme.onLight;
      ctx.font = '24px SoulMapSans';
      ctx.fillText(axis.left, 60, barY);
      const rightWidth = ctx.measureText(axis.right).width;
      ctx.fillText(axis.right, SHARE_CARD_WIDTH - 60 - rightWidth, barY);

      const trackY = barY + 14;
      const trackWidth = contentWidth;
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(60, trackY, trackWidth, 10);

      ctx.fillStyle = theme.accent;
      ctx.fillRect(60, trackY, Math.max(4, (trackWidth * Math.max(0, Math.min(100, value))) / 100), 10);

      barY += 76;
    }
  } else if (input.template === 'RADAR_CARD') {
    const values = BIG_FIVE_LABELS.map((entry) => ({ label: entry.label, value: input.bigFive?.[entry.key] ?? 0 }));
    const centerX = SHARE_CARD_WIDTH / 2;
    const centerY = 520;
    const radius = 230;

    const pointAt = (index: number, ratio: number): { x: number; y: number } => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / values.length;

      return { x: centerX + Math.cos(angle) * radius * ratio, y: centerY + Math.sin(angle) * radius * ratio };
    };

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    for (const ratio of [0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      for (let index = 0; index < values.length; index += 1) {
        const point = pointAt(index, ratio);
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    ctx.beginPath();
    values.forEach((entry, index) => {
      const point = pointAt(index, Math.max(0, Math.min(100, entry.value)) / 100);
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(94,234,212,0.35)';
    ctx.fill();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = theme.onDark;
    ctx.font = '26px SoulMapSans';
    values.forEach((entry, index) => {
      const label = `${entry.label} ${Math.round(entry.value)}`;
      const point = pointAt(index, 1.2);
      const width = ctx.measureText(label).width;
      ctx.fillText(label, point.x - width / 2, point.y + 8);
    });
  } else {
    // QUOTE_CARD：金句必须来自免费预览段（调用方保证）
    const quote = (input.quote ?? '').trim() || '在 SoulMap AI 看见自己的倾向';

    ctx.fillStyle = theme.accent;
    ctx.font = 'bold 120px SoulMapSans';
    ctx.fillText('“', 48, 340);

    ctx.fillStyle = theme.onDark;
    ctx.font = '44px SoulMapSans';

    const lines = wrapForCanvas(ctx, quote, contentWidth);
    let quoteY = 400;
    for (const line of lines.slice(0, 9)) {
      ctx.fillText(line, 60, quoteY);
      quoteY += 66;
    }
  }

  // ---- 小程序码（缺失则整块不画，不留空白框） ----
  if (input.qrCodeImage !== null && input.qrCodeImage.length > 0) {
    try {
      const image = await loadImage(input.qrCodeImage);
      const boxSize = 190;
      const boxX = SHARE_CARD_WIDTH - 60 - boxSize;
      const boxY = SHARE_CARD_HEIGHT - 300;

      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fillRect(boxX - 12, boxY - 12, boxSize + 24, boxSize + 24);
      ctx.drawImage(image, boxX, boxY, boxSize, boxSize);

      ctx.fillStyle = theme.onLight;
      ctx.font = '22px SoulMapSans';
      const hint = '长按识别，测测你的';
      ctx.fillText(hint, boxX + (boxSize - ctx.measureText(hint).width) / 2, boxY + boxSize + 34);
    } catch {
      // 码画不出来不该让整张卡片失败：分享图本身仍有价值（与契约规则 6 的降级精神一致）
    }
  }

  // ---- 合规微缩文案（固定绘制，契约规则 5） ----
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = '22px SoulMapSans';
  const complianceWidth = ctx.measureText(input.complianceText).width;
  ctx.fillText(input.complianceText, (SHARE_CARD_WIDTH - complianceWidth) / 2, SHARE_CARD_HEIGHT - 56);

  // ---- 编码：优先 WebP，不支持则降级 PNG（两者都在 SHARE_CARD 白名单内） ----
  let body: Buffer;
  let contentType = 'image/webp';

  try {
    body = canvas.toBuffer('image/webp');
    if (body.length === 0) throw new Error('webp 编码返回空数据');
  } catch {
    body = canvas.toBuffer('image/png');
    contentType = 'image/png';
  }

  return {
    body,
    contentType,
    sizeBytes: body.length,
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    pageCount: null,
    // 图片没有字体概念（文字已被光栅化进像素）
    fontEmbedded: null,
    fontSubsetted: null,
  };
};
