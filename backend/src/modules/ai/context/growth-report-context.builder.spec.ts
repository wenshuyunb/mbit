/**
 * 成长回顾报告上下文组装测试
 *
 * 核心主张有三条，与实现里的三条硬性约束一一对应：
 *   · **确定性** —— 同一份画像序列永远产出逐字节相同的变量（ADR-005 的可复现要求），
 *     日期只来自入参 `createdAt`（不读当前时间、不做时区换算）
 *   · **不失败** —— 数据残缺时不抛错，而是给出显式占位文案，并完整列出缺项
 *   · **缺数据 ≠ 0**、**缺数据 ≠ 没有变化** —— 这两条是本文件里最贵的断言：
 *     前者守住"凭空造出 0 → 78 的假增长"，后者守住"把'五项都很稳定'这个真实结论
 *     说成'没有数据'"（那会让模型拒绝解读一个其实有结论的序列）
 */

import { renderPromptVersion } from '../prompt/prompt-renderer';
import {
  BIG_FIVE_LABELS,
  UNAVAILABLE_PLACEHOLDER,
  buildReportContext,
  type ReportContextInput,
} from './report-context.builder';
import {
  CHANGED_TRAIT_DELTA_THRESHOLD,
  buildGrowthReportContext,
  type GrowthProfileSnapshot,
  type GrowthReportContext,
  type GrowthReportContextInput,
} from './growth-report-context.builder';

/** 构造一版画像；默认全字段缺失，测试只写自己关心的字段 */
const snapshot = (overrides: Partial<GrowthProfileSnapshot> & { readonly version: number }): GrowthProfileSnapshot => ({
  createdAt: '2026-01-05T09:12:00.000Z',
  mbtiType: null,
  openness: null,
  conscientiousness: null,
  extraversion: null,
  agreeableness: null,
  neuroticism: null,
  consistencyScore: null,
  completionRate: null,
  answeredCount: null,
  questionCount: null,
  avgResponseMs: null,
  testDefinitionCode: null,
  ...overrides,
});

/**
 * 三版齐全序列：v1 INFJ → v3 ENFP
 *
 * 变化量刻意设计成"两项明显、三项基本不动"：
 *   开放性 62 → 78（+16）、神经质 55 → 40（-15）→ 超过阈值（明显变化）
 *   尽责性 +1、外向性 +2、宜人性 +1               → 低于阈值（基本稳定）
 */
const fullSeries = (): GrowthProfileSnapshot[] => [
  snapshot({
    version: 1,
    createdAt: '2026-01-05T09:12:00.000Z',
    mbtiType: 'INFJ',
    openness: 62,
    conscientiousness: 70,
    extraversion: 30,
    agreeableness: 65,
    neuroticism: 55,
    consistencyScore: 82,
    completionRate: 95,
    answeredCount: 30,
    questionCount: 32,
    avgResponseMs: 12_000,
    testDefinitionCode: 'MBTI_LITE',
  }),
  snapshot({
    version: 2,
    createdAt: '2026-03-18T21:40:00.000Z',
    mbtiType: 'INFJ',
    openness: 70,
    conscientiousness: 72,
    extraversion: 31,
    agreeableness: 66,
    neuroticism: 50,
    consistencyScore: 88,
    completionRate: 100,
    answeredCount: 32,
    questionCount: 32,
    avgResponseMs: 11_000,
    testDefinitionCode: 'MBTI_LITE',
  }),
  snapshot({
    version: 3,
    createdAt: '2026-06-20T11:05:00.000Z',
    mbtiType: 'ENFP',
    openness: 78,
    conscientiousness: 71,
    extraversion: 32,
    agreeableness: 66,
    neuroticism: 40,
    consistencyScore: 95,
    completionRate: 100,
    answeredCount: 32,
    questionCount: 32,
    avgResponseMs: 10_000,
    testDefinitionCode: 'MBTI_LITE',
  }),
];

/** 数据全缺的两版序列（模板在数据残缺时同样必须可渲染） */
const emptySeries = (): GrowthProfileSnapshot[] => [
  snapshot({ version: 1, createdAt: '' }),
  snapshot({ version: 2, createdAt: '' }),
];

const fullInput = (): GrowthReportContextInput => ({ profiles: fullSeries() });
const emptyInput = (): GrowthReportContextInput => ({ profiles: emptySeries() });

/** 除这两个变量外，数据全缺时其余变量都必须是占位文案（原因见各自的实现注释） */
const ALWAYS_DEFINED: readonly string[] = ['profileCount', 'mbtiShifted'];

const build = (profiles: readonly GrowthProfileSnapshot[]): GrowthReportContext =>
  buildGrowthReportContext({ profiles });

/** 变量 → 行数组（多行块变量的断言用） */
const linesOf = (context: GrowthReportContext, name: string): string[] => context.variables[name].split('\n');

describe('buildGrowthReportContext', () => {
  describe('完整序列（3 版）', () => {
    it('给出参与对比的版本数与时间跨度', () => {
      const { variables } = buildGrowthReportContext(fullInput());

      expect(variables['profileCount']).toBe('3');
      // 日期只做字符串切片：`2026-01-05T09:12:00.000Z` → `2026-01-05`
      expect(variables['periodText']).toBe('2026-01-05 → 2026-06-20');
    });

    it('【关键】时间线逐版一行：版本号、日期、MBTI、五维分数（顺序固定）', () => {
      const context = buildGrowthReportContext(fullInput());
      const lines = linesOf(context, 'growthTimeline');

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('v1｜2026-01-05｜INFJ｜开放性 62、尽责性 70、外向性 30、宜人性 65、神经质 55');
      expect(lines[1]).toBe('v2｜2026-03-18｜INFJ｜开放性 70、尽责性 72、外向性 31、宜人性 66、神经质 50');
      expect(lines[2]).toBe('v3｜2026-06-20｜ENFP｜开放性 78、尽责性 71、外向性 32、宜人性 66、神经质 40');

      // 五维顺序必须与 `BIG_FIVE_LABELS` 的固定顺序一致（三处变量各用一套顺序会让模型对错列）
      const order = Object.values(BIG_FIVE_LABELS);
      for (const line of lines) {
        const positions = order.map((label) => line.indexOf(label));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(positions.every((position) => position >= 0)).toBe(true);
      }
    });

    it('【关键】变化量给出"同一维度上的真实数值"前后对比', () => {
      const { variables } = buildGrowthReportContext(fullInput());

      expect(variables['scoreDeltas']).toContain('开放性 62 → 78（+16）');
      expect(variables['scoreDeltas']).toContain('神经质 55 → 40（-15）');
      expect(variables['scoreDeltas']).toContain('尽责性 70 → 71（+1）');
      // 逐维一行、顺序固定
      expect(linesOf(buildGrowthReportContext(fullInput()), 'scoreDeltas').map((line) => line.split(' ')[0])).toEqual(
        Object.values(BIG_FIVE_LABELS),
      );
    });

    it('变化最大的维度按幅度降序，并点明最大项', () => {
      const context = buildGrowthReportContext(fullInput());

      expect(linesOf(context, 'changedTraits')).toEqual([
        '开放性 62 → 78（+16，本次序列中幅度最大）',
        '神经质 55 → 40（-15）',
      ]);
      // 没有达到阈值的维度不得出现在"哪些变了"里
      expect(context.variables['changedTraits']).not.toContain('尽责性');
      expect(context.variables['changedTraits']).not.toContain('宜人性');
    });

    it('【关键】"哪些没变"同样给出（稳定同样是成长报告的关键信息）', () => {
      const { variables } = buildGrowthReportContext(fullInput());

      expect(variables['stableTraits']).toBe(
        ['尽责性 70 → 71（+1）', '外向性 30 → 32（+2）', '宜人性 65 → 66（+1）'].join('\n'),
      );
      expect(variables['stableTraits']).not.toContain('开放性');
    });

    it('【关键】变化项与稳定项互补且无重叠（阈值是含的，两者并集等于全部可比维度）', () => {
      const context = buildGrowthReportContext(fullInput());
      const changed = linesOf(context, 'changedTraits').map((line) => line.split(' ')[0]);
      const stable = linesOf(context, 'stableTraits').map((line) => line.split(' ')[0]);
      const comparable = linesOf(context, 'scoreDeltas').map((line) => line.split(' ')[0]);

      expect([...changed, ...stable].sort()).toEqual([...comparable].sort());
      expect(changed.filter((label) => stable.includes(label))).toEqual([]);
    });

    it('最新一版的类型、中文名与"类型是否变过"', () => {
      const { variables } = buildGrowthReportContext(fullInput());

      expect(variables['latestMbtiType']).toBe('ENFP');
      // 中文名取自 MBTI 百科（与单画像报告同一份文案来源）
      expect(variables['latestMbtiTypeName']).toBe('竞选者');
      expect(variables['mbtiShifted']).toBe('是');
    });

    it('最新一版的五维摘要与单画像 bigFiveSummary 同格式（便于模板换用变量）', () => {
      const { variables } = buildGrowthReportContext(fullInput());

      expect(variables['latestBigFiveSummary']).toBe(
        ['开放性 78（偏高）', '尽责性 71（偏高）', '外向性 32（偏低）', '宜人性 66（偏高）', '神经质 40（偏低）'].join(
          '；',
        ),
      );

      // 与 `report-context.builder.ts` 的产出比对：同一档位阈值、同一分隔符、同一顺序
      const singleProfile: ReportContextInput = {
        profile: {
          mbtiType: 'ENFP',
          mbtiConfidence: null,
          eiPercent: null,
          snPercent: null,
          tfPercent: null,
          jpPercent: null,
          openness: 78,
          conscientiousness: 71,
          extraversion: 32,
          agreeableness: 66,
          neuroticism: 40,
          consistencyScore: null,
          completionRate: null,
          avgResponseMs: null,
          engineVersion: null,
        },
        testDefinitionCode: 'MBTI_LITE',
        answeredCount: 32,
        questionCount: 32,
      };

      expect(variables['latestBigFiveSummary']).toBe(buildReportContext(singleProfile).variables['bigFiveSummary']);
    });

    it('数据质量说明给出各版一致性 / 完成率区间与覆盖版本数', () => {
      const context = buildGrowthReportContext(fullInput());

      expect(linesOf(context, 'dataQualityText')).toEqual([
        '作答一致性 82–95（3/3 版有数据）',
        '完成率 95–100%（3/3 版有数据）',
        '作答题数 30/32–32/32（3/3 版有数据）',
        // 与单画像报告的 `avgResponseSeconds` 同单位（秒/题），避免同一数据差 1000 倍
        '平均作答耗时 10–12 秒/题（3/3 版有数据）',
        '量表 MBTI_LITE（3/3 版有数据）',
      ]);
    });

    it('【关键】完全没有缺项', () => {
      expect(buildGrowthReportContext(fullInput()).unavailable).toEqual([]);
    });
  });

  describe('确定性', () => {
    it('【关键】同一输入重复调用产出逐字节相同的变量', () => {
      const first = buildGrowthReportContext(fullInput());
      const second = buildGrowthReportContext(fullInput());

      expect(JSON.stringify(first.variables)).toBe(JSON.stringify(second.variables));
      expect(first.unavailable).toEqual(second.unavailable);
    });

    it('【关键】变量键集合固定（模板不必知道哪些数据必有）', () => {
      const full = Object.keys(buildGrowthReportContext(fullInput()).variables).sort();
      const empty = Object.keys(buildGrowthReportContext(emptyInput()).variables).sort();

      expect(empty).toEqual(full);
      expect(full).toEqual([
        'changedTraits',
        'dataQualityText',
        'growthTimeline',
        'latestBigFiveSummary',
        'latestMbtiType',
        'latestMbtiTypeName',
        'mbtiShifted',
        'periodText',
        'profileCount',
        'scoreDeltas',
        'stableTraits',
      ]);
    });

    it('每次返回全新对象（调用方修改结果不会污染后续调用）', () => {
      const first = buildGrowthReportContext(fullInput());
      const second = buildGrowthReportContext(fullInput());

      expect(first.variables).not.toBe(second.variables);
      expect(first.unavailable).not.toBe(second.unavailable);
    });

    it('【关键】日期只来自入参 createdAt：不做时区换算、不读当前时间', () => {
      // `1999-12-31T23:59:59.000Z` 在 UTC+8 上属于 2000-01-01：
      // 任何 `new Date(...).toLocaleDateString()` / `getFullYear()` 式的实现都会把它算成次年，
      // 而那种实现会让同一份数据在不同时区的机器上产出不同的 Prompt（破坏可复现性）。
      const { variables } = build([
        snapshot({ version: 1, createdAt: '1999-12-31T23:59:59.000Z', mbtiType: 'INFJ' }),
        snapshot({ version: 2, createdAt: '2000-01-01T00:00:01.000Z', mbtiType: 'INFJ' }),
      ]);

      expect(variables['periodText']).toBe('1999-12-31 → 2000-01-01');
      expect(variables['growthTimeline']).toContain('v1｜1999-12-31');
      expect(variables['growthTimeline']).toContain('v2｜2000-01-01');
    });

    it('版本号不连号时原样使用（重算或删除历史画像会留下空档，不强行重编号）', () => {
      const context = build([
        snapshot({ version: 1, mbtiType: 'INFJ', openness: 50 }),
        snapshot({ version: 3, mbtiType: 'INFJ', openness: 62 }),
        snapshot({ version: 7, mbtiType: 'ENFP', openness: 70 }),
      ]);

      // `profileCount` 是**参与对比的版本数**，不是最大版本号
      expect(context.variables['profileCount']).toBe('3');
      expect(context.variables['growthTimeline']).toContain('v1｜');
      expect(context.variables['growthTimeline']).toContain('v3｜');
      expect(context.variables['growthTimeline']).toContain('v7｜');
      expect(context.variables['scoreDeltas']).toContain('开放性 50 → 70（+20）');
    });
  });

  describe('数据残缺', () => {
    it('【关键】不抛错，缺失项以显式占位文案呈现', () => {
      const { variables } = buildGrowthReportContext(emptyInput());

      for (const [name, value] of Object.entries(variables)) {
        if (ALWAYS_DEFINED.includes(name)) continue;

        expect({ name, value }).toEqual({ name, value: UNAVAILABLE_PLACEHOLDER });
      }
    });

    it('【关键】两个"永远是确定取值"的变量：版本数与类型是否变化', () => {
      const { variables } = buildGrowthReportContext(emptyInput());

      // 版本数即使只有 0/1 版也是确定事实（服务层契约保证 2–12 版，但 builder 不抛错）
      expect(variables['profileCount']).toBe('2');
      // 类型不可比时取「否」而不是占位：模板与用户都需要一个明确结论
      expect(variables['mbtiShifted']).toBe('否');
    });

    it('【关键】缺项清单完整（后台据此提示数据不全）', () => {
      const { unavailable } = buildGrowthReportContext(emptyInput());

      for (const name of [
        'periodText',
        'growthTimeline',
        'scoreDeltas',
        'changedTraits',
        'stableTraits',
        'latestMbtiType',
        'latestMbtiTypeName',
        'latestBigFiveSummary',
        'dataQualityText',
      ]) {
        expect(unavailable).toContain(name);
      }

      // 字段级缺项也进清单（否则后台会以为数据齐全）
      for (const name of ['openness', 'neuroticism', 'mbtiType', 'createdAt', 'consistencyScore']) {
        expect(unavailable).toContain(name);
      }
      // 全缺时"类型是否变化"是确定取值，不能被登记成缺项
      expect(unavailable).not.toContain('mbtiShifted');
      expect(unavailable).not.toContain('profileCount');
    });

    it('【关键】某一版缺某维度时跳过而不是当 0（否则会造出"从 0 涨到 78"的假增长）', () => {
      const series = fullSeries();
      const broken = build([series[0], { ...series[1], openness: null }, series[2]]);

      // 仍然用两端**真实存在**的数值做对比，并把两端锚定到具体版本
      expect(broken.variables['scoreDeltas']).toContain('开放性 62（v1） → 78（v3）（+16）');
      // 绝不能出现 0 起点
      expect(broken.variables['scoreDeltas']).not.toContain(' 0 →');
      expect(broken.variables['scoreDeltas']).not.toContain('0（v1）');
      // 缺数据的那一版在时间线上留占位（不是留空、也不是 0）
      expect(broken.variables['growthTimeline']).toContain('v2｜2026-03-18｜INFJ｜开放性 （本次测评未包含此项）');
      // 部分缺失要进缺项清单：这一维的对比跨度不完整
      expect(broken.unavailable).toContain('openness');
      // 其余维度每版都有值 → 不标注版本号，保持简洁形态
      expect(broken.variables['scoreDeltas']).toContain('尽责性 70 → 71（+1）');
    });

    it('某维度只有一版有值时明确写"无法比较"，不产出任何看似有变化的数字', () => {
      const series = fullSeries();
      const context = build([series[0], { ...series[1], openness: null }, { ...series[2], openness: null }]);

      expect(context.variables['scoreDeltas']).toContain('开放性 无法比较');
      expect(context.variables['scoreDeltas']).not.toContain('开放性 62 →');
      expect(context.variables['changedTraits']).not.toContain('开放性');
      expect(context.variables['stableTraits']).not.toContain('开放性');
      // 其余四维仍然可比 → scoreDeltas 整体不是占位文案
      expect(context.variables['scoreDeltas']).not.toBe(UNAVAILABLE_PLACEHOLDER);
      expect(context.unavailable).toContain('openness');
      expect(context.unavailable).not.toContain('scoreDeltas');
    });

    it('【关键】"结果为空"不等于"缺数据"：五维都有值但都没动时，明确写出结论而不是占位', () => {
      const base = fullSeries()[0];
      const context = build([base, { ...base, version: 2 }]);

      expect(context.variables['changedTraits']).toBe(
        `本次序列中的 5 个可比维度都没有达到变化阈值（|Δ| ≥ ${CHANGED_TRAIT_DELTA_THRESHOLD} 分），即没有任何维度发生明显变化`,
      );
      expect(context.variables['stableTraits']).not.toBe(UNAVAILABLE_PLACEHOLDER);
      expect(linesOf(context, 'stableTraits')).toHaveLength(5);
      // 这是"有结论"，不是"缺数据"：不得进缺项清单
      expect(context.unavailable).not.toContain('changedTraits');
      expect(context.unavailable).not.toContain('stableTraits');
    });

    it('【关键】五维全都明显变化时，稳定项写"没有可视为稳定的维度"而不是占位', () => {
      const context = build([
        snapshot({
          version: 1,
          mbtiType: 'INFJ',
          openness: 30,
          conscientiousness: 30,
          extraversion: 30,
          agreeableness: 30,
          neuroticism: 30,
        }),
        snapshot({
          version: 2,
          mbtiType: 'INFJ',
          openness: 60,
          conscientiousness: 60,
          extraversion: 60,
          agreeableness: 60,
          neuroticism: 60,
        }),
      ]);

      expect(context.variables['stableTraits']).toContain('没有可视为稳定的维度');
      expect(context.unavailable).not.toContain('stableTraits');
      // 幅度相同 → 打平后回落到固定维度顺序，第一项（开放性）被标为幅度最大
      expect(linesOf(context, 'changedTraits')[0]).toBe('开放性 30 → 60（+30，本次序列中幅度最大）');
      expect(linesOf(context, 'changedTraits')).toHaveLength(5);
    });

    it('少于 2 版时不做任何"对比"变量（成长报告没有对比就等于没有内容）', () => {
      const only = fullSeries()[0];
      const context = build([only]);

      expect(context.variables['profileCount']).toBe('1');
      for (const name of ['periodText', 'scoreDeltas', 'changedTraits', 'stableTraits']) {
        expect(context.variables[name]).toBe(UNAVAILABLE_PLACEHOLDER);
        expect(context.unavailable).toContain(name);
      }

      // 但"最新一版"的事实仍然给全（这一版确实是用户当前的样子）
      expect(context.variables['latestMbtiType']).toBe('INFJ');
      expect(context.variables['latestBigFiveSummary']).toContain('开放性 62');
      expect(context.variables['growthTimeline']).toContain('v1｜2026-01-05');
      expect(context.variables['dataQualityText']).toContain('作答一致性 82（1/1 版有数据）');
    });

    it('空序列不抛错（服务层本不该这样调用，但 builder 必须能扛住）', () => {
      const context = build([]);

      expect(context.variables['profileCount']).toBe('0');
      expect(context.variables['mbtiShifted']).toBe('否');
      expect(context.variables['growthTimeline']).toBe(UNAVAILABLE_PLACEHOLDER);
      expect(context.variables['latestMbtiType']).toBe(UNAVAILABLE_PLACEHOLDER);
      expect(context.unavailable).toContain('growthTimeline');
      // 一版都没有 → 只登记变量名，不登记字段级缺项（没有"部分缺失"可言）
      for (const field of ['openness', 'createdAt', 'mbtiType', 'consistencyScore']) {
        expect(context.unavailable).not.toContain(field);
      }
    });

    it('非有限数值按缺失处理（不产出 NaN）', () => {
      const series = fullSeries();
      const context = build([series[0], { ...series[1], openness: Number.NaN }, series[2]]);

      expect(context.variables['growthTimeline']).not.toContain('NaN');
      expect(context.variables['scoreDeltas']).not.toContain('NaN');
      expect(context.unavailable).toContain('openness');
    });

    it('未知类型码时类型保留原值，中文名缺项（不猜百科内容）', () => {
      const context = build([
        snapshot({ version: 1, mbtiType: 'XXXX', openness: 50 }),
        snapshot({ version: 2, mbtiType: 'XXXX', openness: 55 }),
      ]);

      expect(context.variables['latestMbtiType']).toBe('XXXX');
      expect(context.variables['latestMbtiTypeName']).toBe(UNAVAILABLE_PLACEHOLDER);
      expect(context.unavailable).toContain('latestMbtiTypeName');
    });

    it('只有部分版本有类型时，时间线留占位且 mbtiShifted 仍取确定值「否」', () => {
      const context = build([
        snapshot({ version: 1, mbtiType: 'INFJ', openness: 50 }),
        snapshot({ version: 2, mbtiType: null, openness: 55 }),
        snapshot({ version: 3, mbtiType: 'INFJ', openness: 60 }),
      ]);

      expect(context.variables['mbtiShifted']).toBe('否');
      // 类型那一格留占位（不是留空、也不是沿用上一版的类型）
      expect(context.variables['growthTimeline']).toContain(`v2｜2026-01-05｜${UNAVAILABLE_PLACEHOLDER}｜开放性 55`);
      expect(context.unavailable).toContain('mbtiType');
    });

    it('日期不可解析时记为缺项，时间跨度用占位文案（不拿当前日期兜底）', () => {
      const context = build([
        snapshot({ version: 1, createdAt: '2026/01/05', openness: 50 }),
        snapshot({ version: 2, createdAt: '', openness: 55 }),
      ]);

      expect(context.variables['periodText']).toBe(UNAVAILABLE_PLACEHOLDER);
      expect(context.unavailable).toContain('periodText');
      expect(context.unavailable).toContain('createdAt');
      // 五维数据仍在，其他变量不受影响
      expect(context.variables['scoreDeltas']).toContain('开放性 50 → 55（+5）');
    });

    it('各版量表不同时如实说明（不同量表的分数口径可能不一致）', () => {
      const series = fullSeries();
      const context = build([series[0], series[1], { ...series[2], testDefinitionCode: 'BIG_FIVE_FULL' }]);

      expect(context.variables['dataQualityText']).toContain('量表不同：MBTI_LITE（v1、v2）；BIG_FIVE_FULL（v3）');
    });
  });

  describe('变化阈值', () => {
    /** 两版序列：指定第一个维度从 from 变到 to */
    const twoVersions = (from: number, to: number): GrowthReportContext =>
      build([
        snapshot({ version: 1, mbtiType: 'INFJ', openness: from }),
        snapshot({ version: 2, mbtiType: 'INFJ', openness: to }),
      ]);

    it(`恰好 ${CHANGED_TRAIT_DELTA_THRESHOLD} 分记为变化（阈值是含的）`, () => {
      const context = twoVersions(60, 65);

      expect(context.variables['changedTraits']).toContain('开放性 60 → 65（+5');
      expect(context.variables['stableTraits']).not.toContain('开放性');
    });

    it(`低于 ${CHANGED_TRAIT_DELTA_THRESHOLD} 分记为稳定`, () => {
      const context = twoVersions(60, 64);

      expect(context.variables['stableTraits']).toBe('开放性 60 → 64（+4）');
      expect(context.variables['changedTraits']).not.toContain('开放性');
    });

    it('下降同样按幅度判定（方向不影响是否算"变化"）', () => {
      const context = twoVersions(60, 55);

      expect(context.variables['changedTraits']).toContain('开放性 60 → 55（-5');
    });

    it('【关键】展示出来的加减必须自洽（端点取整后相减，而不是浮点数先减再取整）', () => {
      // 62.6 → 78.4 的两端显示为 63 与 78；若用原始浮点数算差值会写成 +16，用户按计算器对不上
      expect(twoVersions(62.6, 78.4).variables['scoreDeltas']).toContain('开放性 63 → 78（+15）');
      // 其余四维在这条序列里完全没数据 → 明确写"无法比较"
      expect(twoVersions(62.6, 78.4).variables['scoreDeltas']).toContain('尽责性 无法比较');
    });

    it('数值统一取整（同一分数永远同一种写法）', () => {
      const context = twoVersions(62.4, 78.5);

      expect(context.variables['scoreDeltas']).toContain('开放性 62 → 79（+17）');
    });
  });

  describe('与模板渲染的衔接', () => {
    const templateOf = (variables: Readonly<Record<string, string>>): string =>
      Object.keys(variables)
        .map((name) => `{{${name}}}`)
        .join(' | ');

    it('产出的变量可直接渲染一个引用全部字段的模板', () => {
      const { variables } = buildGrowthReportContext(fullInput());

      const rendered = renderPromptVersion(
        { systemPrompt: '你是分析师', userPromptTemplate: templateOf(variables) },
        variables,
      );

      expect(rendered.user).not.toContain('{{');
      expect(rendered.usedVariables.length).toBe(Object.keys(variables).length);
      // 多版本对比的两条核心信息确实进了 Prompt
      expect(rendered.user).toContain('v1｜2026-01-05');
      expect(rendered.user).toContain('v3｜2026-06-20');
      expect(rendered.user).toContain('开放性 62 → 78（+16）');
    });

    it('【关键】数据全缺时模板仍能渲染成功（占位文案保证了这一点）', () => {
      const { variables } = buildGrowthReportContext(emptyInput());

      const rendered = renderPromptVersion({ systemPrompt: 's', userPromptTemplate: templateOf(variables) }, variables);

      expect(rendered.user).not.toContain('{{');
      expect(rendered.user).toContain(UNAVAILABLE_PLACEHOLDER);
      // 版本数与"类型是否变过"依然给出确定取值
      expect(rendered.user).toContain('2');
      expect(rendered.user).toContain('否');
    });
  });
});
