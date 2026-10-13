/**
 * 「成长回顾报告」（`GROWTH_SUMMARY`）的上下文组装器
 *
 * 契约 §3.5（AI 报告）；架构依据 ADR-005「算分确定、AI 只做解读」。
 *
 * 本模块与 `report-context.builder.ts`（单画像）和 `relationship-report-context.builder.ts`
 * （关系双方）并列，是**第三条取数路径**：同一用户的**多个历史画像（时间序列）**。
 *
 * ## 为什么必须是独立的一条路径（不能用单画像上下文凑一份"成长报告"）
 *
 * 成长报告的**全部价值**就是跨版本对比：用户想知道的是"我这半年变了什么"，
 * 而不是"我现在是什么样"。拿单画像上下文渲染一份标题写着"成长回顾"的报告，
 * 会得到一篇读起来毫无破绽、实际与"成长"毫无关系的内容 —— 用户会为它付费，
 * 而且不会察觉任何异常。那比明确报错更伤用户，所以本模块的变量**只描述序列**：
 * 时间线、五维变化量、哪些变了、哪些没变。
 *
 * 与这条铁律配套的还有一条同样重要的区分：**「没有数据」与「对比结果为空」是两件事**。
 *
 *   · 某维度在两版里都没有值 → 该维度**不做**数值比较，并记入 `unavailable`（真·缺数据）；
 *   · 五维都有值、只是恰好都没动 → 明确写出"本次没有任何维度达到变化阈值"，
 *     **不能**填占位文案。占位文案（`UNAVAILABLE_PLACEHOLDER`）的语义是
 *     "本次测评未包含此项"，用它来表达"对比结果是空的"会让模型以为数据缺失，
 *     于是拒绝解读一个其实**有明确结论**的序列（"这半年你的五项特质都很稳定"
 *     本身就是一个有价值的结论）。
 *
 * ## 缺数据绝不能被当成 0
 *
 * 某一版缺某个维度时，那一维**在该版的对比中跳过**，不当 0 参与计算：
 * 把缺失读成 0 会凭空造出「从 0 涨到 78」的假增长 —— 它看起来像一次巨大的进步，
 * 用户会当真，而这正是成长报告里最严重的一类错误。
 *
 * ## 三条硬性约束（与单画像构建器同源）
 *
 *   ① **不引入当前时间 / 随机数**：日期只来自入参 `createdAt`，且只做**字符串切片**
 *      （取 ISO 串的 `YYYY-MM-DD`）。刻意不用 `new Date()` 做时区换算 ——
 *      那会让同一份数据在不同机器/时区上产出不同的 Prompt，破坏 ADR-005 的可复现要求；
 *   ② **迭代顺序固定**：版本按入参顺序（服务层保证 version 升序），
 *      五维按 `BIG_FIVE_KEYS` 的固定顺序，`variables` 的键按声明顺序插入；
 *   ③ **可选数据缺失时不抛错**：填显式占位文案，模板因此永远能渲染成功。
 *
 * ## `unavailable` 的两类名字（都是"数据不全"的信号，但含义不同）
 *
 *   · **变量名**（与 `variables` 的键同名，如 `scoreDeltas`）：该变量整列不可用，值是占位文案；
 *   · **字段名**（`openness` / `mbtiType` / `createdAt` / `consistencyScore` / …）：
 *     **不是每一版都有该字段**。依赖它的变量仍然产出（用有数据的版本算出一条真实结果），
 *     但覆盖面不完整 —— 例如只有 v1 与 v3 有开放性时，变化量就是"v1 → v3"。
 *     若只在文本里体现这种部分缺失、不进清单，后台会以为数据齐全，也就不会提示用户补测。
 *
 * 两类名字不重名，因此不会混淆。
 */

import {
  BIG_FIVE_LABELS,
  UNAVAILABLE_PLACEHOLDER,
  describeBigFiveLevel,
  findTypeProfile,
  formatScore,
} from './report-context.builder';

/** 历史画像序列中的一版（服务层负责按 version 升序传入，并保证至少 2 版） */
export interface GrowthProfileSnapshot {
  readonly version: number;
  /** 该版画像的生成时间（ISO 字符串；**由调用方注入**，builder 内不得取当前时间） */
  readonly createdAt: string;
  readonly mbtiType: string | null;
  readonly openness: number | null;
  readonly conscientiousness: number | null;
  readonly extraversion: number | null;
  readonly agreeableness: number | null;
  readonly neuroticism: number | null;
  readonly consistencyScore: number | null;
  readonly completionRate: number | null;
  readonly answeredCount: number | null;
  readonly questionCount: number | null;
  readonly avgResponseMs: number | null;
  readonly testDefinitionCode: string | null;
}

export interface GrowthReportContextInput {
  readonly profiles: readonly GrowthProfileSnapshot[];
}

export interface GrowthReportContext {
  readonly variables: Readonly<Record<string, string>>;
  /** 缺失数据项的名字列表（与 buildReportContext 的 unavailable 同语义） */
  readonly unavailable: readonly string[];
}

/** 大五维度键 */
type BigFiveKey = 'openness' | 'conscientiousness' | 'extraversion' | 'agreeableness' | 'neuroticism';

/**
 * 五维的**固定顺序**：开放性 → 尽责性 → 外向性 → 宜人性 → 神经质
 *
 * 与 `report-context.builder.ts` 的 `bigFiveSummary` 同序。时间线、变化量、稳定项
 * 三处若各用一套顺序，模型就得自己对齐列；而它一旦对错列，会把"开放性涨了"
 * 讲成"宜人性涨了" —— 结论整体错位，报告却读不出任何破绽。
 */
const BIG_FIVE_KEYS: readonly BigFiveKey[] = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
];

/**
 * 「变化幅度明显」的阈值（0–100 分制上的**绝对**差值）
 *
 * 取 5 不是一个随手定的数，三个理由：
 *   · **显示取整**：分数在本模块统一按 0 位小数呈现（`formatScore`），±1 以内的差异
 *     是取整的产物而非真实变化，阈值必须显著大于它；
 *   · **档位带宽是 15 分**（`describeBigFiveLevel`：低 <30 / 偏低 30–44 / 中等 45–64 /
 *     偏高 65–79 / 高 ≥80），5 分 = 三分之一个档位：小到能在用户真正感知得到的
 *     **跨档位**变化之前就报警，大到不会被自评量表的重测噪声刷屏；
 *   · **自评量表的重复测量**本身就有个位数分的正常波动，把 <5 分的位移说成"你变了"
 *     属于过度解读 —— 而成长报告最贵的错误正是**把噪声讲成成长**。
 *
 * 阈值是**含**的：`|Δ| ≥ 5` 记为变化，`|Δ| < 5` 记为稳定。两者互补、不留空隙，
 * 因此任一可比维度必然落在且只落在一侧（`changedTraits` 与 `stableTraits` 的并集
 * 恰好等于全部可比维度）。
 */
export const CHANGED_TRAIT_DELTA_THRESHOLD = 5;

/** 一版画像的规范化取值（全部字段都已判定过"可用 / 不可用"） */
interface NormalizedSeriesEntry {
  readonly version: number;
  readonly date: string | null;
  readonly mbtiType: string | null;
  readonly bigFive: Readonly<Record<BigFiveKey, number | null>>;
  readonly consistencyScore: number | null;
  readonly completionRate: number | null;
  /** 作答比例（`answeredCount` 与 `questionCount` 都可用且题数不为 0 时才有） */
  readonly answeredRatio: { readonly value: number; readonly text: string } | null;
  readonly answeredCount: number | null;
  readonly questionCount: number | null;
  readonly avgResponseMs: number | null;
  readonly testDefinitionCode: string | null;
}

/** 某维度在序列中一个**可用**数值 */
interface DimPoint {
  readonly version: number;
  readonly value: number;
}

/** 某维度在序列中的可用数值集合（按版本升序） */
interface DimSeries {
  readonly key: BigFiveKey;
  readonly points: readonly DimPoint[];
}

/**
 * 一个**可比**维度（至少两版有数值）的变化量
 *
 * 两端与展示串都在这一个结构里定好，`scoreDeltas` / `changedTraits` / `stableTraits`
 * 三个变量复用同一份文案 —— 三处各拼一次字符串，迟早会出现"变化量说 +16、
 * 变化最大的维度说 +15"这种自相矛盾的 Prompt。
 */
interface ComparableDelta {
  readonly key: BigFiveKey;
  /** 固定顺序下标（按幅度排序时打平用的稳定依据） */
  readonly order: number;
  /** **展示上的**变化量：由已取整的两个端点相减得到（见 `buildGrowthReportContext` 内注释） */
  readonly delta: number;
  /** `开放性 62 → 78` */
  readonly headline: string;
  /** `+16` / `-15` / `0` */
  readonly deltaText: string;
}

/** 一个质量指标的逐版取值（`text` 是给模型看的写法，`value` 只用于挑区间的两端） */
interface VersionStat {
  readonly version: number;
  readonly value: number;
  readonly text: string;
}

/** 非有限数值（NaN / Infinity）一律按缺失处理，绝不让它渗进 Prompt */
const finiteOrNull = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : value;

/** 空串按缺失处理（DB 的 `VarChar` 允许空串，空串写进 Prompt 等于没说） */
const textOrNull = (value: string | null): string | null => (value === null || value.length === 0 ? null : value);

/**
 * ISO 时间串的日期部分；不合法时返回 null（不猜、不用当前日期兜底）
 *
 * ⚠ 取的是 ISO 串里的 **UTC** 日期。若产品要求展示**用户本地时区**的日期
 * （例如 `createdAt` 存的是 `2026-01-05T16:30:00Z`，而用户在 UTC+8 是 1 月 6 日），
 * 应由服务层把已经换算好的本地日期传进来（或另行约定字段），**不要**让 builder 去读机器时区：
 * 那会让同一份数据在不同环境/容器上产出不同的 Prompt，破坏 ADR-005 的可复现要求。
 */
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

const dateOf = (createdAt: string): string | null => {
  const match = DATE_PREFIX.exec(createdAt);

  return match === null ? null : match[1];
};

/**
 * 有限数值 → 定点字符串
 *
 * 与 `report-context.builder.ts` 的 `formatScore` 同规则（0 位小数）：调用点拿到的
 * 都已经是过滤过的有限数值，因此不需要再处理缺失分支（时间线等可能缺值的地方
 * 直接用 `formatScore(...) ?? UNAVAILABLE_PLACEHOLDER`）。
 */
const scoreText = (value: number): string => String(Math.round(value));

/**
 * 版本号标签（时间线与变化量里的 `v1` / `v3`）
 *
 * 原样使用入参的 `version`，**不假设它是 1..N 连号**：重算画像、删除历史画像都会让
 * 版本号出现空档（`personality_profiles` 只有 `UNIQUE(userId, version)`，没有连续性约束）。
 * 时间线因此可能显示 `v1 / v3 / v7`，那是**真实**的历史，比强行重编号更可信。
 */
const versionLabel = (version: number): string => `v${version}`;

const normalize = (snapshot: GrowthProfileSnapshot): NormalizedSeriesEntry => {
  const answeredCount = finiteOrNull(snapshot.answeredCount);
  const questionCount = finiteOrNull(snapshot.questionCount);
  const rawType = textOrNull(snapshot.mbtiType);

  return {
    version: snapshot.version,
    date: dateOf(snapshot.createdAt),
    // 与单画像构建器一致：类型码统一大写后输出
    mbtiType: rawType === null ? null : rawType.toUpperCase(),
    bigFive: {
      openness: finiteOrNull(snapshot.openness),
      conscientiousness: finiteOrNull(snapshot.conscientiousness),
      extraversion: finiteOrNull(snapshot.extraversion),
      agreeableness: finiteOrNull(snapshot.agreeableness),
      neuroticism: finiteOrNull(snapshot.neuroticism),
    },
    consistencyScore: finiteOrNull(snapshot.consistencyScore),
    completionRate: finiteOrNull(snapshot.completionRate),
    // 与单画像构建器的 `answeredRatio` 同规则：题数为 0 时记缺失（不产出 `32/0`）
    answeredRatio:
      answeredCount === null || questionCount === null || questionCount === 0
        ? null
        : {
            value: answeredCount / questionCount,
            text: `${scoreText(answeredCount)}/${scoreText(questionCount)}`,
          },
    answeredCount,
    questionCount,
    avgResponseMs: finiteOrNull(snapshot.avgResponseMs),
    testDefinitionCode: textOrNull(snapshot.testDefinitionCode),
  };
};

/**
 * 时间线的一行：`v1｜2026-01-05｜INFJ｜开放性 62、尽责性 70、外向性 30、宜人性 65、神经质 55`
 *
 * 缺失的槽位一律填占位文案而不是留空：留空会让模型以为那是空字符串，
 * 或者干脆把该槽位"看不见"从而误以为该版本只有四项 —— 与"这个版本没有这项数据"
 * 是完全不同的两件事。五维按固定顺序逐项占位，版本之间因此天然列对齐。
 */
const describeTimelineLine = (entry: NormalizedSeriesEntry): string => {
  const bigFive = BIG_FIVE_KEYS.map(
    (key) => `${BIG_FIVE_LABELS[key]} ${formatScore(entry.bigFive[key]) ?? UNAVAILABLE_PLACEHOLDER}`,
  ).join('、');

  return [
    versionLabel(entry.version),
    entry.date ?? UNAVAILABLE_PLACEHOLDER,
    entry.mbtiType ?? UNAVAILABLE_PLACEHOLDER,
    bigFive,
  ].join('｜');
};

/**
 * 逐版质量的区间描述：`82–95（3/3 版有数据）`
 *
 * `stats.length`（有值的版本数）与 `total`（参与对比的版本数）都写出来：
 * 只给区间会让模型以为"每一版都有这个数据"，而它据此判断的确信程度会偏高。
 */
const describeRange = (stats: readonly VersionStat[], total: number, suffix: string): string | null => {
  if (stats.length === 0) return null;

  const lowest = stats.reduce((acc, item) => (item.value < acc.value ? item : acc));
  const highest = stats.reduce((acc, item) => (item.value > acc.value ? item : acc));
  const range = lowest.value === highest.value ? lowest.text : `${lowest.text}–${highest.text}`;

  return `${range}${suffix}（${stats.length}/${total} 版有数据）`;
};

/**
 * 各版量表的说明
 *
 * 单一口径：`量表 MBTI_LITE（3/3 版有数据）`；
 * 混合口径：`量表不同：MBTI_LITE（v1、v2）；BIG_FIVE_FULL（v3）`。
 *
 * 这里只陈述**事实**，不写"分数不可直接比较"这类指令 —— 指令属于系统提示词
 * （模板里的 `report.growth` 已明确要求），把指令混进数据块会让模型分不清
 * 哪一段是数据、哪一段是规则。
 */
const describeScaleLine = (series: readonly NormalizedSeriesEntry[]): string | null => {
  const coded = series.flatMap((entry) =>
    entry.testDefinitionCode === null ? [] : [{ version: entry.version, code: entry.testDefinitionCode }],
  );

  if (coded.length === 0) return null;

  const codes = [...new Set(coded.map((entry) => entry.code))];

  if (codes.length === 1) {
    return `量表 ${codes[0]}（${coded.length}/${series.length} 版有数据）`;
  }

  const groups = codes.map((code) => {
    const versions = coded.filter((entry) => entry.code === code).map((entry) => versionLabel(entry.version));

    return `${code}（${versions.join('、')}）`;
  });

  return `量表不同：${groups.join('；')}`;
};

/**
 * 登记**字段级**缺项（与"变量整列不可用"区分开）
 *
 * 某字段只在部分版本里有值时，依赖它的变量**仍然产出**真实结果，只是覆盖面不完整。
 * 这种"部分缺失"必须进清单：不进清单，后台就以为数据齐全，运营也不会提示用户补测。
 */
const noteFieldIncomplete = (list: string[], name: string, presentCount: number, totalCount: number): void => {
  if (presentCount < totalCount) list.push(name);
};

/**
 * 组装成长回顾报告上下文
 *
 * 变量名是**模板与本模块之间的契约**：模板里写 `{{scoreDeltas}}`，这里就必须产出
 * `scoreDeltas`。因此所有变量**无条件存在**（不可用时为占位文案），模板不需要知道
 * 「哪些数据是必有的」，也不会因缺一项而整份渲染失败。
 *
 * 两个例外（**刻意**不填占位文案，原因见各自注释）：
 *   · `profileCount`：参与对比的版本数永远是一个确定事实（即使是 0 或 1 版）；
 *   · `mbtiShifted`：类型是否变化必须有确定的「是」/「否」，用户与模板都需要一个明确结论。
 *
 * 本模块**不排序**：版本顺序由服务层保证（按 version 升序），"最新一版"即入参的最后一个。
 * 刻意不在 builder 里再排一次 —— 排序会让"最新"的判定依赖构建器里的一份隐式规则，
 * 而取数顺序本该在服务层就明确；两处各排一遍反而更容易错。
 */
export const buildGrowthReportContext = (input: GrowthReportContextInput): GrowthReportContext => {
  const series = input.profiles.map(normalize);
  const total = series.length;
  const latest = total === 0 ? null : series[total - 1];

  const unavailable: string[] = [];

  // ------------------------------------------------------------------ 时间跨度
  // 只有至少两版时"跨度"才有意义：单版的首末日期是同一天，写出来会像"没有任何变化"，
  // 而那是数据不足，不是结论。因此少于两版时该变量记入 unavailable 并填占位文案。
  const firstDate = total === 0 ? null : series[0].date;
  const lastDate = latest === null ? null : latest.date;
  const periodText = total >= 2 && firstDate !== null && lastDate !== null ? `${firstDate} → ${lastDate}` : null;

  // ------------------------------------------------------------------ 逐版时间线
  // 时间线只要**有任何一版带着任何一项真实数据**就算可用（哪怕其他版本全是占位）：
  // 序列本身就存在于这些行里，把它整块换成占位文案等于对模型隐瞒"一共有几版"。
  const hasAnyContent = series.some(
    (entry) =>
      entry.date !== null || entry.mbtiType !== null || BIG_FIVE_KEYS.some((key) => entry.bigFive[key] !== null),
  );
  const growthTimeline = hasAnyContent ? series.map(describeTimelineLine).join('\n') : null;

  // ------------------------------------------------------------------ 五维变化量
  // 每维只收集**可用数值**：缺失的版本在这里被跳过（绝不当 0 —— 见文件头）。
  const dimSeries: readonly DimSeries[] = BIG_FIVE_KEYS.map((key) => ({
    key,
    points: series
      .map((entry) => ({ version: entry.version, value: entry.bigFive[key] }))
      .filter((point): point is DimPoint => point.value !== null),
  }));

  const deltaLines: string[] = [];
  const comparables: ComparableDelta[] = [];

  for (const [order, dim] of dimSeries.entries()) {
    const label = BIG_FIVE_LABELS[dim.key];

    // 少于两版有值就没有"变化"可言：明确写出"无法比较"，
    // 而不是产出一个看着像数字的东西（那会被读成"没变化"）
    if (dim.points.length < 2) {
      deltaLines.push(`${label} 无法比较（该维度在参与对比的版本中没有两版可用数值；缺失已跳过，未按 0 处理）`);
      continue;
    }

    const from = dim.points[0];
    const to = dim.points[dim.points.length - 1];

    /**
     * 展示上的加减必须自洽
     *
     * Δ 由**已取整的两个端点**相减得到，而不是两条浮点数先减再取整：
     * 62.6 → 78.4 若先减后取整会显示成 `63 → 78（+16）`（端点是 63 与 78，
     * 差值却是 16，用户拿计算器一按就对不上）。同一份 Prompt 里出现算不通的算术，
     * 是让人整份报告都不敢信的开始。
     */
    const fromScore = Math.round(from.value);
    const toScore = Math.round(to.value);
    const delta = toScore - fromScore;

    // 只在"该维度并非每一版都有值"时标注版本号：常规情况下保持 `开放性 62 → 78（+16）`
    // 的简洁形态，跨度不完整时才把两端锚定到具体版本（否则模型会以为比的是首末两版）
    const partial = dim.points.length < total;
    const fromText = partial ? `${fromScore}（${versionLabel(from.version)}）` : String(fromScore);
    const toText = partial ? `${toScore}（${versionLabel(to.version)}）` : String(toScore);

    const comparable: ComparableDelta = {
      key: dim.key,
      order,
      delta,
      headline: `${label} ${fromText} → ${toText}`,
      deltaText: `${delta > 0 ? '+' : ''}${scoreText(delta)}`,
    };

    deltaLines.push(`${comparable.headline}（${comparable.deltaText}）`);
    comparables.push(comparable);
  }

  // 按幅度降序（打平时回落到固定维度顺序，保证同一输入永远同一顺序）
  const changed = comparables
    .filter((item) => Math.abs(item.delta) >= CHANGED_TRAIT_DELTA_THRESHOLD)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.order - b.order);
  const stable = comparables.filter((item) => Math.abs(item.delta) < CHANGED_TRAIT_DELTA_THRESHOLD);

  let changedTraits: string | null = null;
  if (comparables.length > 0) {
    if (changed.length === 0) {
      // 「结果为空」而不是「缺数据」：明确说出来，且**不**记入 unavailable（占位文案的语义是"没有这项数据"）
      changedTraits =
        `本次序列中的 ${comparables.length} 个可比维度都没有达到变化阈值` +
        `（|Δ| ≥ ${CHANGED_TRAIT_DELTA_THRESHOLD} 分），即没有任何维度发生明显变化`;
    } else {
      changedTraits = changed
        .map((item, index) => `${item.headline}（${item.deltaText}${index === 0 ? '，本次序列中幅度最大' : ''}）`)
        .join('\n');
    }
  }

  let stableTraits: string | null = null;
  if (comparables.length > 0) {
    if (stable.length === 0) {
      stableTraits =
        `本次序列中没有可视为稳定的维度：${comparables.length} 个可比维度全部达到变化阈值` +
        `（|Δ| ≥ ${CHANGED_TRAIT_DELTA_THRESHOLD} 分）`;
    } else {
      // 稳定项按固定维度顺序（不需要按幅度排 —— 它要回答的是"哪些没变"，不是"哪个最稳"）
      stableTraits = stable.map((item) => `${item.headline}（${item.deltaText}）`).join('\n');
    }
  }

  // ------------------------------------------------------------------ 最新一版
  const latestMbtiType = latest === null ? null : latest.mbtiType;
  const latestTypeProfile = findTypeProfile(latestMbtiType);
  const latestMbtiTypeName = latestTypeProfile === null ? null : latestTypeProfile.typeName;

  // 与单画像构建器的 `bigFiveSummary` **同格式**（中文名 + 分数 + 档位，`；` 分隔，
  // 缺失项跳过、全缺才占位），大五模板与本模板之间换用变量不会出现两种写法
  const latestBigFiveParts: string[] = [];
  if (latest !== null) {
    for (const key of BIG_FIVE_KEYS) {
      const value = latest.bigFive[key];
      if (value === null) continue;

      latestBigFiveParts.push(`${BIG_FIVE_LABELS[key]} ${scoreText(value)}（${describeBigFiveLevel(value)}）`);
    }
  }

  // ------------------------------------------------------------------ 类型是否变化
  const knownTypes = series.map((entry) => entry.mbtiType).filter((type): type is string => type !== null);

  /**
   * `是` / `否`，**永远是确定取值**
   *
   * 类型缺数据的版本（`mbtiType` 为 null）会另以字段名 `mbtiType` 记入 `unavailable`，
   * 并在时间线上留占位文案 —— 但 `mbtiShifted` 本身不能是占位：
   * 它要回答的是"序列里的类型有没有变过"，模板与用户都需要一个明确结论。
   * 因此判定只在**已知的类型之间**进行：已知类型不足两种时取「否」。
   */
  const mbtiShifted = new Set(knownTypes).size > 1 ? '是' : '否';

  // ------------------------------------------------------------------ 数据质量
  /** 逐版取值 → 统计数组（缺失的版本直接不出现，区间因此只覆盖有数据的版本） */
  const numberStats = (
    pick: (entry: NormalizedSeriesEntry) => number | null,
    format: (value: number) => string = scoreText,
  ): VersionStat[] =>
    series.flatMap((entry) => {
      const value = pick(entry);

      return value === null ? [] : [{ version: entry.version, value, text: format(value) }];
    });

  const consistencyStats = numberStats((entry) => entry.consistencyScore);
  const completionStats = numberStats((entry) => entry.completionRate);
  // 与单画像构建器的 `avgResponseSeconds` 同单位（秒/题），避免同一份数据在两种报告里差 1000 倍
  const responseStats = numberStats(
    (entry) => entry.avgResponseMs,
    (ms) => String(Math.round(ms / 1000)),
  );
  const answeredStats: VersionStat[] = series.flatMap((entry) =>
    entry.answeredRatio === null
      ? []
      : [{ version: entry.version, value: entry.answeredRatio.value, text: entry.answeredRatio.text }],
  );

  const qualityParts: string[] = [];
  const pushQuality = (label: string, text: string | null): void => {
    if (text !== null) qualityParts.push(`${label} ${text}`);
  };

  pushQuality('作答一致性', describeRange(consistencyStats, total, ''));
  pushQuality('完成率', describeRange(completionStats, total, '%'));
  pushQuality('作答题数', describeRange(answeredStats, total, ''));
  pushQuality('平均作答耗时', describeRange(responseStats, total, ' 秒/题'));
  const scaleLine = describeScaleLine(series);
  if (scaleLine !== null) qualityParts.push(scaleLine);

  const dataQualityText = qualityParts.length === 0 ? null : qualityParts.join('\n');

  // ------------------------------------------------------------------ 字段级缺项登记
  // 顺序固定：先五维（固定顺序），再时间/类型，最后质量字段 —— 同一输入永远同一个清单顺序
  for (const dim of dimSeries) noteFieldIncomplete(unavailable, dim.key, dim.points.length, total);
  noteFieldIncomplete(unavailable, 'createdAt', series.filter((entry) => entry.date !== null).length, total);
  noteFieldIncomplete(unavailable, 'mbtiType', knownTypes.length, total);
  noteFieldIncomplete(unavailable, 'consistencyScore', consistencyStats.length, total);
  noteFieldIncomplete(unavailable, 'completionRate', completionStats.length, total);
  noteFieldIncomplete(
    unavailable,
    'answeredCount',
    series.filter((entry) => entry.answeredCount !== null).length,
    total,
  );
  noteFieldIncomplete(
    unavailable,
    'questionCount',
    series.filter((entry) => entry.questionCount !== null).length,
    total,
  );
  noteFieldIncomplete(unavailable, 'avgResponseMs', responseStats.length, total);
  noteFieldIncomplete(
    unavailable,
    'testDefinitionCode',
    series.filter((entry) => entry.testDefinitionCode !== null).length,
    total,
  );

  // ------------------------------------------------------------------ 产出变量
  const variables: Record<string, string> = {};

  /** 登记一个变量；值为 null / 空串时记入 unavailable 并填占位文案 */
  const resolve = (name: string, text: string | null): void => {
    if (text === null || text.length === 0) {
      unavailable.push(name);
      variables[name] = UNAVAILABLE_PLACEHOLDER;
      return;
    }

    variables[name] = text;
  };

  /**
   * 变量按**固定顺序**产出
   *
   * 用一个表来产出而不是散落地赋值：键的插入顺序因此与数据无关
   * （`JSON.stringify` 的结果、后台看到的变量清单都不会随数据变化而变化），
   * 且"有哪些变量"一眼可数 —— 与模板里的占位符清单逐个对得上。
   */
  const entries: readonly (readonly [string, string | null])[] = [
    // 参与对比的版本数：永远是非空确定的数字
    ['profileCount', String(total)],
    ['periodText', periodText],
    ['growthTimeline', growthTimeline],
    // 一个可比维度都没有 = 这些变量没有任何数据可谈（与"结果为空"不同，见文件头）
    ['scoreDeltas', comparables.length === 0 ? null : deltaLines.join('\n')],
    ['changedTraits', changedTraits],
    ['stableTraits', stableTraits],
    ['latestMbtiType', latestMbtiType],
    ['latestMbtiTypeName', latestMbtiTypeName],
    // 永远是「是」/「否」
    ['mbtiShifted', mbtiShifted],
    ['latestBigFiveSummary', latestBigFiveParts.length === 0 ? null : latestBigFiveParts.join('；')],
    ['dataQualityText', dataQualityText],
  ];

  for (const [name, text] of entries) resolve(name, text);

  return { variables, unavailable };
};
