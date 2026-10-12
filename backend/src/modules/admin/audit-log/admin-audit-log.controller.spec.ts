/**
 * 审计日志控制器路由契约测试（`docs/API_DESIGN.md` §3.14.9.3）
 *
 * 为什么必须测路由元数据：审计日志里含**全量 before/after 快照**（谁把哪个用户封禁了、
 * 谁退了哪笔款）。服务层的过滤与分页测得再全，只要有人顺手在控制器上
 * 加上 `@AdminPublic()`（接口彻底公开）、摘掉 `@RequirePermission`（权限门消失）、
 * 或误标 `@SensitiveOperation()`（只读接口强行要求二次确认密码，审计页直接不可用），
 * 服务层测试都会全绿。
 *
 * 断言的是**元数据**而不是真实请求：单测里没有 Nest 运行时，而元数据正是守卫链
 * 实际读取的东西（`RolesGuard` 读 `PERMISSIONS_KEY`、`ConfirmPasswordGuard` 读
 * `SENSITIVE_OPERATION_KEY`、`AdminAuthGuard` 读 `ADMIN_PUBLIC_KEY`、
 * 全局 `JwtAuthGuard` 读 `IS_PUBLIC_KEY`）。
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
import { AdminAuditLogController } from './admin-audit-log.controller';

/**
 * Swagger 装饰器写入的元数据键
 *
 * 直接拼字符串而不深层导入 `@nestjs/swagger/dist/constants`：深层导入依赖包的
 * 内部目录结构，升级时容易碎（与 `admin-role.controller.spec.ts` 对限流键的处理一致）。
 */
const API_TAGS_KEY = 'swagger/apiUseTags';
const API_SECURITY_KEY = 'swagger/apiSecurity';

/** 限流元数据键（`@nestjs/throttler` v6 的具名限流器是 `global`） */
const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITglobal';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLglobal';

const handler = AdminAuditLogController.prototype.list;

const handlerMetadataOf = (key: string): unknown => Reflect.getMetadata(key, handler);

describe('AdminAuditLogController 路由契约（API_DESIGN §3.14.9.3）', () => {
  // ==========================================================================
  // 路由
  // ==========================================================================

  it('控制器基础路径为 admin/audit-logs（对应 GET /api/v1/admin/audit-logs）', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminAuditLogController)).toBe('admin/audit-logs');
  });

  it('查询路由：GET /admin/audit-logs', () => {
    // Nest 会把无参 `@Get()` 归一化为 `'/'`（与既有控制器测试的断言一致）
    expect(handlerMetadataOf(PATH_METADATA)).toBe('/');
    expect(handlerMetadataOf(METHOD_METADATA)).toBe(RequestMethod.GET);
  });

  it('GET 不显式声明 @HttpCode（框架默认 200，与契约一致）', () => {
    expect(handlerMetadataOf(HTTP_CODE_METADATA)).toBeUndefined();
  });

  it('恰好一个路由方法（只读接口，不得出现写/删除路由 —— 契约业务规则 1：审计仅追加）', () => {
    const prototype = AdminAuditLogController.prototype;
    const handlerNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && typeof prototype[name as keyof AdminAuditLogController] === 'function',
    );

    expect(handlerNames.sort()).toEqual(['list']);
  });

  // ==========================================================================
  // 鉴权标记
  // ==========================================================================

  it('【关键】类上必须标 @Public()（只跳过用户端全局守卫）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AdminAuditLogController)).toBe(true);
  });

  it('【关键】不得标 @AdminPublic()（那是登录/刷新专用；用在这里等于审计接口裸奔）', () => {
    expect(Reflect.getMetadata(ADMIN_PUBLIC_KEY, AdminAuditLogController)).toBeUndefined();
    expect(handlerMetadataOf(ADMIN_PUBLIC_KEY)).toBeUndefined();
  });

  it('【关键】守卫链必须是 AdminAuthGuard → RolesGuard → ConfirmPasswordGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminAuditLogController) as unknown[];

    expect(guards).toEqual([AdminAuthGuard, RolesGuard, ConfirmPasswordGuard]);
  });

  it("类上有 @ApiBearerAuth('admin-token')（Swagger 文档里标明管理端令牌）", () => {
    expect(Reflect.getMetadata(API_SECURITY_KEY, AdminAuditLogController)).toEqual([{ 'admin-token': [] }]);
  });

  it('类上有 @ApiTags（Swagger 分组）', () => {
    expect(Reflect.getMetadata(API_TAGS_KEY, AdminAuditLogController)).toEqual(['后台管理 - 审计日志']);
  });

  // ==========================================================================
  // 权限门 / 二次确认密码 / 限流
  // ==========================================================================

  it('权限点：恰为 system:audit:read（契约 §3.14.9.3）', () => {
    expect(handlerMetadataOf(PERMISSIONS_KEY)).toEqual(['system:audit:read']);
  });

  it('【关键】不标 @SensitiveOperation()（只读查询，不该要求每次翻页都输密码）', () => {
    expect(handlerMetadataOf(SENSITIVE_OPERATION_KEY)).toBeUndefined();
    expect(Reflect.getMetadata(SENSITIVE_OPERATION_KEY, AdminAuditLogController)).toBeUndefined();
  });

  it('限流：300 次/60s（契约 §3.14.9.3，adminId 维度）', () => {
    expect(handlerMetadataOf(THROTTLE_LIMIT_KEY)).toBe(300);
    expect(handlerMetadataOf(THROTTLE_TTL_KEY)).toBe(60_000);
  });
});
