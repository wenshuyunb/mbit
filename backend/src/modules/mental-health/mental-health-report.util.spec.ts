/**
 * 心理状态自评**解读层**测试
 *
 * 用户的实测反馈是「心理评测报告没有特色、没有建设性建议、我看不出个所以然来」。
 * 这一层就是补那两件事：**看得懂**（每维一句人话）与**拿得走**（三条当天能做的小事 +
 * 什么时候找人聊聊）。
 *
 * 因此这里守的不是"函数返回了什么"，而是三条产品红线：
 *
 *   ① **建议必须具体**：不许出现"多休息""保持乐观"这类正确但没用的话
 *      （本模块最容易滑向"说了等于没说"）；
 *   ② **不许越界到临床**：不得出现药物/治疗/诊断类措辞，也不许用"你患有…"的句式；
 *   ③ **必须给求助指引**：三档都要有，且热线号码是**国家卫健委统一号码 12356**
 *      —— 写错一个数字，用户在最需要的时候打不通。
 */

import {
  MENTAL_HEALTH_BAND_LABEL_MAP,
  buildMentalHealthReportExtras,
  isMentalHealthDimension,
} from './mental-health-report.util';

/** 造一份六维快照（默认都平稳，用例按需抬高某一维） */
const snapshot = (
  scores: Partial<Record<string, number>> = {},
): Record<string, { score: number; band: string; usable: boolean }> =>
  Object.fromEntries(
    ['MH_STRESS', 'MH_MOOD', 'MH_ANXIETY', 'MH_SLEEP', 'MH_ENERGY', 'MH_LONELINESS'].map((key) => {
      const score = scores[key] ?? 20;

      return [
        key,
        {
          score,
          band: score >= 70 ? 'NOTABLE' : score >= 50 ? 'MILD' : score >= 30 ? 'SLIGHT' : 'CALM',
          usable: true,
        },
      ];
    }),
  );

describe('buildMentalHealthReportExtras', () => {
  it('六维各一句人话解释（含义 + 常见体验），顺序固定', () => {
    const extras = buildMentalHealthReportExtras(snapshot(), 'GOOD');

    expect(extras.readings).toHaveLength(6);
    expect(extras.readings.map((item) => item.key)).toEqual([
      'MH_STRESS',
      'MH_MOOD',
      'MH_ANXIETY',
      'MH_SLEEP',
      'MH_ENERGY',
      'MH_LONELINESS',
    ]);

    for (const reading of extras.readings) {
      expect(reading.meaning.length).toBeGreaterThan(10);
      expect(reading.commonExperience.length).toBeGreaterThan(10);
      expect(reading.label.length).toBeGreaterThan(0);
    }
  });

  it('【关键】只看最值得留意的两项（六条平铺等于没有重点）', () => {
    const extras = buildMentalHealthReportExtras(snapshot({ MH_SLEEP: 88, MH_STRESS: 72, MH_MOOD: 60 }), 'NOTABLE');

    expect(extras.highlights).toHaveLength(2);
    expect(extras.highlights.map((item) => item.key)).toEqual(['MH_SLEEP', 'MH_STRESS']);
  });

  it('重点项并列时按固定维度顺序（同一份数据每次排序一致）', () => {
    const extras = buildMentalHealthReportExtras(snapshot({ MH_SLEEP: 80, MH_STRESS: 80 }), 'MILD');

    expect(extras.highlights.map((item) => item.key)).toEqual(['MH_STRESS', 'MH_SLEEP']);
  });

  it('【关键】三条建议都扣回"最高分的那一维"，并带上维度名', () => {
    const extras = buildMentalHealthReportExtras(snapshot({ MH_SLEEP: 90, MH_ANXIETY: 70 }), 'NOTABLE');

    expect(extras.suggestions).toHaveLength(3);
    // 前两条来自最高分维度，第三条来自次高分 —— 用户当下的处境优先
    expect(extras.suggestions[0]?.dimension).toBe('MH_SLEEP');
    expect(extras.suggestions[2]?.dimension).toBe('MH_ANXIETY');

    for (const suggestion of extras.suggestions) {
      expect(suggestion.action.length).toBeGreaterThan(8);
      expect(suggestion.reason.length).toBeGreaterThan(10);
      expect(suggestion.when.length).toBeGreaterThan(2);
      expect(suggestion.dimensionLabel.length).toBeGreaterThan(0);
    }
  });

  it('【关键】建议是具体动作，不是"多休息 / 保持乐观 / 放平心态"这类空话', () => {
    const empty = ['多休息', '保持乐观', '放平心态', '多沟通', '要自信', '别想太多', '注意身体'];

    for (const level of ['GOOD', 'MILD', 'NOTABLE'] as const) {
      const extras = buildMentalHealthReportExtras(snapshot({ MH_STRESS: 90, MH_MOOD: 80, MH_ANXIETY: 70 }), level);

      for (const suggestion of extras.suggestions) {
        for (const phrase of empty) {
          expect(suggestion.action).not.toContain(phrase);
        }
      }
    }
  });

  /**
   * ⚠ 这条断言第一版写成"全文不许出现『诊断』"，判红了 —— 而实现是对的
   *
   * NOTABLE 档的求助文案里有一句「它不是诊断，也说明不了"你是什么样的人"」——
   * 那是**否定式声明**（恰恰在划边界），与免责声明里的「不构成心理诊断」同一类。
   * 把否定式也禁掉，只会逼着文案绕开"诊断"这个词，反而说不清边界。
   *
   * 因此规则是：临床词**允许以否定式出现**，不许作为断言/建议出现。
   * 做法与端到端探针里扫免责声明的那条完全一致：先剥掉允许的否定短语，再扫。
   */
  it('【关键】全部文案不越界到临床（允许"不是诊断"这类否定式声明）', () => {
    const clinical = ['药物', '吃药', '治疗', '诊断', '抑郁症', '焦虑症', '症状', '障碍', '处方', '就医', '痊愈'];
    /** 允许出现的否定式短语（它们本身就是边界声明） */
    const allowedNegations = ['不是诊断', '不构成诊断', '不做诊断', '不构成心理诊断', '不是症状'];

    const extras = buildMentalHealthReportExtras(snapshot({ MH_MOOD: 95, MH_SLEEP: 90 }), 'NOTABLE');

    let allText = [
      ...extras.readings.flatMap((item) => [item.meaning, item.commonExperience]),
      ...extras.suggestions.flatMap((item) => [item.action, item.reason, item.when]),
      extras.endorsement,
      extras.support.title,
      extras.support.text,
      extras.support.hotline.name,
      extras.support.hotline.note,
      extras.retestHint,
    ].join('\n');

    for (const phrase of allowedNegations) {
      allText = allText.split(phrase).join('');
    }

    for (const word of clinical) {
      expect(allText).not.toContain(word);
    }
  });

  it('【关键】三档都给出求助指引，且热线是官方统一号码 12356', () => {
    for (const level of ['GOOD', 'MILD', 'NOTABLE'] as const) {
      const extras = buildMentalHealthReportExtras(snapshot(), level);

      expect(extras.support.title.length).toBeGreaterThan(2);
      expect(extras.support.text.length).toBeGreaterThan(20);
      expect(extras.support.hotline.number).toBe('12356');
      expect(extras.support.hotline.name).toContain('心理援助热线');
    }
  });

  it('求助措辞随档位变化（平稳时告知、突出时明确建议，不许三档同一句）', () => {
    const good = buildMentalHealthReportExtras(snapshot(), 'GOOD').support;
    const notable = buildMentalHealthReportExtras(snapshot(), 'NOTABLE').support;

    expect(good.text).not.toBe(notable.text);
    expect(notable.text).toContain('建议找专业人士聊一次');
    // 平稳档不许制造压力：不能出现"建议找专业人士"这种强建议
    expect(good.text).not.toContain('建议找专业人士');
  });

  it('去污名化的一句随档位变化，且强调"这是这两周的状态，不是你的性格"', () => {
    const mild = buildMentalHealthReportExtras(snapshot(), 'MILD');
    const notable = buildMentalHealthReportExtras(snapshot(), 'NOTABLE');

    expect(mild.endorsement).not.toBe(notable.endorsement);
    expect(mild.endorsement).toContain('不是你的性格');
    expect(notable.endorsement).toContain('不等于');
  });

  it('复测引导存在（把单次分数变成趋势）', () => {
    const extras = buildMentalHealthReportExtras(snapshot(), 'GOOD');

    expect(extras.retestHint).toContain('两周后');
  });

  /**
   * 【关键】文案里不许出现 Markdown 标记与错字
   *
   * 两条都是**实测踩到的**：
   *   · 求助文案里写过 `**建议找专业人士聊一次**` —— 而这一层是**纯文本**下发，
   *     小程序用 `<text>` 渲染，用户看到的是两个星号，不是加粗；
   *   · NOTABLE 档的去污名化那句里混进了一个繁体字（「有幾个方面」）——
   *     简繁混排在这类长文案里极难靠肉眼发现，而它是用户最容易截图转发的一句。
   */
  it('【关键】全部用户可见文案不含 Markdown 标记', () => {
    const markdown = ['**', '##', '`', '- [', '](http'];

    for (const level of ['GOOD', 'MILD', 'NOTABLE'] as const) {
      const extras = buildMentalHealthReportExtras(snapshot({ MH_SLEEP: 90, MH_ANXIETY: 80 }), level);

      const texts = [
        ...extras.readings.flatMap((item) => [item.meaning, item.commonExperience]),
        ...extras.suggestions.flatMap((item) => [item.action, item.reason, item.when]),
        extras.endorsement,
        extras.support.title,
        extras.support.text,
        extras.support.hotline.note,
        extras.retestHint,
      ];

      for (const text of texts) {
        for (const token of markdown) {
          expect(text).not.toContain(token);
        }
      }
    }
  });

  it('【关键】用户可见文案里不出现繁体字（简繁混排肉眼查不出来）', () => {
    // 只列容易混进来的常见繁体/异体字，不求覆盖全部
    const traditional = ['幾', '個', '麼', '這', '說', '會', '來', '為', '對', '應', '覺得'];

    for (const level of ['GOOD', 'MILD', 'NOTABLE'] as const) {
      const extras = buildMentalHealthReportExtras(snapshot({ MH_SLEEP: 90 }), level);

      const texts = [
        ...extras.readings.flatMap((item) => [item.meaning, item.commonExperience]),
        ...extras.suggestions.flatMap((item) => [item.action, item.reason, item.when]),
        extras.endorsement,
        extras.support.title,
        extras.support.text,
        extras.support.hotline.note,
        extras.retestHint,
      ];

      for (const text of texts) {
        for (const word of traditional) {
          expect(text).not.toContain(word);
        }
      }
    }
  });

  it('缺数据的维度不进解读（`usable: false` 不许编出一句结论）', () => {
    const partial = snapshot();
    partial['MH_SLEEP'] = { score: 50, band: 'MILD', usable: false };

    const extras = buildMentalHealthReportExtras(partial, 'MILD');

    expect(extras.readings.map((item) => item.key)).not.toContain('MH_SLEEP');
    expect(extras.readings).toHaveLength(5);
  });

  it('脏数据不抛错：未知档位沿用编码、未知 overallLevel 退回 MILD', () => {
    const extras = buildMentalHealthReportExtras(
      { MH_STRESS: { score: 40, band: 'WHATEVER', usable: true } },
      'WHATEVER',
    );

    expect(extras.readings[0]?.bandLabel).toBe('WHATEVER');
    // 三档里没有的取值按 MILD 处理，不抛错也不给空文案
    expect(extras.support.text.length).toBeGreaterThan(20);
    expect(extras.endorsement.length).toBeGreaterThan(20);
  });

  it('维度白名单与档位名映射对外可用（供调用方校验与展示）', () => {
    expect(isMentalHealthDimension('MH_SLEEP')).toBe(true);
    expect(isMentalHealthDimension('EI')).toBe(false);
    expect(MENTAL_HEALTH_BAND_LABEL_MAP['NOTABLE']).toBe('比较突出');
  });
});
