/**
 * 报告模块 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.5
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsIn, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

import { UUID_SHAPE_PATTERN } from '../../../common/utils/uuid.util';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  REPORT_SORT_FIELDS,
  REPORT_SORT_ORDERS,
  REPORT_STATUS_FILTERS,
  type ReportSortField,
  type ReportSortOrder,
  type ReportStatusFilter,
} from './report-list.util';

/**
 * 支持的报告类型（与 Prisma `AiReportType` 对齐）
 *
 * ⚠ 加一个取值必须**成对**做完下面五处，否则要么在 DTO 层就被拒、
 * 要么通过了 DTO 却在取模板时 `50011`（`CONTRACT_DRIFT_AUDIT.md` §9.3 记录过
 * 这个坑：`PromptType.EMOTION_ANALYSIS` 曾长期是个"有枚举、无模板、无代码路径"的空位）：
 *   ① 这里；② `report.service.ts` 的 `TEMPLATE_KEY_BY_TYPE`；
 *   ③ 管理端两处 `ADMIN_REPORT_TYPES`（`admin/report` 与 `admin/ai-stats`）；
 *   ④ 上下文组装器；⑤ `prisma/seed/data/prompt-templates.ts` 的模板本身。
 */
export const REPORT_TYPES = [
  'MBTI_REPORT',
  'BIG_FIVE_REPORT',
  'RELATIONSHIP_REPORT',
  'GROWTH_SUMMARY',
  // 情感测评报告（ADR-038 阶段 3）
  'EMOTION_REPORT',
] as const;
export type ReportTypeValue = (typeof REPORT_TYPES)[number];

/**
 * 逗号分隔的多值参数 → 数组
 *
 * 契约 §3.5.2 把 `type` / `status` 定义为「逗号分隔枚举」。全局 ValidationPipe
 * 开了 `enableImplicitConversion`，若不先转换，`@IsIn(..., { each: true })` 会拿到
 * 整个字符串 `'SUCCEEDED,FAILED'` 当作单个值 → 误判为非法枚举。
 *
 * 同时做两件清洗：去空白（`'A, B'` 要能解析）、丢弃空段（`'A,,'` 不应触发校验失败）。
 */
const splitCommaSeparated = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
};

export class CreateReportDto {
  @ApiProperty({ enum: REPORT_TYPES, description: '报告类型', example: 'MBTI_REPORT' })
  @IsIn(REPORT_TYPES, { message: 'type 取值不合法' })
  type!: ReportTypeValue;

  @ApiPropertyOptional({
    description: '指定测评会话；不传则绑定该用户**当前**的人格画像',
    example: '0195f3a2-91a7-7d53-b8c9-4a7b1e2f3c12',
    maxLength: 36,
  })
  @IsOptional()
  @IsString()
  @Length(1, 36)
  sessionId?: string;

  /**
   * 关系（匹配）解读报告的 relationshipId —— **`type=RELATIONSHIP_REPORT` 时必填**
   *
   * 这个字段此前**不存在**，后果是：DTO 对外宣称支持 `RELATIONSHIP_REPORT`
   * （`@ApiProperty({ enum: REPORT_TYPES })` 会把它渲染进 Swagger），
   * 而 `report.service.ts` 的 `createRelationshipReport` 一进来就检查
   * `input.relationshipId === undefined` → 抛 `400/10001`。
   * 也就是说**这条分支永远是死代码**，任何人按 Swagger 调用都必然失败。
   *
   * 服务层那条路径本身是完整的（校验关系归属、`status='ACTIVE'`、必须有已成功的
   * 算分报告），因此这里只补"把参数送进去"这一环，不改任何业务规则。
   *
   * 与其它 ID 参数同一处理：只校验 UUID **形状**、不校验版本
   * （本仓库主键是 UUIDv7，`@IsUUID()` 会误杀，理由见 `uuid.util.ts`）。
   */
  @ApiPropertyOptional({
    description: '关系 ID；`type=RELATIONSHIP_REPORT` 时必填（其余类型忽略）',
    example: '0195f3a2-b24e-7a86-abf1-7dae4b5c6f45',
  })
  @IsOptional()
  @IsString()
  @Matches(UUID_SHAPE_PATTERN, { message: 'relationshipId 不是合法的 UUID' })
  relationshipId?: string;
}

/**
 * 报告 ID 路径参数（`GET /reports/{id}`、`GET /reports/{id}/progress`）
 *
 * **必须校验 UUID 形状**：非法值（如 `/reports/not-a-uuid`）直接进 Prisma 的
 * `where: { id }` 会让 PostgreSQL 抛 `invalid input syntax for type uuid`，
 * 被全局过滤器翻译成 `90002` / **HTTP 500** —— 契约对同一参数的要求是
 * `400` / `10001`（§3.5.3 错误码表），且前端会把 500 当服务端故障上报，
 * 把「参数写错」误报成「后端挂了」。
 *
 * 用 `@Matches(UUID_SHAPE_PATTERN)` 而不是 `@IsUUID()`：本仓库主键是 UUIDv7，
 * 而 `class-validator` 的 `isUUID` 只认 v1–v5，会把**全部合法请求**判成 400
 * （理由详见 `common/utils/uuid.util.ts`）。同模块的 `ReportIdPathDto` 也用同一个
 * 模式 —— 两处必须一致，否则同一份 ID 在两个接口上一个能过一个报错。
 */
export class ReportIdParamDto {
  @ApiProperty({ description: '报告 ID（UUID）', example: '0195f3a2-3ad0-7c0e-8d79-f5ca2d3e4b2d' })
  @IsString({ message: '报告 ID 必须是字符串' })
  @Length(1, 36, { message: '报告 ID 长度不合法' })
  @Matches(UUID_SHAPE_PATTERN, { message: '报告 ID 不是合法的 UUID' })
  reportId!: string;
}

// ============================================================================
// GET /reports
// ============================================================================

export class ListReportsQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'page 不得小于 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，最大 ${MAX_PAGE_SIZE}`,
    example: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'pageSize 不得小于 1' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize 不得超过 ${MAX_PAGE_SIZE}` })
  pageSize?: number;

  @ApiPropertyOptional({
    enum: REPORT_TYPES,
    isArray: true,
    description: '报告类型，逗号分隔多选（如 `MBTI_REPORT,GROWTH_SUMMARY`）；不传则不限类型',
    example: 'MBTI_REPORT',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(REPORT_TYPES, { each: true, message: 'type 含非法枚举值' })
  type?: ReportTypeValue[];

  @ApiPropertyOptional({
    enum: REPORT_STATUS_FILTERS,
    isArray: true,
    description: '报告状态，逗号分隔多选（如 `SUCCEEDED,FAILED`）；不传则不限状态',
    example: 'SUCCEEDED',
  })
  @IsOptional()
  @Transform(splitCommaSeparated)
  @IsIn(REPORT_STATUS_FILTERS, { each: true, message: 'status 含非法枚举值' })
  status?: ReportStatusFilter[];

  @ApiPropertyOptional({
    enum: REPORT_SORT_FIELDS,
    description: '排序字段（白名单，越界返回 `10004`）',
    example: 'createdAt',
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(REPORT_SORT_FIELDS, { message: 'sortBy 不在允许的排序字段内' })
  sortBy?: ReportSortField;

  @ApiPropertyOptional({
    enum: REPORT_SORT_ORDERS,
    description: '排序方向',
    example: 'desc',
    default: 'desc',
  })
  @IsOptional()
  @IsIn(REPORT_SORT_ORDERS, { message: 'order 必须是 asc 或 desc' })
  order?: ReportSortOrder;
}
