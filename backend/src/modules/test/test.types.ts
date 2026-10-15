/**
 * 测试会话模块 — 类型契约
 *
 * 说明：`paperSnapshot` 是落库的 JSONB 字段，其结构即前端契约（API_DESIGN §3.3.3）。
 * 单独定义类型而不是直接用 Prisma 的 `JsonValue`，是为了让
 * 「写快照」与「读快照」两侧共享同一份结构定义，避免字段名漂移。
 */

/** 题目类型（与 Prisma QuestionType 对齐） */
export type SnapshotQuestionType = 'LIKERT5' | 'BINARY' | 'FORCED_CHOICE' | 'RANK';

/** 抽题阶段拿到的选项（含 `isActive`，构造快照时过滤掉停用项） */
export interface SnapshotSourceOption {
  label: string;
  value: number;
  isActive: boolean;
  /** 该选项在各计分维度上的分值（场景题的算分依据；量表题为空对象） */
  scoreMap: Record<string, number>;
  /** 选中后的即时反馈（场景题用；量表题为 null） */
  feedback: string | null;
}

/** 抽题阶段拿到的题目 */
export interface SnapshotSourceQuestion {
  id: string;
  code: string;
  content: string;
  /** 场景题的提问句（量表题为 null） */
  scenarioPrompt: string | null;
  type: SnapshotQuestionType;
  dimension: string;
  reverseScored: boolean;
  weight: number;
  tags: string[];
  options: SnapshotSourceOption[];
}

/**
 * 快照中的选项（前端渲染 + **算分**用）
 *
 * ⚠ `scoreMap` / `feedback` 声明为**可选**是诚实的建模，不是偷懒：
 * 库里存着 `ps-v1` 的旧快照（本字段是 `ps-v2` 才加的），它们**没有这两个键**。
 * 因此读取侧必须容忍 `undefined`，统一用 `?? null` 归一后再交给引擎 ——
 * 声明成必填只会让类型说谎，然后在下游某处炸成 `undefined is not an object`。
 */
export interface PaperQuestionOption {
  label: string;
  value: number;
  /** 见 `SnapshotSourceOption.scoreMap`；`ps-v1` 快照里不存在 */
  scoreMap?: Record<string, number> | null;
  /** 见 `SnapshotSourceOption.feedback`；`ps-v1` 快照里不存在 */
  feedback?: string | null;
}

/** 快照中的题目 */
export interface PaperQuestion {
  /** 展示顺序（从 0 开始，与乱序后的最终顺序一致） */
  order: number;
  questionId: string;
  code: string;
  content: string;
  /** 场景题的提问句；`ps-v1` 快照与量表题都是 `null` */
  scenarioPrompt?: string | null;
  type: SnapshotQuestionType;
  dimension: string;
  reverseScored: boolean;
  weight: number;
  tags: string[];
  options: PaperQuestionOption[];
}

/** 量表说明（前端渲染李克特刻度用） */
export interface PaperAnswerScale {
  type: SnapshotQuestionType;
  labels: string[];
  values: number[];
}

/** 试卷快照（落库后永不修改） */
export interface PaperSnapshot {
  snapshotVersion: string;
  /** 每批下发题数 */
  questionsPerPage: number;
  /** 题目是否经过乱序 */
  shuffled: boolean;
  /** 是否存在选项乱序（逐题的最终顺序已固化在每题的 `options` 中） */
  optionShuffled: boolean;
  answerScale: PaperAnswerScale;
  questions: PaperQuestion[];
}
