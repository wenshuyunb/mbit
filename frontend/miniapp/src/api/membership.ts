/**
 * 会员与商品接口
 *
 * ## 后端只有两个读接口（权威来源 `backend/src/modules/membership/membership.controller.ts`）
 *
 * | 接口                    | 用途                                        |
 * | ----------------------- | ------------------------------------------- |
 * | `GET /membership`       | 我的会员状态                                |
 * | `GET /membership/products` | 可售商品列表 **+ 会员状态**（一起返回）  |
 *
 * 原文件里的三个路径（`/membership/plans`、`/membership/me`、`/membership/entitlements`）
 * 后端**全都不存在**，调用只会得到 `404 / 10002`。其中：
 *   · `/membership/me` → 实际是 `GET /membership`（无子路径）
 *   · `/membership/plans` → 实际是 `GET /membership/products`，且响应结构不同
 *   · `/membership/entitlements` → **没有对应接口**：`EntitlementService.loadEntitlements()`
 *     是内部方法，从未被任何控制器序列化
 *
 * ## 为什么前端不需要「权益列表」
 *
 * 架构文档 §13.1 说权益是解锁内容的**唯一依据**，但这不等于前端要自己去查权益表：
 * 报告接口的 `isUnlocked` / `unlockType`、会员接口的 `isMember` 都由服务端算好下发。
 * 前端自己推断「是否买过」等于把规则复制一份到客户端，两边一旦不一致就会出现
 * 「显示已解锁但点进去 403」。
 *
 * ## 价格一律以服务端为准
 *
 * 这些字段只用于展示；下单时金额由服务端从商品表重读，客户端传什么价都不影响收款。
 */

import { http } from './request';

/** 商品类型（与 Prisma `ProductType` 一致） */
export type ProductType = 'REPORT_PERSONAL' | 'REPORT_COMPATIBILITY' | 'MEMBERSHIP' | 'AI_CREDITS';

/** 会员状态（后端 `MembershipView`） */
export interface MembershipStatus {
  isMember: boolean;
  /** 非会员时为 `null` */
  expireAt: string | null;
  /** 未开通为 `null`；**已到期为 `0`**（与「未开通」含义不同） */
  remainingDays: number | null;
}

/** 商品（后端 `ProductView`） */
export interface Product {
  /**
   * 商品 ID —— **下单必须用这个**（后端 `@IsUUID()` 校验），不是 `code`
   *
   * 原文件的 `MembershipPlan` 没有这个字段，导致下单时只能传 `code` 而必然被拒。
   */
  productId: string;
  code: string;
  name: string;
  description: string | null;
  type: ProductType;
  /** 现价（分） */
  priceAmount: number;
  /** 划线原价（分）；无优惠时为 `null` */
  originalAmount: number | null;
  currency: string;
  /** 会员/权益时长（天）；一次性商品为 `null` */
  durationDays: number | null;
  /** AI 次数（`AI_CREDITS` 类商品） */
  credits: number | null;
  /** 运营标签（原文件的 `benefits` 字段后端不存在，实际叫 `tags`） */
  tags: string[];
  isRecommended: boolean;
}

/**
 * 商品列表响应
 *
 * 会员状态与商品**一起返回**是后端刻意的设计：会员页必然同时需要这两份数据，
 * 拆成两个接口只会让首屏出现「价格已渲染但会员状态还在转圈」的中间态。
 */
export interface ProductList {
  items: Product[];
  membership: MembershipStatus;
}

/**
 * 我的会员状态
 *
 * 会员判定看的是 `entitlements` 时间窗权益，不是用户表上的布尔字段
 * —— 后者要在退款、续费、后台调整时同步维护，迟早不一致。
 */
export const getMyMembership = (): Promise<MembershipStatus> => http.get<MembershipStatus>('/membership');

/**
 * 可售商品列表
 *
 * 只返回 `ON_SALE` 且在有效期内的商品，按「推荐位 + `sortOrder`」排序。
 * **需要登录**（后端类级 `@ApiBearerAuth('user-token')`，非 `@Public()`）
 * —— 原文件给 `listPlans` 传了 `needAuth: false`，即使路径改对了也会得到 401。
 */
export const listProducts = (): Promise<ProductList> => http.get<ProductList>('/membership/products');
