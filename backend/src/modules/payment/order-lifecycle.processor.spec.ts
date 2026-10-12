/**
 * 订单生命周期处理器测试
 *
 * 断言的重点是**路由与参数**，而不是业务逻辑：
 *   · job name 必须过滤（同一队列上可能有别的处理器，不过滤会把别人的任务"正常 return"吞掉）
 *   · 批大小必须传给 Service（写死默认值会让运维改不动扫描量）
 */

import type { Job } from 'bullmq';

import { OrderLifecycleProcessor } from './order-lifecycle.processor';
import { ORDER_TIMEOUT_CLOSE_JOB, REFUND_RECONCILE_JOB } from './payment-jobs.constants';
import type { OrderQueryService } from './order-query.service';
import type { RefundService } from './refund.service';

interface Mocks {
  orders: { closeExpiredOrders: jest.Mock };
  refunds: { reconcilePendingRefunds: jest.Mock };
}

const build = (): { processor: OrderLifecycleProcessor; mocks: Mocks } => {
  const mocks: Mocks = {
    orders: {
      closeExpiredOrders: jest.fn().mockResolvedValue({ scanned: 0, closed: 0, wechatClosed: 0, wechatFailed: 0 }),
    },
    refunds: {
      reconcilePendingRefunds: jest.fn().mockResolvedValue({ scanned: 0, settled: 0, failed: 0, stillPending: 0 }),
    },
  };

  const processor = new OrderLifecycleProcessor(
    mocks.orders as unknown as OrderQueryService,
    mocks.refunds as unknown as RefundService,
  );

  return { processor, mocks };
};

const job = (name: string): Job => ({ name }) as Job;

describe('OrderLifecycleProcessor', () => {
  it('超时关单任务调用 `closeExpiredOrders` 并传入批大小', async () => {
    const { processor, mocks } = build();

    await processor.process(job(ORDER_TIMEOUT_CLOSE_JOB));

    expect(mocks.orders.closeExpiredOrders).toHaveBeenCalledWith(200);
    expect(mocks.refunds.reconcilePendingRefunds).not.toHaveBeenCalled();
  });

  it('退款对账任务调用 `reconcilePendingRefunds` 并传入批大小', async () => {
    const { processor, mocks } = build();

    await processor.process(job(REFUND_RECONCILE_JOB));

    expect(mocks.refunds.reconcilePendingRefunds).toHaveBeenCalledWith(100);
    expect(mocks.orders.closeExpiredOrders).not.toHaveBeenCalled();
  });

  it('【关键】未知 job name 直接跳过（不抛错、不误伤同一队列上的其他处理器）', async () => {
    const { processor, mocks } = build();

    await expect(processor.process(job('generate'))).resolves.toBeUndefined();

    expect(mocks.orders.closeExpiredOrders).not.toHaveBeenCalled();
    expect(mocks.refunds.reconcilePendingRefunds).not.toHaveBeenCalled();
  });

  it('【关键】Service 抛错时向上传递（让 BullMQ 记录失败，而不是安静地吞掉）', async () => {
    const { processor, mocks } = build();
    mocks.orders.closeExpiredOrders.mockRejectedValue(new Error('db down'));

    await expect(processor.process(job(ORDER_TIMEOUT_CLOSE_JOB))).rejects.toThrow('db down');
  });
});
