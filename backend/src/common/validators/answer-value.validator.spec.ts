/**
 * 答案值校验器 + 保存答案 DTO 的管道回归测试
 *
 * 真实缺陷（发布会阻塞）：`AnswerItemDto.value` 原先只挂了 `@Transform`，
 * 没有任何 class-validator 装饰器。全局管道开启了 `whitelist: true` +
 * `forbidNonWhitelisted: true`，而 `whitelist` 依据的是**校验元数据** ——
 * 于是 `value` 被判为「非白名单字段」，`PUT /tests/sessions/{id}/answers`
 * 对**所有客户端**返回 400 / 10001，答题链路整体不可用。
 *
 * 原单测全部直接构造 DTO 对象调用 Service，绕过了 ValidationPipe，
 * 因此这个缺陷在 1370 个测试全绿的情况下依然存在。本文件用**生产同款管道配置**
 * 在管道边界实测，补上缺失的那一层。
 */

import { ValidationPipe } from '@nestjs/common';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { IsAnswerValue } from './answer-value.validator';
import { AnswerItemDto, SaveAnswersDto } from '../../modules/test/dto/test.dto';

// ------------------------------------------------------------------ 测试载体

class ValueHolder {
  @IsAnswerValue()
  value!: unknown;
}

const checkValue = (value: unknown): string[] =>
  validateSync(plainToInstance(ValueHolder, { value })).flatMap((item) => Object.values(item.constraints ?? {}));

// --------------------------------------------------- 生产环境同款全局管道配置

const createProdPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    validationError: { target: false, value: false },
    stopAtFirstError: false,
  });

const QUESTION_ID = '01a12dd7-7356-7f22-b940-7f78a3e44927';

describe('IsAnswerValue 形状校验', () => {
  it.each([1, 5, 0, -1, 100])('接受整数 %p（值域由 Service 判定，不在此处限制）', (value) => {
    expect(checkValue(value)).toEqual([]);
  });

  it('接受非空整数数组（排序题传全部选项 value 的排列）', () => {
    expect(checkValue([1, 2, 3, 4, 5])).toEqual([]);
  });

  it.each([1.5, NaN, Infinity])('拒绝非整数数字 %p', (value) => {
    expect(checkValue(value)).not.toEqual([]);
  });

  it('拒绝空数组', () => {
    expect(checkValue([])).not.toEqual([]);
  });

  it('拒绝含非整数的数组', () => {
    expect(checkValue([1, '2'])).not.toEqual([]);
  });

  it.each(['3', null, undefined, {}, true])('拒绝非数字非数组的 %p', (value) => {
    expect(checkValue(value)).not.toEqual([]);
  });
});

describe('保存答案 DTO 与全局管道（回归）', () => {
  it('合法载荷通过校验，且 value 不被 whitelist 剥离', async () => {
    const pipe = createProdPipe();
    const payload = {
      answers: [{ questionId: QUESTION_ID, value: 3 }],
    };

    const result: SaveAnswersDto = await pipe.transform(payload, {
      type: 'body',
      metatype: SaveAnswersDto,
    });

    // 关键断言：修复前 value 无校验元数据，会被 whitelist 剔除并整批 400
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]).toBeInstanceOf(AnswerItemDto);
    expect(result.answers[0].value).toBe(3);
  });

  it('排序题的数组 value 同样不被剥离', async () => {
    const pipe = createProdPipe();
    const result: SaveAnswersDto = await pipe.transform(
      { answers: [{ questionId: QUESTION_ID, value: [1, 2, 3] }] },
      { type: 'body', metatype: SaveAnswersDto },
    );

    expect(result.answers[0].value).toEqual([1, 2, 3]);
  });

  it('value 类型不符时在管道层被拒绝（契约 §3.3.5 的 10001）', async () => {
    const pipe = createProdPipe();

    await expect(
      pipe.transform(
        { answers: [{ questionId: QUESTION_ID, value: '三' }] },
        { type: 'body', metatype: SaveAnswersDto },
      ),
    ).rejects.toThrow();
  });

  it('含未声明字段的答案元素仍被拒绝（forbidNonWhitelisted 保持生效）', async () => {
    const pipe = createProdPipe();

    await expect(
      pipe.transform(
        { answers: [{ questionId: QUESTION_ID, value: 3, optionId: 'abc' }] },
        { type: 'body', metatype: SaveAnswersDto },
      ),
    ).rejects.toThrow();
  });
});
