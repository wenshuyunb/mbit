/**
 * 报告渲染单点（契约 §3.5.8 PDF / §3.5.9 分享卡）
 *
 * ============================================================================
 * 🚨 这是本次交付中**唯一未完成**的部分，且是**故意**留的
 * ============================================================================
 *
 * 项目当前**没有安装任何 PDF / Canvas / 图片渲染库**（`backend/package.json` 的
 * dependencies 里没有 puppeteer / playwright / pdfkit / pdf-lib / canvas / sharp / satori），
 * 而本任务明确要求**不得新增 npm 依赖**。因此：
 *
 *   · 接口层、异步任务状态机、幂等、配额原子扣减、OSS 上传、签名 URL、降级与补偿
 *     —— **全部已实现并可测**（见 `report-export.service.ts` / `report-share-card.service.ts`）；
 *   · 只有「把结构化报告画成 PDF / PNG」这一步没有实现，它被收敛到本文件的
 *     三个函数里，**每个函数都明确抛 `90008 CONFIG_MISSING`**，
 *     而不是返回一个假的空文件或占位图。
 *
 * 为什么宁可抛错也不返回占位文件：一份"看起来成功、实际是空白/占位图"的 PDF 会被
 * 用户当成真实报告保存和转发，比明确的失败严重得多 —— 前者是静默的数据错误，
 * 后者只是一次可重试的失败。
 *
 * ============================================================================
 * 接入方式（只需改本文件，其余代码不动）
 * ============================================================================
 *
 * 1. 安装渲染库（示例，任选其一）：
 *    · 服务端浏览器渲染：`puppeteer` 或 `playwright`（HTML/CSS 排版能力最强，
 *      中文断行、页眉页脚、图表都好做；代价是镜像里多一个 Chromium，冷启动较慢）
 *    · 纯 JS 排版：`pdfkit` / `pdf-lib`（体积小、启动快，但排版要自己算，
 *      中文字体需自带 TTF 并注册子集，否则中文会变成方块）
 *    · Canvas 系：`@napi-rs/canvas` / `sharp`（分享卡用；`sharp` 还能顺带做 WebP 与缩放）
 * 2. 在 `renderReportPdf` 里：
 *    · 用 `input.sections`（已按 `order` 排好、**正文已按可见性判定裁剪**）拼 HTML/画布；
 *    · 图表（`includeCharts`）用 `input.dimensions` / `input.bigFive` 画雷达图与维度条；
 *    · `input.watermark === true` 时在每页绘制 `input.watermarkText`（含昵称与生成日期，
 *      **不得含手机号等敏感信息**，契约 §3.5.8 规则 5）；
 *    · 返回 `body: Buffer`、`pageCount`、`sizeBytes`。
 * 3. 在 `renderShareCardImage` 里产出 750×1334 的 **WebP**（契约 §3.5.9 规则 3；
 *    `image/webp` 也在 `storage-policy.ts` 的 `SHARE_CARD` 场景白名单里），
 *    并**固定绘制**合规微缩文案（契约规则 5：`AI 内容由模型生成，仅供自我探索参考`）。
 * 4. 在 `generateMiniAppCode` 里调用微信 `wxacode.getUnlimited`（`scene` 传
 *    `qrCodeScene`，即 `report_{reportId 前 8 位}`），返回小程序码 PNG Buffer。
 *    该函数失败时**不要抛错**：返回 `null` 即可，调用方会自动降级为"无码卡片"
 *    并写 `outbox_event` 重试（契约规则 6）。
 *
 * 三个函数的入参已经把渲染所需的**全部素材**（含合规文案与水印文案）准备好，
 * 因此接入时不需要回头改 Service、队列或接口。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';

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
}

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

/** 渲染器未接入的统一错误文案 */
const RENDERER_MISSING_MESSAGE =
  '报告渲染器尚未接入（项目未安装 PDF/图片渲染库，且本次交付不允许新增依赖），请联系管理员';

/**
 * 渲染报告 PDF
 *
 * 🚨 **当前恒以 `90008 CONFIG_MISSING` 拒绝** —— 这是唯一未实现的步骤，接入方式见文件头。
 * 抛出位置在任务状态机的 `RENDERING_PDF` 阶段，因此任务会以 `FAILED` +
 * 明确的 `errorMessage` 收尾，并且**已扣的配额会被归还**（见 `report-export.service.ts`）。
 */
export const renderReportPdf = (_input: PdfRenderInput): Promise<RenderedArtifact> =>
  Promise.reject(new BusinessException(ErrorCode.CONFIG_MISSING, RENDERER_MISSING_MESSAGE));

/**
 * 渲染分享卡图片（750×1334 WebP）
 *
 * 🚨 **当前恒以 `90008 CONFIG_MISSING` 拒绝**。分享卡是**同步接口**（契约 §3.5.9），
 * 因此客户端会直接收到 500 + 该文案，而不是拿到一张假图。
 */
export const renderShareCardImage = (_input: ShareCardRenderInput): Promise<RenderedArtifact> =>
  Promise.reject(new BusinessException(ErrorCode.CONFIG_MISSING, RENDERER_MISSING_MESSAGE));

/**
 * 生成小程序码（`wxacode.getUnlimited`）
 *
 * 契约 §3.5.9 规则 6 要求：生成失败**不阻断**分享，降级为无码卡片并写
 * `outbox_event` 重试。因此本函数的契约是「失败返回 `null`」而不是抛错；
 * 当前未接入微信接口，**恒返回 `null`**，调用方便按契约走降级分支
 * （`showQrCode` 置 `false` + 写重试事件）。
 */
export const generateMiniAppCode = (_params: {
  readonly scene: string;
  readonly pagePath: string;
}): Promise<Buffer | null> => Promise.resolve(null);
