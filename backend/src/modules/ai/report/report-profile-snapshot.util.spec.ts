/**
 * 画像快照纯函数测试
 *
 * 这一层的职责只有一个：把数据库行**如实**翻译成前端画图要用的结构。
 * 因此这里盯的是三件事：
 *   · JSONB 列被收窄（脏数据不许变成 `NaN` 的条形宽度）；
 *   · 结论与结果页**同源**（同一份画像 → 同一段话）；
 *   · 输出里只有编码与数值，**没有中文标签**（标签的唯一来源是前端 config，
 *     两处都写一份迟早会分叉）。
 */

import {
  buildEmotionProfileSnapshot,
  buildPersonalityProfileSnapshot,
  type EmotionSnapshotSource,
  type PersonalitySnapshotSource,
} from './report-profile-snapshot.util';

const emotionSource = (overrides: Partial<EmotionSnapshotSource> = {}): EmotionSnapshotSource => ({
  attachmentStyle: 'ANXIOUS',
  attachmentAnxiety: 52.38,
  attachmentAvoidance: 0,
  loveLanguageScores: {
    LOVE_WORDS: 60,
    LOVE_TIME: 62.07,
    LOVE_GIFTS: 6.25,
    LOVE_SERVICE: 4.55,
    LOVE_TOUCH: 63.16,
  },
  primaryLoveLanguages: ['LOVE_TOUCH', 'LOVE_TIME'],
  conflictStyle: 'CONFLICT_COLLABORATING',
  conflictScores: {
    CONFLICT_AVOIDING: 0,
    CONFLICT_COMPETING: 20,
    CONFLICT_COMPROMISING: 20,
    CONFLICT_ACCOMMODATING: 50,
    CONFLICT_COLLABORATING: 100,
  },
  completionRate: 100,
  consistencyScore: 100,
  ...overrides,
});

const personalitySource = (overrides: Partial<PersonalitySnapshotSource> = {}): PersonalitySnapshotSource => ({
  mbtiType: 'INFJ',
  mbtiConfidence: 0.82,
  eiPercent: 38,
  snPercent: 24,
  tfPercent: 71,
  jpPercent: 66,
  openness: 78,
  conscientiousness: 64,
  extraversion: 32,
  agreeableness: 70,
  neuroticism: 45,
  consistencyScore: 88,
  ...overrides,
});

describe('buildEmotionProfileSnapshot', () => {
  it('逐字段带出两轴、五项爱语、五种冲突与身份编码', () => {
    const snapshot = buildEmotionProfileSnapshot(emotionSource(), { anxiety: 50, avoidance: 50 });

    expect(snapshot.kind).toBe('EMOTION');
    expect(snapshot.attachmentStyle).toBe('ANXIOUS');
    expect(snapshot.attachmentAnxiety).toBe(52.38);
    expect(snapshot.attachmentAvoidance).toBe(0);
    expect(snapshot.thresholds).toEqual({ anxiety: 50, avoidance: 50 });
    expect(Object.keys(snapshot.loveLanguageScores)).toHaveLength(5);
    expect(Object.keys(snapshot.conflictScores)).toHaveLength(5);
    expect(snapshot.primaryLoveLanguages).toEqual(['LOVE_TOUCH', 'LOVE_TIME']);
    expect(snapshot.conflictStyle).toBe('CONFLICT_COLLABORATING');
  });

  it('【关键】JSONB 里的脏数据被丢弃（否则条形图宽度会变成 NaN）', () => {
    const snapshot = buildEmotionProfileSnapshot(
      emotionSource({
        loveLanguageScores: {
          LOVE_WORDS: 60,
          LOVE_TIME: '不是数字',
          LOVE_GIFTS: Number.NaN,
          LOVE_SERVICE: null,
          LOVE_TOUCH: Number.POSITIVE_INFINITY,
        },
        conflictScores: '整个都不是对象',
      }),
      { anxiety: 50, avoidance: 50 },
    );

    expect(snapshot.loveLanguageScores).toEqual({ LOVE_WORDS: 60 });
    expect(snapshot.conflictScores).toEqual({});
  });

  it('【关键】结论与结果页同源：同一份画像得到同一段话', () => {
    const first = buildEmotionProfileSnapshot(emotionSource(), { anxiety: 50, avoidance: 50 });
    const second = buildEmotionProfileSnapshot(emotionSource(), { anxiety: 50, avoidance: 50 });

    expect(second.conclusion).toEqual(first.conclusion);
    expect(first.conclusion.headline).toContain('被冷落');
    // 最低分那一项要被点出来（"对你几乎不起作用"），这是全文最能让用户恍然的一句
    expect(first.conclusion.needs).toContain('服务的行动');
  });

  it('缺数据（全 null）不抛错，仍然给出一份可展示的结论', () => {
    const snapshot = buildEmotionProfileSnapshot(
      emotionSource({
        loveLanguageScores: null,
        conflictScores: null,
        primaryLoveLanguages: [],
        completionRate: null,
        consistencyScore: null,
      }),
      { anxiety: 50, avoidance: 50 },
    );

    expect(snapshot.loveLanguageScores).toEqual({});
    expect(snapshot.conclusion.headline.length).toBeGreaterThan(0);
    expect(snapshot.completionRate).toBeNull();
  });

  /**
   * ⚠ 这条断言第一次写错了，而且错得有价值，值得留个记号
   *
   * 我原本断言"整个快照 JSON 里不出现『身体的接触』"—— 判红了，但**实现是对的**：
   * `conclusion` 是**给用户读的中文散文**（"你最需要的是「身体的接触」与「精心的时刻」"），
   * 它当然含中文标签。
   *
   * "只发编码不发标签"这条规则的真正范围是**结构化字段**：
   * `attachmentStyle` / `loveLanguageScores` 的键 / `conflictStyle` 必须是编码，
   * 前端靠 `config/modules.ts` 的标签表渲染。因此断言要排除掉 `conclusion`。
   */
  it('结构化字段只发编码，不发中文标签（标签的唯一来源是前端 config）', () => {
    const snapshot = buildEmotionProfileSnapshot(emotionSource(), { anxiety: 50, avoidance: 50 });
    const { conclusion, ...codes } = snapshot;

    expect(conclusion.needs.length).toBeGreaterThan(0);

    const encoded = JSON.stringify(codes);

    expect(encoded).not.toContain('身体的接触');
    expect(encoded).not.toContain('焦虑型');
    expect(encoded).toContain('LOVE_TOUCH');
    expect(encoded).toContain('ANXIOUS');
  });

  it('主爱语数组是副本（调用方后续改原数组不影响快照）', () => {
    const primary = ['LOVE_TOUCH'];
    const snapshot = buildEmotionProfileSnapshot(emotionSource({ primaryLoveLanguages: primary }), {
      anxiety: 50,
      avoidance: 50,
    });

    primary.push('LOVE_TIME');

    expect(snapshot.primaryLoveLanguages).toEqual(['LOVE_TOUCH']);
  });
});

describe('buildPersonalityProfileSnapshot', () => {
  it('四维与大五逐字段带出，键名与前端 config 对齐', () => {
    const snapshot = buildPersonalityProfileSnapshot(personalitySource());

    expect(snapshot).toMatchObject({
      kind: 'PERSONALITY',
      mbtiType: 'INFJ',
      mbtiConfidence: 0.82,
      dimensions: { EI: 38, SN: 24, TF: 71, JP: 66 },
      bigFive: {
        openness: 78,
        conscientiousness: 64,
        extraversion: 32,
        agreeableness: 70,
        neuroticism: 45,
      },
      consistencyScore: 88,
    });
  });
});
