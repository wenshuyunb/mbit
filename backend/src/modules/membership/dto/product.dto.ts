/**
 * 会员商品查询参数（契约 §3.8.1）
 *
 * 契约在该端点的字段表里声明了 `type`（按商品类型筛选）与 `code`（精确查单个商品），
 * 但实现此前**根本没有绑定 `@Query()`** —— 传什么都没人看。
 * 与"参数被静默忽略"相比，更糟的是有真实调用方依赖它：
 * `chat-conversation.service.ts` 下发给付费墙的 `creditsUrl` 就带着 `?type=AI_CREDITS`
 * （用户点"买次数包"时若不过滤，会看到会员套餐混在一起）。
 *
 * 本次只补 `type`：它是**付费墙真正需要**的那一个。`code` 属"按编码查单个商品"
 * 的场景（当前没有调用方），留待有需求时再加 —— 契约里未交付的字段已按 ADR-034
 * 的做法登记，不在 DTO 里占位（占位即"收下再忽略"）。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductType } from '@prisma/client';
import { IsIn, IsOptional } from 'class-validator';

/** 可筛选的商品类型（与 Prisma `ProductType` 逐字对齐） */
export const PRODUCT_TYPE_FILTERS = [
  ProductType.MEMBERSHIP,
  ProductType.AI_CREDITS,
  ProductType.REPORT_PERSONAL,
  ProductType.REPORT_COMPATIBILITY,
] as const;

export type ProductTypeFilter = (typeof PRODUCT_TYPE_FILTERS)[number];

export class ListProductsQueryDto {
  @ApiPropertyOptional({
    enum: PRODUCT_TYPE_FILTERS,
    description: '按商品类型筛选；不传返回全部可售商品（会员档位 + 单次商品）',
    example: ProductType.AI_CREDITS,
  })
  @IsOptional()
  @IsIn(PRODUCT_TYPE_FILTERS, { message: `type 仅支持：${PRODUCT_TYPE_FILTERS.join(', ')}` })
  type?: ProductTypeFilter;
}
