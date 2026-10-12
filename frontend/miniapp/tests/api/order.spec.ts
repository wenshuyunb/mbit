/**
 * 订单与支付接口层测试
 *
 * 原实现有两处会让下单链路**完全不可用**的错误：
 *   ① 路径写的是 `POST /orders`，后端实际是 `POST /payment/orders`
 *   ② 请求体传 `productCode`，后端 DTO 只认 `productId`（`@IsUUID`），
 *      且因全局管道 `forbidNonWhitelisted` 会直接 400。
 *
 * 另有一个崩溃风险：后端 `OrderCreatedView.payment` **可以为 `null`**（预支付失败），
 * 原实现把它声明为非空，页面直接取 `payment.package` 会抛 TypeError。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOrder } from '@/api/order';

interface CapturedRequest {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: unknown;
}

let captured: CapturedRequest[] = [];

const respondWith = (data: unknown): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    captured.push({
      url: String(options['url']),
      method: String(options['method'] ?? 'GET'),
      header: (options['header'] ?? {}) as Record<string, string>,
      data: options['data'],
    });
    setTimeout(() => {
      (options['success'] as (res: unknown) => void)({
        statusCode: 200,
        data: { code: 0, message: 'ok', data, requestId: 'req_test', timestamp: '' },
      });
    }, 0);
  }) as unknown as typeof uni.request);
};

const PRODUCT_ID = '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d';

const REAL_ORDER = {
  orderId: '0195f3a2-9f1c-7d20-8d13-1f2a3b4c5d6e',
  orderNo: 'SM202610120001',
  amount: 12800,
  currency: 'CNY',
  expiresAt: '2026-10-12T03:24:46.728Z',
  payment: {
    timeStamp: '1760000000',
    nonceStr: 'abc123def456',
    package: 'prepay_id=wx1234567890',
    signType: 'RSA',
    paySign: 'signature',
  },
};

beforeEach(() => {
  captured = [];
  vi.mocked(uni.request).mockReset();
});

describe('createOrder：路径与字段（下单链路回归）', () => {
  it('命中 POST /payment/orders（不是顶层 /orders）', async () => {
    respondWith(REAL_ORDER);

    await createOrder({ productId: PRODUCT_ID });

    expect(captured[0]?.url).toContain('/payment/orders');
    expect(captured[0]?.method).toBe('POST');
  });

  it('请求体用 productId（原实现传 productCode，会被 400 拒绝）', async () => {
    respondWith(REAL_ORDER);

    await createOrder({ productId: PRODUCT_ID });

    expect(captured[0]?.data).toMatchObject({ productId: PRODUCT_ID });
    expect(captured[0]?.data).not.toHaveProperty('productCode');
  });

  it('必须携带幂等键，避免重复下单', async () => {
    respondWith(REAL_ORDER);

    await createOrder({ productId: PRODUCT_ID });

    expect(captured[0]?.header['X-Idempotency-Key']).toBeTruthy();
  });

  it('不需要 reportId / relationshipId 时不发送这两个字段', async () => {
    respondWith(REAL_ORDER);

    await createOrder({ productId: PRODUCT_ID });

    // 后端两个字段都是 @IsOptional，但多余的空值没有意义，且便于日志比对
    expect(captured[0]?.data).not.toHaveProperty('reportId');
    expect(captured[0]?.data).not.toHaveProperty('relationshipId');
  });

  it('购买单份报告时透传 reportId', async () => {
    respondWith(REAL_ORDER);

    await createOrder({ productId: PRODUCT_ID, reportId: 'report-1' });

    expect(captured[0]?.data).toMatchObject({ productId: PRODUCT_ID, reportId: 'report-1' });
  });

  it('购买匹配报告时透传 relationshipId', async () => {
    respondWith(REAL_ORDER);

    await createOrder({ productId: PRODUCT_ID, relationshipId: 'rel-1' });

    expect(captured[0]?.data).toMatchObject({ productId: PRODUCT_ID, relationshipId: 'rel-1' });
  });
});

describe('createOrder：响应结构', () => {
  it('返回顶层金额与订单号（后端没有嵌套的 order 对象）', async () => {
    respondWith(REAL_ORDER);

    const order = await createOrder({ productId: PRODUCT_ID });

    expect(order.orderId).toBe(REAL_ORDER.orderId);
    expect(order.orderNo).toBe('SM202610120001');
    expect(order.amount).toBe(12800);
    expect(order.currency).toBe('CNY');
    expect(order.expiresAt).toBe(REAL_ORDER.expiresAt);
    expect(order).not.toHaveProperty('order');
  });

  it('支付参数结构符合 uni.requestPayment 要求', async () => {
    respondWith(REAL_ORDER);

    const order = await createOrder({ productId: PRODUCT_ID });

    expect(order.payment).toMatchObject({
      timeStamp: '1760000000',
      nonceStr: 'abc123def456',
      package: 'prepay_id=wx1234567890',
      signType: 'RSA',
      paySign: 'signature',
    });
  });

  it('预支付失败时 payment 为 null —— 调用方必须判空（原实现声明为非空会崩）', async () => {
    respondWith({
      ...REAL_ORDER,
      payment: null,
      paymentUnavailableReason: '微信支付服务暂时不可用，请稍后重试',
    });

    const order = await createOrder({ productId: PRODUCT_ID });

    expect(order.payment).toBeNull();
    expect(order.paymentUnavailableReason).toBe('微信支付服务暂时不可用，请稍后重试');
  });
});
