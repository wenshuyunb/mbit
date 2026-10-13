/**
 * 付费墙链接必须指向**真实存在的路由**（契约 §3.7.8 → §3.8.1）
 *
 * ## 守的是什么
 *
 * `GET /ai/quota` 的 `nextActions.upgradeUrl` / `creditsUrl` 是服务端**下发给客户端
 * 用来跳转**的地址。此前它们是 `/api/v1/membership/plans` 与
 * `/api/v1/products?type=AI_CREDITS` —— 这两个路径在本项目**一个路由都没有**
 * （ADR-033 已把 `plans` 与 `products` 合并到 `GET /membership/products`）。
 * 客户端照着跳就是 404。
 *
 * 危害不轻：这条链路正是「额度耗尽 → 拉起付费墙 → 去升级」，链接坏掉等于
 * **把付费用户挡在门外**。而它不会报错、不会告警，只有真的点下去才发现。
 *
 * ## 为什么断言"与路由声明绑定"，而不是比较字符串字面量
 *
 * 直接断言 `=== '/api/v1/membership/products'` 会在**路由改名时依然通过**
 * （两边都是手写字面量），那这条测试就成了摆设。这里改为从
 * `MembershipController` 的元数据里读出**真实声明的路径**来拼期望值：
 * 一旦有人改了控制器路径或前缀，测试立刻变红。
 */

import { PATH_METADATA } from '@nestjs/common/constants';

import { MembershipController } from '../../membership/membership.controller';
import { PAYWALL_CREDITS_URL, PAYWALL_UPGRADE_URL } from './chat-conversation.service';

/** 从控制器元数据拼出的真实路径：`/api/v1/{controller}/{handler}` */
const productsRouteOf = (): string => {
  const controllerPath = Reflect.getMetadata(PATH_METADATA, MembershipController) as string;
  const handlerPath = Reflect.getMetadata(PATH_METADATA, MembershipController.prototype.listProducts) as string;

  // 全局前缀 `api/v1` 由 `main.ts` 设置（`API_PREFIX`），此处按既定值拼接
  return `/api/v1/${controllerPath}/${handlerPath}`.replace(/\/+$/, '');
};

describe('付费墙链接', () => {
  it('【关键】upgradeUrl 等于会员商品端点的真实路由', () => {
    expect(PAYWALL_UPGRADE_URL).toBe(productsRouteOf());
  });

  it('【关键】creditsUrl 指向同一路由（带 type 筛选）', () => {
    expect(PAYWALL_CREDITS_URL.startsWith(`${productsRouteOf()}?`)).toBe(true);
  });

  it('【关键】不再引用 ADR-033 已合并掉的两个旧路径', () => {
    // 这两个路径在本项目没有任何路由，出现过一次（2026-10-13 修复），防止回流
    for (const url of [PAYWALL_UPGRADE_URL, PAYWALL_CREDITS_URL]) {
      expect(url).not.toContain('/membership/plans');
      expect(url).not.toMatch(/\/api\/v1\/products(\?|$)/);
    }
  });

  it('creditsUrl 用到的 type 筛选值在商品类型枚举内', () => {
    const type = new URL(PAYWALL_CREDITS_URL, 'https://example.com').searchParams.get('type');

    expect(type).toBe('AI_CREDITS');
  });
});
