/**
 * 出生地经纬度表（**内置数据，不依赖外部地图服务**）
 *
 * ## 为什么内置而不是接地图/地理编码 API
 *
 *   ① 项目约定不新增依赖，而接第三方地理编码要密钥、要配额、要备案；
 *   ② 星盘只用到**经纬度两位小数**（上升星座对经度的敏感度是"每 4 分钟 1°"，
 *      城市级精度完全够用），因此一份静态表就够；
 *   ③ 静态表可以**逐条评审**，不会因为上游数据变动让用户算出的上升星座悄悄变掉。
 *
 * ## 覆盖范围与取值口径
 *
 *   · 中国大陆：省会 + 主要地级市（按拼音/常用称谓均可搜索）；
 *   · 港澳台：香港、澳门、台北、高雄等；
 *   · 海外华人常居城市：常见十几个（纽约、洛杉矶、旧金山、伦敦、悉尼、东京、
 *     首尔、新加坡、多伦多、温哥华、巴黎、法兰克福、迪拜、奥克兰…）。
 *
 * 经纬度取**市中心**坐标（小数两位，约 1 公里）；东经/北纬为正。
 * 时区偏移取该城市**当前**标准时（不处理历史夏令时 —— 那由
 * `resolveTimezoneOffset` 按出生年份处理中国的情形，海外出生请在表单里
 * 手动确认时区）。
 */

/** 一个可选城市 */
export interface BirthCity {
  /** 城市名（中文） */
  readonly name: string;
  /** 省份/国家（用于同名城市区分与搜索） */
  readonly region: string;
  /** 纬度（北正南负） */
  readonly latitude: number;
  /** 经度（东正西负） */
  readonly longitude: number;
  /** 时区偏移（小时） */
  readonly timezoneOffset: number;
  /** 检索别名（拼音首字母、旧称等） */
  readonly aliases?: readonly string[];
}

export const BIRTH_CITIES: readonly BirthCity[] = [
  // ---------------------------------------------------------------- 直辖市
  { name: '北京', region: '北京市', latitude: 39.9, longitude: 116.41, timezoneOffset: 8, aliases: ['beijing', 'bj'] },
  {
    name: '上海',
    region: '上海市',
    latitude: 31.23,
    longitude: 121.47,
    timezoneOffset: 8,
    aliases: ['shanghai', 'sh'],
  },
  { name: '天津', region: '天津市', latitude: 39.08, longitude: 117.2, timezoneOffset: 8, aliases: ['tianjin', 'tj'] },
  {
    name: '重庆',
    region: '重庆市',
    latitude: 29.56,
    longitude: 106.55,
    timezoneOffset: 8,
    aliases: ['chongqing', 'cq'],
  },

  // ---------------------------------------------------------------- 华北 / 东北
  {
    name: '石家庄',
    region: '河北省',
    latitude: 38.04,
    longitude: 114.51,
    timezoneOffset: 8,
    aliases: ['shijiazhuang'],
  },
  { name: '唐山', region: '河北省', latitude: 39.63, longitude: 118.18, timezoneOffset: 8 },
  { name: '保定', region: '河北省', latitude: 38.87, longitude: 115.46, timezoneOffset: 8 },
  { name: '太原', region: '山西省', latitude: 37.87, longitude: 112.55, timezoneOffset: 8, aliases: ['taiyuan'] },
  { name: '大同', region: '山西省', latitude: 40.09, longitude: 113.3, timezoneOffset: 8 },
  { name: '呼和浩特', region: '内蒙古', latitude: 40.84, longitude: 111.75, timezoneOffset: 8, aliases: ['hohhot'] },
  { name: '包头', region: '内蒙古', latitude: 40.66, longitude: 109.84, timezoneOffset: 8 },
  { name: '沈阳', region: '辽宁省', latitude: 41.81, longitude: 123.43, timezoneOffset: 8, aliases: ['shenyang'] },
  { name: '大连', region: '辽宁省', latitude: 38.91, longitude: 121.61, timezoneOffset: 8, aliases: ['dalian'] },
  { name: '长春', region: '吉林省', latitude: 43.82, longitude: 125.32, timezoneOffset: 8, aliases: ['changchun'] },
  { name: '吉林', region: '吉林省', latitude: 43.84, longitude: 126.55, timezoneOffset: 8 },
  { name: '哈尔滨', region: '黑龙江省', latitude: 45.8, longitude: 126.53, timezoneOffset: 8, aliases: ['harbin'] },
  { name: '大庆', region: '黑龙江省', latitude: 46.59, longitude: 125.1, timezoneOffset: 8 },

  // ---------------------------------------------------------------- 华东
  { name: '南京', region: '江苏省', latitude: 32.06, longitude: 118.8, timezoneOffset: 8, aliases: ['nanjing'] },
  { name: '苏州', region: '江苏省', latitude: 31.3, longitude: 120.58, timezoneOffset: 8, aliases: ['suzhou'] },
  { name: '无锡', region: '江苏省', latitude: 31.49, longitude: 120.31, timezoneOffset: 8 },
  { name: '常州', region: '江苏省', latitude: 31.81, longitude: 119.97, timezoneOffset: 8 },
  { name: '南通', region: '江苏省', latitude: 31.98, longitude: 120.89, timezoneOffset: 8 },
  { name: '徐州', region: '江苏省', latitude: 34.27, longitude: 117.19, timezoneOffset: 8 },
  { name: '杭州', region: '浙江省', latitude: 30.27, longitude: 120.16, timezoneOffset: 8, aliases: ['hangzhou'] },
  { name: '宁波', region: '浙江省', latitude: 29.87, longitude: 121.55, timezoneOffset: 8, aliases: ['ningbo'] },
  { name: '温州', region: '浙江省', latitude: 28.0, longitude: 120.7, timezoneOffset: 8, aliases: ['wenzhou'] },
  { name: '绍兴', region: '浙江省', latitude: 30.0, longitude: 120.58, timezoneOffset: 8 },
  { name: '金华', region: '浙江省', latitude: 29.08, longitude: 119.65, timezoneOffset: 8 },
  { name: '合肥', region: '安徽省', latitude: 31.82, longitude: 117.23, timezoneOffset: 8, aliases: ['hefei'] },
  { name: '芜湖', region: '安徽省', latitude: 31.35, longitude: 118.43, timezoneOffset: 8 },
  { name: '福州', region: '福建省', latitude: 26.07, longitude: 119.3, timezoneOffset: 8, aliases: ['fuzhou'] },
  { name: '厦门', region: '福建省', latitude: 24.48, longitude: 118.09, timezoneOffset: 8, aliases: ['xiamen'] },
  { name: '泉州', region: '福建省', latitude: 24.87, longitude: 118.68, timezoneOffset: 8 },
  { name: '南昌', region: '江西省', latitude: 28.68, longitude: 115.86, timezoneOffset: 8, aliases: ['nanchang'] },
  { name: '赣州', region: '江西省', latitude: 25.83, longitude: 114.93, timezoneOffset: 8 },
  { name: '济南', region: '山东省', latitude: 36.65, longitude: 117.12, timezoneOffset: 8, aliases: ['jinan'] },
  { name: '青岛', region: '山东省', latitude: 36.07, longitude: 120.38, timezoneOffset: 8, aliases: ['qingdao'] },
  { name: '烟台', region: '山东省', latitude: 37.46, longitude: 121.45, timezoneOffset: 8 },
  { name: '潍坊', region: '山东省', latitude: 36.71, longitude: 119.16, timezoneOffset: 8 },
  { name: '临沂', region: '山东省', latitude: 35.1, longitude: 118.36, timezoneOffset: 8 },

  // ---------------------------------------------------------------- 华中 / 华南
  { name: '郑州', region: '河南省', latitude: 34.75, longitude: 113.63, timezoneOffset: 8, aliases: ['zhengzhou'] },
  { name: '洛阳', region: '河南省', latitude: 34.62, longitude: 112.45, timezoneOffset: 8 },
  { name: '武汉', region: '湖北省', latitude: 30.59, longitude: 114.31, timezoneOffset: 8, aliases: ['wuhan'] },
  { name: '宜昌', region: '湖北省', latitude: 30.69, longitude: 111.29, timezoneOffset: 8 },
  { name: '襄阳', region: '湖北省', latitude: 32.01, longitude: 112.12, timezoneOffset: 8 },
  { name: '长沙', region: '湖南省', latitude: 28.23, longitude: 112.94, timezoneOffset: 8, aliases: ['changsha'] },
  { name: '株洲', region: '湖南省', latitude: 27.83, longitude: 113.13, timezoneOffset: 8 },
  {
    name: '广州',
    region: '广东省',
    latitude: 23.13,
    longitude: 113.26,
    timezoneOffset: 8,
    aliases: ['guangzhou', 'gz'],
  },
  {
    name: '深圳',
    region: '广东省',
    latitude: 22.54,
    longitude: 114.06,
    timezoneOffset: 8,
    aliases: ['shenzhen', 'sz'],
  },
  { name: '东莞', region: '广东省', latitude: 23.02, longitude: 113.75, timezoneOffset: 8 },
  { name: '佛山', region: '广东省', latitude: 23.02, longitude: 113.12, timezoneOffset: 8 },
  { name: '珠海', region: '广东省', latitude: 22.27, longitude: 113.58, timezoneOffset: 8 },
  { name: '中山', region: '广东省', latitude: 22.52, longitude: 113.39, timezoneOffset: 8 },
  { name: '汕头', region: '广东省', latitude: 23.35, longitude: 116.68, timezoneOffset: 8 },
  { name: '南宁', region: '广西', latitude: 22.82, longitude: 108.32, timezoneOffset: 8, aliases: ['nanning'] },
  { name: '桂林', region: '广西', latitude: 25.27, longitude: 110.29, timezoneOffset: 8 },
  { name: '海口', region: '海南省', latitude: 20.04, longitude: 110.32, timezoneOffset: 8, aliases: ['haikou'] },
  { name: '三亚', region: '海南省', latitude: 18.25, longitude: 109.51, timezoneOffset: 8, aliases: ['sanya'] },

  // ---------------------------------------------------------------- 西南 / 西北
  { name: '成都', region: '四川省', latitude: 30.57, longitude: 104.07, timezoneOffset: 8, aliases: ['chengdu'] },
  { name: '绵阳', region: '四川省', latitude: 31.47, longitude: 104.68, timezoneOffset: 8 },
  { name: '贵阳', region: '贵州省', latitude: 26.65, longitude: 106.63, timezoneOffset: 8, aliases: ['guiyang'] },
  { name: '昆明', region: '云南省', latitude: 25.04, longitude: 102.71, timezoneOffset: 8, aliases: ['kunming'] },
  { name: '大理', region: '云南省', latitude: 25.61, longitude: 100.27, timezoneOffset: 8 },
  { name: '拉萨', region: '西藏', latitude: 29.65, longitude: 91.14, timezoneOffset: 8, aliases: ['lhasa'] },
  { name: '西安', region: '陕西省', latitude: 34.34, longitude: 108.94, timezoneOffset: 8, aliases: ['xian'] },
  { name: '宝鸡', region: '陕西省', latitude: 34.36, longitude: 107.24, timezoneOffset: 8 },
  { name: '兰州', region: '甘肃省', latitude: 36.06, longitude: 103.83, timezoneOffset: 8, aliases: ['lanzhou'] },
  { name: '西宁', region: '青海省', latitude: 36.62, longitude: 101.78, timezoneOffset: 8, aliases: ['xining'] },
  { name: '银川', region: '宁夏', latitude: 38.49, longitude: 106.23, timezoneOffset: 8, aliases: ['yinchuan'] },
  {
    name: '乌鲁木齐',
    region: '新疆',
    latitude: 43.83,
    longitude: 87.62,
    timezoneOffset: 8,
    aliases: ['urumqi', 'wulumuqi'],
  },
  { name: '喀什', region: '新疆', latitude: 39.47, longitude: 75.99, timezoneOffset: 8 },
  {
    name: '香港',
    region: '香港特别行政区',
    latitude: 22.32,
    longitude: 114.17,
    timezoneOffset: 8,
    aliases: ['hongkong', 'hk'],
  },
  { name: '澳门', region: '澳门特别行政区', latitude: 22.2, longitude: 113.54, timezoneOffset: 8, aliases: ['macau'] },
  { name: '台北', region: '台湾省', latitude: 25.03, longitude: 121.57, timezoneOffset: 8, aliases: ['taipei'] },
  { name: '高雄', region: '台湾省', latitude: 22.63, longitude: 120.3, timezoneOffset: 8, aliases: ['kaohsiung'] },
  { name: '台中', region: '台湾省', latitude: 24.15, longitude: 120.68, timezoneOffset: 8 },

  // ---------------------------------------------------------------- 海外常居
  { name: '东京', region: '日本', latitude: 35.68, longitude: 139.69, timezoneOffset: 9, aliases: ['tokyo'] },
  { name: '大阪', region: '日本', latitude: 34.69, longitude: 135.5, timezoneOffset: 9, aliases: ['osaka'] },
  { name: '首尔', region: '韩国', latitude: 37.57, longitude: 126.98, timezoneOffset: 9, aliases: ['seoul'] },
  { name: '新加坡', region: '新加坡', latitude: 1.35, longitude: 103.82, timezoneOffset: 8, aliases: ['singapore'] },
  {
    name: '吉隆坡',
    region: '马来西亚',
    latitude: 3.14,
    longitude: 101.69,
    timezoneOffset: 8,
    aliases: ['kualalumpur'],
  },
  { name: '曼谷', region: '泰国', latitude: 13.76, longitude: 100.5, timezoneOffset: 7, aliases: ['bangkok'] },
  { name: '马尼拉', region: '菲律宾', latitude: 14.6, longitude: 120.98, timezoneOffset: 8, aliases: ['manila'] },
  { name: '雅加达', region: '印度尼西亚', latitude: -6.21, longitude: 106.85, timezoneOffset: 7, aliases: ['jakarta'] },
  { name: '迪拜', region: '阿联酋', latitude: 25.2, longitude: 55.27, timezoneOffset: 4, aliases: ['dubai'] },
  { name: '悉尼', region: '澳大利亚', latitude: -33.87, longitude: 151.21, timezoneOffset: 10, aliases: ['sydney'] },
  {
    name: '墨尔本',
    region: '澳大利亚',
    latitude: -37.81,
    longitude: 144.96,
    timezoneOffset: 10,
    aliases: ['melbourne'],
  },
  { name: '奥克兰', region: '新西兰', latitude: -36.85, longitude: 174.76, timezoneOffset: 12, aliases: ['auckland'] },
  { name: '伦敦', region: '英国', latitude: 51.51, longitude: -0.13, timezoneOffset: 0, aliases: ['london'] },
  { name: '巴黎', region: '法国', latitude: 48.86, longitude: 2.35, timezoneOffset: 1, aliases: ['paris'] },
  { name: '柏林', region: '德国', latitude: 52.52, longitude: 13.4, timezoneOffset: 1, aliases: ['berlin'] },
  { name: '法兰克福', region: '德国', latitude: 50.11, longitude: 8.68, timezoneOffset: 1, aliases: ['frankfurt'] },
  { name: '阿姆斯特丹', region: '荷兰', latitude: 52.37, longitude: 4.9, timezoneOffset: 1, aliases: ['amsterdam'] },
  { name: '苏黎世', region: '瑞士', latitude: 47.37, longitude: 8.54, timezoneOffset: 1, aliases: ['zurich'] },
  { name: '米兰', region: '意大利', latitude: 45.46, longitude: 9.19, timezoneOffset: 1, aliases: ['milan'] },
  { name: '马德里', region: '西班牙', latitude: 40.42, longitude: -3.7, timezoneOffset: 1, aliases: ['madrid'] },
  { name: '莫斯科', region: '俄罗斯', latitude: 55.76, longitude: 37.62, timezoneOffset: 3, aliases: ['moscow'] },
  { name: '纽约', region: '美国', latitude: 40.71, longitude: -74.01, timezoneOffset: -5, aliases: ['newyork', 'nyc'] },
  {
    name: '洛杉矶',
    region: '美国',
    latitude: 34.05,
    longitude: -118.24,
    timezoneOffset: -8,
    aliases: ['losangeles', 'la'],
  },
  {
    name: '旧金山',
    region: '美国',
    latitude: 37.77,
    longitude: -122.42,
    timezoneOffset: -8,
    aliases: ['sanfrancisco', 'sf'],
  },
  { name: '西雅图', region: '美国', latitude: 47.61, longitude: -122.33, timezoneOffset: -8, aliases: ['seattle'] },
  { name: '芝加哥', region: '美国', latitude: 41.88, longitude: -87.63, timezoneOffset: -6, aliases: ['chicago'] },
  { name: '波士顿', region: '美国', latitude: 42.36, longitude: -71.06, timezoneOffset: -5, aliases: ['boston'] },
  { name: '休斯敦', region: '美国', latitude: 29.76, longitude: -95.37, timezoneOffset: -6, aliases: ['houston'] },
  { name: '多伦多', region: '加拿大', latitude: 43.65, longitude: -79.38, timezoneOffset: -5, aliases: ['toronto'] },
  { name: '温哥华', region: '加拿大', latitude: 49.28, longitude: -123.12, timezoneOffset: -8, aliases: ['vancouver'] },
];

/** 常用城市（表单默认给这几个，减少翻找） */
export const POPULAR_CITY_NAMES: readonly string[] = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安'];

/** 按名称/别名检索城市（大小写不敏感，去空格） */
export const searchCities = (keyword: string, limit = 20): BirthCity[] => {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) return BIRTH_CITIES.slice(0, limit);

  return BIRTH_CITIES.filter((city) => {
    const haystack = [city.name, city.region, ...(city.aliases ?? [])].join(' ').toLowerCase();

    return haystack.includes(needle);
  }).slice(0, limit);
};

/** 按名称精确取城市（找不到返回 null） */
export const findCityByName = (name: string): BirthCity | null =>
  BIRTH_CITIES.find((city) => city.name === name.trim()) ?? null;
