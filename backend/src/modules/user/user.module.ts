import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { QueueModule } from '../../infra/queue/queue.module';
import { WechatModule } from '../../infra/wechat/wechat.module';
import { StorageModule } from '../storage/storage.module';
import { DataExportService } from './data-export.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';

/**
 * 用户模块
 *
 * 依赖方向（架构 §6.1 白名单）：`user` → `infra/*`、`user` → `storage`
 * 不依赖 `auth`（认证由全局守卫完成，用户模块只消费 principal）。
 *
 * 头像登记通过 `StorageService` 出口，**不直接触碰 OSS SDK** ——
 * 内容校验、业务登记、公开化与旧对象清理都是存储模块的职责，
 * 用户模块只表达「这个对象要成为我的头像」这一业务意图。
 */
@Module({
  imports: [ConfigModule, WechatModule, StorageModule, QueueModule],
  controllers: [UserController],
  providers: [UserService, DataExportService],
  exports: [UserService, DataExportService],
})
export class UserModule {}
