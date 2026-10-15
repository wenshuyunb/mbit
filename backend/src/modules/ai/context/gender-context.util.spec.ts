/**
 * 报告性别语境测试（ADR-039）
 *
 * ## 这里锁的是"性别不许影响结论"这条边界
 *
 * 用户要求"报告按性别出"，但**测量结论不能按性别变**：同一份依恋焦虑分数
 * 在男女身上是同一个分数。性别只允许影响举例、称呼与处境选取。
 * 一旦它渗进结论，报告就从"测量结果"变成"社会角色期待" ——
 * 既不准，也会让两版的分数量纲不再可比。
 *
 * 因此下面既断言"该有的语境在"，也断言"该有的禁令在"：
 * 提示词里没有禁令时，模型几乎一定会顺手写出性别刻板印象。
 */

import { buildGenderContext, resolveReportGenderFraming } from './gender-context.util';

describe('resolveReportGenderFraming', () => {
  it.each([
    ['MALE', 'MALE'],
    ['FEMALE', 'FEMALE'],
    // 「不想说」与"从没问过"在报告里是同一个结果：中性措辞
    ['UNKNOWN', 'NEUTRAL'],
    ['OTHER', 'NEUTRAL'],
    [null, 'NEUTRAL'],
    [undefined, 'NEUTRAL'],
    ['', 'NEUTRAL'],
    ['male', 'NEUTRAL'],
  ])('%s → %s', (input, expected) => {
    expect(resolveReportGenderFraming(input)).toBe(expected);
  });
});

describe('buildGenderContext', () => {
  it('男生：指明视角，并给出称呼示例', () => {
    const text = buildGenderContext('MALE');

    expect(text).toContain('男生');
    expect(text).toContain('你和她');
  });

  it('女生：指明视角，并给出称呼示例', () => {
    const text = buildGenderContext('FEMALE');

    expect(text).toContain('女生');
    expect(text).toContain('你和他');
  });

  it('未提供性别：要求中性措辞，且**不得假设、不得询问、不得提及**', () => {
    const text = buildGenderContext(null);

    expect(text).toContain('未提供性别');
    expect(text).toContain('对方');
    expect(text).toContain('不要假设');
    expect(text).toContain('不要询问');
  });

  it.each(['MALE', 'FEMALE', null])('【关键】%s 都必须带"性别不影响结论"的约束', (gender) => {
    const text = buildGenderContext(gender);

    // 没有这句，模型很容易写成"因为你是男生，所以你的回避分高"
    expect(text).toContain('不影响任何结论');
    expect(text).toContain('同一个分数');
  });

  it.each(['MALE', 'FEMALE', null])('【关键】%s 都必须显式禁止性别刻板印象', (gender) => {
    const text = buildGenderContext(gender);

    expect(text).toContain('严禁性别刻板印象');
    expect(text).toContain('男生不该');
    expect(text).toContain('女生都');
  });

  it('【关键】任何取值都返回可用文本 —— 不能是"未提供"占位', () => {
    // 占位文案会让模型自行脑补一个性别，而这份报告是要给用户看的
    for (const gender of ['MALE', 'FEMALE', 'UNKNOWN', 'OTHER', null, undefined]) {
      const text = buildGenderContext(gender);

      expect(text.length).toBeGreaterThan(50);
      expect(text).not.toContain('未包含此项');
      expect(text).not.toContain('未提供此项');
    }
  });
});
