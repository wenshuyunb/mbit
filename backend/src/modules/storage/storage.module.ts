import { Module } from '@nestjs/common';

import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/**
 * 存储模块
 *
 * 职责边界（架构 §6.1）：
 *   · `StorageService` —— 上传票据签发与签名 URL 生成（**不写业务表**）
 *   · 文件元数据落库（`stored_files`）随 OSS 回调（§3.10.3）一并实现
 *
 * 依赖方向：`storage` → `infra/oss`（全局模块）。业务模块（user/report）
 * 反向依赖 `storage` 的能力时，通过 `StorageService` 出口，不直接触碰 OSS SDK。
 */
@Module({
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
