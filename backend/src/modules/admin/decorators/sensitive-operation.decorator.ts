/**
 * `@SensitiveOperation()` — 标记敏感写操作，要求二次确认密码
 *
 * 契约 §3.14「核心契约」第 3 条：退款、封禁、发布 Prompt、修改配置等敏感写操作
 * 需请求头 `X-Confirm-Password`（操作者本人密码），缺失返回 `20017`，
 * 密码错误返回 `20018`。
 *
 * ## 为什么用「标记 + 守卫」而不是「每个接口自己校验」
 *
 * 敏感操作是**漏一个就出事**的那类需求：把校验写在业务方法里，新增接口时忘记写
 * 不会有任何提示。改成「守卫常驻 + 标记启用」后，遗漏的表现是**接口不可用**
 * （没标记就没人校验，但也没人会忘记标记，因为不标记就等于没保护 —— 而
 * `ConfirmPasswordGuard` 会把它当作普通接口放行，这仍需要 code review 兜住）。
 *
 * 因此本装饰器应与 `@RequirePermission` 一起写在敏感接口上，两者的组合是：
 *   · `@RequirePermission('payment:order:refund')` — 你有没有这个权限
 *   · `@SensitiveOperation()`                     — 是不是你本人在操作
 */

import { SetMetadata } from '@nestjs/common';

export const SENSITIVE_OPERATION_KEY = 'soulmap:sensitive-operation';

/** 请求头名称（契约 §3.14 核心契约第 3 条） */
export const CONFIRM_PASSWORD_HEADER = 'x-confirm-password';

export const SensitiveOperation = (): MethodDecorator & ClassDecorator => SetMetadata(SENSITIVE_OPERATION_KEY, true);
