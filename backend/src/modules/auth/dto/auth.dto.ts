/**
 * 认证相关 DTO
 *
 * 契约来源：docs/API_DESIGN.md §3.1（认证 auth）
 * 校验策略：全局 ValidationPipe 已开启 whitelist + forbidNonWhitelisted，
 *          因此这里只需声明允许的字段与约束，未声明字段会被直接拒绝。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class WechatLoginDto {
  @ApiProperty({
    description: 'wx.login() 返回的临时登录凭证（5 分钟有效且只能用一次）',
    example: '081Kx3Ga1XyZqL0mNpQrStUvWxYzAbCd',
    minLength: 1,
    maxLength: 128,
  })
  @IsString({ message: 'code 必须是字符串' })
  @Length(1, 128, { message: 'code 长度必须在 1–128 之间' })
  code!: string;

  @ApiPropertyOptional({
    description: '设备指纹，用于登录审计与风控',
    example: 'd9f1c3a7e5b24f60',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'deviceId 必须是字符串' })
  @Length(8, 64, { message: 'deviceId 长度必须在 8–64 之间' })
  deviceId?: string;

  @ApiPropertyOptional({ description: '调用端标识', enum: ['miniapp'], default: 'miniapp' })
  @IsOptional()
  @IsIn(['miniapp'], { message: 'platform 目前仅支持 miniapp' })
  platform?: 'miniapp';

  @ApiPropertyOptional({
    description: '邀请码（8 位 Base32），用于裂变归因，不影响登录成败',
    example: 'K7M2XQ9V',
    minLength: 8,
    maxLength: 8,
  })
  @IsOptional()
  @IsString({ message: 'inviterCode 必须是字符串' })
  @Length(8, 8, { message: 'inviterCode 必须是 8 位' })
  inviterCode?: string;

  @ApiPropertyOptional({
    description: '年龄声明；提交后 < 18 岁将禁用恋爱匹配模块',
    example: 26,
    minimum: 1,
    maximum: 120,
  })
  @IsOptional()
  @IsInt({ message: 'ageDeclared 必须是整数' })
  @Min(1, { message: 'ageDeclared 最小为 1' })
  @Max(120, { message: 'ageDeclared 最大为 120' })
  ageDeclared?: number;
}

export class RefreshTokenDto {
  @ApiProperty({
    description: '上次登录/刷新返回的 RefreshToken（每次刷新都会更换）',
    example: 'rt_9f2b7c41ae6d8305bf41c7d2e9a05b3f8c6d14e27a90b35c',
    minLength: 32,
    maxLength: 128,
  })
  @IsString({ message: 'refreshToken 必须是字符串' })
  @Length(32, 128, { message: 'refreshToken 长度必须在 32–128 之间' })
  refreshToken!: string;

  @ApiPropertyOptional({
    description: '设备指纹；与签发时不一致仅记录审计，不阻断（用户换机场景）',
    example: 'd9f1c3a7e5b24f60',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: 'deviceId 必须是字符串' })
  @Length(8, 64, { message: 'deviceId 长度必须在 8–64 之间' })
  deviceId?: string;
}

export class LogoutDto {
  @ApiPropertyOptional({
    description: '指定撤销的 RefreshToken；不传时撤销当前 AccessToken 对应的会话',
    example: 'rt_3c8e1d5a7b24f09e6a1c8d3b5f7092e4ab6d15c83f02e97d',
    minLength: 32,
    maxLength: 128,
  })
  @IsOptional()
  @IsString({ message: 'refreshToken 必须是字符串' })
  @Length(32, 128, { message: 'refreshToken 长度必须在 32–128 之间' })
  refreshToken?: string;

  @ApiPropertyOptional({
    description: '为 true 时等价于 /auth/logout-all（推荐直接调用 logout-all）',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'allDevices 必须是布尔值' })
  allDevices?: boolean;
}
