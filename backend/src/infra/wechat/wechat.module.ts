import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WechatService } from './wechat.service';

/**
 * 微信服务模块
 *
 * 仅封装对微信开放接口的调用（code2session、内容安全、订阅消息、小程序码），
 * 不含任何业务判断 —— 业务规则留在各业务模块，便于单测与替换。
 *
 * RedisModule 是 @Global 的，因此无需在此 import 即可注入 RedisService
 * （access_token 缓存与刷新锁依赖它）。
 */
@Module({
  imports: [ConfigModule],
  providers: [WechatService],
  exports: [WechatService],
})
export class WechatModule {}
