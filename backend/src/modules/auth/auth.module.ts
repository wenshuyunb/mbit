import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import type { AppConfig } from '../../config/config.type';
import { WechatModule } from '../../infra/wechat/wechat.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * 认证模块
 *
 * 依赖方向（架构 §6.1 白名单）：`auth` → `user` / `infra/wechat` / `infra/redis`
 * 本模块不依赖任何其他业务模块，是依赖图的最底层之一。
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'user-jwt', session: false }),
    WechatModule,
    // JwtModule 只用于 signAsync / verifyAsync，具体密钥在调用处以 per-call 形式传入，
    // 避免「用户端 / 管理端共用同一默认密钥」这种容易出错的隐式约定。
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => ({
        secret: configService.get('jwt.userSecret', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtStrategy],
  // TokenService 需要被其他模块复用以校验令牌（如 WebSocket 握手），因此导出
  exports: [AuthService, TokenService],
})
export class AuthModule {}
