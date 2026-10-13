/**
 * 管理端测试定义 DTO
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.4（`GET` / `POST /api/v1/admin/test-definitions`）
 *
 * ## 校验分层
 *
 * 本文件只做**结构校验**（类型、长度、枚举、数值范围）。语义校验（配额合计是否等于题量、
 * 题目是否存在且启用、计分模型与维度是否匹配、`isFree=false` 时是否声明了权益）放在
 * Service —— 它们要么需要查库，要么依赖跨字段推导，写在 DTO 里只会得到「同样的规则两份实现」。
 *
 * ## 契约与数据模型的取值域差异（重要）
 *
 * 契约的 `category` 只有 `PERSONALITY` / `RELATIONSHIP`，而数据模型的 `TestCategory`
 * 是 `MBTI | BIG_FIVE | RELATIONSHIP_STYLE | COMPREHENSIVE` —— 两个取值域**无法一一对应**。
 * 因此以 `scoringModel` 作为唯一事实源做双向映射（见 `test-definition.service.ts`
 * 的 `toDbCategory` / `toContractCategory`），本文件只校验契约侧的取值。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../../../common/dto/api-response.dto';
import { parseQueryBoolean as toBoolean } from '../../../../common/utils/query-boolean.util';

/** 契约侧测试大类（§3.14.4.1 Query `category`） */
export const TEST_DEFINITION_CATEGORIES = ['PERSONALITY', 'RELATIONSHIP'] as const;
export type TestDefinitionCategory = (typeof TEST_DEFINITION_CATEGORIES)[number];

/** 计分模型（映射到 `PersonalityEngine` 分支） */
export const TEST_SCORING_MODELS = ['MBTI_DIMENSION', 'BIG_FIVE_SUM', 'RELATIONSHIP_STYLE'] as const;
export type TestScoringModel = (typeof TEST_SCORING_MODELS)[number];

/**
 * 权益类型（与 Prisma `EntitlementType` 对齐）
 *
 * 契约只写「权益类型枚举」，取值清单需从数据模型对齐取值 —— 若这里自造取值，
 * 后台能配出一个**永远匹配不到任何权益**的定义，用户端表现为「免费用户能进、付费用户反而进不去」。
 */
export const TEST_ENTITLEMENT_TYPES = ['REPORT_UNLOCK', 'MEMBERSHIP_ACTIVE', 'AI_CREDITS', 'PDF_EXPORT'] as const;
export type TestEntitlementType = (typeof TEST_ENTITLEMENT_TYPES)[number];

/** 全部计分维度（与 Prisma `Dimension` 对齐，供配额项校验） */
export const SCORING_DIMENSIONS = [
  'EI',
  'SN',
  'TF',
  'JP',
  'OPENNESS',
  'CONSCIENTIOUSNESS',
  'EXTRAVERSION',
  'AGREEABLENESS',
  'NEUROTICISM',
  'ATTACHMENT',
  'LOVE_LANGUAGE',
  'CONFLICT_STYLE',
] as const;
export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

/**
 * query 字符串 → 布尔值（共享实现，见 `common/utils/query-boolean.util.ts` 的文件头）
 *
 * ⚠ 不能用 `@Type(() => Boolean)`：`Boolean('false') === true`，于是
 * `?isActive=false` 会被解析成 `true`，筛出来的结果是**反的**（而且不报错，最难发现的那类 bug）。
 *
 * ⚠ 这里原先有一份**局部副本**，它和全仓另外几份一样**从未生效过**：全局
 * `ValidationPipe` 开了 `enableImplicitConversion`，class-transformer 会**先**按属性的
 * 反射类型做隐式转换，**然后**才调用 `@Transform` —— 副本只读 `value`，拿到的已经是
 * `Boolean('false') === true`，"判字符串"的分支永远走不到。实测（收敛前，走与 `main.ts`
 * 同配置的真实管道）：`?isActive=false` → `true`（本意「只看启用中的」变成了「只看停用的」）。
 *
 * 共享实现从 `obj[key]` 读**原始字符串**（`obj` 是未被隐式转换过的原始输入对象），
 * 因此不受隐式转换影响；无法识别的值原样返回，交给 `@IsBoolean` 报错。
 */

// ============================================================================
// GET /api/v1/admin/test-definitions
// ============================================================================

export class ListTestDefinitionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '启用状态筛选', type: Boolean })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'isActive 必须是布尔值' })
  isActive?: boolean;

  @ApiPropertyOptional({ description: '测试类别', enum: TEST_DEFINITION_CATEGORIES })
  @IsOptional()
  @IsIn(TEST_DEFINITION_CATEGORIES, { message: `category 仅支持：${TEST_DEFINITION_CATEGORIES.join(' / ')}` })
  category?: TestDefinitionCategory;

  @ApiPropertyOptional({
    description: '是否返回关联题目 ID 集合（配额配置始终返回）',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'includeQuestionIds 必须是布尔值' })
  includeQuestionIds?: boolean;
}

// ============================================================================
// POST /api/v1/admin/test-definitions
// ============================================================================

/** 维度配额项 */
export class QuotaConfigItemDto {
  @ApiProperty({ description: '计分维度', enum: SCORING_DIMENSIONS, example: 'EI' })
  @IsIn(SCORING_DIMENSIONS, { message: `dimension 仅支持：${SCORING_DIMENSIONS.join(' / ')}` })
  dimension!: ScoringDimension;

  @ApiProperty({ description: '该维度配额题量', minimum: 1, maximum: 200, example: 9 })
  @IsInt({ message: 'quota 必须是整数' })
  @Min(1, { message: 'quota 最小为 1' })
  @Max(200, { message: 'quota 最大为 200' })
  quota!: number;
}

export class CreateTestDefinitionDto {
  @ApiProperty({
    description: '定义编码（全局唯一，大写字母开头，仅含大写字母/数字/下划线）',
    example: 'MBTI_TEEN',
    minLength: 3,
    maxLength: 32,
  })
  @IsString({ message: 'code 必须是字符串' })
  @Length(3, 32, { message: 'code 长度需在 3–32 之间' })
  @Matches(/^[A-Z][A-Z0-9_]+$/, { message: 'code 必须以大写字母开头，且仅含大写字母、数字与下划线' })
  code!: string;

  @ApiProperty({ description: '名称', example: 'MBTI 青少年版', minLength: 2, maxLength: 32 })
  @IsString({ message: 'name 必须是字符串' })
  @Length(2, 32, { message: 'name 长度需在 2–32 之间' })
  name!: string;

  @ApiPropertyOptional({
    description: '副标题（如「48 题 · 约 8 分钟」）；不传时由服务端按题量与时长派生',
    example: '36 题 · 约 6 分钟',
    maxLength: 32,
  })
  @IsOptional()
  @IsString({ message: 'subtitle 必须是字符串' })
  @Length(0, 32, { message: 'subtitle 长度不超过 32' })
  subtitle?: string;

  @ApiProperty({
    description: '说明（用户可见）',
    minLength: 10,
    maxLength: 500,
  })
  @IsString({ message: 'description 必须是字符串' })
  @Length(10, 500, { message: 'description 长度需在 10–500 之间' })
  description!: string;

  @ApiProperty({ description: '类别', enum: TEST_DEFINITION_CATEGORIES, example: 'PERSONALITY' })
  @IsIn(TEST_DEFINITION_CATEGORIES, { message: `category 仅支持：${TEST_DEFINITION_CATEGORIES.join(' / ')}` })
  category!: TestDefinitionCategory;

  @ApiProperty({ description: '定义版本（语义化版本）', example: '1.0.0' })
  @IsString({ message: 'version 必须是字符串' })
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version 需为语义化版本，如 1.0.0' })
  version!: string;

  @ApiProperty({ description: '题量要求', minimum: 5, maximum: 200, example: 36 })
  @IsInt({ message: 'questionCount 必须是整数' })
  @Min(5, { message: 'questionCount 最小为 5' })
  @Max(200, { message: 'questionCount 最大为 200' })
  questionCount!: number;

  @ApiProperty({ description: '预计时长（分钟）', minimum: 1, maximum: 60, example: 6 })
  @IsInt({ message: 'estimatedMinutes 必须是整数' })
  @Min(1, { message: 'estimatedMinutes 最小为 1' })
  @Max(60, { message: 'estimatedMinutes 最大为 60' })
  estimatedMinutes!: number;

  @ApiProperty({ description: '计分模型', enum: TEST_SCORING_MODELS, example: 'MBTI_DIMENSION' })
  @IsIn(TEST_SCORING_MODELS, { message: `scoringModel 仅支持：${TEST_SCORING_MODELS.join(' / ')}` })
  scoringModel!: TestScoringModel;

  @ApiPropertyOptional({ description: '算法版本；不传取当前 ENGINE_VERSION', example: 'pe-v1.0.0', maxLength: 16 })
  @IsOptional()
  @IsString({ message: 'engineVersion 必须是字符串' })
  @Length(1, 16, { message: 'engineVersion 长度需在 1–16 之间' })
  engineVersion?: string;

  @ApiPropertyOptional({ description: '是否免费', default: true })
  @IsOptional()
  @IsBoolean({ message: 'isFree 必须是布尔值' })
  isFree?: boolean;

  @ApiPropertyOptional({ description: '所需权益（isFree=false 时必填）', enum: TEST_ENTITLEMENT_TYPES })
  @IsOptional()
  @IsIn(TEST_ENTITLEMENT_TYPES, { message: `requiredEntitlement 仅支持：${TEST_ENTITLEMENT_TYPES.join(' / ')}` })
  requiredEntitlement?: TestEntitlementType;

  @ApiPropertyOptional({ description: '展示顺序', minimum: 0, maximum: 999, example: 50 })
  @IsOptional()
  @IsInt({ message: 'sortOrder 必须是整数' })
  @Min(0, { message: 'sortOrder 最小为 0' })
  @Max(999, { message: 'sortOrder 最大为 999' })
  sortOrder?: number;

  @ApiPropertyOptional({
    description: '维度配额（quota 合计需等于 questionCount）',
    type: [QuotaConfigItemDto],
  })
  @IsOptional()
  @IsArray({ message: 'quotaConfig 必须是数组' })
  @ArrayMinSize(1, { message: 'quotaConfig 至少包含 1 项' })
  @ArrayMaxSize(SCORING_DIMENSIONS.length, { message: 'quotaConfig 项数超出维度数量' })
  @ValidateNested({ each: true })
  @Type(() => QuotaConfigItemDto)
  quotaConfig?: QuotaConfigItemDto[];

  @ApiPropertyOptional({
    description: '显式题目集合（须为已存在且启用中的题目）',
    type: [String],
    example: ['0195f3a2-29cf-7bfd-9c68-e4bf1c2d3a1c'],
  })
  @IsOptional()
  @IsArray({ message: 'questionIds 必须是数组' })
  @ArrayMinSize(1, { message: 'questionIds 至少包含 1 个题目' })
  @ArrayMaxSize(200, { message: 'questionIds 最多 200 个' })
  @IsUUID('all', { each: true, message: 'questionIds 必须是合法的题目 UUID' })
  questionIds?: string[];

  @ApiPropertyOptional({
    description: '启用状态（新建默认 false：草稿态，配置完成后再启用）',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'isActive 必须是布尔值' })
  isActive?: boolean;
}
