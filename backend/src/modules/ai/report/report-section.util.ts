/**
 * 报告分段列表（契约 §3.5.4）的纯逻辑
 *
 * ## 为什么单独成文件而不是写进 Service
 *
 * 本文件只做一件事：把 `report-visibility.ts` 已经判定好的**可见性**翻译成
 * 契约 §3.5.4 的字段形状（`locked` / `isTruncated` / `previewWordCount` / 阅读时长…）。
 *
 * ⚠ **这里绝不重新判断"该不该给正文"**。判定只有一个入口（`report-visibility.ts`），
 * 本文件只做字段映射。理由是 ADR-004：一旦出现第二处"要不要给正文"的判断，
 * 两个接口迟早会因为边界理解不同而分叉，而分叉的方向通常是"其中一个忘了锁"。
 * 字段映射可以被测到穷尽，可见性判定则必须保持单点。
 */

import type { SectionVisibility } from './report-visibility';

/**
 * 契约 §3.5.4 Query `sectionKey` 的枚举
 *
 * 顺序即报告内的自然段序，取值与生成模板（Prompt 输出 schema）的段落键一致；
 * 这里用字面量联合类型而不是 `string`，让"模板加了新段落、接口忘了登记"
 * 变成编译期问题而不是线上 400。
 */
export const REPORT_SECTION_KEYS = [
  'CORE_PORTRAIT',
  'DIMENSION_ANALYSIS',
  'RELATIONSHIP_PATTERN',
  'STRENGTHS_AND_SHADOWS',
  'GROWTH_SUGGESTIONS',
  'ACTION_PLAN',
] as const;

export type ReportSectionKey = (typeof REPORT_SECTION_KEYS)[number];

/** 正文格式（契约固定 `MARKDOWN`，前端渲染前必须经白名单清洗） */
export const SECTION_CONTENT_FORMAT = 'MARKDOWN';

/**
 * 未解锁段的提示文案
 *
 * 与 `report-visibility.ts` 的 `lockedHint`（"解锁后可阅读本段完整内容"）是**两份不同的文案**：
 * 详情接口用后者，本接口按契约 §3.5.4 的示例用前者。文案不同不影响安全性
 * （两者都不含正文片段），但前端会把它直接展示在锁定卡片上，因此必须逐字与契约一致。
 */
export const SECTION_LOCKED_REASON = '需要解锁报告全文';

/** 阅读速度（字/分钟，契约 §3.5.4 规则 2） */
export const READING_WORDS_PER_MINUTE = 400;

/**
 * 预估阅读时长（秒）
 *
 * 契约示例的 6 段里有 5 段等于 `ceil(字数 / 400 * 60)`，唯一不符的一段（1180 → 示例 178、
 * 计算 177）应当是示例四舍五入的笔误。**取整方向选向上**：宁可让用户觉得"稍微多花一点时间"，
 * 也不要少报导致读一半发现还有内容。
 */
export const readingTimeSeconds = (wordCount: number): number => {
  if (wordCount <= 0) return 0;

  return Math.ceil((wordCount / READING_WORDS_PER_MINUTE) * 60);
};

/** 分段列表项（契约 §3.5.4 的 `items[]`） */
export interface ReportSectionItemView {
  readonly sectionId: string;
  readonly sectionKey: string;
  readonly order: number;
  readonly title: string;
  /**
   * 副标题
   *
   * ⚠ 数据模型缺口：`report_sections` **没有** subtitle 列（`schema.prisma` 禁止修改），
   * 因此恒为 `null`。契约示例给了中文副标题（"四个字母背后的你"），
   * 在补列之前**不伪造**该字段 —— 前端应对 `null` 做降级（只显示 title）。
   */
  readonly subtitle: string | null;
  readonly isFreePreview: boolean;
  /** 正文是否被裁剪（未解锁即为 true；解锁后为 false） */
  readonly isTruncated: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  /** 该段完整字数（**未解锁也下发**：只暴露体量，不算内容泄露） */
  readonly wordCount: number;
  /** 当前可读到的字数（未解锁为 0） */
  readonly previewWordCount: number;
  /** 正文；`includeContent=false` 时**整字段不下发**（契约规则 3），未解锁时为 `null` */
  readonly content?: string | null;
  readonly contentFormat: string;
  readonly readingTimeSeconds: number;
}

/** 分段列表视图（契约 §3.5.4 的 `data`） */
export interface ReportSectionsView {
  readonly reportId: string;
  readonly status: string;
  /** 整份报告是否已解锁（会员 / 单份购买），不是"是否存在可读段" */
  readonly isUnlocked: boolean;
  readonly freePreviewRatio: number;
  readonly totalWordCount: number;
  readonly freePreviewWordCount: number;
  readonly items: readonly ReportSectionItemView[];
  readonly lockedCount: number;
  readonly unlockedCount: number;
}

/** 单段视图的输入（`id` 来自数据库，其余来自可见性判定） */
export interface SectionMeta {
  readonly sectionId: string;
}

/**
 * 可见性 → 分段列表项
 *
 * `sectionId` 由调用方通过 `sectionKey` 查表补上：`buildSectionViews`（可见性判定）
 * 刻意不返回数据库主键，以免"判定"与"取数"耦合；而 `(reportId, sectionKey)` 在
 * `report_sections` 上有唯一约束，因此按键查表是安全的。
 */
export const toSectionItemView = (
  visibility: SectionVisibility,
  sectionId: string,
  includeContent: boolean,
): ReportSectionItemView => {
  const locked = !visibility.isUnlocked;
  const wordCount = visibility.contentLength;

  return {
    sectionId,
    sectionKey: visibility.sectionKey,
    order: visibility.order,
    title: visibility.title,
    // 见 `ReportSectionItemView.subtitle` 的说明：数据库没有这一列
    subtitle: null,
    isFreePreview: visibility.isFreePreview,
    isTruncated: locked,
    locked,
    lockedReason: locked ? SECTION_LOCKED_REASON : null,
    wordCount,
    // 未解锁时"可读字数"是 0，而不是字数本身 —— 否则前端会显示"已显示 620 字"却什么都没有
    previewWordCount: locked ? 0 : wordCount,
    // 契约规则 3：`includeContent=false` 时目录里**根本不该有 content 字段**
    // （而不是给一个 null 让前端自己判断）
    ...(includeContent ? { content: visibility.content } : {}),
    contentFormat: SECTION_CONTENT_FORMAT,
    readingTimeSeconds: readingTimeSeconds(wordCount),
  };
};

/**
 * 统计锁定/解锁段数
 *
 * 契约 §3.5.4 的示例里 `lockedCount=4`、`unlockedCount=0`，而 6 段中有 2 段免费可读
 * （`locked=false`）—— 说明 `unlockedCount` 统计的是**付费段中已解锁的数量**，
 * 而不是"可读段数"。据此实现，并保证不变量：
 *
 * ```
 * lockedCount + unlockedCount + 免费段数 == items 总数
 * ```
 *
 * 契约对这两个字段的统计口径没有正文说明（只有示例），已在交付报告中标注。
 */
export const countSections = (
  items: readonly ReportSectionItemView[],
): { lockedCount: number; unlockedCount: number } => {
  let lockedCount = 0;
  let unlockedCount = 0;

  for (const item of items) {
    if (item.locked) {
      lockedCount += 1;
    } else if (!item.isFreePreview) {
      unlockedCount += 1;
    }
  }

  return { lockedCount, unlockedCount };
};

/** 分段列表的组装入参（计数必须基于**全报告**，见契约规则 4） */
export interface BuildSectionsInput {
  readonly reportId: string;
  readonly status: string;
  readonly isUnlocked: boolean;
  readonly freePreviewRatio: number;
  readonly totalWordCount: number;
  readonly freePreviewWordCount: number;
  readonly visibility: readonly SectionVisibility[];
  readonly sectionIdByKey: ReadonlyMap<string, string>;
  readonly includeContent: boolean;
  /** 只取单个分段（懒加载场景）；计数仍按全报告统计 */
  readonly sectionKey?: string;
}

/**
 * 组装分段列表
 *
 * `sectionKey` 过滤发生在**计数之后**：契约规则 4 明确"单段请求时 `lockedCount`/`unlockedCount`
 * 按全报告统计"。先过滤再计数会让前端目录上的"还剩 4 段未解锁"在懒加载后变成"还剩 0 段"。
 */
export const buildSectionsView = (input: BuildSectionsInput): ReportSectionsView => {
  const allItems = input.visibility.map((visibility) =>
    toSectionItemView(
      visibility,
      // 查不到 id 时退化为空串会让前端拿不到锚点；但这条分支只在数据被手工改动时可达，
      // 用 sectionKey 兜底比抛 500 更合适（响应仍可渲染，只是缺少稳定的段 ID）
      input.sectionIdByKey.get(visibility.sectionKey) ?? visibility.sectionKey,
      input.includeContent,
    ),
  );

  const { lockedCount, unlockedCount } = countSections(allItems);

  const items =
    input.sectionKey === undefined ? allItems : allItems.filter((item) => item.sectionKey === input.sectionKey);

  return {
    reportId: input.reportId,
    status: input.status,
    isUnlocked: input.isUnlocked,
    freePreviewRatio: input.freePreviewRatio,
    totalWordCount: input.totalWordCount,
    freePreviewWordCount: input.freePreviewWordCount,
    items,
    lockedCount,
    unlockedCount,
  };
};
