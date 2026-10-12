/**
 * SystemModule — 用户端系统配置域（契约 §3.12）
 *
 * ## 为什么要单独成模块而不是塞进某个既有模块
 *
 * `system_configs` 被三个方向同时读写：公开侧（本模块）、管理端（`admin/config`）、
 * 以及各业务模块内部的兜底读取。把公开出口与缓存放在独立模块里，
 * 管理端就能 `imports: [SystemModule]` 复用**同一个** `SystemConfigService` 实例来失效缓存，
 * 而不是各自持有 Redis 键名再各写一遍删除逻辑（那是缓存不一致的经典来源）。
 *
 * ## 接线说明
 *
 * 需要在 `app.module.ts` 的 imports 中加入 `SystemModule`（本任务约定不修改共享文件，
 * 因此由接线方补上）；`AdminConfigModule` 会 import 本模块以复用缓存失效能力。
 */

import { Module } from '@nestjs/common';

import { SystemController } from './system.controller';
import { SystemConfigService } from './system-config.service';

@Module({
  controllers: [SystemController],
  providers: [SystemConfigService],
  // 导出给管理端配置模块：写配置后必须失效**同一份**缓存
  exports: [SystemConfigService],
})
export class SystemModule {}
