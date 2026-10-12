/**
 * NotificationModule — 站内通知与订阅消息授权（契约 §3.11）
 *
 * ## 依赖
 *
 *   · `PrismaModule` / `RedisModule` —— 全局模块，无需显式 imports
 *   · `SystemModule` —— 复用 `SystemConfigService` 读取 `assets.staticDomain`
 *     （通知图标域名）与 `notify.template.{scene}`（订阅模板权威值）。
 *     复用同一个服务实例而不是自己查 `system_configs`：缓存失效必须与
 *     配置模块共用一份，否则后台改了模板 ID，这里还在用旧的缓存值。
 *
 * `SystemModule` **不反向依赖**本模块，因此不存在循环依赖。
 *
 * ## 接线
 *
 * 需要在 `app.module.ts` 的 imports 中加入 `NotificationModule`
 * （`app.module.ts` 是共享文件，本次约定不修改，由接线方补上；
 * 该文件第 200 行原本就留着 `// Phase 5+ 待接入：NotificationModule` 的占位）。
 */

import { Module } from '@nestjs/common';

import { SystemModule } from '../system/system.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [SystemModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  // 导出给后续需要读未读数的模块（例如首页红点聚合）
  exports: [NotificationService],
})
export class NotificationModule {}
