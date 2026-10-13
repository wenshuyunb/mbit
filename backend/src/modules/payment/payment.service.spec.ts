/**
 * 下单时创建 `INIT` 支付单（资金链路的锚点）
 *
 * ## 守的是什么
 *
 * `refunds.payment_id` 是**非空外键**，没有支付单行就建不出退款记录。
 * 此前下单只拿到 `prepayId` 就结束，`payments` 表**一行都不写**，
 * 于是「用户付了钱要退款」只能靠 `syncPaymentRow` / `ensurePayment` 事后补建 ——
 * 那意味着**回调丢失的订单在退款时会被卡住**（补建依赖回调真的来过）。
 *
 * 正确做法是下单即建 `status = INIT` 的支付单、回调时推进到 `SUCCESS`。
 *
 * ## 为什么断言"同一事务"
 *
 * 订单与支付单分两次写（不在同一事务）时，中间失败会留下**一个没有支付单的订单** ——
 * 而它恰恰就是退款建不出来的那种订单。所以这里不仅断言"两行都写了"，
 * 还断言它们经过**同一个 `$transaction` 回调**、且订单先建（支付单要引用它的 id）。
 */

import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { WechatPayService } from '../../infra/wechat/wechat-pay.service';
import { ORDER_IDEMPOTENCY_TTL_SECONDS } from './order.util';
import { PaymentService } from './payment.service';

const PRODUCT = {
  id: 'product-1',
  code: 'MEMBERSHIP_MONTHLY',
  name: '月度会员',
  priceAmount: 3900,
  type: 'MEMBERSHIP',
  durationDays: 30,
  status: 'ON_SALE',
};

interface Harness {
  service: PaymentService;
  prisma: {
    product: { findFirst: jest.Mock };
    order: { findUnique: jest.Mock };
    payment: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  tx: { order: { create: jest.Mock }; payment: { create: jest.Mock } };
  wechatPay: { createJsapiPrepay: jest.Mock; buildMiniAppPayParams: jest.Mock };
  redis: { key: jest.Mock; getJson: jest.Mock; setJson: jest.Mock };
}

const createHarness = (options: { prepayFails?: boolean } = {}): Harness => {
  const tx = {
    order: {
      create: jest.fn().mockResolvedValue({
        id: 'order-1',
        orderNo: 'SM20261013000000ABCD',
        totalAmount: 3900,
        currency: 'CNY',
        expiredAt: new Date('2026-10-13T12:00:00.000Z'),
      }),
    },
    payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
  };

  const prisma = {
    product: { findFirst: jest.fn().mockResolvedValue(PRODUCT) },
    // 订单号碰撞探测：默认不碰撞
    order: { findUnique: jest.fn().mockResolvedValue(null) },
    payment: { update: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>): Promise<unknown> => callback(tx)),
  };

  const wechatPay = {
    createJsapiPrepay: options.prepayFails
      ? jest.fn().mockRejectedValue(new Error('支付通道未配置'))
      : jest.fn().mockResolvedValue({ prepayId: 'wx-prepay-1' }),
    buildMiniAppPayParams: jest
      .fn()
      .mockReturnValue({ timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x', signType: 'RSA', paySign: 's' }),
  };

  const redis = {
    key: jest.fn((...parts: (string | number)[]): string => parts.join(':')),
    // 默认未命中：绝大多数用例关心的是「首次下单」路径
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new PaymentService(
      prisma as unknown as PrismaService,
      wechatPay as unknown as WechatPayService,
      redis as unknown as RedisService,
    ),
    prisma,
    tx,
    wechatPay,
    redis,
  };
};

const createOrder = (harness: Harness): ReturnType<PaymentService['createOrder']> =>
  harness.service.createOrder({ userId: 'user-1', productId: 'product-1', idempotencyKey: 'idem-key-12345678' });

describe('PaymentService.createOrder —— INIT 支付单', () => {
  it('【关键】下单时创建 status=INIT 的支付单（此前 payments 表一行都不写）', async () => {
    const harness = createHarness();

    await createOrder(harness);

    expect(harness.tx.payment.create).toHaveBeenCalledTimes(1);

    const data = harness.tx.payment.create.mock.calls[0][0].data as Record<string, unknown>;

    expect(data.status).toBe('INIT');
    expect(data.orderId).toBe('order-1');
    expect(data.userId).toBe('user-1');
    // 微信侧的 out_trade_no 就是订单号，对账与退款都按它关联
    expect(data.outTradeNo).toBe('SM20261013000000ABCD');
    expect(data.amount).toBe(3900);
    expect(data.channel).toBe('WECHAT_JSAPI');
    expect(data.currency).toBe('CNY');
  });

  it('【关键】订单与支付单在同一事务内，且订单先建（支付单引用它的 id）', async () => {
    const harness = createHarness();

    await createOrder(harness);

    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);

    const orderCallOrder = harness.tx.order.create.mock.invocationCallOrder[0];
    const paymentCallOrder = harness.tx.payment.create.mock.invocationCallOrder[0];
    expect(orderCallOrder).toBeLessThan(paymentCallOrder);
  });

  it('预支付成功后把 prepayId 回填到支付单（运维可拿它直接查微信侧）', async () => {
    const harness = createHarness();

    await createOrder(harness);

    expect(harness.prisma.payment.update).toHaveBeenCalledWith({
      where: { outTradeNo: 'SM20261013000000ABCD' },
      data: { prepayId: 'wx-prepay-1' },
      select: { id: true },
    });
  });

  it('预支付失败时仍不抛错、订单保留，且支付单保持 INIT（与"用户尚未拉起支付"一致）', async () => {
    const harness = createHarness({ prepayFails: true });

    const view = await createOrder(harness);

    // 订单照常返回，只是没有支付参数 —— 微信侧抖动不该让用户"什么都没发生"
    expect(view.orderNo).toBe('SM20261013000000ABCD');
    expect(view.payment).toBeNull();
    // 预支付失败 → 没有 prepayId 可回填，但仍要有支付单（退款锚点）
    expect(harness.prisma.payment.update).not.toHaveBeenCalled();
    expect(harness.tx.payment.create).toHaveBeenCalledTimes(1);
  });

  it('回填 prepayId 失败只记日志，不让下单失败（诊断字段不该拖垮主流程）', async () => {
    const harness = createHarness();
    harness.prisma.payment.update.mockRejectedValue(new Error('db down'));

    await expect(createOrder(harness)).resolves.toMatchObject({ orderNo: 'SM20261013000000ABCD' });
  });
});

/**
 * 下单幂等（契约 §2.9.2）
 *
 * ## 守的是什么
 *
 * 契约把 `POST /payment/orders` 列为必须携带 `X-Idempotency-Key` 的接口，
 * 小程序也确实在发这个头（`frontend/miniapp/src/api/order.ts`）——
 * 但服务端此前**根本不读它**，于是文档承诺的 `10009` 永远不会出现，
 * 而「网络超时后重试」会实打实地建出第二张订单、占两次库存与配额。
 *
 * ## 为什么重放要在业务校验之前
 *
 * 重放若走完整流程，商品在这期间下架就会让第二次请求拿到 `70001`，
 * 而用户本该看到第一次的成功响应。顺序错了，幂等就只在「什么都没变」时成立。
 */
describe('PaymentService.createOrder —— 下单幂等', () => {
  const REPLAY_VIEW = {
    orderId: 'order-9',
    orderNo: 'SM20261013000000ZZZZ',
    amount: 3900,
    currency: 'CNY',
    expiresAt: '2026-10-13T12:30:00.000Z',
    payment: { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=z', signType: 'RSA', paySign: 's' },
  };

  it('首次下单后把整份响应写入幂等键，TTL 与订单有效期一致', async () => {
    const harness = createHarness();

    const view = await createOrder(harness);

    expect(harness.redis.setJson).toHaveBeenCalledTimes(1);

    const [key, cached, ttl] = harness.redis.setJson.mock.calls[0] as [string, unknown, number];

    // 键里必须带 userId：两个用户偶然用了同一个幂等键不能互相顶掉重放结果
    expect(key).toContain('user-1');
    expect(cached).toEqual(view);
    // 30 分钟 = 订单有效期：订单过期后重放应当建新单，否则用户永远付不了款
    expect(ttl).toBe(ORDER_IDEMPOTENCY_TTL_SECONDS);
    expect(ttl).toBe(30 * 60);
  });

  it('【关键】同一幂等键重放：原样返回首次响应，且不再建单、不再请求微信', async () => {
    const harness = createHarness();
    harness.redis.getJson.mockResolvedValue(REPLAY_VIEW);

    const view = await createOrder(harness);

    expect(view).toEqual(REPLAY_VIEW);
    // 这两条才是"不产生第二张订单"的实证：没有事务、没有预支付调用
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    expect(harness.wechatPay.createJsapiPrepay).not.toHaveBeenCalled();
    // 重放不应覆盖首次的缓存值（否则 TTL 被反复续期，死单会一直活着）
    expect(harness.redis.setJson).not.toHaveBeenCalled();
  });

  it('【关键】重放短路在任何业务校验之前 —— 商品已下架也照样返回首次成功响应', async () => {
    const harness = createHarness();
    harness.redis.getJson.mockResolvedValue(REPLAY_VIEW);
    harness.prisma.product.findFirst.mockResolvedValue({ ...PRODUCT, status: 'OFF_SHELF' });

    await expect(createOrder(harness)).resolves.toEqual(REPLAY_VIEW);
    // 商品表根本不该被查
    expect(harness.prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it('Redis 故障时降级为新建订单（资金链路不能因为缓存不可用而下不了单）', async () => {
    const harness = createHarness();
    harness.redis.getJson.mockRejectedValue(new Error('redis down'));

    await expect(createOrder(harness)).resolves.toMatchObject({ orderNo: 'SM20261013000000ABCD' });
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('写入幂等键失败只记日志，不让下单失败（订单已落库，缓存写失败是次要故障）', async () => {
    const harness = createHarness();
    harness.redis.setJson.mockRejectedValue(new Error('redis down'));

    await expect(createOrder(harness)).resolves.toMatchObject({ orderNo: 'SM20261013000000ABCD' });
  });

  it('不同用户用同一个幂等键 → 落到不同的 Redis 键（不会互相顶掉）', async () => {
    const harness = createHarness();

    await harness.service.createOrder({ userId: 'user-1', productId: 'product-1', idempotencyKey: 'same-key-1234' });
    await harness.service.createOrder({ userId: 'user-2', productId: 'product-1', idempotencyKey: 'same-key-1234' });

    const firstKey = (harness.redis.key.mock.calls[0] as string[]).join(':');
    const secondKey = (harness.redis.key.mock.calls[1] as string[]).join(':');

    expect(firstKey).not.toBe(secondKey);
    // 客户端键原样出现在键里会让可控字符串进入 Redis 键空间 —— 必须是摘要
    expect(JSON.stringify(harness.redis.key.mock.calls)).not.toContain('same-key-1234');
  });
});
