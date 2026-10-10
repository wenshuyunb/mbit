import { Module } from '@nestjs/common';

import { MembershipController } from './membership.controller';
import { EntitlementService } from './entitlement.service';

/**
 * 会员与权益模块（契约 §2.4；架构 §13）
 *
 * 职责边界：
 *   · `MembershipController` —— 读接口：我的会员状态、可售商品列表
 *   · `EntitlementService` —— 读取与判定权益（会员有效期、单份/单段报告解锁）
 *   · 判定逻辑在 `entitlement.util.ts`（纯函数），本模块只做取数
 *
 * **没有任何发放权益的客户端入口**：权益只能由支付回调（`PaymentService`）
 * 或后台管理员触发。任何「前端调用即发权益」的接口都等于免费送。
 *
 * **导出 `EntitlementService`**：报告域需要它来裁剪付费内容
 * （`ReportController` 的解锁状态、`ReportService` 列表里的 `isUnlocked`）。
 * 依赖方向是单向的 `ai/report` → `membership`，`membership` 不反向依赖任何业务模块。
 *
 * 尚未实现（Phase 6 后续）：
 *   · `payment` 模块 —— 微信支付 v3 下单、回调验签与解密、退款
 *   · `products` / `orders` 的对外接口
 *   · 权益发放（目前权益只能由后台或种子数据写入）
 */
@Module({
  controllers: [MembershipController],
  providers: [EntitlementService],
  exports: [EntitlementService],
})
export class MembershipModule {}
