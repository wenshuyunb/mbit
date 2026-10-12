/**
 * AdminConfigController 路由契约测试
 *
 * 配置写接口是全站风险最高的写操作之一（一个误改就能让支付、AI、合规文案全线异常），
 * 因此除了权限点，还必须钉住三件事：
 *   1. 类上标的是 `@Public()`（跳过用户端守卫）而**不是** `@AdminPublic()`（那会变成匿名可写）；
 *   2. 守卫链完整（AdminAuthGuard → RolesGuard → ConfirmPasswordGuard）；
 *   3. PUT 标了 `@SensitiveOperation()` 且显式返回 200（契约要求，NestJS 默认不是 200 的场景极易踩坑）。
 */

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { ADMIN_PUBLIC_KEY } from '../decorators/admin-public.decorator';
import { SENSITIVE_OPERATION_KEY } from '../decorators/sensitive-operation.decorator';
import { PERMISSIONS_KEY } from '../rbac/decorators/require-permission.decorator';
import { AdminConfigController } from './admin-config.controller';

const meta = (method: keyof AdminConfigController, key: string): unknown =>
  Reflect.getMetadata(key, AdminConfigController.prototype[method]);

describe('AdminConfigController 路由契约（API_DESIGN §3.14.9.1 / §3.14.9.2）', () => {
  it('控制器基础路径为 admin/configs', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminConfigController)).toBe('admin/configs');
  });

  it('查询：GET /admin/configs', () => {
    expect(meta('list', PATH_METADATA)).toBe('/');
    expect(meta('list', METHOD_METADATA)).toBe(RequestMethod.GET);
  });

  it('更新：PUT /admin/configs，且显式返回 200', () => {
    expect(meta('update', PATH_METADATA)).toBe('/');
    expect(meta('update', METHOD_METADATA)).toBe(RequestMethod.PUT);
    expect(meta('update', HTTP_CODE_METADATA)).toBe(200);
  });

  it('权限点分别为 system:config:read / system:config:write', () => {
    expect(meta('list', PERMISSIONS_KEY)).toEqual(['system:config:read']);
    expect(meta('update', PERMISSIONS_KEY)).toEqual(['system:config:write']);
  });

  it('【关键】只有 PUT 标敏感操作，GET 不标（避免读接口也要求二次确认密码）', () => {
    expect(meta('update', SENSITIVE_OPERATION_KEY)).toBe(true);
    expect(meta('list', SENSITIVE_OPERATION_KEY)).toBeUndefined();
  });

  it('【关键】类上必须是 @Public() 而不能是 @AdminPublic()', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AdminConfigController)).toBe(true);
    expect(Reflect.getMetadata(ADMIN_PUBLIC_KEY, AdminConfigController)).toBeUndefined();
  });

  it('守卫链完整：AdminAuthGuard / RolesGuard / ConfirmPasswordGuard', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, AdminConfigController) ?? []) as Array<{ name: string }>;
    expect(guards.map((guard) => guard.name)).toEqual(['AdminAuthGuard', 'RolesGuard', 'ConfirmPasswordGuard']);
  });

  it('只暴露两个接口（新增接口必须同步更新本测试与文档）', () => {
    const names = Object.getOwnPropertyNames(AdminConfigController.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        typeof AdminConfigController.prototype[name as keyof AdminConfigController] === 'function',
    );

    expect(names.sort()).toEqual(['list', 'update']);
  });
});
