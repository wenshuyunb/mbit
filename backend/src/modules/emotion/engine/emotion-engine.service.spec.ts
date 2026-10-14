/**
 * 情感算法引擎测试
 *
 * ## 这个引擎里最容易被写错、且写错不会报错的地方
 *
 * 1. **依恋四象限的映射**（`resolveAttachmentQuadrant`）
 *    焦虑高 + 回避高 = **恐惧型**（FEARFUL），不是"安全型"。
 *    写反了照样能产出一个合法枚举值，用户只会读到一句错的结论。
 * 2. **并列时的顺序**
 *    五项爱的语言分数完全相同时（认真但均衡的作答真实存在），
 *    "取前两名"必须有确定的答案。靠 `sort` 的稳定性是不够的 ——
 *    那份稳定性是 ES2019 才写进规范的，而结果要落库、要能离线复算。
 * 3. **数据不足时不给结论**
 *    `usable = false` 的维度占位是 50。若把它当真实分数读，
 *    "一题没答"就会变成"正好 50 分"，并据此编出一段解读。
 *
 * 因此这三类各有一组专门的用例。
 */

import { EmotionEngine } from './emotion-engine.service';
import {
  CONFLICT_STYLE_DIMENSIONS,
  EMOTION_ENGINE_VERSION,
  LOVE_LANGUAGE_DIMENSIONS,
  type ConflictStyleDimension,
  type LoveLanguageDimension,
} from './emotion-engine.types';
import type { EngineAnswer, EngineQuestion } from '../../../common/engine/assessment.types';

const engine = new EmotionEngine();

/** 造一道 5 点李克特题 */
const likert = (id: string, dimension: string, reverseScored = false, weight = 1): EngineQuestion => ({
  id,
  type: 'LIKERT5',
  dimension,
  weight,
  reverseScored,
  minValue: 1,
  maxValue: 5,
  options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
});

/**
 * 按「期望的归一化百分比」造一道题与答案
 *
 * 5 点量表的 `percent = (value − 1) / 4 × 100`，因此 `value` 直接由目标分数反推：
 * 期望 0 → 选 1，期望 100 → 选 5，期望 50 → 选 3。
 * 这样夹具表达的是"这个人在这条轴上是多少分"，而不是"选了几"，
 * 读用例时不必在脑子里做一次换算。
 */
const answerWithPercent = (id: string, percent: number): { question: EngineQuestion; answer: EngineAnswer } => {
  const value = Math.round(1 + (percent / 100) * 4);

  return { question: likert(id, id), answer: { questionId: id, value, responseMs: 3000 } };
};

/** 用一组"维度 → 期望百分比"构造完整输入 */
const build = (percents: Record<string, number>): { questions: EngineQuestion[]; answers: EngineAnswer[] } => {
  const questions: EngineQuestion[] = [];
  const answers: EngineAnswer[] = [];

  for (const [dimension, percent] of Object.entries(percents)) {
    const { question, answer } = answerWithPercent(dimension, percent);
    questions.push(question);
    answers.push(answer);
  }

  return { questions, answers };
};

/**
 * ⚠ 期望百分比只能取 **0 / 25 / 50 / 75 / 100** —— 5 点量表只有 5 个档位，
 * 写 80 会被 Math.round 落到第 4 档（实际 75 分），断言就会对不上。
 * 这是夹具的约束，不是引擎的：真实量表能表达的也只有这五档。
 */
const ALL_FAMILIES = build({
  ATTACH_ANXIETY: 75,
  ATTACH_AVOIDANCE: 25,
  LOVE_WORDS: 100,
  LOVE_TIME: 75,
  LOVE_GIFTS: 25,
  LOVE_SERVICE: 50,
  LOVE_TOUCH: 25,
  CONFLICT_COLLABORATING: 100,
  CONFLICT_COMPROMISING: 75,
  CONFLICT_ACCOMMODATING: 50,
  CONFLICT_AVOIDING: 25,
  CONFLICT_COMPETING: 0,
});

describe('EmotionEngine.resolveAttachmentQuadrant（ECR 双轴 → 四象限）', () => {
  it.each([
    ['焦虑低 + 回避低 → 安全型', 40, 40, 'SECURE'],
    ['焦虑高 + 回避低 → 焦虑型', 70, 40, 'ANXIOUS'],
    ['焦虑低 + 回避高 → 回避型', 40, 70, 'AVOIDANT'],
    // ⚠ 这条最容易被写反：两个轴都高是恐惧型（紊乱型），不是安全型
    ['焦虑高 + 回避高 → 恐惧型', 70, 70, 'FEARFUL'],
  ])('%s', (_label, anxiety, avoidance, expected) => {
    expect(EmotionEngine.resolveAttachmentQuadrant(anxiety, avoidance, 50, 50)).toBe(expected);
  });

  it('恰好等于阈值算「高」（闭区间），与 ECR 的中位切分一致', () => {
    expect(EmotionEngine.resolveAttachmentQuadrant(50, 50, 50, 50)).toBe('FEARFUL');
    expect(EmotionEngine.resolveAttachmentQuadrant(50, 49.9, 50, 50)).toBe('ANXIOUS');
  });

  it('阈值可调，且调整只改判定、不改轴分数', () => {
    // 焦虑轴 60 分：阈值 50 时算高，阈值 70 时算低
    expect(EmotionEngine.resolveAttachmentQuadrant(60, 40, 50, 50)).toBe('ANXIOUS');
    expect(EmotionEngine.resolveAttachmentQuadrant(60, 40, 70, 50)).toBe('SECURE');
  });
});

describe('EmotionEngine.rankByScore（并列时的稳定顺序）', () => {
  it('按分数降序', () => {
    const scores = { A: 10, B: 30, C: 20 } as Record<'A' | 'B' | 'C', number>;

    expect(EmotionEngine.rankByScore(['A', 'B', 'C'], scores)).toEqual(['B', 'C', 'A']);
  });

  it('全部并列时按声明顺序 —— 不依赖 sort 的稳定性', () => {
    const order = ['A', 'B', 'C'] as const;
    const scores = { A: 50, B: 50, C: 50 } as Record<'A' | 'B' | 'C', number>;

    expect(EmotionEngine.rankByScore(order, scores)).toEqual(['A', 'B', 'C']);
    // 声明顺序本身是结果的一部分：换一个顺序就换一个"主导项"
    expect(EmotionEngine.rankByScore(['C', 'B', 'A'], scores)).toEqual(['C', 'B', 'A']);
  });

  it('反复调用结果一致（可复现）', () => {
    const scores = { A: 50, B: 50, C: 70 } as Record<'A' | 'B' | 'C', number>;
    const order = ['A', 'B', 'C'] as const;

    expect(EmotionEngine.rankByScore(order, scores)).toEqual(EmotionEngine.rankByScore(order, scores));
  });
});

describe('EmotionEngine.compute（完整作答）', () => {
  const output = engine.compute(ALL_FAMILIES);

  it('引擎版本随结果返回（落库用于离线复算）', () => {
    expect(output.engineVersion).toBe(EMOTION_ENGINE_VERSION);
  });

  it('依恋：两个轴按测量值给出，类型由象限得出', () => {
    expect(output.attachment.anxietyUsable).toBe(true);
    expect(output.attachment.avoidanceUsable).toBe(true);
    // 75 → 选 4；25 → 选 2（5 点量表只有整数档）
    expect(output.attachment.anxiety).toBe(75);
    expect(output.attachment.avoidance).toBe(25);
    expect(output.attachment.style).toBe('ANXIOUS');
    expect(output.attachment.thresholds).toEqual({ anxiety: 50, avoidance: 50 });
  });

  it('爱的语言：五项分数齐全，主导项按分数降序', () => {
    expect(output.loveLanguage.usable).toBe(true);
    expect(Object.keys(output.loveLanguage.scores).sort()).toEqual([...LOVE_LANGUAGE_DIMENSIONS].sort());
    expect(output.loveLanguage.primary).toEqual(['LOVE_WORDS', 'LOVE_TIME']);
  });

  it('冲突风格：五种分数齐全，取最高分者', () => {
    expect(output.conflict.usable).toBe(true);
    expect(Object.keys(output.conflict.scores).sort()).toEqual([...CONFLICT_STYLE_DIMENSIONS].sort());
    expect(output.conflict.style).toBe('CONFLICT_COLLABORATING');
  });

  it('三个族都有结论时 `unresolved` 为空', () => {
    expect(output.unresolved).toEqual([]);
  });

  it('质量指标来自共用算法（与人格引擎同一份实现）', () => {
    expect(output.quality.completionRate).toBe(100);
    expect(output.quality.answeredCount).toBe(Object.keys(ALL_FAMILIES.questions).length);
    expect(output.quality.rushRate).toBe(0);
  });

  it('相同输入两次结果完全一致（ADR-005 可复现）', () => {
    expect(engine.compute(ALL_FAMILIES)).toEqual(output);
  });

  it('主导爱的语言取几项可配置', () => {
    const three = engine.compute({ ...ALL_FAMILIES, primaryLoveLanguageCount: 3 });

    expect(three.loveLanguage.primary).toHaveLength(3);
    expect(three.loveLanguage.primary[2]).toBe('LOVE_SERVICE');
  });
});

describe('EmotionEngine.compute（数据不足）', () => {
  it('只有一根依恋轴 → **不给类型结论**（不是回落到安全型）', () => {
    const output = engine.compute(build({ ATTACH_ANXIETY: 75 }));

    expect(output.attachment.style).toBeNull();
    expect(output.attachment.anxietyUsable).toBe(true);
    expect(output.attachment.avoidanceUsable).toBe(false);
    expect(output.unresolved).toContain('依恋类型');
  });

  it('爱的语言一题未答 → 主导项为空数组（不是按固定顺序取前两名）', () => {
    const output = engine.compute(build({ ATTACH_ANXIETY: 50, ATTACH_AVOIDANCE: 50 }));

    expect(output.loveLanguage.usable).toBe(false);
    expect(output.loveLanguage.primary).toEqual([]);
    // 占位 50 会出现在 scores 里，但 `usable=false` 明确说明它不是测量结果
    expect(Object.values(output.loveLanguage.scores).every((score) => score === 50)).toBe(true);
    expect(output.unresolved).toContain('爱的语言');
  });

  it('冲突风格一题未答 → 主导风格为 null', () => {
    const output = engine.compute(build({ ATTACH_ANXIETY: 50, ATTACH_AVOIDANCE: 50 }));

    expect(output.conflict.style).toBeNull();
    expect(output.unresolved).toContain('冲突风格');
  });

  it('完全空试卷：三个族全部 `unresolved`，且不抛异常', () => {
    const output = engine.compute({ questions: [], answers: [] });

    expect(output.unresolved).toEqual(['依恋类型', '爱的语言', '冲突风格']);
    expect(output.attachment.style).toBeNull();
    expect(output.conflict.style).toBeNull();
    expect(output.quality.completionRate).toBe(0);
  });

  it('非情感维度的题目计入完成率但不参与情感得分（模块隔离）', () => {
    // 混进一道人格题：它不该污染任何一个情感维度
    const mixed = build({ ATTACH_ANXIETY: 75, ATTACH_AVOIDANCE: 25 });
    mixed.questions.push(likert('q-EI', 'EI'));
    mixed.answers.push({ questionId: 'q-EI', value: 5, responseMs: 3000 });

    const output = engine.compute(mixed);

    // 1) 人格题**不会**产生任何情感维度分
    expect(output.rawScores.dimensions['EI']).toBeUndefined();
    // 2) 但它确实被算进作答数与完成率 —— 不能假装用户没答这一题
    expect(output.quality.answeredCount).toBe(3);
    expect(output.quality.completionRate).toBe(100);
    // 3) 依恋结论只由那两道依恋题决定
    expect(output.attachment.style).toBe('ANXIOUS');
    // 4) 混进一道人格题**救不了**缺数据的族：爱的语言与冲突风格依旧没有结论
    expect(output.unresolved).toEqual(['爱的语言', '冲突风格']);
  });

  it('反向题按量程翻转（不是简单的 max − value）', () => {
    const questions = [likert('ATTACH_ANXIETY', 'ATTACH_ANXIETY', true)];
    const answers: EngineAnswer[] = [{ questionId: 'ATTACH_ANXIETY', value: 1, responseMs: 3000 }];

    const output = engine.compute({ questions, answers });

    // 反向题选 1（最不同意）→ 翻转后等价于选 5 → 焦虑轴 100
    expect(output.attachment.anxiety).toBe(100);
  });
});

describe('EmotionEngine.compute（阈值来自调用方）', () => {
  it('阈值改变会改变类型判定，但轴分数不变', () => {
    const input = build({ ATTACH_ANXIETY: 75, ATTACH_AVOIDANCE: 25 });

    const strict = engine.compute({ ...input, attachmentThreshold: { anxiety: 80, avoidance: 50 } });
    const loose = engine.compute({ ...input, attachmentThreshold: { anxiety: 70, avoidance: 50 } });

    expect(strict.attachment.anxiety).toBe(loose.attachment.anxiety);
    expect(strict.attachment.style).toBe('SECURE');
    expect(loose.attachment.style).toBe('ANXIOUS');
    // 实际用到的阈值必须回传：报告与后台要能解释"当时为什么判成这个类型"
    expect(strict.attachment.thresholds).toEqual({ anxiety: 80, avoidance: 50 });
  });

  it('未传阈值时用 ECR 惯例的中位切分 50', () => {
    const output = engine.compute(build({ ATTACH_ANXIETY: 75, ATTACH_AVOIDANCE: 25 }));

    expect(output.attachment.thresholds).toEqual({ anxiety: 50, avoidance: 50 });
  });
});

describe('维度常量的完整性（防止新增维度时漏掉某处）', () => {
  it('爱的语言是 5 项、冲突风格是 5 项、依恋是 2 轴', () => {
    expect(LOVE_LANGUAGE_DIMENSIONS).toHaveLength(5);
    expect(CONFLICT_STYLE_DIMENSIONS).toHaveLength(5);
    expect(new Set(LOVE_LANGUAGE_DIMENSIONS).size).toBe(5);
    expect(new Set(CONFLICT_STYLE_DIMENSIONS).size).toBe(5);
  });

  it('情感维度与人格维度不重名（两套白名单互不重叠）', () => {
    const personalityDimensions = [
      'EI',
      'SN',
      'TF',
      'JP',
      'OPENNESS',
      'CONSCIENTIOUSNESS',
      'EXTRAVERSION',
      'AGREEABLENESS',
      'NEUROTICISM',
    ];
    const conflict: readonly ConflictStyleDimension[] = CONFLICT_STYLE_DIMENSIONS;
    const love: readonly LoveLanguageDimension[] = LOVE_LANGUAGE_DIMENSIONS;

    for (const dimension of [...conflict, ...love]) {
      expect(personalityDimensions).not.toContain(dimension);
    }
  });
});
