/**
 * 报告 ID 路径参数校验（契约 §3.5.3 / §3.5.4 / §3.5.6）
 *
 * ## 为什么这个文件必须存在
 *
 * 实测缺陷：`GET /api/v1/reports/not-a-uuid` 返回 **500 / `90002`**，而契约要求
 * `400` / `10001`。原因是 DTO 只声明了 `@IsString` + `@Length`，非法 UUID 一路
 * 进到 Prisma 的 `where: { id }`，由 PostgreSQL 抛 `invalid input syntax for type uuid`，
 * 再被全局过滤器翻译成"数据服务异常"。
 *
 * 这类缺陷**单测全绿也发现不了**：`report.controller.spec.ts` 直接 new 控制器、
 * 手工传参，**绕过了 ValidationPipe**（与交接文档 §6.3 第 9 条同一类陷阱）。
 * 因此这里刻意用与 `main.ts` **同配置**的真实管道走一遍。
 *
 * ## 两个 DTO 必须同口径
 *
 * 本模块有两个报告 ID DTO（`ReportIdParamDto` 服务于已实现的 4 个接口，
 * `ReportIdPathDto` 服务于新增的 5 个接口）。它们曾各带一份 UUID 正则副本，
 * 只要有一份写错，**同一个 ID 在两个接口上就会一个能过一个报错** ——
 * 末位的"一致性"用例专门守住这一点。
 */

import { ValidationPipe } from '@nestjs/common';
import type { BadRequestException } from '@nestjs/common';

import { ReportIdParamDto } from './report.dto';
import { ReportIdPathDto } from './report-engagement.dto';

/** 与 `main.ts` 的全局管道同配置（改一处必须改另一处，否则测试就成了摆设） */
const paramPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

/** 本仓库主键形态：UUIDv7（`class-validator` 的 isUUID 恰恰不认它） */
const UUID_V7 = '0195f3a2-b24e-7a86-abf1-7dae4b5c6f45';

const transformParam = async <T>(metatype: new () => T, value: string): Promise<T> =>
  (await paramPipe.transform({ reportId: value }, { type: 'param', metatype })) as T;

/** 校验失败时的错误消息（空数组表示通过） */
const rejectionMessages = async (metatype: new () => unknown, value: string): Promise<string[]> => {
  try {
    await transformParam(metatype, value);
    return [];
  } catch (error) {
    const response = (error as BadRequestException).getResponse();
    const messages = (response as { message?: string[] | string }).message ?? '';

    return Array.isArray(messages) ? messages : [messages];
  }
};

describe('报告 ID 路径参数校验', () => {
  it('【关键】UUIDv7 通过（用 @IsUUID() 会让所有请求都 400）', async () => {
    await expect(transformParam(ReportIdParamDto, UUID_V7)).resolves.toMatchObject({ reportId: UUID_V7 });
    await expect(transformParam(ReportIdPathDto, UUID_V7)).resolves.toMatchObject({ reportId: UUID_V7 });
  });

  it('【关键】`not-a-uuid` 被拒（这正是实测返回 500/90002 的那个输入）', async () => {
    expect(await rejectionMessages(ReportIdParamDto, 'not-a-uuid')).not.toHaveLength(0);
    expect(await rejectionMessages(ReportIdPathDto, 'not-a-uuid')).not.toHaveLength(0);
  });

  it('其它非法形态同样在入参层被拒（不能让 PostgreSQL 当校验器）', async () => {
    for (const value of [
      '0195f3a2b24e7a86abf17dae4b5c6f45', // 无连字符
      '0195f3a2-b24e-7a86-abf1-7dae4b5c6f4', // 少一位
      '0195f3a2-b24e-7a86-abf1-7dae4b5c6f455', // 多一位
      '0195f3a2-b24e-7a86-abf1-7dae4b5c6f4g', // 非十六进制
      '1', // 过短
      'null', // 字面量 null 串（前端拼串事故的典型产物）
    ]) {
      expect(await rejectionMessages(ReportIdParamDto, value)).not.toHaveLength(0);
    }
  });

  it('长度越界仍报可定位的错误（保留 @Length 的语义，便于前端定位）', async () => {
    const messages = await rejectionMessages(ReportIdParamDto, 'x'.repeat(37));

    // 断言消息文本而不是字段名：本 DTO 用的是**自定义消息**（`报告 ID 长度不合法`），
    // 默认消息才会带属性名 —— 照抄别的 spec 写 `includes('reportId')` 会恒为 false
    expect(messages.some((message) => message.includes('报告 ID'))).toBe(true);
  });

  it('【关键】两个 DTO 对同一组输入的判定完全一致（防两份实现漂移）', async () => {
    const samples = [UUID_V7, 'not-a-uuid', '0195f3a2-b24e-7a86-abf1-7dae4b5c6f4', '', 'ABC'];

    for (const value of samples) {
      const a = await rejectionMessages(ReportIdParamDto, value);
      const b = await rejectionMessages(ReportIdPathDto, value);

      expect(a.length === 0).toBe(b.length === 0);
    }
  });
});
