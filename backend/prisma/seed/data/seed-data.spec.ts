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

import { BIG_FIVE_QUESTIONS, MBTI_QUESTIONS } from './index';
import type { SeedDimension, SeedQuestion } from '../types';

/**
 * ⚠ 情感模块（`EMOTION_LITE`）**不在这份契约里**
 *
 * 它已从李克特量表改成沉浸式场景题（ADR-039），题库是
 * `questions.emotion-scenarios.*`，结构完全不同（分值挂在选项上、没有正反向题、
 * 每场景 3 个做法），因此约束写在 `questions.emotion-scenarios.spec.ts` 里。
 * 原 52 题量表题库已退役并从 seed 删除（历史作答仍在库里，可追溯）。
 *
 * ⚠ 心理状态自评（`MENTAL_HEALTH_LITE`）**同样不在**（2026-10-15）
 *
 * 它已改成「这两周的一天」时间轴式情境自评（`questions.mental-health-scenes.ts`）：
 * 24 幕、四档频率选项挂 `scoreMap`、**有正反向题**、编码是 `MH_SC_01` 而不是
 * `Q_<维度前缀>_<序号>`。下面这些守卫是按"李克特陈述句"写的
 * （题干 ≤ 40 字、不含问号、维度内 order 从 0 连续……），套在情境题上会全是假红。
 * 它自己的约束在 `questions.mental-health-scenes.spec.ts`。
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

const ALL_QUESTIONS: SeedQuestion[] = [...MBTI_QUESTIONS, ...BIG_FIVE_QUESTIONS];

describe('题库种子数据契约', () => {
  it('MBTI 题量为 32 道', () => {
    expect(MBTI_QUESTIONS).toHaveLength(32);
  });

  it('大五题量为 50 道', () => {
    expect(BIG_FIVE_QUESTIONS).toHaveLength(50);
  });

  it('心理健康题库已移出本文件（改版为情境题，见 questions.mental-health-scenes.spec.ts）', () => {
    // 这条断言是**防回归**用的：新题库若被误 import 回这里，
    // 下面那些按李克特陈述句写的守卫会**大面积假红**，而假红比漏测更浪费时间
    expect(ALL_QUESTIONS.some((question) => question.code.startsWith('MH_SC_'))).toBe(false);
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
      // ⚠ 心理健康模块的六条前缀**已移除**（2026-10-15）：该模块题库改成情境题，
      // 编码不再是 `Q_<维度前缀>_<序号>`，守卫搬到了 `questions.mental-health-scenes.spec.ts`
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
