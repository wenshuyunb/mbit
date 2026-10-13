/**
 * 管理端 Prompt 管理 DTO
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.5（7 个接口）
 *
 * ## 校验分层
 *
 * 本文件负责结构性校验（长度、枚举、数值范围、嵌套结构）；**语义校验**放在 Service：
 *   · 变量声明与模板占位符是否一致（需要解析模板文本，且要在 `50021` 上给出明细）
 *   · `cloneFromVersionId` 是否属于该模板（需要查库）
 *   · 发布模式与流量权重的组合约束（AB 模式必须有权重、且必须存在其他 ACTIVE 版本）
 *
 * ## 取值来源说明
 *
 * `model` / `type` 的枚举值**逐字取自契约**，并与运行期一致：
 *   · `type` 与 Prisma `PromptType` 对齐（多一个取值就会写到不存在的枚举上去）
 *   · `model` 是自由文本列，但契约把它约束为 5 个取值；同时我们按「模型 → Provider」
 *     推导 `provider`（运行期据 `provider` 决定走哪个厂商，漏了会退化成按配置兜底）
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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
  Min,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../../../common/dto/api-response.dto';
import { parseQueryBoolean as toBoolean } from '../../../../common/utils/query-boolean.util';

/** 模板类型（与 Prisma `PromptType` 逐字对齐） */
export const PROMPT_TYPES = [
  'MBTI_REPORT',
  'RELATIONSHIP_REPORT',
  'AI_COMPANION',
  'EMOTION_ANALYSIS',
  'SYSTEM_SAFETY',
  // 与 `AiReportType` 对齐的两个报告类型：大五与成长回顾各有自己的模板
  // （`report.bigfive` / `report.growth`）。此前枚举里没有它们，模板只能借
  // `MBTI_REPORT` 登记，后台按类型筛选时混在「MBTI 深度报告」里。
  'BIG_FIVE_REPORT',
  'GROWTH_SUMMARY',
] as const;
export type PromptTypeValue = (typeof PROMPT_TYPES)[number];

/** 允许的模型（契约 §3.14.5.4） */
export const PROMPT_MODELS = ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'qwen-plus', 'qwen-turbo'] as const;
export type PromptModelValue = (typeof PROMPT_MODELS)[number];

/** 发布模式 */
export const PUBLISH_MODES = ['FULL', 'AB_TEST'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

/** 回滚范围 */
export const REVERT_WINDOWS = ['ALL', 'CANARY'] as const;
export type RevertWindow = (typeof REVERT_WINDOWS)[number];

/** 预览模式（`ACTUAL_CALL` 会真实消耗 token，见 Service 中的说明） */
export const RENDER_MODES = ['PREVIEW', 'ACTUAL_CALL'] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

/** 变更说明长度（契约：5–200） */
const CHANGE_NOTE_MIN = 5;
const CHANGE_NOTE_MAX = 200;

/**
 * 模板键格式（契约 `^[A-Z][A-Z0-9_]+$`，3–64 字符）
 *
 * ⚠ 仅用于**新建**。存量种子数据的 key 形如 `report.mbti`（小写带点），
 * 不满足该正则 —— 因此查询类接口（列表/详情/版本/test-render）**不做格式校验**，
 * 否则现有模板全部 400，等于把线上功能锁死。
 */
const TEMPLATE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;

/**
 * 布尔参数转换（共享实现，见 `common/utils/query-boolean.util.ts` 的文件头）
 *
 * 不能写 `@Type(() => Boolean)`，也不能只写 `@Transform(({ value }) => …)`：
 * 全局管道开了 `enableImplicitConversion`，class-transformer 会**先**按属性的反射类型
 * 做隐式转换（`Boolean('false') === true`），**然后**才调用 `@Transform` ——
 * 回调拿到的 `value` 已经是 `true`，"判字符串"的分支永远走不到。
 *
 * ⚠ 这里原先有一份**局部副本**，它和全仓另外几份一样**从未生效过**。实测（收敛前，
 * 走与 `main.ts` 同配置的真实管道）：`?hasAbTest=false` → `true`、
 * `?includeContent=false` → `true`（管理员想看元数据，却拿到了 Prompt 全文）。
 *
 * 共享实现从 `obj[key]` 读**原始字符串**（`obj` 是未被隐式转换过的原始输入对象），
 * 因此不受隐式转换影响；无法识别的值原样返回，交给 `@IsBoolean` 报错。
 */

/**
 * 逗号/空白分隔 → 字符串数组
 *
 * 契约的请求示例写的是 `?type=MBTI_REPORT AI_COMPANION`（空格分隔），表格里写的是
 * 「逗号分隔」。两种都接受：解析层放宽不会带来歧义（枚举值本身不含空格），
 * 而按单一分隔符实现会让其中一种真实调用方式静默筛不到数据。
 */
const splitMultiValue = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const parts = value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
};

// ============================================================================
// GET /api/v1/admin/prompts
// ============================================================================

export class ListPromptsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '模板类型（逗号或空格分隔，可多选）',
    enum: PROMPT_TYPES,
    isArray: true,
  })
  @IsOptional()
  @Transform(splitMultiValue)
  @IsArray({ message: 'type 需要是逗号分隔的枚举列表' })
  @IsIn(PROMPT_TYPES, { each: true, message: `type 仅支持：${PROMPT_TYPES.join(' / ')}` })
  type?: PromptTypeValue[];

  @ApiPropertyOptional({ description: '按 key 或 description 搜索', maxLength: 64 })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @Length(1, 64, { message: 'keyword 长度需在 1–64 之间' })
  keyword?: string;

  @ApiPropertyOptional({ description: '是否仅返回存在多版本流量权（AB 测试）的模板', type: Boolean })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'hasAbTest 必须是布尔值' })
  hasAbTest?: boolean;
}

// ============================================================================
// POST /api/v1/admin/prompts/{key}/versions
// ============================================================================

export class CreatePromptVersionDto {
  @ApiProperty({ description: '系统提示词', minLength: 50, maxLength: 20_000 })
  @IsString({ message: 'systemPrompt 必须是字符串' })
  @Length(50, 20_000, { message: 'systemPrompt 长度需在 50–20000 之间' })
  systemPrompt!: string;

  @ApiProperty({
    description: '用户提示词模板（支持 `{{var}}` 与 `{{#if var}}...{{/if}}`）',
    minLength: 20,
    maxLength: 40_000,
  })
  @IsString({ message: 'userPromptTemplate 必须是字符串' })
  @Length(20, 40_000, { message: 'userPromptTemplate 长度需在 20–40000 之间' })
  userPromptTemplate!: string;

  @ApiProperty({ description: '变量声明（JSON Schema，type: object）', type: Object })
  @IsObject({ message: 'variables 必须是 JSON Schema 对象' })
  variables!: Record<string, unknown>;

  @ApiPropertyOptional({ description: '默认模型', enum: PROMPT_MODELS, example: 'deepseek-chat' })
  @IsOptional()
  @IsIn(PROMPT_MODELS, { message: `model 仅支持：${PROMPT_MODELS.join(' / ')}` })
  model?: PromptModelValue;

  @ApiPropertyOptional({ description: '温度', minimum: 0, maximum: 2, default: 0.7 })
  @IsOptional()
  @IsNumber({}, { message: 'temperature 必须是数字' })
  @Min(0, { message: 'temperature 最小为 0' })
  @Max(2, { message: 'temperature 最大为 2' })
  temperature?: number;

  @ApiPropertyOptional({ description: '最大输出 token', minimum: 64, maximum: 16_000, default: 4000 })
  @IsOptional()
  @IsInt({ message: 'maxTokens 必须是整数' })
  @Min(64, { message: 'maxTokens 最小为 64' })
  @Max(16_000, { message: 'maxTokens 最大为 16000' })
  maxTokens?: number;

  @ApiPropertyOptional({
    description: '结构化输出约束（JSON Schema）；null 表示纯文本输出',
    type: Object,
    nullable: true,
  })
  @IsOptional()
  @IsObject({ message: 'outputSchema 必须是 JSON Schema 对象' })
  outputSchema?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: '流量权重（新建版本默认 0：不参与分流）', minimum: 0, maximum: 100, default: 0 })
  @IsOptional()
  @IsInt({ message: 'trafficWeight 必须是整数' })
  @Min(0, { message: 'trafficWeight 最小为 0' })
  @Max(100, { message: 'trafficWeight 最大为 100' })
  trafficWeight?: number;

  @ApiPropertyOptional({ description: '克隆源版本 ID（必须属于该模板）' })
  @IsOptional()
  @IsString({ message: 'cloneFromVersionId 必须是字符串' })
  @Length(1, 36, { message: 'cloneFromVersionId 长度不合法' })
  cloneFromVersionId?: string;

  @ApiProperty({ description: '变更说明（审计与 AB 复盘用）', minLength: CHANGE_NOTE_MIN, maxLength: CHANGE_NOTE_MAX })
  @IsString({ message: 'changeNote 必须是字符串' })
  @Length(CHANGE_NOTE_MIN, CHANGE_NOTE_MAX, {
    message: `changeNote 长度需在 ${CHANGE_NOTE_MIN}–${CHANGE_NOTE_MAX} 之间`,
  })
  changeNote!: string;
}

// ============================================================================
// POST /api/v1/admin/prompts
// ============================================================================

export class CreatePromptTemplateDto {
  @ApiProperty({
    description: '模板键（全局唯一，大写字母开头）',
    example: 'GROWTH_REVIEW',
    minLength: 3,
    maxLength: 64,
  })
  @IsString({ message: 'key 必须是字符串' })
  @Length(3, 64, { message: 'key 长度需在 3–64 之间' })
  @Matches(TEMPLATE_KEY_PATTERN, { message: 'key 必须以大写字母开头，且仅含大写字母、数字与下划线' })
  key!: string;

  @ApiProperty({ description: '模板类型', enum: PROMPT_TYPES, example: 'EMOTION_ANALYSIS' })
  @IsIn(PROMPT_TYPES, { message: `type 仅支持：${PROMPT_TYPES.join(' / ')}` })
  type!: PromptTypeValue;

  @ApiProperty({ description: '用途说明（后台可读）', minLength: 5, maxLength: 200 })
  @IsString({ message: 'description 必须是字符串' })
  @Length(5, 200, { message: 'description 长度需在 5–200 之间' })
  description!: string;

  @ApiPropertyOptional({
    description: '首个版本（结构同 `POST /versions`，状态为 DRAFT）',
    type: CreatePromptVersionDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreatePromptVersionDto)
  initialVersion?: CreatePromptVersionDto;
}

// ============================================================================
// POST /api/v1/admin/prompts/{key}/versions/{versionId}/publish
// ============================================================================

export class PublishPromptVersionDto {
  @ApiPropertyOptional({ description: '发布模式：完全切换 / AB 分流', enum: PUBLISH_MODES, default: 'FULL' })
  @IsOptional()
  @IsIn(PUBLISH_MODES, { message: `mode 仅支持：${PUBLISH_MODES.join(' / ')}` })
  mode?: PublishMode;

  @ApiPropertyOptional({
    description: 'AB_TEST 模式下的流量权重（其余权重按比例分摊给其他 ACTIVE 版本）',
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt({ message: 'trafficWeight 必须是整数' })
  @Min(1, { message: 'trafficWeight 最小为 1' })
  @Max(100, { message: 'trafficWeight 最大为 100' })
  trafficWeight?: number;

  @ApiPropertyOptional({ description: 'FULL 模式下是否归档其他 ACTIVE 版本', default: true })
  @IsOptional()
  @IsBoolean({ message: 'archiveOtherActive 必须是布尔值' })
  archiveOtherActive?: boolean;

  @ApiPropertyOptional({ description: '发布说明', maxLength: CHANGE_NOTE_MAX })
  @IsOptional()
  @IsString({ message: 'changeNote 必须是字符串' })
  @Length(0, CHANGE_NOTE_MAX, { message: `changeNote 长度不超过 ${CHANGE_NOTE_MAX}` })
  changeNote?: string;

  @ApiPropertyOptional({ description: '是否在下次调用时记录发布事件到日志（排障用）', default: false })
  @IsOptional()
  @IsBoolean({ message: 'notifyOnCall 必须是布尔值' })
  notifyOnCall?: boolean;
}

// ============================================================================
// POST /api/v1/admin/prompts/{key}/versions/{versionId}/rollback
// ============================================================================

export class RollbackPromptVersionDto {
  @ApiProperty({ description: '回滚原因（审计用）', minLength: CHANGE_NOTE_MIN, maxLength: CHANGE_NOTE_MAX })
  @IsString({ message: 'reason 必须是字符串' })
  @Length(CHANGE_NOTE_MIN, CHANGE_NOTE_MAX, { message: `reason 长度需在 ${CHANGE_NOTE_MIN}–${CHANGE_NOTE_MAX} 之间` })
  reason!: string;

  @ApiPropertyOptional({
    description: '回滚范围：立即全量 / 灰度（保留 10% 对照）',
    enum: REVERT_WINDOWS,
    default: 'ALL',
  })
  @IsOptional()
  @IsIn(REVERT_WINDOWS, { message: `revertWindow 仅支持：${REVERT_WINDOWS.join(' / ')}` })
  revertWindow?: RevertWindow;

  @ApiPropertyOptional({ description: '回滚后 1 小时内是否加强指标监控', default: true })
  @IsOptional()
  @IsBoolean({ message: 'alertOnRegression 必须是布尔值' })
  alertOnRegression?: boolean;
}

// ============================================================================
// POST /api/v1/admin/prompts/{key}/test-render
// ============================================================================

export class TestRenderPromptDto {
  @ApiPropertyOptional({ description: '指定版本（可为 DRAFT，用于发布前预览）；不传取模板生效版本' })
  @IsOptional()
  @IsString({ message: 'versionId 必须是字符串' })
  @Length(1, 36, { message: 'versionId 长度不合法' })
  versionId?: string;

  @ApiProperty({ description: '变量键值对', type: Object })
  @IsObject({ message: 'variables 必须是对象' })
  variables!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'PREVIEW（默认，仅渲染，不调用 LLM）| ACTUAL_CALL（真实调用，消耗成本）',
    enum: RENDER_MODES,
    default: 'PREVIEW',
  })
  @IsOptional()
  @IsIn(RENDER_MODES, { message: `mode 仅支持：${RENDER_MODES.join(' / ')}` })
  mode?: RenderMode;

  @ApiPropertyOptional({ description: '严格校验：缺失必填变量直接报错', default: true })
  @IsOptional()
  @IsBoolean({ message: 'strictValidation 必须是布尔值' })
  strictValidation?: boolean;
}

// ============================================================================
// 路径参数与查询参数
// ============================================================================

export class PromptKeyParamDto {
  @ApiProperty({ description: '模板键', example: 'MBTI_REPORT' })
  @IsString({ message: 'key 必须是字符串' })
  @Length(1, 64, { message: 'key 长度需在 1–64 之间' })
  key!: string;
}

export class PromptVersionParamDto extends PromptKeyParamDto {
  @ApiProperty({ description: '版本 ID' })
  @IsString({ message: 'versionId 必须是字符串' })
  @Length(1, 36, { message: 'versionId 长度不合法' })
  versionId!: string;
}

export class PromptDetailQueryDto {
  @ApiPropertyOptional({ description: '是否返回 Prompt 全文（false 时仅元数据）', type: Boolean, default: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'includeContent 必须是布尔值' })
  includeContent?: boolean;

  @ApiPropertyOptional({ description: '仅返回指定版本号', minimum: 1 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' || value === undefined ? undefined : Number(value)))
  @IsInt({ message: 'version 必须是整数' })
  @Min(1, { message: 'version 最小为 1' })
  version?: number;
}
