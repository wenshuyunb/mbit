/**
 * 人格引擎「输出不变」回归锁（ADR-038 阶段 1 的前置约束）
 *
 * ## 为什么先写这个再动结构
 *
 * ADR-038 要把引擎从"写死两个族的固定输出"改成"按模块调度 evaluator"，
 * 而**现有全部存量画像与四类报告都压在这一个 `compute()` 上**：
 * 报告的可复现性承诺（ADR-005）要求同一份试卷 + 同一份答案**永远算出同一结果**。
 *
 * 因此重构前必须先把当前输出**整体冻结**成快照：重构后只要有一个数字变了，
 * 这里就会失败。这不是"锦上添花的测试"，而是这次重构唯一的刹车。
 *
 * ## 为什么用快照而不是逐字段断言
 *
 * 逐字段断言只能覆盖"我想到了的字段"。快照覆盖**整个返回对象**：
 * 任何"顺手多加一个字段"或"少返回一个字段"都会被发现
 *（键集合另有一条显式断言，因为快照对"新增可枚举字段"的敏感度依赖序列化细节）。
 *
 * ## 夹具为什么这么造
 *
 *   · 每个维度**正反向题各一**：只放正向题的话，反向计分逻辑坏了也测不出来；
 *   · 答案值**刻意不落在中位 3**：全填 3 会让 percent 恒为 50，几乎掩盖所有公式错误；
 *   · 每维第三道题给 `weight: 2`：覆盖"权重参与 weightedMin/Max 缩放"的分支；
 *   · 含一道 `responseMs = 500`（低于 1200 阈值）：驱动 `rushRate > 0`；
 *   · 关系规则给**一条必然命中 + 一条不可能命中**：覆盖命中分支与"回落默认风格"分支。
 */

import { PersonalityEngine } from './personality-engine.service';
import {
  BIG_FIVE_DIMENSIONS,
  MBTI_DIMENSIONS,
  type BigFiveDimension,
  type EngineAnswer,
  type EngineQuestion,
  type MbtiDimension,
  type RelationshipStyleRule,
} from './personality-engine.types';

/**
 * 造一道 5 点李克特题
 *
 * 显式给出 `minValue`/`maxValue`：默认值一旦被改动，本测试应当失败而不是跟着变。
 */
const likert = (id: string, dimension: string, reverseScored: boolean, weight = 1): EngineQuestion => ({
  id,
  type: 'LIKERT5',
  dimension,
  weight,
  reverseScored,
  minValue: 1,
  maxValue: 5,
  options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
});

/** 固定题集：MBTI 四维与 BigFive 五维，每维正反向各一 + 一道权重 2 的题 */
const QUESTIONS: EngineQuestion[] = [
  ...MBTI_DIMENSIONS.flatMap((dimension: MbtiDimension) => [
    likert(`q-${dimension}-f`, dimension, false),
    likert(`q-${dimension}-r`, dimension, true),
    likert(`q-${dimension}-w`, dimension, false, 2),
  ]),
  ...BIG_FIVE_DIMENSIONS.flatMap((dimension: BigFiveDimension) => [
    likert(`q-${dimension}-f`, dimension, false),
    likert(`q-${dimension}-r`, dimension, true),
  ]),
];

/**
 * 固定答案：刻意分布不均匀
 *
 * 正向题给 4/5、反向题给 1 —— 各维度百分比会明显偏离 50，公式写错时立刻可见。
 * `q-EI-w` 的 `responseMs` 设为 500（低于 `RUSH_THRESHOLD_MS = 1200`）驱动 `rushRate > 0`。
 */
const ANSWERS: EngineAnswer[] = QUESTIONS.map((question, index) => ({
  questionId: question.id,
  value: question.reverseScored ? 1 + (index % 2) : 4 + (index % 2),
  responseMs: question.id === 'q-EI-w' ? 500 : 3000 + index * 10,
}));

/** 一条必然命中的规则（低门槛）+ 一条不可能命中的规则（阈值 -1） */
const RULES: RelationshipStyleRule[] = [
  {
    code: 'REGRESSION_MATCH',
    name: '回归夹具：必然命中',
    priority: 1,
    conditions: { any: [{ field: 'openness', op: 'gte', value: 0 }] },
    resultAttachment: 'SECURE',
    resultLoveLanguages: ['QUALITY_TIME'],
    resultConflictStyle: 'COLLABORATING',
  },
  {
    code: 'REGRESSION_MISS',
    name: '回归夹具：不可能命中',
    priority: 2,
    conditions: { any: [{ field: 'openness', op: 'lt', value: -1 }] },
    resultAttachment: 'FEARFUL',
    resultLoveLanguages: [],
    resultConflictStyle: null,
  },
];

const engine = new PersonalityEngine();

const computeFull = (): ReturnType<PersonalityEngine['compute']> =>
  engine.compute({ questions: QUESTIONS, answers: ANSWERS, relationshipRules: RULES });

describe('人格引擎输出回归锁（ADR-038 阶段 1）', () => {
  it('【关键】含关系规则的完整输出与快照逐字段一致', () => {
    expect(computeFull()).toMatchSnapshot();
  });

  it('【关键】不含关系规则时（回落默认风格分支）与快照一致', () => {
    expect(engine.compute({ questions: QUESTIONS, answers: ANSWERS })).toMatchSnapshot();
  });

  it('【关键】只有 MBTI 题时与快照一致（大五走"无数据占位 50"分支）', () => {
    const mbtiQuestions = QUESTIONS.filter((question) => MBTI_DIMENSIONS.includes(question.dimension as MbtiDimension));
    const ids = new Set(mbtiQuestions.map((question) => question.id));

    expect(
      engine.compute({
        questions: mbtiQuestions,
        answers: ANSWERS.filter((answer) => ids.has(answer.questionId)),
        relationshipRules: RULES,
      }),
    ).toMatchSnapshot();
  });

  it('【关键】大五全无数据时确实回落中位 50（而不是恰好算出来的 50）', () => {
    const mbtiQuestions = QUESTIONS.filter((question) => MBTI_DIMENSIONS.includes(question.dimension as MbtiDimension));
    const ids = new Set(mbtiQuestions.map((question) => question.id));
    const output = engine.compute({
      questions: mbtiQuestions,
      answers: ANSWERS.filter((answer) => ids.has(answer.questionId)),
    });

    expect(output.bigFive).toEqual({
      openness: 50,
      conscientiousness: 50,
      extraversion: 50,
      agreeableness: 50,
      neuroticism: 50,
    });
    // MBTI 有数据，必须不是 null
    expect(output.mbti.type).not.toBeNull();
  });

  it('【关键】返回对象的**键集合**被冻结 —— 多一个或少一个字段都必须失败', () => {
    const output = computeFull();

    // 键集合是契约的一部分：画像落库 / 报告上下文 / 前端都按它取数
    expect(Object.keys(output).sort()).toEqual([
      'bigFive',
      'engineVersion',
      'mbti',
      'quality',
      'rawScores',
      'relationshipStyle',
    ]);
    expect(Object.keys(output.mbti).sort()).toEqual(['confidence', 'dimensions', 'type']);
    expect(Object.keys(output.bigFive).sort()).toEqual([
      'agreeableness',
      'conscientiousness',
      'extraversion',
      'neuroticism',
      'openness',
    ]);
    expect(Object.keys(output.relationshipStyle).sort()).toEqual([
      'attachment',
      'conflictStyle',
      'loveLanguage',
      'matchedRuleCode',
    ]);
    expect(Object.keys(output.quality).sort()).toEqual([
      'answeredCount',
      'avgResponseMs',
      'completionRate',
      'consistencyScore',
      'rushRate',
      'skippedCount',
      'totalCount',
    ]);
  });

  it('关系规则命中与回落两条分支都真的被走到（夹具自检，避免"两条都走同一条"）', () => {
    expect(computeFull().relationshipStyle.matchedRuleCode).toBe('REGRESSION_MATCH');
    expect(computeFull().relationshipStyle.attachment).toBe('SECURE');
    expect(engine.compute({ questions: QUESTIONS, answers: ANSWERS }).relationshipStyle.matchedRuleCode).toBeNull();
  });

  it('质量指标里 `rushRate` 大于 0（证明过快作答那道题真的被计入）', () => {
    expect(computeFull().quality.rushRate).toBeGreaterThan(0);
  });

  it('引擎版本号与实例属性一致（改算法必须升版本，否则存量画像无法区分算法代次）', () => {
    expect(engine.version).toBe(computeFull().engineVersion);
  });
});
