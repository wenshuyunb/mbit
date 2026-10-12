/**
 * 报告 PDF 导出（契约 §3.5.8）的纯逻辑
 *
 * 这里放**无 I/O** 的部分：任务状态机（状态/阶段/进度）、对象键与文件名、
 * 24h 复用窗口与签名有效期、以及状态到响应字段的映射。
 *
 * 之所以把状态机抽成纯函数：异步导出的 bug 几乎都出在"状态转移漏了一条边"
 * （例如失败时没落到 FAILED、或重试时状态没复位），而这类问题在集成测试里
 * 需要构造时序，在纯函数测试里可以直接把每条边都断言一遍。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';

/** PDF 排版模板（契约 §3.5.8 请求体） */
export const PDF_EXPORT_TEMPLATES = ['CLASSIC', 'MAGAZINE', 'MINIMAL'] as const;

export type PdfExportTemplate = (typeof PDF_EXPORT_TEMPLATES)[number];

/** 导出任务状态机 */
export const REPORT_EXPORT_STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED'] as const;

export type ReportExportStatus = (typeof REPORT_EXPORT_STATUSES)[number];

/** 导出任务阶段（契约 §3.5.8 规则 6 提到 `stage = EXPORTING_PDF`） */
export const REPORT_EXPORT_STAGES = [
  'QUEUED',
  'LOADING_REPORT',
  'RENDERING_PDF',
  'UPLOADING',
  'SIGNING',
  'DONE',
  'ERROR',
] as const;

export type ReportExportStage = (typeof REPORT_EXPORT_STAGES)[number];

/** 阶段 → 进度（供前端进度条使用；估算值，不作业务判据） */
export const REPORT_EXPORT_STAGE_PROGRESS: Readonly<Record<ReportExportStage, number>> = {
  QUEUED: 0,
  LOADING_REPORT: 20,
  RENDERING_PDF: 50,
  UPLOADING: 80,
  SIGNING: 95,
  DONE: 100,
  ERROR: 100,
};

/**
 * 队列名
 *
 * 契约 §3.5.8 指定 `export.pdf`（并发 2、重试 2 次）。**没有**写进
 * `infra/queue/queue.module.ts`（该文件是全局共享文件，其它任务同时在改），
 * 改由 `ai.module.ts` 局部 `BullModule.registerQueue({ name })` 注册 ——
 * BullMQ 按队列名消费，注册位置不影响行为，只是把改动收敛在本模块内。
 */
export const REPORT_EXPORT_QUEUE_NAME = 'export.pdf';

/** 本队列的 job name（处理器按名过滤，避免同队列上其它任务被误消费） */
export const REPORT_EXPORT_JOB_NAME = 'render.report-pdf';

/** 队列并发（契约 §3.5.8：并发 2） */
export const REPORT_EXPORT_CONCURRENCY = 2;

/** 队列重试次数（契约 §3.5.8：重试 2 次） */
export const REPORT_EXPORT_JOB_ATTEMPTS = 2;

/** 每日导出次数上限（契约 §3.5.8 限流：userId 5 次/24h） */
export const PDF_EXPORT_DAILY_LIMIT = 5;

/** 配额窗口（契约：24h；按 UTC 自然日重置以贴合"明天零点恢复"的直觉） */
export const PDF_EXPORT_QUOTA_WINDOW = { kind: 'utc-day' } as const;

/** 签名下载 URL 有效期（契约 §3.5.8 规则 4：24h） */
export const PDF_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

/** OSS 源文件保留天数（契约 §3.5.8 规则 4：7 天） */
export const PDF_SOURCE_RETENTION_DAYS = 7;

/** 任务状态保留时长（秒）：与源文件同寿，便于查到"已过期" */
export const PDF_TASK_TTL_SECONDS = PDF_SOURCE_RETENTION_DAYS * 24 * 60 * 60;

/** 24h 复用窗口（毫秒，契约 §3.5.8 规则 3） */
export const PDF_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 幂等记录保留时长（秒）：覆盖"用户重复点击"的窗口 */
export const PDF_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** 预计渲染耗时（秒，契约示例 12）：仅用于展示 */
export const PDF_ESTIMATED_SECONDS = 12;

/** 对象键前缀（与 `storage-policy.ts` 的 `REPORT_PDF` 场景前缀一致） */
const PDF_OBJECT_PREFIX = 'report-pdf';

/**
 * PDF 对象键
 *
 * 形如 `report-pdf/{userId}/{reportId}-{template}.pdf`。
 * 与契约示例相比多了模板后缀：**同一报告的三种模板必须落在不同对象上**，
 * 否则"改了模板再导出"会覆盖掉上一份文件，24h 复用时用户拿到的就不是他要的模板。
 */
export const buildPdfObjectKey = (userId: string, reportId: string, template: PdfExportTemplate): string =>
  `${PDF_OBJECT_PREFIX}/${userId}/${reportId}-${template.toLowerCase()}.pdf`;

/** `YYYYMMDD`（文件名里的生成日期） */
export const formatPdfDate = (date: Date): string => date.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * 下载文件名（契约示例：`soulmap-report-INFJ-20260214.pdf`）
 *
 * 没有 MBTI 时退化为报告 ID 前 8 位：文件名里出现 `null` 会让用户以为是坏文件。
 */
export const buildPdfFileName = (mbtiType: string | null, reportId: string, generatedAt: Date): string => {
  const subject = mbtiType !== null && mbtiType.length > 0 ? mbtiType : reportId.slice(0, 8);

  return `soulmap-report-${subject}-${formatPdfDate(generatedAt)}.pdf`;
};

/** 导出任务状态（Redis JSON；不含签名 URL —— 签名每次现签，避免存下已过期的链接） */
export interface ReportExportTaskState {
  readonly taskId: string;
  readonly reportId: string;
  readonly userId: string;
  readonly queue: string;
  readonly status: ReportExportStatus;
  readonly stage: ReportExportStage;
  readonly progress: number;
  readonly template: PdfExportTemplate;
  readonly includeCharts: boolean;
  readonly includeAnswers: boolean;
  readonly watermark: boolean;
  /** 对象键（签名在其中现算） */
  readonly objectKey: string;
  readonly fileName: string;
  readonly sizeBytes: number | null;
  readonly pageCount: number | null;
  readonly generatedAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: number | null;
  readonly errorMessage: string | null;
  /**
   * 本次导出消耗的额度（失败补偿用）
   *
   * `entitlementId` 非空表示扣的是单次购买的 `PDF_EXPORT` 权益（需归还 `remainingQuota`）；
   * 两个布尔位表示扣了哪一类时间窗配额。把它们**记在任务上**而不是"失败时再推断"：
   * 失败补偿必须精确归还当初扣的那一份，推断容易重复归还或漏归还。
   */
  readonly consumed: {
    readonly entitlementId: string | null;
    readonly windowQuota: boolean;
  };
}

/** 任务是否已过期（源文件已被清理） */
export const isExportTaskExpired = (task: ReportExportTaskState, now: Date): boolean =>
  Date.parse(task.expiresAt) <= now.getTime();

/** 是否可复用（契约规则 3：同一报告 + 同一模板 + 同参数，24h 内） */
export const isReusableTask = (task: ReportExportTaskState, now: Date): boolean => {
  if (task.status !== 'SUCCEEDED') return false;
  if (task.generatedAt === null) return false;
  if (isExportTaskExpired(task, now)) return false;

  const generatedAt = Date.parse(task.generatedAt);

  return Number.isFinite(generatedAt) && now.getTime() - generatedAt <= PDF_REUSE_WINDOW_MS;
};

/**
 * 复用指纹
 *
 * 契约只提"同一报告同一模板"，但 `includeCharts` / `includeAnswers` / `watermark`
 * 都会改变渲染结果。若只按模板判定复用，用户关掉水印再导出会拿到带水印的旧文件
 * —— 参数参与了渲染就必须参与缓存键，这是缓存设计的基本要求。
 */
export const pdfReuseFingerprint = (input: {
  reportId: string;
  template: PdfExportTemplate;
  includeCharts: boolean;
  includeAnswers: boolean;
  watermark: boolean;
}): string =>
  [
    input.reportId,
    input.template,
    input.includeCharts ? 'charts' : 'nocharts',
    input.includeAnswers ? 'answers' : 'noanswers',
    input.watermark ? 'wm' : 'nowm',
  ].join('|');

/** 队列位置（契约的 `queuePosition`：当前等待数 + 自己） */
export const queuePositionOf = (waitingCount: number): number => Math.max(1, waitingCount + 1);

/**
 * 水印文案（契约规则 5：昵称 + 生成日期，**不含手机号等敏感信息**）
 *
 * 在渲染入口拼好而不是交给渲染实现：水印是**合规要求**，把它放在唯一的
 * 业务侧入口可以保证"换了渲染库也不会漏画或画上不该画的东西"。
 */
export const buildWatermarkText = (nickname: string | null, generatedAt: Date): string => {
  const name = nickname !== null && nickname.trim().length > 0 ? nickname.trim() : 'SoulMap 用户';

  return `${name} · ${generatedAt.toISOString().slice(0, 10)} · 仅供个人参考`;
};

/**
 * 渲染失败是否值得重试
 *
 * 配置缺失（渲染器未接入）与内容问题重试一万次也是同样的结果，重试只会
 * 反复消耗 Worker 时间并让用户等更久；只有基础设施类错误（OSS 抖动、超时）
 * 才交给 BullMQ 重试。
 */
export const isRetryableExportError = (code: number): boolean =>
  code === 80002 /* FILE_UPLOAD_FAILED */ ||
  code === 80011 /* SIGN_URL_FAILED */ ||
  code === 502 /* 上游 5xx 包装 */ ||
  code === 90006; /* THIRD_PARTY_ERROR */

/**
 * 从任意异常里取出业务错误码（取不到回退 `INTERNAL_ERROR`）
 *
 * 与 `report-generation.service.ts` 的同名私有实现同思路：不只用 `instanceof` 判断。
 * 中间任何一层（拦截器、SDK 适配、日志包装）都可能把 `BusinessException` 包成普通
 * `Error`，只认 `instanceof` 会让"渲染器未接入"（90008）在任务状态里退化成 90000，
 * 用户看到的提示与运维的排查线索都会失真。
 */
export const readBusinessErrorCode = (error: unknown): number => {
  if (error instanceof BusinessException) return error.code;

  if (typeof error === 'object' && error !== null) {
    const raw = (error as { code?: unknown }).code;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }

  return ErrorCode.INTERNAL_ERROR;
};
