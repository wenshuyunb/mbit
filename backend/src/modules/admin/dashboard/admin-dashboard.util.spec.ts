/**
 * 看板纯逻辑单测
 *
 * 三条最关键的断言：
 *   ① **时区口径**：`7D` 的起点必须是 UTC 零点（与契约示例逐字一致）
 *   ② **漏斗无数据源阶段**：`LAUNCH` / `LOGIN` 必须为 `null` 且带 `note`，
 *      🚫 绝不能用 0 冒充「没人用」——那会让运营去排查不存在的流失
 *   ③ **方向语义**：`isLowerBetter` 指标（如单报告成本）的达标判断与展示不能反
 */

import {
  DASHBOARD_CACHE_TTL_SECONDS,
  DASHBOARD_MAX_RANGE_DAYS,
  DashboardRangeError,
  METRIC_DEFINITIONS,
  buildFunnel,
  buildMetricView,
  displayTargetOf,
  displayValueOf,
  formatCents,
  formatCount,
  formatPercent,
  formatPercentagePointChange,
  metricDefinitionOf,
  previousPeriod,
  resolveDashboardRange,
  safeRatio,
  toSafeNumber,
  trendDirection,
} from './admin-dashboard.util';

const NOW = new Date('2026-02-14T22:35:00.000Z');

describe('resolveDashboardRange（UTC 口径）', () => {
  it('7D 起点 = UTC 今天零点 − 6 天（与契约示例 2026-02-08T00:00:00.000Z 一致）', () => {
    const range = resolveDashboardRange('7D', undefined, undefined, NOW);

    expect(range.rangeStart.toISOString()).toBe('2026-02-08T00:00:00.000Z');
    expect(range.rangeEnd.toISOString()).toBe(NOW.toISOString());
  });

  it('TODAY / 30D / 90D 的窗口长度正确', () => {
    expect(resolveDashboardRange('TODAY', undefined, undefined, NOW).rangeStart.toISOString()).toBe(
      '2026-02-14T00:00:00.000Z',
    );
    expect(resolveDashboardRange('30D', undefined, undefined, NOW).rangeStart.toISOString()).toBe(
      '2026-01-16T00:00:00.000Z',
    );
    expect(resolveDashboardRange('90D', undefined, undefined, NOW).rangeStart.toISOString()).toBe(
      '2025-11-17T00:00:00.000Z',
    );
  });

  it('CUSTOM 必须同时给起止时间，且范围 ≤ 366 天', () => {
    expect(() => resolveDashboardRange('CUSTOM', '2026-02-01T00:00:00.000Z', undefined, NOW)).toThrow(
      DashboardRangeError,
    );

    expect(resolveDashboardRange('CUSTOM', '2026-02-01T00:00:00.000Z', '2026-02-14T00:00:00.000Z', NOW).key).toBe(
      'CUSTOM',
    );

    expect(DASHBOARD_MAX_RANGE_DAYS).toBe(366);
  });

  it('起止倒置被拒绝', () => {
    expect(() => resolveDashboardRange('CUSTOM', '2026-02-14T00:00:00.000Z', '2026-02-01T00:00:00.000Z', NOW)).toThrow(
      DashboardRangeError,
    );
  });
});

describe('previousPeriod', () => {
  it('紧邻的等长周期', () => {
    const current = resolveDashboardRange('7D', undefined, undefined, NOW);
    const previous = previousPeriod(current);

    expect(previous.end.getTime()).toBe(current.rangeStart.getTime());
    expect(previous.end.getTime() - previous.start.getTime()).toBe(
      current.rangeEnd.getTime() - current.rangeStart.getTime(),
    );
  });
});

describe('buildFunnel', () => {
  const counts: Record<string, number | null> = {
    LAUNCH: null,
    LOGIN: null,
    TEST_START: 14_412,
    TEST_COMPLETE: 9_860,
    REPORT_GENERATE: 8_265,
    REPORT_UNLOCK: 3_180,
    INVITE_SENT: 4_826,
    RELATIONSHIP_ACTIVE: 2_140,
    MEMBER_PURCHASE: 68,
  };

  it('无数据源的阶段为 null 且带 note，绝不用 0 冒充', () => {
    const funnel = buildFunnel(counts);
    const launch = funnel.stages.find((stage) => stage.stage === 'LAUNCH');

    expect(launch?.count).toBeNull();
    expect(launch?.rate).toBeNull();
    expect(launch?.dropOffRate).toBeNull();
    expect(launch?.note).toContain('无数据源');
  });

  it('有数据阶段的 rate 以「最近一个有数据的阶段」为基准（首阶段 = 100%）', () => {
    const funnel = buildFunnel(counts);
    const start = funnel.stages.find((stage) => stage.stage === 'TEST_START');
    const complete = funnel.stages.find((stage) => stage.stage === 'TEST_COMPLETE');

    expect(start?.rate).toBe(1);
    expect(start?.rateDisplay).toBe('100.00%');
    expect(complete?.rate).toBe(0.6842);
    expect(complete?.dropOffRate).toBe(0.3158);
  });

  it('自动识别最大流失点（规则：所有可计算转移中的最大流失率）', () => {
    const funnel = buildFunnel(counts);

    // ⚠ 契约示例把 biggestDropOff 写成 REPORT_GENERATE → REPORT_UNLOCK（0.6153），
    // 但同一份 stages 数据里 RELATIONSHIP_ACTIVE → MEMBER_PURCHASE 的流失是 0.9682，
    // 按「取最大流失」应当选中后者 —— 示例的该字段是人工结论、不可复现。
    // 本实现采用可复现规则，并已把该契约不一致列入交付简报。
    expect(funnel.biggestDropOff?.from).toBe('RELATIONSHIP_ACTIVE');
    expect(funnel.biggestDropOff?.to).toBe('MEMBER_PURCHASE');
    expect(funnel.biggestDropOff?.dropOffRate).toBe(0.9682);
    expect(funnel.biggestDropOff?.suggestion.length).toBeGreaterThan(0);
  });

  it('识别转化最好的一环：取「非负流失率」的最小值（排除下游比上游多的负流失率）', () => {
    const funnel = buildFunnel(counts);

    // REPORT_UNLOCK → INVITE_SENT 的流失率为负（未解锁用户也会发邀请），
    // 它不是「转化最好的一环」，而是漏斗定义本身的分支，因此被排除
    const inviteStep = funnel.stages.find((stage) => stage.stage === 'INVITE_SENT');
    expect(inviteStep?.dropOffRate).toBeLessThan(0);

    expect(funnel.fastestGrowth?.from).toBe('TEST_COMPLETE');
    expect(funnel.fastestGrowth?.to).toBe('REPORT_GENERATE');
    expect(funnel.fastestGrowth?.note.length).toBeGreaterThan(0);
  });

  it('全部阶段无数据时仍返回完整结构（不抛错、biggestDropOff 为 null）', () => {
    const funnel = buildFunnel({ TEST_START: null, TEST_COMPLETE: null });

    expect(funnel.stages.length).toBe(9);
    expect(funnel.biggestDropOff).toBeNull();
    expect(funnel.fastestGrowth).toBeNull();
  });
});

describe('buildMetricView', () => {
  it('百分比类指标：差值为百分点（pp），目标达标判断为「越大越好」', () => {
    const view = buildMetricView({
      definition: metricDefinitionOf('PAID_CONVERSION_RATE'),
      value: 0.0621,
      previousValue: 0.0564,
      parts: {
        numerator: { label: '付费用户数', value: 286 },
        denominator: { label: '完成测试用户数', value: 4606 },
      },
    });

    expect(view.displayValue).toBe('6.21%');
    expect(view.targetDisplay).toBe('5.00%');
    expect(view.isOnTarget).toBe(true);
    expect(view.changeDisplay).toBe('+0.57pp');
    expect(view.trend).toBe('UP');
    expect(view.numerator).toEqual({ label: '付费用户数', value: 286 });
  });

  it('isLowerBetter 指标（单报告成本）：低于目标才达标，方向相反', () => {
    const view = buildMetricView({
      definition: metricDefinitionOf('AI_COST_PER_REPORT_CENTS'),
      value: 12.4,
      previousValue: 12.8,
    });

    expect(view.isLowerBetter).toBe(true);
    expect(view.isOnTarget).toBe(true);
    expect(view.displayValue).toBe('¥0.124');
    expect(view.unit).toBe('CENT');
    expect(view.changeDisplay).toBe('-¥0.004');
    // 成本下降是好事，但 direction 仍如实报告 DOWN（前端按 isLowerBetter 解读语义）
    expect(view.trend).toBe('DOWN');
  });

  it('成本高于目标 → 不达标', () => {
    const view = buildMetricView({
      definition: metricDefinitionOf('AI_COST_PER_REPORT_CENTS'),
      value: 20,
      previousValue: 18,
    });

    expect(view.isOnTarget).toBe(false);
  });

  it('无目标值的指标不带 isOnTarget / targetDisplay 字段', () => {
    const view = buildMetricView({ definition: metricDefinitionOf('DAU'), value: 1860, previousValue: 1742 });

    expect(view.target).toBeNull();
    expect(view.isOnTarget).toBeUndefined();
    expect('targetDisplay' in view).toBe(false);
    expect(view.changeDisplay).toBe('+118');
    expect(view.displayValue).toBe('1,860');
  });

  it('AI_SAFETY_BLOCK_RATE 带中性 note（上升不视为负向）', () => {
    const view = buildMetricView({
      definition: metricDefinitionOf('AI_SAFETY_BLOCK_RATE'),
      value: 0.0025,
      previousValue: 0.0021,
    });

    expect(view.note).toContain('不视为负向');
  });

  it('上期为 null 时 change 与 changeDisplay 都为缺失值（不编造 0 变化）', () => {
    const view = buildMetricView({
      definition: metricDefinitionOf('ARPU_CENTS'),
      value: 6443,
      previousValue: null,
    });

    expect(view.previousValue).toBeNull();
    expect(view.change).toBeNull();
    expect(view.changeDisplay).toBe('—');
  });
});

describe('metricDefinitionOf', () => {
  it('未登记的指标抛错（缺失比静默 undefined 更安全）', () => {
    expect(() => metricDefinitionOf('NOT_A_METRIC')).toThrow();
  });

  it('全部契约指标都已登记（共 9 项：1 北极星 + 8 副指标）', () => {
    const keys = Object.keys(METRIC_DEFINITIONS);
    expect(keys).toHaveLength(9);
    expect(keys).toContain('PAID_CONVERSION_RATE');
    expect(keys).toContain('AI_SAFETY_BLOCK_RATE');
  });
});

describe('展示格式化', () => {
  it('金额格式（契约 ¥1,584.00 / ¥118.40）', () => {
    expect(formatCents(158_400)).toBe('¥1,584.00');
    expect(formatCents(11_840)).toBe('¥118.40');
  });

  it('单值口径（CENT）保留 4 位小数（契约 ¥0.124 / ¥0.15）', () => {
    expect(displayValueOf(12.4, 'CENT')).toBe('¥0.124');
    expect(displayTargetOf(15, 'CENT')).toBe('¥0.15');
  });

  it('计数与比率', () => {
    expect(formatCount(1860)).toBe('1,860');
    expect(displayValueOf(0.84, 'RATIO')).toBe('0.84');
    expect(formatPercent(0.6842)).toBe('68.42%');
  });

  it('百分点变化', () => {
    expect(formatPercentagePointChange(0.0124)).toBe('+1.24pp');
    expect(formatPercentagePointChange(-0.0013)).toBe('-0.13pp');
  });

  it('缓存时长 = 契约的 60 秒', () => {
    expect(DASHBOARD_CACHE_TTL_SECONDS).toBe(60);
  });
});

describe('通用数值', () => {
  it('safeRatio / toSafeNumber / trendDirection', () => {
    expect(safeRatio(1, 0)).toBe(0);
    expect(toSafeNumber(2_000_000_000n)).toBe(2_000_000_000);
    expect(trendDirection(0)).toBe('FLAT');
  });
});
