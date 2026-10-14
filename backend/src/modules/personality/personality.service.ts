/**
 * 人格画像服务（只读）
 *
 * 契约来源：docs/API_DESIGN.md §3.4
 *
 * 重要约定：
 *   · **只读**：画像的写入路径只有一条 —— 完成测试时的 `POST /tests/sessions/{id}/submit`。
 *     本模块不提供任何写接口，避免出现「两处都能改画像」的一致性问题。
 *   · **版本语义**：`version` 从 1 递增，每次完成测试都生成新版本（即使 MBTI 未变化），
 *     以保证成长曲线的连续性；旧版本不重算（架构 §11.4 / ADR-018）。
 *   · `summary` 为**规则模板生成**（`isAiGenerated: false`），不是 AI 输出 ——
 *     AI 深度解读属于 `report` 模块职责。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { MBTI_TYPE_PROFILES } from './data/mbti-types';
import type { MbtiTypeProfile } from './data/mbti-types.types';
import type {
  GetProfileQueryDto,
  GetSnapshotsQueryDto,
  ListProfileHistoryQueryDto,
  MbtiTypeParamDto,
} from './dto/personality.dto';
import { ENGINE_VERSION } from './engine/personality-engine.types';
import {
  aggregatePoints,
  clampPercent,
  computeTrend,
  rangeToDays,
  resolveConfidenceLevel,
  resolveDimensionStrength,
  round1,
  type ConfidenceLevel,
  type DimensionStrength,
  type ProfileTrend,
  type RawSeriesPoint,
  type SeriesPoint,
} from './personality-view.util';

// ============================================================================
// 视图类型
// ============================================================================

/** 维度视图（含对立极与强度档位） */
export interface MbtiDimensionView {
  percent: number;
  pole: string;
  oppositePercent: number;
  oppositePole: string;
  strength: DimensionStrength;
}

/** MBTI 块 */
export interface MbtiBlockView {
  type: string;
  typeName: string;
  group: string;
  confidence: number;
  dimensions: Record<string, MbtiDimensionView>;
}

/** 质量块 */
export interface QualityBlockView {
  consistencyScore: number;
  completionRate: number;
  avgResponseMs: number | null;
  confidenceLevel: ConfidenceLevel;
  notice: string | null;
}

/** 规则模板生成的画像摘要 */
export interface SummaryView {
  headline: string;
  strengths: string[];
  watchouts: string[];
  isAiGenerated: false;
}

/** 完整画像视图 */
export interface ProfileView {
  profileId: string;
  userId: string;
  version: number;
  isLatest: boolean;
  engineVersion: string;
  sourceSessionId: string | null;
  sourceTestCode: string | null;
  generatedAt: string;
  mbti: MbtiBlockView;
  bigFive: Record<string, number>;
  quality: QualityBlockView;
  trend: ProfileTrend | null;
  summary: SummaryView;
  disclaimer: string;
}

/** 历史版本列表项 */
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

/** 成长曲线响应 */
export interface SnapshotsView {
  metric: string;
  granularity: string;
  range: string;
  rangeStart: string;
  rangeEnd: string;
  /** 可用维度清单（前端可据此渲染图例） */
  availableDimensions: string[];
  points: Array<{
    date: string;
    timestamp: string;
    profileVersion: number | null;
    sessionId: string | null;
    testCode: string | null;
    values: Record<string, number>;
    mbtiType: string | null;
    confidence: number | null;
    /** 聚合粒度下该点包含的原始记录数 */
    sampleCount: number;
  }>;
}

// ============================================================================
// 常量
// ============================================================================

/** MBTI 维度的正负极字母与标签 */
const DIMENSION_POLES: Record<string, { positive: string; negative: string }> = {
  EI: { positive: 'E', negative: 'I' },
  SN: { positive: 'S', negative: 'N' },
  TF: { positive: 'T', negative: 'F' },
  JP: { positive: 'J', negative: 'P' },
};

/** 大五维度键（展示顺序固定） */
const BIG_FIVE_KEYS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'] as const;

/** 引擎质量提示阈值（与引擎保持一致，避免两处文案矛盾） */
const LOW_CONSISTENCY_THRESHOLD = 60;

/** 免责声明兜底文案（正常应由 system_configs 下发，见契约 §3.4.1 规则 6） */
const FALLBACK_DISCLAIMER =
  '本画像参考 MBTI 与 Big Five 理论框架，仅供自我探索参考，不构成心理诊断、医疗建议或临床评估。';

/** system_configs 中的免责声明键 */
const DISCLAIMER_CONFIG_KEY = 'disclaimer.personality';

/** 快照接口支持的维度白名单 */
const SNAPSHOT_DIMENSION_WHITELIST: Record<string, readonly string[]> = {
  BIG_FIVE: BIG_FIVE_KEYS,
  MBTI_DIMENSIONS: ['EI', 'SN', 'TF', 'JP'],
  CONFIDENCE: ['confidence'],
};

@Injectable()
export class PersonalityService {
  private readonly logger = new Logger(PersonalityService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================================
  // 当前画像 / 指定版本
  // ==========================================================================

  async getProfile(userId: string, query: GetProfileQueryDto = {}): Promise<ProfileView> {
    const requestedVersion = query.version;

    const profile = await this.prisma.personalityProfile.findFirst({
      where: {
        userId,
        deletedAt: null,
        ...(requestedVersion !== undefined ? { version: requestedVersion } : { isCurrent: true }),
      },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        userId: true,
        version: true,
        isCurrent: true,
        engineVersion: true,
        mbtiType: true,
        mbtiConfidence: true,
        eiPercent: true,
        snPercent: true,
        tfPercent: true,
        jpPercent: true,
        openness: true,
        conscientiousness: true,
        extraversion: true,
        agreeableness: true,
        neuroticism: true,
        consistencyScore: true,
        completionRate: true,
        avgResponseMs: true,
        computedAt: true,
        testResult: { select: { sessionId: true, definitionCode: true } },
      },
    });

    if (!profile) {
      // 区分「从未测试」与「指定版本不存在」：前者提示先完成测试，后者提示版本无效
      if (requestedVersion !== undefined) {
        throw BusinessException.notFound(
          ErrorCode.PERSONALITY_PROFILE_NOT_FOUND,
          `未找到版本 ${requestedVersion} 的画像`,
        );
      }
      throw BusinessException.notFound(
        ErrorCode.PERSONALITY_PROFILE_NOT_FOUND,
        '你还没有人格画像，完成一次测评即可生成',
      );
    }

    // 极旧版本算法可能已不兼容当前字段语义，要求重新测试
    if (!this.isEngineVersionSupported(profile.engineVersion)) {
      throw BusinessException.badRequest(
        ErrorCode.ENGINE_VERSION_UNSUPPORTED,
        '该版本画像由已停止支持的算法生成，请重新完成一次测评',
      );
    }

    const typeProfile = this.findTypeProfile(profile.mbtiType);
    const latestVersion = await this.prisma.personalityProfile.findFirst({
      where: { userId, deletedAt: null },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const trend = await this.resolveTrend(userId, profile, query.includeTrend !== false);

    return {
      profileId: profile.id,
      userId: profile.userId,
      version: profile.version,
      isLatest: latestVersion?.version === profile.version,
      engineVersion: profile.engineVersion,
      sourceSessionId: profile.testResult?.sessionId ?? null,
      sourceTestCode: profile.testResult?.definitionCode ?? null,
      generatedAt: profile.computedAt.toISOString(),
      mbti: {
        type: profile.mbtiType,
        typeName: typeProfile?.typeName ?? profile.mbtiType,
        group: typeProfile?.group ?? 'ANALYST',
        confidence: round1(profile.mbtiConfidence),
        dimensions: this.buildDimensions({
          EI: profile.eiPercent,
          SN: profile.snPercent,
          TF: profile.tfPercent,
          JP: profile.jpPercent,
        }),
      },
      bigFive: {
        openness: round1(profile.openness),
        conscientiousness: round1(profile.conscientiousness),
        extraversion: round1(profile.extraversion),
        agreeableness: round1(profile.agreeableness),
        neuroticism: round1(profile.neuroticism),
      },
      quality: {
        consistencyScore: round1(profile.consistencyScore ?? 0),
        completionRate: round1(profile.completionRate ?? 0),
        avgResponseMs: profile.avgResponseMs,
        confidenceLevel: resolveConfidenceLevel(profile.consistencyScore ?? 0),
        notice: this.buildQualityNotice(profile.consistencyScore ?? 0),
      },
      trend,
      summary: {
        headline: typeProfile?.summary.headline ?? `${profile.mbtiType} 型人格`,
        strengths: typeProfile?.summary.strengths ?? [],
        watchouts: typeProfile?.summary.watchouts ?? [],
        isAiGenerated: false,
      },
      disclaimer: await this.getDisclaimer(),
    };
  }

  // ==========================================================================
  // 历史版本
  // ==========================================================================

  async listHistory(
    userId: string,
    query: ListProfileHistoryQueryDto,
  ): Promise<{
    items: ProfileHistoryItem[];
    total: number;
    page: number;
    pageSize: number;
    hasNext: boolean;
  }> {
    const where = {
      userId,
      deletedAt: null,
      ...(query.engineVersion ? { engineVersion: query.engineVersion } : {}),
    };

    const sortBy = query.sortBy ?? 'version';
    const order = query.order ?? 'desc';

    const [total, profiles, latest] = await Promise.all([
      this.prisma.personalityProfile.count({ where }),
      this.prisma.personalityProfile.findMany({
        where,
        orderBy: sortBy === 'version' ? { version: order } : { computedAt: order },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          version: true,
          engineVersion: true,
          mbtiType: true,
          mbtiConfidence: true,
          computedAt: true,
        },
      }),
      this.prisma.personalityProfile.findFirst({
        where: { userId, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { version: true },
      }),
    ]);

    return {
      items: profiles.map((profile) => ({
        profileId: profile.id,
        version: profile.version,
        isLatest: latest?.version === profile.version,
        engineVersion: profile.engineVersion,
        mbtiType: profile.mbtiType,
        mbtiTypeName: this.findTypeProfile(profile.mbtiType)?.typeName ?? profile.mbtiType,
        confidence: round1(profile.mbtiConfidence),
        generatedAt: profile.computedAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasNext: query.page * query.pageSize < total,
    };
  }

  // ==========================================================================
  // 成长曲线
  // ==========================================================================

  async getSnapshots(userId: string, query: GetSnapshotsQueryDto = {}): Promise<SnapshotsView> {
    const metric = query.metric ?? 'BIG_FIVE';
    const range = query.range ?? '90D';
    const granularity = query.granularity ?? 'RAW';

    const allowedDimensions = SNAPSHOT_DIMENSION_WHITELIST[metric] ?? [];

    // 维度参数必须属于该指标族的白名单（否则会返回永远为空的曲线，属隐性错误）
    if (query.dimension !== undefined && !allowedDimensions.includes(query.dimension)) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `dimension 与 metric 不匹配，${metric} 支持：${allowedDimensions.join(', ')}`,
      );
    }

    const days = rangeToDays(range);
    const rangeEnd = new Date();
    const rangeStart = days === null ? null : new Date(rangeEnd.getTime() - days * 86_400_000);

    const snapshots = await this.prisma.personalitySnapshot.findMany({
      where: {
        userId,
        ...(rangeStart ? { capturedAt: { gte: rangeStart } } : {}),
      },
      orderBy: { capturedAt: 'asc' },
      select: {
        capturedAt: true,
        mbtiType: true,
        bigFive: true,
        sourceSessionId: true,
        profile: {
          select: {
            version: true,
            mbtiConfidence: true,
            eiPercent: true,
            snPercent: true,
            tfPercent: true,
            jpPercent: true,
          },
        },
        sourceSession: { select: { definitionCode: true } },
      },
    });

    // ------------------------------------------------------------ 组装原始点
    const rawPoints: RawSeriesPoint[] = [];
    const metaByTimestamp = new Map<
      string,
      {
        profileVersion: number | null;
        sessionId: string | null;
        testCode: string | null;
        mbtiType: string;
        confidence: number | null;
      }
    >();

    for (const snapshot of snapshots) {
      const values = this.extractMetricValues(metric, snapshot);

      // 该指标族在本快照中没有任何可用值 → 跳过（不要产生全空的点）
      if (Object.keys(values).length === 0) continue;

      const timestamp = snapshot.capturedAt.toISOString();
      rawPoints.push({ timestamp, values });
      metaByTimestamp.set(timestamp, {
        profileVersion: snapshot.profile?.version ?? null,
        sessionId: snapshot.sourceSessionId,
        testCode: snapshot.sourceSession?.definitionCode ?? null,
        mbtiType: snapshot.mbtiType,
        confidence: snapshot.profile ? round1(snapshot.profile.mbtiConfidence) : null,
      });
    }

    // -------------------------------------------------------------- 聚合
    const aggregated = aggregatePoints(rawPoints, granularity);

    // 聚合后一个桶对应多条原始记录，元信息取桶内最新一条
    const points = aggregated.map((point) => {
      const meta = metaByTimestamp.get(point.timestamp);

      return {
        date: point.date,
        timestamp: point.timestamp,
        profileVersion: meta?.profileVersion ?? null,
        sessionId: meta?.sessionId ?? null,
        testCode: meta?.testCode ?? null,
        values: this.pickDimension(point, query.dimension),
        mbtiType: meta?.mbtiType ?? null,
        confidence: meta?.confidence ?? null,
        sampleCount: point.sampleCount,
      };
    });

    return {
      metric,
      granularity,
      range,
      rangeStart: (rangeStart ?? new Date(0)).toISOString(),
      rangeEnd: rangeEnd.toISOString(),
      availableDimensions: query.dimension ? [query.dimension] : [...allowedDimensions],
      points,
    };
  }

  // ==========================================================================
  // 类型百科
  // ==========================================================================

  /** 获取类型百科（公开接口，游客可访问） */
  getTypeInfo(params: MbtiTypeParamDto): MbtiTypeProfile {
    const profile = this.findTypeProfile(params.mbti.toUpperCase());

    if (!profile) {
      throw BusinessException.notFound(ErrorCode.MBTI_TYPE_INVALID, `未找到类型 ${params.mbti} 的百科内容`);
    }

    return profile;
  }

  /** 全部类型列表（供后台与 SEO 落地页使用） */
  listTypeProfiles(): Array<
    Pick<MbtiTypeProfile, 'type' | 'typeName' | 'typeNameEn' | 'group' | 'groupName' | 'tagline'>
  > {
    return MBTI_TYPE_PROFILES.map((profile) => ({
      type: profile.type,
      typeName: profile.typeName,
      typeNameEn: profile.typeNameEn,
      group: profile.group,
      groupName: profile.groupName,
      tagline: profile.tagline,
    }));
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 按类型码查找百科（大小写不敏感） */
  private findTypeProfile(type: string | null | undefined): MbtiTypeProfile | undefined {
    if (!type) return undefined;
    const normalized = type.toUpperCase();
    return MBTI_TYPE_PROFILES.find((profile) => profile.type === normalized);
  }

  /** 构造四维度视图（含对立极百分比与强度档位） */
  private buildDimensions(percents: Record<string, number>): Record<string, MbtiDimensionView> {
    const view: Record<string, MbtiDimensionView> = {};

    for (const [dimension, poles] of Object.entries(DIMENSION_POLES)) {
      const percent = clampPercent(percents[dimension] ?? 50);
      const isPositive = percent >= 50;

      view[dimension] = {
        percent: round1(percent),
        pole: isPositive ? poles.positive : poles.negative,
        oppositePercent: round1(100 - percent),
        oppositePole: isPositive ? poles.negative : poles.positive,
        strength: resolveDimensionStrength(percent),
      };
    }

    return view;
  }

  /** 质量提示文案（与引擎保持同阈值） */
  private buildQualityNotice(consistencyScore: number): string | null {
    if (consistencyScore >= LOW_CONSISTENCY_THRESHOLD) return null;
    return '本次作答速度较快或存在不一致，结果置信度偏低，建议在更放松的状态下重测。';
  }

  /** 引擎版本是否仍受支持（仅拒绝主版本已变更的画像） */
  private isEngineVersionSupported(engineVersion: string): boolean {
    // 形如 pe-v1.0.0；主版本号不同则视为不兼容（字段语义可能已变）
    const currentMajor = ENGINE_VERSION.match(/^pe-v(\d+)\./)?.[1];
    const major = engineVersion.match(/^pe-v(\d+)\./)?.[1];

    if (!major || !currentMajor) {
      // 无法解析的版本号（如历史脏数据）按不兼容处理，引导用户重测而非给出错误解读
      return false;
    }

    return major === currentMajor;
  }

  /** 与上一版本对比 */
  private async resolveTrend(
    userId: string,
    current: {
      version: number;
      computedAt: Date;
      mbtiType: string;
      mbtiConfidence: number;
      eiPercent: number;
      snPercent: number;
      tfPercent: number;
      jpPercent: number;
      openness: number;
      conscientiousness: number;
      extraversion: number;
      agreeableness: number;
      neuroticism: number;
    },
    includeTrend: boolean,
  ): Promise<ProfileTrend | null> {
    if (!includeTrend) return null;

    const previous = await this.prisma.personalityProfile.findFirst({
      where: { userId, deletedAt: null, version: { lt: current.version } },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        computedAt: true,
        mbtiType: true,
        mbtiConfidence: true,
        eiPercent: true,
        snPercent: true,
        tfPercent: true,
        jpPercent: true,
        openness: true,
        conscientiousness: true,
        extraversion: true,
        agreeableness: true,
        neuroticism: true,
      },
    });

    // 契约规则 5：无上一版本时 trend 为 null
    if (!previous) return null;

    return computeTrend(
      {
        version: current.version,
        generatedAt: current.computedAt.toISOString(),
        mbtiType: current.mbtiType,
        confidence: current.mbtiConfidence,
        dimensions: {
          EI: current.eiPercent,
          SN: current.snPercent,
          TF: current.tfPercent,
          JP: current.jpPercent,
        },
        bigFive: {
          openness: current.openness,
          conscientiousness: current.conscientiousness,
          extraversion: current.extraversion,
          agreeableness: current.agreeableness,
          neuroticism: current.neuroticism,
        },
      },
      {
        version: previous.version,
        generatedAt: previous.computedAt.toISOString(),
        mbtiType: previous.mbtiType,
        confidence: previous.mbtiConfidence,
        dimensions: {
          EI: previous.eiPercent,
          SN: previous.snPercent,
          TF: previous.tfPercent,
          JP: previous.jpPercent,
        },
        bigFive: {
          openness: previous.openness,
          conscientiousness: previous.conscientiousness,
          extraversion: previous.extraversion,
          agreeableness: previous.agreeableness,
          neuroticism: previous.neuroticism,
        },
      },
    );
  }

  /** 从快照中按指标族提取数值 */
  private extractMetricValues(
    metric: string,
    snapshot: {
      bigFive: unknown;
      profile: {
        mbtiConfidence: number;
        eiPercent: number;
        snPercent: number;
        tfPercent: number;
        jpPercent: number;
      } | null;
    },
  ): Record<string, number> {
    if (metric === 'BIG_FIVE') {
      const source = (snapshot.bigFive ?? {}) as Record<string, unknown>;
      const values: Record<string, number> = {};

      for (const key of BIG_FIVE_KEYS) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value)) values[key] = round1(value);
      }

      return values;
    }

    // MBTI_DIMENSIONS 与 CONFIDENCE 的数值都存在画像上（快照表只存大五与关系风格）
    if (!snapshot.profile) return {};

    if (metric === 'MBTI_DIMENSIONS') {
      return {
        EI: round1(snapshot.profile.eiPercent),
        SN: round1(snapshot.profile.snPercent),
        TF: round1(snapshot.profile.tfPercent),
        JP: round1(snapshot.profile.jpPercent),
      };
    }

    if (metric === 'CONFIDENCE') {
      return { confidence: round1(snapshot.profile.mbtiConfidence) };
    }

    return {};
  }

  /** 按 dimension 参数裁剪返回值（不传则返回全部维度） */
  private pickDimension(point: SeriesPoint, dimension?: string): Record<string, number> {
    if (!dimension) return point.values;

    const value = point.values[dimension];
    return value === undefined ? {} : { [dimension]: value };
  }

  /** 免责声明：优先读系统配置，缺失时用兜底文案（前端不得硬编码，契约规则 6） */
  private async getDisclaimer(): Promise<string> {
    try {
      const row = await this.prisma.systemConfig.findUnique({
        where: { key: DISCLAIMER_CONFIG_KEY },
        select: { value: true },
      });

      const value = row?.value?.trim();
      return value && value.length > 0 ? value : FALLBACK_DISCLAIMER;
    } catch (error) {
      // 配置读取失败不应阻断画像展示
      this.logger.warn(`读取免责声明配置失败，使用兜底文案: ${(error as Error).message}`);
      return FALLBACK_DISCLAIMER;
    }
  }
}
