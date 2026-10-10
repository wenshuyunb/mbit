/**
 * 报告列表纯逻辑（无 I/O、可 100% 单测）
 *
 * 为什么单独成文件：契约 §3.5.2 的列表响应里有一半字段是**推导**出来的
 * （免费预览占比、生成耗时、类型中文名、摘要统计），还有一条「进行中的报告排最前」
 * 的分页规则 —— 这类逻辑写在 `ReportService` 里只能用 mock 间接覆盖，
 * 且「跨两个集合分页」的边界（页码正好落在切分点）极难构造。
 * 抽出来后可以直接把边界全部枚举出来测（ADR-027 的同一思路）。
 */

/** 排序字段白名单（契约 §3.5.2：不在白名单 → `10004`） */
export const REPORT_SORT_FIELDS = ['createdAt', 'generatedAt', 'updatedAt'] as const;

/** 排序字段取值 */
export type ReportSortField = (typeof REPORT_SORT_FIELDS)[number];

/** 排序方向（契约 §3.5.2，默认 `desc`） */
export const REPORT_SORT_ORDERS = ['asc', 'desc'] as const;

/** 排序方向取值 */
export type ReportSortOrder = (typeof REPORT_SORT_ORDERS)[number];

/** 状态筛选白名单（与 Prisma `AiReportStatus` 一致，契约 §3.5.2） */
export const REPORT_STATUS_FILTERS = ['QUEUED', 'GENERATING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/** 状态筛选取值 */
export type ReportStatusFilter = (typeof REPORT_STATUS_FILTERS)[number];

/**
 * 「进行中」的状态集合
 *
 * 单独抽出来是因为它有两处用途，且**两处必须一致**：
 *   ① 排序上要把这些报告置顶（契约 §3.5.2 规则 5）
 *   ② 分页时它们构成虚拟列表的前半段
 * 若两处各写一份字面量，日后加入新状态时只改一处，就会出现「置顶了但没参与分页
 * 计算」→ 某条报告重复出现或被跳过。
 */
export const ACTIVE_REPORT_STATUSES = ['QUEUED', 'GENERATING'] as const;

/** 报告类型的中文名（契约 §3.5.2 的 `typeName`） */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  MBTI_REPORT: '人格深度报告',
  BIG_FIVE_REPORT: '大五人格报告',
  RELATIONSHIP_REPORT: '关系匹配报告',
  GROWTH_SUMMARY: '成长回顾报告',
};

/** 类型中文名；未知类型回落到原始值而非空串（便于发现新增类型未登记） */
export const reportTypeName = (type: string): string => TYPE_NAMES[type] ?? type;

/** 分页上限（契约 §3.5.2：`pageSize ≤ 100`，超出 → `10005`） */
export const MAX_PAGE_SIZE = 100;

/** 默认每页条数（契约 §3.5.2） */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * 免费预览占比
 *
 * 契约字段是 `freePreviewRatio`（示例 `0.2`）。**除以零必须挡住**：失败的报告
 * `contentLength` 为 0，直接相除得到 `NaN`，`NaN` 会被 `JSON.stringify` 序列化成
 * `null`，前端拿到的就不是数字 —— 这类"看起来是数据问题、实际是序列化副作用"的
 * 缺陷最难定位。内容为空时明确返回 0。
 */
export const computeFreePreviewRatio = (freePreviewLength: number, contentLength: number): number => {
  if (contentLength <= 0) return 0;

  const ratio = freePreviewLength / contentLength;
  // 夹到 [0,1]：数据异常（预览长度大于总长）时不应给出 >1 的占比
  return Math.min(1, Math.max(0, Number(ratio.toFixed(4))));
};

/**
 * 生成耗时（毫秒）
 *
 * 优先用「开始 → 结束」的墙钟时间差（这是用户实际等待的时长）；
 * 缺失时回落到 `latencyMs`（单次模型调用耗时）。二者不可混用：
 * 一次生成可能包含多次调用与重试，墙钟时间通常明显大于单次延迟。
 */
export const computeGenerationDurationMs = (
  startedAt: Date | null,
  finishedAt: Date | null,
  latencyMs: number | null,
): number => {
  if (startedAt !== null && finishedAt !== null) {
    return Math.max(0, finishedAt.getTime() - startedAt.getTime());
  }

  return Math.max(0, latencyMs ?? 0);
};

/**
 * 失败原因的**对外**文案
 *
 * 契约 §3.5.2 规则 6 明确要求：返回友好文案，**不得暴露内部错误细节**。
 * 因此这里不使用 `ai_reports.error_message` —— 它保存的是上游原文
 * （可能含 Provider 名称、HTTP 状态、甚至请求片段）。把上游错误原文回给
 * 客户端等于免费泄露技术栈与内部结构，是渗透测试的常见入口。
 */
export const friendlyFailureReason = (): string => 'AI 服务暂时不可用，请重新生成';

/** 置顶分页的取数指令 */
export interface PinnedPaginationPlan {
  readonly activeSkip: number;
  readonly activeTake: number;
  readonly inactiveSkip: number;
  readonly inactiveTake: number;
}

/**
 * 计算「置顶列表 + 普通列表」拼成的虚拟列表在某一页的取数区间
 *
 * 契约 §3.5.2 规则 5 要求进行中的报告排最前。这看似只是排序，但对分页有真实影响：
 * 若只在**当前页内**重排，一条在第 2 页的进行中报告永远不会浮到第 1 页，
 * 而"让用户立刻看到正在生成的任务"正是这条规则的目的。
 *
 * 因此在逻辑上构造 `[进行中..., 其余...]` 的虚拟列表，再按 `skip/take` 落回
 * 两个真实查询。本函数只做算术，不查库。
 *
 * @param activeTotal 进行中的报告总数
 * @param inactiveTotal 其余报告总数（已应用筛选条件）
 * @param page 页码，从 1 开始
 * @param pageSize 每页条数
 */
export const planPinnedPagination = (
  activeTotal: number,
  inactiveTotal: number,
  page: number,
  pageSize: number,
): PinnedPaginationPlan => {
  // 防御非法入参：算出负数区间会让 Prisma 抛错，而这里的调用方是 Service，
  // 不该因为分页参数越界而 500（越界由 DTO 层拦成 10005）
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.max(0, Math.floor(pageSize));
  const skip = (safePage - 1) * safePageSize;

  const activeSkip = Math.min(skip, activeTotal);
  const activeTake = Math.max(0, Math.min(activeTotal - activeSkip, safePageSize));

  // ⚠ 必须同时夹上界。只写 `Math.max(0, skip - activeTotal)` 时，页码越过末页
  // 会得到远大于 inactiveTotal 的 skip（例如 1960），Prisma 虽只返回空数组不会报错，
  // 但「skip 落在集合内」这条不变量被破坏 —— 而后续任何基于该区间的计算
  // （如把它换算成全局序号）都会算出一个不存在的位置。
  const inactiveSkip = Math.min(Math.max(0, skip - activeTotal), inactiveTotal);
  const inactiveTake = Math.max(0, Math.min(inactiveTotal - inactiveSkip, safePageSize - activeTake));

  return { activeSkip, activeTake, inactiveSkip, inactiveTake };
};

/** 列表摘要统计的原始输入 */
export interface ReportSummaryInput {
  readonly totalReports: number;
  readonly unlockedReports: number;
  readonly generatingReports: number;
  readonly failedReports: number;
  readonly latestReportId: string | null;
}

/** 列表摘要（契约 §3.5.2 的 `summary`） */
export interface ReportListSummary {
  readonly totalReports: number;
  readonly unlockedReports: number;
  readonly generatingReports: number;
  readonly failedReports: number;
  readonly latestReportId: string | null;
}

/**
 * 组装摘要
 *
 * 这些数字必须统计**该用户的全部报告**，而不是当前页 —— 否则用户翻到第 2 页时
 * 「共 3 份报告」会变成「共 1 份」，看起来像数据丢了。因此 Service 侧用的是
 * 独立的 `count` 查询，而非对当前页做 `length`。
 */
export const buildListSummary = (input: ReportSummaryInput): ReportListSummary => ({
  totalReports: input.totalReports,
  unlockedReports: input.unlockedReports,
  generatingReports: input.generatingReports,
  failedReports: input.failedReports,
  latestReportId: input.latestReportId,
});

/**
 * 预览文本
 *
 * 契约 §3.5.2 说明 `previewText` 约 120 字、可直接在列表页展示。
 * 这里按**字符**截断并加省略号：中文按字符数截断才符合"120 字"的直觉，
 * 按字节截断会把一个汉字切成两半，产生乱码。
 */
export const PREVIEW_TEXT_MAX_LENGTH = 120;

export const buildPreviewText = (content: string | null, maxLength = PREVIEW_TEXT_MAX_LENGTH): string | null => {
  if (content === null) return null;

  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= maxLength) return trimmed;

  return `${trimmed.slice(0, maxLength)}…`;
};
