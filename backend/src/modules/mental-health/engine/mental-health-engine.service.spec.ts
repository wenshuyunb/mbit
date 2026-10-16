/**
 * 心理健康引擎测试（ADR-038 阶段 4）
 *
 * ## 这个引擎与另两个引擎的测试重点不同
 *
 * 人格与情感引擎的测试重点是"分数算得对不对"。
 * 本模块的重点是**文案的合规边界** —— 它的产品定位不是"测出什么"，
 * 而是"只说结论、不给建议、不做诊断"。因此这里有两组别的模块没有的断言：
 *
 *   1. **禁用词扫描**：遍历全部档位组合生成的结论文本，
 *      确认不出现"建议""你可以试试""就医""诊断""症状"等词；
 *   2. **方向一致性**：六个维度都必须是"越高越值得留意" ——
 *      混进一个反向维度会让整体聚合**静默反向**，而文案读起来完全通顺。
 */

import { FORBIDDEN_CONCLUSION_PHRASES, MentalHealthEngine } from './mental-health-engine.service';
import {
  DEFAULT_LEVEL_THRESHOLDS,
  MENTAL_HEALTH_DIMENSIONS,
  MENTAL_HEALTH_ENGINE_VERSION,
  type MentalHealthDimension,
  type MentalHealthDimensionResult,
} from './mental-health-engine.types';
import type { EngineAnswer, EngineQuestion } from '../../../common/engine/assessment.types';

const engine = new MentalHealthEngine();

/** 造一道 5 点李克特题 */
const likert = (id: string, dimension: string, reverseScored = false): EngineQuestion => ({
  id,
  type: 'LIKERT5',
  dimension,
  weight: 1,
  reverseScored,
  minValue: 1,
  maxValue: 5,
  options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
});

/**
 * 按"期望的归一化百分比"造题与答案
 *
 * 5 点量表的 `percent = (value − 1) / 4 × 100`，因此**只能取 0/25/50/75/100**
 * 五档。写 80 会被 `Math.round` 落到第 4 档（实际 75 分），断言就会对不上 ——
 * 这是夹具的约束，不是引擎的：真实量表能表达的也只有这五档。
 */
const build = (percents: Record<string, number>): { questions: EngineQuestion[]; answers: EngineAnswer[] } => {
  const questions: EngineQuestion[] = [];
  const answers: EngineAnswer[] = [];

  for (const [dimension, percent] of Object.entries(percents)) {
    questions.push(likert(dimension, dimension));
    answers.push({ questionId: dimension, value: Math.round(1 + (percent / 100) * 4), responseMs: 4000 });
  }

  return { questions, answers };
};

/** 六维全答、且分数各不同（便于断言高亮项） */
const ALL_DIMENSIONS = build({
  MH_STRESS: 100,
  MH_MOOD: 50,
  MH_ANXIETY: 75,
  MH_SLEEP: 25,
  MH_ENERGY: 0,
  MH_LONELINESS: 75,
});

describe('MentalHealthEngine.resolveBand（单维档位）', () => {
  const thresholds = DEFAULT_LEVEL_THRESHOLDS.band;

  it.each([
    [0, 'CALM'],
    [29, 'CALM'],
    // 边界：恰好等于上界时落到**下一档**（`<` 而不是 `<=`）——
    // 写反会让"恰好 30 分"到底算哪一档取决于实现细节
    [30, 'SLIGHT'],
    [49, 'SLIGHT'],
    [50, 'MILD'],
    [69, 'MILD'],
    [70, 'NOTABLE'],
    [100, 'NOTABLE'],
  ])('%i 分 → %s', (score, expected) => {
    expect(MentalHealthEngine.resolveBand(score, thresholds)).toBe(expected);
  });
});

describe('MentalHealthEngine.resolveOverallLevel（整体档位）', () => {
  const thresholds = DEFAULT_LEVEL_THRESHOLDS.overall;

  it.each([
    [0, 'GOOD'],
    [34, 'GOOD'],
    [35, 'MILD'],
    [54, 'MILD'],
    [55, 'NOTABLE'],
    [100, 'NOTABLE'],
  ])('%i 分 → %s', (score, expected) => {
    expect(MentalHealthEngine.resolveOverallLevel(score, thresholds)).toBe(expected);
  });

  it('只有三档（分得越细越像"分级判定"，而本模块不做判定）', () => {
    const levels = new Set(
      [0, 20, 40, 60, 80, 100].map((score) => MentalHealthEngine.resolveOverallLevel(score, thresholds)),
    );

    expect([...levels].sort()).toEqual(['GOOD', 'MILD', 'NOTABLE']);
  });

  /**
   * 单项抬高整体档位（2026-10-16 修）
   *
   * 只看均值会造出自相矛盾的结果，而且实测撞上过：用户"睡眠 100、紧张 100、
   * 其余四项 0"，均值 33.3 → 判「整体比较平稳」，而页面上同时写着"两项比较突出"。
   * 用户的原话是「看不出个所以然来」—— 结论与眼前的分数打架就是最典型的成因。
   */
  describe('单项抬高整体（结论不许与分数打架）', () => {
    const dimension = (score: number, usable = true): MentalHealthDimensionResult => ({
      score,
      band: score >= 70 ? 'NOTABLE' : score >= 50 ? 'MILD' : score >= 30 ? 'SLIGHT' : 'CALM',
      usable,
    });

    /** 造六维：把指定维度设成给定分数，其余给 `rest` */
    const withDimensions = (scores: Record<string, number>, rest = 0): Record<string, MentalHealthDimensionResult> =>
      Object.fromEntries(
        ['MH_STRESS', 'MH_MOOD', 'MH_ANXIETY', 'MH_SLEEP', 'MH_ENERGY', 'MH_LONELINESS'].map((key) => [
          key,
          dimension(scores[key] ?? rest),
        ]),
      );

    it('均值低但有一项 ≥70 → 至少 MILD（不许说"整体平稳"）', () => {
      const dimensions = withDimensions({ MH_SLEEP: 72 });

      // 均值 (72 + 0×5) / 6 = 12 → 按均值是 GOOD
      expect(MentalHealthEngine.resolveOverallLevel(12, thresholds, dimensions, Object.keys(dimensions))).toBe('MILD');
    });

    it('两项 ≥70 → NOTABLE（这正是用户实测的那个画像）', () => {
      const dimensions = withDimensions({ MH_ANXIETY: 100, MH_SLEEP: 100 });

      expect(MentalHealthEngine.resolveOverallLevel(33.33, thresholds, dimensions, Object.keys(dimensions))).toBe(
        'NOTABLE',
      );
    });

    it('只有一项但极高（≥85）→ 也抬到 NOTABLE', () => {
      const dimensions = withDimensions({ MH_MOOD: 90 });

      expect(MentalHealthEngine.resolveOverallLevel(15, thresholds, dimensions, Object.keys(dimensions))).toBe(
        'NOTABLE',
      );
    });

    it('均值本身更高时不降级（抬高是单向的）', () => {
      const dimensions = withDimensions({ MH_SLEEP: 72 });

      expect(MentalHealthEngine.resolveOverallLevel(80, thresholds, dimensions, Object.keys(dimensions))).toBe(
        'NOTABLE',
      );
    });

    it('不传维度信息时退回纯均值（向后兼容）', () => {
      expect(MentalHealthEngine.resolveOverallLevel(20, thresholds)).toBe('GOOD');
    });

    it('`usable: false` 的占位分不抬高整体（没有数据就不该影响结论）', () => {
      const dimensions = withDimensions({ MH_SLEEP: 90 });
      dimensions['MH_SLEEP'] = dimension(90, false);

      expect(MentalHealthEngine.resolveOverallLevel(15, thresholds, dimensions, Object.keys(dimensions))).toBe('GOOD');
    });
  });
});

describe('MentalHealthEngine.compute（完整作答）', () => {
  const output = engine.compute(ALL_DIMENSIONS);

  it('引擎版本随结果返回', () => {
    expect(output.engineVersion).toBe(MENTAL_HEALTH_ENGINE_VERSION);
  });

  it('【关键】六个维度都有结果且方向一致（越高越值得留意）', () => {
    for (const dimension of MENTAL_HEALTH_DIMENSIONS) {
      const result = output.dimensions[dimension];

      expect(result.usable).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }

    // 方向一致性的直接体现：填 100 的那一项必须比填 0 的那一项分数高。
    // 若有人把某个维度写成"越高越好"，这条会红
    expect(output.dimensions.MH_STRESS.score).toBeGreaterThan(output.dimensions.MH_ENERGY.score);
  });

  it('整体分是**有数据维度**的均值', () => {
    const expected = (100 + 50 + 75 + 25 + 0 + 75) / 6;

    expect(output.overallScore).toBeCloseTo(expected, 1);
  });

  it('高亮项取分数最高的两项，并列时按维度定义顺序', () => {
    // 100（压力）> 75（不安、缺支持并列）→ 高亮两项应为「压力感受 + 紧张不安」
    expect(output.highlightedDimensions).toEqual(['MH_STRESS', 'MH_ANXIETY']);
  });

  it('高亮项数量可配置', () => {
    expect(engine.compute({ ...ALL_DIMENSIONS, highlightCount: 3 }).highlightedDimensions).toHaveLength(3);
  });

  it('数据齐全时没有缺项', () => {
    expect(output.unresolved).toEqual([]);
  });

  it('【关键】相同输入两次结果完全一致（结论文本也必须可复现）', () => {
    // 这条比另两个引擎的同名断言更重要：本模块的交付物就是那段文字，
    // "每次请求现编一段话"在心理健康主题上是不可接受的
    expect(engine.compute(ALL_DIMENSIONS)).toEqual(output);
  });

  it('质量指标来自共用算法', () => {
    expect(output.quality.completionRate).toBe(100);
    expect(output.quality.answeredCount).toBe(6);
  });
});

describe('MentalHealthEngine.compute（结论的合规边界）', () => {
  /**
   * 扫描**全部档位组合**的结论文本
   *
   * 只测一两个样例是不够的：禁用词往往只在某个档位的措辞里被顺口加进去。
   * 这里把六维的五个档位组合出来（用不同的目标分数触发不同 band），
   * 覆盖"整体平稳"到"整体值得留意"的完整区间。
   */
  const bandScores = [0, 25, 50, 75, 100];

  const conclusions = new Map<string, string>();

  for (const score of bandScores) {
    const percents = Object.fromEntries(MENTAL_HEALTH_DIMENSIONS.map((dimension) => [dimension, score]));
    const output = engine.compute(build(percents));
    conclusions.set(`六维全 ${score}`, output.conclusion);
  }

  // 再加一批"某项独高"的组合，覆盖高亮项走到不同维度时的措辞
  for (const dimension of MENTAL_HEALTH_DIMENSIONS) {
    const percents = Object.fromEntries(MENTAL_HEALTH_DIMENSIONS.map((item) => [item, item === dimension ? 100 : 0]));
    const output = engine.compute(build(percents));
    conclusions.set(`仅 ${dimension} 高`, output.conclusion);
  }

  it('【关键】任何档位下都不出现建议、干预与诊断类措辞', () => {
    for (const [label, conclusion] of conclusions) {
      for (const phrase of FORBIDDEN_CONCLUSION_PHRASES) {
        expect(`${label}: ${conclusion}`).not.toContain(phrase);
      }
    }
  });

  it('【关键】禁用词表本身覆盖了产品明确排除的三类说法', () => {
    // 建议/干预/诊断各至少一个代表词 —— 将来有人"优化"措辞时，这张表是他要面对的边界。
    // 用 `includes` 而不是精确匹配：表里放的是"需要干预""需要治疗"这类**完整说法**
    // （精确匹配"干预"会漏掉"需要干预"），这里只断言每个概念都有词覆盖到
    for (const concept of ['建议', '干预', '诊断']) {
      expect(FORBIDDEN_CONCLUSION_PHRASES.some((phrase) => phrase.includes(concept))).toBe(true);
    }
  });

  it('【关键】结论文本非空且含整体判断（不能是一段没有内容的套话）', () => {
    for (const [label, conclusion] of conclusions) {
      expect(conclusion.length).toBeGreaterThan(20);
      expect(`${label}: ${conclusion}`).toMatch(/整体/);
    }
  });

  it('结论文本会点出最值得留意的维度名（用户要能对上自己的情况）', () => {
    const output = engine.compute(
      build(
        Object.fromEntries(
          MENTAL_HEALTH_DIMENSIONS.map((dimension) => [dimension, dimension === 'MH_SLEEP' ? 100 : 0]),
        ),
      ),
    );

    expect(output.conclusion).toContain('睡眠困扰');
  });

  it('全部维度平稳时，结论里不会出现"值得留意"这类负面判断', () => {
    const allCalm = engine.compute(
      build(Object.fromEntries(MENTAL_HEALTH_DIMENSIONS.map((dimension) => [dimension, 0]))),
    );

    expect(allCalm.overallLevel).toBe('GOOD');
    expect(allCalm.conclusion).toContain('整体比较平稳');
    expect(allCalm.conclusion).not.toContain('值得留意');
  });

  it('【关键】只有**一项**平稳时用单数量词，不写"这几项"', () => {
    /**
     * 这条是真实输出里发现的语病：六维中只有一项落在 CALM 时，
     * 原实现会输出「相对而言，紧张不安**这几项**比较平稳」。
     *
     * 它不会抛异常、类型检查也发现不了 —— 只能靠读真实结论文本。
     * 因此这里把单数/复数两种措辞分别钉住。
     */
    const output = engine.compute(
      build({
        MH_STRESS: 100,
        MH_MOOD: 100,
        MH_ANXIETY: 0, // 唯一平稳项
        MH_SLEEP: 100,
        MH_ENERGY: 100,
        MH_LONELINESS: 100,
      }),
    );

    expect(output.conclusion).toContain('「紧张不安」相对平稳');
    expect(output.conclusion).not.toContain('这几项');
  });

  it('两项以上平稳时用复数量词', () => {
    const output = engine.compute(
      build({
        MH_STRESS: 0,
        MH_MOOD: 0,
        MH_ANXIETY: 100,
        MH_SLEEP: 100,
        MH_ENERGY: 0,
        MH_LONELINESS: 100,
      }),
    );

    expect(output.conclusion).toContain('这几项比较平稳');
    expect(output.conclusion).toContain('压力感受');
  });

  it('六维全高时仍只陈述结论（不因为"看起来严重"就加上建议）', () => {
    const allHigh = engine.compute(
      build(Object.fromEntries(MENTAL_HEALTH_DIMENSIONS.map((dimension) => [dimension, 100]))),
    );

    expect(allHigh.overallLevel).toBe('NOTABLE');
    for (const phrase of FORBIDDEN_CONCLUSION_PHRASES) {
      expect(allHigh.conclusion).not.toContain(phrase);
    }
  });
});

describe('MentalHealthEngine.compute（数据不足）', () => {
  it('某维度一题未答 → 记入缺项、标 usable=false、且不参与整体均值', () => {
    // 只答压力（100），其余五项无题
    const output = engine.compute(build({ MH_STRESS: 100 }));

    expect(output.unresolved).toContain('情绪低落');
    expect(output.dimensions.MH_MOOD.usable).toBe(false);
    // 整体分只由有数据的维度算 —— 若把占位 50 也算进去，100 会被稀释成 58
    expect(output.overallScore).toBe(100);
  });

  it('【关键】高亮项只从有数据的维度里选（不拿占位 50 当"最值得留意"）', () => {
    const output = engine.compute(build({ MH_STRESS: 25, MH_SLEEP: 25 }));

    expect(output.highlightedDimensions.every((dimension) => output.dimensions[dimension].usable)).toBe(true);
    expect(output.highlightedDimensions).not.toContain('MH_MOOD');
  });

  it('完全空试卷：结论为空字符串，六个维度全部缺项，且不抛异常', () => {
    const output = engine.compute({ questions: [], answers: [] });

    expect(output.unresolved).toHaveLength(6);
    expect(output.conclusion).toBe('');
    expect(output.quality.completionRate).toBe(0);
  });

  it('混入别的模块的题 → 计入完成率但不参与本模块得分（模块隔离）', () => {
    const mixed = build({ MH_STRESS: 100 });
    mixed.questions.push(likert('q-EI', 'EI'));
    mixed.answers.push({ questionId: 'q-EI', value: 5, responseMs: 4000 });

    const output = engine.compute(mixed);

    expect(output.rawScores.dimensions['EI']).toBeUndefined();
    expect(output.quality.answeredCount).toBe(2);
    expect(output.overallScore).toBe(100);
  });

  it('反向题按量程翻转（不是简单的 max − value）', () => {
    const questions = [likert('MH_STRESS', 'MH_STRESS', true)];
    const answers: EngineAnswer[] = [{ questionId: 'MH_STRESS', value: 1, responseMs: 4000 }];

    const output = engine.compute({ questions, answers });

    // 反向题选 1（最不同意）→ 翻转后等价于选 5 → 压力感受 100
    expect(output.dimensions.MH_STRESS.score).toBe(100);
  });
});

describe('维度常量', () => {
  it('恰好六个维度、无重复', () => {
    expect(MENTAL_HEALTH_DIMENSIONS).toHaveLength(6);
    expect(new Set(MENTAL_HEALTH_DIMENSIONS).size).toBe(6);
  });

  it('【关键】维度名不含临床构念（合规底线）', () => {
    const clinical = ['抑郁', '焦虑症', '症状', '障碍', '创伤', '自残', '自杀'];

    for (const dimension of MENTAL_HEALTH_DIMENSIONS) {
      for (const word of clinical) {
        expect(dimension).not.toContain(word);
      }
    }
  });

  it('与人格、情感两个模块的维度不重名（三套白名单互不重叠）', () => {
    const otherDimensions = [
      'EI',
      'SN',
      'TF',
      'JP',
      'OPENNESS',
      'CONSCIENTIOUSNESS',
      'EXTRAVERSION',
      'AGREEABLENESS',
      'NEUROTICISM',
      'ATTACH_ANXIETY',
      'ATTACH_AVOIDANCE',
      'LOVE_WORDS',
      'LOVE_TIME',
      'LOVE_GIFTS',
      'LOVE_SERVICE',
      'LOVE_TOUCH',
      'CONFLICT_COLLABORATING',
      'CONFLICT_COMPROMISING',
      'CONFLICT_ACCOMMODATING',
      'CONFLICT_AVOIDING',
      'CONFLICT_COMPETING',
    ];

    for (const dimension of MENTAL_HEALTH_DIMENSIONS as readonly MentalHealthDimension[]) {
      expect(otherDimensions).not.toContain(dimension);
    }
  });
});
