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
import type { WechatPayCallbackHeaders, WechatPayService } from '../../infra/wechat/wechat-pay.service';

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

    const order = await this.prisma.order.create({
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

    this.logger.log(`订单已创建 orderNo=${order.orderNo} amount=${order.totalAmount} userId=${input.userId}`);

    const payment = await this.tryPrepay(order.orderNo, order.totalAmount);

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
   */
  private async tryPrepay(
    orderNo: string,
    amount: number,
  ): Promise<{ params: OrderCreatedView['payment']; reason?: string }> {
    try {
      const prepay = await this.wechatPay.createJsapiPrepay({ orderNo, amount, description: 'SoulMap AI' });

      // 签名需要商户私钥，而私钥只存在于 WechatPayService 内部 ——
      // 因此由它构造支付参数，本服务只负责编排
      return { params: this.wechatPay.buildMiniAppPayParams(prepay.prepayId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.warn(`预支付失败（订单已创建，可稍后重试拉起支付）orderNo=${orderNo}: ${message}`);

      return { params: null, reason: '预支付暂时不可用，请稍后重试' };
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
   * 发放一份权益
   *
   * `idempotencyKey` 有唯一约束，因此这里**捕获唯一冲突并视为成功** ——
   * 冲突意味着"这份权益已经发过了"，正是幂等要的结果。
   * 让它抛错会把一次正常的重复投递变成"处理失败"，进而触发微信重投。
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
  ): Promise<void> {
    const { grant } = params;

    // 会员到期时间：从**现在**起算而不是从下单时间 —— 用户等了一天才付款的话，
    // 按下单时间算会白扣一天
    const expireAt =
      grant.membershipDays === undefined ? null : new Date(Date.now() + grant.membershipDays * 86_400_000);

    try {
      await tx.entitlement.create({
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
      });
    } catch (error) {
      // 唯一冲突 = 已经发过了，这正是幂等要的结果
      if (isUniqueConstraintError(error)) {
        this.logger.log(`权益已存在，跳过重复发放 orderNo=${params.orderNo} suffix=${grant.suffix}`);

        return;
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
