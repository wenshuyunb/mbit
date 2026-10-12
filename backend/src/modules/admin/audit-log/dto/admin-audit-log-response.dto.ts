/**
 * 审计日志响应体（契约 §3.14.9.3）
 *
 * ## 字段与数据模型的落差（逐条对应，避免被当成「表里就有这些列」）
 *
 * | 契约字段        | 真实来源                                                       |
 * | --------------- | -------------------------------------------------------------- |
 * | `action`        | **反推**：`(resourceType, action枚举)` → 权限点（见 constants） |
 * | `actionLabel`   | **反推**：同上表的中文动作名                                    |
 * | `severity`      | **反推**：由权限点查契约业务规则 2 的表                          |
 * | `targetType`    | **归一**：`resourceType` 别名表；未知值原样返回                 |
 * | `targetSummary` | `diff_summary`（表里没有 `targetSummary` 列）                   |
 * | `changeNote`    | `reason ?? diff_summary`（表里没有 `changeNote` 列）            |
 * | `metadata`      | 仅在有真实来源时给 `{ latencyMs }`；否则 `null`，不编造字段     |
 *
 * `metadata` 只放 `latencyMs` 是**刻意**的：契约示例里还有
 * `ticketId` / `refundNo` / `confirmPasswordVerified` 等，但表里没有任何列存它们，
 * 「编造一个恒为 `true` 的 `confirmPasswordVerified`」会让审计数据说谎 ——
 * 审计页最不该出现的就是不可信字段。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PaginatedDataDto } from '../../../../common/dto/api-response.dto';
import { AUDIT_RESULTS, AUDIT_SEVERITIES, type AuditResult, type AuditSeverity } from '../admin-audit-log.constants';

/** 操作人信息（批量查库补齐，避免 N+1） */
export class AuditLogOperatorDto {
  @ApiProperty({
    description: '操作人管理员 ID；账号已被彻底删除（或登录失败时账号不存在）时为 `null`',
    nullable: true,
    example: '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a',
  })
  adminId!: string | null;

  @ApiProperty({
    description: '展示名（`nickname → realName → username`；管理员已删除时回退审计行里冗余的用户名）',
    example: '超级管理员',
  })
  displayName!: string;

  @ApiProperty({ description: '登录用户名（审计行冗余存储，账号删除后仍可追责）', example: 'admin@soulmap.cn' })
  username!: string;

  @ApiProperty({
    description: '角色码列表；`isSuperAdmin` 恒为 `["SUPER_ADMIN"]`；管理员已删除时为 `[]`',
    type: [String],
    example: ['SUPER_ADMIN'],
  })
  roles!: string[];
}

/** 单条审计记录 */
export class AdminAuditLogItemDto {
  @ApiProperty({ description: '审计记录 ID', example: '0195f3a2-2527-7a20-9b1c-acdb9e0f1c95' })
  auditLogId!: string;

  @ApiProperty({
    description: '动作（权限点；未登记的组合回退为 `${resourceType}:${action}` 形式）',
    example: 'payment:order:refund',
  })
  action!: string;

  @ApiProperty({ description: '动作中文名', example: '发起退款' })
  actionLabel!: string;

  @ApiProperty({ enum: [...AUDIT_SEVERITIES], description: '风险等级（由权限点推导）', example: 'CRITICAL' })
  severity!: AuditSeverity;

  @ApiProperty({ enum: [...AUDIT_RESULTS], description: '操作结果', example: 'SUCCESS' })
  result!: AuditResult;

  @ApiProperty({ type: AuditLogOperatorDto, description: '操作人' })
  operator!: AuditLogOperatorDto;

  @ApiProperty({ description: '目标类型（归一后的枚举；无法归一时原样返回 `resourceType`）', example: 'ORDER' })
  targetType!: string;

  @ApiPropertyOptional({
    description: '目标 ID（表内为 uuid 列，故为 UUID 或 null）',
    nullable: true,
    example: '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89',
  })
  targetId!: string | null;

  @ApiPropertyOptional({
    description: '目标摘要（`diff_summary`）',
    nullable: true,
    example: '订单 SM20260214A7K3M9Q1 → REFUNDED',
  })
  targetSummary!: string | null;

  @ApiPropertyOptional({
    description: '变更前快照（`before_data`）',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  before!: unknown;

  @ApiPropertyOptional({
    description: '变更后快照（`after_data`）',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  after!: unknown;

  @ApiPropertyOptional({
    description: '变更备注（`reason` 优先，其次 `diff_summary`）',
    nullable: true,
    example: '用户投诉报告生成失败，客服核实后全额退款',
  })
  changeNote!: string | null;

  @ApiPropertyOptional({
    description: '补充元数据；仅当存在真实来源时返回（目前只有 `latencyMs`），否则 `null`',
    nullable: true,
    type: 'object',
    additionalProperties: true,
    example: { latencyMs: 128 },
  })
  metadata!: { latencyMs: number } | null;

  @ApiPropertyOptional({ description: '操作来源 IP', nullable: true, example: '203.0.113.42' })
  ip!: string | null;

  @ApiPropertyOptional({ description: '操作来源 User-Agent', nullable: true })
  userAgent!: string | null;

  @ApiPropertyOptional({ description: '请求追踪 ID', nullable: true, example: 'req_01HQ8Z3K7M2XQ9V4T6B1NDCFA8' })
  requestId!: string | null;

  @ApiProperty({ description: '发生时间（ISO 8601 UTC）', example: '2026-02-14T21:10:05.000Z' })
  createdAt!: string;
}

/** `byAction` 条目 */
export class AuditLogActionCountDto {
  @ApiProperty({ description: '权限点', example: 'payment:order:refund' })
  action!: string;

  @ApiProperty({ description: '命中条数', example: 4 })
  count!: number;
}

/** `byOperator` 条目 */
export class AuditLogOperatorCountDto {
  @ApiProperty({ description: '操作人管理员 ID', example: '0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a' })
  adminId!: string;

  @ApiProperty({ description: '展示名（口径与列表的 `operator.displayName` 一致）', example: '超级管理员' })
  displayName!: string;

  @ApiProperty({ description: '命中条数', example: 142 })
  count!: number;
}

/** `weeklyTrend` 条目 */
export class AuditLogTrendPointDto {
  @ApiProperty({ description: 'UTC 日期 `YYYY-MM-DD`', example: '2026-02-14' })
  date!: string;

  @ApiProperty({ description: '当日审计条数（无记录的日子补 0，保证曲线连续）', example: 48 })
  count!: number;

  @ApiProperty({ description: '当日 `CRITICAL` 条数', example: 6 })
  criticalCount!: number;
}

/** 摘要统计 */
export class AuditLogSummaryDto {
  @ApiProperty({ description: '当前过滤条件下的总条数（= 分页的 `total`）', example: 186 })
  totalLogs!: number;

  @ApiProperty({ description: '`CRITICAL` 条数（资金/权限/合规）', example: 12 })
  criticalCount!: number;

  @ApiProperty({ description: '`SENSITIVE` 条数（内容与用户数据）', example: 48 })
  sensitiveCount!: number;

  @ApiProperty({ description: '`NORMAL` 条数（补集，保证三项之和 = `totalLogs`）', example: 126 })
  normalCount!: number;

  @ApiProperty({ description: '失败条数（`success = false` 且非越权）', example: 4 })
  failedCount!: number;

  @ApiProperty({ description: '越权被拒条数（`errorCode = 20009`，安全审计重点）', example: 18 })
  deniedCount!: number;

  @ApiProperty({ type: [AuditLogActionCountDto], description: '按权限点 Top 10' })
  byAction!: AuditLogActionCountDto[];

  @ApiProperty({ type: [AuditLogOperatorCountDto], description: '按操作人 Top 10' })
  byOperator!: AuditLogOperatorCountDto[];

  @ApiProperty({ type: [AuditLogTrendPointDto], description: '最近 7 天（UTC）趋势' })
  weeklyTrend!: AuditLogTrendPointDto[];
}

/** 列表响应体（分页包络 + 摘要 + 保留期提示） */
export class AdminAuditLogListDto extends PaginatedDataDto<AdminAuditLogItemDto> {
  /**
   * 重声明 `items` 只是为了给 Swagger 标注元素类型。
   *
   * 必须带初始值（`= []`）：本仓库 `target: ES2022` 下 `useDefineForClassFields` 默认为真，
   * 无初始值的字段声明会用 `undefined` **覆盖**基类属性（TS2612）。本类只作为文档 schema
   * 使用（响应由 `buildPaginated` 返回的普通对象构成），因此这个初始值不会被真实请求用到。
   */
  @ApiProperty({ type: [AdminAuditLogItemDto], description: '当前页审计记录' })
  override items: AdminAuditLogItemDto[] = [];

  @ApiProperty({ type: AuditLogSummaryDto, description: '按当前过滤条件统计的摘要' })
  summary!: AuditLogSummaryDto;

  @ApiProperty({
    description: '保留期提示（契约原文）',
    example: '审计日志保留 1 年（法定合规要求）；超过保留期的日志将归档至冷存储。',
  })
  retentionNotice!: string;
}
