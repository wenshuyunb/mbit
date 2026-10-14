/**
 * 管理端题库 DTO
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.3（题库管理 7 个接口）
 *
 * ## 校验分层（与 test 模块保持一致）
 *
 * 本文件只做**结构校验**（类型、长度、枚举、数值范围），由全局 `ValidationPipe`
 * （`whitelist: true` + `forbidNonWhitelisted: true`）执行 —— 因此 PATCH 的请求体里
 * 不声明 `code` / `type`，客户端一旦传入就会得到 `10001`（契约 §3.14.3.4 明确要求
 * 这两个字段不可变）。**语义校验**（LIKERT5 是否恰好 1–5、选项 `value` 是否题内唯一、
 * `testCodes` 是否真的存在于库中）放在 Service：它们要么要查库，要么依赖同请求内的
 * 其它字段，写在 DTO 里会得到「同一规则两份实现」。
 *
 * ## 与数据模型的取值域差异（重要）
 *
 * 契约允许一道题**多归属**（`testCodes: ["MBTI_LITE","MBTI_FULL"]`），但数据模型
 * `Question.testDefinitionId` 是**必填外键**（一对一）—— 二者无法同时满足。
 * 本实现以数据模型为准：只接受 1 个 `testCode`，多归属请求被显式拒绝（见 Service
 * 的 `resolveTestCodes`），而不是静默只写第一个。详见实现简报中的契约矛盾清单。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Dimension, QuestionType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  registerDecorator,
} from 'class-validator';
import type { ValidationArguments, ValidationOptions } from 'class-validator';

import { PaginationQueryDto } from '../../../../common/dto/api-response.dto';
import { parseQueryBoolean as toBoolean } from '../../../../common/utils/query-boolean.util';

// ============================================================================
// 取值域常量（契约 §3.14.3；与 Service 的语义校验共用，避免两处各写一份数字）
// ============================================================================

/** 题型（与 Prisma `QuestionType` 对齐） */
export const QUESTION_TYPES = ['LIKERT5', 'BINARY', 'FORCED_CHOICE', 'RANK'] as const;
export type QuestionTypeValue = (typeof QUESTION_TYPES)[number];

/**
 * 计分维度（与 Prisma `Dimension` 对齐）
 *
 * ⚠ 这份白名单**必须与 `Dimension` 枚举逐字同步**，而且它在管理端有**两处**
 * （本文件与 `admin/test-definition/dto`）。漏登记某个维度不会报错，
 * 只表现为"后台建题时选不到这个维度" —— 而运营会以为这个维度不存在。
 *
 * 族级值（`ATTACHMENT` / `LOVE_LANGUAGE` / `CONFLICT_STYLE`）保留用于后台归类；
 * 真正参与算分的是各自模块的细粒度维度。
 */
export const QUESTION_DIMENSIONS = [
  'EI',
  'SN',
  'TF',
  'JP',
  'OPENNESS',
  'CONSCIENTIOUSNESS',
  'EXTRAVERSION',
  'AGREEABLENESS',
  'NEUROTICISM',
  // 情感模块的族级值（后台归类用）
  'ATTACHMENT',
  'LOVE_LANGUAGE',
  'CONFLICT_STYLE',
  // 情感模块的计分维度（ADR-038 阶段 3）
  'ATTACH_ANXIETY',
  'ATTACH_AVOIDANCE',
  'LOVE_WORDS',
  'LOVE_TIME',
  'LOVE_GIFTS',
  'LOVE_SERVICE',
  'LOVE_TOUCH',
  'CONFLICT_COMPETING',
  'CONFLICT_COLLABORATING',
  'CONFLICT_COMPROMISING',
  'CONFLICT_AVOIDING',
  'CONFLICT_ACCOMMODATING',
  // 心理健康模块的计分维度（ADR-038 阶段 4）
  'MH_STRESS',
  'MH_MOOD',
  'MH_ANXIETY',
  'MH_SLEEP',
  'MH_ENERGY',
  'MH_LONELINESS',
] as const;
export type QuestionDimensionValue = (typeof QUESTION_DIMENSIONS)[number];

/** 题目编码：`^Q_[A-Z0-9_]+$`，长度 3–32（§3.14.3.2） */
export const QUESTION_CODE_PATTERN = /^Q_[A-Z0-9_]+$/;
export const QUESTION_CODE_MIN_LENGTH = 3;
export const QUESTION_CODE_MAX_LENGTH = 32;

/**
 * 归属测试定义白名单（契约写「白名单 4 个 code」）
 *
 * 四个 code 取自契约 §3.7.5（`MBTI_LITE` / `MBTI_FULL` / `BIG_FIVE_50` / `RELATIONSHIP_STYLE`）。
 * ⚠ 当前 seed 只灌入了其中 3 个定义（`RELATIONSHIP_STYLE` 尚无定义行），
 * 因此白名单通过后 Service 仍会做一次**存在性校验**：白名单是契约约束，库才是事实源。
 */
export const TEST_CODE_WHITELIST = ['MBTI_LITE', 'MBTI_FULL', 'BIG_FIVE_50', 'RELATIONSHIP_STYLE'] as const;
export type TestCodeValue = (typeof TEST_CODE_WHITELIST)[number];

/** 列表排序字段白名单（§3.14.3.1） */
export const QUESTION_SORT_FIELDS = ['order', 'createdAt', 'updatedAt'] as const;
export type QuestionSortField = (typeof QUESTION_SORT_FIELDS)[number];

/** 排序方向 */
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** 李克特 5 点量表的标准取值（LIKERT5 的 `value` 必须恰好是这 5 个） */
export const LIKERT5_VALUES = [1, 2, 3, 4, 5] as const;

/** 选项数量约束（§3.14.3.2 错误码 10016：`options` 长度 2–8） */
export const MIN_OPTION_COUNT = 2;
export const MAX_OPTION_COUNT = 8;

/** `scoreMap` 分值范围（§3.14.3.2） */
export const SCORE_MAP_MIN = -5;
export const SCORE_MAP_MAX = 5;

/** 标签约束（§3.14.3.1 / §3.14.3.2） */
export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 16;

/** 权重与展示顺序约束（§3.14.3.2 错误码 10016） */
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 5;
export const MIN_QUESTION_ORDER = 0;
export const MAX_QUESTION_ORDER = 9999;

/** 题干 / 解释 / 变更说明长度约束 */
export const MIN_CONTENT_LENGTH = 5;
export const MAX_CONTENT_LENGTH = 200;
export const MAX_EXPLANATION_LENGTH = 500;
export const MAX_CHANGE_NOTE_LENGTH = 200;
export const MIN_DELETE_REASON_LENGTH = 5;
export const MAX_DELETE_REASON_LENGTH = 200;
export const MAX_TOGGLE_REASON_LENGTH = 200;

/** 列表筛选：keyword 长度、标签筛选个数上限 */
export const MAX_KEYWORD_LENGTH = 64;
export const MAX_TAG_FILTERS = 5;

/** 批量导入约束（§3.14.3.6） */
export const IMPORT_FORMATS = ['JSON', 'CSV'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
export const IMPORT_MODES = ['APPEND', 'UPSERT', 'REPLACE'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];
export const IMPORT_ON_ERROR = ['ABORT', 'SKIP'] as const;
export type ImportOnError = (typeof IMPORT_ON_ERROR)[number];

/** `data` 体积上限 512KB（错误码 10006/413） */
export const MAX_IMPORT_BYTES = 512 * 1024;
/** 同步导入的题目数上限（错误码 10016；> 上限应分批或走异步队列） */
export const MAX_IMPORT_ROWS = 500;
/** CSV 表头约定（§3.14.3.6 业务规则 2），顺序不敏感、按列名取值 */
export const IMPORT_CSV_COLUMNS = [
  'code',
  'content',
  'type',
  'dimension',
  'weight',
  'reverseScored',
  'order',
  'tags',
  'optionLabels',
  'optionValues',
  'scoreMaps',
] as const;

/** 逗号分隔的维度列表（如 `EI,SN`） */
const DIMENSION_LIST_PATTERN = new RegExp(
  `^(?:${QUESTION_DIMENSIONS.join('|')})(?:,(?:${QUESTION_DIMENSIONS.join('|')}))*$`,
);

/** 逗号分隔的标签列表（每个标签 1–16 字符，元素个数上限在 Service 校验） */
const TAG_LIST_PATTERN = /^(?:[^,]{1,16})(?:,[^,]{1,16})*$/;

/**
 * query 字符串 → 布尔值（共享实现，见 `common/utils/query-boolean.util.ts` 的文件头）
 *
 * ⚠ **只写 `@Transform` 是不够的**：`main.ts` 的全局 ValidationPipe 开了
 * `enableImplicitConversion`，class-transformer 会先按反射类型执行隐式转换
 * （`Boolean('false') === true`），**然后**才调用自定义 transform —— 也就是说自定义
 * transform 拿到的 `value` 已经是 `true`，只读 `value` 的写法会让 `?isActive=false`
 * 被静默解析成 `true`，筛出来的结果是**反的**（且不报错，是最难发现的那类缺陷）。
 *
 * 因此必须从原始对象（`obj`）里取回未经转换的值 —— 共享实现正是这么做的。
 *
 * ## 收敛说明（本文件此前是**唯一读对了 `obj[key]` 的一份**）
 *
 * 这里原先的局部副本也读了 `obj[key]`，因此它**是 7 份里唯一真正有效的**（另一份
 * `refund.dto.ts` 是"侥幸有效"，见那里的说明）：实测（走与 `main.ts` 同配置的真实管道）
 * `?isActive=false` → `false`，与共享实现一致，所以它不是缺陷的一部分。
 * 但它比共享实现更严，边界行为不同 —— 收敛后**放宽**了如下取值（原先会被 400 拒绝）：
 *
 * | 输入 | 旧局部副本 | 共享实现 |
 * | --- | --- | --- |
 * | `'1'` | 400 | `true` |
 * | `'0'` | 400 | `false` |
 * | `' TRUE '` / `'False'` | 400 | `true` / `false` |
 * | `'maybe'` | 400 | 400（原样透出交给 `@IsBoolean`） |
 *
 * 这次放宽是**有意**的：全仓只该有一套查询布尔语义，否则同一个 `?flag=1` 在不同
 * 管理端接口上「一个能用一个 400」。若将来要收紧，应改共享实现而不是在这里留副本。
 */

/**
 * `scoreMap` 自定义校验
 *
 * 契约要求 `{维度: 分值}` 且分值 −5..5。用自定义验证器而不是 `@IsObject()`：
 * 后者只保证「是个对象」，`{"EI": "abc"}` 或 `{"EI": 99}` 会一路写进 JSONB，
 * 直到算分阶段才以「得分离谱」的形式暴露。
 */
export const IsScoreMap = (validationOptions?: ValidationOptions): PropertyDecorator => {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isScoreMap',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

          return Object.entries(value as Record<string, unknown>).every(([dimension, score]) => {
            const knownDimension = (QUESTION_DIMENSIONS as readonly string[]).includes(dimension);
            const validScore = typeof score === 'number' && Number.isFinite(score);
            return knownDimension && validScore && score >= SCORE_MAP_MIN && score <= SCORE_MAP_MAX;
          });
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} 必须是 {维度: 分值} 映射，分值范围 ${SCORE_MAP_MIN}..${SCORE_MAP_MAX}，维度需为合法枚举`;
        },
      },
    });
  };
};

// ============================================================================
// GET /api/v1/admin/questions
// ============================================================================

export class ListAdminQuestionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '题干全文搜索，≤ 64 字符', maxLength: MAX_KEYWORD_LENGTH })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(MAX_KEYWORD_LENGTH, { message: `keyword 最长 ${MAX_KEYWORD_LENGTH} 个字符` })
  keyword?: string;

  @ApiPropertyOptional({ description: '按所属测试定义筛选', enum: TEST_CODE_WHITELIST })
  @IsOptional()
  @IsIn(TEST_CODE_WHITELIST, { message: `testCode 仅支持：${TEST_CODE_WHITELIST.join(' / ')}` })
  testCode?: TestCodeValue;

  @ApiPropertyOptional({
    description: '维度筛选，可逗号分隔多个（如 `EI,SN`）',
    example: 'EI',
  })
  @IsOptional()
  @IsString({ message: 'dimension 必须是字符串' })
  @Matches(DIMENSION_LIST_PATTERN, { message: 'dimension 含非法枚举值（需为逗号分隔的合法维度）' })
  dimension?: string;

  @ApiPropertyOptional({ description: '题型筛选', enum: QUESTION_TYPES })
  @IsOptional()
  @IsIn(QUESTION_TYPES, { message: `type 仅支持：${QUESTION_TYPES.join(' / ')}` })
  type?: QuestionType;

  @ApiPropertyOptional({ description: '启用状态筛选', type: Boolean })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'isActive 必须是布尔值' })
  isActive?: boolean;

  @ApiPropertyOptional({ description: '是否反向计分筛选', type: Boolean })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'reverseScored 必须是布尔值' })
  reverseScored?: boolean;

  @ApiPropertyOptional({ description: '标签筛选，逗号分隔，最多 5 个', example: '社交,能量' })
  @IsOptional()
  @IsString({ message: 'tags 必须是字符串' })
  @Matches(TAG_LIST_PATTERN, { message: 'tags 需为逗号分隔的标签（每个 1–16 字符）' })
  tags?: string;

  @ApiPropertyOptional({ description: '排序字段', enum: QUESTION_SORT_FIELDS, default: 'order' })
  @IsOptional()
  @IsIn(QUESTION_SORT_FIELDS, { message: `sortBy 仅支持：${QUESTION_SORT_FIELDS.join(' / ')}` })
  sortBy?: QuestionSortField;

  @ApiPropertyOptional({ description: '排序方向', enum: SORT_DIRECTIONS, default: 'asc' })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS, { message: `order 仅支持：${SORT_DIRECTIONS.join(' / ')}` })
  order?: SortDirection;
}

// ============================================================================
// 选项（新建 / 修改 / 导入共用）
// ============================================================================

export class AdminQuestionOptionDto {
  @ApiProperty({ description: '选项文案', example: '非常同意', minLength: 1, maxLength: 32 })
  @IsString({ message: 'options[].label 必须是字符串' })
  @Length(1, 32, { message: 'options[].label 长度需在 1–32 之间' })
  label!: string;

  @ApiProperty({ description: '选项值（题内唯一）', example: 5 })
  @IsInt({ message: 'options[].value 必须是整数' })
  value!: number;

  @ApiProperty({
    description: '计分映射 `{维度: 分值}`，分值 −5..5',
    example: { EI: 2 },
  })
  @IsObject({ message: 'options[].scoreMap 必须是对象' })
  @IsScoreMap()
  scoreMap!: Record<string, number>;
}

// ============================================================================
// POST /api/v1/admin/questions
// ============================================================================

export class CreateAdminQuestionDto {
  @ApiProperty({ description: '题目编码，全局唯一', example: 'Q_EI_049', minLength: 3, maxLength: 32 })
  @IsString({ message: 'code 必须是字符串' })
  @Length(QUESTION_CODE_MIN_LENGTH, QUESTION_CODE_MAX_LENGTH, { message: 'code 长度需在 3–32 之间' })
  @Matches(QUESTION_CODE_PATTERN, { message: 'code 需匹配 ^Q_[A-Z0-9_]+$（如 Q_EI_049）' })
  code!: string;

  @ApiProperty({
    description: '题干（纯文本，不支持 HTML；服务端会剥离标签）',
    example: '在需要做决定时，我更愿意先自己思考清楚再和别人讨论。',
    minLength: MIN_CONTENT_LENGTH,
    maxLength: MAX_CONTENT_LENGTH,
  })
  @IsString({ message: 'content 必须是字符串' })
  @Length(MIN_CONTENT_LENGTH, MAX_CONTENT_LENGTH, {
    message: `content 长度需在 ${MIN_CONTENT_LENGTH}–${MAX_CONTENT_LENGTH} 之间`,
  })
  content!: string;

  @ApiProperty({ description: '题型', enum: QUESTION_TYPES })
  @IsIn(QUESTION_TYPES, { message: `type 仅支持：${QUESTION_TYPES.join(' / ')}` })
  type!: QuestionType;

  @ApiProperty({ description: '所属维度', enum: QUESTION_DIMENSIONS })
  @IsIn(QUESTION_DIMENSIONS, { message: 'dimension 取值不合法' })
  dimension!: Dimension;

  @ApiPropertyOptional({
    description: `计分权重 ${MIN_WEIGHT}–${MAX_WEIGHT}，最多 1 位小数`,
    default: 1,
    minimum: MIN_WEIGHT,
    maximum: MAX_WEIGHT,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 }, { message: `weight 最多 1 位小数，且需在 ${MIN_WEIGHT}–${MAX_WEIGHT} 之间` })
  @Min(MIN_WEIGHT, { message: `weight 最小为 ${MIN_WEIGHT}` })
  @Max(MAX_WEIGHT, { message: `weight 最大为 ${MAX_WEIGHT}` })
  weight?: number;

  @ApiPropertyOptional({ description: '是否反向计分', default: false })
  @IsOptional()
  @IsBoolean({ message: 'reverseScored 必须是布尔值' })
  reverseScored?: boolean;

  @ApiPropertyOptional({
    description: '展示顺序（同维度内）',
    default: 0,
    minimum: MIN_QUESTION_ORDER,
    maximum: MAX_QUESTION_ORDER,
  })
  @IsOptional()
  @IsInt({ message: 'order 必须是整数' })
  @Min(MIN_QUESTION_ORDER, { message: `order 最小为 ${MIN_QUESTION_ORDER}` })
  @Max(MAX_QUESTION_ORDER, { message: `order 最大为 ${MAX_QUESTION_ORDER}` })
  order?: number;

  @ApiPropertyOptional({ description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean({ message: 'isActive 必须是布尔值' })
  isActive?: boolean;

  @ApiPropertyOptional({ description: '标签，≤ 5 个，每个 ≤ 16 字符', type: [String], example: ['社交'] })
  @IsOptional()
  @IsArray({ message: 'tags 必须是数组' })
  @ArrayMaxSize(MAX_TAGS, { message: `tags 最多 ${MAX_TAGS} 个` })
  @IsString({ each: true, message: 'tags 元素必须是字符串' })
  @MaxLength(MAX_TAG_LENGTH, { each: true, message: `tags 元素最长 ${MAX_TAG_LENGTH} 个字符` })
  tags?: string[];

  @ApiPropertyOptional({
    description: '归属测试定义（**本实现只支持 1 个**：数据模型 `Question.testDefinitionId` 为必填外键）',
    type: [String],
    example: ['MBTI_LITE'],
  })
  @IsOptional()
  @IsArray({ message: 'testCodes 必须是数组' })
  @ArrayMaxSize(TEST_CODE_WHITELIST.length, { message: 'testCodes 元素过多' })
  @IsString({ each: true, message: 'testCodes 元素必须是字符串' })
  @IsIn(TEST_CODE_WHITELIST, { each: true, message: `testCodes 仅支持：${TEST_CODE_WHITELIST.join(' / ')}` })
  testCodes?: string[];

  @ApiPropertyOptional({
    description: `选项列表；${QUESTION_TYPES[1]} / ${QUESTION_TYPES[2]} / ${QUESTION_TYPES[3]} 必填，LIKERT5 可省略（服务端生成 1–5 默认选项）`,
    type: [AdminQuestionOptionDto],
  })
  @IsOptional()
  @IsArray({ message: 'options 必须是数组' })
  @ArrayMinSize(MIN_OPTION_COUNT, { message: `options 至少 ${MIN_OPTION_COUNT} 项` })
  @ArrayMaxSize(MAX_OPTION_COUNT, { message: `options 最多 ${MAX_OPTION_COUNT} 项` })
  @ValidateNested({ each: true })
  @Type(() => AdminQuestionOptionDto)
  options?: AdminQuestionOptionDto[];

  @ApiPropertyOptional({ description: '题目解释（后台可见）', maxLength: MAX_EXPLANATION_LENGTH })
  @IsOptional()
  @IsString({ message: 'explanation 必须是字符串' })
  @MaxLength(MAX_EXPLANATION_LENGTH, { message: `explanation 最长 ${MAX_EXPLANATION_LENGTH} 个字符` })
  explanation?: string;
}

// ============================================================================
// PATCH /api/v1/admin/questions/{id}
// ============================================================================

/**
 * 修改题目（PATCH 语义：全部字段可选）
 *
 * 刻意**不声明** `code` / `type`：二者不可变（契约 §3.14.3.4 业务规则 1），
 * 依赖 `forbidNonWhitelisted` 让越界写入直接 400，而不是「声明了但不生效」。
 */
export class UpdateAdminQuestionDto {
  @ApiPropertyOptional({
    description: '题干（纯文本，不支持 HTML）',
    minLength: MIN_CONTENT_LENGTH,
    maxLength: MAX_CONTENT_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'content 必须是字符串' })
  @Length(MIN_CONTENT_LENGTH, MAX_CONTENT_LENGTH, {
    message: `content 长度需在 ${MIN_CONTENT_LENGTH}–${MAX_CONTENT_LENGTH} 之间`,
  })
  content?: string;

  @ApiPropertyOptional({ description: '所属维度（修改需谨慎：影响算分口径）', enum: QUESTION_DIMENSIONS })
  @IsOptional()
  @IsIn(QUESTION_DIMENSIONS, { message: 'dimension 取值不合法' })
  dimension?: Dimension;

  @ApiPropertyOptional({
    description: `计分权重 ${MIN_WEIGHT}–${MAX_WEIGHT}`,
    minimum: MIN_WEIGHT,
    maximum: MAX_WEIGHT,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 }, { message: `weight 最多 1 位小数，且需在 ${MIN_WEIGHT}–${MAX_WEIGHT} 之间` })
  @Min(MIN_WEIGHT, { message: `weight 最小为 ${MIN_WEIGHT}` })
  @Max(MAX_WEIGHT, { message: `weight 最大为 ${MAX_WEIGHT}` })
  weight?: number;

  @ApiPropertyOptional({ description: '反向计分' })
  @IsOptional()
  @IsBoolean({ message: 'reverseScored 必须是布尔值' })
  reverseScored?: boolean;

  @ApiPropertyOptional({ description: '展示顺序', minimum: MIN_QUESTION_ORDER, maximum: MAX_QUESTION_ORDER })
  @IsOptional()
  @IsInt({ message: 'order 必须是整数' })
  @Min(MIN_QUESTION_ORDER, { message: `order 最小为 ${MIN_QUESTION_ORDER}` })
  @Max(MAX_QUESTION_ORDER, { message: `order 最大为 ${MAX_QUESTION_ORDER}` })
  order?: number;

  @ApiPropertyOptional({ description: '启用状态' })
  @IsOptional()
  @IsBoolean({ message: 'isActive 必须是布尔值' })
  isActive?: boolean;

  @ApiPropertyOptional({ description: '标签（传 `[]` 可清空）', type: [String] })
  @IsOptional()
  @IsArray({ message: 'tags 必须是数组' })
  @ArrayMaxSize(MAX_TAGS, { message: `tags 最多 ${MAX_TAGS} 个` })
  @IsString({ each: true, message: 'tags 元素必须是字符串' })
  @MaxLength(MAX_TAG_LENGTH, { each: true, message: `tags 元素最长 ${MAX_TAG_LENGTH} 个字符` })
  tags?: string[];

  @ApiPropertyOptional({
    description: '归属测试定义（**本实现只支持 1 个**，且传 `[]` 不被支持：数据模型要求必填归属）',
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: 'testCodes 必须是数组' })
  @ArrayMaxSize(TEST_CODE_WHITELIST.length, { message: 'testCodes 元素过多' })
  @IsString({ each: true, message: 'testCodes 元素必须是字符串' })
  @IsIn(TEST_CODE_WHITELIST, { each: true, message: `testCodes 仅支持：${TEST_CODE_WHITELIST.join(' / ')}` })
  testCodes?: string[];

  @ApiPropertyOptional({ description: '选项（**全量替换**语义）', type: [AdminQuestionOptionDto] })
  @IsOptional()
  @IsArray({ message: 'options 必须是数组' })
  @ArrayMinSize(MIN_OPTION_COUNT, { message: `options 至少 ${MIN_OPTION_COUNT} 项` })
  @ArrayMaxSize(MAX_OPTION_COUNT, { message: `options 最多 ${MAX_OPTION_COUNT} 项` })
  @ValidateNested({ each: true })
  @Type(() => AdminQuestionOptionDto)
  options?: AdminQuestionOptionDto[];

  @ApiPropertyOptional({ description: '题目解释', maxLength: MAX_EXPLANATION_LENGTH })
  @IsOptional()
  @IsString({ message: 'explanation 必须是字符串' })
  @MaxLength(MAX_EXPLANATION_LENGTH, { message: `explanation 最长 ${MAX_EXPLANATION_LENGTH} 个字符` })
  explanation?: string;

  @ApiPropertyOptional({ description: '变更说明（写入审计，建议提供）', maxLength: MAX_CHANGE_NOTE_LENGTH })
  @IsOptional()
  @IsString({ message: 'changeNote 必须是字符串' })
  @MaxLength(MAX_CHANGE_NOTE_LENGTH, { message: `changeNote 最长 ${MAX_CHANGE_NOTE_LENGTH} 个字符` })
  changeNote?: string;
}

// ============================================================================
// DELETE /api/v1/admin/questions/{id}
// ============================================================================

export class DeleteAdminQuestionDto {
  @ApiProperty({
    description: '删除原因（必填，审计用）',
    minLength: MIN_DELETE_REASON_LENGTH,
    maxLength: MAX_DELETE_REASON_LENGTH,
  })
  @IsString({ message: 'reason 必须是字符串' })
  @Length(MIN_DELETE_REASON_LENGTH, MAX_DELETE_REASON_LENGTH, {
    message: `reason 长度需在 ${MIN_DELETE_REASON_LENGTH}–${MAX_DELETE_REASON_LENGTH} 之间`,
  })
  reason!: string;

  @ApiPropertyOptional({
    description: '⚠️ 是否物理删除（仅当该题从未被任何会话引用且无答题记录时允许）',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'hardDelete 必须是布尔值' })
  hardDelete?: boolean;
}

// ============================================================================
// POST /api/v1/admin/questions/{id}/toggle
// ============================================================================

export class ToggleAdminQuestionDto {
  @ApiProperty({ description: '目标状态（显式传目标值，而非「切换」语义，保证幂等）', example: false })
  @IsBoolean({ message: 'isActive 必须是布尔值' })
  isActive!: boolean;

  @ApiPropertyOptional({ description: '原因（建议填写，审计用）', maxLength: MAX_TOGGLE_REASON_LENGTH })
  @IsOptional()
  @IsString({ message: 'reason 必须是字符串' })
  @MaxLength(MAX_TOGGLE_REASON_LENGTH, { message: `reason 最长 ${MAX_TOGGLE_REASON_LENGTH} 个字符` })
  reason?: string;
}

// ============================================================================
// POST /api/v1/admin/questions/import
// ============================================================================

export class ImportAdminQuestionsDto {
  @ApiProperty({ description: '导入格式', enum: IMPORT_FORMATS })
  @IsIn(IMPORT_FORMATS, { message: `format 仅支持：${IMPORT_FORMATS.join(' / ')}` })
  format!: ImportFormat;

  @ApiProperty({
    description: '题目数据（JSON 为数组字符串；CSV 为含表头的文本），≤ 512KB',
  })
  @IsString({ message: 'data 必须是字符串' })
  data!: string;

  @ApiPropertyOptional({ description: '统一归属的测试定义（数据行内可覆盖）', enum: TEST_CODE_WHITELIST })
  @IsOptional()
  @IsIn(TEST_CODE_WHITELIST, { message: `testCode 仅支持：${TEST_CODE_WHITELIST.join(' / ')}` })
  testCode?: TestCodeValue;

  @ApiPropertyOptional({ description: '导入模式', enum: IMPORT_MODES, default: 'APPEND' })
  @IsOptional()
  @IsIn(IMPORT_MODES, { message: `mode 仅支持：${IMPORT_MODES.join(' / ')}` })
  mode?: ImportMode;

  @ApiPropertyOptional({ description: '试运行（只校验不写入）', type: Boolean, default: true })
  @IsOptional()
  @IsBoolean({ message: 'dryRun 必须是布尔值' })
  dryRun?: boolean;

  @ApiPropertyOptional({ description: '错误处理策略', enum: IMPORT_ON_ERROR, default: 'ABORT' })
  @IsOptional()
  @IsIn(IMPORT_ON_ERROR, { message: `onError 仅支持：${IMPORT_ON_ERROR.join(' / ')}` })
  onError?: ImportOnError;
}
