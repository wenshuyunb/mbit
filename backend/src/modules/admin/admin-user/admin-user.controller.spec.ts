/**
 * 管理员账号控制器路由契约测试
 *
 * 为什么单测路由元数据：本控制器是**权限提升的入口** —— 它能创建管理员、能重置他人密码。
 * 服务层的护栏测得再全，若某天有人在类上误加 `@AdminPublic()`（匿名）、
 * 漏掉 `@SensitiveOperation()`（免二次确认），或把 `@HttpCode` 改回默认 201，
 * 上述缺陷都不会被服务层测试发现，而线上已经是敞开的。
 */

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ADMIN_PUBLIC_KEY } from '../decorators/admin-public.decorator';
import { SENSITIVE_OPERATION_KEY } from '../decorators/sensitive-operation.decorator';
import { PERMISSIONS_KEY } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminUserController } from './admin-user.controller';

/** 三个契约接口的处理方法名（新增路由必须同步更新本文件与文档） */
type HandlerName = 'list' | 'create' | 'resetPassword';

const handler = (method: HandlerName): object => AdminUserController.prototype[method];

const pathOf = (method: HandlerName): unknown => Reflect.getMetadata(PATH_METADATA, handler(method));

const httpMethodOf = (method: HandlerName): unknown => Reflect.getMetadata(METHOD_METADATA, handler(method));

const httpCodeOf = (method: HandlerName): unknown => Reflect.getMetadata(HTTP_CODE_METADATA, handler(method));

const permissionsOf = (method: HandlerName): unknown => Reflect.getMetadata(PERMISSIONS_KEY, handler(method));

const sensitiveOf = (method: HandlerName): unknown => Reflect.getMetadata(SENSITIVE_OPERATION_KEY, handler(method));

describe('AdminUserController 路由契约（API_DESIGN §3.14.9.4–3.14.9.6）', () => {
  // ==========================================================================
  // 路由形态
  // ==========================================================================

  it('控制器基础路径为 admin/admins', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminUserController)).toBe('admin/admins');
  });

  it('管理员列表：GET /admin/admins', () => {
    expect(pathOf('list')).toBe('/');
    expect(httpMethodOf('list')).toBe(RequestMethod.GET);
  });

  it('新建管理员：POST /admin/admins', () => {
    expect(pathOf('create')).toBe('/');
    expect(httpMethodOf('create')).toBe(RequestMethod.POST);
  });

  it('重置管理员密码：POST /admin/admins/:id/reset-password', () => {
    expect(pathOf('resetPassword')).toBe(':id/reset-password');
    expect(httpMethodOf('resetPassword')).toBe(RequestMethod.POST);
  });

  it('【契约】新建管理员成功码为 201', () => {
    expect(httpCodeOf('create')).toBe(201);
  });

  it('【契约】重置密码成功码必须显式覆盖为 200（NestJS 的 @Post() 默认是 201）', () => {
    expect(httpCodeOf('resetPassword')).toBe(200);
  });

  it('列表接口未覆盖状态码（保持 GET 默认的 200）', () => {
    expect(httpCodeOf('list')).toBeUndefined();
  });

  // ==========================================================================
  // 鉴权与守卫链
  // ==========================================================================

  it('【关键】类上必须标 @Public()（用于跳过用户端全局守卫）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AdminUserController)).toBe(true);
  });

  it('【关键】绝不允许 @AdminPublic() —— 那会让「能创建管理员」的接口变成匿名可访问', () => {
    expect(Reflect.getMetadata(ADMIN_PUBLIC_KEY, AdminUserController)).toBeUndefined();
    for (const method of ['list', 'create', 'resetPassword'] as const) {
      expect(Reflect.getMetadata(ADMIN_PUBLIC_KEY, handler(method))).toBeUndefined();
    }
  });

  it('守卫链固定为 AdminAuthGuard + RolesGuard + ConfirmPasswordGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminUserController) as unknown[];

    expect(guards).toEqual([AdminAuthGuard, RolesGuard, ConfirmPasswordGuard]);
  });

  it('ConfirmPasswordGuard 必须排在 AdminAuthGuard 之后（它依赖已认证的 principal）', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminUserController) as unknown[];

    expect(guards.indexOf(AdminAuthGuard)).toBeLessThan(guards.indexOf(ConfirmPasswordGuard));
  });

  // ==========================================================================
  // 权限点与二次确认密码
  // ==========================================================================

  it('列表需要 system:admin:read', () => {
    expect(permissionsOf('list')).toEqual(['system:admin:read']);
  });

  it('新建管理员需要 system:admin:write', () => {
    expect(permissionsOf('create')).toEqual(['system:admin:write']);
  });

  it('重置密码需要 system:admin:write', () => {
    expect(permissionsOf('resetPassword')).toEqual(['system:admin:write']);
  });

  it('【关键】两个写接口必须标 @SensitiveOperation()（二次确认密码）', () => {
    expect(sensitiveOf('create')).toBe(true);
    expect(sensitiveOf('resetPassword')).toBe(true);
  });

  it('【关键】GET 列表不得标 @SensitiveOperation()（否则每次列表都要输密码）', () => {
    expect(sensitiveOf('list')).toBeUndefined();
  });

  it('已实现的路由恰好三个（新增路由必须同步更新本测试与文档）', () => {
    const prototype = AdminUserController.prototype;
    const routeHandlers = Object.getOwnPropertyNames(prototype).filter((name) => {
      if (name === 'constructor') return false;
      return Reflect.getMetadata(METHOD_METADATA, prototype[name as keyof AdminUserController]) !== undefined;
    });

    expect(routeHandlers.sort()).toEqual(['create', 'list', 'resetPassword']);
  });
});
