/**
 * 心理健康画像服务（ADR-038 阶段 4）
 *
 * ## 与其他两个画像服务的最大差异：**结论与免责声明都由服务端下发**
 *
 * 用户对这个模块的要求是「要写好提示，本结果仅供参考的字样」。因此：
 *   · `conclusion` 从库里读（写入时由**确定性规则**生成，不是 AI 现编的）；
 *   · `disclaimer` 从库里读（前端**不得**硬编码 —— 合规文案要能独立迭代而不发版）。
 *
 * 两者都落库而不是在读取时现算，原因不同：
 *   结论是一个**历史快照**（用户在那一刻看到的就是那段话，算法升级后不该被改写）；
 *   免责声明则是**服务端唯一真相**（同一份画像在不同端看到的合规文案必须一致）。
 *
 * ## 只读
 *
 * 写入路径只有一条：完成心理健康测评（`POST /tests/sessions/{id}/submit`）。
 */

import { Injectable } from '@nestjs/common';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  MENTAL_HEALTH_DIMENSION_LABELS,
  MENTAL_HEALTH_DIMENSIONS,
  MENTAL_HEALTH_OVERALL_LABELS,
  type MentalHealthBand,
  type MentalHealthDimension,
  type MentalHealthOverallLevel,
} from './engine/mental-health-engine.types';

/** 单维视图 */
export interface MentalHealthDimensionView {
  /** 维度编码（`MH_*`） */
  key: MentalHealthDimension;
  /** 中文名（服务端下发，前端不再各写一份） */
  label: string;
  /** 0–100，越高越值得留意 */
  score: number;
  /** 档位编码与中文名 */
  band: MentalHealthBand;
  bandLabel: string;
  /** 是否被高亮为"最值得留意"的项 */
  isHighlighted: boolean;
}

/** 心理健康画像视图 */
export interface MentalHealthProfileView {
  profileId: string;
  userId: string;
  version: number;
  isLatest: boolean;
  engineVersion: string;
  sourceSessionId: string | null;
  sourceTestCode: string | null;
  generatedAt: string;
  /** 六维得分（按固定顺序） */
  dimensions: MentalHealthDimensionView[];
  /** 整体得分与档位 */
  overallScore: number;
  overallLevel: MentalHealthOverallLevel;
  overallLabel: string;
  /** 文字结论（**只描述、不建议**，由确定性规则生成） */
  conclusion: string;
  quality: {
    consistencyScore: number;
    completionRate: number;
    avgResponseMs: number | null;
    confidenceLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    notice: string | null;
  };
  /** 合规声明（服务端下发，**必须**含「本结果仅供参考」） */
  disclaimer: string;
}

/** 一致性分数的档位阈值（与另两个模块同一口径，便于用户横向比较三份结果） */
const CONFIDENCE_THRESHOLDS = { high: 80, medium: 60 } as const;

/** 档位中文名（与引擎里那份保持同步；读取时要用，因此这里再列一次） */
const BAND_LABELS: Readonly<Record<MentalHealthBand, string>> = {
  CALM: '平稳',
  SLIGHT: '偶尔',
  MILD: '比较明显',
  NOTABLE: '比较突出',
};

@Injectable()
export class MentalHealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 读取当前（或指定版本）的心理健康画像
   *
   * @param version 指定版本号；不传则取 `isCurrent = true` 的那一份
   */
  async getProfile(userId: string, version?: number): Promise<MentalHealthProfileView> {
    const profile = await this.prisma.mentalHealthProfile.findFirst({
      where: {
        userId,
        deletedAt: null,
        ...(version === undefined ? { isCurrent: true } : { version }),
      },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        isCurrent: true,
        engineVersion: true,
        dimensionScores: true,
        overallLevel: true,
        overallScore: true,
        conclusion: true,
        highlightedDimensions: true,
        consistencyScore: true,
        completionRate: true,
        avgResponseMs: true,
        disclaimer: true,
        computedAt: true,
        testResult: { select: { sessionId: true, definitionCode: true } },
      },
    });

    if (profile === null) {
      if (version !== undefined) {
        throw BusinessException.notFound(
          ErrorCode.MENTAL_HEALTH_PROFILE_NOT_FOUND,
          `未找到版本 ${version} 的心理健康画像`,
        );
      }

      throw BusinessException.notFound(ErrorCode.MENTAL_HEALTH_PROFILE_NOT_FOUND);
    }

    const scores = (profile.dimensionScores ?? {}) as Record<string, unknown>;
    const highlighted = new Set(profile.highlightedDimensions);

    // 六维按**固定顺序**输出（JSONB 的键顺序不保证稳定）：
    // 顺序即展示顺序，直接透出会让同一份画像在不同请求里的字段顺序不同
    const dimensions: MentalHealthDimensionView[] = MENTAL_HEALTH_DIMENSIONS.map((dimension) => {
      // ⚠ 分数与档位都从**落库值**读，不在这里按当前阈值重算：
      // `conclusion` 里嵌着档位措辞（「这一项比较突出」），而结论是历史快照。
      // 若档位在此重算，阈值一改就会出现"页面标签说平稳、结论正文说比较突出"。
      const stored = (scores[dimension] ?? {}) as { score?: unknown; band?: unknown };
      const score = typeof stored.score === 'number' && Number.isFinite(stored.score) ? stored.score : 0;
      const band = isBand(stored.band) ? stored.band : 'MILD';

      return {
        key: dimension,
        label: MENTAL_HEALTH_DIMENSION_LABELS[dimension],
        score,
        band,
        bandLabel: BAND_LABELS[band],
        isHighlighted: highlighted.has(dimension),
      };
    });

    const consistencyScore = profile.consistencyScore ?? 0;
    const overallLevel = profile.overallLevel as MentalHealthOverallLevel;

    return {
      profileId: profile.id,
      userId,
      version: profile.version,
      isLatest: profile.isCurrent,
      engineVersion: profile.engineVersion,
      sourceSessionId: profile.testResult?.sessionId ?? null,
      sourceTestCode: profile.testResult?.definitionCode ?? null,
      generatedAt: profile.computedAt.toISOString(),
      dimensions,
      overallScore: profile.overallScore,
      overallLevel,
      overallLabel: MENTAL_HEALTH_OVERALL_LABELS[overallLevel] ?? overallLevel,
      conclusion: profile.conclusion,
      quality: {
        consistencyScore,
        completionRate: profile.completionRate ?? 0,
        avgResponseMs: profile.avgResponseMs,
        confidenceLevel: resolveConfidenceLevel(consistencyScore),
        notice: buildQualityNotice(consistencyScore),
      },
      disclaimer: profile.disclaimer,
    };
  }
}

/**
 * 校验落库的档位是否是合法取值
 *
 * 手工改库、旧版本数据、Json 列被写坏 —— 这些情况都会让 `band` 是任意值。
 * 读取时把它当联合类型用会让 `BAND_LABELS[band]` 得到 `undefined` 并渲染成空白，
 * 因此这里显式判定并回落到中间档（`MILD`），而不是让页面出现空标签。
 */
const isBand = (value: unknown): value is MentalHealthBand =>
  value === 'CALM' || value === 'SLIGHT' || value === 'MILD' || value === 'NOTABLE';

const resolveConfidenceLevel = (consistencyScore: number): 'LOW' | 'MEDIUM' | 'HIGH' => {
  if (consistencyScore >= CONFIDENCE_THRESHOLDS.high) return 'HIGH';
  if (consistencyScore >= CONFIDENCE_THRESHOLDS.medium) return 'MEDIUM';

  return 'LOW';
};

const buildQualityNotice = (consistencyScore: number): string | null =>
  consistencyScore >= CONFIDENCE_THRESHOLDS.medium
    ? null
    : '本次作答前后有些不一致，这份结论的参考价值有限。如果方便，可以在更安静的时候再答一次。';
