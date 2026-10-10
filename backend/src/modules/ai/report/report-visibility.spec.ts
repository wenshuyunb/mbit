/**
 * 报告段落可见性测试
 *
 * 首要断言是**付费内容不泄露**：未解锁段落的正文不得出现在返回对象里
 * ——不是空字符串、不是被截断的片段，而是根本不存在该字段的内容。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import {
  assertHasReadableSection,
  buildSectionViews,
  summarizeVisibility,
  type SectionRecord,
} from './report-visibility';

const FREE_CONTENT = '这是免费预览段的正文，用户无需付费即可阅读。';
const PAID_CONTENT = '这是付费段的正文，包含深度解读与行动建议，未解锁时绝不能下发。';

const sections = (): SectionRecord[] => [
  { sectionKey: 'overview', title: '整体印象', content: FREE_CONTENT, order: 0, isFreePreview: true },
  { sectionKey: 'strengths', title: '核心优势', content: PAID_CONTENT, order: 1, isFreePreview: false },
  { sectionKey: 'growth', title: '成长建议', content: '成长建议正文内容。', order: 2, isFreePreview: false },
];

const noUnlocks = { allUnlocked: false, unlockedSectionKeys: new Set<string>() };

describe('buildSectionViews', () => {
  describe('免费预览与解锁', () => {
    it('免费段永远可见，付费段默认锁定', () => {
      const views = buildSectionViews(sections(), noUnlocks);

      expect(views[0]).toMatchObject({ sectionKey: 'overview', isUnlocked: true });
      expect(views[1]).toMatchObject({ sectionKey: 'strengths', isUnlocked: false });
      expect(views[2]).toMatchObject({ sectionKey: 'growth', isUnlocked: false });
    });

    it('【关键】未解锁段落的 content 为 null，正文不出现在返回对象中', () => {
      const views = buildSectionViews(sections(), noUnlocks);

      expect(views[1].content).toBeNull();
      // 整个序列化结果里都不得出现付费正文
      expect(JSON.stringify(views)).not.toContain('深度解读与行动建议');
    });

    it('【关键】未解锁段落不下发任何正文片段（连前 N 字都没有）', () => {
      const views = buildSectionViews(sections(), noUnlocks);
      const serialized = JSON.stringify(views[1]);

      // 取付费正文的前 10 个字做片段检测
      expect(serialized).not.toContain(PAID_CONTENT.slice(0, 10));
    });

    it('未解锁时给出解锁提示（不含正文片段）', () => {
      const views = buildSectionViews(sections(), noUnlocks);

      expect(views[1].lockedHint).toBe('解锁后可阅读本段完整内容');
      expect(views[0].lockedHint).toBeNull();
    });

    it('按段落键单独解锁', () => {
      const views = buildSectionViews(sections(), {
        allUnlocked: false,
        unlockedSectionKeys: new Set(['strengths']),
      });

      expect(views[1].isUnlocked).toBe(true);
      expect(views[1].content).toBe(PAID_CONTENT);
      // 未解锁的那段仍然不可读
      expect(views[2].isUnlocked).toBe(false);
      expect(views[2].content).toBeNull();
    });

    it('整体解锁（会员）时全部可见', () => {
      const views = buildSectionViews(sections(), {
        allUnlocked: true,
        unlockedSectionKeys: new Set(),
      });

      expect(views.every((view) => view.isUnlocked)).toBe(true);
      expect(views.every((view) => view.content !== null)).toBe(true);
    });

    it('未解锁段落仍下发正文长度（只暴露体量，便于展示"解锁可读 N 字"）', () => {
      const views = buildSectionViews(sections(), noUnlocks);

      expect(views[1].contentLength).toBe(PAID_CONTENT.length);
      expect(views[1].content).toBeNull();
    });
  });

  describe('顺序', () => {
    it('按 order 升序输出（不信任入参顺序）', () => {
      const shuffled = [...sections()].reverse();

      const views = buildSectionViews(shuffled, noUnlocks);

      expect(views.map((view) => view.order)).toEqual([0, 1, 2]);
    });

    it('不修改入参数组', () => {
      const input = [...sections()].reverse();
      const snapshot = input.map((item) => item.sectionKey);

      buildSectionViews(input, noUnlocks);

      expect(input.map((item) => item.sectionKey)).toEqual(snapshot);
    });
  });

  describe('边界', () => {
    it('空段落列表返回空数组', () => {
      expect(buildSectionViews([], noUnlocks)).toEqual([]);
    });

    it('没有免费段且未解锁时全部锁定', () => {
      const paidOnly: SectionRecord[] = [
        { sectionKey: 'a', title: 'A', content: '内容', order: 0, isFreePreview: false },
      ];

      const views = buildSectionViews(paidOnly, noUnlocks);

      expect(views[0].isUnlocked).toBe(false);
      expect(views[0].content).toBeNull();
    });

    it('空正文段落在解锁后 content 为空字符串（而非 null，语义不同）', () => {
      const emptyBody: SectionRecord[] = [{ sectionKey: 'a', title: 'A', content: '', order: 0, isFreePreview: true }];

      const views = buildSectionViews(emptyBody, noUnlocks);

      expect(views[0].content).toBe('');
      expect(views[0].contentLength).toBe(0);
    });
  });
});

describe('summarizeVisibility', () => {
  it('统计解锁与锁定数量', () => {
    const summary = summarizeVisibility(buildSectionViews(sections(), noUnlocks));

    expect(summary).toEqual({
      totalSections: 3,
      unlockedSections: 1,
      lockedSections: 2,
      isFullyUnlocked: false,
      isFullyLocked: false,
    });
  });

  it('全部解锁时 isFullyUnlocked 为真', () => {
    const summary = summarizeVisibility(
      buildSectionViews(sections(), { allUnlocked: true, unlockedSectionKeys: new Set() }),
    );

    expect(summary.isFullyUnlocked).toBe(true);
    expect(summary.lockedSections).toBe(0);
  });

  it('【关键】空报告时 isFullyUnlocked 为假（空集合不应被视为"全解锁"）', () => {
    const summary = summarizeVisibility([]);

    expect(summary.isFullyUnlocked).toBe(false);
    expect(summary.isFullyLocked).toBe(true);
  });
});

describe('assertHasReadableSection', () => {
  it('有免费段时通过', () => {
    const summary = summarizeVisibility(buildSectionViews(sections(), noUnlocks));

    expect(() => assertHasReadableSection(summary)).not.toThrow();
  });

  it('【关键】一段不可读时抛 50019（而非下发空壳报告）', () => {
    const paidOnly: SectionRecord[] = [
      { sectionKey: 'a', title: 'A', content: '内容', order: 0, isFreePreview: false },
    ];
    const summary = summarizeVisibility(buildSectionViews(paidOnly, noUnlocks));

    expect(() => assertHasReadableSection(summary)).toThrow(
      expect.objectContaining({ code: ErrorCode.AI_REPORT_NOT_UNLOCKED }),
    );
  });

  it('报告没有任何段落时抛 50016（配置事故应有明确错误码）', () => {
    expect(() => assertHasReadableSection(summarizeVisibility([]))).toThrow(
      expect.objectContaining({ code: ErrorCode.AI_REPORT_NOT_FOUND }),
    );
  });
});
