/**
 * 试卷快照构造器（纯函数）
 *
 * 契约来源：docs/API_DESIGN.md §3.3.3 业务规则 2、3
 *
 * 为什么必须固化快照：
 *   题目乱序 + 选项乱序后，若不在会话上固化「当时下发的题目与顺序」，
 *   题库后续的增删改会影响进行中的会话与历史结果的可解释性 ——
 *   用户看到的第 7 题和算分用的第 7 题可能不是同一题。
 *   因此 `paperSnapshot` 一经写入**永不修改**。
 *
 * 乱序策略（契约规则 2）：
 *   · 题目乱序：全部题目参与
 *   · 选项乱序：**仅 `BINARY` 且非反向题** —— 李克特量表打乱顺序会破坏「程度递进」的语义
 *
 * 本文件是纯函数：随机源可注入，便于单测得到确定性结果。
 */

import type { PaperQuestion, PaperSnapshot, SnapshotSourceQuestion } from './test.types';

/** 快照格式版本：格式变更时递增，旧会话仍可按旧版本解析 */
export const SNAPSHOT_VERSION = 'ps-v2';

/**
 * `ps-v1` — 只带 `{ label, value }` 的历史格式
 *
 * `ps-v2`（ADR-039）在选项上补了 `scoreMap`（场景题的**算分依据**）
 * 与 `feedback`，在题目上补了 `scenarioPrompt`。
 *
 * ⚠ 升版**不能**让旧会话失效：库里存着进行中的 `ps-v1` 会话，
 * 它们按旧语义（选项分值 = 用户所选值）继续算分，不受影响。
 * 读取侧因此必须把缺失的 `scoreMap` 归一为 `null`，而不是当作 0 ——
 * 当作 0 会让所有旧作答被算成"全部最低分"，且不报任何错。
 */
export const LEGACY_SNAPSHOT_VERSION = 'ps-v1';

/** 默认每批返回题数（契约规则 4：48–93 题的完整试卷约 60–120KB，超出小程序单次请求体验阈值） */
export const DEFAULT_PAGE_SIZE = 20;

/** 李克特 5 点量表的标准选项与标签（与 seed 保持一致） */
const LIKERT5_SCALE = {
  type: 'LIKERT5' as const,
  labels: ['非常不同意', '不同意', '中立', '同意', '非常同意'],
  values: [1, 2, 3, 4, 5],
};

/** Fisher–Yates 洗牌（返回新数组，不修改入参） */
export const shuffle = <T>(items: readonly T[], random: () => number): T[] => {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const current = result[i];
    const target = result[j];

    // 显式判空以满足 noUncheckedIndexedAccess 风格的严格性
    if (current === undefined || target === undefined) continue;

    result[i] = target;
    result[j] = current;
  }

  return result;
};

/** 是否应对该题的选项卡进行乱序（契约规则 2） */
export const shouldShuffleOptions = (question: SnapshotSourceQuestion): boolean =>
  question.type === 'BINARY' && !question.reverseScored;

/** 构造单题的快照条目 */
const buildPaperQuestion = (question: SnapshotSourceQuestion, order: number, random: () => number): PaperQuestion => {
  /**
   * ⚠ 选项乱序**只对 `BINARY` 生效**，且这里刻意不给场景题乱序
   *
   * 量表题乱序会破坏"程度递进"的语义（契约规则 2）；
   * 而场景题的选项是**并列的做法**，乱序本身无害 —— 但它的每个选项都带
   * `scoreMap`（算分依据），乱序一旦出错就会让"选 A 得到 B 的分"且无法察觉。
   * 收益（避免位置偏好）远小于风险（算分错位），因此不做。
   */
  const options = question.options
    .filter((option) => option.isActive)
    .map((option) => ({
      label: option.label,
      value: option.value,
      scoreMap: option.scoreMap,
      feedback: option.feedback,
    }));

  const orderedOptions = shouldShuffleOptions(question) ? shuffle(options, random) : options;

  return {
    order,
    questionId: question.id,
    code: question.code,
    content: question.content,
    scenarioPrompt: question.scenarioPrompt,
    type: question.type,
    dimension: question.dimension,
    reverseScored: question.reverseScored,
    weight: question.weight,
    tags: question.tags,
    options: orderedOptions,
  };
};

/**
 * 构造试卷快照
 *
 * @param questions 抽题结果（已按定义规则选出，顺序未定）
 * @param options.random 随机源（默认 `Math.random`；测试可注入确定性序列）
 */
export const buildPaperSnapshot = (
  questions: readonly SnapshotSourceQuestion[],
  options: { random?: () => number; shuffled?: boolean } = {},
): PaperSnapshot => {
  const random = options.random ?? Math.random;
  const shouldShuffleQuestions = options.shuffled ?? true;

  const ordered = shouldShuffleQuestions ? shuffle(questions, random) : [...questions];

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    questionsPerPage: DEFAULT_PAGE_SIZE,
    shuffled: shouldShuffleQuestions,
    // 只要有任一题需要选项乱序，就在快照层面标记；逐题的最终顺序已固化在 options 中
    optionShuffled: questions.some(shouldShuffleOptions),
    answerScale: LIKERT5_SCALE,
    questions: ordered.map((question, index) => buildPaperQuestion(question, index, random)),
  };
};
