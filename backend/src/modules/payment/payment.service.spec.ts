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
import type { WechatPayService } from '../../infra/wechat/wechat-pay.service';
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

  return {
    service: new PaymentService(prisma as unknown as PrismaService, wechatPay as unknown as WechatPayService),
    prisma,
    tx,
    wechatPay,
  };
};

const createOrder = (harness: Harness): ReturnType<PaymentService['createOrder']> =>
  harness.service.createOrder({ userId: 'user-1', productId: 'product-1' });

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
