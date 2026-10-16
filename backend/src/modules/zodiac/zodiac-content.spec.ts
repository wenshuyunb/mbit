/**
 * 星座内容表的**合规与质量守卫**
 *
 * ## 为什么给"文案数据"写测试
 *
 * 这个模块的合规风险不在代码里，在**每一句话**里：星座内容天然带"预测"色彩，
 * 而《互联网信息服务管理办法》禁止宣扬封建迷信、小程序平台对"运势预测"另有拒绝情形。
 * 一句"今日宜签约"或"注意心血管"就足以让整个模块变成风险点，而它在 code review 里
 * 看起来只是一行普通的中文。
 *
 * 因此这里拿黑名单**逐条扫描本模块的全部用户可见文案**（星座档案、每日基调、
 * 五维解读、宜忌、箴言、周运月运、配对）—— 内容改动只要越线，测试立刻变红。
 *
 * 黑名单分四类，每一类都对应一条真实的产品/监管边界：
 *   ① **决策类**：把娱乐内容当成决策依据（投资、签约、就医…）；
 *   ② **医疗类**：暗示诊断或治疗能力；
 *   ③ **承诺类**：把"倾向"说成"必然"；
 *   ④ **命理类**：占卜、风水、转运、消灾这类真正的迷信表述（我们只做文化解读）。
 */

import {
  AVOID_ACTIVITIES,
  DAILY_TONES,
  DIMENSION_LINES,
  GOOD_ACTIVITIES,
  LUCKY_COLORS,
  LUCKY_DIRECTIONS,
  LUCKY_HOURS,
  MATCH_DIMENSION_LINES,
  MATCH_ELEMENT_NOTES,
  MONTHLY_PHASES,
  MONTHLY_THEMES,
  QUOTES,
  WEEKLY_LINES,
  WEEKLY_TIPS,
  ZODIAC_PROFILES,
} from './zodiac-content';
import { FORTUNE_DIMENSIONS, ZODIAC_SIGNS } from './zodiac.types';

/** ① 决策类：绝不能出现在"宜"里，也不该作为任何建议出现 */
const DECISION_WORDS = [
  '投资',
  '理财',
  '股票',
  '基金',
  '签约',
  '合同',
  '辞职',
  '离职',
  '跳槽',
  '就医',
  '看病',
  '手术',
  '买房',
  '借贷',
  '贷款',
  '表白',
  '分手',
  '离婚',
  '搬迁',
];

/** ② 医疗类：不暗示诊断或治疗能力 */
const MEDICAL_WORDS = [
  '疾病',
  '症状',
  '诊断',
  '治疗',
  '用药',
  '药物',
  '处方',
  '抑郁',
  '焦虑症',
  '失眠症',
  '康复',
  '痊愈',
  '病情',
  '心脏',
  '血压',
  '血糖',
];

/** ③ 承诺类：只说倾向，不说必然 */
const PROMISE_WORDS = ['必定', '一定会', '必然会', '百分百', '100%', '准确率', '保证', '肯定能'];

/**
 * ④ 命理类：我们做文化解读，不做占卜
 *
 * ⚠ 「化解」**不在**这个列表里：它在中文里也用于"化解矛盾"（天秤座档案里就有
 * "朋友之间的矛盾常靠你化解"），那是正常表述，不是迷信话术。
 * 第一版把它列进来，判红了 —— 而那是**黑名单写得太宽**，不是文案有问题。
 * 要拦的是「化解霉运」这类，因此用更具体的组合词。
 */
const DIVINATION_WORDS = [
  '算命',
  '占卜',
  '风水',
  '转运',
  '开运',
  '消灾',
  '改命',
  '求签',
  '生辰八字',
  '紫微',
  '塔罗',
  '化解霉运',
  '逢凶化吉',
  '命中注定',
];

/** 把全部用户可见文案收集成一个 `[位置, 文本]` 列表（位置用于定位失败项） */
const collectTexts = (): Array<[string, string]> => {
  const texts: Array<[string, string]> = [];

  for (const sign of ZODIAC_SIGNS) {
    const profile = ZODIAC_PROFILES[sign];

    texts.push(
      [`${sign}.personality`, profile.personality],
      [`${sign}.love`, profile.love],
      [`${sign}.career`, profile.career],
      [`${sign}.friendship`, profile.friendship],
      ...profile.strengths.map((item, index): [string, string] => [`${sign}.strengths[${index}]`, item]),
      ...profile.watchouts.map((item, index): [string, string] => [`${sign}.watchouts[${index}]`, item]),
    );

    DAILY_TONES[sign].forEach((line, index) => texts.push([`${sign}.tone[${index}]`, line]));
  }

  for (const dimension of FORTUNE_DIMENSIONS) {
    const bands = DIMENSION_LINES[dimension];

    for (const band of ['LOW', 'MID', 'HIGH'] as const) {
      bands[band].forEach((line, index) => texts.push([`${dimension}.${band}[${index}]`, line]));
    }
  }

  GOOD_ACTIVITIES.forEach((line, index) => texts.push([`good[${index}]`, line]));
  AVOID_ACTIVITIES.forEach((line, index) => texts.push([`avoid[${index}]`, line]));
  QUOTES.forEach((line, index) => texts.push([`quote[${index}]`, line]));
  WEEKLY_TIPS.forEach((line, index) => texts.push([`weeklyTip[${index}]`, line]));
  MONTHLY_THEMES.forEach((line, index) => texts.push([`monthlyTheme[${index}]`, line]));

  for (const section of ['CAREER', 'LOVE', 'SELF'] as const) {
    for (const band of ['LOW', 'MID', 'HIGH'] as const) {
      WEEKLY_LINES[section][band].forEach((line, index) => texts.push([`weekly.${section}.${band}[${index}]`, line]));
    }
  }

  for (const phase of ['EARLY', 'MIDDLE', 'LATE'] as const) {
    for (const band of ['LOW', 'MID', 'HIGH'] as const) {
      MONTHLY_PHASES[phase][band].forEach((line, index) => texts.push([`monthly.${phase}.${band}[${index}]`, line]));
    }
  }

  for (const dimension of ['COMMUNICATION', 'SPARK', 'LONGTERM'] as const) {
    for (const band of ['LOW', 'MID', 'HIGH'] as const) {
      MATCH_DIMENSION_LINES[dimension][band].forEach((line, index) =>
        texts.push([`match.${dimension}.${band}[${index}]`, line]),
      );
    }
  }

  Object.entries(MATCH_ELEMENT_NOTES).forEach(([key, line]) => texts.push([`matchElement.${key}`, line]));

  return texts;
};

const ALL_TEXTS = collectTexts();

describe('星座内容表', () => {
  it('文案总量与覆盖度（内容池够大才不会天天重复）', () => {
    // 每个维度 3 档 × 6 条 = 18 条，五维共 90 条；加上档案与周期文案总量应在 300 条以上
    expect(ALL_TEXTS.length).toBeGreaterThan(300);
    expect(Object.keys(ZODIAC_PROFILES)).toHaveLength(12);
  });

  it.each<[string, readonly string[]]>([
    ['决策类（不做决策依据）', DECISION_WORDS],
    ['医疗类（不暗示诊断治疗）', MEDICAL_WORDS],
    ['承诺类（不说必然）', PROMISE_WORDS],
    ['命理类（只做文化解读）', DIVINATION_WORDS],
  ])('【关键】全部文案不含%s的表述', (_label, words) => {
    const hits: string[] = [];

    for (const [where, text] of ALL_TEXTS) {
      for (const word of words) {
        if (text.includes(word)) hits.push(`${where}: 「${text}」含「${word}」`);
      }
    }

    expect(hits).toEqual([]);
  });

  it('【关键】"宜"只写日常小事：不含任何决策类活动', () => {
    for (const item of GOOD_ACTIVITIES) {
      for (const word of DECISION_WORDS) {
        expect(item).not.toContain(word);
      }
    }
  });

  it('状态维度的文案不谈疾病与身体指标（只谈作息、运动、饮水、用眼）', () => {
    const healthTexts = [
      ...DIMENSION_LINES.HEALTH.LOW,
      ...DIMENSION_LINES.HEALTH.MID,
      ...DIMENSION_LINES.HEALTH.HIGH,
    ].join('\n');

    for (const word of MEDICAL_WORDS) {
      expect(healthTexts).not.toContain(word);
    }

    // 正向要求：至少要谈到具体的日常动作，不能只有"注意身体"这种空话
    expect(healthTexts).toMatch(/睡|运动|水|走|坐|咖啡|眼睛|作息/);
  });

  it('每个星座的档案字段齐备（性格/爱情/事业/友情 + 3 优势 + 3 留意）', () => {
    for (const sign of ZODIAC_SIGNS) {
      const profile = ZODIAC_PROFILES[sign];

      expect(profile.name.length).toBeGreaterThan(1);
      expect(profile.dateRange).toMatch(/^\d{2}-\d{2} ~ \d{2}-\d{2}$/);
      expect(profile.ruler.length).toBeGreaterThan(0);
      expect(profile.traits).toHaveLength(3);

      for (const text of [profile.personality, profile.love, profile.career, profile.friendship]) {
        expect(text.length).toBeGreaterThan(20);
      }

      expect(profile.strengths).toHaveLength(3);
      expect(profile.watchouts).toHaveLength(3);
    }
  });

  it('【关键】"需要留意"的措辞不是人格否定（不出现"你很自私/你有问题"这类判定）', () => {
    const judgemental = ['你很自私', '你有问题', '你不正常', '性格缺陷', '你错了', '很糟糕', '很失败'];

    for (const sign of ZODIAC_SIGNS) {
      for (const item of ZODIAC_PROFILES[sign].watchouts) {
        for (const word of judgemental) {
          expect(item).not.toContain(word);
        }
      }
    }
  });

  it('五维文案每档至少 5 条（同一档位反复出现会立刻被察觉）', () => {
    for (const dimension of FORTUNE_DIMENSIONS) {
      for (const band of ['LOW', 'MID', 'HIGH'] as const) {
        expect(DIMENSION_LINES[dimension][band].length).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('同一维度内不出现重复文案（重复会让用户觉得内容没更新）', () => {
    for (const dimension of FORTUNE_DIMENSIONS) {
      const all = [
        ...DIMENSION_LINES[dimension].LOW,
        ...DIMENSION_LINES[dimension].MID,
        ...DIMENSION_LINES[dimension].HIGH,
      ];

      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('十二星座的档案文案互不相同（复制粘贴会让"个人化"当场露馅）', () => {
    const personalities = ZODIAC_SIGNS.map((sign) => ZODIAC_PROFILES[sign].personality);

    expect(new Set(personalities).size).toBe(personalities.length);
  });

  it('幸运元素表齐备且无重复', () => {
    expect(LUCKY_COLORS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(LUCKY_COLORS.map((item) => item.name)).size).toBe(LUCKY_COLORS.length);
    // 色值必须是合法十六进制，前端要直接用于色块渲染
    for (const color of LUCKY_COLORS) expect(color.hex).toMatch(/^#[0-9A-F]{6}$/);

    expect(LUCKY_DIRECTIONS.length).toBeGreaterThanOrEqual(4);
    expect(LUCKY_HOURS.length).toBeGreaterThanOrEqual(4);
  });

  it('配对基调覆盖全部元素组合（4×4 去掉重复方向共 10 种）', () => {
    // 元素两两组合（无顺序）：FIRE/EARTH/AIR/WATER → 10 种
    expect(Object.keys(MATCH_ELEMENT_NOTES)).toHaveLength(10);
  });
});
