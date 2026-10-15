/**
 * 报告详情页的**画像快照**（纯函数，无 I/O、可 100% 单测）
 *
 * ## 为什么报告详情要带画像数据
 *
 * 用户的实测反馈是「点开一看，哇，全是字，我是用户我看都不想看，累不累啊，
 * 最好是图文并茂，一针见血」。
 *
 * 而这份报告**本来就有数字**：正文里写着「焦虑轴 52、回避轴 0」「身体的接触 63、
 * 精心的时刻 62」「服务的行动 5」—— 这些数字是整份报告最有说服力的部分，
 * 却全部埋在段落正文里，用户要逐字读才能把它们拼出来。
 *
 * 因此详情接口额外下发一份**生成这份报告时用的画像数值**，前端用它画条形图：
 * 「一眼看到自己是哪一种、两条轴各在哪儿、最在意什么」——这就是"一针见血"。
 *
 * ## 三条边界
 *
 * ① **不参与付费墙判定**。这一段是**已解锁的元数据**，与段落正文的可见性无关：
 *    它描述的是"你的画像"，不是"报告写了什么"。免费用户也能看到自己填出来的数字
 *    （这些数字他在结果页本来就看过）。真正被锁的是**解读文字**。
 * ② **只发编码与数值，不发中文标签**。与结果接口（`/tests/sessions/:id/result`）
 *    同一口径：标签的唯一来源是前端 `config/modules.ts` 的
 *    `ATTACHMENT_STYLE_LABELS` / `LOVE_LANGUAGE_LABELS` / `CONFLICT_STYLE_LABELS`。
 *    若这里也发一份中文，两处文案迟早会分叉（ADR-004 的单点原则）。
 * ③ **缺画像就是 `null`**，不编造：关系报告 / 成长报告挂的是别的东西，
 *    历史数据也可能画像已被删除（外键是 `SetNull`）。前端按"没有数据卡"降级渲染。
 */

import { parseScoreMap } from '../../../common/engine/score-map.util';
import { buildEmotionConclusion, type EmotionConclusion } from '../../emotion/emotion-conclusion.util';

/** 依恋两轴的中点（判定"偏高/偏低"的那条线；系统配置读不到时的兜底与引擎一致） */
export interface AttachmentThresholdView {
  readonly anxiety: number;
  readonly avoidance: number;
}

/** 情感画像快照 */
export interface EmotionReportProfileSnapshotView {
  readonly kind: 'EMOTION';
  readonly attachmentStyle: string;
  readonly attachmentAnxiety: number;
  readonly attachmentAvoidance: number;
  readonly thresholds: AttachmentThresholdView;
  /** 五项爱的语言（0–100，键为 `LOVE_*` 编码） */
  readonly loveLanguageScores: Readonly<Record<string, number>>;
  readonly primaryLoveLanguages: readonly string[];
  readonly conflictStyle: string;
  /** 五种冲突风格（0–100，键为 `CONFLICT_*` 编码） */
  readonly conflictScores: Readonly<Record<string, number>>;
  readonly completionRate: number | null;
  readonly consistencyScore: number | null;
  /**
   * 确定性结论（与结果页同一份、同一个纯函数）
   *
   * 放在这里而不是让前端再请求一次结果接口：报告详情是一份**独立可读**的交付物，
   * 用户从"我的报告"直接进来时手里没有会话 id，也没有必要为了四行字再跑一次网络。
   */
  readonly conclusion: EmotionConclusion;
}

/** 人格画像快照（MBTI 四维 + 大五） */
export interface PersonalityReportProfileSnapshotView {
  readonly kind: 'PERSONALITY';
  readonly mbtiType: string;
  readonly mbtiConfidence: number;
  /** 四维百分比（≥ 50 偏向正极字母；键为 `EI` / `SN` / `TF` / `JP`） */
  readonly dimensions: Readonly<Record<string, number>>;
  /** 大五得分（0–100，键为 `openness` 等英文小写） */
  readonly bigFive: Readonly<Record<string, number>>;
  readonly consistencyScore: number | null;
}

/** 详情接口下发的画像快照（无画像时为 `null`） */
export type ReportProfileSnapshotView = EmotionReportProfileSnapshotView | PersonalityReportProfileSnapshotView;

/** 情感画像的数据源（只声明用到的列，便于上层按需 select） */
export interface EmotionSnapshotSource {
  readonly attachmentStyle: string;
  readonly attachmentAnxiety: number;
  readonly attachmentAvoidance: number;
  readonly loveLanguageScores: unknown;
  readonly primaryLoveLanguages: readonly string[];
  readonly conflictStyle: string;
  readonly conflictScores: unknown;
  readonly completionRate: number | null;
  readonly consistencyScore: number | null;
}

/** 人格画像的数据源 */
export interface PersonalitySnapshotSource {
  readonly mbtiType: string;
  readonly mbtiConfidence: number;
  readonly eiPercent: number;
  readonly snPercent: number;
  readonly tfPercent: number;
  readonly jpPercent: number;
  readonly openness: number;
  readonly conscientiousness: number;
  readonly extraversion: number;
  readonly agreeableness: number;
  readonly neuroticism: number;
  readonly consistencyScore: number | null;
}

/**
 * 情感画像 → 快照
 *
 * `loveLanguageScores` / `conflictScores` 是 JSONB 列，交给 `parseScoreMap` 收窄
 * （理由见那份文件：后台能往里写任何 JSON，直接 `as Record<string, number>`
 * 会让字符串值混进条形图的宽度计算里）。
 */
export const buildEmotionProfileSnapshot = (
  source: EmotionSnapshotSource,
  thresholds: AttachmentThresholdView,
): EmotionReportProfileSnapshotView => {
  const loveLanguageScores = parseScoreMap(source.loveLanguageScores);
  const conflictScores = parseScoreMap(source.conflictScores);

  return {
    kind: 'EMOTION',
    attachmentStyle: source.attachmentStyle,
    attachmentAnxiety: source.attachmentAnxiety,
    attachmentAvoidance: source.attachmentAvoidance,
    thresholds,
    loveLanguageScores,
    primaryLoveLanguages: [...source.primaryLoveLanguages],
    conflictStyle: source.conflictStyle,
    conflictScores,
    completionRate: source.completionRate,
    consistencyScore: source.consistencyScore,
    // 与结果页**同一个纯函数**：同一份画像在这里与在结果页必须得到同一段话，
    // 否则用户会看到"报告里的结论"和"结果页的结论"不一样
    conclusion: buildEmotionConclusion({
      attachmentStyle: source.attachmentStyle,
      attachmentAnxiety: source.attachmentAnxiety,
      attachmentAvoidance: source.attachmentAvoidance,
      loveLanguageScores,
      primaryLoveLanguages: source.primaryLoveLanguages,
      conflictStyle: source.conflictStyle,
      conflictScores,
    }),
  };
};

/** 人格画像 → 快照 */
export const buildPersonalityProfileSnapshot = (
  source: PersonalitySnapshotSource,
): PersonalityReportProfileSnapshotView => ({
  kind: 'PERSONALITY',
  mbtiType: source.mbtiType,
  mbtiConfidence: source.mbtiConfidence,
  dimensions: {
    EI: source.eiPercent,
    SN: source.snPercent,
    TF: source.tfPercent,
    JP: source.jpPercent,
  },
  bigFive: {
    openness: source.openness,
    conscientiousness: source.conscientiousness,
    extraversion: source.extraversion,
    agreeableness: source.agreeableness,
    neuroticism: source.neuroticism,
  },
  consistencyScore: source.consistencyScore,
});
