/**
 * 匹配权重矩阵种子（架构 §12.2：权重矩阵存 `compatibility_weights`，后台可调、改动走版本号）
 *
 * ⚠ **矩阵的键必须与引擎读取的字段名完全一致**：
 *   · MBTI 四维键：`EI` / `SN` / `TF` / `JP`
 *   · 大五特质键：与 `CompatibilityProfile` 的字段名一致（`openness` 等小写）
 *   · 依恋键：`SECURE` / `ANXIOUS` / `AVOIDANT` / `FEARFUL`
 *
 * 键名写错的后果是**静默降级**而非报错：引擎读不到配置就跳过该维度、
 * 把权重归一给其余维度，用户看到一个"算出来了"但依据更少的分数。
 * `compatibility-weights.spec.ts` 用「把种子喂进引擎并断言无维度被跳过」
 * 把这条约束变成可执行测试。
 *
 * 分数方向：0–100，越高越契合。数值是**产品判断**而非科学结论，
 * 因此全部集中在配置表里、由运营经后台调整，而不是散落在代码中。
 */

/** 匹配引擎读取的 MBTI 维度 */
const MBTI_DIMENSIONS = ['EI', 'SN', 'TF', 'JP'] as const;

/** 匹配引擎读取的依恋风格 */
const ATTACHMENT_STYLES = ['SECURE', 'ANXIOUS', 'AVOIDANT', 'FEARFUL'] as const;

/**
 * 依恋组合基准分（对称矩阵，只需写下三角）
 *
 * 依据依恋理论中「焦虑—回避追逃循环」是最高风险组合（32 分）；
 * 安全型与任何类型的组合都相对稳定（安全型本身是关系缓冲）；
 * 两个不安全型组合在一起缺少修复能力，因此低于任一单项的基准。
 */
const ATTACHMENT_PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ['SECURE', 'SECURE', 95],
  ['SECURE', 'ANXIOUS', 75],
  ['SECURE', 'AVOIDANT', 72],
  ['SECURE', 'FEARFUL', 62],
  ['ANXIOUS', 'ANXIOUS', 55],
  ['ANXIOUS', 'AVOIDANT', 32],
  ['ANXIOUS', 'FEARFUL', 45],
  ['AVOIDANT', 'AVOIDANT', 50],
  ['AVOIDANT', 'FEARFUL', 42],
  ['FEARFUL', 'FEARFUL', 40],
];

/** 生成完整 4×4 对称矩阵（引擎虽支持双向查找，但填满可避免"漏配组合"这类静默缺口） */
const buildAttachmentMatrix = (): Record<string, Record<string, number>> => {
  const matrix: Record<string, Record<string, number>> = {};

  for (const style of ATTACHMENT_STYLES) {
    matrix[style] = {};
  }

  for (const [a, b, score] of ATTACHMENT_PAIRS) {
    matrix[a][b] = score;
    // 镜像填充：组合分是双向对称的（谁是谁不影响契合度）
    matrix[b][a] = score;
  }

  return matrix;
};

/** 权重矩阵种子 */
export interface SeedCompatibilityWeights {
  code: string;
  name: string;
  version: string;
  description: string;
  mbtiMatrix: Record<string, { same: number; different: number }>;
  bigFiveConfig: Record<string, { mode: 'SIMILAR' | 'COMPLEMENTARY'; idealGap?: number; weight: number }>;
  attachmentMatrix: Record<string, Record<string, number>>;
  communicationConfig: {
    loveLanguageBase: number;
    loveLanguagePerMatch: number;
    conflictStyleSame: number;
    conflictStyleDifferent: number;
  };
  dimensionWeights: { mbti: number; bigFive: number; attachment: number; communication: number };
}

/**
 * 默认权重版本
 *
 * 设计取向说明（供运营调整时参考）：
 *   · **SN 维度同极权重最高（95）**：感知方式不同（一个看事实、一个看可能性）
 *     是日常沟通中最难协调的差异，说的是同一种语言却常指不同的事
 *   · **EI 维度异极略优（80 > 70）**：内外向互补能拓宽双方的活动半径，
 *     但差距过大时需要刻意安排各自独处/社交的时间
 *   · **大五中尽责性权重最高（1.5）**：金钱、家务、deadline 的预期冲突
 *     是长期关系里最高频的矛盾来源
 *   · **依恋风格占 25%**：它是"关系能否修复"的核心变量，因此权重高于沟通偏好
 */
export const COMPATIBILITY_WEIGHTS: SeedCompatibilityWeights[] = [
  {
    code: 'DEFAULT',
    name: '默认匹配权重',
    version: '1.0.0',
    description:
      '首版默认权重：MBTI 维度互补性 + 大五同质/异质配置 + 依恋组合矩阵 + 沟通偏好一致性。分数为产品判断，可由后台调整并走版本号。',
    mbtiMatrix: {
      EI: { same: 70, different: 80 },
      SN: { same: 95, different: 55 },
      TF: { same: 85, different: 70 },
      JP: { same: 75, different: 80 },
    },
    bigFiveConfig: {
      // 尽责性：差异大意味着家务与 deadline 预期冲突，权重最高
      conscientiousness: { mode: 'SIMILAR', weight: 1.5 },
      // 宜人性：都高则冲突易化解；一高一低容易出现单方面让步
      agreeableness: { mode: 'SIMILAR', weight: 1.2 },
      // 开放性：相似更好（对新鲜事物的接受度接近，兴趣交集更多）
      openness: { mode: 'SIMILAR', weight: 1 },
      // 神经质：都低最稳；都高则情绪叠加，因此也是相似更好
      neuroticism: { mode: 'SIMILAR', weight: 1 },
      // 外向性：**互补**——差 20 分左右最佳（一个带动社交、一个提供安静），
      // 差 60 分以上则生活节奏难以同步
      extraversion: { mode: 'COMPLEMENTARY', idealGap: 20, weight: 1 },
    },
    attachmentMatrix: buildAttachmentMatrix(),
    communicationConfig: {
      loveLanguageBase: 50,
      loveLanguagePerMatch: 25,
      conflictStyleSame: 100,
      conflictStyleDifferent: 60,
    },
    dimensionWeights: { mbti: 30, bigFive: 30, attachment: 25, communication: 15 },
  },
];

/** 导出的维度清单（供契约测试断言矩阵完整性） */
export const COMPATIBILITY_MBTI_DIMENSIONS = MBTI_DIMENSIONS;
export const COMPATIBILITY_ATTACHMENT_STYLES = ATTACHMENT_STYLES;
