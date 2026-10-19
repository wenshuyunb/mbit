/**
 * 出生城市数据的完整性与检索测试
 *
 * ## 起因：用户报「选择城市没有我出生的城市（福建龙岩武平县）」
 *
 * 原来的城市表是**手写**的 106 条，福建只写了福州/厦门/泉州 ——
 * 中国有 333 个地级市、约 2800 个县级单位，人工补永远补不全。
 * 现在改为从 GeoNames 公共数据集生成（`node scripts/build-china-cities.mjs`）。
 *
 * ## 这里守的是四类"不会报错、只会静默失能"的缺陷
 *
 *   ① **数据规模缩水**：生成脚本哪天少读一级（例如 ADM3 没读进来），
 *      代码照样跑、接口照样 200，只是用户又搜不到自己的县了；
 *   ② **繁体/异体字混入**：GeoNames 里甘肃写作「甘粛」、黑龙江写作「黒龍江」、
 *      贵州写作「貴州」—— 不归一化的话用户搜简体字**一个字都搜不到**。
 *      实测踩过三次（`粛`/`黒`/`竜` 不在 OpenCC 的繁简表里）；
 *   ③ **一对多误伤**：OpenCC 把「乾」映射成「干」，于是**乾县（陕西）变成"干县"**。
 *      地名里的正字被改成不存在的名字，比搜不到更糟（用户会以为我们数据错乱）；
 *   ④ **排序退化**：有多达 3100 条数据时，如果只按文件顺序返回，
 *      用户搜省份会看到一串随机顺序的城市。
 */

import { BIRTH_CITIES, findCityByName, POPULAR_CITY_NAMES, searchCities } from './zodiac-city.data';
import { ZODIAC_SIGNS } from './zodiac.types';

/** 用户场景里用到的坐标（用于断言数值没被写错） */
const WUPING = { latitude: 25.16, longitude: 116.14 };

describe('城市数据：规模与结构', () => {
  it('地级市数量达到全国量级（少读一级就是"用户又搜不到自己的城市了"）', () => {
    const prefectures = BIRTH_CITIES.filter((city) => city.level === 'PREFECTURE');

    expect(prefectures.length).toBeGreaterThanOrEqual(330);
  });

  it('县级单位数量达到全国量级（约 2800 个）', () => {
    const counties = BIRTH_CITIES.filter((city) => city.level === 'COUNTY');

    expect(counties.length).toBeGreaterThanOrEqual(2700);
  });

  it('港澳台与海外仍然在（它们不在 CN 数据集里，由手工维护）', () => {
    for (const name of ['香港', '澳门', '台北', '东京', '纽约', '伦敦', '悉尼']) {
      expect(findCityByName(name)).not.toBeNull();
    }
  });

  it('4 个直辖市都在（GeoNames 里它们是省级，容易在生成时漏掉）', () => {
    for (const name of ['北京市', '上海市', '天津市', '重庆市']) {
      const city = findCityByName(name);

      expect(city).not.toBeNull();
      expect(city?.level).toBe('PREFECTURE');
    }
  });

  it('每条城市的经纬度都在合法范围，且时区在 -12 ~ 14', () => {
    for (const city of BIRTH_CITIES) {
      expect(Math.abs(city.latitude)).toBeLessThanOrEqual(90);
      expect(Math.abs(city.longitude)).toBeLessThanOrEqual(180);
      expect(city.timezoneOffset).toBeGreaterThanOrEqual(-12);
      expect(city.timezoneOffset).toBeLessThanOrEqual(14);
    }
  });

  it('没有重名条目（同名同归属会出现两个一模一样的选项）', () => {
    const keys = BIRTH_CITIES.map((city) => `${city.name}|${city.region}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('城市数据：繁简与异体字归一化', () => {
  /**
   * 繁简/异体字黑名单：这些字出现在**地名数据里**就是没归一化干净。
   * 每一条都是实测或明确已知的坑（`粛`/`黒`/`竜` 甚至不在 OpenCC 繁简表里）。
   *
   * ⚠ 注意「乾」**故意不在**黑名单里：乾县（陕西）的「乾」是正字，
   * 归一化成「干县」反而制造了一个不存在的地名。
   */
  const TRADITIONAL_CHARS = /[粛県徳広黒竜龍貴雲廣區縣寧遼蘇陝慶壯滿臺裡們與國學長門車東馬鳥齊專樂書見貝頁風飛]/u;

  it('没有任何城市名残留繁体/异体字（否则用户用简体搜不到）', () => {
    const offenders = BIRTH_CITIES.filter((city) => TRADITIONAL_CHARS.test(city.name)).map(
      (city) => `${city.name}（${city.region}）`,
    );

    expect(offenders).toEqual([]);
  });

  it('省份名残留异体字同样要拦住（地区字段是用户可见的）', () => {
    const offenders = BIRTH_CITIES.filter((city) => TRADITIONAL_CHARS.test(city.region)).map((city) => city.region);

    expect(offenders).toEqual([]);
  });

  it('【关键】搜简体省份名必须搜得到（甘肃/贵州/黑龙江/内蒙古曾经一个字都搜不到）', () => {
    for (const province of ['甘肃', '贵州', '黑龙江', '内蒙古', '陕西', '云南', '广西', '宁夏', '辽宁', '山东']) {
      expect(`${province}:${searchCities(province, 5).length > 0}`).toBe(`${province}:true`);
    }
  });

  it('没有被过度归一化的地名（乾县不能变成"干县"）', () => {
    const qian = BIRTH_CITIES.filter((city) => city.name.includes('乾'));

    expect(qian.length).toBeGreaterThan(0);
    expect(qian.some((city) => city.name === '乾县')).toBe(true);
    expect(BIRTH_CITIES.some((city) => city.name === '干县')).toBe(false);
  });
});

describe('城市数据：用户场景（福建龙岩武平县）', () => {
  it('【关键】搜「武平」能找到武平县，并带完整归属', () => {
    const hits = searchCities('武平');

    expect(hits.some((city) => city.name === '武平县')).toBe(true);

    const wuping = hits.find((city) => city.name === '武平县');
    expect(wuping?.region).toBe('福建省龙岩市');
    expect(wuping?.level).toBe('COUNTY');
  });

  it('武平县的坐标是真实值（不是地级市坐标的复制）', () => {
    const wuping = findCityByName('武平县');

    expect(wuping).not.toBeNull();
    expect(Math.abs((wuping?.latitude ?? 0) - WUPING.latitude)).toBeLessThan(0.2);
    expect(Math.abs((wuping?.longitude ?? 0) - WUPING.longitude)).toBeLessThan(0.2);
    // 与龙岩市区必须不同（差 0.5° 左右），否则等于没有县级精度
    const longyan = findCityByName('龙岩市');
    expect(Math.abs((wuping?.longitude ?? 0) - (longyan?.longitude ?? 0))).toBeGreaterThan(0.2);
  });

  it('搜「龙岩」第一条是地级市龙岩市（不能被同名/下级条目挤掉）', () => {
    const hits = searchCities('龙岩');

    expect(hits[0]?.name).toBe('龙岩市');
    expect(hits[0]?.level).toBe('PREFECTURE');
  });

  it('搜「福建」时地级市排在县级之前', () => {
    const hits = searchCities('福建', 12);

    expect(hits.slice(0, 5).every((city) => city.level === 'PREFECTURE')).toBe(true);
    expect(hits.some((city) => city.name === '龙岩市')).toBe(true);
  });

  it('搜省名时省会排第一（省会 ADM2 人口可能缺失，只按人口排会排错）', () => {
    expect(searchCities('福建')[0]?.name).toBe('福州市');
    expect(searchCities('贵州')[0]?.name).toBe('贵阳市');
    expect(searchCities('甘肃')[0]?.name).toBe('兰州市');
  });

  it('搜县级名能找到同名不同省的条目时，按归属区分', () => {
    // 「城区」这类通名会出现多条，必须带归属才分得清
    const hits = searchCities('城区', 5);

    for (const city of hits) {
      expect(city.region.length).toBeGreaterThan(0);
    }
  });
});

describe('城市数据：检索与兼容', () => {
  it('空关键词返回热门城市（选择器一打开就有内容）', () => {
    const hits = searchCities('');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(30);
  });

  it('热门城市名都能在数据里查到（写错一个字就会静默少一个）', () => {
    for (const name of POPULAR_CITY_NAMES) {
      expect(`${name}:${findCityByName(name) !== null}`).toBe(`${name}:true`);
    }
  });

  it('【关键】"北京"与"北京市"都能查到（旧版前端存过没有通名的名字）', () => {
    expect(findCityByName('北京')?.name).toBe('北京市');
    expect(findCityByName('北京市')?.name).toBe('北京市');
  });

  it('拼音也能搜到地级市', () => {
    expect(searchCities('hangzhou').some((city) => city.name === '杭州市')).toBe(true);
  });

  it('关键词前后空格不影响结果', () => {
    expect(searchCities('  武平  ')[0]?.name).toBe('武平县');
  });

  it('返回结果不超过 limit', () => {
    expect(searchCities('县', 7)).toHaveLength(7);
  });

  it('新疆的城市带"另一种惯用时间"标记（新疆时间与北京时间差 2 小时，会让上升星座错一个）', () => {
    const urumqi = findCityByName('乌鲁木齐');

    expect(urumqi?.region).toBe('新疆维吾尔自治区');
    expect(urumqi?.altTimezoneOffset).toBe(6);
    expect(urumqi?.timezoneOffset).toBe(8);
  });

  it('非新疆地区没有该标记（避免到处弹无意义的提示）', () => {
    expect(findCityByName('杭州市')?.altTimezoneOffset).toBeNull();
  });

  it('城市数据的星座字段没被误用（本模块不做星座归属）', () => {
    // 防御性断言：城市表里不该出现任何星座编码
    for (const city of BIRTH_CITIES.slice(0, 50)) {
      expect(ZODIAC_SIGNS.includes(city.name as (typeof ZODIAC_SIGNS)[number])).toBe(false);
    }
  });
});
