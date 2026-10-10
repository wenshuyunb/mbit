/**
 * 加密服务 — 敏感字段的加解密与摘要工具
 *
 * 用途（架构文档 §14.2）：
 *   · `wechat_accounts.sessionKeyEnc`：微信会话密钥（解密手机号等加密数据所需）
 *   · `users.phoneEnc`：手机号
 *   · `users.phoneHash`：手机号的确定性哈希（用于唯一性校验，不可逆）
 *
 * 算法：AES-256-GCM
 *   选择 GCM 而非 CBC 的原因：GCM 提供**认证加密**（AEAD），
 *   密文被篡改时解密会直接失败，而 CBC 需要额外做 HMAC 否则存在填充预言攻击面。
 *
 * 存储格式（自描述、带版本号，便于后续轮换算法）：
 *   v1.<iv>.<authTag>.<ciphertext>
 *   各段均为 base64url（无 +/ 字符，避免出现在 URL 与日志中时需要转义）
 *
 * 安全约束：
 *   · 主密钥只来自环境变量 `CRYPTO_KEY`（32 字节 base64），**绝不入库、绝不入日志**
 *   · 每次加密使用独立随机 IV（12 字节，GCM 推荐长度），绝不复用
 *   · 解密失败统一抛内部错误，不泄露「是密钥错还是密文坏」的区分信息
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ErrorCode } from '../../common/errors/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import type { AppConfig } from '../../config/config.type';

/** 当前密文格式版本 */
const CIPHER_VERSION = 'v1';

/** GCM 推荐的 IV 长度（字节） */
const IV_LENGTH = 12;

/** AES-256 密钥长度（字节） */
const KEY_LENGTH = 32;

/** GCM 认证标签长度（字节） */
const AUTH_TAG_LENGTH = 16;

/** refresh token 随机字节数（256 bit，架构 §9.2） */
const REFRESH_TOKEN_BYTES = 32;

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer | null;
  /** 确定性哈希用的盐（`CRYPTO_IV_SALT`）；未配置时为 null，加盐哈希不可用 */
  private readonly ivSalt: string | null;

  constructor(configService: ConfigService<AppConfig, true>) {
    const rawKey = configService.get('crypto.key', { infer: true });
    this.key = this.parseKey(rawKey);

    const rawSalt = configService.get('crypto.ivSalt', { infer: true });
    this.ivSalt = typeof rawSalt === 'string' && rawSalt.length > 0 ? rawSalt : null;

    if (this.key === null) {
      // 开发环境允许缺省（相关功能在调用时才报错）；生产环境由配置校验 schema 强制要求
      this.logger.warn('CRYPTO_KEY 未配置或长度非法，敏感字段加解密功能不可用');
    }
    if (this.ivSalt === null) {
      this.logger.warn('CRYPTO_IV_SALT 未配置，手机号等确定性哈希不可用（拒绝写入未加盐摘要）');
    }
  }

  // ==========================================================================
  // 加解密
  // ==========================================================================

  /**
   * 加密明文
   *
   * @param plaintext 待加密内容；空字符串会原样返回（避免对 null 语义做额外编码）
   * @returns `v1.<iv>.<tag>.<ciphertext>`（base64url 分段）
   */
  encrypt(plaintext: string): string {
    const key = this.requireKey();

    // 每次加密使用全新的随机 IV —— GCM 下 IV 复用会直接导致密钥流复用，是致命错误
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      CIPHER_VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * 解密
   *
   * @throws BusinessException 密文格式非法、密钥不匹配或内容被篡改时抛出（对外统一为内部错误）
   */
  decrypt(payload: string): string {
    const key = this.requireKey();

    const parts = payload.split('.');
    if (parts.length !== 4) {
      throw this.decryptFailed('密文格式非法');
    }

    const [version, ivPart, tagPart, dataPart] = parts;

    if (version !== CIPHER_VERSION || ivPart === undefined || tagPart === undefined || dataPart === undefined) {
      throw this.decryptFailed(`不支持的密文版本: ${String(version)}`);
    }

    try {
      const iv = Buffer.from(ivPart, 'base64url');
      const authTag = Buffer.from(tagPart, 'base64url');
      const ciphertext = Buffer.from(dataPart, 'base64url');

      if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
        throw this.decryptFailed('密文分段长度非法');
      }

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      // GCM 的完整性校验在 final() 中完成：密文被篡改会在此抛出
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw this.decryptFailed((error as Error).message);
    }
  }

  /**
   * 解密；失败返回 null 而不是抛异常
   *
   * 适用场景：字段可能为空、可能是历史遗留的明文格式，业务上「解不开」不应中断主流程。
   */
  tryDecrypt(payload: string | null | undefined): string | null {
    if (payload === null || payload === undefined || payload === '') return null;
    try {
      return this.decrypt(payload);
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // 摘要与随机数
  // ==========================================================================

  /**
   * SHA-256 摘要（十六进制）
   *
   * 用途：
   *   · refresh token 落库前哈希（架构 §9.2：服务端只存哈希）
   *   · 手机号确定性哈希（`phoneHash`，支持唯一约束与「是否已绑定」判断）
   *   · 日志中 openid 的脱敏记录（不打印原文）
   */
  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /**
   * 加盐哈希是否可用（`CRYPTO_IV_SALT` 是否已配置）
   *
   * 暴露该探测是为了让调用方能在**任何外部调用之前**快速失败：
   * 缺少盐值是服务端配置问题，与请求无关，不该等到消耗了微信接口配额
   * （或写了一半数据）才发现。
   */
  get saltedHashAvailable(): boolean {
    return this.ivSalt !== null;
  }

  /**
   * 加盐 SHA-256 摘要（用于手机号等**低熵、可枚举**的确定性哈希）
   *
   * 为什么不能用 `sha256`：中国大陆手机号的空间约 10^9 量级，
   * 未加盐摘要可被离线暴力枚举（秒级完成全空间预计算），
   * 那样「只存哈希不存明文」的保护就形同虚设（架构 §14.2）。
   * 盐值来自环境变量，与数据库分离保管 —— 仅拖库无法还原号码。
   *
   * 契约 §3.2.4 规则 1 指定算法为 `SHA-256(phone + CRYPTO_IV_SALT)`。
   *
   * 未配置盐时**拒绝计算**而非退化为无盐摘要：静默降级会产出无法识别
   * 的弱哈希并落库，事后无法区分哪些行的摘要带盐。
   */
  sha256Salted(value: string): string {
    if (this.ivSalt === null) {
      throw new BusinessException(ErrorCode.CONFIG_MISSING, '服务端未配置手机号哈希盐值，暂时无法完成该操作');
    }
    return createHash('sha256').update(`${value}${this.ivSalt}`, 'utf8').digest('hex');
  }

  /**
   * 生成不透明随机令牌（默认 256 bit）
   *
   * 为什么不用 JWT 做 refresh token（架构 §3.1.2 规则 4）：
   *   JWT 自包含，签发后在过期前无法真正吊销；不透明串服务端持有哈希，可即时作废。
   */
  randomToken(bytes: number = REFRESH_TOKEN_BYTES): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** 生成带业务前缀的 refresh token，便于在日志/抓包中识别类型 */
  generateRefreshToken(): string {
    return `rt_${this.randomToken()}`;
  }

  /**
   * 恒定时间比较，防止通过响应时间差逐字节爆破
   *
   * 用于比较：已存储的哈希与待校验的哈希。
   */
  safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');

    // 长度不同时直接返回 false（timingSafeEqual 要求等长，否则抛错）
    if (bufferA.length !== bufferB.length) return false;

    return timingSafeEqual(bufferA, bufferB);
  }

  /** 指定长度与 TTL 的解析结果，便于调用方计算过期时间 */
  getRefreshTokenTtlSeconds(ttl: string): number {
    return parseDurationToSeconds(ttl);
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private requireKey(): Buffer {
    if (this.key === null) {
      throw BusinessException.internal(ErrorCode.CONFIG_MISSING, '服务配置缺失，请联系客服', {
        missing: 'CRYPTO_KEY',
      });
    }
    return this.key;
  }

  private decryptFailed(reason: string): BusinessException {
    // 对外统一为「数据解密失败」，不区分密钥错误 / 密文损坏，避免给攻击者反馈信号
    return BusinessException.internal(ErrorCode.INTERNAL_ERROR, '数据解密失败', {
      cryptoReason: reason,
    });
  }

  private parseKey(rawKey: string): Buffer | null {
    if (!rawKey || rawKey.trim() === '') return null;

    try {
      const key = Buffer.from(rawKey.trim(), 'base64');
      if (key.length !== KEY_LENGTH) {
        this.logger.error(`CRYPTO_KEY 解码后长度为 ${key.length} 字节，要求 ${KEY_LENGTH} 字节（AES-256）`);
        return null;
      }
      return key;
    } catch (error) {
      this.logger.error(`CRYPTO_KEY 不是合法的 base64: ${(error as Error).message}`);
      return null;
    }
  }
}

/**
 * 把 `2h` / `30d` / `15m` / `45s` 这类时长字符串转为秒
 *
 * 支持 @nestjs/jwt 使用的同款简写，避免两处对 TTL 的理解不一致。
 * 无法解析时回退 0（调用方据此走「不设过期」分支，而非静默使用错误值）。
 */
export const parseDurationToSeconds = (ttl: string): number => {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(ttl.trim());
  if (!match) {
    const numeric = Number(ttl);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();

  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return amount * (multipliers[unit] ?? 1);
};
