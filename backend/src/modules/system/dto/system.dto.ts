/**
 * 用户端系统模块的 Query DTO（契约 §3.12）
 *
 * 全局 `ValidationPipe` 开启了 `forbidNonWhitelisted`，因此这里必须把契约里出现的
 * **每一个** query 参数都声明出来 —— 少声明一个，客户端带上它就会收到 `10001`。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** 平台枚举（契约 §3.12.1） */
export const CONFIG_PLATFORMS = ['MINIAPP', 'ADMIN'] as const;
export type ConfigPlatform = (typeof CONFIG_PLATFORMS)[number];

/** 免责声明场景枚举（契约 §3.12.2） */
export const DISCLAIMER_SCENES = ['ALL', 'AI_CHAT', 'REPORT', 'TEST', 'COMPATIBILITY', 'SHARE'] as const;
export type DisclaimerScene = (typeof DISCLAIMER_SCENES)[number];

/** 语言枚举（契约 §3.12.2） */
export const DISCLAIMER_LANGUAGES = ['zh-CN', 'en-US'] as const;
export type DisclaimerLanguage = (typeof DISCLAIMER_LANGUAGES)[number];

/**
 * 语义化版本正则
 *
 * 契约 §3.12.1 的错误码表把「格式非法」单列为 `10017`，但本仓库的错误码表里没有
 * `10017`（见 `common/errors/error-code.ts`，该区间是版本冲突语义），
 * 因此统一用 `10001`（PARAM_INVALID, 400）并在 message 里说明具体格式要求。
 */
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export class SystemConfigQueryDto {
  @ApiPropertyOptional({ description: '客户端版本（x.y.z），用于判断强更', example: '1.4.2' })
  @IsOptional()
  @IsString()
  @Matches(SEMVER_PATTERN, { message: 'clientVersion 需为 x.y.z 语义化版本' })
  clientVersion?: string;

  @ApiPropertyOptional({ description: '平台：MINIAPP（默认，含分享文案）| ADMIN（精简配置）', enum: CONFIG_PLATFORMS })
  @IsOptional()
  @IsIn(CONFIG_PLATFORMS, { message: 'platform 只能是 MINIAPP 或 ADMIN' })
  platform?: ConfigPlatform;

  @ApiPropertyOptional({
    description: '逗号分隔的配置键白名单，用于按需拉取；免责声明不受白名单裁剪（合规要求）',
    example: 'FEATURE_PAYMENT,reportFreePreviewRatio',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'keys 过长' })
  keys?: string;
}

export class DisclaimersQueryDto {
  @ApiPropertyOptional({ description: '场景：按页面取所需文案', enum: DISCLAIMER_SCENES, default: 'ALL' })
  @IsOptional()
  @IsIn(DISCLAIMER_SCENES, { message: 'scene 取值不合法' })
  scene?: DisclaimerScene;

  @ApiPropertyOptional({ description: '语言：zh-CN（默认）| en-US', enum: DISCLAIMER_LANGUAGES, default: 'zh-CN' })
  @IsOptional()
  @IsIn(DISCLAIMER_LANGUAGES, { message: 'language 只能是 zh-CN 或 en-US' })
  language?: DisclaimerLanguage;
}
