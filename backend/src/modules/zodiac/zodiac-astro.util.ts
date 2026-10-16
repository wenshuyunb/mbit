/**
 * 星盘天文计算（纯函数，**零依赖自研**）
 *
 * ## 为什么自己实现而不是装库
 *
 * 项目硬约定：**不新增 npm 依赖**（HANDOVER §5.2）。市面上有 `astronomia`、
 * `swisseph` 一类库，但为"定星座与相位"引入一个天文库不划算 ——
 * 我们需要的是**黄道经度**（精度 0.01° 足够，星座宽 30°、相位容许度 6–8°），
 * 而不是星历级的角秒精度。
 *
 * ## 算法来源与精度（如实说明，不吹）
 *
 * | 天体                 | 算法                                          | 典型精度 |
 * | -------------------- | --------------------------------------------- | -------- |
 * | 太阳                 | Meeus《天文算法》ch.25 低精度公式             | ~0.01°   |
 * | 月亮                 | Meeus ch.47（周期项取前 30 项）               | ~0.1°    |
 * | 水星…冥王星          | JPL/Standish 近似开普勒要素 + 开普勒方程求解  | ~0.01–0.1° |
 * | 上升点 / 天顶         | 恒星时 + 黄赤交角的标准球面公式                | 角分级   |
 *
 * 全表位置都做了**岁差改正**（J2000 黄道 → 当日黄道，约 1.397°/世纪）——
 * 少了这一步，2026 年的位置会整体偏 0.36°，虽然不至于错星座，但相位会算歪。
 *
 * ⚠ **本模块只做"星座与相位"层面的解读**，不提供专业占星软件级的精度承诺。
 * 接口响应里会带 `precisionNote` 说明这一点（对外不吹精度，是合规也是诚实）。
 *
 * ## 关于时区与出生时刻
 *
 * 出生时刻是"当地钟表时间"，折算成世界时才能算恒星时。中国用户在
 * 1986–1991 年夏季实行过**夏令时**（比标准时快 1 小时），如果按标准时算，
 * 那几年夏天的上升星座会整整错一个星座 —— 因此 `resolveTimezoneOffset`
 * 内置了这段历史规则。
 */

/** 黄赤交角（J2000，度） */
const OBLIQUITY_J2000 = 23.4392911;

/** 每世纪黄道岁差（度）——把 J2000 黄经换算到"当日黄道" */
const PRECESSION_PER_CENTURY = 1.396971;

const DEG = Math.PI / 180;

/** 角度规整到 [0, 360) */
export const normalizeDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;

const sinDeg = (degrees: number): number => Math.sin(degrees * DEG);
const cosDeg = (degrees: number): number => Math.cos(degrees * DEG);

/** 反正切（返回 0–360 度） */
const atan2Deg = (y: number, x: number): number => normalizeDegrees(Math.atan2(y, x) / DEG);

// ============================================================================
// 儒略日
// ============================================================================

/**
 * 由**世界时**的年月日时分求儒略日（Meeus ch.7）
 *
 * @param hourUtc 0–24 的小时（可含小数）
 */
export const julianDay = (year: number, month: number, day: number, hourUtc = 0): number => {
  let y = year;
  let m = month;

  if (m <= 2) {
    y -= 1;
    m += 12;
  }

  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);

  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5 + hourUtc / 24;
};

/** 儒略日 → 儒略世纪数（自 J2000） */
export const julianCenturies = (jd: number): number => (jd - 2451545.0) / 36525;

// ============================================================================
// 时区：含中国 1986–1991 年的夏令时
// ============================================================================

/**
 * 解析出生地当时的时区偏移（小时）
 *
 * ## 为什么要处理夏令时
 *
 * 中国在 **1986–1991 年**实行过夏令时（每年 4 月中旬到 9 月中旬拨快 1 小时）。
 * 那几年夏天出生的人，如果按标准时（+8）折算世界时，会**整整差 1 小时** ——
 * 而上升星座每约 2 小时换一个星座，1 小时的误差足以让它落到前一个星座上
 * （北京 7 月实测：差一个时区，上升点差约 12°）。
 *
 * ## 历史窗口（国务院 1986 年起实行，1992 年起停止）
 *
 * 各年的起止日期略有不同，这里按**实际公布的日期**列出（来源：中国夏令时
 * 历年起止时间表）：
 *
 * | 年份 | 开始（当地 02:00 → 03:00） | 结束（当地 02:00 → 01:00） |
 * | ---- | -------------------------- | -------------------------- |
 * | 1986 | 05-04                     | 09-14                     |
 * | 1987 | 04-12                     | 09-13                     |
 * | 1988 | 04-10                     | 09-11                     |
 * | 1989 | 04-16                     | 09-17                     |
 * | 1990 | 04-15                     | 09-16                     |
 * | 1991 | 04-14                     | 09-15                     |
 *
 * ## ⚠ `baseOffset` 是**标准时区**，不是"最终偏移"
 *
 * 这是端到端探针抓到的坑（2026-10）：最初把传入的偏移当作最终值、给了就直接返回，
 * 结果**从城市表补齐坐标的那条路径**（`zodiac-city.data.ts` 里北京存的是 +8）
 * 把夏令时判定整个跳过了 —— 同一个人、同一份出生信息，走"存过经纬度"
 * 与"只存了城市名"两条路，算出来的上升点差 12°，而两条路都自称北京。
 *
 * 因此现在的规则是：
 *   · `baseOffset` 只表示该地点的**标准**时区（北京恒为 +8、东京为 +9）；
 *   · **只要标准时区是 +8（即中国），就按上面的窗口叠加夏令时** ——
 *     不管这个 +8 是用户填的、还是城市表给的；
 *   · 其他标准时区不适用中国的夏令时规则（否则 1988 年 7 月出生的东京用户
 *     会被多加 1 小时），原样返回。
 *
 * @param baseOffset 出生地的**标准**时区偏移（小时）。为空时按中国 +8 处理。
 */
export const resolveTimezoneOffset = (year: number, month: number, day: number, baseOffset?: number | null): number => {
  // 缺省按东八区（中国用户占绝大多数）
  const standard = baseOffset === undefined || baseOffset === null || !Number.isFinite(baseOffset) ? 8 : baseOffset;

  // 中国夏令时只属于 +8 时区：其他标准时区不适用
  if (standard !== 8) return standard;

  const dstWindow: Readonly<Record<number, readonly [number, number, number, number]>> = {
    1986: [5, 4, 9, 14],
    1987: [4, 12, 9, 13],
    1988: [4, 10, 9, 11],
    1989: [4, 16, 9, 17],
    1990: [4, 15, 9, 16],
    1991: [4, 14, 9, 15],
  };

  const window = dstWindow[year];
  if (window === undefined) return standard;

  const [startMonth, startDay, endMonth, endDay] = window;
  const value = month * 100 + day;
  const start = startMonth * 100 + startDay;
  const end = endMonth * 100 + endDay;

  return value >= start && value <= end ? standard + 1 : standard;
};

// ============================================================================
// 太阳
// ============================================================================

/**
 * 太阳的**视黄经**（度，**当日春分点**）
 *
 * ⚠ **不要再加岁差改正**（2026-10-16 实测踩过）：
 * Meeus ch.25 的这条公式给出的已经是"当日真春分点"下的视黄经
 *（它内部的章动/光行差项就是相对当日春分点的）。
 * 第一版按"J2000 → 当日"又多加了 `1.396971°×T`，于是 2026 年春分时
 * 太阳算出来是 **0.37°** 而不是 0° —— 那正是该世纪的岁差量，
 * 也就是**同一项改正被做了两遍**。
 *
 * 校验方式：春分/夏至/秋分时刻太阳黄经必须是 0° / 90° / 180°（见
 * `.runlogs/verify-astro.cjs`）。
 */
export const sunLongitude = (jd: number): number => {
  const t = julianCenturies(jd);

  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const m = 357.52911 + 35999.05029 * t - 0.0001537 * t * t;

  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * sinDeg(m) +
    (0.019993 - 0.000101 * t) * sinDeg(2 * m) +
    0.000289 * sinDeg(3 * m);

  const trueLongitude = l0 + c;
  // 章动与光行差合并修正（Meeus ch.25 的简化式）
  const omega = 125.04 - 1934.136 * t;

  return normalizeDegrees(trueLongitude - 0.00569 - 0.00478 * sinDeg(omega));
};

// ============================================================================
// 月亮（Meeus ch.47，取量级最大的 30 个周期项）
// ============================================================================

/** 月亮的**黄经**（度，**当日春分点**；与太阳同一参考系，勿再加岁差） */
export const moonLongitude = (jd: number): number => {
  const t = julianCenturies(jd);

  const lp = 218.3164477 + 481267.88123421 * t - 0.0015786 * t * t + (t * t * t) / 538841 - t ** 4 / 65194000;
  const d = 297.8501921 + 445267.1114034 * t - 0.0018819 * t * t + (t * t * t) / 545868 - t ** 4 / 113065000;
  const m = 357.5291092 + 35999.0502909 * t - 0.0001536 * t * t + (t * t * t) / 24490000;
  const mp = 134.9633964 + 477198.8675055 * t + 0.0087414 * t * t + (t * t * t) / 69699 - t ** 4 / 14712000;
  const f = 93.272095 + 483202.0175233 * t - 0.0036539 * t * t - (t * t * t) / 3526000 + t ** 4 / 863310000;

  // 地球轨道偏心率带来的修正系数（Meeus 用 E 给含 M 的项加权）
  const e = 1 - 0.002516 * t - 0.0000074 * t * t;

  /** 每项：[D 系数, M 系数, M' 系数, F 系数, 正弦系数（10^-6 度）] */
  const terms: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [0, 0, 1, 0, 6288774],
    [2, 0, -1, 0, 1274027],
    [2, 0, 0, 0, 658314],
    [0, 0, 2, 0, 213618],
    [0, 1, 0, 0, -185116],
    [0, 0, 0, 2, -114332],
    [2, 0, -2, 0, 58793],
    [2, -1, -1, 0, 57066],
    [2, 0, 1, 0, 53322],
    [2, -1, 0, 0, 45758],
    [0, 1, -1, 0, -40923],
    [1, 0, 0, 0, -34720],
    [0, 1, 1, 0, -30383],
    [2, 0, 0, -2, 15327],
    [0, 0, 1, 2, -12528],
    [0, 0, 1, -2, 10980],
    [4, 0, -1, 0, 10675],
    [0, 0, 3, 0, 10034],
    [4, 0, -2, 0, 8548],
    [2, 1, -1, 0, -7888],
    [2, 1, 0, 0, -6766],
    [1, 0, -1, 0, -5163],
    [1, 1, 0, 0, 4987],
    [2, -1, 1, 0, 4036],
    [2, 0, 2, 0, 3994],
    [4, 0, 0, 0, 3861],
    [2, 0, -3, 0, 3665],
    [0, 1, -2, 0, -2689],
    [2, 0, -1, 2, -2602],
    [2, -1, -2, 0, 2390],
    [1, 0, 1, 0, -2348],
    [2, -2, 0, 0, 2236],
    [0, 1, 2, 0, -2120],
    [0, 2, 0, 0, -2069],
    [2, -2, -1, 0, 2048],
  ];

  let sum = 0;

  for (const [cd, cm, cmp, cf, coefficient] of terms) {
    // 含 M 的项按 E 加权（一阶 / 二阶）
    const eccentricityFactor = Math.abs(cm) === 1 ? e : Math.abs(cm) === 2 ? e * e : 1;
    const argument = cd * d + cm * m + cmp * mp + cf * f;

    sum += coefficient * eccentricityFactor * sinDeg(argument);
  }

  const longitude = lp + sum / 1_000_000;

  return normalizeDegrees(longitude);
};

// ============================================================================
// 行星（JPL/Standish 近似开普勒要素）
// ============================================================================

/**
 * 行星的轨道要素（J2000 历元，取自 JPL "Keplerian Elements for Approximate
 * Positions of the Major Planets"，**1800–2050 表**）
 *
 * 每行：`[a, e, i, L, 近日点黄经, 升交点黄经]` 与其**每世纪变化率**。
 * 单位：a 为天文单位，其余为度。
 *
 * ## ⚠ 不要去加"长期项"（血泪教训，2026-10 实测）
 *
 * JPL 那一页有**两张表**：1800–2050 表（本表）、以及 3000BC–3000AD 表。
 * 后者配有一组"木星到冥王星平均黄经附加项"（`ΔL = b·T² + c·cos(f·T) + s·sin(f·T)`，
 * 即 Table 2b）。**那组附加项只属于 3000BC–3000AD 表，不能加到本表上。**
 *
 * 我一开始加了，结果天王星偏 −0.87°、海王星偏 +0.67° —— 而且**自证式测试
 * 永远发现不了**（换座仍然照换，只是差几天；相位仍然照成，只是偏差大一度）。
 * 是拿 9 个公开换座/退回边界日期逐个对表才暴露出来的：
 *
 * | 天体 | 实测偏移 | 该附加项的量级 | 去掉后的残差 |
 * | ---- | -------- | -------------- | ------------ |
 * | 天王星 | −0.87° | −0.97° | **+0.10°** |
 * | 海王星 | +0.67° | +0.68° | **−0.01°** |
 * | 冥王星 | +0.03° | ≈0（只有 T² 项） | +0.03° |
 * | 木星 | +0.07° | −0.004° | +0.07° |
 * | 土星 | +0.12° | +0.013° | +0.12° |
 *
 * 偏移量与附加项一一对应，去掉后残差全部落在 ±0.12° 以内 —— 因此**本文件不实现
 * 任何长期项**。要动这里，先跑 `.runlogs/verify-planet-ingress.cjs` 对表。
 */
const PLANET_ELEMENTS: Readonly<Record<string, { base: readonly number[]; rate: readonly number[] }>> = {
  MERCURY: {
    base: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  },
  VENUS: {
    base: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rate: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  },
  EARTH: {
    base: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  },
  MARS: {
    base: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  },
  JUPITER: {
    base: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  },
  SATURN: {
    base: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  },
  URANUS: {
    base: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  },
  NEPTUNE: {
    base: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  },
  PLUTO: {
    base: [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
    rate: [-0.00031596, 0.0000517, 0.00004818, 145.20780515, -0.04062942, -0.01183482],
  },
};

/** 求解开普勒方程 `M = E − e·sin E`（牛顿迭代，弧度） */
const solveKepler = (meanAnomalyRad: number, eccentricity: number): number => {
  let eccentric = meanAnomalyRad;

  for (let index = 0; index < 12; index += 1) {
    const delta =
      (eccentric - eccentricity * Math.sin(eccentric) - meanAnomalyRad) / (1 - eccentricity * Math.cos(eccentric));
    eccentric -= delta;

    if (Math.abs(delta) < 1e-10) break;
  }

  return eccentric;
};

/** 某行星的**日心黄道坐标**（AU） */
const heliocentricPosition = (planet: string, t: number): { x: number; y: number; z: number } => {
  const element = PLANET_ELEMENTS[planet];
  if (element === undefined) throw new RangeError(`未知行星 ${planet}`);

  const a = element.base[0] + element.rate[0] * t;
  const e = element.base[1] + element.rate[1] * t;
  const inclination = element.base[2] + element.rate[2] * t;
  const meanLongitude = element.base[3] + element.rate[3] * t;
  const perihelion = element.base[4] + element.rate[4] * t;
  const node = element.base[5] + element.rate[5] * t;

  // ⚠ 这里**刻意不加** JPL 的"长期项"：那组附加项属于 3000BC–3000AD 表，
  // 加到本表（1800–2050）上会让天王星偏 −0.9°、海王星偏 +0.7°。详见上方注释。
  const meanAnomaly = normalizeDegrees(meanLongitude - perihelion);
  const eccentricAnomaly = solveKepler(meanAnomaly * DEG, e);

  // 轨道平面内的坐标
  const xOrbital = a * (Math.cos(eccentricAnomaly) - e);
  const yOrbital = a * Math.sqrt(1 - e * e) * Math.sin(eccentricAnomaly);

  const argumentOfPerihelion = perihelion - node;

  const cosArg = cosDeg(argumentOfPerihelion);
  const sinArg = sinDeg(argumentOfPerihelion);
  const cosNode = cosDeg(node);
  const sinNode = sinDeg(node);
  const cosInc = cosDeg(inclination);
  const sinInc = sinDeg(inclination);

  return {
    x:
      (cosArg * cosNode - sinArg * sinNode * cosInc) * xOrbital +
      (-sinArg * cosNode - cosArg * sinNode * cosInc) * yOrbital,
    y:
      (cosArg * sinNode + sinArg * cosNode * cosInc) * xOrbital +
      (-sinArg * sinNode + cosArg * cosNode * cosInc) * yOrbital,
    z: sinArg * sinInc * xOrbital + cosArg * sinInc * yOrbital,
  };
};

/**
 * 行星的**地心视黄经**（度，当日黄道）
 *
 * 做法：日心坐标相减得到地心向量 → 取黄经。**不含光行时改正**
 * （外行星最大影响约 0.02°，对星座与相位无影响）。
 */
export const planetLongitude = (planet: string, jd: number): number => {
  const t = julianCenturies(jd);

  const earth = heliocentricPosition('EARTH', t);
  const target = heliocentricPosition(planet, t);

  const dx = target.x - earth.x;
  const dy = target.y - earth.y;

  const longitude = atan2Deg(dy, dx);

  return normalizeDegrees(longitude + PRECESSION_PER_CENTURY * t);
};

// ============================================================================
// 上升点 / 天顶 / 宫位
// ============================================================================

/** 格林尼治平恒星时（度） */
export const greenwichSiderealTime = (jd: number): number => {
  const t = julianCenturies(jd);
  const sidereal = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - (t * t * t) / 38710000;

  return normalizeDegrees(sidereal);
};

/** 当地恒星时（度） */
export const localSiderealTime = (jd: number, longitude: number): number =>
  normalizeDegrees(greenwichSiderealTime(jd) + longitude);

/** 当日的黄赤交角（度，含岁差小改正） */
const obliquityOf = (t: number): number => OBLIQUITY_J2000 - 0.0130042 * t;

/**
 * 上升点黄经（度）
 *
 * 标准球面公式：以当地恒星时（RAMC）与地理纬度求黄道与地平线**东侧**的交点：
 *
 *     ASC = atan2( cos(RAMC), −( sin(RAMC)·cos ε + tan φ·sin ε ) )
 *
 * ⚠ **只与纬度有关、与经度无关**（经度已经体现在当地恒星时里）。
 *
 * ## 为什么注释里要写死这个公式
 *
 * 这里的符号错误是**看不出来**的：写成 `atan2(−cos, +(...))` 两个分量同时反号，
 * 结果恰好转 180°，返回的是**下降点**——页面上照样显示一个合法星座，
 * 只有拿物理事实去反验才会露馅。判据（`.runlogs/verify-astro.cjs` 已固化）：
 *
 *   · 上升点高度角必须 = 0°，且方位角 ≈ 90°（正东），再往前 1° 在地平线**下**；
 *   · **日出时刻上升点黄经 = 太阳黄经**（太阳此刻正从东边地平线升起，恒等式）；
 *   · 南半球纬度不能把结果镜像过去（纬度符号写错在北半球看不出来）。
 *
 * 高纬度（|φ| > 66°）时上升点会失去定义（极昼极夜），这里按 ±66° 截断 ——
 * 与其返回一个无意义的角度，不如给一个明确的可解释结果（调用方会标注）。
 */
export const ascendantLongitude = (lst: number, latitude: number, jd: number): number => {
  const t = julianCenturies(jd);
  const obliquity = obliquityOf(t);
  const phi = Math.max(-66, Math.min(66, latitude)) * DEG;
  const ramc = lst * DEG;

  const y = cosDeg(lst);
  const x = -(Math.sin(ramc) * cosDeg(obliquity) + Math.tan(phi) * sinDeg(obliquity));

  return normalizeDegrees(atan2Deg(y, x));
};

/** 天顶（MC）黄经（度） */
export const midheavenLongitude = (lst: number, jd: number): number => {
  const t = julianCenturies(jd);
  const obliquity = obliquityOf(t);

  return normalizeDegrees(atan2Deg(sinDeg(lst), cosDeg(lst) * cosDeg(obliquity)));
};

/**
 * 整宫制宫位（Whole Sign）
 *
 * ## 为什么第一版用整宫制而不是 Placidus
 *
 *   · **整宫制**：上升星座所在的那个星座即第 1 宫，其后每宫一个星座。
 *     规则简单、无迭代、不会在高纬度退化 —— 也是古典占星的标准做法；
 *   · **Placidus**：需要按半弧迭代求解，在高纬度（|φ| > 66°）无解，
 *     且各家实现差异不小。要做"专业级"就得先确认用哪一套，属于产品决策。
 *
 * 因此第一版给整宫制，并在响应里**明确标注宫位制**（`houseSystem: 'WHOLE_SIGN'`），
 * 不假装自己是 Placidus。真要做 Placidus 时替换本函数即可。
 */
export const wholeSignCusps = (ascendant: number): number[] => {
  const firstCusp = Math.floor(normalizeDegrees(ascendant) / 30) * 30;

  return Array.from({ length: 12 }, (_, index) => normalizeDegrees(firstCusp + index * 30));
};

// ============================================================================
// 相位
// ============================================================================

/** 主要相位定义（含容许度） */
export const MAJOR_ASPECTS: ReadonlyArray<{
  readonly key: string;
  readonly name: string;
  readonly symbol: string;
  readonly angle: number;
  readonly orb: number;
  /** 性质：和谐 / 紧张 / 中性（用于前端配色与文案口径） */
  readonly nature: 'HARMONIOUS' | 'TENSE' | 'NEUTRAL';
}> = [
  { key: 'CONJUNCTION', name: '合相', symbol: '☌', angle: 0, orb: 8, nature: 'NEUTRAL' },
  { key: 'SEXTILE', name: '六合', symbol: '⚹', angle: 60, orb: 4, nature: 'HARMONIOUS' },
  { key: 'SQUARE', name: '刑相', symbol: '□', angle: 90, orb: 6, nature: 'TENSE' },
  { key: 'TRINE', name: '拱相', symbol: '△', angle: 120, orb: 6, nature: 'HARMONIOUS' },
  { key: 'OPPOSITION', name: '冲相', symbol: '☍', angle: 180, orb: 8, nature: 'TENSE' },
];

/** 一条相位 */
export interface AspectHit {
  readonly from: string;
  readonly to: string;
  readonly key: string;
  readonly name: string;
  readonly symbol: string;
  readonly nature: 'HARMONIOUS' | 'TENSE' | 'NEUTRAL';
  /** 实际角度差（0–180） */
  readonly separation: number;
  /** 与精确相位的偏差（度，越小越强） */
  readonly orb: number;
}

/**
 * 计算一组天体之间的主要相位
 *
 * @param positions 键为天体编码、值为黄经（度）
 */
export const findAspects = (positions: Readonly<Record<string, number>>): AspectHit[] => {
  const keys = Object.keys(positions);
  const hits: AspectHit[] = [];

  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const from = keys[i];
      const to = keys[j];

      const raw = Math.abs(normalizeDegrees(positions[from] - positions[to]));
      const separation = raw > 180 ? 360 - raw : raw;

      for (const aspect of MAJOR_ASPECTS) {
        const orb = Math.abs(separation - aspect.angle);

        if (orb <= aspect.orb) {
          hits.push({
            from,
            to,
            key: aspect.key,
            name: aspect.name,
            symbol: aspect.symbol,
            nature: aspect.nature,
            separation: Math.round(separation * 100) / 100,
            orb: Math.round(orb * 100) / 100,
          });
          break;
        }
      }
    }
  }

  // 越接近精确相位越"强"，排前面
  return hits.sort((a, b) => a.orb - b.orb);
};

// ============================================================================
// 星座与宫位归属
// ============================================================================

/** 黄经 → 星座序号（0 = 白羊） */
export const signIndexOf = (longitude: number): number => Math.floor(normalizeDegrees(longitude) / 30);

/** 黄经在星座内的度数（0–30） */
export const degreeInSign = (longitude: number): number => Math.round((normalizeDegrees(longitude) % 30) * 100) / 100;
