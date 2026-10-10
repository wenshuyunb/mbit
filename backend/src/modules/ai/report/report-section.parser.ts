/**
 * 报告分段解析（纯函数，无 I/O、可 100% 单测）
 *
 * ADR-004 要求报告**分段落库**，以支持「按段免费预览、按段付费解锁、按段重新生成」。
 * 这一切的前提是：**每次生成出的同一段落，其 `sectionKey` 必须稳定** ——
 * 否则用户今天解锁的「核心优势」明天就变成另一段，付费权益无从追溯。
 *
 * 因此本模块不接受「模型想给几段就给几段」：段落键与免费标记由**模板声明**
 * （`PromptVersion.outputSchema`）给出，模型只负责按顺序生产内容。
 * 模型多写的段落按 `extra-{n}` 兜底保留（内容不能丢），少写的段落则不存在。
 *
 * 模型输出格式约定（供模板作者遵循）：
 *
 * ```
 * ## 段落标题
 * 段落正文……
 *
 * ## 下一个段落标题
 * ……
 * ```
 *
 * 首个标题之前的内容视为**引言**（preamble），单独返回 —— 它通常是对整份报告的
 * 一句话概括，适合放进列表页，而不是充当一个付费段落。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';

/** 模板声明的段落（顺序即报告中的展示顺序） */
export interface ExpectedSection {
  /** 稳定的段落键（被付费权益引用，一经发布不可更改） */
  readonly key: string;
  /** 默认标题（模型未给标题或标题缺失时使用） */
  readonly title: string;
  /** 是否为免费预览段 */
  readonly freePreview: boolean;
}

/** 解析出的段落草稿 */
export interface ReportSectionDraft {
  readonly sectionKey: string;
  readonly title: string;
  readonly content: string;
  readonly order: number;
  readonly isFreePreview: boolean;
}

/** 解析结果 */
export interface ParsedReport {
  /** 首个标题之前的内容（可能是空串） */
  readonly preamble: string;
  readonly sections: readonly ReportSectionDraft[];
  /** 全文长度（含标题与引言，用于 `contentLength`） */
  readonly contentLength: number;
  /** 免费预览部分的总长度（用于 `freePreviewLength`） */
  readonly freePreviewLength: number;
  /** 模型多产出的段落键（内容被保留但未在模板声明中，需人工复核） */
  readonly extraSectionKeys: readonly string[];
  /** 因内容为空而被丢弃的段落键（不占用付费段位） */
  readonly droppedSectionKeys: readonly string[];
}

/** 标题行：1–4 级 Markdown 标题 */
const headingPattern = (): RegExp => /^#{1,4}\s+(.+?)\s*$/;

/** 模型多产出段落的兜底键前缀 */
const EXTRA_SECTION_PREFIX = 'extra';

/**
 * 解析报告正文为结构化段落
 *
 * 空内容直接抛 `AI_OUTPUT_INVALID`：一份没有任何正文的报告不是"分段失败"，
 * 而是本次生成无效，应当走重试而不是落库一条空报告。
 */
export const parseReportSections = (rawContent: string, expected: readonly ExpectedSection[]): ParsedReport => {
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    throw new BusinessException(ErrorCode.AI_OUTPUT_INVALID, 'AI 返回的报告内容为空');
  }

  const lines = rawContent.split(/\r?\n/);

  const preambleLines: string[] = [];
  /** 逐段累积：[标题, 正文行] */
  const blocks: Array<{ title: string; lines: string[] }> = [];

  for (const line of lines) {
    const matched = headingPattern().exec(line);

    if (matched !== null) {
      blocks.push({ title: matched[1], lines: [] });
      continue;
    }

    if (blocks.length === 0) {
      preambleLines.push(line);
    } else {
      blocks[blocks.length - 1].lines.push(line);
    }
  }

  // 没有任何标题：整篇作为一个段落，键取模板第一段（避免把合法内容判为无效）
  if (blocks.length === 0) {
    const key = expected[0]?.key ?? `${EXTRA_SECTION_PREFIX}-1`;

    return {
      preamble: '',
      sections: [
        {
          sectionKey: key,
          title: expected[0]?.title ?? '报告正文',
          content: rawContent.trim(),
          order: 0,
          isFreePreview: expected[0]?.freePreview ?? false,
        },
      ],
      contentLength: rawContent.length,
      freePreviewLength: expected[0]?.freePreview === true ? rawContent.trim().length : 0,
      extraSectionKeys: [],
      droppedSectionKeys: [],
    };
  }

  const sections: ReportSectionDraft[] = [];
  const extraSectionKeys: string[] = [];
  const droppedSectionKeys: string[] = [];

  let extraCounter = 0;

  for (const [index, block] of blocks.entries()) {
    const declared = expected[index];
    const content = block.lines.join('\n').trim();

    // 分配稳定的段落键：优先用模板声明，多出的用兜底键
    const sectionKey = declared?.key ?? `${EXTRA_SECTION_PREFIX}-${(extraCounter += 1)}`;
    if (declared === undefined) extraSectionKeys.push(sectionKey);

    // 模型只给了标题没给正文：丢弃而不是保留空段 ——
    // 空段会在前端渲染成空白付费卡片，且占用「按段解锁」的段位
    if (content.length === 0) {
      droppedSectionKeys.push(sectionKey);
      continue;
    }

    sections.push({
      sectionKey,
      // 标题以模板声明为准（保证同一段落标题稳定），模型标题仅在模板未声明时使用
      title: declared?.title ?? block.title,
      content,
      order: sections.length,
      isFreePreview: declared?.freePreview ?? false,
    });
  }

  const freePreviewLength = sections
    .filter((section) => section.isFreePreview)
    .reduce((total, section) => total + section.content.length, 0);

  return {
    preamble: preambleLines.join('\n').trim(),
    sections,
    contentLength: rawContent.length,
    freePreviewLength,
    extraSectionKeys,
    droppedSectionKeys,
  };
};

/**
 * 从模板的 `outputSchema` 中提取段落声明
 *
 * 容错优先：`outputSchema` 是后台可编辑的 JSON，格式出错时返回空数组
 * （调用方据此退化为「整篇一段」），而不是让报告生成整体失败 ——
 * 后台配置错误不应该让线上功能不可用。
 */
export const readExpectedSections = (outputSchema: unknown): ExpectedSection[] => {
  if (typeof outputSchema !== 'object' || outputSchema === null || Array.isArray(outputSchema)) {
    return [];
  }

  const sections = (outputSchema as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return [];

  const result: ExpectedSection[] = [];

  for (const item of sections) {
    if (typeof item !== 'object' || item === null) continue;

    const candidate = item as { key?: unknown; title?: unknown; freePreview?: unknown };
    if (typeof candidate.key !== 'string' || candidate.key.length === 0) continue;

    result.push({
      key: candidate.key,
      title: typeof candidate.title === 'string' && candidate.title.length > 0 ? candidate.title : candidate.key,
      freePreview: candidate.freePreview === true,
    });
  }

  return result;
};
