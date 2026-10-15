/**
 * 题库内容数据契约测试
 *
 * 为什么给「纯数据」写测试：
 *   题库是**运行期算分的地基**，但内容改动（后台批量导入、文案修订、新增题目）不会经过代码评审。
 *   若某维度只剩正向题、题量不足、或题目编码重复，问题会在**用户答题时**才暴露，
 *   且表现为「结果奇怪」而非「明确报错」，排查成本很高。
 *
 *   因此这里把题库应满足的结构约束固化下来：
 *     · 题量与维度分布
 *     · 每个维度内**正反向题并存**（否则一致性评分无法计算，会静默返回 100）
 *     · 编码唯一、维度内 order 连续
 *     · 题干质量底线（长度、无指令性措辞、无重复）
 */

import { BIG_FIVE_QUESTIONS, MBTI_QUESTIONS, MENTAL_HEALTH_QUESTIONS } from './index';
import type { SeedDimension, SeedQuestion } from '../types';

/**
 * ⚠ 情感模块（`EMOTION_LITE`）**不在这份契约里**
 *
 * 它已从李克特量表改成沉浸式场景题（ADR-039），题库是
 * `questions.emotion-scenarios.*`，结构完全不同（分值挂在选项上、没有正反向题、
 * 每场景 3 个做法），因此约束写在 `questions.emotion-scenarios.spec.ts` 里。
 * 原 52 题量表题库已退役并从 seed 删除（历史作答仍在库里，可追溯）。
 */

/** 期望的题量与反向题数（与 seed 内容约定一致） */
const EXPECTED_MBTI: Array<{ dimension: SeedDimension; total: number; reverse: number }> = [
  { dimension: 'EI', total: 8, reverse: 3 },
  { dimension: 'SN', total: 8, reverse: 3 },
  { dimension: 'TF', total: 8, reverse: 3 },
  { dimension: 'JP', total: 8, reverse: 3 },
];

const EXPECTED_BIG_FIVE: Array<{ dimension: SeedDimension; total: number; reverse: number }> = [
  { dimension: 'OPENNESS', total: 10, reverse: 3 },
  { dimension: 'CONSCIENTIOUSNESS', total: 10, reverse: 3 },
  { dimension: 'EXTRAVERSION', total: 10, reverse: 3 },
  { dimension: 'AGREEABLENESS', total: 10, reverse: 3 },
  { dimension: 'NEUROTICISM', total: 10, reverse: 3 },
];

const ALL_QUESTIONS: SeedQuestion[] = [...MBTI_QUESTIONS, ...BIG_FIVE_QUESTIONS, ...MENTAL_HEALTH_QUESTIONS];

/**
 * 心理健康模块的期望题量（ADR-038 阶段 4）
 *
 * 六个维度每项 4 题（2 正 + 2 反）—— 与情感模块的"四项维度"同一取舍：
 * 每项只有 1 道反向题时，该维度的一致性评分偏脆，且满足不了下面那条
 * 「前后半区都要有反向题」的守卫（题量 3 时两个半区互斥，1 道反向题数学上不可能同时在两侧）。
 */
const EXPECTED_MENTAL_HEALTH: Array<{ dimension: SeedDimension; total: number; reverse: number }> = [
  { dimension: 'MH_STRESS', total: 4, reverse: 2 },
  { dimension: 'MH_MOOD', total: 4, reverse: 2 },
  { dimension: 'MH_ANXIETY', total: 4, reverse: 2 },
  { dimension: 'MH_SLEEP', total: 4, reverse: 2 },
  { dimension: 'MH_ENERGY', total: 4, reverse: 2 },
  { dimension: 'MH_LONELINESS', total: 4, reverse: 2 },
];

describe('题库种子数据契约', () => {
  it('MBTI 题量为 32 道', () => {
    expect(MBTI_QUESTIONS).toHaveLength(32);
  });

  it('大五题量为 50 道', () => {
    expect(BIG_FIVE_QUESTIONS).toHaveLength(50);
  });

  it('心理健康题量为 24 道（六个维度各 4 题）', () => {
    expect(MENTAL_HEALTH_QUESTIONS).toHaveLength(24);
  });

  it.each(EXPECTED_MENTAL_HEALTH)(
    '心理健康维度 $dimension：$total 题、$reverse 道反向题',
    ({ dimension, total, reverse }) => {
      const items = MENTAL_HEALTH_QUESTIONS.filter((question) => question.dimension === dimension);

      expect(items).toHaveLength(total);
      expect(items.filter((question) => question.reverseScored)).toHaveLength(reverse);
    },
  );

  it('心理健康题库只含本模块的六个维度（各模块白名单互不重叠）', () => {
    const otherDimensions = [
      ...MBTI_QUESTIONS.map((question) => question.dimension),
      ...BIG_FIVE_QUESTIONS.map((question) => question.dimension),
    ];

    for (const question of MENTAL_HEALTH_QUESTIONS) {
      expect(otherDimensions).not.toContain(question.dimension);
    }
  });

  it('【关键】心理健康题库的题干不含临床构念（合规底线，比通用黑名单更严）', () => {
    // 通用黑名单只管"诊断/抑郁症/症状"这类**词**，而心理健康主题的风险更高：
    // 题目本身不该出现任何导向临床解读的表述（"障碍""治疗""崩溃""绝望"……）。
    // 这个模块**只做状态描述**，题目也只问近两周的体验。
    const clinical = ['障碍', '治疗', '疾病', '生病', '崩溃', '绝望', '失眠症', '躯体化'];

    for (const question of MENTAL_HEALTH_QUESTIONS) {
      for (const word of clinical) {
        expect(question.content).not.toContain(word);
      }
    }
  });

  it.each(EXPECTED_MBTI)('MBTI 维度 $dimension：$total 题、$reverse 道反向题', ({ dimension, total, reverse }) => {
    const items = MBTI_QUESTIONS.filter((question) => question.dimension === dimension);

    expect(items).toHaveLength(total);
    expect(items.filter((question) => question.reverseScored)).toHaveLength(reverse);
  });

  it.each(EXPECTED_BIG_FIVE)('大五维度 $dimension：$total 题、$reverse 道反向题', ({ dimension, total, reverse }) => {
    const items = BIG_FIVE_QUESTIONS.filter((question) => question.dimension === dimension);

    expect(items).toHaveLength(total);
    expect(items.filter((question) => question.reverseScored)).toHaveLength(reverse);
  });

  it('【一致性评分前提】每个维度都同时存在正向题与反向题', () => {
    const dimensions = new Set(ALL_QUESTIONS.map((question) => question.dimension));

    for (const dimension of dimensions) {
      const items = ALL_QUESTIONS.filter((question) => question.dimension === dimension);
      const forward = items.filter((question) => !question.reverseScored).length;
      const reverse = items.filter((question) => question.reverseScored).length;

      // 引擎的一致性评分只对「正反向题配对」的维度生效；某维度只有一种方向时会静默返回 100
      expect(forward).toBeGreaterThan(0);
      expect(reverse).toBeGreaterThan(0);
    }
  });

  it('题目编码全局唯一', () => {
    const codes = ALL_QUESTIONS.map((question) => question.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('编码格式为 Q_<维度前缀>_<三位序号>，且与维度匹配', () => {
    const prefixByDimension: Record<string, string> = {
      EI: 'Q_EI_',
      SN: 'Q_SN_',
      TF: 'Q_TF_',
      JP: 'Q_JP_',
      OPENNESS: 'Q_OP_',
      CONSCIENTIOUSNESS: 'Q_CO_',
      EXTRAVERSION: 'Q_EX_',
      AGREEABLENESS: 'Q_AG_',
      NEUROTICISM: 'Q_NE_',
      // 情感模块（ADR-038 阶段 3）
      ATTACH_ANXIETY: 'Q_AN_',
      ATTACH_AVOIDANCE: 'Q_AV_',
      LOVE_WORDS: 'Q_LW_',
      LOVE_TIME: 'Q_LT_',
      LOVE_GIFTS: 'Q_LG_',
      LOVE_SERVICE: 'Q_LS_',
      LOVE_TOUCH: 'Q_LO_',
      CONFLICT_COLLABORATING: 'Q_CB_',
      CONFLICT_COMPROMISING: 'Q_CM_',
      CONFLICT_ACCOMMODATING: 'Q_CD_',
      CONFLICT_AVOIDING: 'Q_CA_',
      CONFLICT_COMPETING: 'Q_CC_',
      // 心理健康模块（ADR-038 阶段 4）
      //
      // ⚠ 这六条必须与题库文件里的前缀**逐字一致**：spec 的既有守卫在缺映射时
      // 直接 `throw new Error('维度 X 没有登记编码前缀')` —— 那是"新增了维度但忘了
      // 登记前缀"的结构性错误，早失败比静默放行好
      MH_STRESS: 'Q_MS_',
      MH_MOOD: 'Q_MM_',
      MH_ANXIETY: 'Q_MX_',
      MH_SLEEP: 'Q_MZ_',
      MH_ENERGY: 'Q_ME_',
      MH_LONELINESS: 'Q_MU_',
    };

    for (const question of ALL_QUESTIONS) {
      const prefix = prefixByDimension[question.dimension];

      // 显式守卫而不是断言：维度前缀缺失说明「新增了维度但忘了登记前缀」，
      // 这本身就是需要立刻失败的结构性错误（用 toBeDefined 无法让 TS 收窄类型）
      if (prefix === undefined) {
        throw new Error(`维度 ${question.dimension} 没有登记编码前缀`);
      }

      expect(question.code.startsWith(prefix)).toBe(true);
      expect(question.code.slice(prefix.length)).toMatch(/^\d{3}$/);
    }
  });

  it('每个维度内 order 从 0 连续递增且无重复', () => {
    const dimensions = new Set(ALL_QUESTIONS.map((question) => question.dimension));

    for (const dimension of dimensions) {
      const orders = ALL_QUESTIONS.filter((question) => question.dimension === dimension)
        .map((question) => question.order)
        .sort((a, b) => a - b);

      expect(orders).toEqual(Array.from({ length: orders.length }, (_, index) => index));
    }
  });

  it('题干长度在 8–40 个字符之间（过短无法构成有效题目）', () => {
    for (const question of ALL_QUESTIONS) {
      expect(question.content.length).toBeGreaterThanOrEqual(8);
      expect(question.content.length).toBeLessThanOrEqual(40);
    }
  });

  it('题干不含指令性措辞与疑问句（李克特量表要求陈述句）', () => {
    const forbidden = ['你是否', '请选择', '请判断', '你觉得吗'];

    for (const question of ALL_QUESTIONS) {
      for (const phrase of forbidden) {
        expect(question.content).not.toContain(phrase);
      }
      expect(question.content).not.toContain('？');
      expect(question.content).not.toContain('?');
    }
  });

  it('题干不重复', () => {
    const contents = ALL_QUESTIONS.map((question) => question.content);

    expect(new Set(contents).size).toBe(contents.length);
  });

  it('每题都带 1–3 个标签', () => {
    for (const question of ALL_QUESTIONS) {
      expect(question.tags.length).toBeGreaterThanOrEqual(1);
      expect(question.tags.length).toBeLessThanOrEqual(3);
    }
  });

  it('题目不涉及疾病、诊断与创伤等敏感内容（合规底线）', () => {
    const sensitive = ['诊断', '抑郁症', '焦虑症', '创伤', '自残', '自杀', '用药', '症状'];

    for (const question of ALL_QUESTIONS) {
      for (const word of sensitive) {
        expect(question.content).not.toContain(word);
      }
    }
  });

  it('未设置非默认权重（权重偏差会干扰理论上下界的累加）', () => {
    for (const question of ALL_QUESTIONS) {
      expect(question.weight === undefined || question.weight === 1).toBe(true);
    }
  });

  it('反向题不成块聚集，且两个半区都有分布（避免受测者识别反向题区段）', () => {
    // 真正的风险是「反向题成块出现」让受测者识别出规律后改变作答策略；
    // 单看「最后一道是不是反向题」并没有意义（末位恰好是反向题本身无害）。
    const dimensions = new Set(ALL_QUESTIONS.map((question) => question.dimension));

    for (const dimension of dimensions) {
      const flags = ALL_QUESTIONS.filter((question) => question.dimension === dimension)
        .sort((a, b) => a.order - b.order)
        .map((question) => question.reverseScored);

      // 不允许连续两道反向题
      for (let index = 1; index < flags.length; index += 1) {
        expect(flags[index] === true && flags[index - 1] === true).toBe(false);
      }

      // 前后半区都应有反向题（否则形成可识别的区段）
      const half = Math.floor(flags.length / 2);
      const firstHalf = flags.slice(0, half).filter(Boolean).length;
      const secondHalf = flags.slice(half).filter(Boolean).length;

      expect(firstHalf).toBeGreaterThan(0);
      expect(secondHalf).toBeGreaterThan(0);
    }
  });
});
