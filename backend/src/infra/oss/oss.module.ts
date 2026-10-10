import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { OssService } from './oss.service';

/**
 * 对象存储模块（全局）
 *
 * 为什么设为全局：OSS 被 `storage`（签发票据）、`report`（PDF 回写）、
 * `relationship`（分享图）等多处使用。该服务无状态、无副作用，
 * 逐个 import 只增加样板代码而无隔离收益 —— 与 `CryptoModule` 同理。
 *
 * 未配置 OSS 环境变量时服务**不会**导致启动失败：
 * 图片/报告是增值能力，缺失应降级为「该功能不可用」（`80003`），
 * 而不是让整个后端起不来（架构 §15.2 降级策略）。
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [OssService],
  exports: [OssService],
})
export class OssModule {}
