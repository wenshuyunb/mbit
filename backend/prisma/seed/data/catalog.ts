/**
 * 可售目录种子数据：会员套餐 + 商品
 *
 * ## 价格来源
 *
 * 全部取自契约 `docs/API_DESIGN.md` 中已给出的示例价格，**不是自编的**：
 *   · 会员套餐 §3.8.1 计划列表（约 8233–8340 行）：月度 3900 / 季度 9900 / 年度 29900
 *   · 单次商品 §3.12.1 系统配置的商品清单（约 10752–10774 行）：
 *     人格深度报告 9900 / 情侣匹配深度报告 19900 / AI 对话 50 次 2900
 *
 * 金额一律为**整数分**（ADR-009）。改价请改这里并重新执行 seed，或走后台商品管理。
 *
 * ## 为什么必须有这份种子
 *
 * 此前 `products` 与 `membership_plans` 表**是空的**，导致：
 *   · `GET /membership/products` 返回 `items: []` —— 会员页只能显示「暂无可用套餐」
 *   · `POST /payment/orders` 无商品可买 —— **整条支付链路无法验证**
 * 契约的定价是「可后台配置」的，但配置的前提是初始目录存在。
 */

import type { AiReportType, ProductType } from '@prisma/client';

/** 会员权益项（写入 `membership_plans.benefits` 这个 JsonB 列） */
export interface SeedPlanBenefit {
  key: string;
  label: string;
  value: string;
  highlight: boolean;
}

/** 会员套餐种子 */
export interface SeedMembershipPlan {
  code: string;
  name: string;
  description: string;
  durationDays: number;
  /** 现价（分） */
  priceAmount: number;
  /** 划线原价（分） */
  originalAmount: number;
  dailyAiQuota: number;
  totalAiQuota: number | null;
  pdfExportQuota: number;
  benefits: SeedPlanBenefit[];
  sortOrder: number;
  isRecommended: boolean;
  tags: string[];
  /** 关联商品编码：seed 会把它填进对应商品的 `membershipPlanId` */
  productCode: string;
}

/** 三种会员档位共用的权益清单（契约 §3.8.1 示例逐字取自文档） */
const MEMBERSHIP_BENEFITS: SeedPlanBenefit[] = [
  { key: 'AI_DAILY_LIMIT', label: 'AI 助手每日对话', value: '50 次', highlight: true },
  { key: 'UNLIMITED_REPORTS', label: '人格报告', value: '不限份数', highlight: true },
  { key: 'REGENERATE', label: '报告重新生成', value: '每日 5 次', highlight: false },
  // ⚠ 「PDF 导出」后端目前**交不出来**（`report-render.util.ts` 恒抛 `90008`），
  // 因此这里如实写成"即将开放"而不是"不限次" —— 这是**付费权益表**，
  // 写上去就是对用户的承诺（`FEATURE_PDF_EXPORT` 开关也已同步默认关闭）。
  // 渲染器接入后：本项改回 `value: '不限次', highlight: true`，
  // 并把 `system-config.catalog.ts` 的 `FEATURE_PDF_EXPORT` 默认值改回 `'true'`。
  { key: 'PDF_EXPORT', label: 'PDF 导出', value: '即将开放', highlight: false },
  { key: 'COMPATIBILITY_REPORT', label: '情侣匹配深度报告', value: '包含', highlight: true },
  { key: 'HISTORY_ARCHIVE', label: '历史关系档案', value: '包含', highlight: false },
];

export const MEMBERSHIP_PLANS: SeedMembershipPlan[] = [
  {
    code: 'MEMBER_MONTHLY',
    name: '月度会员',
    description: '解锁 AI 情感助手每日 50 次对话、报告无限重新生成与匹配深度报告（PDF 导出即将开放）。',
    durationDays: 30,
    priceAmount: 3900,
    originalAmount: 6900,
    // 契约 §3.8.1 示例：每日 50 次
    dailyAiQuota: 50,
    totalAiQuota: null,
    pdfExportQuota: 0,
    benefits: MEMBERSHIP_BENEFITS,
    sortOrder: 10,
    isRecommended: false,
    tags: ['随时可取消'],
    productCode: 'MEMBERSHIP_MONTHLY',
  },
  {
    code: 'MEMBER_QUARTERLY',
    name: '季度会员',
    description: '90 天完整权益，折合每月更低，覆盖完整的关系探索周期。',
    durationDays: 90,
    priceAmount: 9900,
    originalAmount: 20700,
    dailyAiQuota: 50,
    totalAiQuota: null,
    pdfExportQuota: 0,
    benefits: MEMBERSHIP_BENEFITS,
    sortOrder: 20,
    isRecommended: true,
    tags: ['最受欢迎', '折合 ¥33/月'],
    productCode: 'MEMBERSHIP_QUARTERLY',
  },
  {
    code: 'MEMBER_YEARLY',
    name: '年度会员',
    description: '365 天完整权益，适合希望长期记录人格成长的用户。',
    durationDays: 365,
    priceAmount: 29900,
    originalAmount: 82800,
    dailyAiQuota: 50,
    totalAiQuota: null,
    pdfExportQuota: 0,
    benefits: MEMBERSHIP_BENEFITS,
    sortOrder: 30,
    isRecommended: false,
    tags: ['最划算', '折合 ¥25/月'],
    productCode: 'MEMBERSHIP_YEARLY',
  },
];

/** 商品种子 */
export interface SeedProduct {
  code: string;
  name: string;
  type: ProductType;
  description: string;
  /** 现价（分） */
  priceAmount: number;
  /** 划线原价（分）；无优惠为 null */
  originalAmount: number | null;
  /** 会员/权益时长（天）；一次性商品为 null */
  durationDays: number | null;
  /** AI 次数包包含的次数 */
  credits: number | null;
  /** 报告类商品关联的报告类型 */
  reportType: AiReportType | null;
  tags: string[];
  sortOrder: number;
  isRecommended: boolean;
}

export const PRODUCTS: SeedProduct[] = [
  // ------------------------------------------------------------------ 会员
  {
    code: 'MEMBERSHIP_MONTHLY',
    name: '月度会员',
    type: 'MEMBERSHIP',
    description: '30 天会员权益：AI 助手每日 50 次对话、报告不限份数（PDF 导出即将开放）。',
    priceAmount: 3900,
    originalAmount: 6900,
    durationDays: 30,
    credits: null,
    reportType: null,
    tags: ['随时可取消'],
    sortOrder: 10,
    isRecommended: false,
  },
  {
    code: 'MEMBERSHIP_QUARTERLY',
    name: '季度会员',
    type: 'MEMBERSHIP',
    description: '90 天会员权益，折合每月更低。',
    priceAmount: 9900,
    originalAmount: 20700,
    durationDays: 90,
    credits: null,
    reportType: null,
    tags: ['最受欢迎', '折合 ¥33/月'],
    sortOrder: 20,
    isRecommended: true,
  },
  {
    code: 'MEMBERSHIP_YEARLY',
    name: '年度会员',
    type: 'MEMBERSHIP',
    description: '365 天会员权益，最划算。',
    priceAmount: 29900,
    originalAmount: 82800,
    durationDays: 365,
    credits: null,
    reportType: null,
    tags: ['最划算', '折合 ¥25/月'],
    sortOrder: 30,
    isRecommended: false,
  },

  // -------------------------------------------------------------- 单次报告
  {
    code: 'REPORT_PERSONAL_DEEP',
    name: '人格深度报告',
    type: 'REPORT_PERSONAL',
    description: '基于你的人格画像生成 3000+ 字深度解读，含 6 大板块，永久可读。',
    priceAmount: 9900,
    originalAmount: null,
    durationDays: null,
    credits: null,
    // 人格深度报告对应 MBTI 报告（项目的人格报告以 MBTI 类型为主线索）
    reportType: 'MBTI_REPORT',
    tags: ['永久可读', '3000+ 字'],
    sortOrder: 40,
    isRecommended: false,
  },
  {
    code: 'REPORT_COMPATIBILITY_DEEP',
    name: '情侣匹配深度报告',
    type: 'REPORT_COMPATIBILITY',
    description: '双人画像交叉解读：相处模式、冲突来源与沟通建议。',
    priceAmount: 19900,
    originalAmount: null,
    durationDays: null,
    credits: null,
    reportType: 'RELATIONSHIP_REPORT',
    tags: ['双人解读', '永久可读'],
    sortOrder: 50,
    isRecommended: false,
  },

  // ------------------------------------------------------------- AI 次数包
  {
    code: 'AI_CREDITS_50',
    name: 'AI 对话 50 次',
    type: 'AI_CREDITS',
    description: '一次性购买 50 次 AI 情感助手对话额度，不限期使用。',
    priceAmount: 2900,
    originalAmount: null,
    durationDays: null,
    credits: 50,
    reportType: null,
    tags: ['不限期'],
    sortOrder: 60,
    isRecommended: false,
  },
];
