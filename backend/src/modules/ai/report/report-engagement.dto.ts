/**
 * 报告扩展接口 DTO（契约 §3.5.4 / §3.5.6 / §3.5.7 / §3.5.8 / §3.5.9）
 *
 * 与 `report.dto.ts` 分开的原因：那个文件服务于已实现的 4 个接口，
 * 混在一起会让"哪条 DTO 属于哪个接口"需要靠前缀猜。新增的 5 个接口的 DTO 集中在这里。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { parseQueryBoolean } from '../../../common/utils/query-boolean.util';
import { UUID_SHAPE_PATTERN } from '../../../common/utils/uuid.util';
import { PDF_EXPORT_TEMPLATES, type PdfExportTemplate } from './report-export.util';
import {
  MAX_REGENERATE_FEEDBACK_LENGTH,
  MAX_REGENERATE_FOCUS,
  REGENERATE_FOCUS_VALUES,
  REGENERATE_REASONS,
  REGENERATE_TONES,
  type RegenerateFocus,
  type RegenerateReason,
  type RegenerateTone,
} from './report-regenerate.util';
import { REPORT_SECTION_KEYS, type ReportSectionKey } from './report-section.util';
import {
  SHARE_CARD_SCENES,
  SHARE_CARD_TEMPLATES,
  type ShareCardScene,
  type ShareCardTemplate,
} from './report-share-card.util';
import { STREAM_DEFAULT_HEARTBEAT_MS, STREAM_MAX_HEARTBEAT_MS, STREAM_MIN_HEARTBEAT_MS } from './report-stream.util';

/**
 * 查询参数布尔值解析
 *
 * ⚠ 这里原先有一份**局部副本**，而它（以及全仓另外 6 份同样的副本）**从未生效过**：
 * 全局 `ValidationPipe` 开了 `enableImplicitConversion`，class-transformer 会
 * **先**按属性的反射类型做隐式转换 —— `Boolean('false') === true`，
 * 于是 `@Transform` 回调拿到的 `value` 已经是 `true`，"判字符串"的分支永远走不到。
 * 实测 `?includeContent=false` → `true`（详见 `common/utils/query-boolean.util.ts` 的文件头）。
 *
 * 现统一改用共享实现：它从 `obj[key]` 读**原始字符串**，因此不受隐式转换影响。
 */
const toBooleanParam = parseQueryBoolean;

/**
 * 报告 ID（UUID 形状校验）
 *
 * 不用 `@IsUUID()`：`class-validator` 的 `isUUID` 只认 v1–v5，而本项目主键是
 * UUIDv7 —— 用会让**所有请求**都 400。
 * 模式已收敛到 `common/utils/uuid.util.ts`：本模块有两个报告 ID DTO
 *（这里是 `ReportIdPathDto`，`report.dto.ts` 里是 `ReportIdParamDto`），
 * 各留一份副本的后果是**同一个 ID 在两个接口上一个能过一个报错**。
 */
export class ReportIdPathDto {
  @ApiProperty({ description: '报告 ID（UUID）', example: '0195f3a2-b24e-7a86-abf1-7dae4b5c6f45' })
  @IsString({ message: '报告 ID 必须是字符串' })
  @Matches(UUID_SHAPE_PATTERN, { message: '报告 ID 不是合法的 UUID' })
  reportId!: string;
}

// ============================================================================
// §3.5.4 GET /reports/{id}/sections
// ============================================================================

export class ReportSectionsQueryDto {
  @ApiPropertyOptional({
    enum: REPORT_SECTION_KEYS,
    description: '只取单个分段（懒加载场景）；不传则返回全部段落',
    example: 'CORE_PORTRAIT',
  })
  @IsOptional()
  @IsIn(REPORT_SECTION_KEYS, { message: 'sectionKey 取值不合法' })
  sectionKey?: ReportSectionKey;

  @ApiPropertyOptional({
    description: '`false` 时只返回分段元数据（目录），不含 `content`',
    example: true,
    default: true,
  })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'includeContent 必须是布尔值' })
  includeContent?: boolean;
}

// ============================================================================
// §3.5.6 GET /reports/{id}/stream
// ============================================================================

export class ReportStreamQueryDto {
  @ApiPropertyOptional({
    description: `心跳间隔（毫秒），范围 ${STREAM_MIN_HEARTBEAT_MS}–${STREAM_MAX_HEARTBEAT_MS}`,
    example: STREAM_DEFAULT_HEARTBEAT_MS,
    minimum: STREAM_MIN_HEARTBEAT_MS,
    maximum: STREAM_MAX_HEARTBEAT_MS,
    default: STREAM_DEFAULT_HEARTBEAT_MS,
  })
  @IsOptional()
  @IsInt({ message: 'heartbeatMs 必须是整数' })
  @Min(STREAM_MIN_HEARTBEAT_MS, { message: `heartbeatMs 不得小于 ${STREAM_MIN_HEARTBEAT_MS}` })
  @Max(STREAM_MAX_HEARTBEAT_MS, { message: `heartbeatMs 不得大于 ${STREAM_MAX_HEARTBEAT_MS}` })
  heartbeatMs?: number;

  @ApiPropertyOptional({
    description: '是否在 `section` 事件中推送**免费预览片段**（绝不推送付费段落正文）',
    example: false,
    default: false,
  })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'includeSectionPreview 必须是布尔值' })
  includeSectionPreview?: boolean;
}

// ============================================================================
// §3.5.7 POST /reports/{id}/regenerate
// ============================================================================

export class RegenerateReportDto {
  @ApiPropertyOptional({
    enum: REGENERATE_TONES,
    description: '新语气',
    example: 'DIRECT',
    default: 'WARM',
  })
  @IsOptional()
  @IsIn(REGENERATE_TONES, { message: 'tone 取值不合法' })
  tone?: RegenerateTone;

  @ApiPropertyOptional({
    enum: REGENERATE_FOCUS_VALUES,
    isArray: true,
    description: `内容侧重，最多 ${MAX_REGENERATE_FOCUS} 个（白名单同 §3.5.1）`,
    example: ['CAREER'],
  })
  @IsOptional()
  @IsArray({ message: 'focus 必须是数组' })
  @ArrayMaxSize(MAX_REGENERATE_FOCUS, { message: `focus 最多 ${MAX_REGENERATE_FOCUS} 个` })
  @IsIn(REGENERATE_FOCUS_VALUES, { each: true, message: 'focus 含非法取值' })
  focus?: RegenerateFocus[];

  @ApiPropertyOptional({
    enum: REGENERATE_REASONS,
    description: '重新生成原因（进入质量抽检）',
    example: 'UNSATISFIED',
    default: 'TONE_CHANGE',
  })
  @IsOptional()
  @IsIn(REGENERATE_REASONS, { message: 'reason 取值不合法' })
  reason?: RegenerateReason;

  @ApiPropertyOptional({
    description: `用户文字反馈，0–${MAX_REGENERATE_FEEDBACK_LENGTH} 字符`,
    example: '希望建议更具体一些',
    maxLength: MAX_REGENERATE_FEEDBACK_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(0, MAX_REGENERATE_FEEDBACK_LENGTH, { message: `feedback 最长 ${MAX_REGENERATE_FEEDBACK_LENGTH} 个字符` })
  feedback?: string;

  @ApiPropertyOptional({
    description: '`true` 保留原报告为历史版本；`false` 覆盖（原记录仍保留在库中）',
    example: true,
    default: true,
  })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'keepOriginal 必须是布尔值' })
  keepOriginal?: boolean;
}

// ============================================================================
// §3.5.8 POST /reports/{id}/export-pdf
// ============================================================================

export class ExportReportPdfDto {
  @ApiPropertyOptional({
    enum: PDF_EXPORT_TEMPLATES,
    description: '排版模板',
    example: 'CLASSIC',
    default: 'CLASSIC',
  })
  @IsOptional()
  @IsIn(PDF_EXPORT_TEMPLATES, { message: 'template 取值不合法' })
  template?: PdfExportTemplate;

  @ApiPropertyOptional({ description: '是否嵌入雷达图 / 维度条', example: true, default: true })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'includeCharts 必须是布尔值' })
  includeCharts?: boolean;

  @ApiPropertyOptional({ description: '是否附测验答题摘要', example: false, default: false })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'includeAnswers 必须是布尔值' })
  includeAnswers?: boolean;

  @ApiPropertyOptional({ description: '是否加水印（含昵称与生成日期，不含敏感信息）', example: true, default: true })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'watermark 必须是布尔值' })
  watermark?: boolean;
}

// ============================================================================
// §3.5.9 POST /reports/{id}/share-card
// ============================================================================

export class GenerateShareCardDto {
  @ApiPropertyOptional({
    enum: SHARE_CARD_TEMPLATES,
    description: '卡片样式',
    example: 'RADAR_CARD',
    default: 'TYPE_CARD',
  })
  @IsOptional()
  @IsIn(SHARE_CARD_TEMPLATES, { message: 'template 取值不合法' })
  template?: ShareCardTemplate;

  @ApiPropertyOptional({
    enum: REPORT_SECTION_KEYS,
    description: '`template = QUOTE_CARD` 时必填；**只允许免费预览段落**（付费段落返回 `10001`）',
    example: 'CORE_PORTRAIT',
  })
  @IsOptional()
  @IsIn(REPORT_SECTION_KEYS, { message: 'quoteSectionKey 取值不合法' })
  quoteSectionKey?: ReportSectionKey;

  @ApiPropertyOptional({ description: '是否叠加小程序码', example: true, default: true })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'showQrCode 必须是布尔值' })
  showQrCode?: boolean;

  @ApiPropertyOptional({ description: '是否显示昵称（`false` 时脱敏为「一位 INFJ」）', example: true, default: true })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'showNickname 必须是布尔值' })
  showNickname?: boolean;

  @ApiPropertyOptional({
    enum: SHARE_CARD_SCENES,
    description: '场景标识，写入分享归因',
    example: 'REPORT',
    default: 'REPORT',
  })
  @IsOptional()
  @IsIn(SHARE_CARD_SCENES, { message: 'scene 取值不合法' })
  scene?: ShareCardScene;

  @ApiPropertyOptional({ description: '忽略缓存强制重新渲染', example: false, default: false })
  @IsOptional()
  @Transform(toBooleanParam)
  @IsBoolean({ message: 'forceRefresh 必须是布尔值' })
  forceRefresh?: boolean;
}
