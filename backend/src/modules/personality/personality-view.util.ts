/**
 * 画像视图纯函数
 *
 * 抽为独立模块的原因与 `engine-math.util.ts` 一致：这里的阈值分档、趋势计算、时间聚合
 * 都是**有明确边界的纯逻辑**，放在 Service 私有方法里只能靠构造数据库数据间接覆盖。
 *
 * 这些函数不访问任何 I/O，因此可以直接单测到 100% 分支覆盖。
 */

// ============================================================================
// 维度强度分级
// ============================================================================

/** 维度倾向强度 */
export type DimensionStrength = 'SLIGHT' | 'MODERATE' | 'CLEAR' | 'VERY_CLEAR';

/**
 * 强度分档阈值（按偏离中位 50 的距离）
 *
 * 档位边界与 API 文档 §3.4.1 的示例保持一致（TF 61.4→SLIGHT、EI 34.5→MODERATE、JP 72.8→MODERATE）。
 * 含义：越偏离中位说明倾向越明确；接近中位则说明两极性相当，轻微波动即可翻转字母。
 */
const STRENGTH_THRESHOLDS: ReadonlyArray<{ max: number; level: DimensionStrength }> = [
  { max: 13, level: 'SLIGHT' },
  { max: 30, level: 'MODERATE' },
  { max: 42, level: 'CLEAR' },
  { max: Number.POSITIVE_INFINITY, level: 'VERY_CLEAR' },
];

/** 由百分比推导倾向强度 */
export const resolveDimensionStrength = (percent: number): DimensionStrength => {
  const deviation = Math.abs(clampPercent(percent) - 50);

  for (const { max, level } of STRENGTH_THRESHOLDS) {
    if (deviation < max) return level;
  }

  return 'VERY_CLEAR';
};

/** 把任意数值限制在 0–100（非有限数回退 50，即「无倾向」） */
export const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
};

/** 保留 1 位小数（画像百分比展示精度） */
export const round1 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
};

// ============================================================================
// 置信度分级
// ============================================================================

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * 一致性分数 → 置信度档位
 *
 * 与引擎的「质量提示」阈值对齐：低于 60 分时引擎会返回「建议重测」提示，
 * 因此这里把 60 以下定为 LOW，保证文案与档位不矛盾。
 */
export const resolveConfidenceLevel = (consistencyScore: number): ConfidenceLevel => {
  if (!Number.isFinite(consistencyScore)) return 'LOW';
  if (consistencyScore >= 75) return 'HIGH';
  if (consistencyScore >= 60) return 'MEDIUM';
  return 'LOW';
};

// ============================================================================
// 趋势对比
// ============================================================================

/** 单个维度的变化 */
export interface DimensionDelta {
  dimension: string;
  previous: number;
  current: number;
  delta: number;
}

/** 趋势对比结果 */
export interface ProfileTrend {
  comparedWithVersion: number;
  comparedAt: string;
  mbtiChanged: boolean;
  confidenceDelta: number;
  dimensionDelta: DimensionDelta[];
  bigFiveDelta: Record<string, number>;
  /** 数据完整性提示：缺失维度会出现在此列表中（前端可据此弱化展示） */
  missingDimensions: string[];
}

/** 参与趋势对比的 MBTI 维度 */
const MBTI_DIMENSION_KEYS = ['EI', 'SN', 'TF', 'JP'] as const;

/** 参与趋势对比的大五维度 */
const BIG_FIVE_DIMENSION_KEYS = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
] as const;

/**
 * 计算与上一版本的差异
 *
 * 设计要点：**缺失数据不参与对比**，而是记录在 `missingDimensions` 中。
 * 理由：把缺失值当作 0 会产生「巨大变化」的假象（例如从 null 到 70 显示 +70），
 * 这比「不显示该维度趋势」更有误导性。
 */
export const computeTrend = (current: ProfileSnapshotValues, previous: ProfileSnapshotValues): ProfileTrend => {
  const dimensionDelta: DimensionDelta[] = [];
  const missingDimensions: string[] = [];

  for (const dimension of MBTI_DIMENSION_KEYS) {
    const currentValue = current.dimensions[dimension];
    const previousValue = previous.dimensions[dimension];

    if (currentValue === undefined || previousValue === undefined) {
      missingDimensions.push(dimension);
      continue;
    }

    dimensionDelta.push({
      dimension,
      previous: round1(previousValue),
      current: round1(currentValue),
      delta: round1(currentValue - previousValue),
    });
  }

  const bigFiveDelta: Record<string, number> = {};
  for (const key of BIG_FIVE_DIMENSION_KEYS) {
    const currentValue = current.bigFive[key];
    const previousValue = previous.bigFive[key];

    if (currentValue === undefined || previousValue === undefined) {
      missingDimensions.push(key);
      continue;
    }

    bigFiveDelta[key] = round1(currentValue - previousValue);
  }

  return {
    comparedWithVersion: previous.version,
    comparedAt: previous.generatedAt,
    mbtiChanged: current.mbtiType !== previous.mbtiType,
    confidenceDelta: round1(current.confidence - previous.confidence),
    dimensionDelta,
    bigFiveDelta,
    missingDimensions,
  };
};

/** 趋势计算所需的画像数值快照 */
export interface ProfileSnapshotValues {
  version: number;
  generatedAt: string;
  mbtiType: string | null;
  confidence: number;
  dimensions: Record<string, number>;
  bigFive: Record<string, number>;
}

// ============================================================================
// 时间序列聚合
// ============================================================================

/** 聚合粒度 */
export type SnapshotGranularity = 'RAW' | 'WEEK' | 'MONTH';

/** 待聚合的原始点（值可能是多维度） */
export interface RawSeriesPoint {
  timestamp: string;
  values: Record<string, number>;
}

/** 聚合后的点 */
export interface SeriesPoint {
  /** 展示用日期：RAW 为当日、WEEK 为该周周一、MONTH 为该月 1 日 */
  date: string;
  timestamp: string;
  values: Record<string, number>;
  /** 该点聚合了多少条原始记录（RAW 恒为 1） */
  sampleCount: number;
}

/** 取 UTC 日期字符串 YYYY-MM-DD */
const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

/** 取该周的周一（ISO 周：周一为一周开始） */
const startOfWeek = (date: Date): Date => {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay(): 0=周日 … 6=周六；转换为「距离周一的天数」
  const dayOffset = (result.getUTCDay() + 6) % 7;
  result.setUTCDate(result.getUTCDate() - dayOffset);
  return result;
};

/** 取该月 1 日 */
const startOfMonth = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

/** 计算某个时间点所属的聚合桶键 */
const bucketKeyOf = (date: Date, granularity: SnapshotGranularity): Date => {
  if (granularity === 'WEEK') return startOfWeek(date);
  if (granularity === 'MONTH') return startOfMonth(date);
  return date;
};

/**
 * 按粒度聚合时间序列
 *
 * 聚合值取区间**算术平均**（对人格分数而言，均值比末值更能代表一段时间内的水平）。
 * 时间戳取桶内**最后一条**记录的时间，便于前端标注「最近一次测量」。
 *
 * @param points 必须已按时间升序排列
 */
export const aggregatePoints = (points: readonly RawSeriesPoint[], granularity: SnapshotGranularity): SeriesPoint[] => {
  if (granularity === 'RAW') {
    return points.map((point) => ({
      date: toDateString(new Date(point.timestamp)),
      timestamp: point.timestamp,
      values: { ...point.values },
      sampleCount: 1,
    }));
  }

  const buckets = new Map<string, { key: Date; points: RawSeriesPoint[] }>();

  for (const point of points) {
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) continue;

    const bucket = bucketKeyOf(date, granularity);
    const bucketKey = toDateString(bucket);

    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.points.push(point);
    } else {
      buckets.set(bucketKey, { key: bucket, points: [point] });
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucketKey, { points: bucketPoints }]) => {
      const sums: Record<string, number> = {};
      const counts: Record<string, number> = {};

      for (const point of bucketPoints) {
        for (const [key, value] of Object.entries(point.values)) {
          if (!Number.isFinite(value)) continue;
          sums[key] = (sums[key] ?? 0) + value;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }

      const values: Record<string, number> = {};
      for (const [key, sum] of Object.entries(sums)) {
        const count = counts[key] ?? 0;
        if (count > 0) values[key] = round1(sum / count);
      }

      // 桶内已按输入顺序（升序）排列，末条即最新
      const lastPoint = bucketPoints[bucketPoints.length - 1];

      return {
        date: bucketKey,
        timestamp: lastPoint?.timestamp ?? `${bucketKey}T00:00:00.000Z`,
        values,
        sampleCount: bucketPoints.length,
      };
    });
};

/** 时间范围枚举 → 天数（`ALL` 返回 null 表示不限） */
export const rangeToDays = (range: string): number | null => {
  switch (range) {
    case '30D':
      return 30;
    case '90D':
      return 90;
    case '180D':
      return 180;
    case '365D':
      return 365;
    default:
      return null;
  }
};
