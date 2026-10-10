/**
 * 错误码体系一致性测试
 *
 * 价值：随着模块增加，极易出现「新增错误码但忘记登记 HTTP 状态码 / 中文文案」的情况，
 * 那会导致线上返回 500 + 英文兜底文案。本测试把该约定变成可执行约束。
 */

import { ERROR_HTTP_STATUS, ERROR_MESSAGE, ErrorCode, httpStatusOf, messageOf } from './error-code';

describe('错误码体系', () => {
  const allCodes = Object.entries(ErrorCode) as Array<[keyof typeof ErrorCode, number]>;

  it('错误码应全部为不重复的整数', () => {
    const values = allCodes.map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
    for (const [, value] of allCodes) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('SUCCESS 必须是 0（前端以 code === 0 判定成功）', () => {
    expect(ErrorCode.SUCCESS).toBe(0);
  });

  it('每个错误码都必须登记 HTTP 状态码', () => {
    const missing = allCodes
      .filter(([, value]) => value !== ErrorCode.SUCCESS)
      .filter(([, value]) => ERROR_HTTP_STATUS[value] === undefined)
      .map(([name, value]) => `${name}(${value})`);

    expect(missing).toEqual([]);
  });

  it('每个错误码都必须登记中文用户文案', () => {
    const missing = allCodes
      .filter(([, value]) => ERROR_MESSAGE[value] === undefined)
      .map(([name, value]) => `${name}(${value})`);

    expect(missing).toEqual([]);
  });

  it('错误码必须落在已定义的分段区间内（AABBB 规则）', () => {
    const validSegments = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    for (const [name, value] of allCodes) {
      if (value === ErrorCode.SUCCESS) continue;
      const segment = Math.floor(value / 1000);
      expect(validSegments).toContain(segment);
      expect(String(value)).toHaveLength(5);
      expect(name).toBeTruthy();
    }
  });

  it('5xx 错误文案不得泄露内部实现细节（不出现英文技术名词）', () => {
    const leakyPatterns = [/prisma/i, /postgres/i, /redis/i, /stack/i, /ECONNREFUSED/i, /undefined/i];
    for (const [code, status] of Object.entries(ERROR_HTTP_STATUS)) {
      if (status < 500) continue;
      const text = ERROR_MESSAGE[Number(code)] ?? '';
      for (const pattern of leakyPatterns) {
        expect(text).not.toMatch(pattern);
      }
    }
  });

  it('httpStatusOf 对未知错误码回退 500，messageOf 回退通用文案', () => {
    expect(httpStatusOf(19999)).toBe(500);
    expect(messageOf(19999)).toBe('服务开小差了，请稍后重试');
  });

  it('典型业务错误码映射正确', () => {
    expect(httpStatusOf(ErrorCode.UNAUTHORIZED)).toBe(401);
    expect(httpStatusOf(ErrorCode.PERMISSION_DENIED)).toBe(403);
    expect(httpStatusOf(ErrorCode.TEST_SESSION_NOT_FOUND)).toBe(404);
    expect(httpStatusOf(ErrorCode.ORDER_ALREADY_PAID)).toBe(409);
    expect(httpStatusOf(ErrorCode.RATE_LIMITED)).toBe(429);
    expect(httpStatusOf(ErrorCode.AI_PROVIDER_UNAVAILABLE)).toBe(503);
    expect(httpStatusOf(ErrorCode.AI_PROVIDER_TIMEOUT)).toBe(504);
    expect(httpStatusOf(ErrorCode.INTERNAL_ERROR)).toBe(500);
  });
});
