/**
 * 订单生命周期队列的常量与接线说明
 *
 * ## ⚠ 需要接线（本文件所在模块无法自行生效）
 *
 * 在 `backend/src/worker.module.ts` 的 `imports` 中加入 `PaymentJobsModule`：
 *
 * ```ts
 * import { PaymentJobsModule } from './modules/payment/payment-jobs.module';
 * // ...
 * imports: [AppModule, UserJobsModule, AiJobsModule, RelationshipJobsModule, AdminOrderJobsModule, PaymentJobsModule],
 * ```
 *
 * 未接线时的表现：**超时关单与退款对账都不会执行**。HTTP 侧一切正常
 * （接口能调用、退款单能创建），但
 *   · 过期订单永远停留在 `PENDING_PAY`；
 *   · 微信返回 `PROCESSING` 的退款永远停留在 `PENDING`。
 *
 * 这两个任务都不会因为"没接线"而报错，只会**安静地不工作** —— 因此把它们
 * 的接线写在这里，而不是留给部署文档。
 *
 * ## 为什么队列名定义在本模块而不是 `infra/queue/queue.module.ts`
 *
 * 共享文件 `queue.module.ts` 列出了架构 §6.4 的全部队列；本队列属于
 * 「订单生命周期」这一新职责，改动共享文件会与并行开发的其他模块冲突。
 * 接线时把下面两个常量搬进 `queue.module.ts` 即可（与 `QUEUE_EXPORT_DATA` 并列）。
 */

/** 订单生命周期队列名（超时关单 + 退款对账） */
export const QUEUE_ORDER_LIFECYCLE = 'order.lifecycle';

/** 超时自动关单任务（契约 §3.9.7 规则 2：每分钟扫描） */
export const ORDER_TIMEOUT_CLOSE_JOB = 'order.timeout-close';

/** 退款对账任务（契约 §3.9.10 规则 3：主动查询更新退款状态） */
export const REFUND_RECONCILE_JOB = 'refund.reconcile';

/**
 * 定时周期（毫秒）
 *
 * 契约要求「每分钟」：60_000。这个值同时决定了两个任务的**最坏延迟** ——
 * 用户取消后最多 1 分钟才会被自动关单兜底，退款最多 1 分钟才会被对账推进。
 */
export const LIFECYCLE_INTERVAL_MS = 60_000;
