/**
 * JWT 认证策略（管理端 realm）
 *
 * 与用户端 `JwtStrategy` 的差异只有一处但至关重要：**密钥不同**
 * （`jwt.adminSecret` = `ADMIN_JWT_SECRET`，配置层强校验其与 `JWT_SECRET` 不同值）。
 *
 * ## 跨 realm 令牌的表现
 *
 * 因为两端密钥不同，把用户令牌拿到管理端接口上会在**签名校验**阶段就失败，
 * 根本解不出 `realm` 字段 —— 因此实际返回的是 `TOKEN_INVALID`（20002），
 * 而不是契约 §3.14 字面写的 `REALM_MISMATCH`。
 *
 * 这不是缺陷，而是双 realm 隔离（ADR-012）**生效**的表现：攻击者连
 * 「这个令牌属于另一个 realm」都无法从响应中推断出来。`assertPayloadUsable`
 * 里的 realm 检查作为纵深防御保留（应对密钥误配成同一个的极端情况）。
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';

import type { AuthPrincipal } from '../../../common/types/request.type';
import type { AppConfig } from '../../../config/config.type';
import { AdminTokenService, type AdminAccessTokenPayload } from '../auth/admin-token.service';

/** 本策略在 passport 中的注册名，供 AuthGuard('admin-jwt') 引用 */
export const ADMIN_JWT_STRATEGY = 'admin-jwt';

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, ADMIN_JWT_STRATEGY) {
  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly tokens: AdminTokenService,
  ) {
    const options: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // 管理端与用户端使用不同密钥，杜绝令牌跨 realm 复用
      secretOrKey: configService.get('jwt.adminSecret', { infer: true }),
      ignoreExpiration: false,
    };

    super(options);
  }

  /**
   * 签名校验通过后调用；返回值会被挂到 `request.principal`
   *
   * @throws BusinessException realm 不匹配、令牌被吊销或会话已撤销
   */
  async validate(payload: AdminAccessTokenPayload): Promise<AuthPrincipal> {
    return this.tokens.assertPayloadUsable(payload);
  }
}
