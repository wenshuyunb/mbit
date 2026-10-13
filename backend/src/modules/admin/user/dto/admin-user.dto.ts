/**
 * 管理端用户管理 DTO
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.2（4 个接口：列表 / 详情 / 封禁 / 解封）
 *
 * ## 为什么有些校验不放在 DTO
 *
 * 契约给这些字段指定了**专属错误码**（`sortBy` → `10004`、`pageSize` → `10005`、
 * 缺 `reason` → `10002`），而 class-validator 的失败会被全局 `ValidationPipe`
 * 统一归一为 `10001`（见 `all-exceptions.filter.ts` 的 `normalizeHttpException`）。
 * 因此凡是有专属错误码的字段只在此做「类型级」校验，白名单与边界判断留在 Service 中
 * 显式抛 `BusinessException`，保证对外错误码与契约逐字一致。
 *
 * 反之，契约要求 `10001` 的字段（`reason` 非法枚举、`reasonDetail` 超长、
 * `durationDays` 越界、时间非 ISO 8601）直接由 DTO 拦截 —— 语义与错误码都吻合。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { parseQueryBoolean as toBoolean } from '../../../../common/utils/query-boolean.util';

// ============================================================================
// 常量（同时被 Service 与 Swagger 使用，集中在此避免多处漂移）
// ============================================================================

/**
 * 用户状态筛选值（契约 §3.14.2.1）
 *
 * ⚠ 数据层 `UserStatus` 只有 `ACTIVE | DISABLED | DELETED`（无 `BANNED`），
 *   且「注销冷静期」不是用户状态而是 `user_deletion_requests` 的一条 PENDING 记录。
 *   因此这四个筛选值需要在 Service 中**翻译**为数据层条件，详见 `admin-user.service.ts`。
 */
export const ADMIN_USER_STATUSES = ['ACTIVE', 'BANNED', 'PENDING_DELETION', 'DELETED'] as const;
export type AdminUserStatusFilter = (typeof ADMIN_USER_STATUSES)[number];

/** 对外展示状态（与契约的 status 字段取值一致） */
export type AdminUserDisplayStatus = AdminUserStatusFilter;

/** MBTI 16 型（契约 §3.14.2.1：`mbtiType` 非 16 型合法值 → 10001） */
export const MBTI_TYPES = [
  'INTJ',
  'INTP',
  'ENTJ',
  'ENTP',
  'INFJ',
  'INFP',
  'ENFJ',
  'ENFP',
  'ISTJ',
  'ISFJ',
  'ESTJ',
  'ESFJ',
  'ISTP',
  'ISFP',
  'ESTP',
  'ESFP',
] as const;
export type MbtiType = (typeof MBTI_TYPES)[number];

/** 排序字段白名单（契约 §3.14.2.1，白名单外 → 10004） */
export const ADMIN_USER_SORT_FIELDS = ['createdAt', 'lastActiveAt', 'totalPaidAmount'] as const;
export type AdminUserSortField = (typeof ADMIN_USER_SORT_FIELDS)[number];

/** 详情 `include` 白名单（契约 §3.14.2.2，白名单外 → 10001） */
export const ADMIN_USER_INCLUDE_BLOCKS = [
  'orders',
  'membership',
  'reports',
  'relationships',
  'aiUsage',
  'consents',
  'deletion',
  'audit',
  'testSessions',
] as const;
export type AdminUserIncludeBlock = (typeof ADMIN_USER_INCLUDE_BLOCKS)[number];

/**
 * 详情默认 include（契约 §3.14.2.2：默认 `orders,membership,consents`）
 *
 * `include=audit` 映射到响应字段 `auditTrail`：契约里白名单值叫 `audit`，
 * 而响应块名是 `auditTrail`，两者刻意不做重命名以避免前端二义。
 */
export const DEFAULT_ADMIN_USER_INCLUDES: readonly AdminUserIncludeBlock[] = ['orders', 'membership', 'consents'];

/** 分页上限（契约 §3.14.2.1：pageSize ≤ 100，超出 → 10005） */
export const ADMIN_USER_MAX_PAGE_SIZE = 100;

/** 列表默认每页条数（契约 §3.14.2.1） */
export const ADMIN_USER_DEFAULT_PAGE_SIZE = 20;

/** 关键词最大长度（契约 §3.14.2.1：`keyword` ≤ 64 字符） */
export const ADMIN_USER_KEYWORD_MAX_LENGTH = 64;

/** 封禁原因枚举（契约 §3.14.2.3） */
export const BAN_REASONS = ['ABUSE', 'FRAUD', 'ILLEGAL_CONTENT', 'AI_ABUSE', 'MULTIPLE_REFUNDS', 'OTHER'] as const;
export type BanReason = (typeof BAN_REASONS)[number];

/** 封禁原因的中文文案（通知与审计摘要使用；不暴露内部风控规则细节） */
export const BAN_REASON_LABELS: Readonly<Record<BanReason, string>> = {
  ABUSE: '辱骂或骚扰',
  FRAUD: '欺诈或刷单',
  ILLEGAL_CONTENT: '发布违规内容',
  AI_ABUSE: '滥用 AI 服务',
  MULTIPLE_REFUNDS: '恶意退款',
  OTHER: '违反平台使用规范',
};

/** 封禁时长边界（契约 §3.14.2.3：整数 1–3650 天；越界 → 10001） */
export const BAN_DURATION_MIN_DAYS = 1;
export const BAN_DURATION_MAX_DAYS = 3650;

/** 封禁补充说明最大长度（契约 §3.14.2.3：0–200 字符） */
export const BAN_REASON_DETAIL_MAX_LENGTH = 200;

/** 解封原因最大长度（契约 §3.14.2.4：0–200 字符） */
export const UNBAN_REASON_MAX_LENGTH = 200;

/** 解析后的详情 include 集合 */
export interface ResolvedInclude {
  orders: boolean;
  membership: boolean;
  reports: boolean;
  relationships: boolean;
  aiUsage: boolean;
  consents: boolean;
  deletion: boolean;
  audit: boolean;
  testSessions: boolean;
}

/**
 * 布尔参数转换（共享实现，见 `common/utils/query-boolean.util.ts` 的文件头）
 *
 * 全局 `ValidationPipe` 开启了 `transformOptions.enableImplicitConversion`，
 * 而隐式转换会把字符串 `"false"` 变为 `true`（非空字符串恒为真）——
 * 这会让 `?isMember=false` 变成「筛选会员」，是典型的隐蔽 bug。
 *
 * ⚠ 这里原先有一份**局部副本**，它和全仓另外几份一样**从未生效过**：
 * class-transformer 的隐式转换**先于** `@Transform` 执行，副本只读 `value`，
 * 拿到的已经是 `Boolean('false') === true`，"判字符串"的分支永远走不到。
 * 实测（收敛前，走与 `main.ts` 同配置的真实管道）：
 *
 * | 字段 | 位置 | `'false'` | 期望 |
 * | --- | --- | --- | --- |
 * | `AdminUserListQueryDto.isMember` | 查询 | `true` ✗ | `false` |
 * | `BanUserDto.notifyUser` | 请求体 | `true` ✗ | `false` |
 *
 * 共享实现从 `obj[key]` 读**原始字符串**（`obj` 是未被隐式转换过的原始输入对象），
 * 因此不受隐式转换影响；无法识别的值原样返回，交给 `@IsBoolean` 报错。
 */

/** 逗号分隔字符串的清洗（保留原始字符串，语义校验交由 Service，以便给出专属错误码） */
const trimString = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

// ============================================================================
// GET /admin/users
// ============================================================================

export class AdminUserListQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1, minimum: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 最小为 1' })
  page?: number;

  @ApiPropertyOptional({
    description: `每页条数，最大 ${ADMIN_USER_MAX_PAGE_SIZE}（超出返回 10005）`,
    default: ADMIN_USER_DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: ADMIN_USER_MAX_PAGE_SIZE,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 最小为 1' })
  pageSize?: number;

  @ApiPropertyOptional({
    description: '模糊搜索：昵称（模糊） / 手机号（服务端 SHA-256 后精确匹配 phoneHash，绝不模糊） / 用户 ID（精确）',
    maxLength: ADMIN_USER_KEYWORD_MAX_LENGTH,
    example: '小满',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(ADMIN_USER_KEYWORD_MAX_LENGTH, { message: `keyword 长度不能超过 ${ADMIN_USER_KEYWORD_MAX_LENGTH}` })
  keyword?: string;

  @ApiPropertyOptional({
    description: `状态筛选，逗号分隔：${ADMIN_USER_STATUSES.join(' | ')}`,
    example: 'ACTIVE,BANNED',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'status 必须是逗号分隔的字符串' })
  @MaxLength(64, { message: 'status 长度不能超过 64' })
  status?: string;

  @ApiPropertyOptional({ description: '按最新画像的 MBTI 类型筛选', enum: MBTI_TYPES, example: 'INFJ' })
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'mbtiType 必须是字符串' })
  @MaxLength(4, { message: 'mbtiType 长度不能超过 4' })
  mbtiType?: string;

  @ApiPropertyOptional({ description: '是否会员（存在生效中的会员）', example: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'isMember 必须是布尔值' })
  isMember?: boolean;

  @ApiPropertyOptional({ description: '是否有已支付订单', example: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'hasPaid 必须是布尔值' })
  hasPaid?: boolean;

  @ApiPropertyOptional({ description: '是否已绑定手机号', example: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'phoneBound 必须是布尔值' })
  phoneBound?: boolean;

  @ApiPropertyOptional({ description: '注册时间范围起（ISO 8601）', example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @Transform(trimString)
  @IsDateString({ strict: true }, { message: 'registeredStartTime 必须是 ISO 8601 时间' })
  registeredStartTime?: string;

  @ApiPropertyOptional({ description: '注册时间范围止（ISO 8601）', example: '2026-02-14T23:59:59.999Z' })
  @IsOptional()
  @Transform(trimString)
  @IsDateString({ strict: true }, { message: 'registeredEndTime 必须是 ISO 8601 时间' })
  registeredEndTime?: string;

  @ApiPropertyOptional({ description: '最近活跃时间范围起（ISO 8601）', example: '2026-02-01T00:00:00.000Z' })
  @IsOptional()
  @Transform(trimString)
  @IsDateString({ strict: true }, { message: 'lastActiveStartTime 必须是 ISO 8601 时间' })
  lastActiveStartTime?: string;

  @ApiPropertyOptional({ description: '最近活跃时间范围止（ISO 8601）', example: '2026-02-14T23:59:59.999Z' })
  @IsOptional()
  @Transform(trimString)
  @IsDateString({ strict: true }, { message: 'lastActiveEndTime 必须是 ISO 8601 时间' })
  lastActiveEndTime?: string;

  @ApiPropertyOptional({
    description: `排序字段白名单：${ADMIN_USER_SORT_FIELDS.join(' | ')}（默认 createdAt）`,
    enum: ADMIN_USER_SORT_FIELDS,
    default: 'createdAt',
    example: 'createdAt',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'sortBy 必须是字符串' })
  sortBy?: string;

  @ApiPropertyOptional({ description: '排序方向', enum: ['asc', 'desc'], default: 'desc', example: 'desc' })
  @IsOptional()
  @Transform(trimString)
  @IsIn(['asc', 'desc'], { message: 'order 仅支持 asc / desc' })
  order?: 'asc' | 'desc';
}

// ============================================================================
// GET /admin/users/{id}
// ============================================================================

export class AdminUserDetailQueryDto {
  @ApiPropertyOptional({
    description: `逗号分隔的扩展块白名单：${ADMIN_USER_INCLUDE_BLOCKS.join(' | ')}（默认 ${DEFAULT_ADMIN_USER_INCLUDES.join(',')}）`,
    example: 'orders,membership,reports,aiUsage,consents,deletion',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'include 必须是逗号分隔的字符串' })
  @MaxLength(256, { message: 'include 长度不能超过 256' })
  include?: string;
}

// ============================================================================
// POST /admin/users/{id}/ban
// ============================================================================

export class BanUserDto {
  @ApiPropertyOptional({
    description: `封禁原因枚举：${BAN_REASONS.join(' | ')}；缺失返回 10002`,
    enum: BAN_REASONS,
    example: 'AI_ABUSE',
  })
  // 刻意用 @IsOptional()：契约要求「缺 reason」返回 10002 而非 10001，
  // 因此存在性判断放在 Service（枚举非法仍由 DTO 拦截为 10001，与契约一致）
  @IsOptional()
  @IsIn(BAN_REASONS, { message: `reason 仅支持：${BAN_REASONS.join(', ')}` })
  reason?: BanReason;

  @ApiPropertyOptional({
    description: `补充说明（0–${BAN_REASON_DETAIL_MAX_LENGTH} 字符；reason = OTHER 时必填，缺失返回 10002）`,
    maxLength: BAN_REASON_DETAIL_MAX_LENGTH,
    example: '短时间内高频调用 AI 接口，疑似脚本刷量',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'reasonDetail 必须是字符串' })
  @MaxLength(BAN_REASON_DETAIL_MAX_LENGTH, {
    message: `reasonDetail 长度不能超过 ${BAN_REASON_DETAIL_MAX_LENGTH}`,
  })
  reasonDetail?: string;

  @ApiPropertyOptional({
    description: `封禁时长（整数 ${BAN_DURATION_MIN_DAYS}–${BAN_DURATION_MAX_DAYS} 天）；不传为永久封禁`,
    minimum: BAN_DURATION_MIN_DAYS,
    maximum: BAN_DURATION_MAX_DAYS,
    example: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'durationDays 必须是整数' })
  @Min(BAN_DURATION_MIN_DAYS, { message: `durationDays 最小为 ${BAN_DURATION_MIN_DAYS}` })
  @Max(BAN_DURATION_MAX_DAYS, { message: `durationDays 最大为 ${BAN_DURATION_MAX_DAYS}` })
  durationDays?: number;

  @ApiPropertyOptional({ description: '是否向用户发送封禁通知（站内通知）', default: true, example: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'notifyUser 必须是布尔值' })
  notifyUser?: boolean;

  @ApiPropertyOptional({ description: '是否立即撤销该用户全部登录会话', default: true, example: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'revokeSessions 必须是布尔值' })
  revokeSessions?: boolean;
}

// ============================================================================
// POST /admin/users/{id}/unban
// ============================================================================

export class UnbanUserDto {
  @ApiPropertyOptional({
    description: `解封原因（0–${UNBAN_REASON_MAX_LENGTH} 字符，必填，用于审计；缺失返回 10002）`,
    maxLength: UNBAN_REASON_MAX_LENGTH,
    example: '申诉通过：确认为正常使用，误判',
  })
  // 同上：缺失走 10002，超长由 DTO 拦截为 10001
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'reason 必须是字符串' })
  @MaxLength(UNBAN_REASON_MAX_LENGTH, { message: `reason 长度不能超过 ${UNBAN_REASON_MAX_LENGTH}` })
  reason?: string;

  @ApiPropertyOptional({ description: '是否通知用户', default: true, example: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'notifyUser 必须是布尔值' })
  notifyUser?: boolean;

  @ApiPropertyOptional({
    description: '误判封禁时是否补偿（true 时赠送 7 天会员延期或等值 AI 次数，并写审计）',
    default: false,
    example: true,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'restoreCompensation 必须是布尔值' })
  restoreCompensation?: boolean;
}
