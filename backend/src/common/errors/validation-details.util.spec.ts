import type { ValidationError } from 'class-validator';

import { flattenValidationErrors } from './validation-details.util';

const error = (
  property: string,
  constraints?: Record<string, string>,
  children?: ValidationError[],
): ValidationError => ({
  property,
  constraints,
  children,
});

describe('flattenValidationErrors', () => {
  it('展平顶层字段的约束', () => {
    const result = flattenValidationErrors([error('nickname', { isString: 'nickname 必须是字符串' })]);

    expect(result).toEqual([{ field: 'nickname', issue: 'nickname 必须是字符串' }]);
  });

  it('同一字段的多个约束各自产出一条明细', () => {
    const result = flattenValidationErrors([error('nickname', { isString: '必须是字符串', length: '长度不合法' })]);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.field)).toEqual(['nickname', 'nickname']);
  });

  it('递归展平嵌套 DTO，并带上数组下标（真实缺陷回归）', () => {
    // 这正是 `answers[].value` 报错时的真实结构：顶层 `answers` 没有 constraints，
    // 约束全部藏在 children 里。旧的「只展平一层」实现会得到空数组，
    // 而空 details 会被响应过滤器整体省略，客户端只看到「请求参数不合法」。
    const result = flattenValidationErrors([
      error('answers', undefined, [
        error('0', undefined, [error('value', { isAnswerValue: 'value 必须是整数，或非空的整数数组' })]),
      ]),
    ]);

    expect(result).toEqual([{ field: 'answers.0.value', issue: 'value 必须是整数，或非空的整数数组' }]);
  });

  it('嵌套层级本身报错时也能输出（如嵌套对象类型不符）', () => {
    const result = flattenValidationErrors([
      error('answers', undefined, [error('0', { nestedValidation: 'answers.0 嵌套校验失败' })]),
    ]);

    expect(result).toEqual([{ field: 'answers.0', issue: 'answers.0 嵌套校验失败' }]);
  });

  it('空错误列表返回空明细', () => {
    expect(flattenValidationErrors([])).toEqual([]);
  });

  it('没有 constraints 也没有 children 时不产生明细', () => {
    expect(flattenValidationErrors([error('mystery')])).toEqual([]);
  });
});
