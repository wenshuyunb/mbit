/**
 * 会员与商品接口层测试
 *
 * 原文件的三个路径（`/membership/plans`、`/membership/me`、`/membership/entitlements`）
 * 后端**全都不存在**，且 `MembershipStatus` 的字段名（`isActive`/`expiresAt`）与
 * 后端（`isMember`/`expireAt`）全错 —— 会员页首屏必然全空。
 * 这里用后端真实响应样本（本机实测 `GET /membership`、`GET /membership/products`）
 * 锁死路径与字段。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getMyMembership, listProducts, type MembershipStatus } from '@/api/membership';

interface CapturedRequest {
  url: string;
  method: string;
}

let captured: CapturedRequest[] = [];

const respondWith = (data: unknown): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    captured.push({ url: String(options['url']), method: String(options['method'] ?? 'GET') });
    setTimeout(() => {
      (options['success'] as (res: unknown) => void)({
        statusCode: 200,
        data: { code: 0, message: 'ok', data, requestId: 'req_test', timestamp: '' },
      });
    }, 0);
  }) as unknown as typeof uni.request);
};

/** 本机实测 `GET /membership` 的真实返回 */
const REAL_MEMBERSHIP: MembershipStatus = { isMember: false, expireAt: null, remainingDays: null };

beforeEach(() => {
  captured = [];
  vi.mocked(uni.request).mockReset();
});

describe('getMyMembership', () => {
  it('命中 GET /membership（不是 /membership/me）', async () => {
    respondWith(REAL_MEMBERSHIP);

    await getMyMembership();

    expect(captured[0]?.url).toContain('/membership');
    expect(captured[0]?.url).not.toContain('/membership/me');
    expect(captured[0]?.method).toBe('GET');
  });

  it('字段名与后端一致：isMember / expireAt / remainingDays', async () => {
    respondWith({ isMember: true, expireAt: '2027-01-01T00:00:00.000Z', remainingDays: 81 });

    const status = await getMyMembership();

    expect(status.isMember).toBe(true);
    expect(status.expireAt).toBe('2027-01-01T00:00:00.000Z');
    expect(status.remainingDays).toBe(81);
    // 旧字段名不得再出现，否则页面读到的永远是 undefined
    expect(status).not.toHaveProperty('isActive');
    expect(status).not.toHaveProperty('expiresAt');
  });

  it('remainingDays 为 0（已到期）与 null（未开通）是两种不同含义', async () => {
    respondWith({ isMember: true, expireAt: '2026-01-01T00:00:00.000Z', remainingDays: 0 });
    const expired = await getMyMembership();
    expect(expired.remainingDays).toBe(0);

    respondWith({ isMember: false, expireAt: null, remainingDays: null });
    const never = await getMyMembership();
    expect(never.remainingDays).toBeNull();
  });
});

describe('listProducts', () => {
  it('命中 GET /membership/products（不是顶层 /products）', async () => {
    respondWith({ items: [], membership: REAL_MEMBERSHIP });

    await listProducts();

    expect(captured[0]?.url).toContain('/membership/products');
  });

  it('响应是对象：商品在 items，会员状态与它一起返回', async () => {
    respondWith({
      items: [
        {
          productId: '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d',
          code: 'MEMBER_YEAR',
          name: '年度会员',
          description: '一年内解锁全部权益',
          type: 'MEMBERSHIP',
          priceAmount: 12800,
          originalAmount: 19800,
          currency: 'CNY',
          durationDays: 365,
          credits: null,
          tags: ['不限次对话', 'PDF 导出'],
          isRecommended: true,
        },
      ],
      membership: REAL_MEMBERSHIP,
    });

    const data = await listProducts();

    // 原实现把响应声明为数组，实际是对象
    expect(Array.isArray(data)).toBe(false);
    expect(data.items).toHaveLength(1);
    expect(data.membership).toEqual(REAL_MEMBERSHIP);
  });

  it('商品必须带 productId（下单要用它，后端按 UUID 校验），且标签字段叫 tags', async () => {
    respondWith({
      items: [
        {
          productId: '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d',
          code: 'MEMBER_YEAR',
          name: '年度会员',
          description: null,
          type: 'MEMBERSHIP',
          priceAmount: 12800,
          originalAmount: null,
          currency: 'CNY',
          durationDays: 365,
          credits: null,
          tags: [],
          isRecommended: false,
        },
      ],
      membership: REAL_MEMBERSHIP,
    });

    const product = (await listProducts()).items[0];

    expect(product?.productId).toBe('0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d');
    expect(product?.tags).toEqual([]);
    // 旧字段名后端不存在
    expect(product).not.toHaveProperty('benefits');
    expect(product).not.toHaveProperty('recommended');
    // description 允许为 null
    expect(product?.description).toBeNull();
  });

  it('AI 次数商品用 credits 表达次数，一次性商品 durationDays 为 null', async () => {
    respondWith({
      items: [
        {
          productId: 'p1',
          code: 'AI_100',
          name: 'AI 次数包',
          description: null,
          type: 'AI_CREDITS',
          priceAmount: 1900,
          originalAmount: null,
          currency: 'CNY',
          durationDays: null,
          credits: 100,
          tags: [],
          isRecommended: false,
        },
      ],
      membership: REAL_MEMBERSHIP,
    });

    const product = (await listProducts()).items[0];

    expect(product?.credits).toBe(100);
    expect(product?.durationDays).toBeNull();
  });
});
