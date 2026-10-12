import { Module } from '@nestjs/common';

import { QueueModule } from '../../infra/queue/queue.module';
import { AiModule } from '../ai/ai.module';
import { MembershipModule } from '../membership/membership.module';
import { CompatibilityReportController } from './compatibility-report.controller';
import { CompatibilityService } from './compatibility.service';
import { RelationshipController } from './relationship.controller';
import { RelationshipService } from './relationship.service';

/**
 * 关系模块（契约 §3.6；架构 §12.1）
 *
 * 职责边界（架构 §6.1）：
 *   · `RelationshipService` —— 邀请生命周期与关系状态机（`pairKey` 防重、
 *     邀请码 DB + Redis 双写、确认与解除）
 *   · `RelationshipController` —— 4 个写端点的参数校验与响应成形
 *
 * 依赖方向：`relationship` → `infra/prisma` + `infra/redis`（全局模块）
 * + `infra/queue`（需显式 imports 以注入 `compatibility.calc` 队列）
 * + `ai`（匹配报告的**第二阶段**：算分完成后调用 `ReportService.createReport`
 *   生成 AI 解读）。
 *
 * 关于 `relationship` → `ai` 这条依赖：它是**单向**的，`AiModule` 不反向依赖本模块
 * （关系报告的生成只用到 `relationship-view.util.ts` 里的纯函数，不是模块）。
 * 之所以允许业务模块间直接调用而不走队列，是因为这段编排本身很短（就是
 * "用关系 ID 建一份报告"），且失败必须能被算分流程感知并降级 ——
 * 拆成两段队列会让"算分成功但解读没排上"变成一种难以观测的中间态。
 *
 * 未注册 `PersonalityService`：算分直接调用 `computeCompatibility` 这个**纯函数**
 * 并自行查表取画像，而非调用人格服务 —— 关系域只需要画像的数值字段，
 * 跨模块复用整套人格视图会引入不必要的耦合与循环依赖风险。
 *
 * 依赖 `MembershipModule`（导出 `EntitlementService`）：匹配报告的付费裁剪
 * （契约 §3.6.10 规则 2）必须与个人报告用**同一套解锁规则**，
 * 否则同一份权益在不同页面会得出不同结论。`membership` 不反向依赖任何业务模块，
 * 因此无循环依赖。
 */
@Module({
  imports: [QueueModule, AiModule, MembershipModule],
  controllers: [RelationshipController, CompatibilityReportController],
  providers: [RelationshipService, CompatibilityService],
  exports: [RelationshipService, CompatibilityService],
})
export class RelationshipModule {}
