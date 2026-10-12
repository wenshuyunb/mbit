/**
 * 管理端订单查询服务（契约 §3.14.6.1 列表 / §3.14.6.2 详情）
 *
 * ## 为什么读接口也要写审计
 *
 * 契约 §3.14.6.1 规则 3：「查询记录 `admin_audit_logs`（含查询条件），金融类数据访问
 * 必须可追溯」；§3.14.6.2 的响应里甚至直接带 `auditTrail`（示例即是本次访问）。
 * 但 `AdminAuditAction` 是**闭集枚举且没有 `READ`/`QUERY` 成员**
 * （只有 LOGIN/CREATE/UPDATE/DELETE/EXPORT/…），而 `schema.prisma` 本轮不可改。
 * 用 `UPDATE` 冒充读访问会污染审计语义（审计表的价值在于可信），
 * 因此这里的选择是：**只读接口不写审计**，导出（有真实外部副作用的写操作）
 * 照常落审计。该缺口已列入交付简报名单，需一次「枚举新增 READ」的决策。
 *
 * ## 性能约定
 *
 * 列表页固定 **6 条 SQL**（主查询 + count + 2 个 groupBy 摘要 + 1 个权益 groupBy
 * + 1 个交易号批量查询），与页大小无关 —— 不存在逐行查用户/商品/权益/支付的 N+1。
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Order, OrderStatus, Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { AppConfig } from '../../../config/config.type';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  ADMIN_ORDER_DEFAULT_PAGE_SIZE,
  type AdminOrderProductType,
  type AdminOrderSortField,
  type AdminOrderSortOrder,
  type AdminOrderStatus,
  type ListAdminOrdersQueryDto,
} from './dto/admin-order.dto';
import {
  ABNORMAL_FLAG_LABELS,
  buildOrderCoreView,
  buildOrderEntitlementView,
  buildOrderListSummary,
  buildOrderPaymentView,
  buildOrderRefundView,
  buildOrderTimeline,
  computeRefundableAmount,
  deriveAbnormalFlags,
  deriveAdminActions,
  latestPayment,
  latestRefundSuccessAt,
  maskPhoneOf,
  orderStatusLabel,
  type AdminActionsView,
  type AdminOrderCoreView,
  type AdminOrderEntitlementView,
  type AdminOrderPaymentView,
  type AdminOrderRefundView,
  type OrderListSummary,
  type OrderTimelineEvent,
} from './admin-order.util';

/** 列表主查询的 include（用 `satisfies` 固定形状，便于从它推导行类型） */
const ORDER_LIST_INCLUDE = {
  user: { select: { id: true, nickname: true } },
  product: { select: { code: true, name: true } },
  _count: { select: { refunds: true } },
} as const satisfies Prisma.OrderInclude;

type OrderListRow = Prisma.OrderGetPayload<{ include: typeof ORDER_LIST_INCLUDE }>;

/**
 * 筛选条件（列表与导出共用）
 *
 * 抽成独立接口而不是复用列表 DTO：导出只允许契约声明的子集（无分页、无排序、
 * 无 keyword），若直接把列表 DTO 传给导出服务，「多传了一个字段」不会有任何提示，
 * 却会让导出结果与调用方以为的条件不一致。
 */
export interface OrderFilterInput {
  status?: AdminOrderStatus[];
  productType?: AdminOrderProductType;
  productCode?: string;
  userId?: string;
  keyword?: string;
  minAmount?: number;
  maxAmount?: number;
  hasRefund?: boolean;
  paidStartTime?: string;
  paidEndTime?: string;
  createdStartTime?: string;
  createdEndTime?: string;
}

/** 导出单次最多导出行数（防止一次导出把应用内存打满） */
export const ORDER_EXPORT_MAX_ROWS = 50_000;

/** 导出分页游标大小（每批行数） */
const EXPORT_BATCH_SIZE = 1_000;

/** 导出取数结果 */
export interface OrderExportCollection {
  readonly items: AdminOrderListItem[];
  readonly rowCount: number;
  readonly totalAmount: number;
  readonly totalRefundedAmount: number;
  /** 是否因超过 `maxRows` 被截断（必须显式告知，静默截断会让人以为拿到了全量） */
  readonly truncated: boolean;
}

/** 列表条目（契约 §3.14.6.1 的 `items[]`） */
export interface AdminOrderListItem {
  orderId: string;
  orderNo: string;
  status: string;
  statusLabel: string;
  userId: string;
  userNickname: string | null;
  productCode: string | null;
  productName: string | null;
  productType: string;
  amount: number;
  payAmount: number;
  refundedAmount: number;
  refundableAmount: number;
  currency: string;
  payMethod: string | null;
  transactionId: string | null;
  targetResourceId: string | null;
  entitlementTypes: string[];
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  refundCount: number;
  hasAbnormalFlag: boolean;
  abnormalFlags: string[];
}

/** 列表响应（契约 §3.14.6.1） */
export interface AdminOrderListView {
  items: AdminOrderListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: OrderListSummary;
}

/** 订单详情里的 `user` 块（契约 §3.14.6.2） */
export interface AdminOrderUserView {
  userId: string;
  nickname: string | null;
  phoneMasked: string | null;
  status: string;
  registeredAt: string;
  orderCount: number;
  totalPaidAmount: number;
  refundCount: number;
}

/** 详情里的审计轨迹项 */
export interface AdminOrderAuditEntry {
  at: string;
  action: string;
  operatorName: string;
  detail: string | null;
}

/** 详情响应（契约 §3.14.6.2） */
export interface AdminOrderDetailView {
  order: AdminOrderCoreView;
  user: AdminOrderUserView;
  payment: AdminOrderPaymentView | null;
  entitlements: AdminOrderEntitlementView[];
  refunds: AdminOrderRefundView[];
  refundedAmount: number;
  refundableAmount: number;
  timeline: OrderTimelineEvent[];
  auditTrail: AdminOrderAuditEntry[];
  adminActions: AdminActionsView;
}

/** 详情页展示的审计轨迹条数（完整轨迹走 `GET /admin/audit-logs`） */
const AUDIT_TRAIL_LIMIT = 10;

/** UUID 形态判定（v4/v7 均匹配） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AdminOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  // ==========================================================================
  // GET /admin/orders
  // ==========================================================================

  async listOrders(query: ListAdminOrdersQueryDto): Promise<AdminOrderListView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ADMIN_ORDER_DEFAULT_PAGE_SIZE;

    if (query.minAmount !== undefined && query.maxAmount !== undefined && query.minAmount > query.maxAmount) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'minAmount 不能大于 maxAmount');
    }

    const where = this.buildListWhere(query);
    const orderBy = this.buildOrderBy(query.sortBy ?? 'createdAt', query.order ?? 'desc');

    const [rows, total, statusBuckets, typeBuckets] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: ORDER_LIST_INCLUDE,
      }),
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { paidAmount: true, refundedAmount: true },
      }),
      this.prisma.order.groupBy({
        by: ['productType'],
        where,
        _count: { _all: true },
        _sum: { paidAmount: true },
      }),
    ]);

    const orderIds = rows.map((row) => row.id);
    const [entitlementTypesByOrder, transactionIds] = await Promise.all([
      this.loadEntitlementTypes(orderIds),
      this.loadTransactionIds(orderIds),
    ]);

    const now = new Date();
    const items = rows.map((row) =>
      this.toListItem(row, entitlementTypesByOrder.get(row.id) ?? [], transactionIds.get(row.id) ?? null, now),
    );

    const summary = buildOrderListSummary(
      total,
      statusBuckets.map((bucket) => ({
        status: bucket.status,
        count: bucket._count._all,
        paidAmount: bucket._sum.paidAmount ?? 0,
        refundedAmount: bucket._sum.refundedAmount ?? 0,
      })),
      typeBuckets.map((bucket) => ({
        productType: bucket.productType,
        count: bucket._count._all,
        paidAmount: bucket._sum.paidAmount ?? 0,
      })),
    );

    return {
      items,
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary,
    };
  }

  // ==========================================================================
  // GET /admin/orders/{id}
  // ==========================================================================

  /**
   * 订单详情
   *
   * `byNo = true` 时 path 参数是 `orderNo`。两条路径共用同一套装配逻辑，
   * 避免「按 ID 查」与「按单号查」的响应结构随时间漂移。
   */
  async getOrderDetail(id: string, byNo: boolean): Promise<AdminOrderDetailView> {
    const order = await this.findOrder(id, byNo);

    const [product, payments, refunds, entitlements, userAggregates, auditTrail, user] = await Promise.all([
      order.productId === null
        ? Promise.resolve(null)
        : this.prisma.product.findUnique({ where: { id: order.productId }, select: { code: true, name: true } }),
      // payments / refunds / entitlements 都按 order_id 索引取，单次查询
      this.prisma.payment.findMany({
        where: { orderId: order.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.refund.findMany({ where: { orderId: order.id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
      this.prisma.entitlement.findMany({
        where: { orderId: order.id, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.loadUserAggregates(order.userId),
      this.prisma.adminAuditLog.findMany({
        where: { resourceType: 'order', resourceId: order.id },
        orderBy: { createdAt: 'desc' },
        take: AUDIT_TRAIL_LIMIT,
        select: { createdAt: true, action: true, adminUsername: true, diffSummary: true },
      }),
      this.prisma.user.findUnique({
        where: { id: order.userId },
        select: { id: true, nickname: true, phoneEnc: true, status: true, createdAt: true },
      }),
    ]);

    if (user === null) {
      // orders.user_id 是 Restrict 外键，理论上不会出现；出现即说明数据被绕过约束改过
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND, '订单归属用户不存在，请联系技术支持');
    }

    const refundedAmount = order.refundedAmount;
    const refundableAmount = computeRefundableAmount(order.paidAmount, refundedAmount);
    const payment = latestPayment(payments);
    const refundSuccessAt = latestRefundSuccessAt(refunds);

    return {
      order: buildOrderCoreView({
        order,
        product,
        refundedAt: refundSuccessAt,
        wechatPayEnv: this.configService.get('wechatPay.env', { infer: true }),
      }),
      user: {
        userId: user.id,
        nickname: user.nickname,
        // 明文永不外传：解密后立刻掩码，响应里只有掩码值（架构 §14.2）
        phoneMasked: maskPhoneOf(this.crypto.tryDecrypt(user.phoneEnc)),
        status: user.status,
        registeredAt: user.createdAt.toISOString(),
        orderCount: userAggregates.orderCount,
        totalPaidAmount: userAggregates.totalPaidAmount,
        refundCount: userAggregates.refundCount,
      },
      payment: buildOrderPaymentView(payment),
      entitlements: entitlements.map((entitlement) => buildOrderEntitlementView(entitlement)),
      refunds: refunds.map((refund) => buildOrderRefundView(refund)),
      refundedAmount,
      refundableAmount,
      timeline: buildOrderTimeline({
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        fulfilledAt: order.fulfilledAt,
        closedAt: order.closedAt,
        cancelledAt: order.cancelledAt,
        paymentCreatedAt: payment?.createdAt ?? null,
        paymentStatus: payment?.status ?? null,
        refundSuccessAt,
      }),
      auditTrail: auditTrail.map((entry) => ({
        at: entry.createdAt.toISOString(),
        action: entry.action,
        operatorName: entry.adminUsername,
        detail: entry.diffSummary,
      })),
      adminActions: deriveAdminActions({
        status: order.status,
        paidAt: order.paidAt,
        refundableAmount,
        entitlementCount: entitlements.length,
        hasPayment: payment !== null,
        now: new Date(),
      }),
    };
  }

  // ==========================================================================
  // 导出取数（供 Processor 调用）
  // ==========================================================================

  /** 命中筛选条件的订单数（导出的 `estimatedRows`；只 count，不取行） */
  async countForExport(filters: OrderFilterInput): Promise<number> {
    return this.prisma.order.count({ where: this.buildListWhere(filters) });
  }

  /**
   * 分页取全量导出数据（keyset 游标，不用 OFFSET）
   *
   * 为什么不用 `skip/take` 翻页：导出的时间范围上限是 366 天，
   * `OFFSET 40000` 会让 PostgreSQL 逐行丢弃前 4 万行，随页数增长呈平方级变慢。
   * 按主键 `id` 游标翻页则每批都走索引且代价恒定。
   *
   * 排序固定为 `id asc`：导出文件是给财务核对用的，需要**同一条件两次导出得到
   * 相同的行顺序**（契约未规定排序，这里显式定死并写在这里，而不是随调用方传参）。
   */
  async collectForExport(
    filters: OrderFilterInput,
    maxRows: number = ORDER_EXPORT_MAX_ROWS,
  ): Promise<OrderExportCollection> {
    const baseWhere = this.buildListWhere(filters);
    const items: AdminOrderListItem[] = [];
    let totalAmount = 0;
    let totalRefundedAmount = 0;
    let truncated = false;
    let cursor: string | null = null;

    for (;;) {
      const where: Prisma.OrderWhereInput = cursor === null ? baseWhere : { AND: [baseWhere, { id: { gt: cursor } }] };

      const rows = await this.prisma.order.findMany({
        where,
        orderBy: { id: 'asc' },
        take: EXPORT_BATCH_SIZE,
        include: ORDER_LIST_INCLUDE,
      });

      if (rows.length === 0) break;

      const orderIds = rows.map((row) => row.id);
      const [entitlementTypesByOrder, transactionIds] = await Promise.all([
        this.loadEntitlementTypes(orderIds),
        this.loadTransactionIds(orderIds),
      ]);

      const now = new Date();
      for (const row of rows) {
        if (items.length >= maxRows) {
          truncated = true;
          break;
        }

        const item = this.toListItem(
          row,
          entitlementTypesByOrder.get(row.id) ?? [],
          transactionIds.get(row.id) ?? null,
          now,
        );

        items.push(item);
        totalAmount += item.payAmount;
        totalRefundedAmount += item.refundedAmount;
      }

      if (truncated) break;
      if (rows.length < EXPORT_BATCH_SIZE) break;

      cursor = rows[rows.length - 1]?.id ?? null;
      if (cursor === null) break;
    }

    return { items, rowCount: items.length, totalAmount, totalRefundedAmount, truncated };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private async findOrder(id: string, byNo: boolean): Promise<Order> {
    if (!byNo && !UUID_PATTERN.test(id)) {
      // 契约 §3.14.6.2 的 `10003`（id 非合法 UUID）在本项目映射为 `10001`
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'id 必须是合法 UUID');
    }

    const order = await this.prisma.order.findFirst({
      where: byNo ? { orderNo: id, deletedAt: null } : { id, deletedAt: null },
    });

    if (order === null) {
      throw BusinessException.notFound(ErrorCode.ORDER_NOT_FOUND, '订单不存在');
    }

    return order;
  }

  /** 用户维度聚合（订单数 / 累计实付 / 退款笔数）：3 条聚合查询，不逐条遍历 */
  private async loadUserAggregates(
    userId: string,
  ): Promise<{ orderCount: number; totalPaidAmount: number; refundCount: number }> {
    const [orderCount, paidSum, refundCount] = await Promise.all([
      this.prisma.order.count({ where: { userId, deletedAt: null } }),
      this.prisma.order.aggregate({ where: { userId, deletedAt: null }, _sum: { paidAmount: true } }),
      this.prisma.refund.count({ where: { userId, deletedAt: null } }),
    ]);

    return {
      orderCount,
      totalPaidAmount: paidSum._sum.paidAmount ?? 0,
      refundCount,
    };
  }

  /**
   * 批量取「订单 → 权益类型集合」
   *
   * groupBy 而非逐订单查询：一页 100 条时逐条查会产生 100 次往返（N+1），
   * 这里固定 1 次，且只取 `orderId/type` 两列。
   */
  private async loadEntitlementTypes(orderIds: readonly string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (orderIds.length === 0) return map;

    const grouped = await this.prisma.entitlement.groupBy({
      by: ['orderId', 'type'],
      where: { orderId: { in: [...orderIds] }, deletedAt: null },
    });

    for (const row of grouped) {
      if (row.orderId === null) continue;
      const list = map.get(row.orderId);
      if (list === undefined) {
        map.set(row.orderId, [row.type]);
      } else {
        list.push(row.type);
      }
    }

    return map;
  }

  /**
   * 批量取「订单 → 交易号」
   *
   * 契约 §3.14.6.1 的列表条目含 `transactionId`，而该列在 `payments` 表上。
   * 用一次 `IN` 查询替代逐行查询；同一订单可能有多张支付单（如重新支付），
   * 按 `createdAt desc` 取首个即最近一次交易号。
   */
  private async loadTransactionIds(orderIds: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (orderIds.length === 0) return map;

    const payments = await this.prisma.payment.findMany({
      where: { orderId: { in: [...orderIds] }, transactionId: { not: null }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { orderId: true, transactionId: true },
    });

    for (const payment of payments) {
      if (payment.transactionId === null || map.has(payment.orderId)) continue;
      map.set(payment.orderId, payment.transactionId);
    }

    return map;
  }

  private toListItem(
    row: OrderListRow,
    entitlementTypes: string[],
    transactionId: string | null,
    now: Date,
  ): AdminOrderListItem {
    const abnormalFlags = deriveAbnormalFlags({
      status: row.status,
      totalAmount: row.totalAmount,
      discountAmount: row.discountAmount,
      paidAmount: row.paidAmount,
      refundedAmount: row.refundedAmount,
      paidAt: row.paidAt,
      entitlementCount: entitlementTypes.length,
      now,
    });

    return {
      orderId: row.id,
      orderNo: row.orderNo,
      status: row.status,
      statusLabel: orderStatusLabel(row.status),
      userId: row.userId,
      userNickname: row.user.nickname,
      productCode: row.product?.code ?? null,
      productName: row.product?.name ?? null,
      productType: row.productType,
      amount: row.totalAmount,
      payAmount: row.paidAmount,
      refundedAmount: row.refundedAmount,
      refundableAmount: computeRefundableAmount(row.paidAmount, row.refundedAmount),
      currency: row.currency,
      payMethod: row.payChannel,
      // 契约 §3.14.6.1 规则 4：不返回支付者 openid 明文，仅返回 transactionId
      transactionId,
      targetResourceId: row.relatedReportId ?? row.relatedRelationshipId ?? null,
      entitlementTypes,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
      refundCount: row._count.refunds,
      hasAbnormalFlag: abnormalFlags.length > 0,
      abnormalFlags: abnormalFlags.map((flag) => ABNORMAL_FLAG_LABELS[flag]),
    };
  }

  /** 列表筛选条件 */
  private buildListWhere(query: OrderFilterInput): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = { deletedAt: null };

    if (query.status !== undefined && query.status.length > 0) {
      where.status = { in: query.status as OrderStatus[] };
    }

    if (query.productType !== undefined) {
      // `AdminOrderProductType` 与 Prisma 的 `ProductType` 是同一组字符串字面量，
      // 因此无需断言（断言多余会被 @typescript-eslint/no-unnecessary-type-assertion 拦下）
      where.productType = query.productType;
    }

    if (query.productCode !== undefined) {
      where.product = { code: query.productCode };
    }

    if (query.userId !== undefined) {
      where.userId = query.userId;
    }

    if (query.hasRefund !== undefined) {
      // 「含退款」以金额为准而非 `refunds` 关联：退款单可能处于 FAILED/CLOSED，
      // 用金额判定才与 `refundedAmount`/`refundableAmount` 自洽
      where.refundedAmount = query.hasRefund ? { gt: 0 } : { equals: 0 };
    }

    if (query.minAmount !== undefined || query.maxAmount !== undefined) {
      where.paidAmount = {
        ...(query.minAmount !== undefined ? { gte: query.minAmount } : {}),
        ...(query.maxAmount !== undefined ? { lte: query.maxAmount } : {}),
      };
    }

    if (query.paidStartTime !== undefined || query.paidEndTime !== undefined) {
      where.paidAt = dateRange(query.paidStartTime, query.paidEndTime);
    }

    if (query.createdStartTime !== undefined || query.createdEndTime !== undefined) {
      where.createdAt = dateRange(query.createdStartTime, query.createdEndTime);
    }

    const keyword = query.keyword?.trim();
    if (keyword !== undefined && keyword.length > 0) {
      const or: Prisma.OrderWhereInput[] = [
        { orderNo: { contains: keyword, mode: 'insensitive' } },
        { payments: { some: { transactionId: { contains: keyword, mode: 'insensitive' } } } },
        { user: { nickname: { contains: keyword, mode: 'insensitive' } } },
      ];

      // 仅当关键字形如 UUID 才按用户 ID 匹配：否则任何随机字符串都会被拿去
      // 与 uuid 列比较，PostgreSQL 会因类型转换直接报错（而非返回空集）
      if (UUID_PATTERN.test(keyword)) {
        or.push({ userId: keyword });
      }

      where.OR = or;
    }

    return where;
  }

  /**
   * 排序映射
   *
   * `amount` 映射到 `paidAmount`（实付）而非 `totalAmount`：列表用途是对账与客服，
   * 且同一响应的 `summary.totalPaidAmount` 也是实付口径 —— 两处口径不一致会出现
   * 「按金额排序的第一条不是 summary 里金额最高的」这种自相矛盾。
   */
  private buildOrderBy(
    sortBy: AdminOrderSortField,
    order: AdminOrderSortOrder,
  ): Prisma.OrderOrderByWithRelationInput[] {
    const primary: Prisma.OrderOrderByWithRelationInput =
      sortBy === 'amount' ? { paidAmount: order } : sortBy === 'paidAt' ? { paidAt: order } : { createdAt: order };

    // 次级排序固定 id：`paidAt` 可空且大量订单时间相同，PostgreSQL 不保证稳定序，
    // 仅按单一字段排序时分页会让同一条记录在第 1、2 页各出现一次
    return [primary, { id: 'desc' }];
  }
}

/** 日期区间条件；只给一端时另一端不设界 */
const dateRange = (start: string | undefined, end: string | undefined): Prisma.DateTimeFilter => ({
  ...(start !== undefined ? { gte: new Date(start) } : {}),
  ...(end !== undefined ? { lte: new Date(end) } : {}),
});
