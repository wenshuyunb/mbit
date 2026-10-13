/**
 * 支付服务（契约 §3.7；架构 §13.3）
 *
 * 负责"通知 → 订单已付 → 权益落库"这一条链路，其中**幂等**是核心：
 * 微信会对同一笔支付多次投递通知（网络重试、我们响应超时），
 * 而重复发货意味着用户付一次钱拿到多份权益。
 *
 * 幂等有两道闸门，缺一不可：
 *   ① **订单状态判断**（`decideFulfillment`）—— 挡住"已经处理过"的绝大多数情况
 *   ② **`entitlements.idempotencyKey` 唯一约束** —— 挡住并发投递：两条回调同时
 *      读到订单还是 `CREATED`，应用层判断都会说"该发货"，唯一约束只会放行一条
 *
 * 只有第 ① 道时，并发下会双双发货；只有第 ② 道时，订单状态与权益可能不一致。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
// ⚠ `WechatPayService` 必须用**普通 import**，只有请求头类型可用 `import type`：
// Nest 的构造参数注入依赖 `design:paramtypes` 元数据里的**运行时类引用**，
// `import type` 会被编译期擦除，元数据退化成 `Function`，启动时报
// "Nest can't resolve dependencies of the PaymentService (PrismaService, ?)"。
// 这个错误只有真正启动进程才会暴露 —— 单测全是手写 new，完全测不到。
import { WechatPayService } from '../../infra/wechat/wechat-pay.service';
import type { WechatPayCallbackHeaders } from '../../infra/wechat/wechat-pay.service';

import {
  buildProductSnapshot,
  generateOrderIdempotencyKey,
  generateOrderNo,
  isValidPayAmount,
  normalizeClientIp,
  orderExpiresAt,
} from './order.util';
import {
  decideFulfillment,
  entitlementIdempotencyKey,
  parseWechatPayNotification,
  type ParsedPaymentNotification,
} from './payment-notification.util';

/** 回调处理结果 */
export interface PaymentCallbackResult {
  /** 是否应当给微信回 200（**已处理过的重复通知也要回 200**，否则微信会一直重投） */
  readonly acknowledged: boolean;
  readonly code: PaymentCallbackCode;
  /** 面向日志；不进入 HTTP 响应体 */
  readonly detail: string;
}

/** 处理结果码 */
export type PaymentCallbackCode =
  'FULFILLED' | 'ALREADY_FULFILLED' | 'REJECTED' | 'INVALID_CALLBACK' | 'INTERNAL_ERROR';

/** 下单结果（契约 §3.7.1） */
export interface OrderCreatedView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly amount: number;
  readonly currency: string;
  readonly expiresAt: string;
  /** 小程序 `wx.requestPayment` 所需参数；预支付失败时为 `null` */
  readonly payment: {
    readonly timeStamp: string;
    readonly nonceStr: string;
    readonly package: string;
    readonly signType: 'RSA';
    readonly paySign: string;
  } | null;
  /** 未返回支付参数时的原因（便于前端提示与排查） */
  readonly paymentUnavailableReason?: string;
}

/** 下单入参 */
export interface CreateOrderInput {
  readonly userId: string;
  readonly productId: string;
  /** 相关资源（购买单份报告 / 匹配报告时提供） */
  readonly reportId?: string;
  readonly relationshipId?: string;
  readonly clientIp?: string;
}

/** 查单补偿 / 补发货的结果 */
export interface PaidOrderFulfillment {
  /** 本次是否真的推进了订单状态（`false` = 此前已处理，幂等命中） */
  readonly fulfilled: boolean;
  /** 本次**新发放**的权益 ID（幂等命中时为空数组） */
  readonly grantedEntitlementIds: string[];
}

/** 订单 → 权益的映射规则（`productType` 决定发什么） */
interface EntitlementGrant {
  readonly type: 'REPORT_UNLOCK' | 'MEMBERSHIP_ACTIVE' | 'AI_CREDITS';
  /** 资源键后缀（同一订单可能发多份权益，用后缀区分幂等键） */
  readonly suffix: string;
  /** 会员时长（天）；仅 `MEMBERSHIP_ACTIVE` 需要 */
  readonly membershipDays?: number;
}

/**
 * 商品类型 → 权益规格
 *
 * `REPORT_COMPATIBILITY` 与 `REPORT_PERSONAL` 都发 `REPORT_UNLOCK`：
 * 权益表的 `type` 只有"报告解锁"这一档，具体解锁哪份报告由 `reportId` /
 * `relationshipId` 决定（见 `entitlement.util.ts` 的资源键约定）。
 */
const GRANT_BY_PRODUCT_TYPE: Readonly<Record<string, EntitlementGrant>> = {
  REPORT_PERSONAL: { type: 'REPORT_UNLOCK', suffix: 'report' },
  REPORT_COMPATIBILITY: { type: 'REPORT_UNLOCK', suffix: 'report' },
  MEMBERSHIP: { type: 'MEMBERSHIP_ACTIVE', suffix: 'membership', membershipDays: 30 },
};

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wechatPay: WechatPayService,
  ) {}

  /**
   * 创建订单并获取预支付参数（契约 §3.7.1）
   *
   * **金额一律从商品表读取，绝不接受客户端传值**：前端常把"元"当"分"传，
   * 而这类错误在小额测试订单上完全看不出来，上线后就是少收 100 倍。
   *
   * 预支付失败时**订单仍然创建成功**（`payment` 为 `null`）：订单落库是事实，
   * 微信侧抖动不该让用户"什么都没发生"。前端可稍后重试拉起支付。
   */
  async createOrder(input: CreateOrderInput): Promise<OrderCreatedView> {
    const now = new Date();

    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, deletedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        priceAmount: true,
        type: true,
        durationDays: true,
        status: true,
      },
    });

    if (product === null) {
      throw BusinessException.notFound(ErrorCode.PRODUCT_NOT_FOUND);
    }

    // 下架商品不允许下单：价格可能正在调整，此时购买会引发争议
    if (product.status !== 'ON_SALE') {
      throw new BusinessException(ErrorCode.PRODUCT_OFF_SHELF, '商品已下架');
    }

    if (!isValidPayAmount(product.priceAmount)) {
      // 商品价格非法属**配置事故**，不是用户错误
      this.logger.error(`商品价格非法 productId=${product.id} price=${product.priceAmount}`);

      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '商品配置异常，请联系客服');
    }

    const orderNo = await this.createUniqueOrderNo(now);

    /**
     * 订单与支付单**必须在同一事务内创建**
     *
     * 支付单（`status = INIT`）是这条资金链路的锚点：`refunds.payment_id` 是**非空外键**，
     * 没有支付单行就根本建不出退款记录；对账任务也需要靠它把微信侧的 `out_trade_no`
     * 与本地订单对上。此前下单只拿到 `prepayId` 就结束，**没有任何代码写入 `payments`**，
     * 于是退款只能靠 `ensurePayment` 事后补建（见 `syncPaymentRow` 的注释）。
     *
     * 放在同一事务里而不是"订单建完再补一行"：后者在中间失败时会留下
     * **一个没有支付单的订单**，而它恰恰是退款建不出来的那种订单 ——
     * 这正是本改动要消灭的状态。
     */
    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNo,
          userId: input.userId,
          productId: product.id,
          productType: product.type,
          productSnapshot: buildProductSnapshot(
            {
              productId: product.id,
              code: product.code,
              name: product.name,
              priceAmount: product.priceAmount,
              productType: product.type,
              durationDays: product.durationDays,
            },
            now,
          ) as never,
          totalAmount: product.priceAmount,
          currency: 'CNY',
          status: 'CREATED',
          expiredAt: orderExpiresAt(now),
          clientIp: normalizeClientIp(input.clientIp),
          idempotencyKey: generateOrderIdempotencyKey(),
          ...(input.reportId !== undefined ? { relatedReportId: input.reportId } : {}),
          ...(input.relationshipId !== undefined ? { relatedRelationshipId: input.relationshipId } : {}),
        },
        select: { id: true, orderNo: true, totalAmount: true, currency: true, expiredAt: true },
      });

      await tx.payment.create({
        data: {
          orderId: created.id,
          userId: input.userId,
          // 微信侧的 `out_trade_no` 就是它，天然唯一 —— 对账与退款都按它关联
          outTradeNo: created.orderNo,
          channel: 'WECHAT_JSAPI',
          status: 'INIT',
          amount: created.totalAmount,
          currency: created.currency,
        },
        select: { id: true },
      });

      return created;
    });

    this.logger.log(`订单已创建 orderNo=${order.orderNo} amount=${order.totalAmount} userId=${input.userId}`);

    const payment = await this.tryPrepay(order.orderNo, order.totalAmount);

    // 预支付单号回填：出问题时运维能拿它直接去微信侧查这笔单，而不是只能凭 out_trade_no 猜
    await this.attachPrepayId(order.orderNo, payment.prepayId);

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      amount: order.totalAmount,
      currency: order.currency,
      expiresAt: order.expiredAt.toISOString(),
      payment: payment.params,
      ...(payment.reason !== undefined ? { paymentUnavailableReason: payment.reason } : {}),
    };
  }

  /**
   * 生成不冲突的订单号
   *
   * `order_no` 有唯一约束，同一天内 10 位随机数极小概率碰撞 ——
   * **重试**而不是抛错（与邀请码同一策略）：碰撞是正常概率事件，
   * 抛错会让用户看到"下单失败"，而系统完全有能力自己解决。
   */
  private async createUniqueOrderNo(now: Date): Promise<string> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const orderNo = generateOrderNo(now);
      const existing = await this.prisma.order.findUnique({ where: { orderNo }, select: { id: true } });

      if (existing === null) return orderNo;

      this.logger.warn(`订单号碰撞，重试生成 attempt=${attempt}`);
    }

    this.logger.error('订单号连续碰撞 5 次，随机源可能异常');
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, '订单创建失败，请稍后重试');
  }

  /**
   * 尝试获取预支付单
   *
   * 失败**不抛错**：订单已经落库，微信侧抖动不该让用户"什么都没发生"。
   * 同时把 `prepayId` 一并返回：它要回填到支付单上，供运维直接去微信侧查这笔单。
   */
  private async tryPrepay(
    orderNo: string,
    amount: number,
  ): Promise<{ params: OrderCreatedView['payment']; reason?: string; prepayId?: string }> {
    try {
      const prepay = await this.wechatPay.createJsapiPrepay({ orderNo, amount, description: 'SoulMap AI' });

      // 签名需要商户私钥，而私钥只存在于 WechatPayService 内部 ——
      // 因此由它构造支付参数，本服务只负责编排
      return { params: this.wechatPay.buildMiniAppPayParams(prepay.prepayId), prepayId: prepay.prepayId };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.warn(`预支付失败（订单已创建，可稍后重试拉起支付）orderNo=${orderNo}: ${message}`);

      return { params: null, reason: '预支付暂时不可用，请稍后重试' };
    }
  }

  /**
   * 把预支付单号回填到支付单
   *
   * 失败**只记日志**：订单与支付单都已落库，回填一个诊断字段不该让下单失败。
   * 没有 `prepayId` 时（预支付失败）直接跳过 —— 支付单保持 `INIT`，
   * 与"用户尚未拉起支付"的事实一致。
   */
  private async attachPrepayId(orderNo: string, prepayId: string | undefined): Promise<void> {
    if (prepayId === undefined) return;

    try {
      await this.prisma.payment.update({
        where: { outTradeNo: orderNo },
        data: { prepayId },
        select: { id: true },
      });
    } catch (error) {
      this.logger.warn(
        `回填 prepayId 失败 orderNo=${orderNo}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 处理微信支付回调
   *
   * 返回值里的 `acknowledged` 表示"是否给微信回成功"。**重复通知必须回成功**，
   * 否则微信会按自己的退避策略持续重投，直到超过最大次数后停止 ——
   * 那之后若我们的处理真的失败了，就再没有补偿机会。
   */
  async handleWechatCallback(rawBody: string, headers: WechatPayCallbackHeaders): Promise<PaymentCallbackResult> {
    const outcome = this.wechatPay.handleCallback(rawBody, headers);

    if (!outcome.ok) {
      // 验签/解密失败**不回 200**：这可能是攻击，也可能是我们的证书过期。
      // 回成功会让真正的问题被掩盖，且微信不会再重投（证书修复后那笔通知就丢了）
      this.logger.warn(`支付回调校验失败 reason=${outcome.reason}`);

      return { acknowledged: false, code: 'INVALID_CALLBACK', detail: outcome.reason };
    }

    const mchId = this.wechatPay.mchId;
    if (mchId === null) {
      return { acknowledged: false, code: 'INVALID_CALLBACK', detail: 'NOT_CONFIGURED' };
    }

    const parsed = parseWechatPayNotification(outcome.resource, mchId);
    if (!parsed.ok) {
      // 解析失败里也有"非 SUCCESS 状态"这种**正常**情况（例如用户取消支付），
      // 这类必须回成功，否则微信会为一个永远不会成功的通知反复重投
      this.logger.log(`支付通知未进入发货流程 reason=${parsed.reason}`);

      return { acknowledged: true, code: 'REJECTED', detail: parsed.reason };
    }

    try {
      return await this.fulfill(parsed.value);
    } catch (error) {
      // 处理过程中出错**不回成功**：让微信重投，这是唯一的自动补偿机会
      this.logger.error(`支付回调处理异常 orderNo=${parsed.value.orderNo}: ${(error as Error).message}`);

      return { acknowledged: false, code: 'INTERNAL_ERROR', detail: '内部错误' };
    }
  }

  /** 发货（幂等） */
  private async fulfill(notification: ParsedPaymentNotification): Promise<PaymentCallbackResult> {
    const order = await this.prisma.order.findFirst({
      where: { orderNo: notification.orderNo, deletedAt: null },
      select: {
        id: true,
        orderNo: true,
        userId: true,
        productType: true,
        totalAmount: true,
        paidAmount: true,
        currency: true,
        status: true,
        relatedReportId: true,
        relatedRelationshipId: true,
      },
    });

    const decision = decideFulfillment(order, notification);

    if (decision.action === 'REJECT') {
      this.logger.warn(`支付回调被拒绝 orderNo=${notification.orderNo} reason=${decision.reason}`);

      // 拒绝也要回成功：这些是**确定性**的拒绝（订单不存在、金额不符），
      // 重投一万次结果也一样，只会浪费资源。真正需要人工介入。
      return { acknowledged: true, code: 'REJECTED', detail: decision.reason };
    }

    if (decision.action === 'ALREADY_FULFILLED') {
      this.logger.log(`支付回调重复投递，幂等命中 orderNo=${notification.orderNo}`);

      return { acknowledged: true, code: 'ALREADY_FULFILLED', detail: '已处理' };
    }

    // 到这里 order 必然非空（`decideFulfillment` 已排除 null）
    const target = order as NonNullable<typeof order>;

    await this.prisma.$transaction(async (tx) => {
      // ① 条件更新：只在状态仍为未支付时推进。
      // 用 `updateMany` + 状态条件而不是 `update`：并发下两条回调同时到达时，
      // 只有一条能改到行（`count === 1`），另一条会看到 `count === 0`
      const updated = await tx.order.updateMany({
        where: { id: target.id, status: { in: ['CREATED', 'PENDING_PAY'] } },
        data: {
          status: 'FULFILLED',
          paidAmount: decision.paidAmount,
          paidAt: new Date(),
          fulfilledAt: new Date(),
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        // 被另一条并发回调抢先处理了：不重复发权益，直接返回
        this.logger.log(`订单已被并发回调处理 orderNo=${notification.orderNo}`);

        return;
      }

      for (const grant of this.grantsFor(target.productType)) {
        await this.grantEntitlement(tx, {
          userId: target.userId,
          orderId: target.id,
          orderNo: target.orderNo,
          reportId: target.relatedReportId,
          relationshipId: target.relatedRelationshipId,
          grant,
        });
      }
    });

    this.logger.log(`支付已完成并发货 orderNo=${notification.orderNo} amount=${decision.paidAmount}`);

    return { acknowledged: true, code: 'FULFILLED', detail: '已发货' };
  }

  /**
   * 把「微信已支付但本地未更新」的订单推进到 `FULFILLED`（幂等）
   *
   * 契约 §3.9.5 的补偿链路与 §3.9.8 的回调链路**必须走同一套本地状态机**：
   * 两条路径各写一份「改订单状态 + 发权益」的代码，迟早会在某次改动后不一致
   * （例如一边补了 `fulfilledAt`、另一边没有），而这类不一致只在补偿路径触发时
   * 才暴露 —— 也就是在事故当天才发现。
   *
   * 因此回调路径（`fulfill`）与本方法共用 `grantEntitlement`，本方法只负责
   * 「按订单 ID 重放一次发货」，不做商户号/解密之类的回调专属校验。
   *
   * ⚠ 调用方**必须**在调用前确认「微信侧确实 `SUCCESS` 且金额与本地订单一致」，
   * 本方法不做任何金额校验（金额一律以本地 `orders` 为准，绝不采信外部传入金额）。
   *
   * @returns `fulfilled` 表示本次是否真的推进了状态；`entitlementIds` 是**本次新发放**的权益
   */
  async fulfillPaidOrder(params: {
    orderId: string;
    transactionId: string | null;
    /** 实付金额（分），由调用方从**本地订单**读取 */
    paidAmount: number;
    paidAt: Date;
  }): Promise<PaidOrderFulfillment> {
    const order = await this.prisma.order.findFirst({
      where: { id: params.orderId, deletedAt: null },
      select: {
        id: true,
        orderNo: true,
        userId: true,
        productType: true,
        status: true,
        relatedReportId: true,
        relatedRelationshipId: true,
      },
    });

    if (order === null) return { fulfilled: false, grantedEntitlementIds: [] };

    const grantedEntitlementIds: string[] = [];
    let fulfilled = false;

    await this.prisma.$transaction(async (tx) => {
      // 条件更新是**唯一**的并发闸门：两条补偿同时到达时只会有一条改到行
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: { in: ['CREATED', 'PENDING_PAY'] } },
        data: {
          status: 'FULFILLED',
          paidAmount: params.paidAmount,
          paidAt: params.paidAt,
          fulfilledAt: new Date(),
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        this.logger.log(`订单已处于支付后状态，补偿跳过 orderNo=${order.orderNo} status=${order.status}`);

        return;
      }

      fulfilled = true;

      for (const grant of this.grantsFor(order.productType)) {
        const id = await this.grantEntitlement(tx, {
          userId: order.userId,
          orderId: order.id,
          orderNo: order.orderNo,
          reportId: order.relatedReportId,
          relationshipId: order.relatedRelationshipId,
          grant,
        });

        if (id !== null) grantedEntitlementIds.push(id);
      }
    });

    // 支付单同步放在**事务之外**：它是对账与退款的辅助记录，写失败不该让
    // 「付了必给货」回滚（订单与权益已经落库）。退款链路另有"找不到支付单就补建"
    // 的兜底，因此这里的失败不会造成无法退款的死角。
    if (fulfilled) {
      await this.syncPaymentRow(this.prisma, {
        orderId: order.id,
        userId: order.userId,
        orderNo: order.orderNo,
        transactionId: params.transactionId,
        amount: params.paidAmount,
        paidAt: params.paidAt,
      });
    }

    return { fulfilled, grantedEntitlementIds };
  }

  /**
   * 同步支付单行（回调与补偿共用）
   *
   * ## 正常情况下这里是**更新**，不是补建
   *
   * 下单时已在同一事务里创建了 `status = INIT` 的支付单（见 `createOrder`），
   * 因此回调走到这里时行已经存在，本方法把它推进到 `SUCCESS` 并记下
   * `transactionId` / `successTime` / `notifyReceivedAt`。
   *
   * ## 那"补建"分支为什么还留着
   *
   * 它服务于**历史数据与异常路径**：在 INIT 行落地之前创建的订单没有支付单，
   * 而回调仍可能到来（微信会重投）；另外 `outTradeNo` 唯一约束之外没有别的锚点，
   * 补建行（`outTradeNo = orderNo`，微信侧的 `out_trade_no` 就是它）能让这些订单
   * 也能退款。**不要**因为它看起来多余而删掉：删掉等于让改动前创建的订单永久无法退款。
   */
  private async syncPaymentRow(
    client: Pick<PrismaService, 'payment'>,
    params: {
      orderId: string;
      userId: string;
      orderNo: string;
      transactionId: string | null;
      amount: number;
      paidAt: Date;
    },
  ): Promise<void> {
    try {
      const existing = await client.payment.findUnique({
        where: { outTradeNo: params.orderNo },
        select: { id: true, transactionId: true },
      });

      // `transaction_id` 有唯一约束：先确认这个微信单号没被别的本地支付单占用，
      // 否则写入会抛 P2002 并让本次同步整体失败（交易号留空只是少了一条对账线索，
      // 由同步失败告警与对账任务兜住）
      const canSetTransactionId =
        params.transactionId !== null &&
        (existing === null || existing.transactionId === null || existing.transactionId === params.transactionId);

      if (params.transactionId !== null && !canSetTransactionId) {
        const owner = await client.payment.findUnique({
          where: { transactionId: params.transactionId },
          select: { outTradeNo: true },
        });

        this.logger.error(
          `支付单交易号冲突，已跳过写入（需人工核对）outTradeNo=${params.orderNo} 占用方=${owner?.outTradeNo ?? '未知'}`,
        );
      }

      if (existing === null) {
        await client.payment.create({
          data: {
            orderId: params.orderId,
            userId: params.userId,
            outTradeNo: params.orderNo,
            ...(canSetTransactionId ? { transactionId: params.transactionId } : {}),
            channel: 'WECHAT_JSAPI',
            status: 'SUCCESS',
            amount: params.amount,
            payerAmount: params.amount,
            currency: 'CNY',
            successTime: params.paidAt,
            notifyReceivedAt: new Date(),
          },
        });

        return;
      }

      await client.payment.update({
        where: { id: existing.id },
        data: {
          ...(canSetTransactionId ? { transactionId: params.transactionId } : {}),
          status: 'SUCCESS',
          amount: params.amount,
          successTime: params.paidAt,
          notifyReceivedAt: new Date(),
          version: { increment: 1 },
        },
      });
    } catch (error) {
      // 支付单只是对账与退款的**辅助**记录，写失败不应让"付了必给货"失败；
      // 但必须留痕：没有支付单行会导致后续退款被拒
      this.logger.error(
        `同步支付单失败 orderNo=${params.orderNo}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 发放一份权益
   *
   * `idempotencyKey` 有唯一约束，因此这里**捕获唯一冲突并视为成功** ——
   * 冲突意味着"这份权益已经发过了"，正是幂等要的结果。
   * 让它抛错会把一次正常的重复投递变成"处理失败"，进而触发微信重投。
   *
   * @returns 新发放的权益 ID；幂等命中（已存在）时返回 `null`
   */
  private async grantEntitlement(
    tx: Pick<PrismaService, 'entitlement'>,
    params: {
      userId: string;
      orderId: string;
      orderNo: string;
      reportId: string | null;
      relationshipId: string | null;
      grant: EntitlementGrant;
    },
  ): Promise<string | null> {
    const { grant } = params;

    // 会员到期时间：从**现在**起算而不是从下单时间 —— 用户等了一天才付款的话，
    // 按下单时间算会白扣一天
    const expireAt =
      grant.membershipDays === undefined ? null : new Date(Date.now() + grant.membershipDays * 86_400_000);

    try {
      const created = await tx.entitlement.create({
        data: {
          userId: params.userId,
          type: grant.type,
          status: 'ACTIVE',
          resourceKey: this.resourceKeyFor(params, grant),
          orderId: params.orderId,
          reportId: params.reportId,
          relationshipId: params.relationshipId,
          expireAt,
          totalQuota: null,
          idempotencyKey: entitlementIdempotencyKey(params.orderNo, grant.suffix),
        },
        select: { id: true },
      });

      return created.id;
    } catch (error) {
      // 唯一冲突 = 已经发过了，这正是幂等要的结果
      if (isUniqueConstraintError(error)) {
        this.logger.log(`权益已存在，跳过重复发放 orderNo=${params.orderNo} suffix=${grant.suffix}`);

        return null;
      }
      throw error;
    }
  }

  /**
   * 资源键
   *
   * ⚠ **只能产出 `entitlement.util.ts` 认识的形态**（`report:{reportId}`）。
   * 曾经写过 `relationship:{id}`，但解析侧只认 `report:` 前缀 ——
   * 那样的权益会安静地存在库里、却永远解锁不了任何东西。
   * 关系维度的解锁需要先在 `entitlement.util.ts` 里定义约定，不能在这里随手造一个。
   */
  private resourceKeyFor(
    params: { reportId: string | null; relationshipId: string | null },
    grant: EntitlementGrant,
  ): string | null {
    if (grant.type !== 'REPORT_UNLOCK') return null;
    if (params.reportId !== null) return `report:${params.reportId}`;

    // 关系匹配报告的购买：`related_report_id` 在解读生成前是空的。
    // 此时先落一条**无资源键**的权益（钱已收，不能不发），
    // 并告警让人工/补单脚本补上 `reportId` —— 比造一个解析不了的前缀好
    this.logger.warn(
      `报告解锁权益缺少 reportId，暂时无法关联到具体报告 relationshipId=${params.relationshipId ?? 'null'}（需补单）`,
    );

    return null;
  }

  /** 商品类型 → 权益规格；未知类型返回空数组（订单仍标记已付，但不发权益并告警） */
  private grantsFor(productType: string): readonly EntitlementGrant[] {
    const grant = GRANT_BY_PRODUCT_TYPE[productType];

    if (grant === undefined) {
      // 【关键】不回退成"发一份默认权益"：发错权益比不发更糟 ——
      // 用户会以为自己买到了会员。这里保持"订单已付、权益待补"的状态，
      // 由后台或补单脚本处理
      this.logger.error(`未知商品类型，未发放权益 productType=${productType}（需人工补单）`);

      return [];
    }

    return [grant];
  }
}

/** 判断 Prisma 唯一约束冲突（不依赖具体错误码文本） */
const isUniqueConstraintError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;

  return (error as { code?: unknown }).code === 'P2002';
};
