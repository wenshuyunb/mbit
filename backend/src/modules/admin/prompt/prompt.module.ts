/**
 * AdminPromptModule — 管理端 Prompt 管理域
 *
 * `imports: [AdminModule, AiModule]`：
 *   · `AdminModule` → 守卫链（`AdminAuthGuard` / `RolesGuard` / `ConfirmPasswordGuard`）
 *     与审计服务（`AdminAuditService`）。守卫必须在**本模块的注入上下文**里可见，
 *     否则 `@UseGuards(...)` 解析不到依赖（表现为启动或首个请求报错）。
 *   · `AiModule` → 运行期的 `PromptService`，仅用于发布/回滚后调用
 *     `invalidateVersion()` 失效版本内容缓存。**必须复用运行期的实现**：
 *     缓存键格式与 TTL 都定义在那里，后台自己拼一遍 key 会在任何一次改动后静默失配，
 *     表现就是「后台显示已发布、线上仍用旧版本」。
 *
 * ⚠ 本模块尚未挂到 `AdminModule` 或 `AppModule`（共享文件，本次改动范围之外）。
 *   接入时应加入 `AdminModule` 的 imports，否则路由不会被注册。
 */

import { Module } from '@nestjs/common';

import { AiModule } from '../../ai/ai.module';
import { AdminModule } from '../admin.module';
import { AdminPromptController } from './prompt.controller';
import { AdminPromptService } from './prompt.service';

@Module({
  imports: [AdminModule, AiModule],
  controllers: [AdminPromptController],
  providers: [AdminPromptService],
})
export class AdminPromptModule {}
