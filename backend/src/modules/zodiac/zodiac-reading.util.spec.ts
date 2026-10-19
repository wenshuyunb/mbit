/**
 * 星盘解读（模板 + 提示词 + 解析）的用例
 *
 * ## 这一层测什么、为什么必须测
 *
 * 解读正文是"给用户看的判断性文字"，因此有三类风险**代码不会报错、只有用例能拦住**：
 *
 *   ① **合规**：一旦模型或模板写出"建议你辞职""你今年必定…"，产品就从"娱乐内容"
 *      变成了"决策建议"，这是有真实风险的。提示词里的红线必须存在，模板输出必须干净；
 *   ② **缓存指纹**：解读按 `chartHash` 缓存。指纹算错（例如漏了时区）会导致
 *      "用户改了出生信息却还是旧解读"，或者"什么都没改却反复重新生成烧钱"；
 *   ③ **模型返回格式**：模型不按 JSON 回答是常态。解析器必须能过滤掉自创章节、
 *      过短正文与非法 key，而不是把垃圾直接塞进数据库。
 */

import { buildNatalChart } from './zodiac-chart.util';
import {
  buildReadingUserPrompt,
  parseReadingSections,
  READING_SECTION_KEYS,
  READING_SYSTEM_PROMPT,
} from './zodiac-reading.prompt';
import { buildChartHash, buildTemplateReading } from './zodiac-reading.util';

/** 一份完整的出生信息（1988-07-15 14:30 北京，落在夏令时窗口内） */
const FULL_BIRTH = {
  birthday: '1988-07-15',
  birthTime: '14:30',
  birthPlace: '北京',
  birthLatitude: 39.9042,
  birthLongitude: 116.4074,
} as const;

const chartOf = (input: Parameters<typeof buildNatalChart>[0]): ReturnType<typeof buildNatalChart> =>
  buildNatalChart(input);

describe('buildChartHash：缓存指纹', () => {
  it('同一份出生信息永远得到同一个指纹（否则每次进来都重新生成）', () => {
    const first = buildChartHash(chartOf(FULL_BIRTH));

    for (let index = 0; index < 20; index += 1) {
      expect(buildChartHash(chartOf(FULL_BIRTH))).toBe(first);
    }
  });

  it('【关键】出生时间、经纬度、时区任一变化 → 指纹必须变化（否则用户改了资料还是旧解读）', () => {
    const base = buildChartHash(chartOf(FULL_BIRTH));

    expect(buildChartHash(chartOf({ ...FULL_BIRTH, birthTime: '15:30' }))).not.toBe(base);
    expect(buildChartHash(chartOf({ ...FULL_BIRTH, birthLongitude: 120.1551 }))).not.toBe(base);
    expect(buildChartHash(chartOf({ ...FULL_BIRTH, birthLatitude: 30.2741 }))).not.toBe(base);
    expect(buildChartHash(chartOf({ ...FULL_BIRTH, birthTimezoneOffset: 6 }))).not.toBe(base);
  });

  it('生日变化同样会换指纹', () => {
    expect(buildChartHash(chartOf({ ...FULL_BIRTH, birthday: '1988-07-16' }))).not.toBe(
      buildChartHash(chartOf(FULL_BIRTH)),
    );
  });

  it('指纹足够短（会进 VARCHAR(32) 索引）', () => {
    expect(buildChartHash(chartOf(FULL_BIRTH)).length).toBeLessThanOrEqual(32);
  });
});

describe('buildTemplateReading：模板解读', () => {
  const chart = chartOf(FULL_BIRTH);
  const reading = buildTemplateReading(chart);

  it('六个章节齐全且顺序固定（前端按 key 渲染）', () => {
    expect(reading.sections.map((section) => section.key)).toEqual([...READING_SECTION_KEYS]);
  });

  it('每章都有标题与正文，正文长度足够（不是一句话敷衍）', () => {
    for (const section of reading.sections) {
      expect(section.title.length).toBeGreaterThan(3);
      expect(section.body.length).toBeGreaterThan(80);
    }
  });

  it('首段（免费部分）非空，且说出了三巨头', () => {
    expect(reading.preview.length).toBeGreaterThan(20);
    expect(reading.preview).toContain('太阳');
    expect(reading.preview).toContain('月亮');
  });

  it('【关键】正文用的是**盘上真实数据**，不是通用套话', () => {
    const sunSign = chart.positions.find((item) => item.key === 'SUN')?.signName ?? '';
    const ascSign = chart.angles.ascendant?.signName ?? '';

    expect(reading.sections[0].body).toContain(sunSign);
    expect(reading.sections[0].body).toContain(ascSign);
    // 元素分布章节要出现具体计数
    expect(reading.sections[1].body).toMatch(/\d+ 个/);
  });

  it('缺出生时间/城市时也能生成（只是上升与宫位章节改为提示补全）', () => {
    const partial = buildTemplateReading(chartOf({ birthday: '1988-07-15' }));

    expect(partial.sections).toHaveLength(READING_SECTION_KEYS.length);
    expect(partial.sections[0].body).toContain('上升星座需要出生时间与出生城市');
    expect(partial.preview).toContain('补齐出生时间');
  });

  it('【合规】模板正文不得出现决策引导、医疗暗示、承诺式预测与占卜词汇', () => {
    const forbidden = [
      '投资',
      '买房',
      '签约',
      '辞职',
      '离婚',
      '就医',
      '疾病',
      '症状',
      '诊断',
      '必定',
      '一定会',
      '准确率',
      '保证',
      '算命',
      '风水',
      '转运',
      '消灾',
      '改命',
    ];

    const text = [reading.preview, ...reading.sections.map((section) => `${section.title}${section.body}`)].join('\n');

    for (const word of forbidden) {
      expect(`${word}:${text.includes(word)}`).toBe(`${word}:false`);
    }
  });

  it('两份不同的盘要给出不同的正文（否则"解读"只是套模板）', () => {
    const other = buildTemplateReading(
      chartOf({ birthday: '1995-03-20', birthTime: '08:00', birthLatitude: 31.2304, birthLongitude: 121.4737 }),
    );

    expect(other.sections[0].body).not.toBe(reading.sections[0].body);
  });
});

describe('buildReadingUserPrompt：喂给模型的证据', () => {
  const chart = chartOf(FULL_BIRTH);
  const prompt = buildReadingUserPrompt(chart);

  it('包含三巨头、行星、元素、相位、命主星、宫位六类事实', () => {
    for (const label of ['【三巨头】', '【十大行星】', '【元素分布】', '【主要相位', '【命主星】', '【宫位】']) {
      expect(prompt).toContain(label);
    }
  });

  it('写的是盘上真实位置（抽查太阳与上升）', () => {
    const sun = chart.positions.find((item) => item.key === 'SUN');
    const asc = chart.angles.ascendant;

    expect(prompt).toContain(sun?.position ?? '');
    expect(prompt).toContain(asc?.position ?? '');
  });

  it('缺时间/城市时如实写"未知"，而不是编一个', () => {
    const partial = buildReadingUserPrompt(chartOf({ birthday: '1988-07-15' }));

    expect(partial).toContain('未知');
  });

  it('【合规】提示词里写明了全部五条红线', () => {
    for (const line of ['不做决策引导', '不做医疗暗示', '不做承诺式预测', '不用占卜词汇', '不作为人生决策依据']) {
      expect(`${line}:${READING_SYSTEM_PROMPT.includes(line)}`).toBe(`${line}:true`);
    }
  });

  it('要求按固定章节 key 输出结构化 JSON', () => {
    expect(READING_SYSTEM_PROMPT).toContain('"sections"');
    for (const key of READING_SECTION_KEYS) {
      expect(READING_SYSTEM_PROMPT).toContain(key);
    }
  });
});

describe('parseReadingSections：模型返回的兜底解析', () => {
  const valid = {
    key: 'big-three',
    title: '三巨头',
    body: '这是一段足够长的正文，用来验证解析器不会把过短的内容收进来。',
  };

  it('正常 JSON 能被解析', () => {
    expect(parseReadingSections({ sections: [valid] })).toEqual([valid]);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['字符串', 'not-json'],
    ['没有 sections 字段', { foo: 1 }],
    ['sections 不是数组', { sections: 'abc' }],
    ['空数组', { sections: [] }],
  ])('非法输入（%s）返回 null，交给调用方回退模板', (_label, input) => {
    expect(parseReadingSections(input)).toBeNull();
  });

  it('丢弃自创章节（key 不在白名单里，前端无法渲染）', () => {
    const result = parseReadingSections({
      sections: [valid, { key: 'made-up', title: '自创', body: '这一段的正文也足够长了，但它不该被收进来。' }],
    });

    expect(result).toHaveLength(1);
    expect(result?.[0]?.key).toBe('big-three');
  });

  it('丢弃标题为空或正文过短的章节', () => {
    const result = parseReadingSections({
      sections: [
        valid,
        { key: 'elements', title: '', body: '正文足够长足够长足够长足够长足够长' },
        { key: 'aspects', title: '相位', body: '太短' },
      ],
    });

    expect(result).toHaveLength(1);
  });

  it('同一个 key 只保留第一次出现（重复会让前端渲染两遍）', () => {
    const result = parseReadingSections({ sections: [valid, { ...valid, body: `${valid.body}重复的一段` }] });

    expect(result).toHaveLength(1);
  });

  it('全部不合格时返回 null（调用方据此保留模板版）', () => {
    expect(parseReadingSections({ sections: [{ key: 'xxx', title: 'a', body: 'b' }] })).toBeNull();
  });
});
