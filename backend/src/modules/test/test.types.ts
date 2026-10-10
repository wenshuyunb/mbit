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
}

/** 抽题阶段拿到的题目 */
export interface SnapshotSourceQuestion {
  id: string;
  code: string;
  content: string;
  type: SnapshotQuestionType;
  dimension: string;
  reverseScored: boolean;
  weight: number;
  tags: string[];
  options: SnapshotSourceOption[];
}

/** 快照中的选项（前端渲染用） */
export interface PaperQuestionOption {
  label: string;
  value: number;
}

/** 快照中的题目 */
export interface PaperQuestion {
  /** 展示顺序（从 0 开始，与乱序后的最终顺序一致） */
  order: number;
  questionId: string;
  code: string;
  content: string;
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
