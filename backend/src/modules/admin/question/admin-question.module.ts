/**
 * AdminQuestionModule — 后台管理「题库管理」域
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.3（7 个接口，前缀 `admin/questions`）
 *
 * ## 为什么 `imports: [AdminModule]`
 *
 * 控制器用到的守卫（`AdminAuthGuard` / `RolesGuard` / `ConfirmPasswordGuard`）与审计服务
 * （`AdminAuditService`）都由 `AdminModule` 提供并导出。**不 import 的话**，`@UseGuards(...)`
 * 里的类在当前模块的注入上下文里解析不到，应用启动即失败（而不是运行时 500）——
 * 这是刻意保留的失败方式：认证链缺件应该「起不来」，而不是「裸奔」。
 *
 * ⚠ `PrismaService` / `RedisService` 所在模块是 `@Global()`，因此这里无需 import。
 *
 * ⚠ 本模块需要被 `app.module.ts` 的 `imports` 引用后接口才会真正挂载
 * （`app.module.ts` 属于共享文件，按本次任务约定未做改动）。
 */
import { Module } from '@nestjs/common';

import { AdminModule } from '../admin.module';
import { AdminQuestionController } from './admin-question.controller';
import { AdminQuestionService } from './admin-question.service';

@Module({
  imports: [AdminModule],
  controllers: [AdminQuestionController],
  providers: [AdminQuestionService],
  exports: [AdminQuestionService],
})
export class AdminQuestionModule {}
