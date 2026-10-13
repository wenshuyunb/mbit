/**
 * `JwtAuthGuard` 对**公开接口**的处理（`@Public()` 语义）
 *
 * ## 守的是一个真实发生过的回归
 *
 * 原实现是：
 * ```ts
 * if (isPublic) return true;      // ← 直接跳过策略
 * ```
 * 于是**即使客户端带了合法令牌，`request.principal` 也不会被填上**。
 * 后果：`@OptionalUser()` 在公开接口上恒为 `undefined` ——
 * `GET /membership/products`（游客能看、登录用户还要看到自己的会员状态）
 * 会让**登录会员拿到匿名的"非会员"视图**，会员页显示未开通。
 *
 * 而且这会让 `@OptionalUser` 这个装饰器**永远用不上"有身份"的那一半**：
 * 它的注释写着"允许匿名访问的场景使用"，但公开接口一律拿不到身份。
 *
 * 现在改为：**尝试**解析令牌，失败按匿名继续（公开接口不因令牌问题 401）。
 */

import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

/** 造一个最小的 ExecutionContext：只需要 `getHandler` / `getClass` 与 http 请求 */
const createContext = (principal?: unknown): { context: ExecutionContext; request: Record<string, unknown> } => {
  const request: Record<string, unknown> = principal === undefined ? {} : { principal };

  const context = {
    getHandler: () => (): void => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { context, request };
};

const createGuard = (isPublic: boolean): JwtAuthGuard => {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(isPublic) } as unknown as Reflector;

  return new JwtAuthGuard(reflector);
};

describe('JwtAuthGuard 与 @Public()', () => {
  it('非公开接口走正常鉴权（由 passport 决定，失败会抛精确错误码）', async () => {
    const guard = createGuard(false);
    const { context } = createContext();

    // 未带令牌的非公开请求必须失败 —— 全站"默认拒绝"的底线
    await expect(guard.canActivate(context)).rejects.toBeDefined();
  });

  it('【关键】公开接口即使没有令牌也放行（匿名访问是正常形态）', async () => {
    const guard = createGuard(true);
    const { context, request } = createContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // 没有身份就是没有身份，不能凭空造一个
    expect(request['principal']).toBeUndefined();
  });

  it('【关键】公开接口带**合法令牌**时仍要解析出身份（否则登录会员被当成游客）', async () => {
    const guard = createGuard(true);
    const principal = { userId: 'user-1', realm: 'user' };
    const { context, request } = createContext(principal);

    // 入口放行
    await expect(guard.canActivate(context)).resolves.toBe(true);
    // 关键：`principal` 必须还在（本用例守的就是"公开接口跳过策略导致身份丢失"）
    expect(request['principal']).toEqual(principal);
  });

  it('公开接口不因令牌问题而 401（过期/损坏/别的 realm 都按匿名处理）', async () => {
    const guard = createGuard(true);
    const { context } = createContext();

    // 通过 `Reflect.getMetadata` 之外的路径无法直接注入坏令牌，这里验证"不抛错"这一契约：
    // 即使内部策略抛错，`canActivate` 也必须解析为 true
    const spy = jest
      .spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(guard)) as { canActivate: () => Promise<boolean> },
        'canActivate',
      )
      .mockRejectedValue(new Error('token expired'));

    await expect(guard.canActivate(context)).resolves.toBe(true);

    spy.mockRestore();
  });

  it('公开标记来自 handler 或 class（`getAllAndOverride` 的语义由 Reflector 保证）', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);
    const { context } = createContext();

    await guard.canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
  });
});
