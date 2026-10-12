/**
 * 管理员账号管理 DTO（契约 §3.14.9.4 / §3.14.9.5 / §3.14.9.6）
 *
 * ## 为什么响应体也用 class 而不是 interface
 *
 * 三个接口的响应字段多且嵌套（`operationStats7d` / `initialPassword` / `createdBy`），
 * 用带 `@ApiProperty` 的 class 才能让 Swagger 输出完整结构，
 * 前端据此生成类型时不必再对照文档手抄一遍（抄错一个字段名就是一次线上排查）。
 *
 * ## 与契约的已知差异（均为**收窄**，不是放宽）
 *
 * · `username`：契约写 3–64 字符，但 `admin_users.username` 是 `varchar(48)`。
 *   这里按 48 校验 —— 否则 49–64 字符的请求会通过校验再被数据库拒绝，表现为 500。
 * · 错误码：契约的 `10012`（用户名已存在）在本仓库不存在，改用 `10003`；
 *   契约的 `10016`（参数不合法）在本仓库不存在，统一为全局的 `10001`。
 *   详见各字段注释与交付报告。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import { PaginatedDataDto, PaginationQueryDto } from '../../../../common/dto/api-response.dto';
import { ADMIN_PASSWORD_PATTERN, IP_OR_CIDR_PATTERN } from '../admin-user.util';

/**
 * 登录名格式：邮箱形态（契约 §3.14.9.5 明确「邮箱格式」）
 *
 * 刻意保持宽松（本地部分只挡空白与 `@`）：管理端登录名是内部约定，
 * 过严的 RFC 5322 子集会把 `admin+ops@soulmap.cn`、`ops_it@soulmap.cn` 这类
 * 完全可用的工号/别名邮箱挡在门外。
 */
const USERNAME_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 角色码格式：大写字母开头的 `UPPER_SNAKE_CASE`（与 `roles.code` 的取值约定一致） */
const ROLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,47}$/;

/** 单次创建/查询允许的角色码数量上限（契约：创建时 1–3 个） */
const MAX_ROLE_CODES_PER_ADMIN = 3;

// ============================================================================
// 请求：列表查询（§3.14.9.4）
// ============================================================================

export class AdminUserListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '状态筛选，逗号分隔：`ACTIVE` / `DISABLED` / `LOCKED`',
    example: 'ACTIVE,LOCKED',
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'status 必须是字符串' })
  @MaxLength(64, { message: 'status 长度不能超过 64' })
  status?: string;

  @ApiPropertyOptional({
    description: '角色码筛选，逗号分隔（按 `admin_user_roles` 关联过滤，含已过期的临时授予不计入）',
    example: 'ANALYST,FINANCE',
    maxLength: 256,
  })
  @IsOptional()
  @IsString({ message: 'roleCode 必须是字符串' })
  @MaxLength(256, { message: 'roleCode 长度不能超过 256' })
  roleCode?: string;

  @ApiPropertyOptional({
    description: '关键词，匹配 `username` / `nickname`（大小写不敏感，包含匹配）',
    example: 'soulmap.cn',
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(64, { message: 'keyword 长度不能超过 64' })
  keyword?: string;
}

// ============================================================================
// 请求：新建管理员（§3.14.9.5）
// ============================================================================

export class CreateAdminUserDto {
  @ApiProperty({
    description: '登录名（邮箱格式，全局唯一）。⚠️ 上限 48 而非契约写的 64：`admin_users.username` 列为 `varchar(48)`',
    example: 'analyst@soulmap.cn',
    minLength: 3,
    maxLength: 48,
  })
  @IsString({ message: 'username 必须是字符串' })
  @Length(3, 48, { message: 'username 长度需在 3–48 之间' })
  @Matches(USERNAME_PATTERN, { message: 'username 需为邮箱格式' })
  username!: string;

  @ApiProperty({
    description: '显示名（落库到 `admin_users.nickname`），用于审计与操作记录展示',
    example: '数据分析师',
    minLength: 2,
    maxLength: 32,
  })
  @IsString({ message: 'displayName 必须是字符串' })
  @Length(2, 32, { message: 'displayName 长度需在 2–32 之间' })
  displayName!: string;

  @ApiProperty({
    description: '角色码数组（1–3 个，必须存在于 `roles` 表；🚫 不允许 `SUPER_ADMIN`）',
    example: ['ANALYST'],
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
    maxItems: MAX_ROLE_CODES_PER_ADMIN,
  })
  @IsArray({ message: 'roleCodes 必须是数组' })
  @ArrayMinSize(1, { message: 'roleCodes 至少需要 1 个角色' })
  @ArrayMaxSize(MAX_ROLE_CODES_PER_ADMIN, { message: `roleCodes 最多 ${MAX_ROLE_CODES_PER_ADMIN} 个角色` })
  @ArrayUnique({ message: 'roleCodes 不能包含重复角色码' })
  @IsString({ each: true, message: 'roleCodes 每一项都必须是字符串' })
  @Matches(ROLE_CODE_PATTERN, { each: true, message: 'roleCodes 含非法角色码格式' })
  roleCodes!: string[];

  @ApiPropertyOptional({
    description: '初始密码（12–64 位，需含大小写字母 + 数字 + 符号）。不传则由服务端生成一次性强密码',
    example: 'Sm#2026-Aq7Kd9Lp',
    minLength: 12,
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'initialPassword 必须是字符串' })
  @Length(12, 64, { message: 'initialPassword 长度需在 12–64 之间' })
  @Matches(ADMIN_PASSWORD_PATTERN, { message: 'initialPassword 需同时包含大写字母、小写字母、数字与符号' })
  initialPassword?: string;

  @ApiPropertyOptional({
    description: '首次登录是否强制改密，默认 `true`（**强烈建议保持默认**）',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'mustChangePassword 必须是布尔值' })
  mustChangePassword?: boolean;

  @ApiPropertyOptional({
    description: '备注（岗位职责等）',
    example: '负责 AI 用量与成本分析，仅只读权限',
    maxLength: 200,
  })
  @IsOptional()
  @IsString({ message: 'remark 必须是字符串' })
  @MaxLength(200, { message: 'remark 长度不能超过 200' })
  remark?: string;

  @ApiPropertyOptional({
    description: '登录 IP 白名单（≤ 10 个 IP/CIDR）。⚠️ 当前仅落库留痕，登录链路尚未强制执行',
    example: ['203.0.113.0/24'],
    type: 'array',
    items: { type: 'string' },
    maxItems: 10,
  })
  @IsOptional()
  @IsArray({ message: 'ipWhitelist 必须是数组' })
  @ArrayMaxSize(10, { message: 'ipWhitelist 最多 10 个 IP/CIDR' })
  @ArrayUnique({ message: 'ipWhitelist 不能包含重复项' })
  @IsString({ each: true, message: 'ipWhitelist 每一项都必须是字符串' })
  @Matches(IP_OR_CIDR_PATTERN, { each: true, message: 'ipWhitelist 含非法的 IP/CIDR' })
  ipWhitelist?: string[];
}

// ============================================================================
// 请求：重置管理员密码（§3.14.9.6）
// ============================================================================

export class ResetAdminPasswordDto {
  @ApiProperty({
    description: '重置原因（必填，5–200 字符，写入审计 `reason`）',
    example: '该账号疑似密码泄露，客服工单 TK-20260214-0091 申请重置',
    minLength: 5,
    maxLength: 200,
  })
  @IsString({ message: 'reason 必须是字符串' })
  @Length(5, 200, { message: 'reason 长度需在 5–200 之间' })
  reason!: string;

  @ApiPropertyOptional({
    description: '是否撤销该管理员全部登录会话，默认 `true`（重置密码的语义是「旧凭证全部作废」）',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'revokeSessions 必须是布尔值' })
  revokeSessions?: boolean;

  @ApiPropertyOptional({
    description: '是否强制下次登录修改，默认 `true`',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'mustChangePassword 必须是布尔值' })
  mustChangePassword?: boolean;
}

// ============================================================================
// 响应：公共片段
// ============================================================================

export class AdminRoleBriefDto {
  @ApiProperty({ description: '角色码', example: 'ANALYST' })
  roleCode!: string;

  @ApiProperty({ description: '角色名称', example: '数据分析' })
  roleName!: string;
}

export class AdminOperatorRefDto {
  @ApiProperty({ description: '操作者管理员 ID', example: '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a' })
  adminId!: string;

  @ApiProperty({ description: '操作者显示名', example: '超级管理员' })
  displayName!: string;
}

export class AdminOperationStatsDto {
  @ApiProperty({ description: '近 7 天审计总条数', example: 142 })
  totalActions!: number;

  @ApiProperty({ description: '近 7 天 CRITICAL 级操作数', example: 10 })
  criticalActions!: number;

  @ApiProperty({
    description:
      '近 7 天读操作数。⚠️ `AdminAuditAction` 枚举没有 `READ`，读接口无法入账，' +
      '该值由「总数 − 写类 − 登录类」反推，属**近似值**（少数非写非登录动作如 `EXPORT` 也会落进差额）',
    example: 0,
  })
  readActions!: number;

  @ApiProperty({
    description: '近 7 天写操作数（CREATE/UPDATE/DELETE/REFUND/CONFIG_CHANGE 等；⚠️ `EXPORT` 按契约不计入写类）',
    example: 46,
  })
  writeActions!: number;
}

export class AdminInitialPasswordDto {
  @ApiProperty({ description: '是否为服务端生成（`false` 表示调用方指定了 `initialPassword`）', example: true })
  generated!: boolean;

  @ApiProperty({
    description: '一次性明文密码，**仅在本响应中出现一次**，服务端只存 Argon2id 哈希',
    example: 'Sm#2026-Aq7Kd9Lp',
  })
  password!: string;

  @ApiProperty({ description: '交付提示语', example: '⚠️ 该密码仅在此响应中返回一次，请立即通过安全渠道交付本人。' })
  note!: string;

  @ApiProperty({
    description:
      '密码有效期（小时）。⚠️ `admin_users` 无「密码过期时间」列，' +
      '「24 小时内未登录即失效」目前**未强制执行**（登录链路不在本次范围）',
    example: 24,
  })
  expiresInHours!: number;
}

// ============================================================================
// 响应：列表（§3.14.9.4）
// ============================================================================

export class AdminUserListItemDto {
  @ApiProperty({ description: '管理员 ID', example: '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a' })
  adminId!: string;

  @ApiProperty({ description: '登录名', example: 'admin@soulmap.cn' })
  username!: string;

  @ApiProperty({ description: '显示名（`nickname`，缺失时回退 `username`）', example: '超级管理员' })
  displayName!: string;

  @ApiProperty({ description: '账号状态', example: 'ACTIVE', enum: ['ACTIVE', 'DISABLED', 'LOCKED'] })
  status!: string;

  @ApiProperty({ description: '角色明细', type: () => AdminRoleBriefDto, isArray: true })
  roles!: AdminRoleBriefDto[];

  @ApiProperty({
    description: '权限点数量（持通配符 `*` 时计为系统全部权限点数）',
    example: 24,
  })
  permissionCount!: number;

  @ApiProperty({ description: '最近登录时间', example: '2026-02-14T19:00:00.000Z', nullable: true })
  lastLoginAt!: string | null;

  @ApiProperty({ description: '最近登录 IP', example: '203.0.113.42', nullable: true })
  lastLoginIp!: string | null;

  @ApiProperty({ description: '近 30 天成功登录次数（按审计表 `LOGIN` + `success` 统计）', example: 42 })
  loginCount30d!: number;

  @ApiProperty({ description: '密码最近修改时间', example: '2026-01-05T08:20:00.000Z', nullable: true })
  passwordUpdatedAt!: string | null;

  @ApiProperty({ description: '是否要求下次登录改密', example: false })
  mustChangePassword!: boolean;

  @ApiProperty({
    description: '是否处于锁定状态（`status = LOCKED` 或 `lockedUntil` 尚未到期）',
    example: false,
  })
  isLocked!: boolean;

  @ApiProperty({
    description: '锁定截止时间；未锁定时为 `null`',
    example: '2026-02-14T22:20:00.000Z',
    nullable: true,
  })
  lockedUntil!: string | null;

  @ApiProperty({ description: '连续登录失败次数', example: 0 })
  failedLoginCount!: number;

  @ApiProperty({ description: '账号创建时间', example: '2026-01-01T00:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    description:
      '创建者用户名（取自该管理员的 `CREATE` 审计记录）；种子/超管账号为 `SYSTEM_SEED`，' + '无法归因时为 `null`',
    example: 'SYSTEM_SEED',
    nullable: true,
  })
  createdBy!: string | null;

  @ApiProperty({ description: '近 7 天操作统计', type: () => AdminOperationStatsDto })
  operationStats7d!: AdminOperationStatsDto;
}

export class AdminUserListSummaryDto {
  @ApiProperty({ description: '当前筛选条件下的管理员总数', example: 4 })
  totalAdmins!: number;

  @ApiProperty({ description: '启用中数量（`status = ACTIVE`）', example: 3 })
  activeCount!: number;

  @ApiProperty({
    description:
      '锁定数量（`status = LOCKED`）。⚠️ `ACTIVE` 但 `lockedUntil` 未到期的账号也计为锁定，与 `isLocked` 同口径',
    example: 1,
  })
  lockedCount!: number;

  @ApiProperty({ description: '已禁用数量（`status = DISABLED`）', example: 0 })
  disabledCount!: number;

  @ApiProperty({
    description: '各角色人数（覆盖全部内置角色码，缺失补 0；一个管理员持多个角色时在每个角色下都计入）',
    example: { SUPER_ADMIN: 1, OPERATOR: 1, CONTENT_EDITOR: 1, FINANCE: 1, ANALYST: 0 },
  })
  byRole!: Record<string, number>;
}

export class AdminUserListDto extends PaginatedDataDto<AdminUserListItemDto> {
  @ApiProperty({
    description: '当前页管理员列表（**不含** `passwordHash`）',
    type: () => AdminUserListItemDto,
    isArray: true,
  })
  override items: AdminUserListItemDto[] = [];

  @ApiProperty({
    description: '统计摘要，基于**当前筛选条件**（不受分页影响）',
    type: () => AdminUserListSummaryDto,
  })
  summary!: AdminUserListSummaryDto;
}

// ============================================================================
// 响应：新建管理员（§3.14.9.5）
// ============================================================================

export class AdminCreateResultDto {
  @ApiProperty({ description: '新管理员 ID', example: '0195f3a2-0ad0-7c0e-8d79-f5ca2d3e4b20' })
  adminId!: string;

  @ApiProperty({ description: '登录名', example: 'analyst@soulmap.cn' })
  username!: string;

  @ApiProperty({ description: '显示名', example: '数据分析师' })
  displayName!: string;

  @ApiProperty({ description: '账号状态（新建恒为 `ACTIVE`）', example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ description: '角色明细', type: () => AdminRoleBriefDto, isArray: true })
  roles!: AdminRoleBriefDto[];

  @ApiProperty({
    description: '权限并集（扁平化权限点，`*` 表示全部权限；用于复核是否符合最小权限原则）',
    example: ['ai:stats:read', 'ai:calllog:read', 'dashboard:metrics:read'],
    type: 'array',
    items: { type: 'string' },
  })
  permissions!: string[];

  @ApiProperty({ description: '权限点数量', example: 3 })
  permissionCount!: number;

  @ApiProperty({ description: '是否要求首次登录改密', example: true })
  mustChangePassword!: boolean;

  @ApiProperty({
    description:
      'IP 白名单回显。⚠️ 数据模型无该列，实际存储在 `system_configs`（key = `admin.ipWhitelist.{adminId}`），登录链路尚未强制校验',
    example: ['203.0.113.0/24'],
    type: 'array',
    items: { type: 'string' },
  })
  ipWhitelist!: string[];

  @ApiProperty({ description: '备注', example: '负责 AI 用量与成本分析', nullable: true })
  remark!: string | null;

  @ApiProperty({ description: '一次性初始密码（仅此一次返回）', type: () => AdminInitialPasswordDto })
  initialPassword!: AdminInitialPasswordDto;

  @ApiProperty({ description: '创建时间', example: '2026-02-14T22:15:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: '创建者', type: () => AdminOperatorRefDto })
  createdBy!: AdminOperatorRefDto;

  @ApiProperty({
    description: '审计日志 ID。⚠️ 恒为 `null`：`AdminAuditService.log` 只回传 `boolean` 且本次不允许修改该服务',
    example: null,
    nullable: true,
  })
  auditLogId!: string | null;
}

// ============================================================================
// 响应：重置管理员密码（§3.14.9.6）
// ============================================================================

export class AdminPasswordResetResultDto {
  @ApiProperty({ description: '目标管理员 ID', example: '0195f3a2-09cf-7bfd-9c68-e4bf1c2d3a1f' })
  adminId!: string;

  @ApiProperty({ description: '目标管理员登录名', example: 'finance@soulmap.cn' })
  username!: string;

  @ApiProperty({ description: '目标管理员显示名', example: '财务专员' })
  displayName!: string;

  @ApiProperty({ description: '重置原因（原样回显，便于前端展示操作回执）', example: '该账号疑似密码泄露' })
  reason!: string;

  @ApiProperty({ description: '是否强制下次登录改密', example: true })
  mustChangePassword!: boolean;

  @ApiProperty({ description: '被撤销的会话数量', example: 2 })
  revokedSessions!: number;

  @ApiProperty({ description: '本次是否解除了锁定（重置前处于锁定态则为 `true`）', example: true })
  unlocked!: boolean;

  @ApiProperty({ description: '重置前的连续失败次数（用于解释「为什么之前登不上」）', example: 5 })
  previousFailedLoginCount!: number;

  @ApiProperty({ description: '一次性新密码（仅此一次返回）', type: () => AdminInitialPasswordDto })
  newPassword!: AdminInitialPasswordDto;

  @ApiProperty({ description: '密码更新时间', example: '2026-02-14T22:20:00.000Z' })
  passwordUpdatedAt!: string;

  @ApiProperty({ description: '执行重置的操作者', type: () => AdminOperatorRefDto })
  resetBy!: AdminOperatorRefDto;

  @ApiProperty({
    description: '审计日志 ID。⚠️ 恒为 `null`（同创建接口，`AdminAuditService.log` 不回传 id）',
    example: null,
    nullable: true,
  })
  auditLogId!: string | null;
}
