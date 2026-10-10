import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CryptoService } from './crypto.service';

/**
 * 加密模块（全局）
 *
 * 为什么设为全局：`session_key`、手机号等敏感字段散布在 user / auth / storage 多个模块，
 * 逐个 import 只会增加样板代码而无隔离收益（该服务本身无状态、无副作用）。
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
