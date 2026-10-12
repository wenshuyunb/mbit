/**
 * Worker 进程的根模块
 *
 * 部署形态（架构 §17.1）：与 HTTP 服务**同一镜像**，仅启动命令不同：
 *   HTTP   → node dist/main.js   （加载 AppModule）
 *   Worker → node dist/worker.js （加载 WorkerModule = AppModule + 队列处理器）
 *
 * 为什么用**两个根模块**而不是在同一模块里按环境变量开关处理器：
 * `.env` 由 `ConfigModule.forRoot()` 在模块初始化阶段读取，而模块装饰器的
 * `imports` 在**导入求值时**就已确定 —— 那时 `.env` 还没加载。用环境变量
 * 控制 `imports` 会得到「本机开发能跑、容器里静默不消费」这类难查的问题。
 * 拆成两个根模块则完全由启动命令决定，行为确定且可读。
 *
 * `NestFactory.createApplicationContext` 不启动 HTTP 服务，因此
 * AppModule 里的 Controller 在 Worker 中只是未被调用的 Provider，无副作用。
 */

import { Module } from '@nestjs/common';

import { AppModule } from './app.module';
import { AdminOrderJobsModule } from './modules/admin/order/admin-order-jobs.module';
import { AiJobsModule } from './modules/ai/jobs/ai-jobs.module';
// 订单生命周期：超时自动关单 + 退款对账。
// ⚠ 不接线不会报任何错，只会**安静地不工作** —— 过期订单永远停在 PENDING_PAY，
//  微信返回 PROCESSING 的退款永远停在 PENDING（用户永远看到「处理中」）。
import { PaymentJobsModule } from './modules/payment/payment-jobs.module';
import { RelationshipJobsModule } from './modules/relationship/jobs/relationship-jobs.module';
import { UserJobsModule } from './modules/user/jobs/user-jobs.module';

@Module({
  imports: [
    AppModule,

    // ---------------------------------------------------------- 队列处理器
    UserJobsModule,
    AiJobsModule,
    RelationshipJobsModule,
    // 管理端订单导出（`export.data` 队列，job name = `admin.order.export`）
    AdminOrderJobsModule,
    // 订单超时关单 + 退款对账（BullMQ repeatable，60s/次）
    PaymentJobsModule,
  ],
})
export class WorkerModule {}
