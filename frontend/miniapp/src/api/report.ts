/**
 * AI 报告接口
 *
 * ## 与后端的对齐关系（重要）
 *
 * 本文件曾按**设计契约**先行编写，而后端实现晚于它落地，导致两边一度不一致
 * （类型枚举、字段名、分页信封都不同）。现已逐字段对齐以下**权威来源**：
 *
 * | 前端类型              | 后端来源                                                       |
 * | --------------------- | -------------------------------------------------------------- |
 * | `ReportType`          | `backend/src/modules/ai/report/report.dto.ts` 的 `REPORT_TYPES` |
 * | `ReportStatus`        | Prisma `AiReportStatus`                                        |
 * | `ReportCreated`       | `ReportService.ReportCreatedView`                              |
 * | `ReportProgress`      | `ReportService.ReportProgressView`                             |
 * | `ReportDetail`        | `ReportService.ReportDetailView`                               |
 * | `ReportSummary`       | `ReportService.ReportListItemView`                             |
 * | 分页信封 `items/hasNext` | 契约 §3.5.2                                                  |
 *
 * **不要照抄 `docs/API_DESIGN.md` 的示例枚举**：契约里出现过 `MBTI` / `GROWTH_REPORT`
 * / `READY` 等简写，而数据库枚举实际是 `MBTI_REPORT` / `GROWTH_SUMMARY` / `SUCCEEDED`。
 * 后端代码与 Prisma 枚举才是运行时事实源。
 *
 * ## 免费预览的服务端裁剪
 *
 * 未解锁段落由**服务端**把 `content` 置为 `null`（不是前端遮挡全文），
 * 后者抓包即可看到付费内容。前端只需根据 `content === null` 决定是否展示解锁引导。
 */

import { http } from './request';
import type { PaginatedData } from './types';

/** 报告类型（与后端 `REPORT_TYPES` 一致） */
export type ReportType = 'MBTI_REPORT' | 'BIG_FIVE_REPORT' | 'RELATIONSHIP_REPORT' | 'GROWTH_SUMMARY';

/** 报告状态（与 Prisma `AiReportStatus` 一致） */
export type ReportStatus = 'QUEUED' | 'GENERATING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** 排序字段白名单（与后端 `REPORT_SORT_FIELDS` 一致） */
export type ReportSortField = 'createdAt' | 'generatedAt' | 'updatedAt';

/** 报告分段（服务端按权益裁剪） */
export interface ReportSection {
  /** 稳定段落键（来自模板声明，如 `core_traits`），不是 id */
  sectionKey: string;
  title: string;
  order: number;
  isFreePreview: boolean;
  /** 是否已解锁（未解锁时 `content` 必为 `null`） */
  isUnlocked: boolean;
  /**
   * 正文。**未解锁时为 `null`** —— 服务端不下发正文，而非前端隐藏。
   * 前端必须显式处理 `null`，不能假设它有内容。
   */
  content: string | null;
  /** 未解锁时的引导文案（服务端下发，前端不要硬编码） */
  lockedHint: string | null;
  /** 正文字数；`content` 为 `null` 时仍可展示"约 N 字" */
  contentLength: number;
}

/** 可见性汇总（详情接口返回，用于渲染解锁进度） */
export interface ReportVisibility {
  totalSections: number;
  unlockedSections: number;
  lockedSections: number;
  isFullyUnlocked: boolean;
  isFullyLocked: boolean;
}

/** 列表摘要统计（口径为**该用户全部报告**，不随筛选与翻页变化） */
export interface ReportListSummary {
  totalReports: number;
  unlockedReports: number;
  generatingReports: number;
  failedReports: number;
  latestReportId: string | null;
}

/** 报告摘要（列表项） */
export interface ReportSummary {
  reportId: string;
  type: ReportType;
  /** 服务端给出的类型中文名，前端**不要**再维护一份映射表 */
  typeName: string;
  title: string | null;
  status: ReportStatus;
  mbtiType: string | null;
  engineVersion: string | null;
  /** 正文字数（中文语境下即字符数） */
  wordCount: number;
  sectionCount: number;
  freePreviewRatio: number;
  isUnlocked: boolean;
  unlockType: 'REPORT_UNLOCK' | 'MEMBERSHIP_ACTIVE' | null;
  provider: string | null;
  model: string | null;
  totalTokens: number;
  generationDurationMs: number;
  createdAt: string;
  generatedAt: string | null;
  /** 约 120 字的预览摘要，可直接渲染；失败或无可读段落时为 `null` */
  previewText: string | null;
  hasPdf: boolean;
  shareCardUrl: string | null;
  /** 仅 `FAILED` 项存在，且为**友好文案**（后端不透出上游错误原文） */
  failureReason?: string;
}

/** 报告列表响应（信封 + `summary`） */
export interface ReportListData extends PaginatedData<ReportSummary> {
  summary: ReportListSummary;
}

/** 报告详情 */
export interface ReportDetail {
  reportId: string;
  type: ReportType;
  /** 服务端给出的类型中文名 */
  typeName: string;
  status: ReportStatus;
  title: string | null;
  summary: string | null;
  sectionCount: number;
  sections: ReportSection[];
  visibility: ReportVisibility;
  /** 该报告绑定画像的 MBTI（无画像时为 `null`） */
  mbtiType: string | null;
  engineVersion: string | null;
  provider: string | null;
  model: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 创建报告的受理结果 */
export interface ReportCreated {
  reportId: string;
  status: ReportStatus;
  /**
   * 是否复用了既有报告
   *
   * 同一份画像 + 同一 Prompt 版本 + 同一模型产出的报告必然相同，因此重复请求会
   * 命中缓存直接复用 —— 用户不会为同一内容付两次费。前端据此可跳过轮询。
   */
  isReused: boolean;
  /** 轮询地址（服务端下发，前端不要自己拼） */
  pollUrl: string;
}

/** 生成进度 */
export interface ReportProgress {
  reportId: string;
  status: ReportStatus;
  /** 0-100 */
  progress: number;
  /** 失败时的业务错误码（数字），成功时为 `null` */
  errorCode: number | null;
  errorMessage: string | null;
  requestedAt: string;
  finishedAt: string | null;
}

/**
 * 生成阶段文案
 *
 * 后端 `ReportProgressView` **没有** `stage` 字段（进度只有数值 + 状态），
 * 因此阶段文案在前端按状态推导。若日后后端下发真实阶段，替换本函数即可。
 */
export const progressStageLabel = (status: ReportStatus | undefined, progress: number): string => {
  switch (status) {
    case 'QUEUED':
      return '排队中，即将开始…';
    case 'GENERATING':
      return progress < 40 ? '正在分析人格特征…' : '正在撰写解读内容…';
    case 'FAILED':
      return '生成失败';
    case 'CANCELLED':
      return '已取消';
    default:
      return '正在处理…';
  }
};

/** 列表查询参数 */
export interface ListReportsQuery {
  page?: number;
  pageSize?: number;
  /** 逗号分隔多选 */
  type?: string;
  /** 逗号分隔多选 */
  status?: string;
  sortBy?: ReportSortField;
  order?: 'asc' | 'desc';
}

/**
 * 创建个人人格报告（异步）
 *
 * 返回 `202`。`isReused` 为 `true` 时报告已就绪，无需轮询进度。
 */
export const createReport = (payload: { type: ReportType; sessionId?: string }): Promise<ReportCreated> =>
  http.post<ReportCreated>('/reports', payload, { timeout: 20_000 });

/**
 * 报告列表
 *
 * 只返回元信息与预览摘要（无分段正文）。进行中的报告由服务端置顶并已参与分页，
 * 前端**不要**再做一次本地重排 —— 那会打乱服务端算好的分页区间，导致
 * 某些报告重复出现或被跳过。
 */
export const listReports = (query: ListReportsQuery = {}): Promise<ReportListData> =>
  http.get<ReportListData>('/reports', { ...query });

/** 报告详情（服务端按权益裁剪，未解锁段落 `content` 为 `null`） */
export const getReport = (reportId: string): Promise<ReportDetail> => http.get<ReportDetail>(`/reports/${reportId}`);

/** 轮询生成进度（静默失败：调用方自己决定重试节奏） */
export const getReportProgress = (reportId: string): Promise<ReportProgress> =>
  http.get<ReportProgress>(`/reports/${reportId}/progress`, undefined, { showError: false });

/** 重新生成报告（需会员权益） */
export const regenerateReport = (reportId: string): Promise<ReportCreated> =>
  http.post<ReportCreated>(`/reports/${reportId}/regenerate`, {});

/** 导出 PDF（异步，返回下载 URL 需 OSS 签名） */
export const exportReportPdf = (reportId: string): Promise<{ taskId: string }> =>
  http.post<{ taskId: string }>(`/reports/${reportId}/export-pdf`, {});

/** 生成分享图 */
export const createShareCard = (reportId: string): Promise<{ imageUrl: string }> =>
  http.post<{ imageUrl: string }>(`/reports/${reportId}/share-card`, {}, { timeout: 30_000 });
