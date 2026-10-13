/**
 * 退款服务「出款 ↔ 审计」测试（契约 §3.14.6.3）
 *
 * ## 为什么单独盯这两个动作的顺序与异常路径
 *
 * `adminRefund` 是本仓库**唯一会真实出款**的入口。它此前是「先出款、后写审计」，
 * 中间没有任何异常保护 —— 于是**每一次出款异常都会连带丢掉审计记录**。生产实测
 * 正是这一条：支付渠道未配置（`70018`）时订单的 `refunded_amount` 已被预留，
 * 而 `admin_audit_logs` 里查该订单命中 0 条。事后要回答「是谁在什么时候发起了这笔
 * 退款」就完全失去依据 —— 偏偏「出款结果未知」才是最需要审计的场景（微信侧可能
 * 已经出款，本地却什么都没记下）。
 *
 * 修好之后本文件守住三件事，缺一条都会让这条链路重新变成"钱动了但查不到人"：
 *   ① 出款失败也必须落一条 `success=false` 且带 `errorCode` 的审计；
 *   ② 审计自己写失败**不能顶替**原始异常（排障要看到的是出款为什么失败）；
 *   ③ 成功路径仍是 `success=true` / `errorCode=null`（修一条不能打坏另一条）。
 *
 * ## mock 的取舍
 *
 * 三个依赖全部替身化，照 `report.service.spec.ts` 与
 * `order-lifecycle.processor.spec.ts` 的既有写法：`createHarness()` 建一次，
 * 各用例按需改行为。唯一"多写"的地方是 `refunds` 行的替身会被写操作**真的改掉**，
 * 原因见 `createHarness` 内的注释 —— 那不是为了好看，而是成功路径必须读到结算后
 * 的行，否则断言测的是替身的懒，而不是实现的行为。
 */

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { WechatPayService } from '../../infra/wechat/wechat-pay.service';
import { RefundService, type AdminRefundView } from './refund.service';

const ADMIN_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const ORDER_ID = '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89';
const USER_ID = '0195f3a2-3b21-7b31-9a6d-2f5c8e1b4d70';
const REFUND_ID = 'refund-1';
const ORDER_NO = 'SM20260214120000ABCD';
const REFUND_NO = 'RF20260214ABCDEFGH';
const PAID_AMOUNT = 9900;
const WECHAT_REFUND_ID = '4200001234202602140000000001';
const AUDIT_ID = 'audit-1';

/**
 * 下单时间取**真实当前时间往前 1 分钟**
 *
 * 非 `force` 的退款要求订单在 7 天窗口内。写死一个日历时间会让这条测试在某天之后
 * 突然被 `70012` 拦在出款之前 —— 那时失败原因就不再是本文件要盯的那条路径了，
 * 测试会"绿得毫无意义"。
 */
const PAID_AT = new Date(Date.now() - 60_000);

/**
 * 订单行（`refundedAmount` 由调用方给：预留前后的读到的值不同）
 *
 * 显式标注 `Record<string, unknown>`：替身只喂给 `mockResolvedValue`，
 * 不需要真实行类型；而 `@typescript-eslint/explicit-function-return-type`
 * 要求导出/顶层函数写明返回类型。
 */
const orderRow = (refundedAmount: number): Record<string, unknown> => ({
  id: ORDER_ID,
  orderNo: ORDER_NO,
  userId: USER_ID,
  status: 'PAID',
  paidAmount: PAID_AMOUNT,
  refundedAmount,
  currency: 'CNY',
  payChannel: 'WECHAT_JSAPI',
  paidAt: PAID_AT,
  createdAt: PAID_AT,
});

/** 退款行初值（`create` 的 `data` 会覆盖上去，模拟真实插入结果） */
const refundBase = (): Record<string, unknown> => ({
  id: REFUND_ID,
  refundNo: REFUND_NO,
  outRefundNo: REFUND_NO,
  orderId: ORDER_ID,
  paymentId: 'payment-1',
  userId: USER_ID,
  refundAmount: PAID_AMOUNT,
  totalAmount: PAID_AMOUNT,
  currency: 'CNY',
  reason: '客服核实后同意全额退款',
  status: 'PENDING',
  channel: 'WECHAT_JSAPI',
  operatorAdminId: ADMIN_ID,
  refundId: null as string | null,
  errorCode: null as string | null,
  errorMessage: null as string | null,
  successTime: null as Date | null,
  notifyPayload: null,
  createdAt: PAID_AT,
});

interface Harness {
  service: RefundService;
  prisma: {
    order: { findFirst: jest.Mock; findUnique: jest.Mock };
    refund: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    payment: { findFirst: jest.Mock; create: jest.Mock };
    entitlement: { findMany: jest.Mock };
    adminAuditLog: { create: jest.Mock };
    outboxEvent: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  tx: {
    order: { updateMany: jest.Mock; findUnique: jest.Mock };
    refund: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    payment: { updateMany: jest.Mock };
    entitlement: { findMany: jest.Mock };
    membership: { updateMany: jest.Mock };
  };
  wechatPay: { isApiConfigured: boolean; createRefund: jest.Mock };
  redis: { incrWithTtl: jest.Mock };
}

const createHarness = (options: { apiConfigured: boolean }): Harness => {
  /**
   * `refunds` 行的替身：写操作**必须真的改掉这一行**
   *
   * `settleRefundSuccess` 在事务里把 `PENDING → SUCCESS`，紧接着 `adminRefund` 会
   * `reloadRefund` 再读一次来决定审计的 `success` 与返回值。如果替身每次只回固定
   * 行，成功路径就会读到 `PENDING`，"出款成功却被记成失败" —— 那是替身不像数据库，
   * 不是实现有问题。所以这里做一个最小的行内存，按真实语义增删改。
   */
  let current = refundBase();

  const refundTable = {
    findUnique: jest.fn((args: { where: Record<string, unknown> }) => {
      // 幂等键未命中、微信退款单号无人占用 → 请求继续往下走（命中幂等就绕开退款流程了）
      if ('idempotencyKey' in args.where) return Promise.resolve(null);
      if ('refundId' in args.where) return Promise.resolve(null);

      return Promise.resolve({ ...current });
    }),
    // 该订单没有处理中的用户申请 → 走"管理员新开一笔"的分支
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      current = { ...current, ...args.data };

      return Promise.resolve({ ...current });
    }),
    updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
      // 条件更新（`where.status = 'PENDING'`）在这里恒成功：并发结算的场景由
      // `reconcilePendingRefunds` 那侧覆盖，本文件只关心单请求内的顺序
      current = { ...current, ...args.data };

      return Promise.resolve({ count: 1 });
    }),
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      current = { ...current, ...args.data };

      return Promise.resolve({ ...current });
    }),
  };

  const tx = {
    order: {
      // 预留跑的是带条件的 `UPDATE`；count=1 表示"抢到了额度"（count=0 是并发冲突分支）
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // 结算时重新读订单，此时额度**已经**被预留加上 —— 这是它与 `prisma.order.findFirst`
      // 唯一有意义的差别（读成 0 会把可退金额算成双倍，订单状态也会判错）
      findUnique: jest.fn().mockResolvedValue(orderRow(PAID_AMOUNT)),
    },
    // 事务内外操作的是同一张表，共用同一份替身：否则会出现"事务里改了、事务外读不到"
    refund: refundTable,
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    // 无权益可回收：本文件不测权益链路，空数组让 `revokeOrderEntitlements` 提前返回
    entitlement: { findMany: jest.fn().mockResolvedValue([]) },
    membership: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  const prisma = {
    order: {
      // `findFirst` 是**预留之前**的读：该订单一分钱都还没退
      findFirst: jest.fn().mockResolvedValue(orderRow(0)),
      // `reloadOrder` 是预留之后的读
      findUnique: jest.fn().mockResolvedValue(orderRow(PAID_AMOUNT)),
    },
    refund: refundTable,
    payment: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'payment-1',
        orderId: ORDER_ID,
        channel: 'WECHAT_JSAPI',
        status: 'SUCCESS',
      }),
      // 本文件里支付单总是已存在（`refunds.payment_id` 是必填外键），补建分支不触发
      create: jest.fn(),
    },
    entitlement: { findMany: jest.fn().mockResolvedValue([]) },
    adminAuditLog: {
      create: jest.fn((_args: { data: Record<string, unknown> }) => Promise.resolve({ id: AUDIT_ID })),
    },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };

  const wechatPay = {
    // 契约 §3.9.10：通道未配置 → `70018`，且 `executeWechatRefund` 在**最开头**就抛。
    // 这条路径正好精确复现"出款调用抛异常"，而不牵扯微信的网络细节
    isApiConfigured: options.apiConfigured,
    createRefund: jest.fn().mockResolvedValue({
      wechatRefundId: WECHAT_REFUND_ID,
      outRefundNo: REFUND_NO,
      status: 'SUCCESS',
      successTime: PAID_AT.toISOString(),
      refundAmount: PAID_AMOUNT,
      totalAmount: PAID_AMOUNT,
      payerRefund: PAID_AMOUNT,
      userReceivedAccount: 'oUpF8uMuAJO_M2pxb1Q9zNjWeS6o',
      raw: {},
    }),
  };

  const redis = { incrWithTtl: jest.fn().mockResolvedValue(1) };

  const service = new RefundService(
    prisma as unknown as PrismaService,
    wechatPay as unknown as WechatPayService,
    redis as unknown as RedisService,
  );

  return { service, prisma, tx, wechatPay, redis };
};

/**
 * 发起一次管理端全额退款
 *
 * 入参刻意取"能一路走到出款"的那一组：`force=false` + 7 天窗口内的订单 + 未消费的
 * 权益。任何一项不满足，请求都会先被策略拦下（`70012`），根本到不了本文件要盯的
 * 那段代码，测试就会变成"断言了一条没被执行的路径"。
 */
const adminRefundOnce = (harness: Harness): Promise<AdminRefundView> =>
  harness.service.adminRefund({
    adminUserId: ADMIN_ID,
    adminUsername: 'ops_zhang',
    adminDisplayName: '张运营',
    orderId: ORDER_ID,
    dto: { reason: '客服核实后同意全额退款' },
    idempotencyKey: 'idem-key-1',
    force: false,
    ctx: { ip: '203.0.113.7', userAgent: 'jest', requestId: 'req-1' },
  });

/** 取本次请求写入的审计入参（本文件关心的是"审计记了什么"） */
const auditData = (harness: Harness): Record<string, unknown> => {
  const call = harness.prisma.adminAuditLog.create.mock.calls[0];

  if (call === undefined) throw new Error('没有写入任何审计记录');

  // `mock.calls` 的元素是 `any`：显式收窄成 Record，否则触发 no-unsafe-return
  return call[0].data as Record<string, unknown>;
};

describe('RefundService.adminRefund —— 出款失败也必须留下审计', () => {
  it('【核心】渠道未配置（70018）时写一条 success=false 的审计，再把原错误码原样抛出', async () => {
    const harness = createHarness({ apiConfigured: false });

    // 契约里 70018 就是「支付通道未配置」；审计落库的 error_code 必须是这个对外号码
    expect(ErrorCode.PAYMENT_FEATURE_DISABLED).toBe(70018);

    await expect(adminRefundOnce(harness)).rejects.toMatchObject({ code: ErrorCode.PAYMENT_FEATURE_DISABLED });

    expect(harness.prisma.adminAuditLog.create).toHaveBeenCalledTimes(1);
    expect(auditData(harness)).toMatchObject({
      action: 'REFUND',
      // 挂在订单上：生产事故的表征正是"按该订单查 admin_audit_logs 命中 0 条"
      resourceId: ORDER_ID,
      success: false,
      errorCode: String(ErrorCode.PAYMENT_FEATURE_DISABLED),
    });
  });

  it('【关键】审计写失败不能顶替原始异常', async () => {
    const harness = createHarness({ apiConfigured: false });
    harness.prisma.adminAuditLog.create.mockRejectedValue(new Error('db down'));

    const error = await adminRefundOnce(harness).then(
      () => null,
      (caught: unknown) => caught,
    );

    // 抛出来的必须仍是"出款为什么失败"：审计挂了是次生故障，拿它顶替原始异常会让
    // 排障方向完全跑偏（去查审计表，而真正的问题在出款）
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).code).toBe(ErrorCode.PAYMENT_FEATURE_DISABLED);
    expect((error as BusinessException).message).toBe('支付通道未配置，暂时无法退款，请联系客服');

    // 审计确实尝试过（`writeAdminAudit` 内部吞掉并打 error 日志），不是被跳过
    expect(harness.prisma.adminAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('成功路径回归：出款成功时审计为 success=true / errorCode=null', async () => {
    const harness = createHarness({ apiConfigured: true });

    const view = await adminRefundOnce(harness);

    expect(view.status).toBe('SUCCESS');
    expect(harness.prisma.adminAuditLog.create).toHaveBeenCalledTimes(1);
    expect(auditData(harness)).toMatchObject({ action: 'REFUND', success: true, errorCode: null });
  });

  it('【关键】渠道未配置时退款单保持 PENDING、预留额度不释放，故审计必须强标失败', async () => {
    const harness = createHarness({ apiConfigured: false });

    await expect(adminRefundOnce(harness)).rejects.toMatchObject({ code: ErrorCode.PAYMENT_FEATURE_DISABLED });

    // 退款单**不**置 FAILED：配置补上之后这笔申请仍可被执行（见 `executeWechatRefund` 顶部注释）
    expect(harness.tx.refund.updateMany).not.toHaveBeenCalled();
    // 订单上只有"预留"那一次写，没有 decrement —— 额度没有被释放
    expect(harness.tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.tx.order.updateMany.mock.calls[0][0].data).toMatchObject({
      refundedAmount: { increment: PAID_AMOUNT },
    });

    // 审计如实记下 `refundStatus: PENDING`，但 `success` 仍为 false ——
    // 这正是按状态推断会把"结果未知"记成成功，所以失败审计必须显式强标
    expect(auditData(harness)).toMatchObject({ success: false, afterData: { refundStatus: 'PENDING' } });
  });
});
