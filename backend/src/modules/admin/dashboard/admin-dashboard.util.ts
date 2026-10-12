/**
 * 管理端看板纯逻辑（无 I/O、可 100% 单测）
 *
 * ## ⏱ 时区口径
 *
 * 与 `ai-stats` 一致：**UTC 自然日 / 周 / 月**。契约示例的 `rangeStart` 是
 * `2026-02-08T00:00:00.000Z`（7D 的 UTC 零点），趋势点的 `date` 也是 UTC 日期。
 * 项目 `TZ = Asia/Shanghai`，因此**北京时间 00:00–08:00 的行为会被计入前一天**，
 * 这一偏差已在交付简报中标注（统一口径比「各自正确」更重要：
 * 看板、AI 统计、导出对不上账的排查成本远高于 8 小时的边界偏移）。
 *
 * ## 为什么漏斗/指标的「数值」逻辑放在这里
 *
 * 看板的每一项都要求 `definition` + `numerator` + `denominator`
 * （契约 §3.14.9.9 规则 2：避免「同名指标口径不一致」的运营争议）。
 * 把这些算式抽成纯函数后，可以用单测把口径**钉死**，而不是靠注释约定。
 */

/** 看板时间范围（契约 §3.14.9.9；比 AI 统计多一个 90D） */
export const DASHBOARD_RANGES = ['TODAY', '7D', '30D', '90D', 'CUSTOM'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

/** 趋势粒度（契约 §3.14.9.9） */
export const DASHBOARD_GRANULARITIES = ['DAY', 'WEEK', 'MONTH'] as const;
export type DashboardGranularity = (typeof DASHBOARD_GRANULARITIES)[number];

/** 自定义范围上限（契约 §3.14.9.9 的 `10016`：> 366 天） */
export const DASHBOARD_MAX_RANGE_DAYS = 366;

/** 看板缓存时长（契约 §3.14.9.9 的 `cacheTtlSeconds: 60`） */
export const DASHBOARD_CACHE_TTL_SECONDS = 60;

/** 指标目标值（架构 §1.4） */
export const METRIC_TARGETS = {
  /** 北极星：付费转化率 ≥ 5% */
  PAID_CONVERSION_RATE: 0.05,
  /** 测试完成率 ≥ 65% */
  TEST_COMPLETION_RATE: 0.65,
  /** 邀请裂变系数 K ≥ 0.8 */
  VIRAL_COEFFICIENT_K: 0.8,
  /** AI 报告生成成功率 ≥ 99% */
  AI_REPORT_SUCCESS_RATE: 0.99,
  /** AI 单报告成本 ≤ 15 分（¥0.15） */
  AI_COST_PER_REPORT_CENTS: 15,
  /** 会员续费率 ≥ 35% */
  MEMBER_RETENTION_RATE: 0.35,
} as const;

/** 时间范围解析结果 */
export interface ResolvedDashboardRange {
  readonly key: DashboardRange;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
}

/** UTC 当天零点 */
export const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** 日期区间天数 */
export const rangeDays = (start: Date, end: Date): number => (end.getTime() - start.getTime()) / 86_400_000;

/**
 * 解析 `range`
 *
 * `ND` = 「含今天在内的 N 个 UTC 自然日」，起点是 `UTC 今天零点 − (N−1) 天`；
 * 校验过契约示例：2026-02-14 取 `7D` → 起点 `2026-02-08T00:00:00.000Z` ✓。
 */
export const resolveDashboardRange = (
  range: DashboardRange,
  startTime: string | undefined,
  endTime: string | undefined,
  now: Date = new Date(),
): ResolvedDashboardRange => {
  if (range === 'CUSTOM') {
    if (startTime === undefined || endTime === undefined) {
      throw new DashboardRangeError('range = CUSTOM 时必须提供 startTime 与 endTime');
    }

    const rangeStart = new Date(startTime);
    const rangeEnd = new Date(endTime);

    if (rangeStart.getTime() > rangeEnd.getTime()) {
      throw new DashboardRangeError('startTime 不能晚于 endTime');
    }

    if (rangeDays(rangeStart, rangeEnd) > DASHBOARD_MAX_RANGE_DAYS) {
      throw new DashboardRangeError(`自定义时间范围不能超过 ${DASHBOARD_MAX_RANGE_DAYS} 天`);
    }

    return { key: 'CUSTOM', rangeStart, rangeEnd };
  }

  const days = range === 'TODAY' ? 1 : range === '7D' ? 7 : range === '30D' ? 30 : 90;
  const todayStart = startOfUtcDay(now);

  return {
    key: range,
    rangeStart: new Date(todayStart.getTime() - (days - 1) * 86_400_000),
    rangeEnd: now,
  };
};

/**
 * 参数级错误（由 Service 翻译成 `10001 PARAM_INVALID`）
 *
 * 不直接抛 `BusinessException`：本文件是纯逻辑层，不依赖 Nest 与错误码表，
 * 才能在单测中零 mock 覆盖（与 `report-list.util.ts` 的取舍一致）。
 */
export class DashboardRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashboardRangeError';
  }
}

/** 前一等长周期 */
export const previousPeriod = (range: ResolvedDashboardRange): { start: Date; end: Date } => {
  const length = range.rangeEnd.getTime() - range.rangeStart.getTime();
  return { start: new Date(range.rangeStart.getTime() - length), end: range.rangeStart };
};

// ============================================================================
// 数值与格式化
// ============================================================================

/** int8 → number（BigInt 进入响应体会让 JSON.stringify 抛错） */
export const toSafeNumber = (value: bigint | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
};

/** 四舍五入 */
export const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 比率（分母 ≤ 0 → 0；NaN 会被序列化成 null，前端拿到的就不是数字） */
export const safeRatio = (numerator: number, denominator: number, digits = 4): number => {
  if (denominator <= 0) return 0;
  return roundTo(numerator / denominator, digits);
};

/** 整数分 → `¥1,584.00` */
export const formatCents = (cents: number): string => {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}¥${grouped}.${fraction}`;
};

/** 比率 → `6.21%` */
export const formatPercent = (ratio: number): string => `${roundTo(ratio * 100, 2).toFixed(2)}%`;

/** 千分位整数 → `1,860` */
export const formatCount = (value: number): string => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 百分点变化 → `+1.24pp` */
export const formatPercentagePointChange = (change: number): string =>
  `${change >= 0 ? '+' : ''}${roundTo(change * 100, 2).toFixed(2)}pp`;

/** 变化方向（契约规则 3：🚫 前端不得假设「增长即正向」） */
export const trendDirection = (change: number): 'UP' | 'DOWN' | 'FLAT' => {
  if (change > 0) return 'UP';
  if (change < 0) return 'DOWN';
  return 'FLAT';
};

// ============================================================================
// 指标
// ============================================================================

/** 单个指标的分子/分母（契约 §3.14.9.9 规则 2） */
export interface MetricParts {
  readonly numerator: { label: string; value: number } | null;
  readonly denominator: { label: string; value: number } | null;
}

/** 指标视图（`northStar` 与 `keyMetrics[]` 共用的字段集合） */
export interface MetricView {
  key: string;
  name: string;
  definition: string;
  value: number;
  displayValue: string;
  target: number | null;
  targetDisplay?: string;
  isOnTarget?: boolean;
  previousValue: number | null;
  change: number | null;
  changeDisplay: string;
  unit?: string;
  trend: 'UP' | 'DOWN' | 'FLAT';
  isLowerBetter?: boolean;
  note?: string;
  numerator?: { label: string; value: number };
  denominator?: { label: string; value: number };
}

/** 指标定义（本文件集中声明，避免定义文案散落在 Service 里） */
export interface MetricDefinition {
  readonly key: string;
  readonly name: string;
  readonly definition: string;
  readonly unit: 'PERCENT' | 'COUNT' | 'CENT' | 'RATIO';
  readonly target: number | null;
  readonly isLowerBetter?: boolean;
  readonly note?: string;
}

export const METRIC_DEFINITIONS: Readonly<Record<string, MetricDefinition>> = {
  PAID_CONVERSION_RATE: {
    key: 'PAID_CONVERSION_RATE',
    name: '付费转化率',
    definition: '完成测试 → 付费订单的转化（架构 1.4）',
    unit: 'PERCENT',
    target: METRIC_TARGETS.PAID_CONVERSION_RATE,
  },
  TEST_COMPLETION_RATE: {
    key: 'TEST_COMPLETION_RATE',
    name: '测试完成率',
    definition: '开始测试 → 提交全部答案（架构 1.4）',
    unit: 'PERCENT',
    target: METRIC_TARGETS.TEST_COMPLETION_RATE,
  },
  VIRAL_COEFFICIENT_K: {
    key: 'VIRAL_COEFFICIENT_K',
    name: '邀请裂变系数 K',
    definition: '每个完成测试用户带来的有效邀请数（架构 1.4）',
    unit: 'RATIO',
    target: METRIC_TARGETS.VIRAL_COEFFICIENT_K,
  },
  AI_REPORT_SUCCESS_RATE: {
    key: 'AI_REPORT_SUCCESS_RATE',
    name: 'AI 报告生成成功率',
    definition: '成功报告数 / 报告请求总数（含重试）',
    unit: 'PERCENT',
    target: METRIC_TARGETS.AI_REPORT_SUCCESS_RATE,
  },
  AI_COST_PER_REPORT_CENTS: {
    key: 'AI_COST_PER_REPORT_CENTS',
    name: 'AI 单报告成本',
    definition: '单份深度报告的平均 token 成本（架构 1.4）',
    unit: 'CENT',
    target: METRIC_TARGETS.AI_COST_PER_REPORT_CENTS,
    isLowerBetter: true,
  },
  ARPU_CENTS: {
    key: 'ARPU_CENTS',
    name: '付费用户 ARPU',
    definition: '期内营收 / 付费用户数',
    unit: 'CENT',
    target: null,
  },
  DAU: {
    key: 'DAU',
    name: '日活跃用户',
    definition: '期内最后一天有 AI 调用记录的**去重用户数**（近似口径，见交付简报）',
    unit: 'COUNT',
    target: null,
    note: '无全站请求日志表，用「当日产生 AI 用量记录的用户数」作为 DAU 代理口径。',
  },
  MEMBER_RETENTION_RATE: {
    key: 'MEMBER_RETENTION_RATE',
    name: '会员续费率',
    definition: '期内到期会员中，在到期后再次购买会员的比例',
    unit: 'PERCENT',
    target: METRIC_TARGETS.MEMBER_RETENTION_RATE,
  },
  AI_SAFETY_BLOCK_RATE: {
    key: 'AI_SAFETY_BLOCK_RATE',
    name: 'AI 危险内容拦截率',
    definition: '命中危险内容拦截的调用占比（合规观测）',
    unit: 'PERCENT',
    target: null,
    note: '拦截率上升通常反映用户情绪困扰增加，需关注但不视为负向指标',
  },
};

/** 取指标定义；未登记时抛错而不是返回 undefined —— 静默的 `undefined` 会变成响应里缺字段 */
export const metricDefinitionOf = (key: string): MetricDefinition => {
  const definition = METRIC_DEFINITIONS[key];
  if (definition === undefined) {
    throw new Error(`未登记的看板指标：${key}`);
  }
  return definition;
};

/** 展示值：按单位选择格式（`¥0.124` / `6.21%` / `1,860` / `0.84`） */
export const displayValueOf = (value: number, unit: MetricDefinition['unit']): string => {
  switch (unit) {
    case 'CENT':
      // 契约示例：12.4 分 → `¥0.124`（总额口径用 formatCents，单值口径保留 3 位小数）
      return `¥${roundTo(value / 100, 4)}`;
    case 'PERCENT':
      return formatPercent(value);
    case 'COUNT':
      return formatCount(value);
    case 'RATIO':
      return String(roundTo(value, 2));
  }
};

/** 目标展示值（`5%` / `¥0.15` / `0.8`） */
export const displayTargetOf = (target: number, unit: MetricDefinition['unit']): string => {
  switch (unit) {
    case 'CENT':
      return `¥${roundTo(target / 100, 4)}`;
    case 'PERCENT':
      return formatPercent(target);
    case 'COUNT':
      return formatCount(target);
    case 'RATIO':
      return String(roundTo(target, 2));
  }
};

/**
 * 组装单个指标视图
 *
 * `change` 与 `changeDisplay` 都按**单位语义**计算：比率的差值用百分点（`pp`），
 * 金额与计数用绝对差 + 单位。这是契约示例的呈现方式（`+1.24pp` / `-¥0.004` / `+118`）。
 */
export const buildMetricView = (params: {
  definition: MetricDefinition;
  value: number;
  previousValue: number | null;
  parts?: MetricParts;
}): MetricView => {
  const { definition, value, previousValue, parts } = params;
  const change = previousValue === null ? null : roundTo(value - previousValue, 4);

  const changeDisplay = buildChangeDisplay(definition.unit, change);
  const isOnTarget =
    definition.target === null
      ? undefined
      : definition.isLowerBetter === true
        ? value <= definition.target
        : value >= definition.target;

  return {
    key: definition.key,
    name: definition.name,
    definition: definition.definition,
    value,
    displayValue: displayValueOf(value, definition.unit),
    target: definition.target,
    ...(definition.target !== null ? { targetDisplay: displayTargetOf(definition.target, definition.unit) } : {}),
    ...(isOnTarget !== undefined ? { isOnTarget } : {}),
    previousValue,
    change,
    changeDisplay,
    ...(definition.unit === 'CENT' || definition.unit === 'COUNT' ? { unit: definition.unit } : {}),
    trend: trendDirection(change ?? 0),
    ...(definition.isLowerBetter === true ? { isLowerBetter: true } : {}),
    ...(definition.note !== undefined ? { note: definition.note } : {}),
    ...(parts?.numerator !== undefined && parts.numerator !== null ? { numerator: parts.numerator } : {}),
    ...(parts?.denominator !== undefined && parts.denominator !== null ? { denominator: parts.denominator } : {}),
  };
};

/** 变化展示：百分比类用 pp，其余用带符号的绝对差 */
const buildChangeDisplay = (unit: MetricDefinition['unit'], change: number | null): string => {
  if (change === null) return '—';

  if (unit === 'PERCENT') {
    return `${change >= 0 ? '+' : '-'}${Math.abs(roundTo(change * 100, 2)).toFixed(2)}pp`;
  }

  if (unit === 'CENT') {
    const sign = change >= 0 ? '+' : '-';
    return `${sign}¥${roundTo(Math.abs(change) / 100, 4)}`;
  }

  if (unit === 'COUNT') {
    return `${change >= 0 ? '+' : ''}${formatCount(change)}`;
  }

  return `${change >= 0 ? '+' : ''}${roundTo(change, 2)}`;
};

// ============================================================================
// 漏斗
// ============================================================================

/** 漏斗阶段定义（契约 §3.14.9.9） */
export interface FunnelStageDefinition {
  readonly stage: string;
  readonly label: string;
}

export const FUNNEL_STAGES: readonly FunnelStageDefinition[] = [
  { stage: 'LAUNCH', label: '小程序启动' },
  { stage: 'LOGIN', label: '静默登录成功' },
  { stage: 'TEST_START', label: '开始测试' },
  { stage: 'TEST_COMPLETE', label: '完成测试' },
  { stage: 'REPORT_GENERATE', label: '生成报告' },
  { stage: 'REPORT_UNLOCK', label: '解锁报告/购买' },
  { stage: 'INVITE_SENT', label: '发出邀请' },
  { stage: 'RELATIONSHIP_ACTIVE', label: '关系建立' },
  { stage: 'MEMBER_PURCHASE', label: '购买会员' },
] as const;

/** 漏斗阶段视图 */
export interface FunnelStageView {
  stage: string;
  label: string;
  count: number | null;
  rate: number | null;
  rateDisplay: string;
  dropOffRate: number | null;
  note?: string;
}

/** 漏斗视图 */
export interface FunnelView {
  name: string;
  stages: FunnelStageView[];
  biggestDropOff: { from: string; to: string; dropOffRate: number; suggestion: string } | null;
  fastestGrowth: { from: string; to: string; note: string } | null;
}

/**
 * 组装漏斗
 *
 * 第一阶段作为基准（`rate = 1`）；缺失数据源（`LAUNCH` / `LOGIN`）的阶段
 * `count` / `rate` / `dropOffRate` 一律为 `null` 并附 `note`，
 * 🚫 绝不拿 0 冒充「没人用」——那会让运营去排查一个并不存在的流失问题。
 * 一旦出现 null 阶段，其后阶段的 `rate` 仍以**最近一个有数据的阶段**为基准重算，
 * 避免「漏斗百分比从 0 一路为 0」。
 */
export const buildFunnel = (counts: Readonly<Record<string, number | null>>, name = '核心转化漏斗'): FunnelView => {
  const stages: FunnelStageView[] = [];
  let base: number | null = null;
  let previous: { stage: string; count: number } | null = null;

  for (const definition of FUNNEL_STAGES) {
    const count = counts[definition.stage] ?? null;

    if (count === null) {
      stages.push({
        stage: definition.stage,
        label: definition.label,
        count: null,
        rate: null,
        rateDisplay: '—',
        dropOffRate: null,
        note: '无数据源（缺少全站访问日志表），暂不纳入漏斗计算',
      });
      continue;
    }

    if (base === null) base = count;

    const rate = base === 0 ? 0 : roundTo(count / base, 4);
    const dropOffRate = previous === null || previous.count === 0 ? null : roundTo(1 - count / previous.count, 4);

    stages.push({
      stage: definition.stage,
      label: definition.label,
      count,
      rate,
      rateDisplay: formatPercent(rate),
      dropOffRate,
    });

    previous = { stage: definition.stage, count };
  }

  return { name, stages, ...identifyTransitions(stages) };
};

/**
 * 找出最大流失点与「转化最好的一环」
 *
 * ## 选择规则（契约示例的 `biggestDropOff` / `fastestGrowth` **无法由示例数字推出**）
 *
 * 契约 §3.14.9.9 的示例里，`biggestDropOff` 写的是 `REPORT_GENERATE → REPORT_UNLOCK`
 * （流失 0.6153），但同一份 `stages` 数据里 `RELATIONSHIP_ACTIVE → MEMBER_PURCHASE`
 * 的流失是 0.9682 —— 按「取最大流失」的规则应当选中后者。`fastestGrowth` 同理
 * （示例写 `INVITE_SENT → RELATIONSHIP_ACTIVE`，但其流失并非最小）。
 * 也就是说示例里的这两个字段是**人工撰写的结论**，不是可复现的算法；
 * 本实现采用**可复现且可解释**的规则并在此写明，而不是去猜示例的人工意图：
 *
 *   · `biggestDropOff`：所有可计算转移中流失率的**最大值**（真实的最大流失点）
 *   · `fastestGrowth`：所有**非负**流失率中的最小值（即转化最好的一环）
 *
 * 排除负流失率的原因：本漏斗的 `INVITE_SENT` 并非 `REPORT_UNLOCK` 的子集
 * （未解锁的用户也会发出邀请），因此该转移可能出现「下游比上游多」的负流失率；
 * 把它当作「增长最快」会给出误导性的结论。负值仍如实出现在 `stages[].dropOffRate` 中。
 */
const identifyTransitions = (
  stages: readonly FunnelStageView[],
): {
  biggestDropOff: FunnelView['biggestDropOff'];
  fastestGrowth: FunnelView['fastestGrowth'];
} => {
  let biggest: { from: string; to: string; dropOffRate: number } | null = null;
  let fastest: { from: string; to: string; dropOffRate: number } | null = null;

  for (let index = 1; index < stages.length; index += 1) {
    const current = stages[index];
    const previous = stages[index - 1];

    if (current === undefined || previous === undefined) continue;
    if (current.dropOffRate === null || current.count === null || previous.count === null) continue;
    if (previous.count === 0) continue;

    if (biggest === null || current.dropOffRate > biggest.dropOffRate) {
      biggest = { from: previous.stage, to: current.stage, dropOffRate: current.dropOffRate };
    }

    if (current.dropOffRate < 0) continue;

    if (fastest === null || current.dropOffRate < fastest.dropOffRate) {
      fastest = { from: previous.stage, to: current.stage, dropOffRate: current.dropOffRate };
    }
  }

  return {
    biggestDropOff:
      biggest === null
        ? null
        : {
            from: biggest.from,
            to: biggest.to,
            dropOffRate: biggest.dropOffRate,
            // 建议文案**不含**具体环节的产品方案（那是运营决策，且会随版本过期）：
            // 只给出「该往哪看」的排查路径，避免把过期的建议固化成接口文案
            suggestion: `「${labelOf(biggest.from)} → ${labelOf(biggest.to)}」流失 ${formatPercent(
              biggest.dropOffRate,
            )}，为漏斗最大流失点。建议按该环节的实际路径排查：入口提示是否清晰、是否存在非必要的强制操作、以及是否缺少召回手段。`,
          },
    fastestGrowth:
      fastest === null
        ? null
        : {
            from: fastest.from,
            to: fastest.to,
            note: `「${labelOf(fastest.from)} → ${labelOf(fastest.to)}」转化率最高（流失仅 ${formatPercent(
              fastest.dropOffRate,
            )}），说明该环节的用户意图明确。`,
          },
  };
};

const labelOf = (stage: string): string => FUNNEL_STAGES.find((item) => item.stage === stage)?.label ?? stage;
