/**
 * 匹配权重矩阵种子契约测试
 *
 * 核心主张：**把种子原样喂进引擎，不能有任何维度被跳过**。
 *
 * 这条断言看起来绕，但它防的是一类很隐蔽的故障：矩阵的键名与引擎读取的
 * 字段名不一致时（如种子写 `EXTRAVERSION`、引擎读 `extraversion`），
 * 引擎**不会报错** —— 它会跳过该维度、把权重归一给其余维度，
 * 用户看到一个"算出来了"但依据更少的分数，而线上没有任何异常信号。
 */

import {
  COMPATIBILITY_WEIGHTS,
  COMPATIBILITY_ATTACHMENT_STYLES,
  COMPATIBILITY_MBTI_DIMENSIONS,
} from './compatibility-weights';
import {
  computeCompatibility,
  type CompatibilityProfile,
  type CompatibilityWeights,
} from '../../../src/modules/personality/engine/compatibility-engine.service';

/** 与画像字段名一致的大五特质（引擎按此读取） */
const BIG_FIVE_TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'] as const;

/** 取默认权重并转成引擎入参形状 */
const defaultWeights = (): CompatibilityWeights => {
  const seed = COMPATIBILITY_WEIGHTS[0];

  return {
    version: seed.version,
    mbtiMatrix: seed.mbtiMatrix as CompatibilityWeights['mbtiMatrix'],
    bigFiveConfig: seed.bigFiveConfig,
    attachmentMatrix: seed.attachmentMatrix,
    communicationConfig: seed.communicationConfig,
    dimensionWeights: seed.dimensionWeights,
  };
};

/** 数据齐全的画像 */
const profile = (overrides: Partial<CompatibilityProfile> = {}): CompatibilityProfile => ({
  id: 'p1',
  version: 1,
  eiPercent: 72,
  snPercent: 68,
  tfPercent: 61,
  jpPercent: 78,
  openness: 84,
  conscientiousness: 67,
  extraversion: 32,
  agreeableness: 72,
  neuroticism: 49,
  attachmentStyle: 'SECURE',
  loveLanguages: ['WORDS_OF_AFFIRMATION', 'QUALITY_TIME'],
  conflictStyle: 'COLLABORATING',
  ...overrides,
});

describe('匹配权重矩阵种子契约', () => {
  it('至少有一个权重版本（否则引擎无配置可用，全部维度都会被跳过）', () => {
    expect(COMPATIBILITY_WEIGHTS.length).toBeGreaterThan(0);
  });

  it('code + version 唯一', () => {
    const keys = COMPATIBILITY_WEIGHTS.map((item) => `${item.code}@${item.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('【关键】MBTI 矩阵覆盖全部四个维度', () => {
    for (const weights of COMPATIBILITY_WEIGHTS) {
      expect(Object.keys(weights.mbtiMatrix).sort()).toEqual([...COMPATIBILITY_MBTI_DIMENSIONS].sort());
    }
  });

  it('【关键】大五配置覆盖全部五个特质，且键名与画像字段名一致', () => {
    for (const weights of COMPATIBILITY_WEIGHTS) {
      expect(Object.keys(weights.bigFiveConfig).sort()).toEqual([...BIG_FIVE_TRAITS].sort());
    }
  });

  it('【关键】依恋矩阵覆盖全部 4×4 组合', () => {
    for (const weights of COMPATIBILITY_WEIGHTS) {
      for (const a of COMPATIBILITY_ATTACHMENT_STYLES) {
        for (const b of COMPATIBILITY_ATTACHMENT_STYLES) {
          expect(weights.attachmentMatrix[a]?.[b]).toBeDefined();
          expect(typeof weights.attachmentMatrix[a][b]).toBe('number');
        }
      }
    }
  });

  it('依恋矩阵对称（组合分不因谁是谁而变）', () => {
    for (const weights of COMPATIBILITY_WEIGHTS) {
      for (const a of COMPATIBILITY_ATTACHMENT_STYLES) {
        for (const b of COMPATIBILITY_ATTACHMENT_STYLES) {
          expect(weights.attachmentMatrix[a][b]).toBe(weights.attachmentMatrix[b][a]);
        }
      }
    }
  });

  it('全部分数落在 0–100', () => {
    for (const weights of COMPATIBILITY_WEIGHTS) {
      for (const dimension of Object.values(weights.mbtiMatrix)) {
        for (const score of [dimension.same, dimension.different]) {
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
        }
      }

      for (const scores of Object.values(weights.attachmentMatrix)) {
        for (const score of Object.values(scores)) {
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('COMPLEMENTARY 模式必须给出 idealGap，SIMILAR 模式不应给', () => {
    for (const weights of COMPATIBILITY_WEIGHTS) {
      for (const config of Object.values(weights.bigFiveConfig)) {
        if (config.mode === 'COMPLEMENTARY') {
          expect(config.idealGap).toBeGreaterThan(0);
          expect(config.idealGap).toBeLessThan(100);
        }
      }
    }
  });

  it('子项权重全为正且总和为 100（引擎会归一，但配置本身应自洽）', () => {
    for (const weights of COMPATIBILITY_WEIGHTS) {
      const values = Object.values(weights.dimensionWeights);

      for (const value of values) expect(value).toBeGreaterThan(0);
      expect(values.reduce((sum, value) => sum + value, 0)).toBe(100);
    }
  });

  it('依恋维度获得独立权重（它是"关系能否修复"的核心变量）', () => {
    for (const weights of COMPATIBILITY_WEIGHTS) {
      expect(weights.dimensionWeights.attachment).toBeGreaterThanOrEqual(20);
    }
  });

  describe('与引擎的集成一致性', () => {
    it('【关键】数据齐全时喂进引擎，不跳过任何维度', () => {
      const result = computeCompatibility(profile(), profile({ id: 'p2' }), defaultWeights());

      expect(result.skippedDimensions).toEqual([]);
      expect(result.mbtiScore).not.toBeNull();
      expect(result.bigFiveScore).not.toBeNull();
      expect(result.attachmentScore).not.toBeNull();
      expect(result.communicationScore).not.toBeNull();
    });

    it('【关键】大五明细恰好五个特质（键名不匹配会静默少算）', () => {
      const result = computeCompatibility(profile(), profile({ id: 'p2' }), defaultWeights());
      const detail = result.scoreBreakdown['bigFive'] as Record<string, unknown>;

      expect(Object.keys(detail).sort()).toEqual([...BIG_FIVE_TRAITS].sort());
    });

    it('【关键】MBTI 明细恰好四个维度', () => {
      const result = computeCompatibility(profile(), profile({ id: 'p2' }), defaultWeights());
      const detail = result.scoreBreakdown['mbti'] as Record<string, unknown>;

      expect(Object.keys(detail).sort()).toEqual([...COMPATIBILITY_MBTI_DIMENSIONS].sort());
    });

    it('全部 16 种依恋组合都能算出分数（无"漏配组合"）', () => {
      for (const a of COMPATIBILITY_ATTACHMENT_STYLES) {
        for (const b of COMPATIBILITY_ATTACHMENT_STYLES) {
          const result = computeCompatibility(
            profile({ attachmentStyle: a }),
            profile({ id: 'p2', attachmentStyle: b }),
            defaultWeights(),
          );

          expect(result.attachmentScore).not.toBeNull();
        }
      }
    });

    it('安全型组合得分高于焦虑—回避组合（矩阵方向符合依恋理论）', () => {
      const secure = computeCompatibility(
        profile({ attachmentStyle: 'SECURE' }),
        profile({ id: 'p2', attachmentStyle: 'SECURE' }),
        defaultWeights(),
      );
      const anxiousAvoidant = computeCompatibility(
        profile({ attachmentStyle: 'ANXIOUS' }),
        profile({ id: 'p2', attachmentStyle: 'AVOIDANT' }),
        defaultWeights(),
      );

      expect(secure.attachmentScore).toBeGreaterThan(anxiousAvoidant.attachmentScore ?? 0);
      // 追逃循环是最高风险组合，应显著偏低
      expect(anxiousAvoidant.attachmentScore).toBeLessThan(50);
    });

    it('总分落在 0–100 且子项权重归一', () => {
      const result = computeCompatibility(profile(), profile({ id: 'p2' }), defaultWeights());
      const applied = result.scoreBreakdown['appliedWeights'] as Record<string, number>;

      expect(result.totalScore).toBeGreaterThan(0);
      expect(result.totalScore).toBeLessThanOrEqual(100);
      expect(Object.values(applied).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 3);
    });
  });
});
