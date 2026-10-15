/**
 * 情感结论生成测试（ADR-039 补）
 *
 * ## 这一段的红线与 AI 报告一致
 *
 * 结果页的结论**不是 AI 写的**，因此它更容易越界 —— 手写的文案不受提示词 guardrails 约束，
 * 只能靠断言看着。这里锁四件事：
 *
 *   ① **不贴标签**：四种依恋类型都必须带"这是当下的倾向"这类限定；
 *   ② **不评判关系、不做诊断**：不出现临床词与"你们合不合适"这类判断；
 *   ③ **真的回答了那三个问题**：我是什么样（headline/portrait）、
 *      我需要什么（needs）、我该做什么（suggestions 三条）；
 *   ④ **确定性**：同一份画像任何时候都得到同一段话（ADR-005）。
 */

import { buildEmotionConclusion, type EmotionConclusionInput } from './emotion-conclusion.util';

const baseInput = (overrides: Partial<EmotionConclusionInput> = {}): EmotionConclusionInput => ({
  attachmentStyle: 'ANXIOUS',
  attachmentAnxiety: 62,
  attachmentAvoidance: 20,
  loveLanguageScores: {
    LOVE_WORDS: 60,
    LOVE_TIME: 62,
    LOVE_GIFTS: 6,
    LOVE_SERVICE: 5,
    LOVE_TOUCH: 63,
  },
  primaryLoveLanguages: ['LOVE_TOUCH', 'LOVE_TIME'],
  conflictStyle: 'CONFLICT_COLLABORATING',
  conflictScores: {
    CONFLICT_COLLABORATING: 100,
    CONFLICT_COMPROMISING: 20,
    CONFLICT_ACCOMMODATING: 50,
    CONFLICT_AVOIDING: 0,
    CONFLICT_COMPETING: 20,
  },
  ...overrides,
});

describe('buildEmotionConclusion：回答那三个问题', () => {
  const conclusion = buildEmotionConclusion(baseInput());

  it('① 我是什么样：一句话画像 + 两轴解释', () => {
    expect(conclusion.headline.length).toBeGreaterThan(10);
    expect(conclusion.portrait).toContain('62');
    expect(conclusion.portrait).toContain('20');
    // 必须说明两个档位，而不是只丢数字
    expect(conclusion.portrait).toContain('焦虑');
    expect(conclusion.portrait).toContain('回避');
  });

  it('② 我需要什么：把主导爱的语言翻成需求句，并点出"哪一项对你没用"', () => {
    expect(conclusion.needs).toContain('身体的接触');
    expect(conclusion.needs).toContain('精心的时刻');
    // 最低分那项要出现，否则用户不知道"为什么我对他做这些没感觉"
    expect(conclusion.needs).toContain('服务的行动');
  });

  it('③ 我该做什么：三条建议，每条都带"为什么"', () => {
    expect(conclusion.suggestions).toHaveLength(3);
    for (const advice of conclusion.suggestions) {
      expect(advice.length).toBeGreaterThan(20);
    }
  });

  it('还给了优势（用户最想看到的部分之一）', () => {
    expect(conclusion.strengths.length).toBeGreaterThan(0);
    expect(conclusion.strengths.length).toBeLessThanOrEqual(3);
  });

  it('带合规提示，且说明它不是 AI 生成', () => {
    expect(conclusion.note).toContain('不含 AI 生成内容');
    expect(conclusion.note).toContain('不构成心理诊断');
  });
});

describe('四种依恋类型都说得通', () => {
  it.each([
    ['SECURE', 30, 25],
    ['ANXIOUS', 75, 20],
    ['AVOIDANT', 25, 75],
    ['FEARFUL', 75, 75],
  ])('%s：有专属的一句话画像，且不贴标签', (style, anxiety, avoidance) => {
    const conclusion = buildEmotionConclusion(
      baseInput({ attachmentStyle: style, attachmentAnxiety: anxiety, attachmentAvoidance: avoidance }),
    );

    expect(conclusion.headline.length).toBeGreaterThan(10);
    // 不能把类型写成对人的定性 —— 必须带上"当下的倾向"
    expect(conclusion.portrait).toContain('当下');
    expect(conclusion.portrait).toContain('不是贴在你身上的标签');
    expect(conclusion.suggestions).toHaveLength(3);
  });

  it('四型的画像句互不相同（不是同一句话换个类型名）', () => {
    const headlines = ['SECURE', 'ANXIOUS', 'AVOIDANT', 'FEARFUL'].map(
      (style) => buildEmotionConclusion(baseInput({ attachmentStyle: style })).headline,
    );

    expect(new Set(headlines).size).toBe(4);
  });
});

describe('红线：不评判、不诊断、不空泛', () => {
  const allStyles = ['SECURE', 'ANXIOUS', 'AVOIDANT', 'FEARFUL'];
  const allConflicts = [
    'CONFLICT_COLLABORATING',
    'CONFLICT_COMPROMISING',
    'CONFLICT_ACCOMMODATING',
    'CONFLICT_AVOIDING',
    'CONFLICT_COMPETING',
  ];

  it('任何组合都不出现临床词与关系裁决', () => {
    const banned = ['症状', '障碍', '治疗', '创伤', '抑郁症', '焦虑症', '诊断', '合适', '分手', '该不该继续'];

    for (const style of allStyles) {
      for (const conflict of allConflicts) {
        const conclusion = buildEmotionConclusion(baseInput({ attachmentStyle: style, conflictStyle: conflict }));
        const text = [
          conclusion.headline,
          conclusion.portrait,
          conclusion.needs,
          conclusion.conflict,
          ...conclusion.strengths,
          ...conclusion.suggestions,
        ].join('');

        for (const word of banned) {
          expect(`${style}/${conflict} 含「${word}」=${text.includes(word)}`).toBe(
            `${style}/${conflict} 含「${word}」=false`,
          );
        }
      }
    }
  });

  it('五种冲突风格都有对应文案（不会落成兜底句）', () => {
    for (const conflict of allConflicts) {
      const conclusion = buildEmotionConclusion(baseInput({ conflictStyle: conflict }));

      expect(conclusion.conflict).toContain('有分歧时你偏向');
    }
  });
});

describe('数据不足时不硬编结论', () => {
  it('没有爱的语言数据时，明说给不出结论，而不是编一个', () => {
    const conclusion = buildEmotionConclusion(baseInput({ primaryLoveLanguages: [], loveLanguageScores: null }));

    expect(conclusion.needs).toContain('数据不足');
    // 仍然给建议（来自依恋类型），不能让用户看到一个空页
    expect(conclusion.suggestions.length).toBeGreaterThan(0);
  });

  it('未知的依恋类型值不会抛错（回落安全型）', () => {
    const conclusion = buildEmotionConclusion(baseInput({ attachmentStyle: 'UNKNOWN' }));

    expect(conclusion.headline).toBe(buildEmotionConclusion(baseInput({ attachmentStyle: 'SECURE' })).headline);
  });
});

describe('确定性（ADR-005）', () => {
  it('同一份画像两次生成逐字相同', () => {
    expect(buildEmotionConclusion(baseInput())).toEqual(buildEmotionConclusion(baseInput()));
  });
});
