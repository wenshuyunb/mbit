/**
 * 角色控制器路由契约测试（`docs/API_DESIGN.md` §3.14.9.7 / §3.14.9.8）
 *
 * 为什么必须测路由元数据：`PATCH /admin/roles/{id}` 是**能改全站权限映射**的接口。
 * 服务层测得再全，只要有人顺手在控制器上加了 `@AdminPublic()`（把接口变成匿名可访问）、
 * 摘掉 `@SensitiveOperation()`（不再要求二次确认密码）、或换错权限点，
 * 服务层测试会全绿而线上已经敞开。
 *
 * 断言的是**元数据**而不是发起真实请求：单元测试里没有 Nest 运行时，
 * 元数据正是「守卫链实际会读到的东西」（`RolesGuard` 读 `PERMISSIONS_KEY`、
 * `ConfirmPasswordGuard` 读 `SENSITIVE_OPERATION_KEY`、`AdminAuthGuard` 读 `ADMIN_PUBLIC_KEY`）。
 */

import { HttpStatus, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ADMIN_PUBLIC_KEY } from '../decorators/admin-public.decorator';
import { SENSITIVE_OPERATION_KEY } from '../decorators/sensitive-operation.decorator';
import { PERMISSIONS_KEY } from '../rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../rbac/guards/confirm-password.guard';
import { RolesGuard } from '../rbac/guards/roles.guard';
import { AdminRoleController } from './admin-role.controller';

type HandlerName = 'listRoles' | 'updateRole';

const handlerOf = (method: HandlerName): object => AdminRoleController.prototype[method];

const metadataOf = (key: string, method: HandlerName): unknown => Reflect.getMetadata(key, handlerOf(method));

/**
 * 限流元数据的键名
 *
 * `@nestjs/throttler` v6 把配置写成 `` `THROTTLER:LIMIT${名字}` ``（本应用注册的
 * 具名限流器就是 `global`，见 `app.module.ts`）。这里直接拼键名，而不是从
 * `@nestjs/throttler/dist/throttler.constants` 深层导入 —— 深层导入会依赖包的
 * 内部目录结构，升级时容易碎。
 */
const throttleLimitOf = (method: HandlerName): unknown => metadataOf('THROTTLER:LIMITglobal', method);
const throttleTtlOf = (method: HandlerName): unknown => metadataOf('THROTTLER:TTLglobal', method);

describe('AdminRoleController 路由契约（API_DESIGN §3.14.9.7 / §3.14.9.8）', () => {
  // ==========================================================================
  // 路由
  // ==========================================================================

  it('控制器基础路径为 admin/roles', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminRoleController)).toBe('admin/roles');
  });

  it('角色列表：GET /admin/roles', () => {
    // Nest 会把无参 `@Get()` 归一化为 `'/'`（与 `report.controller.spec.ts` 的既有断言一致），
    // 因此这里断言 `'/'` 而不是空串
    expect(metadataOf(PATH_METADATA, 'listRoles')).toBe('/');
    expect(metadataOf(METHOD_METADATA, 'listRoles')).toBe(RequestMethod.GET);
  });

  it('修改角色：PATCH /admin/roles/:id', () => {
    expect(metadataOf(PATH_METADATA, 'updateRole')).toBe(':id');
    expect(metadataOf(METHOD_METADATA, 'updateRole')).toBe(RequestMethod.PATCH);
  });

  it('恰好两个路由（新增/删减路由必须同步更新本测试与文档）', () => {
    const prototype = AdminRoleController.prototype;
    const handlerNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && typeof prototype[name as keyof AdminRoleController] === 'function',
    );

    expect(handlerNames.sort()).toEqual(['listRoles', 'updateRole']);
  });

  // ==========================================================================
  // 成功码
  // ==========================================================================

  it('【关键】PATCH 成功码显式为 200（契约要求；防止日后被改成 POST 时默认 201）', () => {
    expect(metadataOf(HTTP_CODE_METADATA, 'updateRole')).toBe(HttpStatus.OK);
  });

  it('GET 未显式声明状态码，框架默认即 200', () => {
    expect(metadataOf(HTTP_CODE_METADATA, 'listRoles') ?? HttpStatus.OK).toBe(HttpStatus.OK);
  });

  // ==========================================================================
  // 鉴权标记
  // ==========================================================================

  it('【关键】类上必须标 @Public()（跳过用户端全局守卫），但不得标 @AdminPublic()', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AdminRoleController)).toBe(true);
    // @AdminPublic() 会让 AdminAuthGuard 直接放行 → 接口彻底公开
    expect(Reflect.getMetadata(ADMIN_PUBLIC_KEY, AdminRoleController)).toBeUndefined();
  });

  it('【关键】两个路由都不得贴 @AdminPublic()', () => {
    expect(metadataOf(ADMIN_PUBLIC_KEY, 'listRoles')).toBeUndefined();
    expect(metadataOf(ADMIN_PUBLIC_KEY, 'updateRole')).toBeUndefined();
  });

  it('【关键】守卫链必须是 AdminAuthGuard → RolesGuard → ConfirmPasswordGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminRoleController) as unknown[];

    expect(guards).toEqual([AdminAuthGuard, RolesGuard, ConfirmPasswordGuard]);
  });

  // ==========================================================================
  // 权限门
  // ==========================================================================

  it('权限点：GET 需 system:role:read', () => {
    expect(metadataOf(PERMISSIONS_KEY, 'listRoles')).toEqual(['system:role:read']);
  });

  it('权限点：PATCH 需 system:role:write', () => {
    expect(metadataOf(PERMISSIONS_KEY, 'updateRole')).toEqual(['system:role:write']);
  });

  // ==========================================================================
  // 二次确认密码
  // ==========================================================================

  it('【关键】PATCH 必须标 @SensitiveOperation()（由 ConfirmPasswordGuard 校验 X-Confirm-Password）', () => {
    expect(metadataOf(SENSITIVE_OPERATION_KEY, 'updateRole')).toBe(true);
  });

  it('GET 不标 @SensitiveOperation()（只读接口不该要求二次确认密码）', () => {
    expect(metadataOf(SENSITIVE_OPERATION_KEY, 'listRoles')).toBeUndefined();
  });

  // ==========================================================================
  // 限流
  // ==========================================================================

  it('限流：GET 为 300 次/60s（契约 §3.14.9.7）', () => {
    expect(throttleLimitOf('listRoles')).toBe(300);
    expect(throttleTtlOf('listRoles')).toBe(60_000);
  });

  it('限流：PATCH 为 10 次/60min（契约 §3.14.9.8，CRITICAL 级操作）', () => {
    expect(throttleLimitOf('updateRole')).toBe(10);
    expect(throttleTtlOf('updateRole')).toBe(3_600_000);
  });
});
