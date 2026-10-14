/**
 * 心理健康算法引擎 — 类型契约（ADR-038 阶段 4）
 *
 * ## 这个模块只做一件事：**给结论**
 *
 * 用户对该模块的定位逐字是：
 *   「多维度得分 + 文字结论，要写好提示，本结果仅供参考的字样，
 *     不涉及专业建议以及心理干预，只做结论」
 *
 * 因此引擎的输出被刻意收窄成"分数 + 一段描述性的结论文本"：
 *   · **不给建议**：结论文本里不会出现"你可以试试……""建议你……"；
 *   · **不做干预**：没有引导、没有行动计划、没有分级处置；
 *   · **不做诊断**：维度名用体验词（压力、低落、不安、睡眠困扰、精力不足、缺少支持），
 *     不用临床构念（抑郁、焦虑障碍、症状）。
 *
 * ## ⚠ 六个维度方向一致：**分数越高 = 越值得留意**
 *
 * 这是**正确性**要求，不是措辞偏好。`overallScore` 是六维均值，
 * 只要混进一个"越高越好"的维度（例如写着更顺口的「社会支持」），
 * 聚合就会**静默反向** —— 状态越好的人被判成越值得留意，而文案读起来完全通顺。
 * 所以第六维是「缺少支持」而不是「社会支持」。
 *
 * 这条约束由测试钉住（`mental-health-engine.service.spec.ts` 有一条
 * "六维方向一致性"的断言）：将来有人加维度时，必须显式想清楚方向。
 */

import type { EngineAnswer, EngineQuestion, QualityMetrics, RawScores } from '../../../common/engine/assessment.types';

/** 引擎版本：随画像落库，算法升级时旧画像不重算而是产生新版本 */
export const MENTAL_HEALTH_ENGINE_VERSION = 'mh-v1.0.0';

/**
 * 六个计分维度
 *
 * 顺序即**展示与结论文本的固定顺序**，不按分数排序 ——
 * 同一份结果每次渲染的行序必须一致，否则用户来回切换页面会看到顺序跳动。
 * "哪几项最值得留意"由 `highlightedDimensions` 单独承担。
 */
export const MENTAL_HEALTH_DIMENSIONS = [
  'MH_STRESS',
  'MH_MOOD',
  'MH_ANXIETY',
  'MH_SLEEP',
  'MH_ENERGY',
  'MH_LONELINESS',
] as const;

export type MentalHealthDimension = (typeof MENTAL_HEALTH_DIMENSIONS)[number];

/** 情感/心理两个模块的分数方向都是"越高越值得留意"，这里显式声明一次便于审查 */
export const MENTAL_HEALTH_HIGHER_IS_WORSE = true;

/** 维度中文名（**提示词与结论文本里唯一的中文名来源**） */
export const MENTAL_HEALTH_DIMENSION_LABELS: Readonly<Record<MentalHealthDimension, string>> = {
  MH_STRESS: '压力感受',
  MH_MOOD: '情绪低落',
  MH_ANXIETY: '紧张不安',
  MH_SLEEP: '睡眠困扰',
  MH_ENERGY: '精力不足',
  MH_LONELINESS: '缺少支持',
};

/**
 * 分数档位
 *
 * 四档，但**措辞一律克制**：最强的档位也只是"比较明显"，
 * 不用"严重""偏高很多"这类会放大焦虑的词 —— 本模块不做诊断，也不该制造恐慌。
 */
export type MentalHealthBand = 'CALM' | 'SLIGHT' | 'MILD' | 'NOTABLE';

/** 档位中文名（结论文本用） */
export const MENTAL_HEALTH_BAND_LABELS: Readonly<Record<MentalHealthBand, string>> = {
  CALM: '平稳',
  SLIGHT: '偶尔',
  MILD: '比较明显',
  NOTABLE: '比较突出',
};

/**
 * 整体档位（**描述性**，不对应任何临床分级）
 *
 * 三档而不是四档：整体结论是给用户看的第一句话，分得越细越像"分级判定"，
 * 而本模块明确不做判定。三档足以表达"平稳 / 有些起伏 / 值得留意"。
 */
export type MentalHealthOverallLevel = 'GOOD' | 'MILD' | 'NOTABLE';

/**
 * 整体档位中文名
 *
 * ⚠ 三个名字**都必须带"整体"二字**：它们出现在结论的第一句
 * （`你近期的状态${label}`），而第一句的作用就是给一个整体判断。
 * 少了"整体"，`NOTABLE` 那句会读成"你近期的状态有几处值得留意"——
 * 语义上从"整体判断"滑成了"零散发现"，与第二句的逐项描述重复。
 */
export const MENTAL_HEALTH_OVERALL_LABELS: Readonly<Record<MentalHealthOverallLevel, string>> = {
  GOOD: '整体比较平稳',
  MILD: '整体有些起伏',
  NOTABLE: '整体有几处值得留意',
};

/** 引擎输入 */
export interface MentalHealthEngineInput {
  /** 试卷中的题目（必须与作答时一致，保证可复现） */
  questions: EngineQuestion[];
  /** 用户答案 */
  answers: EngineAnswer[];
  /**
   * 档位阈值（0–100），**由调用方从系统配置读入**
   *
   * 不做成代码常量：什么分数算"值得留意"是产品口径问题，
   * 调整它不该发版。默认值见 `DEFAULT_LEVEL_THRESHOLDS`。
   */
  levelThresholds?: MentalHealthLevelThresholds;
  /** 高亮几个维度（默认 2） */
  highlightCount?: number;
}

/** 档位阈值 */
export interface MentalHealthLevelThresholds {
  /** 单维档位分界：`[CALM 上界, SLIGHT 上界, MILD 上界]`（超过最后一个即 NOTABLE） */
  band: readonly [number, number, number];
  /** 整体档位分界：`[GOOD 上界, MILD 上界]`（超过第二个即 NOTABLE） */
  overall: readonly [number, number];
}

/** 默认阈值 */
export const DEFAULT_LEVEL_THRESHOLDS: MentalHealthLevelThresholds = {
  band: [30, 50, 70],
  overall: [35, 55],
};

/** 单维结果 */
export interface MentalHealthDimensionResult {
  /** 0–100，越高越值得留意 */
  score: number;
  band: MentalHealthBand;
  /** 是否有有效数据（false 时 score 是占位 50，不代表测量结果） */
  usable: boolean;
}

/** 引擎输出 */
export interface MentalHealthEngineOutput {
  engineVersion: string;
  /** 六维完整结果（按 `MENTAL_HEALTH_DIMENSIONS` 固定顺序） */
  dimensions: Record<MentalHealthDimension, MentalHealthDimensionResult>;
  /** 六维均值（0–100） */
  overallScore: number;
  /** 整体档位（描述性，不是诊断分级） */
  overallLevel: MentalHealthOverallLevel;
  /** 最值得留意的 1–2 项（按分数降序；并列时按维度定义顺序） */
  highlightedDimensions: MentalHealthDimension[];
  /**
   * 文字结论（**确定性规则生成，不含任何建议**）
   *
   * 由服务端生成并落库：用户看到的这段文字必须是可复现、可审计的，
   * 而不是每次请求由模型现编 —— 后者在心理健康这个主题上尤其不可接受。
   */
  conclusion: string;
  /** 数据不足、无法给出结论的维度名（为空表示六个维度都有数据） */
  unresolved: string[];
  quality: QualityMetrics;
  rawScores: RawScores;
}
