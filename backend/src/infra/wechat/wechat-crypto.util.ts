/**
 * 微信加密数据解密（纯函数，无 I/O、无依赖注入，可 100% 单测）
 *
 * 为什么单独成文件：这是与项目自有加密体系**完全不同**的一套算法 ——
 * WeChat 用 `AES-128-CBC` + PKCS#7，密钥是 `session_key`（base64，16 字节），
 * 而项目自有字段用 `AES-256-GCM`（见 `CryptoService`）。
 * 两套算法混在一个模块里极易被误用（例如拿 CRYPTO_KEY 去解微信数据），
 * 因此把微信侧解密隔离在此，并只暴露一个语义明确的入口。
 *
 * 失败一律抛 `WechatDecryptError`，**不携带任何明文或密钥片段** ——
 * 调用方把它转成业务错误码即可，异常信息不会出现在响应里。
 */

import { createDecipheriv } from 'node:crypto';

/** 解密失败（输入不合法、密钥不匹配、密文损坏、明文非 JSON） */
export class WechatDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WechatDecryptError';
  }
}

/** AES-128-CBC 的密钥与 IV 长度（字节） */
const AES_KEY_BYTES = 16;
const AES_IV_BYTES = 16;

/** `decryptWechatEncryptedData` 入参 */
export interface DecryptWechatDataParams {
  /** 微信返回的密文（base64） */
  readonly encryptedData: string;
  /** 微信返回的初始向量（base64，16 字节） */
  readonly iv: string;
  /** 解密密钥（base64，16 字节）—— 来自 `wechat_accounts.sessionKeyEnc` 解密结果 */
  readonly sessionKey: string;
}

/**
 * 校验并解码 base64
 *
 * 微信侧字段是标准 base64。这里额外做「往返一致」校验：
 * `Buffer.from` 对非法 base64 会**静默截断**而不是抛错，
 * 若不做校验，`iv` 传 `"xx"` 会解出长度 1 的缓冲并在后续抛出一个含义不明的错误。
 */
const decodeBase64 = (value: string, label: string, expectedBytes: number): Buffer => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WechatDecryptError(`${label} 缺失`);
  }

  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== expectedBytes) {
    throw new WechatDecryptError(`${label} 长度不是 ${expectedBytes} 字节`);
  }
  // 往返校验：合法 base64 重新编码后应与输入一致（忽略 padding 差异）
  if (buffer.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new WechatDecryptError(`${label} 不是合法 base64`);
  }

  return buffer;
};

/**
 * 解密微信 `encryptedData`，返回解析后的对象
 *
 * 用于 `getPhoneNumber` 的旧版加密数据路径（新版推荐用 `code` 换取）。
 * 明文在函数作用域结束时即被丢弃，调用方负责立即加密落库（架构 §14.2）。
 */
export const decryptWechatEncryptedData = (params: DecryptWechatDataParams): Record<string, unknown> => {
  const keyBuffer = decodeBase64(params.sessionKey, 'session_key', AES_KEY_BYTES);
  const ivBuffer = decodeBase64(params.iv, 'iv', AES_IV_BYTES);

  if (typeof params.encryptedData !== 'string' || params.encryptedData.length === 0) {
    throw new WechatDecryptError('encryptedData 缺失');
  }

  let plaintext: string;
  try {
    const decipher = createDecipheriv('aes-128-cbc', keyBuffer, ivBuffer);
    // 微信使用 PKCS#7 填充，Node 默认开启 autoPadding，与之一致
    decipher.setAutoPadding(true);
    const cipherBuffer = Buffer.from(params.encryptedData, 'base64');
    plaintext = Buffer.concat([decipher.update(cipherBuffer), decipher.final()]).toString('utf8');
  } catch {
    // 不区分「密钥错 / 密文坏 / padding 非法」—— 对外都是解密失败
    throw new WechatDecryptError('解密失败');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new WechatDecryptError('明文不是合法 JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WechatDecryptError('明文结构不是对象');
  }

  return parsed as Record<string, unknown>;
};
