/**
 * AdminConfigModule — 管理端系统配置域（契约 §3.14.9.1 / §3.14.9.2）
 *
 * ## 为什么同时 import AdminModule 与 SystemModule
 *
 *   · `AdminModule`：提供守卫（`AdminAuthGuard`/`RolesGuard`/`ConfirmPasswordGuard`）、
 *     审计（`AdminAuditService`）—— 管理端业务域模块的统一依赖。
 *   · `SystemModule`：提供**同一个** `SystemConfigService`。配置写入后必须失效前台
 *     读路径正在使用的缓存，共享同一个实例与同一个 Redis 键是唯一能保证「后台写、
 *     前台立刻读到」的方式；各自持有键名各删一次，迟早会漏掉一个（例如按版本命名的键）。
 *
 * ## 接线说明
 *
 * 需要在 `admin.module.ts` 或 `app.module.ts` 中注册本模块
 *（本任务约定不修改共享文件，因此由接线方补上）。
 */

import { Module } from '@nestjs/common';

import { SystemModule } from '../../system/system.module';
import { AdminModule } from '../admin.module';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';

@Module({
  imports: [AdminModule, SystemModule],
  controllers: [AdminConfigController],
  providers: [AdminConfigService],
})
export class AdminConfigModule {}
