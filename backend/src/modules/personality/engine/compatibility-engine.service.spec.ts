/**
 * CompatibilityEngine 测试
 *
 * 中心主张：
 *   · **确定性**：同一对画像 + 同一版权重永远得到同一分数（ADR-005）
 *   · **缺数据不编造**：某维度缺失时剔除并**重新归一权重**，而不是按 0 分算 ——
 *     后者会把"没测"表达成"关系很差"，是错误结论
 *   · **可解释**：总分能拆到四个子项，且 breakdown 记录实际生效的权重
 */

import { ErrorCode } from '../../../common/errors/error-code';
import {
  computeCompatibility,
  type CompatibilityProfile,
  type CompatibilityWeights,
} from './compatibility-engine.service';

const weights = (): CompatibilityWeights => ({
  version: '1.0.0',
  mbtiMatrix: {
    EI: { same: 70, different: 80 },
    SN: { same: 95, different: 55 },
    TF: { same: 85, different: 70 },
    JP: { same: 75, different: 80 },
  },
  bigFiveConfig: {
    openness: { mode: 'SIMILAR', weight: 1 },
    conscientiousness: { mode: 'SIMILAR', weight: 1.5 },
    extraversion: { mode: 'COMPLEMENTARY', idealGap: 20, weight: 1 },
    agreeableness: { mode: 'SIMILAR', weight: 1 },
    neuroticism: { mode: 'SIMILAR', weight: 1 },
  },
  attachmentMatrix: {
    SECURE: { SECURE: 95, ANXIOUS: 75, AVOIDANT: 70, FEARFUL: 60 },
    ANXIOUS: { AVOIDANT: 35, FEARFUL: 45 },
  },
  dimensionWeights: { mbti: 30, bigFive: 30, attachment: 25, communication: 15 },
});

const profile = (overrides: Partial<CompatibilityProfile> = {}): CompatibilityProfile => ({
  id: 'profile-1',
  version: 1,
  eiPercent: 80,
  snPercent: 75,
  tfPercent: 70,
  jpPercent: 65,
  openness: 70,
  conscientiousness: 60,
  extraversion: 50,
  agreeableness: 65,
  neuroticism: 45,
  attachmentStyle: 'SECURE',
  loveLanguages: ['WORDS_OF_AFFIRMATION', 'QUALITY_TIME'],
  conflictStyle: 'COLLABORATING',
  ...overrides,
});

describe('computeCompatibility', () => {
  describe('确定性与范围', () => {
    it('【关键】同一输入重复计算结果完全一致', () => {
      const first = computeCompatibility(profile(), profile({ id: 'b' }), weights());
      const second = computeCompatibility(profile(), profile({ id: 'b' }), weights());

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('总分与各子项都落在 0–100', () => {
      const result = computeCompatibility(
        profile(),
        profile({ id: 'b', eiPercent: 20, snPercent: 10, openness: 5 }),
        weights(),
      );

      for (const score of [
        result.totalScore,
        result.mbtiScore,
        result.bigFiveScore,
        result.attachmentScore,
        result.communicationScore,
      ]) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    });

    it('输出携带引擎版本（参与报告幂等键）', () => {
      expect(computeCompatibility(profile(), profile(), weights()).engineVersion).toBe('1.0.0');
    });
  });

  describe('MBTI 维度', () => {
    it('同极且偏好强烈时得分显著高于同极但偏好模糊（强度决定信号量）', () => {
      const strong = computeCompatibility(
        profile({ eiPercent: 95, snPercent: 95, tfPercent: 95, jpPercent: 95 }),
        profile({ id: 'b', eiPercent: 95, snPercent: 95, tfPercent: 95, jpPercent: 95 }),
        weights(),
      );
      const weak = computeCompatibility(
        profile({ eiPercent: 55, snPercent: 55, tfPercent: 55, jpPercent: 55 }),
        profile({ id: 'b', eiPercent: 55, snPercent: 55, tfPercent: 55, jpPercent: 55 }),
        weights(),
      );

      const sn = (strong.scoreBreakdown['mbti'] as Record<string, { anchor: number; isSame: boolean }>)['SN'];
      expect(sn.isSame).toBe(true);
      expect(sn.anchor).toBe(95);

      // 偏好模糊时信号不足，分数被拉向中性；偏好强烈时充分体现同极基准分
      expect(strong.mbtiScore).toBeGreaterThan(weak.mbtiScore ?? 0);
    });

    it('异极时采用 different 基准分', () => {
      const a = profile({ snPercent: 90 });
      const b = profile({ id: 'b', snPercent: 10 });

      const result = computeCompatibility(a, b, weights());
      const sn = (result.scoreBreakdown['mbti'] as Record<string, { isSame: boolean; anchor: number }>)['SN'];

      expect(sn.isSame).toBe(false);
      expect(sn.anchor).toBe(55);
    });

    it('【关键】双方偏好都接近 50 时收敛到中性分（信号不足 ≠ 不匹配）', () => {
      const a = profile({ snPercent: 51 });
      const b = profile({ id: 'b', snPercent: 95 });

      const result = computeCompatibility(a, b, weights());
      const sn = (result.scoreBreakdown['mbti'] as Record<string, { avgStrength: number }>)['SN'];

      // 一方强度几乎为 0，平均强度 ≈ 0.45，分数被拉向中性
      expect(sn.avgStrength).toBeLessThan(0.5);
    });
  });

  describe('大五特质', () => {
    it('SIMILAR 模式：完全一致得满分，最大差异得 0 分', () => {
      const same = computeCompatibility(profile({ openness: 70 }), profile({ id: 'b', openness: 70 }), weights());
      const far = computeCompatibility(profile({ openness: 100 }), profile({ id: 'b', openness: 0 }), weights());

      const sameDetail = (same.scoreBreakdown['bigFive'] as Record<string, { gap: number }>)['openness'];
      const farDetail = (far.scoreBreakdown['bigFive'] as Record<string, { gap: number }>)['openness'];

      expect(sameDetail.gap).toBe(0);
      expect(farDetail.gap).toBe(100);
    });

    it('COMPLEMENTARY 模式：差异等于 idealGap 时最佳', () => {
      // extraversion idealGap = 20
      const ideal = computeCompatibility(
        profile({ extraversion: 60 }),
        profile({ id: 'b', extraversion: 40 }),
        weights(),
      );
      const zero = computeCompatibility(
        profile({ extraversion: 60 }),
        profile({ id: 'b', extraversion: 60 }),
        weights(),
      );

      const idealDetail = (ideal.scoreBreakdown['bigFive'] as Record<string, { gap: number }>)['extraversion'];
      const zeroDetail = (zero.scoreBreakdown['bigFive'] as Record<string, { gap: number }>)['extraversion'];

      expect(idealDetail.gap).toBe(20);
      expect(zeroDetail.gap).toBe(0);
      // 差异 0 在互补模式下不如差异 20
      expect(ideal.bigFiveScore).toBeGreaterThan(zero.bigFiveScore ?? 0);
    });

    it('特质权重影响子项得分（尽责性权重 1.5 高于其他）', () => {
      // 让尽责性差异极大、其他特质完全一致 → 子项分数应明显低于满分
      const result = computeCompatibility(
        profile({ conscientiousness: 100 }),
        profile({ id: 'b', conscientiousness: 0 }),
        weights(),
      );

      expect(result.bigFiveScore).toBeLessThan(80);
    });
  });

  describe('依恋风格矩阵', () => {
    it('命中矩阵直接取分', () => {
      const result = computeCompatibility(
        profile({ attachmentStyle: 'SECURE' }),
        profile({ id: 'b', attachmentStyle: 'SECURE' }),
        weights(),
      );

      expect(result.attachmentScore).toBe(95);
    });

    it('【关键】矩阵只写了一个方向时双向查找仍能命中', () => {
      // 矩阵里只有 ANXIOUS.AVOIDANT，没有 AVOIDANT.ANXIOUS
      const forward = computeCompatibility(
        profile({ attachmentStyle: 'ANXIOUS' }),
        profile({ id: 'b', attachmentStyle: 'AVOIDANT' }),
        weights(),
      );
      const reverse = computeCompatibility(
        profile({ attachmentStyle: 'AVOIDANT' }),
        profile({ id: 'b', attachmentStyle: 'ANXIOUS' }),
        weights(),
      );

      expect(forward.attachmentScore).toBe(35);
      expect(reverse.attachmentScore).toBe(35);
    });

    it('矩阵未覆盖的组合按缺失处理（不猜分数）', () => {
      const result = computeCompatibility(
        profile({ attachmentStyle: 'FEARFUL' }),
        profile({ id: 'b', attachmentStyle: 'FEARFUL' }),
        weights(),
      );

      expect(result.attachmentScore).toBeNull();
      expect(result.skippedDimensions).toContain('attachment');
    });
  });

  describe('沟通偏好', () => {
    it('共享的爱的语言越多得分越高', () => {
      const shared = computeCompatibility(
        profile(),
        profile({ id: 'b', loveLanguages: ['WORDS_OF_AFFIRMATION', 'QUALITY_TIME'] }),
        weights(),
      );
      const none = computeCompatibility(profile(), profile({ id: 'b', loveLanguages: ['RECEIVING_GIFTS'] }), weights());

      expect(shared.communicationScore).toBeGreaterThan(none.communicationScore ?? 0);
    });

    it('冲突风格相同优于不同（但不是零分）', () => {
      const same = computeCompatibility(profile(), profile({ id: 'b' }), weights());
      const different = computeCompatibility(profile(), profile({ id: 'b', conflictStyle: 'AVOIDING' }), weights());

      expect(same.communicationScore).toBeGreaterThan(different.communicationScore ?? 0);
      expect(different.communicationScore).toBeGreaterThan(0);
    });

    it('冲突风格缺失时仅按爱的语言计分（不因缺项判 0）', () => {
      const result = computeCompatibility(profile(), profile({ id: 'b', conflictStyle: null }), weights());
      const detail = result.scoreBreakdown['communication'] as Record<string, unknown>;

      expect(detail['conflictScore']).toBeNull();
      expect(result.communicationScore).toBeGreaterThan(50);
    });
  });

  describe('缺数据处理与权重归一', () => {
    it('【关键】单个维度缺失时剔除并重新归一权重，而不是按 0 分计入', () => {
      const withoutAttachment = computeCompatibility(
        profile({ attachmentStyle: 'FEARFUL' }),
        profile({ id: 'b', attachmentStyle: 'FEARFUL' }),
        weights(),
      );

      const applied = withoutAttachment.scoreBreakdown['appliedWeights'] as Record<string, number>;

      // 依恋维度不应出现在生效权重里
      expect(applied['attachment']).toBeUndefined();
      expect(withoutAttachment.skippedDimensions).toEqual(['attachment']);
      // 其余三个维度的权重之和应为 1
      const total = Object.values(applied).reduce((sum, value) => sum + value, 0);
      expect(total).toBeCloseTo(1, 3);
    });

    it('【关键】缺失维度的权重按比例放大到其余维度（mbti 由 0.30 升到约 0.40）', () => {
      const result = computeCompatibility(
        profile({ attachmentStyle: 'FEARFUL' }),
        profile({ id: 'b', attachmentStyle: 'FEARFUL' }),
        weights(),
      );
      const applied = result.scoreBreakdown['appliedWeights'] as Record<string, number>;

      // 30 / (30+30+15) ≈ 0.4
      expect(applied['mbti']).toBeCloseTo(0.4, 2);
    });

    it('MBTI 缺失时该子项为 null 并从权重中剔除', () => {
      const result = computeCompatibility(
        profile({ eiPercent: null, snPercent: null, tfPercent: null, jpPercent: null }),
        profile({ id: 'b' }),
        weights(),
      );

      expect(result.mbtiScore).toBeNull();
      expect(result.skippedDimensions).toContain('mbti');
    });

    it('【关键】全部维度都无数据时抛错（不产出"无依据的分数"）', () => {
      const empty: Partial<CompatibilityProfile> = {
        eiPercent: null,
        snPercent: null,
        tfPercent: null,
        jpPercent: null,
        openness: null,
        conscientiousness: null,
        extraversion: null,
        agreeableness: null,
        neuroticism: null,
        attachmentStyle: null,
        loveLanguages: [],
        conflictStyle: null,
      };

      // 沟通子项仍可计分（缺失时给基准分），因此这里用「权重全 0」模拟无有效维度
      const zeroWeights = weights();
      const broken: CompatibilityWeights = {
        ...zeroWeights,
        dimensionWeights: { mbti: 0, bigFive: 0, attachment: 0, communication: 0 },
      };

      expect(() => computeCompatibility(profile(empty), profile({ id: 'b', ...empty }), broken)).toThrow(
        expect.objectContaining({ code: ErrorCode.AI_OUTPUT_INVALID }),
      );
    });

    it('skippedDimensions 完整列出被剔除的维度', () => {
      const empty: Partial<CompatibilityProfile> = {
        openness: null,
        conscientiousness: null,
        extraversion: null,
        agreeableness: null,
        neuroticism: null,
        attachmentStyle: null,
      };

      const result = computeCompatibility(profile(empty), profile({ id: 'b', ...empty }), weights());

      expect(result.skippedDimensions).toEqual(expect.arrayContaining(['bigFive', 'attachment']));
    });
  });

  describe('可解释性', () => {
    it('breakdown 含权重版本、引擎版本与生效权重', () => {
      const breakdown = computeCompatibility(profile(), profile({ id: 'b' }), weights()).scoreBreakdown;

      expect(breakdown['weightsVersion']).toBe('1.0.0');
      expect(breakdown['engineVersion']).toBe('1.0.0');
      expect(breakdown['appliedWeights']).toBeDefined();
    });

    it('breakdown 逐维度记录明细（前端可画拆解图）', () => {
      const breakdown = computeCompatibility(profile(), profile({ id: 'b' }), weights()).scoreBreakdown;

      expect(Object.keys(breakdown['mbti'] as object).sort()).toEqual(['EI', 'JP', 'SN', 'TF']);
      expect(Object.keys(breakdown['bigFive'] as object)).toHaveLength(5);
    });
  });
});
