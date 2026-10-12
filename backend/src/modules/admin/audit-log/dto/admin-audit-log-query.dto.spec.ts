/**
 * 审计日志查询参数校验（契约 §3.14.9.3 Query 参数）
 *
 * 用与 `main.ts` **同配置**的真实 `ValidationPipe`（`whitelist` +
 * `forbidNonWhitelisted` + `enableImplicitConversion`）走一遍，而不是手搓
 * `validate()`：
 *   · `whitelist` 会剔除未声明字段，`forbidNonWhitelisted` 会直接报错 —— 少声明一个
 *     契约参数就会让**正常请求**变成 10001，这是最容易漏的一类缺陷；
 *   · `enableImplicitConversion` 会把 query 里的字符串按反射类型转换，
 *     必须确认 `startTime` **仍然是 string**（Service 侧按字符串解析 ISO），
 *     否则会把 `Date` 传进 `new Date(value)` 而得到 Invalid Date。
 */

import { ValidationPipe } from '@nestjs/common';
import type { BadRequestException } from '@nestjs/common';

import { AdminAuditLogQueryDto } from './admin-audit-log-query.dto';

const queryPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

/** 合法基础参数（每个用例只改其中一项，避免多个错误互相掩盖） */
const VALID_QUERY: Record<string, unknown> = {
  startTime: '2026-02-01T00:00:00.000Z',
  endTime: '2026-02-14T23:59:59.999Z',
};

const transformQuery = async (payload: Record<string, unknown>): Promise<AdminAuditLogQueryDto> => {
  const result = await queryPipe.transform(payload, { type: 'query', metatype: AdminAuditLogQueryDto });

  return result as AdminAuditLogQueryDto;
};

/** 校验失败时的错误消息（空数组表示通过） */
const rejectionMessages = async (payload: Record<string, unknown>): Promise<string[]> => {
  try {
    await transformQuery(payload);
    return [];
  } catch (error) {
    const response = (error as BadRequestException).getResponse();
    const messages = (response as { message?: string[] | string }).message ?? '';

    return Array.isArray(messages) ? messages : [messages];
  }
};

const hasMessageAbout = (messages: readonly string[], field: string): boolean =>
  messages.some((message) => message.includes(field));

describe('AdminAuditLogQueryDto 校验（API_DESIGN §3.14.9.3）', () => {
  it('契约示例的查询参数可以原样通过', async () => {
    const dto = await transformQuery({
      ...VALID_QUERY,
      page: '1',
      pageSize: '20',
      severity: 'CRITICAL',
    });

    expect(dto.severity).toBe('CRITICAL');
    // 隐式转换不能把时间串变成 Date（Service 依赖字符串形态做 ISO 解析）
    expect(typeof dto.startTime).toBe('string');
    expect(typeof dto.endTime).toBe('string');
  });

  it('分页有默认值 1 / 20（未传时不能是 undefined）', async () => {
    const dto = await transformQuery(VALID_QUERY);

    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
    expect(dto.skip).toBe(0);
    expect(dto.take).toBe(20);
  });

  it('【关键】startTime / endTime 必填（契约标为必填）', async () => {
    expect(hasMessageAbout(await rejectionMessages({ endTime: VALID_QUERY['endTime'] }), 'startTime')).toBe(true);
    expect(hasMessageAbout(await rejectionMessages({ startTime: VALID_QUERY['startTime'] }), 'endTime')).toBe(true);
  });

  it('非法 ISO 串被拒绝', async () => {
    expect(hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, startTime: 'not-a-time' }), 'startTime')).toBe(
      true,
    );
    expect(hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, endTime: '31/02/2026' }), 'endTime')).toBe(true);
  });

  it('枚举越界被拒绝：targetType / severity / result / sortBy / order', async () => {
    expect(await rejectionMessages({ ...VALID_QUERY, targetType: 'COUPON' })).not.toHaveLength(0);
    expect(await rejectionMessages({ ...VALID_QUERY, severity: 'HIGH' })).not.toHaveLength(0);
    expect(await rejectionMessages({ ...VALID_QUERY, result: 'PENDING' })).not.toHaveLength(0);
    // 白名单只有 createdAt（用 10001，而非语义不符的 10004）
    expect(hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, sortBy: 'updatedAt' }), 'sortBy')).toBe(true);
    expect(hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, order: 'ASC' }), 'order')).toBe(true);
  });

  it('targetType / severity / result 的契约枚举值全部可用', async () => {
    for (const targetType of [
      'USER',
      'ORDER',
      'REFUND',
      'QUESTION',
      'TEST_DEFINITION',
      'PROMPT',
      'CONFIG',
      'ROLE',
      'ADMIN',
      'REPORT',
      'RELATIONSHIP',
    ]) {
      await expect(transformQuery({ ...VALID_QUERY, targetType })).resolves.toBeDefined();
    }

    for (const severity of ['NORMAL', 'SENSITIVE', 'CRITICAL']) {
      await expect(transformQuery({ ...VALID_QUERY, severity })).resolves.toBeDefined();
    }

    for (const result of ['SUCCESS', 'FAILED', 'DENIED']) {
      await expect(transformQuery({ ...VALID_QUERY, result })).resolves.toBeDefined();
    }
  });

  it('action 支持逗号分隔多值，并做去空白与丢弃空段', async () => {
    const dto = await transformQuery({
      ...VALID_QUERY,
      action: 'payment:order:refund, ai:prompt:publish ,,',
    });

    expect(dto.action).toEqual(['payment:order:refund', 'ai:prompt:publish']);
  });

  it('action 为空串时视为未传（不产生空数组条件）', async () => {
    const dto = await transformQuery({ ...VALID_QUERY, action: '   ' });

    expect(dto.action).toBeUndefined();
  });

  it('action 数量有上限（挡住「一个请求塞上千个 OR」）', async () => {
    const many = Array.from({ length: 21 }, (_value, index) => `refund${index}`).join(',');

    expect(hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, action: many }), 'action')).toBe(true);
  });

  it('keyword / targetId 按契约限制长度（≤ 64 字符）', async () => {
    const tooLong = 'x'.repeat(65);

    expect(hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, keyword: tooLong }), 'keyword')).toBe(true);
    expect(hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, targetId: tooLong }), 'targetId')).toBe(true);
    await expect(transformQuery({ ...VALID_QUERY, keyword: 'x'.repeat(64) })).resolves.toBeDefined();
  });

  it('operatorAdminId 必须是 UUID（非 UUID 会让 PostgreSQL 报错而不是查不到）', async () => {
    expect(
      hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, operatorAdminId: 'admin-1' }), 'operatorAdminId'),
    ).toBe(true);

    // UUIDv7（本仓库主键形态）必须通过：class-validator 的 isUUID 只认 v1–v5，不能用它
    await expect(
      transformQuery({ ...VALID_QUERY, operatorAdminId: '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a' }),
    ).resolves.toBeDefined();
  });

  it('pageSize 上限 100（契约 ≤ 100）', async () => {
    expect(hasMessageAbout(await rejectionMessages({ ...VALID_QUERY, pageSize: '101' }), 'pageSize')).toBe(true);
  });

  it('未声明的查询参数被拒绝（避免前端以为过滤生效、实际是全量数据）', async () => {
    expect(await rejectionMessages({ ...VALID_QUERY, ip: '203.0.113.42' })).not.toHaveLength(0);
  });
});
