/**
 * 支付模块（契约 §3.7、§3.9、§3.14.6.3；架构 §13.3）
 *
 * 职责边界：
 *   · `WechatPayService`（infra）—— 验签 / 解密 / 下单 / 查单 / 关单 / 退款，**不涉及订单与权益**
 *   · `PaymentService`    —— 回调 → 订单状态流转 → 权益发放（同一事务）；并提供
 *                            查单补偿可复用的 `fulfillPaidOrder`
 *   · `OrderQueryService` —— 用户端订单查询与状态流转（列表/详情/查单/取消/关单/超时关单）
 *   · `RefundService`     —— 退款（申请/审核/执行/对账）与权益回收
 *
 * 依赖方向：`payment` → `infra/wechat` + `infra/prisma`（全局）+ `infra/redis`（全局），
 * 并 `imports: [AdminModule]` —— 只为拿到 `AdminAuthGuard` / `RolesGuard` /
 * `ConfirmPasswordGuard` 三个守卫类：本模块承载了管理端退款接口
 * （`POST /admin/orders/{id}/refund`）。模块上下文里解析不到守卫类时 Nest **启动即报错**
 * （而不是运行到该路由才 401），因此这个 import 是必需的，不是可选的便利。
 *
 * 反向依赖不存在：AdminModule 不认识 payment。
 *
 * ## 队列处理器不在这里
 *
 * 超时关单与退款对账的 Worker（`PaymentJobsModule`）**只在 Worker 进程加载**，
 * 见同目录 `payment-jobs.module.ts` 的接线说明。
 *
 * ## 尚未实现
 *
 *   · 退款结果回调（`WECHAT_PAY_REFUND_NOTIFY_URL`）—— 当前由每分钟的对账任务
 *     主动查询替代，功能等价但延迟最多 1 分钟
 *   · 平台证书的**自动下载与轮换**（目前从 `WECHAT_PAY_PLATFORM_CERT_PATH` 读文件）
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { WechatPayService } from '../../infra/wechat/wechat-pay.service';
import { AdminModule } from '../admin/admin.module';
import { AdminOrderRefundController } from './admin-order-refund.controller';
import { OrderQueryService } from './order-query.service';
import { OrdersController } from './orders.controller';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { RefundsController } from './refunds.controller';

@Module({
  // `ConfigModule` 显式声明：本模块的服务注入 `ConfigService`（如 `wechatPay.env`）。
  // AppModule 里 `ConfigModule.forRoot({ isGlobal: true })` 已经让它全局可用，
  // 但**显式声明**让本模块可以独立装配（`payment.module.spec.ts` 就是这么验证的）——
  // 否则任何脱离 AppModule 的装配（测试、未来的独立 worker）都会因解析不到
  // ConfigService 而在启动时报错
  imports: [ConfigModule, AdminModule],
  controllers: [PaymentController, OrdersController, RefundsController, AdminOrderRefundController],
  providers: [PaymentService, OrderQueryService, RefundService, WechatPayService],
  // 导出给 `PaymentJobsModule`（Worker 进程）复用**同一份**实现，
  // 避免队列处理器与 HTTP 侧各持一个实例
  exports: [PaymentService, OrderQueryService, RefundService],
})
export class PaymentModule {}
