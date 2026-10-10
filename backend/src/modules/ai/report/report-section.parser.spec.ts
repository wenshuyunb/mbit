/**
 * 报告分段解析测试
 *
 * 本文件的中心主张：**段落键必须稳定、内容不能丢、空段不能占位**。
 * 前两条关系到付费权益能否追溯（ADR-004），第三条关系到用户是否为空白付费。
 */

import type { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { parseReportSections, readExpectedSections, type ExpectedSection } from './report-section.parser';

/** 模板声明：3 段，前 1 段免费预览 */
const EXPECTED: ExpectedSection[] = [
  { key: 'overview', title: '整体印象', freePreview: true },
  { key: 'strengths', title: '核心优势', freePreview: false },
  { key: 'growth', title: '成长建议', freePreview: false },
];

const FULL_TEXT = [
  '这份报告基于你的测评结果生成。',
  '',
  '## 整体印象',
  '你倾向于先在内部构建模型，再与外界交互。',
  '',
  '## 核心优势',
  '长期布局与结构拆解是你最突出的能力。',
  '',
  '## 成长建议',
  '可以刻意练习在讨论中先表达感受。',
].join('\n');

describe('parseReportSections', () => {
  describe('正常分段', () => {
    it('按标题切分并绑定模板声明的稳定键', () => {
      const result = parseReportSections(FULL_TEXT, EXPECTED);

      expect(result.sections.map((s) => s.sectionKey)).toEqual(['overview', 'strengths', 'growth']);
      expect(result.sections.map((s) => s.order)).toEqual([0, 1, 2]);
    });

    it('标题以模板声明为准（同一段落标题跨次生成保持稳定）', () => {
      const result = parseReportSections('## 模型自己起的标题\n正文', [
        { key: 'overview', title: '整体印象', freePreview: true },
      ]);

      expect(result.sections[0].title).toBe('整体印象');
    });

    it('首个标题之前的内容作为引言单独返回（不当付费段落）', () => {
      const result = parseReportSections(FULL_TEXT, EXPECTED);

      expect(result.preamble).toBe('这份报告基于你的测评结果生成。');
      expect(result.sections).toHaveLength(3);
    });

    it('正文字符数统计正确（含标题与引言）', () => {
      const result = parseReportSections(FULL_TEXT, EXPECTED);

      expect(result.contentLength).toBe(FULL_TEXT.length);
    });

    it('【关键】免费预览长度只累计免费段', () => {
      const result = parseReportSections(FULL_TEXT, EXPECTED);
      const freeSection = result.sections.find((s) => s.sectionKey === 'overview');

      expect(result.freePreviewLength).toBe(freeSection?.content.length);
      // 付费段不得计入免费长度
      expect(result.freePreviewLength).toBeLessThan(result.contentLength);
    });
  });

  describe('稳定性', () => {
    it('【关键】同一输入重复解析结果一致', () => {
      const first = parseReportSections(FULL_TEXT, EXPECTED);
      const second = parseReportSections(FULL_TEXT, EXPECTED);

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('【关键】段落键来自模板而非模型标题（付费权益可追溯）', () => {
      const noisy = ['## 随便什么标题一', '正文一', '## 随便什么标题二', '正文二'].join('\n');

      const result = parseReportSections(noisy, EXPECTED.slice(0, 2));

      expect(result.sections.map((s) => s.sectionKey)).toEqual(['overview', 'strengths']);
    });
  });

  describe('模型行为差异', () => {
    it('模型多产出段落时保留内容并记为 extra（不静默丢弃）', () => {
      const text = ['## A', '正文一', '## B', '正文二', '## C', '正文三'].join('\n');

      const result = parseReportSections(text, EXPECTED.slice(0, 2));

      expect(result.sections).toHaveLength(3);
      expect(result.sections[2].sectionKey).toBe('extra-1');
      expect(result.extraSectionKeys).toEqual(['extra-1']);
      // 内容必须完整保留
      expect(result.sections[2].content).toBe('正文三');
      // 未声明为免费的额外段落一律付费
      expect(result.sections[2].isFreePreview).toBe(false);
    });

    it('模型少产出段落时不补齐空段', () => {
      const result = parseReportSections('## 整体印象\n只有一段', EXPECTED);

      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].sectionKey).toBe('overview');
    });

    it('【关键】只有标题没有正文的段落被丢弃且不占段位', () => {
      const text = ['## 整体印象', '有内容', '## 核心优势', '', '## 成长建议', '也有内容'].join('\n');

      const result = parseReportSections(text, EXPECTED);

      expect(result.sections.map((s) => s.sectionKey)).toEqual(['overview', 'growth']);
      expect(result.droppedSectionKeys).toEqual(['strengths']);
      // order 连续，不留空洞
      expect(result.sections.map((s) => s.order)).toEqual([0, 1]);
    });

    it('完全没有标题时整篇作为一段（不把合法内容判为无效）', () => {
      const result = parseReportSections('一段没有任何小标题的长文本。', EXPECTED);

      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].sectionKey).toBe('overview');
      expect(result.sections[0].content).toBe('一段没有任何小标题的长文本。');
      expect(result.preamble).toBe('');
    });

    it('模板未声明任何段落且模型也没给标题时使用兜底键', () => {
      const result = parseReportSections('正文', []);

      expect(result.sections[0].sectionKey).toBe('extra-1');
    });

    it('支持 1–4 级标题，忽略非标题的井号', () => {
      const text = ['# 一级', '内容一', '#### 四级', '内容二', '#无空格不是标题', '仍在内容二里'].join('\n');

      const result = parseReportSections(text, EXPECTED);

      expect(result.sections).toHaveLength(2);
      expect(result.sections[1].content).toContain('#无空格不是标题');
    });
  });

  describe('输入异常', () => {
    it.each(['', '   ', '\n\n'])('空内容抛出 50004：%j', (content) => {
      try {
        parseReportSections(content, EXPECTED);
        throw new Error('期望抛出错误');
      } catch (error) {
        expect((error as BusinessException).code).toBe(ErrorCode.AI_OUTPUT_INVALID);
      }
    });

    it('引言的空白被裁剪', () => {
      const result = parseReportSections('\n\n  \n## A\n正文', EXPECTED);

      expect(result.preamble).toBe('');
    });
  });
});

describe('readExpectedSections', () => {
  it('读取合法声明', () => {
    expect(
      readExpectedSections({
        sections: [
          { key: 'overview', title: '整体印象', freePreview: true },
          { key: 'strengths', title: '核心优势' },
        ],
      }),
    ).toEqual([
      { key: 'overview', title: '整体印象', freePreview: true },
      { key: 'strengths', title: '核心优势', freePreview: false },
    ]);
  });

  it('【关键】声明格式异常时返回空数组而非抛错（后台配置错误不应导致线上不可用）', () => {
    for (const schema of [null, undefined, 'string', 42, [], {}, { sections: 'not-array' }, { sections: [null, 1] }]) {
      expect(readExpectedSections(schema)).toEqual([]);
    }
  });

  it('缺少 key 的条目被跳过，其余条目保留', () => {
    expect(readExpectedSections({ sections: [{ title: '无键条目' }, { key: 'ok', title: '有效' }] })).toEqual([
      { key: 'ok', title: '有效', freePreview: false },
    ]);
  });

  it('缺少标题时用 key 兜底', () => {
    expect(readExpectedSections({ sections: [{ key: 'overview' }] })).toEqual([
      { key: 'overview', title: 'overview', freePreview: false },
    ]);
  });
});
