/**
 * PasswordService — 管理员密码哈希（Argon2id）
 *
 * 参数取自契约 §3.14.1.1 业务规则 1：`memoryCost 19MB, timeCost 2, parallelism 1`。
 *
 * 为什么是 Argon2id 而不是 bcrypt：Argon2id 同时抗 GPU 暴力破解（内存硬化）
 * 与侧信道攻击，是当前密码哈希的推荐算法；bcrypt 的 72 字节截断与较低的内存成本
 * 在现代硬件上都不够（架构 §14.2）。
 *
 * ## 参数是**契约的一部分**
 *
 * `needsRehash` 用于在参数升级后自动重算：登录时若发现旧哈希用的是旧参数，
 * 就用新参数重新哈希并落库。这样调高成本参数不需要强制所有人改密码。
 */

import { Injectable } from '@nestjs/common';
import { argon2id, hash as argonHash, needsRehash as argonNeedsRehash, verify as argonVerify } from 'argon2';

/** Argon2id 参数（契约 §3.14.1.1） */
const ARGON2_OPTIONS = {
  type: argon2id,
  /** 19 MiB —— 契约写 19MB，Argon2 以 KiB 计 */
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  /** 生成密码哈希 */
  async hash(plainPassword: string): Promise<string> {
    return argonHash(plainPassword, ARGON2_OPTIONS);
  }

  /**
   * 校验密码
   *
   * 任何异常（哈希格式非法、库内部错误）一律返回 `false` 而不抛出 ——
   * 调用方是登录流程，抛异常会让「哈希损坏」表现为 500，从而与「密码错误」
   * 区分开来，等于给攻击者一个账号枚举的旁路。
   */
  async verify(passwordHash: string, plainPassword: string): Promise<boolean> {
    try {
      return await argonVerify(passwordHash, plainPassword);
    } catch {
      return false;
    }
  }

  /** 旧哈希是否需要用当前参数重算（参数升级后自动迁移） */
  needsRehash(passwordHash: string): boolean {
    try {
      return argonNeedsRehash(passwordHash, ARGON2_OPTIONS);
    } catch {
      return true;
    }
  }
}
