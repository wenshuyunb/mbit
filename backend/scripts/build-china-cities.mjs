/**
 * 生成中国行政区城市表（地级市 + 县级）
 *
 * ## 为什么要用生成的方式，而不是手写城市表
 *
 * 用户的反馈是「选择城市没有我出生的城市（福建龙岩武平县）」。
 * 我原来的城市表是**手写**的，只有 106 个城市（福建只写了福州/厦门/泉州）——
 * 这种写法的问题是：中国有 333 个地级市、约 2800 个县级单位，
 * 靠人工补永远补不全，而且**手写经纬度必然出错**。
 *
 * 所以这里改成**从公开数据集生成**：
 *
 * | 项     | 值                                                                  |
 * | ------ | ------------------------------------------------------------------- |
 * | 来源   | GeoNames `CN.zip`（<https://download.geonames.org/export/dump/CN.zip>） |
 * | 许可   | Creative Commons Attribution 4.0（可商用，需署名 —— 见生成文件头）    |
 * | 坐标系 | WGS-84                                                              |
 * | 覆盖   | 省级 31 / 地级 360 / 县级 2938                                       |
 *
 * ## 取哪几级、为什么
 *
 * 上升星座只取决于**经度**（经度通过地方恒星时生效），而 1° 经度 ≈ 4 分钟时间
 * ≈ 上升点移动 1° 左右。星座一个 30°，所以**地级市精度已经绰绰有余**
 * （武平县与龙岩市区经度差 0.51°，上升点差不到 1°）。
 * 但用户会想选到自己熟悉的那一级，因此**地级市与县级都收进来**：
 * 县级用自己独立的坐标，比用地级市还准。
 *
 * ## 直辖市与港澳台
 *
 * 北京/上海/天津/重庆在 GeoNames 里是**省级**（ADM1），不是地级市，因此单独补入；
 * 港澳台与海外城市不属于 CN 数据集，继续由 `zodiac-city.data.ts` 手工维护。
 *
 * 用法：`node scripts/build-china-cities.mjs`
 * 前置：把 CN.zip 解到 `backend/.runlogs/geonames-cn/CN.txt`
 */

import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', '.runlogs', 'geonames-cn', 'CN.txt');
const TRADITIONAL_MAP = join(HERE, '..', '.runlogs', 'TSCharacters.txt');
const TARGET = join(HERE, '..', 'src', 'modules', 'zodiac', 'zodiac-city-china.generated.ts');

/** 直辖市：在 GeoNames 里是 ADM1，需要按城市补入 */
const MUNICIPALITIES = new Set(['北京', '上海', '天津', '重庆']);

/** 新疆：当地习惯用「新疆时间」（UTC+6），需要额外标注 */
const XINJIANG_ALT_OFFSET = 6;

/** GeoNames 列序 */
const C = {
  name: 1,
  ascii: 2,
  alternates: 3,
  latitude: 4,
  longitude: 5,
  featureCode: 7,
  admin1: 10,
  admin2: 11,
  admin3: 12,
  population: 14,
};

/**
 * 繁体/异体字 → 简体 的字符映射（OpenCC `TSCharacters.txt`，Apache-2.0）
 *
 * ## 为什么必须做这一步
 *
 * GeoNames 的中文名里混着**繁体、异体字甚至日文汉字**，实测踩到的是省份名：
 *
 * | GeoNames 里的写法 | 用户会输入的写法 |
 * | ----------------- | ---------------- |
 * | `甘粛省`（粛）     | 甘肃             |
 * | `貴州省`（貴）     | 贵州             |
 * | `內蒙古`（內）     | 内蒙古           |
 * | `黑龍江`（龍）     | 黑龙江           |
 *
 * 不归一化的话，这几个省份**一个字都搜不到** —— 与用户报的
 * 「找不到我出生的城市」是同一类缺陷，只是藏得更深（要输对繁体才行）。
 *
 * ## 两个必须手工兜住的坑（第一次生成时都踩到了）
 *
 *   ① **一对多误伤**：OpenCC 把「乾」映射成「干」（乾燥→干燥），
 *      于是 **乾县（陕西）变成了"干县"** —— 地名里「乾」本来就是正字。
 *      因此下面有 `SIMPLIFY_EXCEPTIONS` 明确禁止转换这些字。
 *   ② **日文汉字没被覆盖**：`徳欽県`/`広東` 这类写法 OpenCC 的繁简表管不到，
 *      结果是"半截垃圾名"（`徳钦県`、`広东`），同样搜不到。
 *      因此补 `EXTRA_SIMPLIFY`。
 *
 * ⚠ 生成后必须把**改动清单打印出来人工过一眼** —— 这种缺陷不会报错，
 * 只会让一小撮地名静默搜不到。
 */

/** 明确**不转换**的字：地名里的正字，误转会造出不存在的地名 */
const SIMPLIFY_EXCEPTIONS = new Set(['乾']);

/** 繁简表覆盖不到的字（日文汉字/异体字），实测出现过的 */
const EXTRA_SIMPLIFY = new Map([
  ['県', '县'],
  ['徳', '德'],
  ['広', '广'],
  ['黒', '黑'],
  ['竜', '龙'],
  ['粛', '肃'],
]);

/**
 * 省份全称的人工订正
 *
 * GeoNames 的部分一级行政区**只有简称**（例如甘肃只写了 `甘肅`、黑龙江只写了 `黑龍江`），
 * 按"简称 + 省"兜底会造出错误的全称（内蒙古会变成"内蒙古省"，而它是自治区）。
 * 因此这里显式列出订正表；生成时会打印全部 31 个省份供人工核对。
 */
const PROVINCE_FULL_OVERRIDES = new Map([
  ['甘肃', '甘肃省'],
  ['黑龙江', '黑龙江省'],
  ['内蒙古', '内蒙古自治区'],
  ['宁夏', '宁夏回族自治区'],
  ['广西', '广西壮族自治区'],
  ['新疆', '新疆维吾尔自治区'],
  ['西藏', '西藏自治区'],
]);

const loadSimplifier = () => {
  if (!existsSync(TRADITIONAL_MAP)) {
    console.warn(`⚠ 未找到繁简映射表 ${TRADITIONAL_MAP}，将跳过繁简归一化（部分省份可能搜不到）`);

    return (value) => value;
  }

  const map = new Map();

  for (const line of readFileSync(TRADITIONAL_MAP, 'utf8').split('\n')) {
    if (line.startsWith('#') || line.trim().length === 0) continue;

    const [traditional, simplifiedList] = line.split('\t');
    const simplified = (simplifiedList ?? '').trim().split(/\s+/)[0];

    if (
      traditional?.length === 1 &&
      simplified !== undefined &&
      simplified.length === 1 &&
      traditional !== simplified
    ) {
      map.set(traditional, simplified);
    }
  }

  return (value) =>
    [...value]
      .map((char) => {
        if (SIMPLIFY_EXCEPTIONS.has(char)) return char;

        return EXTRA_SIMPLIFY.get(char) ?? map.get(char) ?? char;
      })
      .join('');
};

/** 从 alternates 里挑中文名（只要纯汉字，2–12 字），并归一化为简体 */
const makeChineseNames = (simplify) => (alternates) =>
  (alternates ?? '')
    .split(',')
    .map((item) => simplify(item.trim()))
    .filter((item) => /^[\u4e00-\u9fa5]{2,12}$/.test(item));

/** 行政区通名后缀，用于挑"最像正式名"的那个（龙岩市 优于 龙岩） */
const OFFICIAL_SUFFIX = /(市|自治州|地区|盟|自治县|县|区|旗|林区|特区)$/;

const pickName = (names) => {
  const official = names.find((item) => OFFICIAL_SUFFIX.test(item));

  return official ?? names[0] ?? null;
};

const round4 = (value) => Math.round(value * 10000) / 10000;

const main = async () => {
  if (!existsSync(SOURCE)) {
    console.error(
      `找不到数据源：${SOURCE}\n请先下载并解压：Invoke-WebRequest https://download.geonames.org/export/dump/CN.zip -OutFile CN.zip; Expand-Archive CN.zip geonames-cn`,
    );

    process.exitCode = 1;

    return;
  }

  /** 省级：代码 → { 简称, 全称 } */
  const provinces = new Map();
  /** 地级：代码 → { name, provinceCode, lat, lng, pinyin } */
  const prefectures = new Map();
  /** 县级：直接收集，最后再挂到地级上 */
  const counties = [];
  /** 被繁简归一化改动过的名字（生成后打印出来人工过一眼） */
  const simplified = new Map();

  const simplify = loadSimplifier();
  const chineseNames = makeChineseNames((value) => {
    const converted = simplify(value);
    if (converted !== value) simplified.set(value, converted);

    return converted;
  });

  const reader = createInterface({ input: createReadStream(SOURCE), crlfDelay: Infinity });

  for await (const line of reader) {
    const parts = line.split('\t');
    const code = parts[C.featureCode];

    if (code === 'ADM1') {
      const names = chineseNames(parts[C.alternates]);
      if (names.length === 0) continue;

      const full = names.find((item) => item.length > 2) ?? names[0];
      const short = names.reduce((best, item) => (item.length < best.length ? item : best), names[0]);
      const override = PROVINCE_FULL_OVERRIDES.get(short);

      provinces.set(parts[C.admin1], {
        short,
        full: override ?? (full.startsWith(short) && full !== short ? full : `${short}省`),
        latitude: round4(Number(parts[C.latitude])),
        longitude: round4(Number(parts[C.longitude])),
      });

      continue;
    }

    if (code === 'ADM2') {
      const names = chineseNames(parts[C.alternates]);
      if (names.length === 0) continue;

      prefectures.set(parts[C.admin2], {
        name: pickName(names),
        provinceCode: parts[C.admin1],
        latitude: round4(Number(parts[C.latitude])),
        longitude: round4(Number(parts[C.longitude])),
        pinyin: (parts[C.ascii] ?? '').toLowerCase(),
        population: Number(parts[C.population]) || 0,
      });

      continue;
    }

    if (code === 'ADM3') {
      const names = chineseNames(parts[C.alternates]);
      if (names.length === 0) continue;

      counties.push({
        name: pickName(names),
        parentCode: parts[C.admin2],
        latitude: round4(Number(parts[C.latitude])),
        longitude: round4(Number(parts[C.longitude])),
        population: Number(parts[C.population]) || 0,
      });
    }
  }

  /** 组装输出：先地级市（含直辖市），再县级 */
  const rows = [];
  const seen = new Set();

  const push = (name, province, latitude, longitude, level, pinyin, hint, population) => {
    const key = `${name}|${province}`;
    if (seen.has(key)) return;

    seen.add(key);
    rows.push({ name, region: province, latitude, longitude, level, pinyin, hint, population });
  };

  for (const [, prefecture] of prefectures) {
    const province = provinces.get(prefecture.provinceCode);
    if (province === undefined) continue;

    // 直辖市在 GeoNames 里是 ADM1，它们的"地级"层是各区，不适合作为出生地选项
    push(
      prefecture.name,
      province.full,
      prefecture.latitude,
      prefecture.longitude,
      'PREFECTURE',
      prefecture.pinyin,
      province.short === '新疆' ? XINJIANG_ALT_OFFSET : null,
      prefecture.population,
    );
  }

  for (const [, province] of provinces) {
    if (!MUNICIPALITIES.has(province.short)) continue;

    push(province.full, province.full, province.latitude, province.longitude, 'PREFECTURE', '', null, 0);
  }

  let orphanCounties = 0;
  for (const county of counties) {
    const prefecture = prefectures.get(county.parentCode);
    if (prefecture === undefined) {
      orphanCounties += 1;
      continue;
    }

    const province = provinces.get(prefecture.provinceCode);
    if (province === undefined) continue;

    // 与上级同名的县级条目（如某些"龙岩县"历史条目）跳过，避免搜索结果里出现两个"龙岩"
    if (county.name === prefecture.name) continue;

    push(
      county.name,
      `${province.full}${prefecture.name}`,
      county.latitude,
      county.longitude,
      'COUNTY',
      '',
      province.short === '新疆' ? XINJIANG_ALT_OFFSET : null,
      county.population,
    );
  }

  const lines = rows.map((row) => {
    const hint = row.hint === null ? 'null' : String(row.hint);
    const pinyin = row.pinyin === undefined || row.pinyin === '' ? "''" : `'${row.pinyin.replace(/'/g, "\\'")}'`;

    return `  ['${row.name.replace(/'/g, "\\'")}', '${row.region.replace(/'/g, "\\'")}', ${row.latitude}, ${row.longitude}, '${row.level}', ${pinyin}, ${hint}, ${row.population}],`;
  });

  const content = `/**
 * 中国行政区城市表（**自动生成，请勿手改**）
 *
 * 生成命令：\`node scripts/build-china-cities.mjs\`
 *
 * | 项     | 值                                                                     |
 * | ------ | ---------------------------------------------------------------------- |
 * | 来源   | GeoNames \`CN.zip\`（<https://download.geonames.org/export/dump/CN.zip>） |
 * | 许可   | Creative Commons Attribution 4.0（署名：GeoNames.org）                   |
 * | 坐标系 | WGS-84                                                                 |
 * | 生成于 | ${new Date().toISOString().slice(0, 10)}                                                        |
 *
 * 覆盖：地级市（含 4 个直辖市）${rows.filter((row) => row.level === 'PREFECTURE').length} 个 +
 * 县级 ${rows.filter((row) => row.level === 'COUNTY').length} 个。
 *
 * ## 为什么县级也要收
 *
 * 上升星座只取决于经度，而 1° 经度 ≈ 上升点移动 1° —— 地级市精度其实已经足够
 * （武平县与龙岩市区经度差 0.51°，上升点差不到 1°，而星座一个 30°）。
 * 但用户会想选到自己熟悉的那一级，且**县级用的是自己独立的坐标，比用地级市更准**。
 *
 * \`timezoneHint\` 是"该地可能存在另一种惯用时间"的提示值（目前只有新疆的 UTC+6）：
 * 新疆部分地区习惯用「新疆时间」，与北京时间差 2 小时 —— 差 2 小时会让上升星座
 * 整整错一个，所以必须让用户能说清楚这一点。
 *
 * ⚠ 港澳台与海外城市不在此表（GeoNames 里它们是独立国家/地区代码），
 * 由 \`zodiac-city.data.ts\` 手工维护。
 */

/** 行政区层级 */
export type CityLevel = 'PREFECTURE' | 'COUNTY';

/** 紧凑行：\`[名称, 所属地区, 纬度, 经度, 层级, 拼音(可空), 备用时区偏移(可空), 人口(0 表示未知)]\` */
export type GeneratedCityRow = readonly [
  string,
  string,
  number,
  number,
  CityLevel,
  string,
  number | null,
  number,
];

export const CHINA_CITY_ROWS: readonly GeneratedCityRow[] = [
${lines.join('\n')}
];
`;

  writeFileSync(TARGET, content, 'utf8');

  console.log(`已生成 ${TARGET}`);
  console.log(`  地级市（含直辖市）：${rows.filter((row) => row.level === 'PREFECTURE').length}`);
  console.log(`  县级：${rows.filter((row) => row.level === 'COUNTY').length}`);
  console.log(`  跳过（无上级匹配的县级条目）：${orphanCounties}`);
  console.log(`  省级：${provinces.size}`);

  console.log(`\n被繁简归一化改动过的名字（共 ${simplified.size} 个，**必须人工过一眼**）：`);
  for (const [from, to] of [...simplified].sort((left, right) => left[0].localeCompare(right[0], 'zh'))) {
    console.log(`  ${from} → ${to}`);
  }

  console.log(`\n31 个省级行政区的「简称 → 全称」（请人工核对，全称会直接展示给用户）：`);
  for (const [, province] of [...provinces].sort((left, right) => left[1].short.localeCompare(right[1].short, 'zh'))) {
    console.log(`  ${province.short.padEnd(6, '　')} → ${province.full}`);
  }

  console.log('');
  const wuping = rows.find((row) => row.name === '武平县');
  const longyan = rows.find((row) => row.name === '龙岩市');
  console.log(
    `  抽查 武平县：${wuping === undefined ? '缺失' : `${wuping.region} ${wuping.latitude},${wuping.longitude}`}`,
  );
  console.log(
    `  抽查 龙岩市：${longyan === undefined ? '缺失' : `${longyan.region} ${longyan.latitude},${longyan.longitude}`}`,
  );
  for (const province of ['甘肃省', '贵州省', '内蒙古', '黑龙江省', '新疆维吾尔自治区']) {
    const count = rows.filter((row) => row.level === 'PREFECTURE' && row.region === province).length;
    console.log(`  抽查 ${province}：地级市 ${count} 个`);
  }
};

main().catch((error) => {
  console.error('生成失败：', error);
  process.exitCode = 1;
});
