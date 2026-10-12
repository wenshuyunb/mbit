/**
 * 管理端认证 DTO
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.1
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/**
 * 新密码强度要求
 *
 * 契约未给出具体策略，但管理端是高权限入口，这里采用「至少 8 位 + 必须同时含
 * 字母与数字」的最低可用标准，并拒绝常见弱口令。
 * 之所以不用「必须含大小写+符号」这类更严的规则：过严的策略会促使管理员
 * 写在便签上或复用同一密码，实际安全性反而下降。
 */
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;

/** 弱口令黑名单（小写比较） */
const WEAK_PASSWORDS = ['password', '12345678', 'admin123', 'soulmap123', 'qwerty123', 'admin@123'];

export class AdminLoginDto {
  @ApiProperty({ description: '登录名（邮箱或工号）', example: 'admin@soulmap.cn', minLength: 3, maxLength: 64 })
  @IsString({ message: 'username 必须是字符串' })
  @Length(3, 64, { message: 'username 长度需在 3–64 之间' })
  username!: string;

  @ApiProperty({ description: '密码', example: 'S0ulM@p#2026Admin', minLength: 8, maxLength: 128 })
  @IsString({ message: 'password 必须是字符串' })
  @Length(8, 128, { message: 'password 长度需在 8–128 之间' })
  password!: string;

  @ApiPropertyOptional({ description: '图形验证码 token（连续失败 3 次后必填）', maxLength: 256 })
  @IsOptional()
  @IsString({ message: 'captchaToken 必须是字符串' })
  @MaxLength(256, { message: 'captchaToken 长度不能超过 256' })
  captchaToken?: string;
}

export class AdminRefreshDto {
  @ApiProperty({ description: '管理员 RefreshToken', minLength: 32, maxLength: 128 })
  @IsString({ message: 'refreshToken 必须是字符串' })
  @Length(32, 128, { message: 'refreshToken 长度需在 32–128 之间' })
  refreshToken!: string;
}

export class AdminChangePasswordDto {
  @ApiProperty({ description: '当前密码', minLength: 8, maxLength: 128 })
  @IsString({ message: 'oldPassword 必须是字符串' })
  @Length(8, 128, { message: 'oldPassword 长度需在 8–128 之间' })
  oldPassword!: string;

  @ApiProperty({ description: '新密码（至少 8 位，且同时包含字母与数字）', minLength: 8, maxLength: 128 })
  @IsString({ message: 'newPassword 必须是字符串' })
  @Length(8, 128, { message: 'newPassword 长度需在 8–128 之间' })
  @Matches(PASSWORD_PATTERN, { message: '新密码需至少 8 位，且同时包含字母与数字' })
  newPassword!: string;
}

/** 新密码是否命中弱口令黑名单 */
export const isWeakPassword = (password: string): boolean => WEAK_PASSWORDS.includes(password.toLowerCase());
