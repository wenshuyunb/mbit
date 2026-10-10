/**
 * 微信支付 v3 回调验签与解密（纯函数，无 I/O、无依赖注入，可 100% 单测）
 *
 * ## 为什么必须与微信登录的解密分开
 *
 * 这是**第三套**加密算法，与另外两套互不兼容：
 *
 * | 用途               | 算法                     | 密钥                              |
 * | ------------------ | ------------------------ | --------------------------------- |
 * | 项目自有敏感字段   | AES-256-GCM              | `CRYPTO_KEY`                      |
 * | 微信登录手机号     | AES-128-CBC + PKCS#7     | `session_key`（16 字节）          |
 * | **微信支付回调**   | **AES-256-GCM**          | **`apiV3Key`（32 字节 ASCII）**   |
 *
 * 后两者都是"微信的"，但密钥来源、长度、算法全不同。混在一处最典型的误用是
 * 拿 `session_key` 去解支付回调 —— 那会解出乱码或直接抛错，而**验签通过但解密失败**
 * 的组合极难判断到底是哪一步错了。因此支付侧单独成文件。
 *
 * ## 安全底线（顺序不能反）
 *
 * 支付回调来自公网，**必须先验签再解密再使用任何字段**。
 * 反过来的话，攻击者可以直接构造一个"已支付"的密文体（用自己生成的密钥加密），
 * 服务端解密成功并发放权益 —— 这是支付系统最经典的漏洞。
 */

import { createDecipheriv, createVerify, timingSafeEqual } from 'node:crypto';

/** 验签或解密失败（输入不合法、签名不匹配、密文损坏、明文非 JSON） */
export class WechatPayCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WechatPayCryptoError';
  }
}

/** AES-256-GCM 的密钥长度（字节） */
const AES_GCM_KEY_BYTES = 32;

/** GCM 认证标签长度（字节）—— 密文的**末 16 字节** */
const GCM_TAG_BYTES = 16;

/** GCM nonce 长度（`apiV3Key` 模式下固定 12 字节 ASCII） */
const GCM_NONCE_BYTES = 12;

/**
 * 回调时间戳允许的最大偏差（秒）
 *
 * 微信官方建议 5 分钟。**必须校验**：只验签不校验时间的话，攻击者可以重放
 * 一个曾经合法的回调体（例如用户已退款的旧订单），签名依然正确 ——
 * 验签解决的是"是不是微信发的"，不解决"是不是现在发的"。
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

/** 验签入参 */
export interface VerifyWechatPaySignatureParams {
  /** 请求头 `Wechatpay-Timestamp` */
  readonly timestamp: string;
  /** 请求头 `Wechatpay-Nonce` */
  readonly nonce: string;
  /** **原始请求体字符串**（不能是 `JSON.stringify(parsed)`，会改变字节） */
  readonly body: string;
  /** 请求头 `Wechatpay-Signature`（base64） */
  readonly signature: string;
  /** 平台证书公钥（PEM） */
  readonly platformCertificatePem: string;
}

/**
 * 待签名字符串
 *
 * 格式固定为 `时间戳\n随机串\n请求体\n`（**末尾的换行不能少**）。
 * 少了它签名永远不匹配，而错误表现只是"验签失败"，很难看出是格式问题 ——
 * 因此把构造抽成独立函数并单测。
 */
export const buildWechatPaySignaturePayload = (timestamp: string, nonce: string, body: string): string =>
  `${timestamp}\n${nonce}\n${body}\n`;

/**
 * 校验回调签名（RSA-SHA256）
 *
 * @returns 验签是否通过。**不抛错**：调用方只需区分"通过/不通过"，
 *          而失败原因（证书格式错、base64 非法）不应泄露给外部
 */
export const verifyWechatPaySignature = (params: VerifyWechatPaySignatureParams): boolean => {
  try {
    const payload = buildWechatPaySignaturePayload(params.timestamp, params.nonce, params.body);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(payload, 'utf8');

    return verifier.verify(params.platformCertificatePem, Buffer.from(params.signature, 'base64'));
  } catch {
    // 证书格式非法、签名不是 base64 等都会走到这里。
    // 一律视为"验签不通过"—— 对内是明确的失败，对外不暴露细节
    return false;
  }
};

/**
 * 回调时间戳是否在容忍窗口内
 *
 * 用**双向**比较（绝对值）：既拒绝过旧的（重放），也拒绝过新的
 * （服务器时钟被校正到未来时，只判"太旧"会放行一批未来时间戳的回调）。
 */
export const isWechatPayTimestampFresh = (
  timestamp: string,
  now: Date,
  toleranceSeconds = TIMESTAMP_TOLERANCE_SECONDS,
): boolean => {
  // 必须全是数字：`Number('')` 是 0，会把空字符串当成 1970 年 —— 那会被判为"太旧"而拒绝，
  // 方向上是安全的，但 `Number(' 12 ')` 这类宽容解析会让边界判断变得不可预测
  if (!/^\d+$/.test(timestamp)) return false;

  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return false;

  const diff = Math.abs(now.getTime() / 1000 - seconds);

  return diff <= toleranceSeconds;
};

/** 解密入参 */
export interface DecryptWechatPayResourceParams {
  /** `resource.ciphertext`（base64，**含末 16 字节认证标签**） */
  readonly ciphertext: string;
  /** `resource.nonce`（12 字节 ASCII） */
  readonly nonce: string;
  /** `resource.associated_data`（可为空字符串） */
  readonly associatedData: string;
  /** APIv3 密钥（32 字节 ASCII） */
  readonly apiV3Key: string;
}

/**
 * 解密回调的 `resource` 字段（AES-256-GCM）
 *
 * 两个容易写错的地方：
 *
 * ① **认证标签在密文末尾**。微信把 GCM 的 tag 直接拼在 `ciphertext` 的末尾
 *    （共 16 字节），不像标准分字段传输。忘记切分就会在 `setAuthTag` 时抛错，
 *    或者更糟：把 tag 当密文解出一段多余字节。
 *
 * ② **密钥与 nonce 是 ASCII 直取字节**，不是 base64 解码。
 *    `apiV3Key` 是 32 个可见字符的字符串本身作为密钥。
 *
 * 失败一律抛 `WechatPayCryptoError`，**不携带任何明文或密钥片段**。
 */
export const decryptWechatPayResource = (params: DecryptWechatPayResourceParams): Record<string, unknown> => {
  const key = Buffer.from(params.apiV3Key, 'utf8');
  if (key.length !== AES_GCM_KEY_BYTES) {
    throw new WechatPayCryptoError(`apiV3Key 必须为 ${AES_GCM_KEY_BYTES} 字节`);
  }

  const nonce = Buffer.from(params.nonce, 'utf8');
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new WechatPayCryptoError(`nonce 必须为 ${GCM_NONCE_BYTES} 字节`);
  }

  const raw = Buffer.from(params.ciphertext, 'base64');
  if (raw.length <= GCM_TAG_BYTES) {
    throw new WechatPayCryptoError('密文长度不足（缺少认证标签）');
  }

  const ciphertext = raw.subarray(0, raw.length - GCM_TAG_BYTES);
  const authTag = raw.subarray(raw.length - GCM_TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    // 空字符串也要设置：`setAAD` 与加密端的 AAD 必须完全一致，
    // 不设置与设置空串在 GCM 里是**不同的**输入
    decipher.setAAD(Buffer.from(params.associatedData, 'utf8'));

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new WechatPayCryptoError('回调明文不是 JSON 对象');
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WechatPayCryptoError) throw error;

    // GCM 认证失败（密钥错、密文被篡改、AAD 不一致）都会走到这里
    throw new WechatPayCryptoError('回调解密失败');
  }
};

/**
 * 常量时间比较（用于回调里的商户号、订单号等标识比对）
 *
 * 普通 `===` 会因为提前返回而泄露前缀匹配长度。对支付回调里的敏感标识
 * （如 `mchid`）应使用本函数 —— 虽然单次泄露的信息量极小，
 * 但这是支付代码里应保持的习惯。
 */
export const safeEquals = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  // 长度不同时 timingSafeEqual 会抛错；长度本身不是秘密，可以直接返回 false
  if (bufferA.length !== bufferB.length) return false;

  return timingSafeEqual(bufferA, bufferB);
};
