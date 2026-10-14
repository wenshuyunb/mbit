/**
 * 情感画像服务（ADR-038 阶段 3）
 *
 * ## 与 `PersonalityService` 的关系
 *
 * 结构上刻意同构（读当前画像 / 读指定版本 / 404 语义），但**两份独立实现、
 * 零相互调用**。原因不是偷懒：把两者合成一个"画像服务"就必须在内部按模块分支，
 * 而那正是 ADR-038 要消除的形态 —— 分支一旦写错，情感画像会带着人格字段返回，
 * 用户读到的是"归属错误"的结论，且不报任何错。
 *
 * ## 只读
 *
 * 写入路径只有一条：完成情感测评（`POST /tests/sessions/{id}/submit`）。
 * 本服务不提供任何写方法，也不导出 Prisma 事务句柄。
 */

import { Injectable } from '@nestjs/common';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  CONFLICT_STYLE_DIMENSIONS,
  LOVE_LANGUAGE_DIMENSIONS,
  type ConflictStyleDimension,
  type LoveLanguageDimension,
} from './engine/emotion-engine.types';

/** 依恋块 */
export interface EmotionAttachmentView {
  /** 四种依恋类型之一 */
  style: string;
  /** 依恋焦虑轴 0–100 */
  anxiety: number;
  /** 依恋回避轴 0–100 */
  avoidance: number;
}

/** 爱的语言块 */
export interface EmotionLoveLanguageView {
  /** 五项得分（0–100），键固定为 `LOVE_*` 五项 */
  scores: Record<LoveLanguageDimension, number>;
  /** 主导项（按分数降序，最多两项） */
  primary: string[];
}

/** 冲突风格块 */
export interface EmotionConflictView {
  scores: Record<ConflictStyleDimension, number>;
  style: string;
}

/** 质量块（与人格画像同口径） */
export interface EmotionQualityView {
  consistencyScore: number;
  completionRate: number;
  avgResponseMs: number | null;
  confidenceLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  notice: string | null;
}

/** 情感画像视图 */
export interface EmotionProfileView {
  profileId: string;
  userId: string;
  version: number;
  isLatest: boolean;
  engineVersion: string;
  sourceSessionId: string | null;
  sourceTestCode: string | null;
  generatedAt: string;
  attachment: EmotionAttachmentView;
  loveLanguage: EmotionLoveLanguageView;
  conflict: EmotionConflictView;
  quality: EmotionQualityView;
  /** 合规免责声明：由服务端下发，前端不得硬编码 */
  disclaimer: string;
}

/**
 * 画像免责声明
 *
 * ⚠ 与人格画像的声明**逐字不同**：情感测评谈的是亲密关系，而人格测评谈的是性格倾向。
 * 共用一句泛泛的声明会让用户以为两者是同一个东西 —— 那正是 ADR-038 要消除的混淆。
 * 文案里明确"不是心理诊断、不是对关系的裁决"，这是合规底线。
 */
const EMOTION_DISCLAIMER =
  '本测评参考依恋理论、爱的语言与冲突处理风格三个心理学模型，结果反映的是你**当下**在亲密关系中的倾向，仅供自我探索参考，不构成心理诊断、医疗建议，也不构成对任何一段关系的评判。';

/** 一致性分数的档位阈值（与人格画像同一口径，便于用户横向比较两份结果的可信度） */
const CONFIDENCE_THRESHOLDS = { high: 80, medium: 60 } as const;

@Injectable()
export class EmotionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 读取当前（或指定版本）的情感画像
   *
   * @param version 指定版本号；不传则取 `isCurrent = true` 的那一份
   */
  async getProfile(userId: string, version?: number): Promise<EmotionProfileView> {
    const profile = await this.prisma.emotionProfile.findFirst({
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
        attachmentStyle: true,
        attachmentAnxiety: true,
        attachmentAvoidance: true,
        loveLanguageScores: true,
        primaryLoveLanguages: true,
        conflictStyle: true,
        conflictScores: true,
        consistencyScore: true,
        completionRate: true,
        avgResponseMs: true,
        computedAt: true,
        testResult: { select: { sessionId: true, definitionCode: true } },
      },
    });

    if (profile === null) {
      // 区分「从未做过情感测评」与「指定版本不存在」：两者的引导动作不同
      if (version !== undefined) {
        throw BusinessException.notFound(ErrorCode.EMOTION_PROFILE_NOT_FOUND, `未找到版本 ${version} 的情感画像`);
      }

      throw BusinessException.notFound(ErrorCode.EMOTION_PROFILE_NOT_FOUND);
    }

    const consistencyScore = profile.consistencyScore ?? 0;
    const quality: EmotionQualityView = {
      consistencyScore,
      completionRate: profile.completionRate ?? 0,
      avgResponseMs: profile.avgResponseMs,
      confidenceLevel: resolveConfidenceLevel(consistencyScore),
      notice: buildQualityNotice(consistencyScore),
    };

    return {
      profileId: profile.id,
      userId,
      version: profile.version,
      isLatest: profile.isCurrent,
      engineVersion: profile.engineVersion,
      sourceSessionId: profile.testResult?.sessionId ?? null,
      sourceTestCode: profile.testResult?.definitionCode ?? null,
      generatedAt: profile.computedAt.toISOString(),
      attachment: {
        style: profile.attachmentStyle,
        anxiety: profile.attachmentAnxiety,
        avoidance: profile.attachmentAvoidance,
      },
      loveLanguage: {
        // 分数表按**固定顺序**重建：JSONB 的键顺序不保证稳定，
        // 直接透出会让同一份画像在不同请求里的字段顺序不同（前端 diff 会误报变更）
        scores: pickScores(profile.loveLanguageScores, LOVE_LANGUAGE_DIMENSIONS),
        primary: profile.primaryLoveLanguages,
      },
      conflict: {
        scores: pickScores(profile.conflictScores, CONFLICT_STYLE_DIMENSIONS),
        style: profile.conflictStyle,
      },
      quality,
      disclaimer: EMOTION_DISCLAIMER,
    };
  }
}

/** 按给定顺序从 JSONB 里取值（缺项补 0，但不编造中位 50） */
const pickScores = <T extends string>(value: unknown, dimensions: readonly T[]): Record<T, number> => {
  const source = (value ?? {}) as Record<string, unknown>;
  const result = {} as Record<T, number>;

  for (const dimension of dimensions) {
    const raw = source[dimension];
    result[dimension] = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  }

  return result;
};

const resolveConfidenceLevel = (consistencyScore: number): EmotionQualityView['confidenceLevel'] => {
  if (consistencyScore >= CONFIDENCE_THRESHOLDS.high) return 'HIGH';
  if (consistencyScore >= CONFIDENCE_THRESHOLDS.medium) return 'MEDIUM';

  return 'LOW';
};

const buildQualityNotice = (consistencyScore: number): string | null =>
  consistencyScore >= CONFIDENCE_THRESHOLDS.medium
    ? null
    : '本次作答前后有些不一致，结果的可参考程度偏低。如果方便，建议在更平静的状态下重测一次。';
