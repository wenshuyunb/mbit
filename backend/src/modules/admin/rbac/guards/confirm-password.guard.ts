/**
 * ConfirmPasswordGuard — 敏感操作的二次确认密码校验
 *
 * 契约 §3.14「核心契约」第 3 条：敏感写操作需 `X-Confirm-Password` 请求头
 * （操作者本人密码），缺失返回 `20017`，密码错误返回 `20018`。
 *
 * ## 为什么需要它（而不是靠 token 就够了）
 *
 * 管理端会话有效期 1 小时且可在多设备存在。如果没有二次确认：
 *   · 管理员离开工位未锁屏，任何人都能用他的会话发起退款、封禁账号、发布 Prompt；
 *   · 一次 XSS 就能静默完成上述所有操作。
 * 二次确认把「持有会话」与「能执行破坏性操作」解耦 —— 破坏性操作要求**知道密码**，
 * 这是不可被窃取的会话令牌替代的。
 *
 * ## 只在被标记的接口上生效
 *
 * 未标 `@SensitiveOperation()` 的接口直接放行，因此本守卫可以常驻在
 * 管理端守卫链里而不影响普通读接口。
 */

import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '../../../../common/errors/business.exception';
import { ErrorCode } from '../../../../common/errors/error-code';
import type { RequestWithContext } from '../../../../common/types/request.type';
import { PrismaService } from '../../../../infra/prisma/prisma.service';
import { PasswordService } from '../../auth/password.service';
import { CONFIRM_PASSWORD_HEADER, SENSITIVE_OPERATION_KEY } from '../../decorators/sensitive-operation.decorator';

@Injectable()
export class ConfirmPasswordGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(SENSITIVE_OPERATION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required !== true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const principal = request.principal;

    if (!principal || principal.realm !== 'admin') {
      // 走到这里说明守卫链顺序配错了（ConfirmPasswordGuard 必须在 AdminAuthGuard 之后）
      throw BusinessException.forbidden(ErrorCode.PERMISSION_DENIED, '该接口仅限管理端访问');
    }

    const raw = request.headers[CONFIRM_PASSWORD_HEADER];
    const confirmPassword = Array.isArray(raw) ? raw[0] : raw;

    if (!confirmPassword) {
      throw BusinessException.unauthorized(
        ErrorCode.ADMIN_CONFIRM_PASSWORD_REQUIRED,
        '该操作需要二次确认密码，请重新输入登录密码',
      );
    }

    const admin = await this.prisma.adminUser.findFirst({
      where: { id: principal.userId, deletedAt: null },
      select: { passwordHash: true },
    });

    if (!admin) {
      throw BusinessException.unauthorized(ErrorCode.ADMIN_CONFIRM_PASSWORD_INVALID, '二次确认密码错误');
    }

    const ok = await this.passwords.verify(admin.passwordHash, confirmPassword);

    if (!ok) {
      /**
       * 与前一步返回**同一个错误码**（`20018`）：不区分「管理员不存在」与「密码错误」，
       * 否则会给出一个探测管理员 ID 是否有效的旁路。
       */
      throw BusinessException.unauthorized(ErrorCode.ADMIN_CONFIRM_PASSWORD_INVALID, '二次确认密码错误');
    }

    return true;
  }
}
