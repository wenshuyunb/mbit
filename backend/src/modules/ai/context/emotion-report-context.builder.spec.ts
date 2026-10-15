/**
 * 情感报告上下文组装测试
 *
 * ## 这里最该被锁住的三件事
 *
 * 1. **两条轴的分数必须与类型一起出现在变量里**。四种依恋类型是焦虑轴与回避轴
 *    **求交**的结果，只给类型标签的话，模型无法解释"为什么是焦虑型"、
 *    也看不出"离分界线多远" —— 那正是用户抱怨的"过于简陋"。
 * 2. **爱的语言必须给完整分布**，不能只给前两名。五项分差常常很小，
 *    只给第一名会把"其实你最在意被肯定，其次是被陪伴"压成一句很绝对的话。
 * 3. **确定性**：同一份画像两次组装必须逐字相同（ADR-005）。
 *    尤其"分布行"的顺序必须按**维度定义顺序**而不是分数顺序 ——
 *    按分数排序会让行内顺序随分数微动而变，而这两行是要被逐字对比的。
 *
 * 另有一组"模块隔离"断言：情感报告的变量表里**不该出现任何人格变量**
 * （MBTI / 大五），否则模型会顺口谈"你作为 INFP……"。
 */

import {
  EMOTION_ATTACHMENT_LABELS,
  EMOTION_CONFLICT_LABELS,
  EMOTION_LOVE_LANGUAGE_LABELS,
  buildEmotionReportContext,
  describeEmotionLevel,
  type EmotionReportContextInput,
} from './emotion-report-context.builder';
import { UNAVAILABLE_PLACEHOLDER } from './report-context.builder';

const profile = (
  overrides: Partial<EmotionReportContextInput['profile']> = {},
): EmotionReportContextInput['profile'] => ({
  attachmentStyle: 'ANXIOUS',
  attachmentAnxiety: 72,
  attachmentAvoidance: 31,
  loveLanguageScores: {
    LOVE_WORDS: 86,
    LOVE_TIME: 80,
    LOVE_SERVICE: 58,
    LOVE_TOUCH: 52,
    LOVE_GIFTS: 33,
  },
  primaryLoveLanguages: ['LOVE_WORDS', 'LOVE_TIME'],
  conflictStyle: 'CONFLICT_ACCOMMODATING',
  conflictScores: {
    CONFLICT_COLLABORATING: 60,
    CONFLICT_COMPROMISING: 67,
    CONFLICT_ACCOMMODATING: 74,
    CONFLICT_AVOIDING: 45,
    CONFLICT_COMPETING: 28,
  },
  consistencyScore: 78,
  completionRate: 100,
  avgResponseMs: 6420,
  engineVersion: 'ee-v1.0.0',
  ...overrides,
});

const input = (overrides: Partial<EmotionReportContextInput> = {}): EmotionReportContextInput => ({
  profile: profile(),
  testDefinitionCode: 'EMOTION_LITE',
  answeredCount: 52,
  questionCount: 52,
  ...overrides,
});

describe('describeEmotionLevel', () => {
  it.each([
    [85, '很高'],
    [70, '偏高'],
    [50, '中等'],
    [35, '偏低'],
    [10, '很低'],
  ])('%i 分 → %s', (value, expected) => {
    expect(describeEmotionLevel(value)).toBe(expected);
  });

  it('边界值归属明确（80 / 65 / 45 / 30 各自落在上档）', () => {
    expect(describeEmotionLevel(80)).toBe('很高');
    expect(describeEmotionLevel(65)).toBe('偏高');
    expect(describeEmotionLevel(45)).toBe('中等');
    expect(describeEmotionLevel(30)).toBe('偏低');
  });
});

describe('buildEmotionReportContext', () => {
  const { variables, unavailable } = buildEmotionReportContext(input());

  it('依恋类型译成中文（不是裸枚举）', () => {
    expect(variables['attachmentStyle']).toBe('焦虑型');
  });

  it('【关键】两条轴的分数与档位都进变量（类型是求交结果，必须能解释）', () => {
    expect(variables['attachmentAxes']).toContain('焦虑轴 72');
    expect(variables['attachmentAxes']).toContain('偏高');
    expect(variables['attachmentAxes']).toContain('回避轴 31');
    expect(variables['attachmentAxes']).toContain('偏低');
  });

  it('【关键】爱的语言给**五项完整分布**，不只是前两名', () => {
    for (const label of Object.values(EMOTION_LOVE_LANGUAGE_LABELS)) {
      expect(variables['loveLanguageSummary']).toContain(label);
    }
    // 最不主导的那项也必须在，否则模型无法说清"不是不在乎，而是不如前几项"
    expect(variables['loveLanguageSummary']).toContain('接受礼物 33');
  });

  it('主导爱的语言是中文串，顺序与输入一致', () => {
    expect(variables['primaryLoveLanguages']).toBe('肯定的言辞、精心的时刻');
  });

  it('【关键】冲突风格给主导 + 五种完整分布', () => {
    expect(variables['conflictStyle']).toBe('迁就型');

    for (const label of Object.values(EMOTION_CONFLICT_LABELS)) {
      expect(variables['conflictStyleSummary']).toContain(label);
    }
  });

  it('数据质量与元信息齐备', () => {
    expect(variables['consistencyScore']).toBe('78');
    expect(variables['completionRate']).toBe('100');
    expect(variables['avgResponseSeconds']).toBe('6');
    expect(variables['answeredRatio']).toBe('52/52');
    expect(variables['engineVersion']).toBe('ee-v1.0.0');
    expect(variables['testDefinitionCode']).toBe('EMOTION_LITE');
  });

  it('数据齐全时没有缺项', () => {
    expect(unavailable).toEqual([]);
  });

  /**
   * 性别语境（ADR-039）
   *
   * 情感报告对它的依赖最直接：举例里的"你和他 / 你和她"必须与用户一致，
   * 而处境本身（谁先开口、见家长、要不要先低头）就带性别角色差异。
   */
  describe('性别语境', () => {
    it('未提供性别时给中性措辞的**明确指令**（不是占位文案）', () => {
      const built = buildEmotionReportContext({ ...input(), gender: null });

      expect(built.variables['genderContext']).toContain('未提供性别');
      expect(built.variables['genderContext']).toContain('对方');
      // 占位文案会被模型读成"这里本来有东西"，进而自行脑补一个性别
      expect(built.unavailable).not.toContain('genderContext');
    });

    it('提供性别时按该视角展开，且仍然禁止刻板印象', () => {
      const built = buildEmotionReportContext({ ...input(), gender: 'MALE' });

      expect(built.variables['genderContext']).toContain('男生');
      expect(built.variables['genderContext']).toContain('严禁性别刻板印象');
    });

    it('【关键】性别不参与任何**结论性**变量（分数与类型不因性别变化）', () => {
      const male = buildEmotionReportContext({ ...input(), gender: 'MALE' }).variables;
      const female = buildEmotionReportContext({ ...input(), gender: 'FEMALE' }).variables;

      for (const key of ['attachmentStyle', 'attachmentAxes', 'primaryLoveLanguages', 'conflictStyle']) {
        expect(male[key]).toBe(female[key]);
      }
    });
  });

  it('【关键】变量表里**没有任何人格变量**（模块隔离）', () => {
    const personalityKeys = [
      'mbtiType',
      'mbtiTypeName',
      'mbtiGroup',
      'mbtiStrengths',
      'dimensionEI',
      'dimensionSN',
      'dimensionTF',
      'dimensionJP',
      'bigFiveSummary',
      'mbtiConfidence',
    ];

    for (const key of personalityKeys) {
      expect(variables).not.toHaveProperty(key);
    }
  });

  it('【关键】相同输入两次组装逐字相同（ADR-005 可复现）', () => {
    expect(buildEmotionReportContext(input())).toEqual(buildEmotionReportContext(input()));
  });

  it('【关键】分布行的顺序按**维度定义顺序**，不按分数排序', () => {
    // 得分最高的是 LOVE_WORDS，但 LOVE_GIFTS 在定义顺序里最靠后 ——
    // 若实现按分数排序，"接受礼物"会跑到前面
    const summary = variables['loveLanguageSummary'] ?? '';
    const wordsAt = summary.indexOf('肯定的言辞');
    const giftsAt = summary.indexOf('接受礼物');

    expect(wordsAt).toBeGreaterThanOrEqual(0);
    expect(giftsAt).toBeGreaterThan(wordsAt);
  });
});

describe('buildEmotionReportContext：数据缺失', () => {
  it('爱的语言分数表为 null → 占位文案 + 记入缺项（不编造 0 分）', () => {
    const result = buildEmotionReportContext(input({ profile: profile({ loveLanguageScores: null }) }));

    expect(result.variables['loveLanguageSummary']).toBe(UNAVAILABLE_PLACEHOLDER);
    expect(result.unavailable).toContain('loveLanguageSummary');
  });

  it('【关键】分数表里缺一项时不补 0（补 0 会被读成"完全不在意"）', () => {
    const partial = buildEmotionReportContext(
      input({
        profile: profile({
          loveLanguageScores: { LOVE_WORDS: 86, LOVE_TIME: 80 },
        }),
      }),
    );

    const summary = partial.variables['loveLanguageSummary'] ?? '';

    expect(summary).toContain('肯定的言辞');
    // 缺失的三项既不出现在串里，也不以 0 分的形式出现
    expect(summary).not.toContain('接受礼物');
    expect(summary).not.toContain(' 0（');
  });

  it('主导爱的语言为空数组 → 占位文案（不回落成"按固定顺序取前两名"）', () => {
    const result = buildEmotionReportContext(input({ profile: profile({ primaryLoveLanguages: [] }) }));

    expect(result.variables['primaryLoveLanguages']).toBe(UNAVAILABLE_PLACEHOLDER);
    expect(result.unavailable).toContain('primaryLoveLanguages');
  });

  it('质量指标缺失时各自记入缺项，且不抛错', () => {
    const result = buildEmotionReportContext(
      input({
        profile: profile({ consistencyScore: null, completionRate: null, avgResponseMs: null, engineVersion: null }),
        answeredCount: null,
        questionCount: null,
        testDefinitionCode: null,
      }),
    );

    expect(result.variables['consistencyScore']).toBe(UNAVAILABLE_PLACEHOLDER);
    expect(result.variables['avgResponseSeconds']).toBe(UNAVAILABLE_PLACEHOLDER);
    expect(result.variables['answeredRatio']).toBe(UNAVAILABLE_PLACEHOLDER);
    expect(result.unavailable).toEqual(
      expect.arrayContaining([
        'consistencyScore',
        'completionRate',
        'avgResponseSeconds',
        'engineVersion',
        'testDefinitionCode',
        'answeredRatio',
      ]),
    );
  });

  it('题量为 0 时不产生 `0/0` 这种误导性的完成率串', () => {
    const result = buildEmotionReportContext(input({ answeredCount: 0, questionCount: 0 }));

    expect(result.variables['answeredRatio']).toBe(UNAVAILABLE_PLACEHOLDER);
  });

  it('未知的依恋/冲突编码原样输出（不猜、不映射成某个类型）', () => {
    const result = buildEmotionReportContext(
      input({ profile: profile({ attachmentStyle: 'ATTACH_NEW_KIND', conflictStyle: 'UNKNOWN_STYLE' }) }),
    );

    expect(result.variables['attachmentStyle']).toBe('ATTACH_NEW_KIND');
    expect(result.variables['conflictStyle']).toBe('UNKNOWN_STYLE');
  });

  it('四种依恋类型都有中文名（漏一个会以裸枚举形式进提示词）', () => {
    expect(Object.keys(EMOTION_ATTACHMENT_LABELS).sort()).toEqual(['ANXIOUS', 'AVOIDANT', 'FEARFUL', 'SECURE']);
  });
});
