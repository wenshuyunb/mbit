/**
 * 查询串布尔解析（含**真实转换链**的回归测试）
 *
 * 最有价值的那条不是"函数本身对不对"，而是**走一遍与 `main.ts` 同配置的
 * 真实 ValidationPipe**：这个缺陷恰恰是"函数写对了但根本没被调用到正确位置上"
 * —— 隐式转换先于 `@Transform` 执行，所以单测直接调 `parseQueryBoolean({ value: 'false' })`
 * 会通过，而线上 `?flag=false` 仍然是 `true`。
 */

import { ValidationPipe } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { parseQueryBoolean } from './query-boolean.util';

class ProbeDto {
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  flag?: boolean;
}

/** 与 `main.ts` 的全局管道同配置（**这条测试的全部意义就在这里**） */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const transformQuery = async (value: Record<string, unknown>): Promise<ProbeDto> =>
  (await pipe.transform(value, { type: 'query', metatype: ProbeDto })) as ProbeDto;

describe('parseQueryBoolean', () => {
  it('直接调用：识别常见布尔字面量', () => {
    expect(parseQueryBoolean({ value: 'true' })).toBe(true);
    expect(parseQueryBoolean({ value: 'false' })).toBe(false);
    expect(parseQueryBoolean({ value: '1' })).toBe(true);
    expect(parseQueryBoolean({ value: '0' })).toBe(false);
    expect(parseQueryBoolean({ value: ' TRUE ' })).toBe(true);
    expect(parseQueryBoolean({ value: 'False' })).toBe(false);
  });

  it('已经是布尔/数字时原样透出（该类字段也可能来自 JSON 请求体）', () => {
    expect(parseQueryBoolean({ value: true })).toBe(true);
    expect(parseQueryBoolean({ value: false })).toBe(false);
    expect(parseQueryBoolean({ value: 1 })).toBe(true);
    expect(parseQueryBoolean({ value: 0 })).toBe(false);
  });

  it('无法识别的值原样透出（交给 @IsBoolean 拒绝，不猜默认值）', () => {
    expect(parseQueryBoolean({ value: 'maybe' })).toBe('maybe');
    expect(parseQueryBoolean({ value: 'yes' })).toBe('yes');
  });

  it('【关键】优先读 `obj[key]` 的原始字符串（隐式转换已把 `value` 变成 true）', () => {
    // 这正是线上发生的事：`value` 已被隐式转换污染，唯有 `obj` 还留着原值
    expect(parseQueryBoolean({ value: true, obj: { flag: 'false' }, key: 'flag' })).toBe(false);
    expect(parseQueryBoolean({ value: true, obj: { flag: '0' }, key: 'flag' })).toBe(false);
    expect(parseQueryBoolean({ value: true, obj: { flag: 'true' }, key: 'flag' })).toBe(true);
  });

  describe('走真实 ValidationPipe（防"函数对了但接线错了"）', () => {
    it('【关键】?flag=false 必须得到 false —— 这是此前全局失效的那一条', async () => {
      await expect(transformQuery({ flag: 'false' })).resolves.toMatchObject({ flag: false });
    });

    it('?flag=true / ?flag=1 / ?flag=0 都正确', async () => {
      await expect(transformQuery({ flag: 'true' })).resolves.toMatchObject({ flag: true });
      await expect(transformQuery({ flag: '1' })).resolves.toMatchObject({ flag: true });
      await expect(transformQuery({ flag: '0' })).resolves.toMatchObject({ flag: false });
    });

    it('未传时保持 undefined（由调用方套用各自契约的默认值）', async () => {
      const dto = await transformQuery({});

      expect(dto.flag).toBeUndefined();
    });

    it('无法识别的值被 400 拒绝（而不是静默当成 true）', async () => {
      await expect(transformQuery({ flag: 'maybe' })).rejects.toBeDefined();
    });
  });
});
