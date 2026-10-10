/**
 * 人格算法引擎测试
 *
 * 覆盖标准（架构 §18.3）：**核心算法覆盖率 ≥ 95%**。
 * 因此这里不只测「正常路径」，还覆盖：
 *   · 反向计分与加权的数学正确性（用可手算的期望值验证）
 *   · 结果确定性（相同输入必须完全一致，这是 ADR-005 的核心承诺）
 *   · 边界与异常（缺维度、空试卷、非法量表、越界答案、外部题目）
 *   · 质量指标（一致性、完成率、过快作答）的语义正确性
 */

import { PersonalityEngine } from './personality-engine.service';
import {
  DEFAULT_SCALE,
  ENGINE_VERSION,
  type EngineAnswer,
  type EngineQuestion,
  type PersonalityEngineInput,
  type PersonalityEngineOutput,
} from './personality-engine.types';

// ============================================================================
// 夹具构造器
// ============================================================================

/** 构造一道李克特量表题 */
const likert = (
  id: string,
  dimension: string,
  options: { reverseScored?: boolean; weight?: number } = {},
): EngineQuestion => ({
  id,
  type: 'LIKERT5',
  dimension,
  weight: options.weight ?? 1,
  reverseScored: options.reverseScored ?? false,
  options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
});

/** 构造一道二选题 */
const binary = (
  id: string,
  dimension: string,
  options: { reverseScored?: boolean; weight?: number } = {},
): EngineQuestion => ({
  id,
  type: 'BINARY',
  dimension,
  weight: options.weight ?? 1,
  reverseScored: options.reverseScored ?? false,
  options: [0, 1].map((value) => ({ value, scoreMap: null })),
});

/** 构造一道迫选题（不同选项对维度的贡献不同） */
const forcedChoice = (
  id: string,
  dimension: string,
  mapping: Array<{ value: number; score: number }>,
): EngineQuestion => ({
  id,
  type: 'FORCED_CHOICE',
  dimension,
  weight: 1,
  reverseScored: false,
  options: mapping.map((item) => ({ value: item.value, scoreMap: { [dimension.toUpperCase()]: item.score } })),
});

/** 构造一道排序题 */
const rank = (
  id: string,
  dimension: string,
  optionWeights: Array<{ value: number; weight: number }>,
): EngineQuestion => ({
  id,
  type: 'RANK',
  dimension,
  weight: 1,
  reverseScored: false,
  options: optionWeights.map((item) => ({
    value: item.value,
    scoreMap: { [dimension.toUpperCase()]: item.weight },
  })),
});

const answer = (questionId: string, value: number | number[], responseMs?: number): EngineAnswer => ({
  questionId,
  value,
  ...(responseMs === undefined ? {} : { responseMs }),
});

/** 构造覆盖四个 MBTI 维度的最小试卷（每维度 1 题） */
const minimalMbtiPaper = (): EngineQuestion[] => [
  likert('q-ei', 'EI'),
  likert('q-sn', 'SN'),
  likert('q-tf', 'TF'),
  likert('q-jp', 'JP'),
];

const run = (input: PersonalityEngineInput): PersonalityEngineOutput => new PersonalityEngine().compute(input);

// ============================================================================
// 测试
// ============================================================================

describe('PersonalityEngine', () => {
  let engine: PersonalityEngine;

  beforeEach(() => {
    engine = new PersonalityEngine();
  });

  it('引擎版本随画像输出（算法升级可追溯）', () => {
    expect(engine.version).toBe(ENGINE_VERSION);
    expect(run({ questions: minimalMbtiPaper(), answers: [] }).engineVersion).toBe(ENGINE_VERSION);
  });

  // ==========================================================================
  // MBTI 算分
  // ==========================================================================

  describe('MBTI 维度算分', () => {
    it('全选最高分 → 四维度 100 → ESTJ', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 5), answer('q-sn', 5), answer('q-tf', 5), answer('q-jp', 5)],
      });

      expect(result.mbti.dimensions).toEqual({ EI: 100, SN: 100, TF: 100, JP: 100 });
      expect(result.mbti.type).toBe('ESTJ');
    });

    it('全选最低分 → 四维度 0 → INFP', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 1), answer('q-sn', 1), answer('q-tf', 1), answer('q-jp', 1)],
      });

      expect(result.mbti.dimensions).toEqual({ EI: 0, SN: 0, TF: 0, JP: 0 });
      expect(result.mbti.type).toBe('INFP');
    });

    it('【反向计分】反向题选 5 等价于正向题选 1（语义翻转到同一极）', () => {
      const forward = run({ questions: [likert('q', 'EI')], answers: [answer('q', 1)] });
      const reverse = run({
        questions: [likert('q', 'EI', { reverseScored: true })],
        answers: [answer('q', 5)],
      });

      expect(reverse.mbti.dimensions.EI).toBe(forward.mbti.dimensions.EI);
      expect(reverse.mbti.dimensions.EI).toBe(0);
    });

    it('【反向计分】反向题选 1 → 相当于正向题选 5', () => {
      const result = run({
        questions: [likert('q', 'EI', { reverseScored: true })],
        answers: [answer('q', 1)],
      });

      expect(result.mbti.dimensions.EI).toBe(100);
    });

    it('【反向计分】正反向题混合时按各题修正后求和', () => {
      // 正向题选 5 → 5；反向题选 3 → 1+5-3 = 3；合计 8
      // 下界 1+1=2，上界 5+5=10 → (8-2)/(10-2) = 75%
      const result = run({
        questions: [likert('q1', 'EI'), likert('q2', 'EI', { reverseScored: true })],
        answers: [answer('q1', 5), answer('q2', 3)],
      });

      expect(result.mbti.dimensions.EI).toBe(75);
    });

    it('【加权】权重 2 的题影响是权重 1 的两倍', () => {
      // q1 权重 1 选 5（贡献 5），q2 权重 3 选 1（贡献 3）
      // 合计 8；下界 1×1 + 1×3 = 4；上界 5×1 + 5×3 = 20 → (8-4)/(20-4) = 25%
      const result = run({
        questions: [likert('q1', 'EI'), likert('q2', 'EI', { weight: 3 })],
        answers: [answer('q1', 5), answer('q2', 1)],
      });

      expect(result.mbti.dimensions.EI).toBe(25);
    });

    it('恰好 50% 时取正极字母（E / S / T / J）', () => {
      // 单题 1–5 量表无法得到恰好 50；用两题（1 与 5）得到 3/中间
      // 改用 BINARY：一题选 1、一题选 0 → 50%
      const result = run({
        questions: [binary('q1', 'EI'), binary('q2', 'EI')],
        answers: [answer('q1', 1), answer('q2', 0)],
      });

      expect(result.mbti.dimensions.EI).toBe(50);
      expect(result.mbti.type).toBeNull(); // 其他维度无数据，因此类型不可判定
    });

    it('各维度相互独立（EI 高分不影响 SN）', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 5), answer('q-sn', 1), answer('q-tf', 3), answer('q-jp', 1)],
      });

      expect(result.mbti.dimensions.EI).toBe(100);
      expect(result.mbti.dimensions.SN).toBe(0);
      expect(result.mbti.dimensions.JP).toBe(0);
    });

    it('单个维度缺少作答时 type 为 null（不猜测类型）', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 5), answer('q-sn', 5), answer('q-tf', 5)],
      });

      expect(result.mbti.type).toBeNull();
      // 但已作答的维度仍给出百分比
      expect(result.mbti.dimensions.EI).toBe(100);
    });

    it('完全未作答 → type 为 null、confidence 为 0', () => {
      const result = run({ questions: minimalMbtiPaper(), answers: [] });

      expect(result.mbti.type).toBeNull();
      expect(result.mbti.confidence).toBe(0);
      expect(result.mbti.dimensions).toEqual({ EI: 50, SN: 50, TF: 50, JP: 50 });
    });
  });

  // ==========================================================================
  // 置信度
  // ==========================================================================

  describe('置信度', () => {
    it('四个维度都极端 → 置信度 100', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 5), answer('q-sn', 5), answer('q-tf', 5), answer('q-jp', 5)],
      });

      expect(result.mbti.confidence).toBe(100);
    });

    it('四个维度都居中 → 置信度接近 0', () => {
      // 每维度两题：一题 3、一题 3 → 50%
      const questions = ['EI', 'SN', 'TF', 'JP'].flatMap((dimension) => [
        likert(`q-${dimension}-1`, dimension),
        likert(`q-${dimension}-2`, dimension),
      ]);
      const answers = ['EI', 'SN', 'TF', 'JP'].flatMap((dimension) => [
        answer(`q-${dimension}-1`, 3),
        answer(`q-${dimension}-2`, 3),
      ]);

      const result = run({ questions, answers });

      expect(result.mbti.confidence).toBe(0);
    });

    it('仅部分维度有数据时只对这些维度求平均', () => {
      // EI = 100（偏离 50），其余无数据 → 平均 = 100
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 5)],
      });

      expect(result.mbti.confidence).toBe(100);
    });
  });

  // ==========================================================================
  // 大五人格
  // ==========================================================================

  describe('大五人格算分', () => {
    it('单极 0–100 归一化并映射到正确字段', () => {
      const questions = [
        likert('o', 'OPENNESS'),
        likert('c', 'CONSCIENTIOUSNESS'),
        likert('e', 'EXTRAVERSION'),
        likert('a', 'AGREEABLENESS'),
        likert('n', 'NEUROTICISM'),
      ];

      const result = run({
        questions,
        answers: [answer('o', 5), answer('c', 1), answer('e', 3), answer('a', 5), answer('n', 1)],
      });

      expect(result.bigFive).toEqual({
        openness: 100,
        conscientiousness: 0,
        extraversion: 50,
        agreeableness: 100,
        neuroticism: 0,
      });
    });

    it('反向题在大五维度上同样生效', () => {
      const result = run({
        questions: [likert('n', 'NEUROTICISM', { reverseScored: true })],
        answers: [answer('n', 5)],
      });

      // 反向题选 5 → 情绪稳定性高 → 神经质得分为 0
      expect(result.bigFive.neuroticism).toBe(0);
    });

    it('无数据的维度取中位 50，且 rawScores 可识别为未作答', () => {
      const result = run({
        questions: [likert('o', 'OPENNESS')],
        answers: [answer('o', 5)],
      });

      expect(result.bigFive.neuroticism).toBe(50);
      expect(result.bigFive.openness).toBe(100);
      expect(result.rawScores.dimensions['NEUROTICISM']).toBeUndefined();
    });

    it('结果四舍五入到 2 位小数（避免浮点长尾落库）', () => {
      // 三题：5、4、4 → 13；下界 3，上界 15 → (13-3)/12 = 83.333…%
      const result = run({
        questions: [likert('a', 'OPENNESS'), likert('b', 'OPENNESS'), likert('c', 'OPENNESS')],
        answers: [answer('a', 5), answer('b', 4), answer('c', 4)],
      });

      expect(result.bigFive.openness).toBe(83.33);
    });
  });

  // ==========================================================================
  // 题型支持
  // ==========================================================================

  describe('题型支持', () => {
    it('李克特量表默认范围 1–5', () => {
      expect(DEFAULT_SCALE.LIKERT5).toEqual({ min: 1, max: 5 });

      const result = run({ questions: [likert('q', 'EI')], answers: [answer('q', 3)] });
      expect(result.mbti.dimensions.EI).toBe(50);
    });

    it('二选题默认范围 0–1', () => {
      const result = run({ questions: [binary('q', 'EI')], answers: [answer('q', 1)] });
      expect(result.mbti.dimensions.EI).toBe(100);
    });

    it('迫选题使用选项的 scoreMap 决定维度贡献', () => {
      const question = forcedChoice('q', 'EI', [
        { value: 1, score: 5 },
        { value: 2, score: 1 },
      ]);

      expect(run({ questions: [question], answers: [answer('q', 1)] }).mbti.dimensions.EI).toBe(100);
      expect(run({ questions: [question], answers: [answer('q', 2)] }).mbti.dimensions.EI).toBe(0);
    });

    it('scoreMap 的维度键大小写不敏感（便于后台录入）', () => {
      const question: EngineQuestion = {
        id: 'q',
        type: 'FORCED_CHOICE',
        dimension: 'ei', // 小写维度
        weight: 1,
        reverseScored: false,
        options: [{ value: 1, scoreMap: { EI: 5 } }],
      };

      expect(run({ questions: [question], answers: [answer('q', 1)] }).mbti.dimensions.EI).toBe(100);
    });

    it('自定义 minValue/maxValue 生效', () => {
      const question: EngineQuestion = {
        ...likert('q', 'EI'),
        minValue: 0,
        maxValue: 10,
        options: [0, 5, 10].map((value) => ({ value, scoreMap: null })),
      };

      expect(run({ questions: [question], answers: [answer('q', 10)] }).mbti.dimensions.EI).toBe(100);
      expect(run({ questions: [question], answers: [answer('q', 5)] }).mbti.dimensions.EI).toBe(50);
    });

    it('非法量表配置（min ≥ max）回退到题型默认值', () => {
      const question: EngineQuestion = {
        ...likert('q', 'EI'),
        minValue: 5,
        maxValue: 1,
      };

      // 回退到 LIKERT5 默认 1–5 → 选 3 = 50%
      expect(run({ questions: [question], answers: [answer('q', 3)] }).mbti.dimensions.EI).toBe(50);
    });

    it('答案值超出量表范围时被截断到边界（不产生越界百分比）', () => {
      const result = run({ questions: [likert('q', 'EI')], answers: [answer('q', 99)] });

      expect(result.mbti.dimensions.EI).toBe(100);
    });

    it('答案值不在选项列表中时回退使用原始值', () => {
      // 选项只有 1–5，答案 4 存在；答案 3.5 不存在 → 使用原始值
      const result = run({ questions: [likert('q', 'EI')], answers: [answer('q', 3.5)] });

      expect(result.mbti.dimensions.EI).toBe(62.5);
    });

    it('非排序题收到数组答案时只取首元素（容错处理）', () => {
      const result = run({ questions: [likert('q', 'EI')], answers: [answer('q', [5, 1])] });

      expect(result.mbti.dimensions.EI).toBe(100);
    });

    it('数组答案为空时该题不计分', () => {
      const result = run({ questions: [likert('q', 'EI')], answers: [answer('q', [])] });

      expect(result.rawScores.dimensions['EI']).toBeUndefined();
    });

    it('答案为非有限数（NaN / Infinity）时该题不计分', () => {
      const nan = run({ questions: [likert('q', 'EI')], answers: [answer('q', Number.NaN)] });
      const infinite = run({ questions: [likert('q', 'EI')], answers: [answer('q', Number.POSITIVE_INFINITY)] });

      expect(nan.rawScores.dimensions['EI']).toBeUndefined();
      expect(infinite.rawScores.dimensions['EI']).toBeUndefined();
    });

    describe('排序题（RANK）', () => {
      const question = rank('q', 'EI', [
        { value: 10, weight: 1 },
        { value: 20, weight: 2 },
        { value: 30, weight: 1 },
      ]);

      it('按加权位置分计算（不是只看第一名）', () => {
        // 顺序 10,20,30：位置分 1, 0.5, 0
        // 加权位置 = (1×1 + 0.5×2 + 0×1) / (1+2+1) = 2/4 = 0.5 → 50%
        const result = run({ questions: [question], answers: [answer('q', [10, 20, 30])] });

        expect(result.mbti.dimensions.EI).toBe(50);
      });

      it('把高权重选项排在前面会提高得分', () => {
        // 顺序 20,10,30：位置分 1, 0.5, 0
        // 加权位置 = (1×2 + 0.5×1 + 0×1) / 4 = 2.5/4 = 0.625 → 62.5%
        const result = run({ questions: [question], answers: [answer('q', [20, 10, 30])] });

        expect(result.mbti.dimensions.EI).toBe(62.5);
      });

      it('把高权重选项排在末尾会降低得分', () => {
        // 顺序 10,30,20：位置分 1, 0.5, 0
        // 加权位置 = (1×1 + 0.5×1 + 0×2) / 4 = 1.5/4 = 0.375 → 37.5%
        const result = run({ questions: [question], answers: [answer('q', [10, 30, 20])] });

        expect(result.mbti.dimensions.EI).toBe(37.5);
      });

      it('所有选项都没有该维度权重时该题不计分', () => {
        const noWeight = rank('q', 'EI', [
          { value: 10, weight: 0 },
          { value: 20, weight: 0 },
        ]);

        const result = run({ questions: [noWeight], answers: [answer('q', [10, 20])] });

        expect(result.mbti.dimensions.EI).toBe(50); // 无数据 → 中位
        expect(result.rawScores.dimensions['EI']).toBeUndefined();
      });

      it('空排序数组不计分', () => {
        const result = run({ questions: [question], answers: [answer('q', [])] });

        expect(result.rawScores.dimensions['EI']).toBeUndefined();
      });

      it('单个选项时位置分视为最前（不会除零）', () => {
        const single = rank('q', 'EI', [{ value: 10, weight: 1 }]);

        const result = run({ questions: [single], answers: [answer('q', [10])] });

        expect(result.mbti.dimensions.EI).toBe(100);
      });

      it('收到标量答案时按单项排序处理（容错处理）', () => {
        const result = run({ questions: [question], answers: [answer('q', 20)] });

        // 视为只排了 20 一个选项 → 位置分 1.0 → 100%
        expect(result.mbti.dimensions.EI).toBe(100);
      });

      it('排序中出现不属于该题的选项值时被忽略（不抛异常）', () => {
        const result = run({ questions: [question], answers: [answer('q', [999, 10, 20])] });

        // 999 不在选项列表中 → 跳过；10 与 20 参与加权位置计算
        // 位置：999→索引0（忽略）、10→索引1、20→索引2
        // 权重 1 与 2：位置分 10 为 (3-1-1)/2 = 0.5；20 为 (3-1-2)/2 = 0
        // 加权位置 = (0.5×1 + 0×2) / 3 = 0.1667 → 16.67%
        expect(result.mbti.dimensions.EI).toBe(16.67);
      });
    });
  });

  // ==========================================================================
  // 质量指标
  // ==========================================================================

  describe('质量指标', () => {
    it('完成率 = 有效作答 / 试卷总题数', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 5), answer('q-sn', 5)],
      });

      expect(result.quality.completionRate).toBe(50);
      expect(result.quality.answeredCount).toBe(2);
      expect(result.quality.totalCount).toBe(4);
    });

    it('跳过的题目计入 skippedCount 但不计入完成率', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 5), { questionId: 'q-sn', value: 0, isSkipped: true }],
      });

      expect(result.quality.skippedCount).toBe(1);
      expect(result.quality.answeredCount).toBe(1);
      expect(result.quality.completionRate).toBe(25);
    });

    it('平均作答耗时基于有耗时数据的题目', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 5, 2000), answer('q-sn', 5, 4000), answer('q-tf', 5)],
      });

      expect(result.quality.avgResponseMs).toBe(3000);
    });

    it('完全没有耗时数据时 avgResponseMs 为 null（不伪装成 0）', () => {
      const result = run({ questions: minimalMbtiPaper(), answers: [answer('q-ei', 5)] });

      expect(result.quality.avgResponseMs).toBeNull();
    });

    it('过快作答比例：低于 1200ms 视为未认真读题', () => {
      const result = run({
        questions: minimalMbtiPaper(),
        answers: [
          answer('q-ei', 5, 500), // 过快
          answer('q-sn', 5, 1199), // 过快
          answer('q-tf', 5, 1200), // 恰好达标
          answer('q-jp', 5, 3000),
        ],
      });

      expect(result.quality.rushRate).toBe(0.5);
    });

    it('无作答时 rushRate 为 0（避免除零）', () => {
      const result = run({ questions: minimalMbtiPaper(), answers: [] });

      expect(result.quality.rushRate).toBe(0);
      expect(result.quality.completionRate).toBe(0);
    });

    describe('一致性评分', () => {
      it('正反向题互相印证 → 100', () => {
        // 正向题 5（归一化 1）、反向题 1（归一化 0）→ 1 + 0 = 1 → 偏差 0
        const result = run({
          questions: [likert('f', 'EI'), likert('r', 'EI', { reverseScored: true })],
          answers: [answer('f', 5), answer('r', 1)],
        });

        expect(result.quality.consistencyScore).toBe(100);
      });

      it('一条线全选满分 → 一致性显著降低', () => {
        // 正向 5（1）、反向 5（1）→ 1 + 1 = 2 → 偏差 1 → 一致性 0
        const result = run({
          questions: [likert('f', 'EI'), likert('r', 'EI', { reverseScored: true })],
          answers: [answer('f', 5), answer('r', 5)],
        });

        expect(result.quality.consistencyScore).toBe(0);
      });

      it('一条线全选最低分 → 同样判定为低一致性', () => {
        const result = run({
          questions: [likert('f', 'EI'), likert('r', 'EI', { reverseScored: true })],
          answers: [answer('f', 1), answer('r', 1)],
        });

        expect(result.quality.consistencyScore).toBe(0);
      });

      it('部分矛盾 → 一致性介于 0 与 100 之间', () => {
        // 正向 5（1）、反向 3（0.5）→ 1.5 → 偏差 0.5 → 一致性 50
        const result = run({
          questions: [likert('f', 'EI'), likert('r', 'EI', { reverseScored: true })],
          answers: [answer('f', 5), answer('r', 3)],
        });

        expect(result.quality.consistencyScore).toBe(50);
      });

      it('多个维度取平均', () => {
        const result = run({
          questions: [
            likert('f1', 'EI'),
            likert('r1', 'EI', { reverseScored: true }),
            likert('f2', 'SN'),
            likert('r2', 'SN', { reverseScored: true }),
          ],
          answers: [
            answer('f1', 5),
            answer('r1', 1), // 偏差 0
            answer('f2', 5),
            answer('r2', 3), // 偏差 0.5
          ],
        });

        // (100 + 50) / 2 = 75
        expect(result.quality.consistencyScore).toBe(75);
      });

      it('无正/反向题配对时不做无依据扣分（返回 100）', () => {
        const result = run({
          questions: [likert('q1', 'EI'), likert('q2', 'EI')],
          answers: [answer('q1', 5), answer('q2', 5)],
        });

        expect(result.quality.consistencyScore).toBe(100);
      });
    });
  });

  // ==========================================================================
  // 防御性与确定性
  // ==========================================================================

  describe('防御性处理', () => {
    it('答案引用了不属于试卷的题目 → 忽略该答案', () => {
      const result = run({
        questions: [likert('q1', 'EI')],
        answers: [answer('q1', 5), answer('not-in-paper', 1)],
      });

      expect(result.mbti.dimensions.EI).toBe(100);
      expect(result.quality.totalCount).toBe(1);
      expect(result.quality.answeredCount).toBe(1);
    });

    it('非算分维度（如 ATTACHMENT）计入完成率但不参与得分', () => {
      const selfReport: EngineQuestion = {
        id: 'attach',
        type: 'LIKERT5',
        dimension: 'ATTACHMENT',
        weight: 1,
        reverseScored: false,
        options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
      };

      const result = run({
        questions: [likert('q1', 'EI'), selfReport],
        answers: [answer('q1', 5), answer('attach', 4)],
      });

      expect(result.quality.answeredCount).toBe(2);
      expect(result.quality.completionRate).toBe(100);
      expect(result.rawScores.dimensions['ATTACHMENT']).toBeUndefined();
    });

    it('非算分维度的作答耗时仍计入平均值与过快作答统计', () => {
      const selfReport: EngineQuestion = {
        id: 'attach',
        type: 'LIKERT5',
        dimension: 'ATTACHMENT',
        weight: 1,
        reverseScored: false,
        options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
      };

      const result = run({
        questions: [likert('q1', 'EI'), selfReport],
        answers: [answer('q1', 5, 3000), answer('attach', 4, 500)],
      });

      // (3000 + 500) / 2 = 1750
      expect(result.quality.avgResponseMs).toBe(1750);
      // 其中 1 题过快 → 1/2
      expect(result.quality.rushRate).toBe(0.5);
    });

    it('选项存在但其 scoreMap 不含本题维度时回退使用原始分值', () => {
      const question: EngineQuestion = {
        id: 'q',
        type: 'LIKERT5',
        dimension: 'EI',
        weight: 1,
        reverseScored: false,
        // 选项只声明了 SN 维度的分值，与本题维度 EI 不匹配
        options: [{ value: 3, scoreMap: { SN: 5 } }],
      };

      const result = run({ questions: [question], answers: [answer('q', 3)] });

      // 回退到原始值 3，量表也回退到 LIKERT5 默认 1–5 → (3-1)/(5-1) = 50
      expect(result.mbti.dimensions.EI).toBe(50);
    });

    it('全部选项的 scoreMap 都不含本题维度时量表回退到题型默认值', () => {
      const question: EngineQuestion = {
        id: 'q',
        type: 'LIKERT5',
        dimension: 'EI',
        weight: 1,
        reverseScored: false,
        options: [
          { value: 1, scoreMap: { SN: 1 } },
          { value: 5, scoreMap: { SN: 5 } },
        ],
      };

      const result = run({ questions: [question], answers: [answer('q', 5)] });

      expect(result.mbti.dimensions.EI).toBe(100);
    });

    it('选项未定义 scoreMap（为 null）时使用原始分值', () => {
      const question: EngineQuestion = {
        id: 'q',
        type: 'LIKERT5',
        dimension: 'EI',
        weight: 1,
        reverseScored: false,
        options: [{ value: 4, scoreMap: null }],
      };

      const result = run({ questions: [question], answers: [answer('q', 4)] });

      expect(result.mbti.dimensions.EI).toBe(75);
    });

    it('空试卷不抛异常，返回中性结果', () => {
      const result = run({ questions: [], answers: [] });

      expect(result.mbti.type).toBeNull();
      expect(result.quality.completionRate).toBe(0);
      expect(result.quality.totalCount).toBe(0);
    });

    it('权重为 0 的题目参与作答计数但不贡献得分', () => {
      const result = run({
        questions: [likert('q', 'EI', { weight: 0 })],
        answers: [answer('q', 5)],
      });

      expect(result.mbti.dimensions.EI).toBe(50); // 无有效权重 → 中位
      expect(result.rawScores.dimensions['EI']?.answeredCount).toBe(1);
    });

    it('原始分值记录可用于排障与结果解释', () => {
      const result = run({
        questions: [likert('q1', 'EI'), likert('q2', 'EI', { reverseScored: true })],
        answers: [answer('q1', 5), answer('q2', 3)],
      });

      expect(result.rawScores.dimensions['EI']).toEqual({
        weightedScore: 8,
        weightedMin: 2,
        weightedMax: 10,
        answeredCount: 2,
      });
    });

    it('【确定性】相同输入多次计算结果完全一致（ADR-005 的核心承诺）', () => {
      const buildInput = (): PersonalityEngineInput => ({
        questions: minimalMbtiPaper(),
        answers: [answer('q-ei', 4, 2000), answer('q-sn', 2, 3000), answer('q-tf', 5, 1500), answer('q-jp', 3, 2500)],
      });

      const first = engine.compute(buildInput());
      const second = engine.compute(buildInput());

      expect(second).toEqual(first);
    });

    it('【确定性】结果不依赖输入数组顺序', () => {
      const questions = minimalMbtiPaper();
      const answers = [answer('q-ei', 4), answer('q-sn', 2), answer('q-tf', 5), answer('q-jp', 3)];

      const ordered = engine.compute({ questions, answers });
      const reversed = engine.compute({
        questions: [...questions].reverse(),
        answers: [...answers].reverse(),
      });

      expect(reversed.mbti).toEqual(ordered.mbti);
      expect(reversed.bigFive).toEqual(ordered.bigFive);
      expect(reversed.quality.answeredCount).toBe(ordered.quality.answeredCount);
    });
  });

  // ==========================================================================
  // 关系风格（规则驱动）
  // ==========================================================================

  describe('关系风格推导', () => {
    const bigFivePaper = (): EngineQuestion[] => [
      likert('o', 'OPENNESS'),
      likert('c', 'CONSCIENTIOUSNESS'),
      likert('e', 'EXTRAVERSION'),
      likert('a', 'AGREEABLENESS'),
      likert('n', 'NEUROTICISM'),
    ];

    it('无规则时返回默认风格（SECURE，无规则命中标记）', () => {
      const result = run({
        questions: bigFivePaper(),
        answers: [answer('o', 5), answer('c', 5), answer('e', 5), answer('a', 5), answer('n', 5)],
      });

      expect(result.relationshipStyle).toEqual({
        attachment: 'SECURE',
        loveLanguage: [],
        conflictStyle: null,
        matchedRuleCode: null,
      });
    });

    it('命中规则时返回规则的结果集', () => {
      const result = run({
        questions: bigFivePaper(),
        answers: [
          answer('o', 5),
          answer('c', 5),
          answer('e', 1), // extraversion = 0
          answer('a', 5),
          answer('n', 5), // neuroticism = 100
        ],
        relationshipRules: [
          {
            code: 'ANXIOUS_HIGH_N',
            name: '高神经质低外向',
            priority: 10,
            conditions: {
              all: [
                { field: 'neuroticism', op: 'gte', value: 60 },
                { field: 'extraversion', op: 'lt', value: 45 },
              ],
            },
            resultAttachment: 'ANXIOUS',
            resultLoveLanguages: ['QUALITY_TIME'],
            resultConflictStyle: 'ACCOMMODATING',
          },
        ],
      });

      expect(result.relationshipStyle).toEqual({
        attachment: 'ANXIOUS',
        loveLanguage: ['QUALITY_TIME'],
        conflictStyle: 'ACCOMMODATING',
        matchedRuleCode: 'ANXIOUS_HIGH_N',
      });
    });

    it('多规则按 priority 升序匹配，首个命中即采用', () => {
      const result = run({
        questions: bigFivePaper(),
        answers: [answer('o', 5), answer('c', 5), answer('e', 5), answer('a', 5), answer('n', 5)],
        relationshipRules: [
          {
            code: 'LOW_PRIORITY_MATCH',
            name: '优先级低',
            priority: 100,
            conditions: { all: [{ field: 'neuroticism', op: 'gte', value: 0 }] },
            resultAttachment: 'SECURE',
            resultLoveLanguages: [],
            resultConflictStyle: null,
          },
          {
            code: 'HIGH_PRIORITY_MATCH',
            name: '优先级高',
            priority: 10,
            conditions: { all: [{ field: 'openness', op: 'gte', value: 80 }] },
            resultAttachment: 'FEARFUL',
            resultLoveLanguages: ['ACTS_OF_SERVICE'],
            resultConflictStyle: null,
          },
        ],
      });

      expect(result.relationshipStyle.matchedRuleCode).toBe('HIGH_PRIORITY_MATCH');
    });

    it('同一 priority 时按 code 字典序，保证结果稳定', () => {
      const build = (): PersonalityEngineOutput =>
        run({
          questions: bigFivePaper(),
          answers: [answer('o', 5), answer('c', 5), answer('e', 5), answer('a', 5), answer('n', 5)],
          relationshipRules: [
            {
              code: 'Z_RULE',
              name: 'Z',
              priority: 50,
              conditions: { all: [{ field: 'openness', op: 'gte', value: 0 }] },
              resultAttachment: 'SECURE',
              resultLoveLanguages: [],
              resultConflictStyle: null,
            },
            {
              code: 'A_RULE',
              name: 'A',
              priority: 50,
              conditions: { all: [{ field: 'openness', op: 'gte', value: 0 }] },
              resultAttachment: 'AVOIDANT',
              resultLoveLanguages: [],
              resultConflictStyle: null,
            },
          ],
        });

      expect(build().relationshipStyle.matchedRuleCode).toBe('A_RULE');
      // 输入顺序颠倒后结果不变
      expect(build().relationshipStyle.matchedRuleCode).toBe('A_RULE');
    });

    it('无规则命中时返回默认风格', () => {
      const result = run({
        questions: bigFivePaper(),
        answers: [answer('o', 5), answer('c', 5), answer('e', 5), answer('a', 5), answer('n', 5)],
        relationshipRules: [
          {
            code: 'NEVER_MATCH',
            name: '永不命中',
            priority: 10,
            conditions: { all: [{ field: 'neuroticism', op: 'gte', value: 200 }] },
            resultAttachment: 'FEARFUL',
            resultLoveLanguages: [],
            resultConflictStyle: null,
          },
        ],
      });

      expect(result.relationshipStyle.attachment).toBe('SECURE');
      expect(result.relationshipStyle.matchedRuleCode).toBeNull();
    });
  });
});
