/**
 * 出生城市数据（港澳台与海外**手工维护**，中国大陆由生成文件提供）
 *
 * ## 为什么这一版重写了
 *
 * 用户的反馈是「选择城市没有我出生的城市（福建龙岩武平县）」。
 * 原来这份表是**手写**的，只有 106 条，福建只写了福州/厦门/泉州 ——
 * 中国有 333 个地级市、约 2800 个县级单位，人工补永远补不全，而且手写经纬度必然出错。
 *
 * 现在：
 *   · 中国大陆（地级市 + 县级，共 3100+ 条）来自 `zodiac-city-china.generated.ts`，
 *     由 `node scripts/build-china-cities.mjs` 从 GeoNames 公共数据集生成；
 *   · 港澳台与海外城市（GeoNames 里是独立国家/地区代码，不在 CN 数据集里）继续手工维护。
 *
 * ## 检索为什么要排序
 *
 * 有了 3100 条数据，单纯的 `includes` 过滤会出问题：搜「福建」会先返回一堆县级单位，
 * 用户想找的"龙岩市"被淹在后面。因此按**匹配质量**排序：
 * 完全相等 → 前缀 → 包含 → 命中省份，同级之内地级市优先。
 */

import { CHINA_CITY_ROWS, type CityLevel } from './zodiac-city-china.generated';

/** 一个可选为出生地的城市 */
export interface BirthCity {
  name: string;
  /** 所属地区：地级市给省份、县级给"省份 + 地级市"，海外给国家/地区 */
  region: string;
  latitude: number;
  longitude: number;
  /** 该地的**标准**时区偏移（小时）。中国夏令时由服务端按日期叠加，不要在这里算 */
  timezoneOffset: number;
  /** 行政区层级；港澳台与海外为 null（不做层级区分） */
  level: CityLevel | null;
  /**
   * 该地可能存在的**另一种惯用时间**（小时）。目前只有新疆的 UTC+6：
   * 新疆部分地区习惯用「新疆时间」，与北京时间差 2 小时 —— 差 2 小时会让上升星座
   * 整整错一个（上升星座约 2 小时换一个），所以必须让用户有机会说清楚。
   */
  altTimezoneOffset: number | null;
  /** 拼音/英文别名（便于英文输入） */
  aliases?: readonly string[];
  /**
   * 人口（来自 GeoNames；0 或缺失表示该条没有数据）
   *
   * 只用于**同分排序**：搜省份名时，用户期望先看到省会与大城市，
   * 而不是按数据文件顺序随机铺开。不参与任何业务判断。
   */
  population?: number;
}

/** 中国大陆行政区（生成数据 → 正式结构） */
const CHINA_CITIES: readonly BirthCity[] = CHINA_CITY_ROWS.map((row) => {
  const [name, region, latitude, longitude, level, pinyin, altTimezoneOffset, population] = row;

  return {
    name,
    region,
    latitude,
    longitude,
    timezoneOffset: 8,
    level,
    altTimezoneOffset,
    aliases: pinyin.length > 0 ? [pinyin] : [],
    population,
  };
});

/**
 * 港澳台与海外（**手工维护**）
 *
 * 这些地方不在 GeoNames 的 CN 数据集里。数值取自公开的城市中心坐标，
 * 精度到 0.01°（约 1 km），对上升星座而言远超所需（1° 经度才对应约 1° 上升点）。
 *
 * ⚠ `timezoneOffset` 填**标准时区**，不要填夏令时后的值：例如伦敦填 0、纽约填 -5。
 * 那些地方的夏令时规则与出生日期有关，属于另一个待办（目前只处理了中国 1986–1991）。
 */
const OVERSEAS_CITIES: readonly BirthCity[] = [
  // ---------------------------------------------------------------- 港澳台
  {
    name: '香港',
    region: '香港特别行政区',
    latitude: 22.32,
    longitude: 114.17,
    timezoneOffset: 8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['hongkong', 'hk'],
  },
  {
    name: '澳门',
    region: '澳门特别行政区',
    latitude: 22.2,
    longitude: 113.54,
    timezoneOffset: 8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['macau'],
  },
  {
    name: '台北',
    region: '台湾省',
    latitude: 25.03,
    longitude: 121.57,
    timezoneOffset: 8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['taipei'],
  },
  {
    name: '高雄',
    region: '台湾省',
    latitude: 22.63,
    longitude: 120.3,
    timezoneOffset: 8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['kaohsiung'],
  },
  {
    name: '台中',
    region: '台湾省',
    latitude: 24.15,
    longitude: 120.68,
    timezoneOffset: 8,
    level: null,
    altTimezoneOffset: null,
  },

  // ---------------------------------------------------------------- 海外常居
  {
    name: '东京',
    region: '日本',
    latitude: 35.68,
    longitude: 139.69,
    timezoneOffset: 9,
    level: null,
    altTimezoneOffset: null,
    aliases: ['tokyo'],
  },
  {
    name: '大阪',
    region: '日本',
    latitude: 34.69,
    longitude: 135.5,
    timezoneOffset: 9,
    level: null,
    altTimezoneOffset: null,
    aliases: ['osaka'],
  },
  {
    name: '首尔',
    region: '韩国',
    latitude: 37.57,
    longitude: 126.98,
    timezoneOffset: 9,
    level: null,
    altTimezoneOffset: null,
    aliases: ['seoul'],
  },
  {
    name: '新加坡',
    region: '新加坡',
    latitude: 1.35,
    longitude: 103.82,
    timezoneOffset: 8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['singapore'],
  },
  {
    name: '吉隆坡',
    region: '马来西亚',
    latitude: 3.14,
    longitude: 101.69,
    timezoneOffset: 8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['kualalumpur'],
  },
  {
    name: '曼谷',
    region: '泰国',
    latitude: 13.76,
    longitude: 100.5,
    timezoneOffset: 7,
    level: null,
    altTimezoneOffset: null,
    aliases: ['bangkok'],
  },
  {
    name: '马尼拉',
    region: '菲律宾',
    latitude: 14.6,
    longitude: 120.98,
    timezoneOffset: 8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['manila'],
  },
  {
    name: '雅加达',
    region: '印度尼西亚',
    latitude: -6.21,
    longitude: 106.85,
    timezoneOffset: 7,
    level: null,
    altTimezoneOffset: null,
    aliases: ['jakarta'],
  },
  {
    name: '迪拜',
    region: '阿联酋',
    latitude: 25.2,
    longitude: 55.27,
    timezoneOffset: 4,
    level: null,
    altTimezoneOffset: null,
    aliases: ['dubai'],
  },
  {
    name: '悉尼',
    region: '澳大利亚',
    latitude: -33.87,
    longitude: 151.21,
    timezoneOffset: 10,
    level: null,
    altTimezoneOffset: null,
    aliases: ['sydney'],
  },
  {
    name: '墨尔本',
    region: '澳大利亚',
    latitude: -37.81,
    longitude: 144.96,
    timezoneOffset: 10,
    level: null,
    altTimezoneOffset: null,
    aliases: ['melbourne'],
  },
  {
    name: '奥克兰',
    region: '新西兰',
    latitude: -36.85,
    longitude: 174.76,
    timezoneOffset: 12,
    level: null,
    altTimezoneOffset: null,
    aliases: ['auckland'],
  },
  {
    name: '伦敦',
    region: '英国',
    latitude: 51.51,
    longitude: -0.13,
    timezoneOffset: 0,
    level: null,
    altTimezoneOffset: null,
    aliases: ['london'],
  },
  {
    name: '巴黎',
    region: '法国',
    latitude: 48.86,
    longitude: 2.35,
    timezoneOffset: 1,
    level: null,
    altTimezoneOffset: null,
    aliases: ['paris'],
  },
  {
    name: '柏林',
    region: '德国',
    latitude: 52.52,
    longitude: 13.4,
    timezoneOffset: 1,
    level: null,
    altTimezoneOffset: null,
    aliases: ['berlin'],
  },
  {
    name: '法兰克福',
    region: '德国',
    latitude: 50.11,
    longitude: 8.68,
    timezoneOffset: 1,
    level: null,
    altTimezoneOffset: null,
    aliases: ['frankfurt'],
  },
  {
    name: '阿姆斯特丹',
    region: '荷兰',
    latitude: 52.37,
    longitude: 4.9,
    timezoneOffset: 1,
    level: null,
    altTimezoneOffset: null,
    aliases: ['amsterdam'],
  },
  {
    name: '苏黎世',
    region: '瑞士',
    latitude: 47.37,
    longitude: 8.54,
    timezoneOffset: 1,
    level: null,
    altTimezoneOffset: null,
    aliases: ['zurich'],
  },
  {
    name: '米兰',
    region: '意大利',
    latitude: 45.46,
    longitude: 9.19,
    timezoneOffset: 1,
    level: null,
    altTimezoneOffset: null,
    aliases: ['milan'],
  },
  {
    name: '马德里',
    region: '西班牙',
    latitude: 40.42,
    longitude: -3.7,
    timezoneOffset: 1,
    level: null,
    altTimezoneOffset: null,
    aliases: ['madrid'],
  },
  {
    name: '莫斯科',
    region: '俄罗斯',
    latitude: 55.76,
    longitude: 37.62,
    timezoneOffset: 3,
    level: null,
    altTimezoneOffset: null,
    aliases: ['moscow'],
  },
  {
    name: '纽约',
    region: '美国',
    latitude: 40.71,
    longitude: -74.01,
    timezoneOffset: -5,
    level: null,
    altTimezoneOffset: null,
    aliases: ['newyork', 'nyc'],
  },
  {
    name: '洛杉矶',
    region: '美国',
    latitude: 34.05,
    longitude: -118.24,
    timezoneOffset: -8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['losangeles', 'la'],
  },
  {
    name: '旧金山',
    region: '美国',
    latitude: 37.77,
    longitude: -122.42,
    timezoneOffset: -8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['sanfrancisco', 'sf'],
  },
  {
    name: '西雅图',
    region: '美国',
    latitude: 47.61,
    longitude: -122.33,
    timezoneOffset: -8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['seattle'],
  },
  {
    name: '芝加哥',
    region: '美国',
    latitude: 41.88,
    longitude: -87.63,
    timezoneOffset: -6,
    level: null,
    altTimezoneOffset: null,
    aliases: ['chicago'],
  },
  {
    name: '波士顿',
    region: '美国',
    latitude: 42.36,
    longitude: -71.06,
    timezoneOffset: -5,
    level: null,
    altTimezoneOffset: null,
    aliases: ['boston'],
  },
  {
    name: '休斯敦',
    region: '美国',
    latitude: 29.76,
    longitude: -95.37,
    timezoneOffset: -6,
    level: null,
    altTimezoneOffset: null,
    aliases: ['houston'],
  },
  {
    name: '多伦多',
    region: '加拿大',
    latitude: 43.65,
    longitude: -79.38,
    timezoneOffset: -5,
    level: null,
    altTimezoneOffset: null,
    aliases: ['toronto'],
  },
  {
    name: '温哥华',
    region: '加拿大',
    latitude: 49.28,
    longitude: -123.12,
    timezoneOffset: -8,
    level: null,
    altTimezoneOffset: null,
    aliases: ['vancouver'],
  },
];

/** 全部可选城市（中国大陆行政区 + 港澳台 + 海外） */
export const BIRTH_CITIES: readonly BirthCity[] = [...CHINA_CITIES, ...OVERSEAS_CITIES];

/** 常用城市（选择器空关键词时先给这几个，减少翻找） */
export const POPULAR_CITY_NAMES: readonly string[] = [
  '北京市',
  '上海市',
  '广州市',
  '深圳市',
  '杭州市',
  '成都市',
  '武汉市',
  '西安市',
];

/**
 * 去掉行政区通名，便于"北京"与"北京市"互相匹配
 *
 * ⚠ 只在**匹配**时用，返回给前端的始终是完整名称 —— 用户填过的历史数据
 * （旧版前端存的是"北京"）也要能查到。
 */
const normalizeName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(特别行政区|自治州|自治县|地区|林区|省|市|县|区|盟)$/u, '');

/** 命中质量：越小越优先（-1 表示不命中） */
const scoreOf = (city: BirthCity, needle: string): number => {
  const name = city.name.toLowerCase();

  if (name === needle || normalizeName(city.name) === needle) return 0;
  if (name.startsWith(needle) || normalizeName(city.name).startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  if ((city.aliases ?? []).some((alias) => alias.includes(needle))) return 2;
  if (city.region.toLowerCase().includes(needle)) return 3;

  return -1;
};

/** 同分时的排序：地级市优先（用户报城市名时通常指地级市），再按人口降序 */
const rankOf = (city: BirthCity): number => (city.level === 'PREFECTURE' ? 0 : city.level === 'COUNTY' ? 1 : 2);

/**
 * 省会/首府/直辖市
 *
 * 用户搜一个省的名字时，最可能想看的是省会。而 GeoNames 的 ADM2 人口**有缺失**
 * （实测：贵阳市的 ADM2 没有人口、毕节地区有），只按人口排序会让「贵州」
 * 的第一条变成毕节地区 —— 看起来像是排错了。因此这里额外把省会提到最前。
 */
const PROVINCIAL_CAPITALS = new Set([
  '北京',
  '上海',
  '天津',
  '重庆',
  '石家庄',
  '太原',
  '呼和浩特',
  '沈阳',
  '长春',
  '哈尔滨',
  '南京',
  '杭州',
  '合肥',
  '福州',
  '南昌',
  '济南',
  '郑州',
  '武汉',
  '长沙',
  '广州',
  '南宁',
  '海口',
  '成都',
  '贵阳',
  '昆明',
  '拉萨',
  '西安',
  '兰州',
  '西宁',
  '银川',
  '乌鲁木齐',
  '台北',
]);

const capitalRankOf = (city: BirthCity): number => (PROVINCIAL_CAPITALS.has(normalizeName(city.name)) ? 0 : 1);

/** 常用城市（按名字取，取不到就退化为列表前几项） */
const popularCities = (limit: number): BirthCity[] => {
  const picked = POPULAR_CITY_NAMES.map((name) => findCityByName(name)).filter(
    (city): city is BirthCity => city !== null,
  );

  return picked.length > 0 ? picked.slice(0, limit) : BIRTH_CITIES.slice(0, limit);
};

/**
 * 按名称 / 所属地区 / 拼音检索城市
 *
 * 排序规则（3100+ 条数据必须排序，否则搜省份会被县级结果淹没）：
 *   完全相等 → 前缀命中 → 名称包含 → 命中省份；同级之内**地级市优先**。
 *
 * @param limit 最多返回多少条（默认 30：小程序面板一屏能滚动的量级）
 */
export const searchCities = (keyword: string, limit = 30): BirthCity[] => {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) return popularCities(limit);

  const hits: { city: BirthCity; score: number }[] = [];

  for (const city of BIRTH_CITIES) {
    const score = scoreOf(city, needle);
    if (score >= 0) hits.push({ city, score });
  }

  return hits
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;

      const rankDelta = rankOf(left.city) - rankOf(right.city);
      if (rankDelta !== 0) return rankDelta;

      const capitalDelta = capitalRankOf(left.city) - capitalRankOf(right.city);
      if (capitalDelta !== 0) return capitalDelta;

      // 同级别内按人口降序：搜省份名时先给省会与大城市，而不是按数据文件顺序铺开
      const populationDelta = (right.city.population ?? 0) - (left.city.population ?? 0);
      if (populationDelta !== 0) return populationDelta;

      return left.city.name.length - right.city.name.length;
    })
    .slice(0, limit)
    .map((hit) => hit.city);
};

/**
 * 按名称取城市（精确 → 去通名相等 → 前缀），找不到返回 null
 *
 * 容忍"北京"与"北京市"这类差异：旧版前端存过没有通名的名字，
 * 只按字符串全等匹配会让那批数据在补齐坐标时静默失效。
 */
export const findCityByName = (name: string): BirthCity | null => {
  const raw = name.trim();
  if (raw.length === 0) return null;

  const exact = BIRTH_CITIES.find((city) => city.name === raw);
  if (exact !== undefined) return exact;

  const normalized = normalizeName(raw);
  const byNormalized = BIRTH_CITIES.find((city) => normalizeName(city.name) === normalized);
  if (byNormalized !== undefined) return byNormalized;

  const byPrefix = BIRTH_CITIES.find((city) => city.name.startsWith(raw));

  return byPrefix ?? null;
};
