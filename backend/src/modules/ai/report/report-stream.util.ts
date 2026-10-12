/**
 * 报告进度 SSE 流（契约 §3.5.6）的纯逻辑
 *
 * 这里只放**无 I/O、可穷举单测**的部分：阶段枚举与权重、状态推导、SSE 帧格式化、
 * 事件载荷构造函数。真正的连接生命周期（握手、心跳、断连清理、超时）在
 * `report-stream.service.ts` 与控制器里。
 *
 * 分开的理由：SSE 的正确性有两类失败，一类是"事件内容错"（可穷举断言），
 * 一类是"连接没关掉/没清理"（只能在集成层验证）。把前者抽成纯函数后，
 * 后者出问题时可以确定不是序列化逻辑的锅。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import type { SectionVisibility } from './report-visibility';

/** 契约 §3.5.5/§3.5.6 的阶段枚举 */
export const REPORT_STAGES = [
  'QUEUED',
  'BUILDING_CONTEXT',
  'RENDERING_PROMPT',
  'CALLING_MODEL',
  'GENERATING_SECTIONS',
  'SAFETY_CHECK',
  'PERSISTING',
  'DONE',
  'ERROR',
] as const;

export type ReportStage = (typeof REPORT_STAGES)[number];

/** 阶段中文标签（契约 §3.5.5 阶段枚举表，逐字一致） */
export const REPORT_STAGE_LABELS: Readonly<Record<ReportStage, string>> = {
  QUEUED: '任务排队中',
  BUILDING_CONTEXT: '正在装配人格上下文',
  RENDERING_PROMPT: '正在渲染提示词',
  CALLING_MODEL: '正在调用 AI 模型',
  GENERATING_SECTIONS: '正在生成报告内容',
  SAFETY_CHECK: '正在进行内容安全检测',
  PERSISTING: '正在保存报告',
  DONE: '报告已生成',
  ERROR: '生成失败',
};

/**
 * 阶段 → 该阶段**开始时**的进度下限（百分比）
 *
 * 契约 §3.5.5 规则 1 说明 `progress` 由"已完成阶段权重 + 已生成字数比例"加权得出。
 * 取值对齐契约 §3.5.6 示例中的阶段进度的**起点**（8/18/45/88/96），并补齐示例里未出现
 * 的 `RENDERING_PROMPT`（取 14，落在 8 与 18 之间且不改变其余取值）。
 *
 * ⚠ `SAFETY_CHECK` 在当前生成流水线里**没有对应步骤**（`ReportGenerationService` 未做
 * 独立的安全检测调用），因此它只会出现在阶段列表里而不会被真正"进入"——如实保留枚举
 * 是为了不破坏契约，而不是假装已实现该步骤。
 */
export const STAGE_PROGRESS: Readonly<Record<ReportStage, number>> = {
  QUEUED: 0,
  BUILDING_CONTEXT: 8,
  RENDERING_PROMPT: 14,
  CALLING_MODEL: 18,
  GENERATING_SECTIONS: 45,
  SAFETY_CHECK: 88,
  PERSISTING: 96,
  DONE: 100,
  ERROR: 100,
};

/** 生成中的阶段顺序（不含 DONE / ERROR） */
const IN_FLIGHT_STAGES = REPORT_STAGES.filter((stage) => stage !== 'DONE' && stage !== 'ERROR');

/**
 * 由 `ai_reports.status` + `progress` 推导当前阶段
 *
 * 取「权重 ≤ progress 的最后一个阶段」：这样 stage 与 progress 永远单调一致，
 * 不会出现"进度 90% 却还在提示词阶段"这种自相矛盾的界面。
 *
 * Worker 若已通过 `report-live-progress.service.ts` 发布真实阶段，调用方应优先使用它
 * （见 `report-stream.service.ts`）——本函数是**没有实时数据时的兜底推导**。
 */
export const deriveStageFromStatus = (status: string, progress: number): ReportStage => {
  if (status === 'SUCCEEDED') return 'DONE';
  if (status === 'FAILED' || status === 'CANCELLED') return 'ERROR';
  if (status === 'QUEUED') return 'QUEUED';

  const clamped = Math.max(0, Math.min(100, Math.trunc(progress)));
  let current: ReportStage = 'QUEUED';

  for (const stage of IN_FLIGHT_STAGES) {
    if (STAGE_PROGRESS[stage] <= clamped) {
      current = stage;
    }
  }

  return current;
};

/** 一次生成的最长连接时长（契约 §3.5.6 规则 5：10 分钟） */
export const STREAM_MAX_DURATION_MS = 10 * 60 * 1000;

/** 心跳间隔默认值（契约 §3.5.6：默认 15s，范围 5–30s） */
export const STREAM_DEFAULT_HEARTBEAT_MS = 15_000;

export const STREAM_MIN_HEARTBEAT_MS = 5_000;

export const STREAM_MAX_HEARTBEAT_MS = 30_000;

/** 进度快照的轮询间隔（毫秒）：契约说 progress 事件"约每 2–5s"，取 2s 与轮询建议一致 */
export const STREAM_POLL_INTERVAL_MS = 2000;

/** 每个用户允许的并发 SSE 连接数（契约 §3.5.6：3 条） */
export const STREAM_MAX_CONNECTIONS_PER_USER = 3;

/**
 * 生成任务的最大尝试次数
 *
 * ⚠ 契约 §3.5.6 的事件示例写 `maxAttempts: 3`，但本项目 `ai.report` 队列**没有**单独设置
 * attempts，实际继承 `infra/queue/queue.module.ts` 的 `defaultJobOptions.attempts = 2`。
 * 这里**如实上报 2**（改队列默认值会影响所有队列，超出本任务范围），
 * 契约值与实现值的不一致已在交付报告中标注。
 */
export const REPORT_JOB_MAX_ATTEMPTS = 2;

/** 历史耗时样本条数（估算预计剩余时间用） */
const ESTIMATE_SAMPLE_SIZE = 20;

/** 无历史数据时的兜底预计耗时（秒）：报告生成典型 30–60s */
const DEFAULT_ESTIMATED_SECONDS = 40;

/**
 * 由历史生成耗时估算本次预计耗时（秒）
 *
 * 用**该用户同类型报告的实测耗时**而不是写死常量：报告生成耗时与画像复杂度、模型
 * 当前负载都相关，恒定值会让进度条要么永远早早走完、要么永远不动。样本不足时退化为兜底值。
 */
export const estimateSecondsFromHistory = (
  durationsMs: readonly number[],
  fallbackSeconds = DEFAULT_ESTIMATED_SECONDS,
): number => {
  const samples = durationsMs.filter((value) => Number.isFinite(value) && value > 0).slice(0, ESTIMATE_SAMPLE_SIZE);

  if (samples.length === 0) return fallbackSeconds;

  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;

  return Math.max(1, Math.round(average / 1000));
};

/** SSE 帧：注释行心跳（防 Nginx/网关 60s 空闲断连） */
export const SSE_HEARTBEAT_FRAME = ': ping\n\n';

/**
 * 组装一个 SSE 帧
 *
 * 手写而不用 `@Sse()` 的 `MessageEvent`：契约 §3.5.6 给出的是**原始字节流**
 * （含 `: ping` 注释行），而 `@Sse()` 只能产出 `event:`/`data:` 组合，无法表达注释心跳。
 * 另外手写可以对 `res.write` 的背压与断连做显式处理。
 */
export const formatSseFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** 流事件名（契约 §3.5.6 事件类型表） */
export const STREAM_EVENT_NAMES = ['start', 'stage', 'progress', 'section', 'usage', 'done', 'error'] as const;

export type StreamEventName = (typeof STREAM_EVENT_NAMES)[number];

/** 事件公共字段（契约示例里每个事件都有） */
export interface StreamEventBase {
  readonly requestId: string;
  readonly seq: number;
  readonly ts: string;
  readonly reportId: string;
}

/** 生成进度的归一化状态（DB 与 Redis 实时通道合并后的结果） */
export interface ReportGenerationSnapshot {
  readonly reportId: string;
  readonly status: string;
  readonly stage: ReportStage;
  readonly progress: number;
  readonly generatedWordCount: number;
  readonly targetWordCount: number;
  readonly generatedSectionCount: number;
  readonly targetSectionCount: number;
  readonly currentSectionKey: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly attempt: number;
  readonly elapsedSeconds: number;
  readonly estimatedRemainingSeconds: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly estimatedCostCents: number;
  } | null;
  /** 失败时的错误码（用于 `error` 事件的 code） */
  readonly failureCode: number | null;
}

/** 预计剩余秒数：按"已完成比例"线性外推，0 与 100 两端都不除零 */
export const estimateRemainingSeconds = (elapsedSeconds: number, progress: number): number => {
  if (progress <= 0 || progress >= 100) return progress >= 100 ? 0 : Math.max(0, elapsedSeconds);

  const remaining = (elapsedSeconds / progress) * (100 - progress);

  return Math.max(0, Math.round(remaining));
};

/** 报告状态是否已进入终态（终态后发完收尾事件即关闭连接） */
export const isTerminalStatus = (status: string): boolean =>
  status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';

/**
 * 生成进度快照 → `start` 事件
 *
 * 契约要求 `start` 在连接建立时立即推送，且带上"目标规模"与预计耗时 ——
 * 前端据此一次性渲染骨架屏，不必等第一个 `progress` 事件。
 */
export const buildStartEvent = (
  base: StreamEventBase,
  snapshot: ReportGenerationSnapshot,
  estimatedSeconds: number,
): Record<string, unknown> => ({
  ...base,
  status: snapshot.status,
  stage: snapshot.stage,
  stageLabel: REPORT_STAGE_LABELS[snapshot.stage],
  progress: snapshot.progress,
  targetSectionCount: snapshot.targetSectionCount,
  targetWordCount: snapshot.targetWordCount,
  provider: snapshot.provider,
  model: snapshot.model,
  estimatedSeconds,
});

/** 生成进度快照 → `stage` 事件 */
export const buildStageEvent = (
  base: StreamEventBase,
  snapshot: ReportGenerationSnapshot,
): Record<string, unknown> => ({
  ...base,
  status: snapshot.status,
  stage: snapshot.stage,
  stageLabel: REPORT_STAGE_LABELS[snapshot.stage],
  progress: snapshot.progress,
  elapsedSeconds: snapshot.elapsedSeconds,
  estimatedRemainingSeconds: snapshot.estimatedRemainingSeconds,
});

/** 生成进度快照 → `progress` 事件 */
export const buildProgressEvent = (
  base: StreamEventBase,
  snapshot: ReportGenerationSnapshot,
): Record<string, unknown> => ({
  ...base,
  status: snapshot.status,
  stage: snapshot.stage,
  stageLabel: REPORT_STAGE_LABELS[snapshot.stage],
  progress: snapshot.progress,
  generatedWordCount: snapshot.generatedWordCount,
  targetWordCount: snapshot.targetWordCount,
  generatedSectionCount: snapshot.generatedSectionCount,
  targetSectionCount: snapshot.targetSectionCount,
  currentSectionKey: snapshot.currentSectionKey,
  elapsedSeconds: snapshot.elapsedSeconds,
  estimatedRemainingSeconds: snapshot.estimatedRemainingSeconds,
});

/** 一个已生成分段 → `section` 事件 */
export interface StreamSectionInput {
  readonly sectionKey: string;
  readonly order: number;
  readonly title: string;
  readonly isFreePreview: boolean;
  readonly wordCount: number;
  /**
   * 免费预览片段
   *
   * ⚠ 只有**通过可见性判定**的段落才会有值（见 `buildSectionEvent`）。
   * 未解锁段落即便 `includeSectionPreview=true` 也不下发任何正文 —— 契约规则 3
   * 要求流中"绝不推送付费段落全文"，防逆向。
   */
  readonly previewText?: string | null;
}

export const buildSectionEvent = (base: StreamEventBase, section: StreamSectionInput): Record<string, unknown> => ({
  ...base,
  sectionKey: section.sectionKey,
  order: section.order,
  title: section.title,
  isFreePreview: section.isFreePreview,
  wordCount: section.wordCount,
  ...(section.previewText !== undefined && section.previewText !== null ? { previewText: section.previewText } : {}),
});

/** 生成进度快照 → `usage` 事件（仅成功结束时推送） */
export const buildUsageEvent = (
  base: StreamEventBase,
  snapshot: ReportGenerationSnapshot,
): Record<string, unknown> | null => {
  if (snapshot.usage === null) return null;

  return {
    ...base,
    promptTokens: snapshot.usage.promptTokens,
    completionTokens: snapshot.usage.completionTokens,
    totalTokens: snapshot.usage.totalTokens,
    estimatedCostCents: snapshot.usage.estimatedCostCents,
    provider: snapshot.provider,
    model: snapshot.model,
    attempt: snapshot.attempt,
    /**
     * 缓存命中
     *
     * 数据模型没有该列（`ai_reports` 无 `cacheHit`），而"是否命中缓存"在生成链路里
     * 由 `cacheKey` 复用逻辑决定、发生在入队之前。恒为 `false` 是**如实**表达
     * "本次是真实调用模型"，而不是猜一个值。
     */
    cacheHit: false,
  };
};

/** 生成进度快照 → `done` 事件 */
export const buildDoneEvent = (
  base: StreamEventBase,
  snapshot: ReportGenerationSnapshot,
  extras: { wordCount: number; sectionCount: number; isUnlocked: boolean; freePreviewRatio: number },
): Record<string, unknown> => ({
  ...base,
  status: snapshot.status,
  stage: 'DONE',
  progress: 100,
  durationMs: computeDurationMs(snapshot.startedAt, snapshot.finishedAt),
  wordCount: extras.wordCount,
  sectionCount: extras.sectionCount,
  isUnlocked: extras.isUnlocked,
  freePreviewRatio: extras.freePreviewRatio,
  detailUrl: `/api/v1/reports/${snapshot.reportId}`,
});

/**
 * `error` 事件
 *
 * `code` 取数据库里记录的真实错误码（生成失败时由 `ReportGenerationService` 写入），
 * 取不到时用 `AI_REPORT_GENERATION_FAILED`。**不把上游错误原文放进事件**：
 * 事件会直接显示在前端，也可能被用户截图，原文里含厂商名与 HTTP 状态。
 */
export const buildErrorEvent = (
  base: StreamEventBase,
  options: { code: number; message: string; canRetry: boolean; attempt: number },
): Record<string, unknown> => ({
  ...base,
  code: options.code,
  message: options.message,
  canRetry: options.canRetry,
  attempt: options.attempt,
  maxAttempts: REPORT_JOB_MAX_ATTEMPTS,
});

/** 耗时（毫秒）：任一端缺失时返回 0，避免 `NaN` 被序列化成 `null` */
export const computeDurationMs = (startedAt: string | null, finishedAt: string | null): number => {
  if (startedAt === null || finishedAt === null) return 0;

  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);

  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;

  return Math.max(0, finish - start);
};

/**
 * 取段落正文的免费预览片段
 *
 * 只对**可见**段落取正文：`visibility.content` 在未解锁时恒为 `null`（类型层面保证），
 * 因此这里天然不会读出付费正文。仍显式做一次空值判断，是为了让
 * "流中不推送付费内容"这条规则在阅读代码时看得见，而不是靠调用方自觉。
 */
export const previewTextOf = (visibility: SectionVisibility, maxLength = 120): string | null => {
  if (visibility.content === null) return null;

  const trimmed = visibility.content.trim();
  if (trimmed.length === 0) return null;

  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
};

/**
 * 生成失败 → `error` 事件的文案与可否重试
 *
 * 契约 §3.5.6 的"流已建立"错误表用的是 50009/50010/50011/50014/50019，而本项目
 * `error-code.ts` 里这几个编号另有含义（例如 50009 = 「无权访问该对话」）。错误码是对外
 * 契约、不得覆盖既有含义，因此这里按**语义**映射到本项目已有的码：
 *
 * | 契约 | 语义             | 本项目                                  |
 * | ---- | ---------------- | --------------------------------------- |
 * | 50009 | provider 调用失败 | `50000 AI_PROVIDER_UNAVAILABLE`（可重试）|
 * | 50010 | 生成超时         | `50001 AI_PROVIDER_TIMEOUT`（可重试）    |
 * | 50011 | provider 熔断    | `50000`（本项目无熔断实现，合并处理）    |
 * | 50014 | 重试耗尽         | `50018 AI_REPORT_GENERATION_FAILED`（可走 /regenerate）|
 * | 50019 | 安全审核未通过   | `50005 AI_CONTENT_BLOCKED`（不可重试）   |
 */
export const failureInfoOf = (code: number | null): { code: number; message: string; canRetry: boolean } => {
  switch (code) {
    case ErrorCode.AI_PROVIDER_TIMEOUT:
      return { code, message: 'AI 服务响应超时，请稍后重试', canRetry: true };
    case ErrorCode.AI_PROVIDER_UNAVAILABLE:
    case ErrorCode.AI_PROVIDER_RATE_LIMITED:
      return { code, message: 'AI 服务暂时不可用，请稍后重试', canRetry: true };
    case ErrorCode.AI_CONTENT_BLOCKED:
    case ErrorCode.AI_SAFETY_INTERVENTION:
      return { code, message: '内容未通过安全检测，暂时无法展示', canRetry: false };
    default:
      return {
        code: code ?? ErrorCode.AI_REPORT_GENERATION_FAILED,
        message: '报告生成失败，请重新生成',
        // 耗尽重试后仍失败 → 引导走 `/regenerate`（契约 §3.5.6 的 50014 语义）
        canRetry: true,
      };
  }
};
