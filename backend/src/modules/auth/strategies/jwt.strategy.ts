/**
 * JWT 认证策略（用户端 realm）
 *
 * 职责分工：
 *   · passport-jwt 负责**签名与过期**校验（密码学层面，交给成熟库）
 *   · TokenService.assertPayloadUsable 负责**业务层面**校验（realm 隔离、黑名单）
 *
 * 双 realm 隔离（架构 §9.2）：本策略只接受 `realm === 'user'` 的令牌；
 * 管理员令牌由独立的 `AdminJwtStrategy` 使用**不同密钥与 audience** 校验，二者不可互换。
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';

import type { AuthPrincipal } from '../../../common/types/request.type';
import type { AppConfig } from '../../../config/config.type';
import { TokenService, type AccessTokenPayload } from '../token.service';

/** 本策略在 passport 中的注册名，供 AuthGuard('jwt') 引用 */
export const USER_JWT_STRATEGY = 'user-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, USER_JWT_STRATEGY) {
  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly tokens: TokenService,
  ) {
    const options: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // 用户端与管理端使用不同密钥，杜绝令牌跨 realm 复用
      secretOrKey: configService.get('jwt.userSecret', { infer: true }),
      // 交由 passport 处理过期（过期会走 handleRequest 的 info 分支）
      ignoreExpiration: false,
    };

    super(options);
  }

  /**
   * 签名校验通过后调用
   *
   * 返回值会被 passport 挂到 `request.user`，随后由 JwtAuthGuard 转存到
   * `request.principal`（见 guards/jwt-auth.guard.ts）。
   *
   * @throws BusinessException realm 不匹配或令牌已被吊销
   */
  async validate(payload: AccessTokenPayload): Promise<AuthPrincipal> {
    return this.tokens.assertPayloadUsable(payload);
  }
}
