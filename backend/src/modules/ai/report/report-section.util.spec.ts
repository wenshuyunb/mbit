/**
 * 报告分段列表纯逻辑测试（契约 §3.5.4）
 *
 * 重点：
 *   · 字段映射（locked / isTruncated / previewWordCount / 阅读时长）逐项对齐契约示例；
 *   · `includeContent=false` 时**不产生 content 字段**（不是 null）；
 *   · 计数口径（`lockedCount` + `unlockedCount` + 免费段数 == 总数）。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import {
  REPORT_SECTION_KEYS,
  SECTION_CONTENT_FORMAT,
  SECTION_LOCKED_REASON,
  buildSectionsView,
  countSections,
  readingTimeSeconds,
  toSectionItemView,
  type ReportSectionItemView,
} from './report-section.util';
import type { SectionVisibility } from './report-visibility';

const visibilityOf = (overrides: Partial<SectionVisibility> = {}): SectionVisibility => ({
  sectionKey: 'CORE_PORTRAIT',
  title: '你的核心画像',
  order: 1,
  isFreePreview: true,
  isUnlocked: true,
  content: '正文',
  lockedHint: null,
  contentLength: 1180,
  ...overrides,
});

describe('readingTimeSeconds（契约规则 2：按 400 字/分钟估算）', () => {
  it.each([
    [1180, 177],
    [940, 141],
    [620, 93],
    [380, 57],
    [96, 15],
    [68, 11],
  ])('%i 字 → %i 秒（向上取整）', (wordCount, expected) => {
    expect(readingTimeSeconds(wordCount)).toBe(expected);
  });

  it('空内容为 0（不显示"预计阅读 1 分钟"）', () => {
    expect(readingTimeSeconds(0)).toBe(0);
  });
});

describe('toSectionItemView', () => {
  it('已解锁段：locked=false、isTruncated=false、previewWordCount=wordCount', () => {
    const item = toSectionItemView(visibilityOf(), 'section-1', true);

    expect(item).toMatchObject({
      sectionId: 'section-1',
      sectionKey: 'CORE_PORTRAIT',
      order: 1,
      title: '你的核心画像',
      isFreePreview: true,
      isTruncated: false,
      locked: false,
      lockedReason: null,
      wordCount: 1180,
      previewWordCount: 1180,
      content: '正文',
      contentFormat: SECTION_CONTENT_FORMAT,
    });
  });

  it('【关键】未解锁段：content 为 null、lockedReason 为契约文案、previewWordCount 为 0', () => {
    const locked = toSectionItemView(
      visibilityOf({ isFreePreview: false, isUnlocked: false, content: null, lockedHint: '解锁后可阅读本段完整内容' }),
      'section-2',
      true,
    );

    expect(locked.content).toBeNull();
    expect(locked.locked).toBe(true);
    expect(locked.isTruncated).toBe(true);
    expect(locked.lockedReason).toBe(SECTION_LOCKED_REASON);
    expect(locked.previewWordCount).toBe(0);
    // 字数元数据仍下发（只暴露体量）
    expect(locked.wordCount).toBe(1180);
    expect(locked.readingTimeSeconds).toBe(177);
  });

  it('includeContent=false 时不产生 content 字段', () => {
    const item = toSectionItemView(visibilityOf(), 'section-1', false);

    expect(Object.prototype.hasOwnProperty.call(item, 'content')).toBe(false);
  });

  it('subtitle 恒为 null（数据库没有该列，不伪造）', () => {
    expect(toSectionItemView(visibilityOf(), 'section-1', true).subtitle).toBeNull();
  });
});

describe('countSections', () => {
  const item = (locked: boolean, isFreePreview: boolean): ReportSectionItemView =>
    toSectionItemView(
      visibilityOf({
        isFreePreview,
        isUnlocked: !locked,
        content: locked ? null : '正文',
      }),
      'section-x',
      true,
    );

  it('lockedCount 统计锁定段；unlockedCount 统计"付费段中已解锁"的数量', () => {
    const items = [item(false, true), item(true, false), item(true, false)];

    expect(countSections(items)).toEqual({ lockedCount: 2, unlockedCount: 0 });
  });

  it('整份解锁：lockedCount=0，unlockedCount=付费段数（免费段不计入）', () => {
    const items = [item(false, true), item(false, false), item(false, false)];

    expect(countSections(items)).toEqual({ lockedCount: 0, unlockedCount: 2 });
  });

  it('不变量：lockedCount + unlockedCount + 免费段数 == 总数', () => {
    // 只组合**可达**的状态：`isFreePreview = true` 的段落永远判定为已解锁
    // （见 `report-visibility.isSectionUnlocked`），因此不存在"免费且锁定"
    const items = [item(false, true), item(false, false), item(true, false), item(false, true)];
    const { lockedCount, unlockedCount } = countSections(items);
    const freeCount = items.filter((entry) => entry.isFreePreview).length;

    expect(lockedCount + unlockedCount + freeCount).toBe(items.length);
  });
});

describe('buildSectionsView', () => {
  const baseInput = {
    reportId: 'report-1',
    status: 'SUCCEEDED',
    isUnlocked: false,
    freePreviewRatio: 0.2,
    totalWordCount: 3284,
    freePreviewWordCount: 656,
    sectionIdByKey: new Map([
      ['CORE_PORTRAIT', 'section-1'],
      ['DIMENSION_ANALYSIS', 'section-2'],
    ]),
    includeContent: true,
  };

  it('按可见性逐段映射，并带上报告级汇总字段', () => {
    const view = buildSectionsView({
      ...baseInput,
      visibility: [
        visibilityOf({ sectionKey: 'CORE_PORTRAIT', order: 1, isFreePreview: true, isUnlocked: true }),
        visibilityOf({
          sectionKey: 'DIMENSION_ANALYSIS',
          order: 2,
          isFreePreview: false,
          isUnlocked: false,
          content: null,
        }),
      ],
    });

    expect(view).toMatchObject({
      reportId: 'report-1',
      status: 'SUCCEEDED',
      isUnlocked: false,
      freePreviewRatio: 0.2,
      totalWordCount: 3284,
      freePreviewWordCount: 656,
      lockedCount: 1,
      unlockedCount: 0,
    });
    expect(view.items.map((item) => item.sectionId)).toEqual(['section-1', 'section-2']);
  });

  it('sectionKey 过滤在计数之后（契约规则 4：计数按全报告）', () => {
    const view = buildSectionsView({
      ...baseInput,
      sectionKey: 'DIMENSION_ANALYSIS',
      visibility: [
        visibilityOf({ sectionKey: 'CORE_PORTRAIT', order: 1, isFreePreview: true, isUnlocked: true }),
        visibilityOf({
          sectionKey: 'DIMENSION_ANALYSIS',
          order: 2,
          isFreePreview: false,
          isUnlocked: false,
          content: null,
        }),
      ],
    });

    expect(view.items).toHaveLength(1);
    expect(view.lockedCount).toBe(1);
  });

  it('段落在数据库里查不到 id 时退化为用 sectionKey 兜底（不抛错）', () => {
    const view = buildSectionsView({
      ...baseInput,
      sectionIdByKey: new Map(),
      visibility: [visibilityOf({ sectionKey: 'STRENGTHS_AND_SHADOWS' })],
    });

    expect(view.items[0]?.sectionId).toBe('STRENGTHS_AND_SHADOWS');
  });
});

describe('分段键枚举（契约 §3.5.4 Query）', () => {
  it('与契约逐字一致且顺序稳定', () => {
    expect([...REPORT_SECTION_KEYS]).toEqual([
      'CORE_PORTRAIT',
      'DIMENSION_ANALYSIS',
      'RELATIONSHIP_PATTERN',
      'STRENGTHS_AND_SHADOWS',
      'GROWTH_SUGGESTIONS',
      'ACTION_PLAN',
    ]);
  });

  it('错误码常量仍然可用（未引入新码）', () => {
    expect(ErrorCode.AI_REPORT_NOT_FOUND).toBe(50016);
  });
});
