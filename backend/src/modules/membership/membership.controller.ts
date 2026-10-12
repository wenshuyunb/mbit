/**
 * 会员与商品控制器（契约 §2.4 / §3.7）
 *
 * 目前只提供**读**接口：会员状态与可售商品列表。这两者是前端会员页的最小依赖 ——
 * 没有它们，会员页只能显示写死的价格与「未开通」，而服务端的定价与权益
 * 一旦调整，界面就会说谎。
 *
 * 下单走 `POST /payment/orders`（见 `PaymentController`），
 * 权益**发放**只能由支付回调或后台触发，没有任何客户端入口 —— 这是刻意的：
 * 任何「前端调用即发权益」的接口都等于免费送。
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../common/decorators';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ListEntitlementsQueryDto } from './dto/entitlement.dto';
import { EntitlementService, type EntitlementListView, type MembershipView } from './entitlement.service';

/** 商品视图（只暴露前端需要的字段） */
export interface ProductView {
  readonly productId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  /** 现价（分） */
  readonly priceAmount: number;
  /** 划线原价（分）；无优惠时为 `null` */
  readonly originalAmount: number | null;
  readonly currency: string;
  /** 会员/权益时长（天）；一次性商品为 `null` */
  readonly durationDays: number | null;
  /** AI 次数（`AI_CREDITS` 类商品） */
  readonly credits: number | null;
  readonly tags: readonly string[];
  readonly isRecommended: boolean;
}

/** 商品列表视图 */
export interface ProductListView {
  readonly items: readonly ProductView[];
  /**
   * 当前用户的会员状态
   *
   * 与商品列表**一起返回**而不是让前端再发一次请求：会员页必然同时需要
   * 这两份数据，拆成两个接口只会让首屏出现「价格已渲染但会员状态还在转圈」
   * 的中间态。
   */
  readonly membership: MembershipView;
}

@ApiTags('会员')
@ApiBearerAuth('user-token')
@Controller('membership')
export class MembershipController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  @Get()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '我的会员状态',
    description: [
      '返回是否会员、到期时间与剩余天数。',
      '',
      '**会员判定看的是 `entitlements` 表的时间窗权益**，不是用户表上的某个布尔字段 ——',
      '后者需要在退款、续费、后台调整时同步维护，迟早不一致。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（非会员时 `expireAt` 与 `remainingDays` 为 `null`）' })
  async getMembership(@CurrentUser('userId') userId: string): Promise<MembershipView> {
    return this.entitlements.getMembership(userId);
  }

  @Get('entitlements')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '权益清单（分页）',
    description: [
      '分页返回**当前用户**的全部权益记录（含已过期/已消耗），用于「我的权益」页与客服排查。',
      '',
      '**强归属过滤** `WHERE userId = 当前用户`：本接口没有任何按 ID 读取他人权益的入口。',
      '',
      '**脱敏**：响应不含内部发放备注、操作人 ID、`idempotencyKey` 等字段 ——',
      '它们**不进入数据库查询**，而不是"查出来再删"（后者迟早会被某次 select 改动带出去）。',
      '人工发放的权益只在 `sourceType` 上体现为 `ADMIN`，`sourceId` 刻意留空。',
      '',
      '**`status` 是派生值**（状态列 + 到期时间 + 剩余次数）：`entitlements.status` 由',
      '到期任务维护，可能延迟刷新，因此服务端综合判定后下发；`isUsable` 同理，',
      '复用与报告付费墙**完全相同**的判定函数，避免「权益页说可用、点进去被挡住」。',
      '',
      '**不传 `status` 时返回全部状态**（契约用途栏要求含已过期/已消耗）。',
      '排序上 `status` 为第一排序键，保证可用权益置顶（契约规则 5）。',
      '',
      '本接口**只读**：权益只能由支付回调或后台人工补发产生，没有任何客户端写入入口。',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: '查询成功（`items` + `total` + `page` + `pageSize` + `hasNext` + `summary` + `membership`）',
  })
  @ApiResponse({
    status: 400,
    description: '`type` / `status` 含非法枚举值、`sortBy` 不在白名单或 `pageSize > 100`（均返回 `10001`）',
  })
  @ApiResponse({ status: 401, description: '未登录或登录态失效（`20000`/`20001`）' })
  @ApiResponse({ status: 429, description: '超出限流（120 次/60s）' })
  async listEntitlements(
    @CurrentUser('userId') userId: string,
    @Query() query: ListEntitlementsQueryDto,
  ): Promise<EntitlementListView> {
    return this.entitlements.listEntitlements(userId, {
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.resourceId !== undefined ? { resourceId: query.resourceId } : {}),
      ...(query.sortBy !== undefined ? { sortBy: query.sortBy } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
    });
  }

  @Get('products')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '可售商品列表',
    description: [
      '只返回 `ON_SALE` 且在有效期内的商品，按 `sortOrder` 升序（运营可置顶推荐位）。',
      '',
      '**价格一律以服务端为准**：前端只用它展示，下单时金额由服务端从商品表重读，',
      '客户端传什么价都不影响实际收款。',
      '',
      '响应里同时带上当前用户的会员状态，避免会员页出现两次请求的中间态。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  async listProducts(@CurrentUser('userId') userId: string): Promise<ProductListView> {
    const now = new Date();

    const [products, membership] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          status: 'ON_SALE',
          deletedAt: null,
          // 有效期窗口：`validFrom`/`validTo` 两端都判，只判一端会让
          // 「还没开始卖」或「已经停售」的商品出现在列表里
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ validTo: null }, { validTo: { gt: now } }] },
          ],
        },
        orderBy: [{ isRecommended: 'desc' }, { sortOrder: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          type: true,
          priceAmount: true,
          originalAmount: true,
          currency: true,
          durationDays: true,
          credits: true,
          tags: true,
          isRecommended: true,
        },
      }),
      this.entitlements.getMembership(userId),
    ]);

    return {
      items: products.map((product) => ({
        productId: product.id,
        code: product.code,
        name: product.name,
        description: product.description,
        type: product.type,
        priceAmount: product.priceAmount,
        originalAmount: product.originalAmount,
        currency: product.currency,
        durationDays: product.durationDays,
        credits: product.credits,
        tags: product.tags,
        isRecommended: product.isRecommended,
      })),
      membership,
    };
  }
}
