/**
 * 角色管理 DTO（契约 §3.14.9.8）
 *
 * 请求体里**不需要**出现 `X-Confirm-Password`：它必须放在请求头，由
 * `ConfirmPasswordGuard` 校验（契约 §3.14.9.8 的显式警告）。原因不只是风格问题：
 * `main.ts` 的 ValidationPipe 开启了 `forbidNonWhitelisted`，把密码写进 body
 * 会被判为未声明字段而直接 `10001`；更重要的是密码出现在请求体里就会进入
 * 访问日志、错误上报与审计 diff —— 请求头在这些环节通常被过滤。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, Length, MaxLength } from 'class-validator';

import { ALL_ADMIN_PERMISSIONS } from '../../rbac/admin-permission.constants';

export class AdminRoleUpdateDto {
  /**
   * 覆盖语义的最终权限集合
   *
   * 刻意**不做** `@ArrayUnique`：契约明确「去重后 0–24 个」，即去重由服务端完成，
   * 重复项应被静默合并而不是报错（前端多选控件在极端情况下重复提交同一权限点时，
   * 报错会让管理员看到无意义的失败）。
   * 上限校验也不在这里做：`ArrayMaxSize` 的报错文案无法说明是「权限点数量」超限，
   * 服务端统一按 `10001` 返回带明细的中文提示。
   */
  @ApiProperty({
    description: '权限点集合（**覆盖语义**：传入的集合即最终权限，传 `[]` 表示清空该角色全部权限；重复项会被自动去重）',
    type: [String],
    example: [
      'user:user:read',
      'user:user:write',
      'user:deletion:read',
      'test:question:read',
      'test:definition:read',
      'payment:order:read',
      'relationship:relationship:read',
      'report:report:read',
      'system:audit:read',
    ],
    maxItems: ALL_ADMIN_PERMISSIONS.length,
  })
  @IsArray({ message: 'permissions 必须是数组' })
  @IsString({ each: true, message: 'permissions 的每一项都必须是字符串权限点' })
  permissions!: string[];

  /** 角色名称（仅自定义角色可改，服务端校验） */
  @ApiPropertyOptional({
    description: '角色名称（2–32 字符，**仅自定义角色可修改**；内置角色改名为 `10001`）',
    example: '客服运营',
    minLength: 2,
    maxLength: 32,
  })
  @IsOptional()
  @IsString({ message: 'roleName 必须是字符串' })
  @Length(2, 32, { message: 'roleName 长度需在 2–32 之间' })
  roleName?: string;

  /** 角色描述 */
  @ApiPropertyOptional({
    description: '角色描述（0–200 字符，可传空串清空描述）',
    example: '用户与内容只读 + 客服操作（封禁/解封）+ 审计日志查询',
    maxLength: 200,
  })
  @IsOptional()
  @IsString({ message: 'description 必须是字符串' })
  @MaxLength(200, { message: 'description 长度不能超过 200' })
  description?: string;

  /**
   * 变更原因
   *
   * 必填而非可选：角色权限变更属 CRITICAL 级操作，审计里只有「谁改了什么」而
   * 没有「为什么改」，事后复盘时无法区分「正常调整」与「越权提权」。
   */
  @ApiProperty({
    description: '变更原因（5–200 字符，必填，写入 admin_audit_logs.reason）',
    example: '客服团队需要查看自身操作审计记录以自查合规',
    minLength: 5,
    maxLength: 200,
  })
  @IsString({ message: 'reason 必须是字符串' })
  @Length(5, 200, { message: 'reason 长度需在 5–200 之间' })
  reason!: string;
}
