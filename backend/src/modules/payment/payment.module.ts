import { Module } from '@nestjs/common';

import { WechatPayService } from '../../infra/wechat/wechat-pay.service';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

/**
 * 支付模块（契约 §3.7；架构 §13.3）
 *
 * 职责边界：
 *   · `WechatPayService`（infra）—— 验签 + 解密，**不涉及订单与权益**
 *   · `PaymentService` —— 通知 → 订单状态流转 → 权益发放（同一事务）
 *
 * 依赖方向：`payment` → `infra/wechat` + `infra/prisma`（全局），
 * 且**单向依赖 `membership` 的判定约定**（资源键格式在 `entitlement.util.ts` 里定义）。
 * 反向依赖不存在：权益模块不认识订单。
 *
 * 尚未实现（Phase 6 后续）：
 *   · 下单接口（`POST /orders`）与 JSAPI 预支付单
 *   · 退款与退款回调（`Refund` 表已存在）
 *   · 平台证书的**自动下载与轮换**（目前从 `WECHAT_PAY_PLATFORM_CERT_PATH` 读文件）
 *   · 订单超时关闭与对账
 */
@Module({
  controllers: [PaymentController],
  providers: [PaymentService, WechatPayService],
  exports: [PaymentService],
})
export class PaymentModule {}
