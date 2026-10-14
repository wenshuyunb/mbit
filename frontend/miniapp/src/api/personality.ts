/**
 * 人格画像接口
 *
 * 对应后端模块：personality（契约来源 `docs/API_DESIGN.md` §3.4）
 * 权威结构以 `backend/src/modules/personality/personality.service.ts` 的
 * `ProfileView` / `ProfileHistoryItem` / `SnapshotsView` 为准。
 *
 * ⚠ 本文件此前是按「想象的契约」写的，与后端实际响应严重不符（实测 `GET /personality/me`）：
 *   · `id`             → 后端是 `profileId`
 *   · `mbti: string`   → 后端是**对象**（含 `type` / `typeName` / `group` / `confidence` / `dimensions`）
 *   · `dimensions: Record<string, number>` → 后端每个维度是**对象**（含对立极与强度档位）
 *   · `summary: string`→ 后端是对象（`headline` / `strengths` / `watchouts` / `isAiGenerated`）
 *   · `confidence`     → 后端嵌在 `mbti.confidence`，另有 `quality.confidenceLevel`
 *   · `createdAt`      → 后端是 `generatedAt`
 *   · `attachmentLabel`→ 后端**不存在**该字段
 *   · `getSnapshots` 返回数组 → 后端返回对象（含 `points` 与可用维度清单）
 * 现已按后端源码逐字段对齐，并由 `tests/api/personality.spec.ts` 锁死。
 */

import { http } from './request';
import { ApiError, ERROR_CODES } from './types';
import type { PaginatedData } from './types';

// ============================================================================
// MBTI 维度
// ============================================================================

/** MBTI 四个维度键（顺序固定，用于展示） */
export const MBTI_DIMENSIONS = ['EI', 'SN', 'TF', 'JP'] as const;
export type MbtiDimensionKey = (typeof MBTI_DIMENSIONS)[number];

/** 四大类型组 */
export type MbtiGroup = 'ANALYST' | 'DIPLOMAT' | 'SENTINEL' | 'EXPLORER';

/** 倾向强度：按偏离中位 50 的距离分档，越偏离说明倾向越明确 */
export type DimensionStrength = 'SLIGHT' | 'MODERATE' | 'CLEAR' | 'VERY_CLEAR';

/** 单个维度视图 */
export interface MbtiDimensionView {
  percent: number;
  pole: string;
  oppositePercent: number;
  oppositePole: string;
  strength: DimensionStrength;
}

/** MBTI 块 */
export interface MbtiBlock {
  type: string;
  typeName: string;
  group: MbtiGroup;
  /** 结果置信度（0-100） */
  confidence: number;
  dimensions: Record<string, MbtiDimensionView>;
}

// ============================================================================
// 大五人格
// ============================================================================

/** 大五五个维度键（后端返回 `Record<string, number>`，此处提供稳定顺序用于渲染） */
export const BIG_FIVE_DIMENSIONS = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
] as const;
export type BigFiveDimensionKey = (typeof BIG_FIVE_DIMENSIONS)[number];

/**
 * 大五维度中文名
 *
 * 后端**不提供**这些标签（返回的是原始键名），因此这个映射表必须放在前端；
 * 与报告类型的中文名不同（那个由服务端下发，前端不得重复维护）。
 */
export const BIG_FIVE_LABELS: Record<BigFiveDimensionKey, string> = {
  openness: '开放性',
  conscientiousness: '尽责性',
  extraversion: '外向性',
  agreeableness: '宜人性',
  neuroticism: '神经质',
};

// ============================================================================
// 质量指标
// ============================================================================

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** 作答质量块：用于提示「结果置信度偏低，建议重测」 */
export interface QualityBlock {
  consistencyScore: number;
  completionRate: number;
  avgResponseMs: number | null;
  confidenceLevel: ConfidenceLevel;
  /** 后端给出的质量提示文案，可能为 null */
  notice: string | null;
}

// ============================================================================
// 画像摘要（规则模板生成，非 AI）
// ============================================================================

export interface ProfileSummary {
  headline: string;
  strengths: string[];
  watchouts: string[];
  /** 恒为 false：AI 深度解读属于报告模块职责 */
  isAiGenerated: false;
}

// ============================================================================
// 与上一版本的对比
// ============================================================================

export interface DimensionDelta {
  dimension: string;
  previous: number;
  current: number;
  delta: number;
}

export interface ProfileTrend {
  comparedWithVersion: number;
  comparedAt: string;
  mbtiChanged: boolean;
  confidenceDelta: number;
  dimensionDelta: DimensionDelta[];
  bigFiveDelta: Record<string, number>;
  /** 缺失维度：后端不做「按 0 计算」以免显示虚假的巨大变化，前端应弱化展示这些维度 */
  missingDimensions: string[];
}

// ============================================================================
// 完整画像
// ============================================================================

/** 人格画像（对应后端 `ProfileView`） */
export interface PersonalityProfile {
  profileId: string;
  userId: string;
  version: number;
  isLatest: boolean;
  /** 算法版本，画像随算法升级产生新版本记录 */
  engineVersion: string;
  sourceSessionId: string | null;
  sourceTestCode: string | null;
  generatedAt: string;
  mbti: MbtiBlock;
  bigFive: Record<string, number>;
  quality: QualityBlock;
  /** 无上一版本时为 null */
  trend: ProfileTrend | null;
  summary: ProfileSummary;
  /** 合规免责声明：由服务端下发，前端不得硬编码 */
  disclaimer: string;
}

/** 历史版本列表项（对应后端 `ProfileHistoryItem`） */
export interface ProfileHistoryItem {
  profileId: string;
  version: number;
  isLatest: boolean;
  engineVersion: string;
  mbtiType: string;
  mbtiTypeName: string;
  confidence: number;
  generatedAt: string;
}

export interface ProfileHistoryData extends PaginatedData<ProfileHistoryItem> {}

// ============================================================================
// 成长曲线
// ============================================================================

export type SnapshotMetric = 'BIG_FIVE' | 'CONFIDENCE' | 'MBTI_DIMENSIONS';
export type SnapshotRange = '30D' | '90D' | '180D' | '365D' | 'ALL';
export type SnapshotGranularity = 'RAW' | 'WEEK' | 'MONTH';

export interface SnapshotPoint {
  /** 展示用日期：RAW 为当日、WEEK 为该周周一、MONTH 为该月 1 日 */
  date: string;
  timestamp: string;
  profileVersion: number | null;
  sessionId: string | null;
  testCode: string | null;
  values: Record<string, number>;
  mbtiType: string | null;
  confidence: number | null;
  /** 聚合粒度下该点包含的原始记录数（RAW 恒为 1） */
  sampleCount: number;
}

/** 成长曲线响应（**是对象不是数组**） */
export interface SnapshotsView {
  metric: SnapshotMetric;
  granularity: SnapshotGranularity;
  range: SnapshotRange;
  rangeStart: string;
  rangeEnd: string;
  /** 可用维度清单，前端据此渲染图例 */
  availableDimensions: string[];
  points: SnapshotPoint[];
}

// ============================================================================
// MBTI 类型百科（公开）
// ============================================================================

export interface MbtiDimensionProfile {
  dimension: MbtiDimensionKey;
  pole: string;
  label: string;
  /** 该类型在该维度上的典型倾向百分比（50–90） */
  percent: number;
}

export interface MbtiTypeItem {
  title: string;
  description: string;
}

/** 单个类型的百科条目（对应后端 `MbtiTypeProfile`） */
export interface MbtiTypeProfile {
  type: string;
  typeName: string;
  typeNameEn: string;
  group: MbtiGroup;
  groupName: string;
  /** 组的主题色（十六进制），用于前端渲染 */
  groupColor: string;
  tagline: string;
  description: string;
  dimensionProfile: MbtiDimensionProfile[];
  strengths: MbtiTypeItem[];
  blindSpots: MbtiTypeItem[];
  relationshipTips: MbtiTypeItem[];
  summary: {
    headline: string;
    strengths: string[];
    watchouts: string[];
  };
}

// ============================================================================
// 查询参数
// ============================================================================

export interface GetProfileQuery {
  /** 指定历史版本号；不传返回最新版本 */
  version?: number;
}

export interface ListProfileHistoryQuery {
  page?: number;
  pageSize?: number;
  engineVersion?: string;
  sortBy?: 'version' | 'generatedAt';
  order?: 'asc' | 'desc';
}

export interface GetSnapshotsQuery {
  metric?: SnapshotMetric;
  dimension?: string;
  range?: SnapshotRange;
  granularity?: SnapshotGranularity;
}

// ============================================================================
// 接口
// ============================================================================

/**
 * 获取当前人格画像
 *
 * **返回 null 表示「尚未做过测评」，这是空状态而非错误** —— 后端会返回
 * `404 / 40010`，此处统一吞掉，避免每个页面各写一遍 try/catch 并各自判断错误码。
 * 其余错误（网络、鉴权等）一律原样抛出，由页面决定如何提示。
 *
 * 因需要自行区分错误码，这里关闭了请求层的自动 toast（`showError: false`），
 * 调用方应对非空错误给出可重试的界面。
 */
export const getMyProfile = async (query: GetProfileQuery = {}): Promise<PersonalityProfile | null> => {
  try {
    return await http.get<PersonalityProfile>('/personality/me', query as Record<string, unknown>, {
      showError: false,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === ERROR_CODES.PERSONALITY_PROFILE_NOT_FOUND) {
      return null;
    }
    throw error;
  }
};

/** 历史画像版本（算法升级后保留历史，便于对比） */
export const getProfileHistory = (query: ListProfileHistoryQuery = {}): Promise<ProfileHistoryData> =>
  http.get<ProfileHistoryData>('/personality/me/history', query as Record<string, unknown>);

/** 成长曲线（时间序列） */
export const getSnapshots = (query: GetSnapshotsQuery = {}): Promise<SnapshotsView> =>
  http.get<SnapshotsView>('/personality/me/snapshots', query as Record<string, unknown>);

/** MBTI 类型百科（公开接口，用于分享落地页与结果页解读） */
export const getMbtiTypeInfo = (type: string): Promise<MbtiTypeProfile> =>
  http.get<MbtiTypeProfile>(`/personality/types/${type}`, undefined, { needAuth: false });
