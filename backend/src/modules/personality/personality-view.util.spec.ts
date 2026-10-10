/**
 * 画像视图纯函数测试
 *
 * 这些函数决定了「用户看到的画像数字与档位」，边界错误会直接表现为**误导性展示**
 * （例如把「几乎无倾向」显示成「非常明确」）。因此逐一锁定边界值。
 */

import {
  aggregatePoints,
  clampPercent,
  computeTrend,
  rangeToDays,
  resolveConfidenceLevel,
  resolveDimensionStrength,
  round1,
  type ProfileSnapshotValues,
  type RawSeriesPoint,
} from './personality-view.util';

// ============================================================================
// 强度分级
// ============================================================================

describe('resolveDimensionStrength', () => {
  it.each([
    [50, 'SLIGHT'],
    [51, 'SLIGHT'],
    [62, 'SLIGHT'],
    [63, 'MODERATE'],
    [65, 'MODERATE'],
    [79, 'MODERATE'],
    [80, 'CLEAR'],
    [85, 'CLEAR'],
    [91, 'CLEAR'],
    [92, 'VERY_CLEAR'],
    [100, 'VERY_CLEAR'],
  ] as const)('percent %i → %s', (percent, expected) => {
    expect(resolveDimensionStrength(percent)).toBe(expected);
  });

  it('对称：偏离中位的距离相同则档位相同', () => {
    expect(resolveDimensionStrength(70)).toBe(resolveDimensionStrength(30));
    expect(resolveDimensionStrength(95)).toBe(resolveDimensionStrength(5));
  });

  it('【与文档示例一致】61.4→SLIGHT、65.5→MODERATE、68.2→MODERATE、72.8→MODERATE', () => {
    expect(resolveDimensionStrength(61.4)).toBe('SLIGHT');
    expect(resolveDimensionStrength(65.5)).toBe('MODERATE');
    expect(resolveDimensionStrength(68.2)).toBe('MODERATE');
    expect(resolveDimensionStrength(72.8)).toBe('MODERATE');
  });

  it('非有限数按「无倾向」处理（50 → SLIGHT）', () => {
    expect(resolveDimensionStrength(Number.NaN)).toBe('SLIGHT');
    expect(resolveDimensionStrength(Number.POSITIVE_INFINITY)).toBe('SLIGHT');
  });

  it('超出 0–100 的值被截断后再分档（不产生越界档位）', () => {
    expect(resolveDimensionStrength(200)).toBe('VERY_CLEAR');
    expect(resolveDimensionStrength(-100)).toBe('VERY_CLEAR');
  });
});

describe('clampPercent', () => {
  it('区间内原样返回', () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(100)).toBe(100);
  });

  it('越界截断', () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(150)).toBe(100);
  });

  it('非有限数回退 50（中位，避免污染展示）', () => {
    expect(clampPercent(Number.NaN)).toBe(50);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(50);
  });
});

describe('round1', () => {
  it('保留 1 位小数', () => {
    expect(round1(34.55)).toBe(34.6);
    expect(round1(68.24)).toBe(68.2);
    expect(round1(100)).toBe(100);
  });

  it('非有限数返回 0', () => {
    expect(round1(Number.NaN)).toBe(0);
  });
});

// ============================================================================
// 置信度分级
// ============================================================================

describe('resolveConfidenceLevel', () => {
  it.each([
    [100, 'HIGH'],
    [75, 'HIGH'],
    [74.9, 'MEDIUM'],
    [60, 'MEDIUM'],
    [59.9, 'LOW'],
    [0, 'LOW'],
  ] as const)('一致性 %f → %s', (score, expected) => {
    expect(resolveConfidenceLevel(score)).toBe(expected);
  });

  it('【与引擎文案一致】低于 60 分为 LOW（此时引擎会返回「建议重测」提示）', () => {
    expect(resolveConfidenceLevel(59)).toBe('LOW');
    expect(resolveConfidenceLevel(60)).toBe('MEDIUM');
  });

  it('非有限数按 LOW 处理（宁可提示置信度低，也不假装可信）', () => {
    expect(resolveConfidenceLevel(Number.NaN)).toBe('LOW');
  });
});

// ============================================================================
// 趋势对比
// ============================================================================

describe('computeTrend', () => {
  const build = (overrides: Partial<ProfileSnapshotValues> = {}): ProfileSnapshotValues => ({
    version: 3,
    generatedAt: '2026-02-14T13:38:12.000Z',
    mbtiType: 'INFJ',
    confidence: 78.4,
    dimensions: { EI: 34.5, SN: 68.2, TF: 61.4, JP: 72.8 },
    bigFive: {
      openness: 82.5,
      conscientiousness: 71,
      extraversion: 34.5,
      agreeableness: 88,
      neuroticism: 56.5,
    },
    ...overrides,
  });

  it('计算各维度与大五的差值', () => {
    const current = build();
    const previous = build({
      version: 2,
      confidence: 74.1,
      dimensions: { EI: 38.1, SN: 64.8, TF: 58.9, JP: 70.2 },
      bigFive: {
        openness: 81,
        conscientiousness: 73,
        extraversion: 35.7,
        agreeableness: 84.6,
        neuroticism: 58.3,
      },
    });

    const trend = computeTrend(current, previous);

    expect(trend.comparedWithVersion).toBe(2);
    expect(trend.comparedAt).toBe(previous.generatedAt);
    expect(trend.confidenceDelta).toBe(4.3);
    expect(trend.dimensionDelta).toEqual([
      { dimension: 'EI', previous: 38.1, current: 34.5, delta: -3.6 },
      { dimension: 'SN', previous: 64.8, current: 68.2, delta: 3.4 },
      { dimension: 'TF', previous: 58.9, current: 61.4, delta: 2.5 },
      { dimension: 'JP', previous: 70.2, current: 72.8, delta: 2.6 },
    ]);
    expect(trend.bigFiveDelta).toEqual({
      openness: 1.5,
      conscientiousness: -2,
      extraversion: -1.2,
      agreeableness: 3.4,
      neuroticism: -1.8,
    });
  });

  it('类型变化时 mbtiChanged 为 true', () => {
    const trend = computeTrend(build({ mbtiType: 'INFJ' }), build({ version: 2, mbtiType: 'INFP' }));

    expect(trend.mbtiChanged).toBe(true);
  });

  it('类型未变时 mbtiChanged 为 false', () => {
    const trend = computeTrend(build({ mbtiType: 'INFJ' }), build({ version: 2, mbtiType: 'INFJ' }));

    expect(trend.mbtiChanged).toBe(false);
  });

  it('【关键】缺失维度不参与对比，而是记入 missingDimensions', () => {
    // 上一版本没有 TF 数据：把 null 当 0 会显示「+61.4」的假变化
    const trend = computeTrend(build(), build({ version: 2, dimensions: { EI: 38.1, SN: 64.8, JP: 70.2 } }));

    expect(trend.dimensionDelta.map((item) => item.dimension)).toEqual(['EI', 'SN', 'JP']);
    expect(trend.missingDimensions).toContain('TF');
  });

  it('大五维度缺失时同样跳过并记录', () => {
    const trend = computeTrend(
      build(),
      build({
        version: 2,
        bigFive: { openness: 81, conscientiousness: 73, extraversion: 35.7, agreeableness: 84.6 },
      }),
    );

    expect(trend.bigFiveDelta['neuroticism']).toBeUndefined();
    expect(trend.missingDimensions).toContain('neuroticism');
  });

  it('完全相同的数据 → 所有差值为 0', () => {
    const trend = computeTrend(build(), build({ version: 2 }));

    expect(trend.confidenceDelta).toBe(0);
    expect(trend.dimensionDelta.every((item) => item.delta === 0)).toBe(true);
    expect(Object.values(trend.bigFiveDelta).every((delta) => delta === 0)).toBe(true);
  });

  it('差值保留 1 位小数（避免浮点长尾）', () => {
    const trend = computeTrend(build({ confidence: 78.44 }), build({ version: 2, confidence: 74.11 }));

    expect(trend.confidenceDelta).toBe(4.3);
  });
});

// ============================================================================
// 时间序列聚合
// ============================================================================

describe('aggregatePoints', () => {
  const point = (timestamp: string, values: Record<string, number>): RawSeriesPoint => ({ timestamp, values });

  describe('RAW（不聚合）', () => {
    it('每个点原样返回，sampleCount 恒为 1', () => {
      const points = [point('2026-01-18T14:00:00.000Z', { openness: 78 })];

      const result = aggregatePoints(points, 'RAW');

      expect(result).toEqual([
        {
          date: '2026-01-18',
          timestamp: '2026-01-18T14:00:00.000Z',
          values: { openness: 78 },
          sampleCount: 1,
        },
      ]);
    });

    it('不修改入参', () => {
      const points = [point('2026-01-18T14:00:00.000Z', { openness: 78 })];
      const snapshot = JSON.parse(JSON.stringify(points)) as unknown;

      aggregatePoints(points, 'RAW');

      expect(JSON.parse(JSON.stringify(points))).toEqual(snapshot);
    });
  });

  describe('WEEK（按自然周聚合）', () => {
    it('同一周的多个点合并为一条，数值取算术平均', () => {
      // 2026-01-19 是周一；01-21 与 01-23 同属该周
      const points = [
        point('2026-01-19T10:00:00.000Z', { openness: 70 }),
        point('2026-01-21T10:00:00.000Z', { openness: 80 }),
        point('2026-01-23T10:00:00.000Z', { openness: 90 }),
      ];

      const result = aggregatePoints(points, 'WEEK');

      expect(result).toHaveLength(1);
      expect(result[0]?.date).toBe('2026-01-19');
      expect(result[0]?.values['openness']).toBe(80);
      expect(result[0]?.sampleCount).toBe(3);
      // 时间戳取桶内最后一条
      expect(result[0]?.timestamp).toBe('2026-01-23T10:00:00.000Z');
    });

    it('跨周的点分属不同桶，并按时间升序返回', () => {
      const points = [
        point('2026-02-02T10:00:00.000Z', { openness: 60 }), // 周一
        point('2026-01-19T10:00:00.000Z', { openness: 70 }), // 上一周的周一
      ];

      const result = aggregatePoints(points, 'WEEK');

      expect(result.map((item) => item.date)).toEqual(['2026-01-19', '2026-02-02']);
    });

    it('周日的点归属到该周的周一（ISO 周）', () => {
      // 2026-01-25 是周日，应归属 2026-01-19 那一周
      const result = aggregatePoints([point('2026-01-25T10:00:00.000Z', { openness: 50 })], 'WEEK');

      expect(result[0]?.date).toBe('2026-01-19');
    });
  });

  describe('MONTH（按自然月聚合）', () => {
    it('同一月的点合并，日期为该月 1 日', () => {
      const points = [
        point('2026-01-05T10:00:00.000Z', { openness: 60 }),
        point('2026-01-25T10:00:00.000Z', { openness: 80 }),
        point('2026-02-03T10:00:00.000Z', { openness: 90 }),
      ];

      const result = aggregatePoints(points, 'MONTH');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ date: '2026-01-01', sampleCount: 2 });
      expect(result[0]?.values['openness']).toBe(70);
      expect(result[1]).toMatchObject({ date: '2026-02-01', sampleCount: 1 });
    });
  });

  describe('多维与异常输入', () => {
    it('多维度分别取平均，缺失维度不影响其他维度', () => {
      const points = [
        point('2026-01-05T10:00:00.000Z', { openness: 60, extraversion: 40 }),
        point('2026-01-06T10:00:00.000Z', { openness: 80 }), // 缺 extraversion
      ];

      const result = aggregatePoints(points, 'MONTH');

      expect(result[0]?.values['openness']).toBe(70);
      expect(result[0]?.values['extraversion']).toBe(40);
    });

    it('非有限数值被忽略，不参与平均（避免 NaN 污染整条曲线）', () => {
      const points = [
        point('2026-01-05T10:00:00.000Z', { openness: 60 }),
        point('2026-01-06T10:00:00.000Z', { openness: Number.NaN }),
      ];

      const result = aggregatePoints(points, 'MONTH');

      expect(result[0]?.values['openness']).toBe(60);
    });

    it('非法时间戳的点被跳过', () => {
      const points = [point('not-a-date', { openness: 60 }), point('2026-01-05T10:00:00.000Z', { openness: 80 })];

      const result = aggregatePoints(points, 'MONTH');

      expect(result).toHaveLength(1);
      expect(result[0]?.values['openness']).toBe(80);
    });

    it('空输入返回空数组', () => {
      expect(aggregatePoints([], 'RAW')).toEqual([]);
      expect(aggregatePoints([], 'WEEK')).toEqual([]);
    });
  });
});

describe('rangeToDays', () => {
  it.each([
    ['30D', 30],
    ['90D', 90],
    ['180D', 180],
    ['365D', 365],
  ] as const)('%s → %i 天', (range, expected) => {
    expect(rangeToDays(range)).toBe(expected);
  });

  it('ALL 与非枚举值返回 null（表示不限时间）', () => {
    expect(rangeToDays('ALL')).toBeNull();
    expect(rangeToDays('unknown')).toBeNull();
  });
});
