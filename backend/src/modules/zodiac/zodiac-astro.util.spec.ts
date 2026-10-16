/**
 * 星盘天文计算的**正确性**测试
 *
 * ## 为什么这层必须用"外部事实"来测，而不是用"自己算一遍"
 *
 * 行星位置算错了**不会报错**、也不会崩溃：页面上照样显示"水星在天蝎座"，
 * 用户永远不知道真正的答案是"水星在天秤座"。所以断言不能来自本模块自身
 * 的输出（那是自证），只能来自**与实现无关的公开事实**：
 *
 *   ① **节气**：太阳过 0°/90°/180° 的时刻是逐年公开可查的；
 *   ② **外行星换座**：几年一遇的公开事件（土星 2026 全年在白羊、木星 2026-06-30 进狮子）；
 *   ③ **朔望月**：新月时日月黄经差应为 0°；
 *   ④ **物理恒等式**：上升点必须压在东边地平线上，且**日出时刻上升点黄经 = 太阳黄经**；
 *   ⑤ **交叉印证**：印度占星（恒星黄道）2026-10 木星处"巨蟹末–狮子初"交界带，
 *      换算回回归黄道应落在狮子座中后段 —— 与本模块独立求解的结果互为来源。
 *
 * ## 已经抓到过的真实 bug（留在这里防止回退）
 *
 * 上升点公式原写作 `atan2(−cos(RAMC), +(…))`，两个分量同时反号，结果**恰好转 180°**，
 * 返回的是**下降点**。它在"落在 0–360 之间""高度角 = 0°"这类弱断言下**全部通过**，
 * 只有第 ④ 类物理判据（方位角在东半圈、日出恒等式）才暴露出来。
 */

import {
  ascendantLongitude,
  degreeInSign,
  findAspects,
  greenwichSiderealTime,
  julianCenturies,
  julianDay,
  localSiderealTime,
  midheavenLongitude,
  moonLongitude,
  normalizeDegrees,
  planetLongitude,
  resolveTimezoneOffset,
  signIndexOf,
  sunLongitude,
  wholeSignCusps,
} from './zodiac-astro.util';

const DEG = Math.PI / 180;
const EPSILON_J2000 = 23.4392911 * DEG;

/** 本轮全部断言共用的参考时刻：2026-10-16 12:00 北京时间（UTC 04:00） */
const REFERENCE_JD = julianDay(2026, 10, 16, 4);

/** 黄经 → 星座序号（0 = 白羊） */
const signOf = (longitude: number): number => signIndexOf(longitude);

/** 黄经 → 赤经/赤纬（度）。刻意走与上升点公式无关的换算路径，用于反验。 */
const toEquatorial = (longitude: number): { ra: number; dec: number } => {
  const ra = normalizeDegrees(
    Math.atan2(Math.sin(longitude * DEG) * Math.cos(EPSILON_J2000), Math.cos(longitude * DEG)) / DEG,
  );
  const dec = Math.asin(Math.sin(longitude * DEG) * Math.sin(EPSILON_J2000)) / DEG;

  return { ra, dec };
};

/** 地平坐标：高度角与方位角（度，正北 = 0，顺时针向东） */
const horizontal = (longitude: number, lst: number, latitude: number): { alt: number; azimuth: number } => {
  const { ra, dec } = toEquatorial(longitude);
  const hourAngle = (lst - ra) * DEG;
  const alt =
    Math.asin(
      Math.sin(latitude * DEG) * Math.sin(dec * DEG) +
        Math.cos(latitude * DEG) * Math.cos(dec * DEG) * Math.cos(hourAngle),
    ) / DEG;
  const azimuth = normalizeDegrees(
    Math.atan2(
      -Math.cos(dec * DEG) * Math.sin(hourAngle),
      Math.sin(dec * DEG) * Math.cos(latitude * DEG) -
        Math.cos(dec * DEG) * Math.sin(latitude * DEG) * Math.cos(hourAngle),
    ) / DEG,
  );

  return { alt, azimuth };
};

describe('太阳黄经：二分二至（公开可查的节气时刻）', () => {
  it.each<[string, number, number, number, number, number]>([
    ['2026 春分 03-20 14:46 UTC', 2026, 3, 20, 14.77, 0],
    ['2026 夏至 06-21 08:24 UTC', 2026, 6, 21, 8.4, 90],
    ['2026 秋分 09-23 00:05 UTC', 2026, 9, 23, 0.1, 180],
    ['2000 春分 03-20 07:35 UTC', 2000, 3, 20, 7.6, 0],
  ])('%s 时刻太阳黄经落在节气点上（±0.05°）', (_label, year, month, day, hour, expected) => {
    const actual = sunLongitude(julianDay(year, month, day, hour));
    const delta = Math.abs(normalizeDegrees(actual - expected + 180) - 180);

    // 节气时刻本身有几分钟的公开误差，对应太阳约 0.01–0.04°/分钟
    expect(delta).toBeLessThan(0.05);
  });
});

describe('外行星黄经：对照公开的换座事实', () => {
  /**
   * 【回归】换座边界日期对照
   *
   * 这一组是**发现过真实 bug 的用例**：我曾把 JPL 3000BC–3000AD 表才有的
   * "长期项"加到了 1800–2050 表上，导致天王星偏 −0.87°、海王星偏 +0.67°。
   * 当时所有自证式测试（符号对不对、快慢对不对、相位成不成）**全部通过**，
   * 只有拿这些公开的换座/退回边界日期逐个对表才暴露出来。
   *
   * 行星在这些日期应当正好压在星座边界（0°00′）上，容差 0.15°（约 9′）。
   */
  it.each<[string, number, number, number, number]>([
    // 冥王星
    ['PLUTO', 1983, 11, 6, 210],
    ['PLUTO', 1995, 11, 10, 240],
    ['PLUTO', 2008, 1, 26, 270],
    ['PLUTO', 2024, 11, 19, 300],
    // 海王星（含"先探入 → 逆行退回 → 再正式进入"的三次边界）
    ['NEPTUNE', 1998, 1, 29, 300],
    ['NEPTUNE', 2011, 4, 4, 330],
    ['NEPTUNE', 2025, 3, 30, 360],
    ['NEPTUNE', 2025, 10, 22, 360],
    ['NEPTUNE', 2026, 1, 26, 360],
    // 天王星
    ['URANUS', 2018, 5, 15, 30],
    ['URANUS', 2018, 11, 6, 30],
    ['URANUS', 2019, 3, 6, 30],
    ['URANUS', 2026, 4, 26, 60],
    // 土星与木星（作为同一代码路径的量级参考）
    ['SATURN', 2025, 5, 25, 0],
    ['JUPITER', 2026, 6, 30, 120],
  ])('%s 在 %i-%i-%i 应压在 %i° 换座边界上（±0.15°）', (planet, year, month, day, boundary) => {
    const actual = planetLongitude(planet, julianDay(year, month, day, 12));
    const delta = Math.abs(normalizeDegrees(actual - boundary + 180) - 180);

    expect(delta).toBeLessThan(0.15);
  });

  it('【回归】天王星/海王星不带 JPL 的"长期项"（加回去会让它们各偏约 1°）', () => {
    // 直接校验两个已知会出问题的时刻，避免有人"顺手补全"公式
    const uranus = planetLongitude('URANUS', julianDay(2019, 3, 6, 12));
    const neptune = planetLongitude('NEPTUNE', julianDay(2026, 1, 26, 12));

    expect(Math.abs(normalizeDegrees(uranus - 30 + 180) - 180)).toBeLessThan(0.1);
    expect(Math.abs(normalizeDegrees(neptune - 360 + 180) - 180)).toBeLessThan(0.1);
  });

  const positions = {
    JUPITER: planetLongitude('JUPITER', REFERENCE_JD),
    SATURN: planetLongitude('SATURN', REFERENCE_JD),
    URANUS: planetLongitude('URANUS', REFERENCE_JD),
    NEPTUNE: planetLongitude('NEPTUNE', REFERENCE_JD),
    PLUTO: planetLongitude('PLUTO', REFERENCE_JD),
  };

  it.each<[string, number]>([
    ['SATURN', 0], // 白羊：2025-05 进入，2026 全年在白羊
    ['NEPTUNE', 0], // 白羊：2026-01-26 进入
    ['URANUS', 2], // 双子：2026-04-26 进入
    ['JUPITER', 4], // 狮子：2026-06-30 进入
    ['PLUTO', 10], // 水瓶：2024-11 进入，直到 2043
  ])('%s 落在 2026 年公开事实对应的星座里', (planet, expectedSign) => {
    expect(signOf(positions[planet as keyof typeof positions])).toBe(expectedSign);
  });

  it('【交叉印证】木星的恒星黄经落在巨蟹末–狮子初的交界带', () => {
    // 独立来源（印度占星）：2026-10 木星处 "Gandantha between Karkataka and Simha"，
    // 即恒星黄道巨蟹末尾；换算回回归黄道 = 恒星 + 岁差（2026 年约 24.2°）
    const sidereal = normalizeDegrees(positions.JUPITER - 24.2);

    expect(sidereal).toBeGreaterThan(105);
    expect(sidereal).toBeLessThan(135);
  });

  it('外行星日行速度都在"慢行星"量级（防止黄经项多算/少算整圈）', () => {
    // 外行星一年中有几个月在逆行，所以只能比"量级"，不能比固定数值。
    // 这里要求：任何一天的速度都在 ±0.3°/日 以内（慢行星最快也就 0.25°/日 左右）。
    for (const planet of ['JUPITER', 'SATURN', 'URANUS', 'NEPTUNE', 'PLUTO']) {
      const raw = normalizeDegrees(planetLongitude(planet, REFERENCE_JD + 1) - planetLongitude(planet, REFERENCE_JD));
      const signed = raw > 180 ? raw - 360 : raw;

      expect(Math.abs(signed)).toBeLessThan(0.3);
    }
  });

  it('木星 2026-10 顺行且速度正常（远离"留"，落在 0.02–0.25°/日）', () => {
    const daily = normalizeDegrees(
      planetLongitude('JUPITER', REFERENCE_JD + 1) - planetLongitude('JUPITER', REFERENCE_JD),
    );

    expect(daily).toBeGreaterThan(0.02);
    expect(daily).toBeLessThan(0.25);
  });

  it('行星不会因为误差被算到隔壁星座（对慢行星给出整宫级容差说明）', () => {
    // 木星刚进狮子不到 4 个月，离 0° 边界还有 22°，即使有 1° 误差也不会翻星座；
    // 这里顺带确认海王星（刚进白羊 9 个月、约 3°）确实已经过界 —— 二者都是公开事实。
    expect(degreeInSign(positions.JUPITER)).toBeGreaterThan(15);
    expect(degreeInSign(positions.NEPTUNE)).toBeLessThan(10);
  });
});

describe('月亮与朔望月', () => {
  it('新月时刻日月黄经差接近 0°（2026-01-18 公开新月）', () => {
    const jd = julianDay(2026, 1, 18, 19.87);
    const elongation = normalizeDegrees(moonLongitude(jd) - sunLongitude(jd));
    const diff = elongation > 180 ? 360 - elongation : elongation;

    expect(diff).toBeLessThan(5);
  });

  it('月亮日行速度在 11.8–15.4° 之间（平均 13.18°）', () => {
    const daily = normalizeDegrees(moonLongitude(REFERENCE_JD + 1) - moonLongitude(REFERENCE_JD));

    expect(daily).toBeGreaterThan(11.8);
    expect(daily).toBeLessThan(15.4);
  });

  it('月亮一个月内会走遍十二个星座（否则项数被截断太多）', () => {
    const signs = new Set<number>();

    for (let day = 0; day < 30; day += 1) {
      signs.add(signOf(moonLongitude(REFERENCE_JD + day)));
    }

    expect(signs.size).toBeGreaterThanOrEqual(11);
  });
});

describe('上升点与天顶：物理反验（当前实现已修复 180° 反向 bug）', () => {
  const sampleJd = julianDay(2000, 1, 1, 4); // 2000-01-01 12:00 北京时间
  const latitude = 39.9; // 北京
  const lst = localSiderealTime(sampleJd, 116.41);
  const ascendant = ascendantLongitude(lst, latitude, sampleJd);
  const midheaven = midheavenLongitude(lst, sampleJd);

  it('【关键】上升点高度角 = 0°（确实在地平线上）', () => {
    expect(Math.abs(horizontal(ascendant, lst, latitude).alt)).toBeLessThan(0.05);
  });

  it('【关键】上升点位于东半圈 —— 返回下降点是同类 bug 的典型表现', () => {
    const { azimuth } = horizontal(ascendant, lst, latitude);

    expect(azimuth).toBeGreaterThan(0);
    expect(azimuth).toBeLessThan(180);
  });

  it('上升点偏离正东不超过 25°（黄道与地平圈斜交，不是 90° 是正常的）', () => {
    const { azimuth } = horizontal(ascendant, lst, latitude);

    expect(Math.abs(azimuth - 90)).toBeLessThan(25);
  });

  it('【关键】上升点之后 1° 落在地平线下（性质是"升起"而不是"落下"）', () => {
    expect(horizontal(normalizeDegrees(ascendant + 1), lst, latitude).alt).toBeLessThan(0);
  });

  it('【关键】日出时刻上升点黄经 = 太阳黄经（与所有公式无关的物理恒等式）', () => {
    const sun = sunLongitude(sampleJd);
    const { ra, dec } = toEquatorial(sun);
    // 太阳高度角 = 0 时的时角（取东侧分支，即负时角）
    const cosHourAngle = -Math.tan(latitude * DEG) * Math.tan(dec * DEG);
    const hourAngleAtSunrise = -Math.acos(Math.max(-1, Math.min(1, cosHourAngle))) / DEG;
    const lstAtSunrise = normalizeDegrees(ra + hourAngleAtSunrise);
    const delta = Math.abs(normalizeDegrees(ascendantLongitude(lstAtSunrise, latitude, sampleJd) - sun + 180) - 180);

    expect(delta).toBeLessThan(0.05);
  });

  it('天顶位于子午线上（时角 = 0°）', () => {
    const { ra } = toEquatorial(midheaven);
    const hourAngle = Math.abs(normalizeDegrees(lst - ra + 180) - 180);

    expect(hourAngle).toBeLessThan(0.05);
  });

  it('天顶高度角 = 90 − |纬度 − 赤纬|（上中天的标准几何关系）', () => {
    const { dec } = toEquatorial(midheaven);
    const expected = 90 - Math.abs(latitude - dec);

    expect(Math.abs(horizontal(midheaven, lst, latitude).alt - expected)).toBeLessThan(0.05);
  });

  it('上升点与天顶的黄经距离（劣弧）落在 60–120°', () => {
    const arc = Math.abs(normalizeDegrees(midheaven - ascendant + 180) - 180);

    expect(arc).toBeGreaterThan(60);
    expect(arc).toBeLessThan(120);
  });

  it('南半球纬度不会把上升点镜像（纬度符号写错在北半球看不出来）', () => {
    const lstSydney = localSiderealTime(sampleJd, 151.21);
    const ascSydney = ascendantLongitude(lstSydney, -33.87, sampleJd);

    expect(Math.abs(horizontal(ascSydney, lstSydney, -33.87).alt)).toBeLessThan(0.05);
    // 同刻同半球不同纬度，上升点不应完全一致
    expect(Math.abs(ascSydney - ascendant)).toBeGreaterThan(5);
  });

  it('同刻不同经度 → 上升点不同（经度通过恒星时生效）', () => {
    const ascShanghai = ascendantLongitude(localSiderealTime(sampleJd, 121.47), 31.23, sampleJd);

    expect(Math.abs(ascShanghai - ascendant)).toBeGreaterThan(1);
  });

  it('高纬度被夹取而非返回 NaN（极昼极夜时上升点无定义）', () => {
    const arctic = ascendantLongitude(lst, 78.2, sampleJd);

    expect(Number.isFinite(arctic)).toBe(true);
    expect(arctic).toBeGreaterThanOrEqual(0);
    expect(arctic).toBeLessThan(360);
  });
});

describe('恒星时与时区', () => {
  it('格林尼治恒星时在 J2000.0 历元约 280.46°', () => {
    expect(Math.abs(normalizeDegrees(greenwichSiderealTime(2451545.0) - 280.46))).toBeLessThan(0.1);
  });

  it('一处恒星时每天比太阳时快约 3 分 57 秒（0.9856°）', () => {
    const day1 = greenwichSiderealTime(REFERENCE_JD);
    const day2 = greenwichSiderealTime(REFERENCE_JD + 1);
    // 注意：恒星时一天走 360.9856°，取 360 的余数后应约等于 0.9856°
    const gain = normalizeDegrees(day2 - day1);

    expect(Math.abs(gain - 0.9856)).toBeLessThan(0.01);
  });

  it('中国 1986–1991 年夏令时窗口会被识别（不识别会让上升点整体错一个小时）', () => {
    // 1988-07-01 属于 1988-04-10 → 09-11 的夏令时窗口
    expect(resolveTimezoneOffset(1988, 7, 1)).toBe(9);
    // 同一天的冬季不属于窗口
    expect(resolveTimezoneOffset(1988, 12, 1)).toBe(8);
    // 窗口边界：开始日当天算夏令时，结束日之后不算
    expect(resolveTimezoneOffset(1988, 4, 10)).toBe(9);
    expect(resolveTimezoneOffset(1988, 9, 12)).toBe(8);
    // 窗口之外（1992 年）不再有夏令时
    expect(resolveTimezoneOffset(1992, 7, 1)).toBe(8);
  });

  it('【关键】传入的城市标准时区 +8 同样要叠加夏令时（否则两条路径算出的上升点会差 12°）', () => {
    // 城市表里北京存的是标准时区 +8；它**不能**被当成"最终偏移"而跳过夏令时判定。
    // 端到端探针抓到过这个缺陷：走"存过经纬度"与"只存了城市名"两条路，上升点差 12°。
    expect(resolveTimezoneOffset(1988, 7, 1, 8)).toBe(9);
    expect(resolveTimezoneOffset(1988, 12, 1, 8)).toBe(8);
    expect(resolveTimezoneOffset(1992, 7, 1, 8)).toBe(8);
  });

  it('其他标准时区不适用中国的夏令时（1988 年 7 月的东京不能多加 1 小时）', () => {
    expect(resolveTimezoneOffset(1988, 7, 1, 9)).toBe(9);
    expect(resolveTimezoneOffset(1995, 7, 1, 5.5)).toBe(5.5);
    expect(resolveTimezoneOffset(1988, 7, 1, -5)).toBe(-5);
  });

  it('非法或缺失的标准时区按中国 +8 处理', () => {
    expect(resolveTimezoneOffset(1995, 7, 1, null)).toBe(8);
    expect(resolveTimezoneOffset(1995, 7, 1, undefined)).toBe(8);
    expect(resolveTimezoneOffset(1995, 7, 1, Number.NaN)).toBe(8);
  });

  it('儒略世纪数与 J2000.0 历元一致', () => {
    expect(julianCenturies(2451545.0)).toBe(0);
  });
});

describe('整宫制宫位与相位', () => {
  it('整宫制：第 1 宫起点 = 上升星座 0°，每宫一个星座', () => {
    const cusps = wholeSignCusps(11.13);

    expect(cusps).toHaveLength(12);
    expect(cusps[0]).toBe(0); // 白羊 0°
    expect(cusps[1]).toBe(30);
    expect(cusps[11]).toBe(330);
  });

  it('整宫制：上升点落在星座末度时宫位起点仍是该星座 0°', () => {
    expect(wholeSignCusps(29.9)[0]).toBe(0);
    expect(wholeSignCusps(30.1)[0]).toBe(30);
  });

  it('相位：日月合相（0°）会被识别，且带容许度与类型', () => {
    const aspects = findAspects({ SUN: 100, MOON: 103 });

    expect(aspects).toHaveLength(1);
    expect(aspects[0].key).toBe('CONJUNCTION');
    expect(aspects[0].orb).toBe(3);
  });

  it('相位：超出容许度不算相位', () => {
    // 合相容许度 8°，差 9° 不应命中
    expect(findAspects({ SUN: 100, MOON: 109 })).toHaveLength(0);
  });

  it('相位：90° 与 270° 都算刑相（相位是角距，不分方向）', () => {
    expect(findAspects({ A: 10, B: 100 })[0].key).toBe('SQUARE');
    expect(findAspects({ A: 10, B: 280 })[0].key).toBe('SQUARE');
  });

  it('相位：跨 0° 的角距按最短弧计算', () => {
    // 358° 与 2° 只差 4°，是合相；350° 与 170° 差 180°，是对冲
    expect(findAspects({ A: 358, B: 2 })[0].key).toBe('CONJUNCTION');
    expect(findAspects({ A: 350, B: 170 })[0].key).toBe('OPPOSITION');
  });

  it('相位：行星自身不与自己成相', () => {
    expect(findAspects({ SUN: 42 })).toHaveLength(0);
  });

  it('相位按角距升序返回（前端直接铺列表，不需要再排）', () => {
    const aspects = findAspects({ SUN: 0, MOON: 92, MERCURY: 179 });
    const orbs = aspects.map((aspect) => aspect.orb);

    expect(orbs).toHaveLength(3);
    expect([...orbs].sort((left, right) => left - right)).toEqual(orbs);
  });
});
