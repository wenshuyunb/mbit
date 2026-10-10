/**
 * 微信支付**商户侧**签名（纯函数，无 I/O、可 100% 单测）
 *
 * 与 `wechat-pay-crypto.util.ts` 的分工：
 *   · 那个文件是**回调方向**（微信 → 我们）：用平台证书**验签**、用 `apiV3Key` 解密
 *   · 本文件是**请求方向**（我们 → 微信）：用**商户私钥**签名、并构造小程序端拉起支付所需的参数
 *
 * 两个方向用的是**不同的密钥**（平台证书公钥 vs 商户私钥），
 * 且待签名字符串的格式也不同。混在一处最典型的事故是拿平台证书去签请求 ——
 * 那会得到一个"格式正确但微信拒绝"的 401，而错误信息里不会告诉你用错了密钥。
 *
 * ## 三处待签名字符串的格式差异（都只差一个字符，但错了就永远签不对）
 *
 * ```
 * 请求 Authorization 头：  mchid\nnonce_str\ntimestamp\nbody\n
 * 小程序 paySign：          appId\ntimeStamp\nnonceStr\npackage\n
 * 回调验签：                timestamp\nnonce\nbody\n
 * ```
 */

import { createSign, randomBytes } from 'node:crypto';

import { WechatPayCryptoError } from './wechat-pay-crypto.util';

/** 签名算法标识（微信支付 v3 固定值） */
const SIGN_TYPE = 'WECHATPAY2-SHA256-RSA2048';

/** 请求头里使用的时间戳精度：秒 */
export const requestTimestamp = (now: Date): string => String(Math.floor(now.getTime() / 1000));

/**
 * 随机串（微信要求 32 位以内、无特殊字符）
 *
 * 用 `randomBytes` 而非 `Math.random`：nonce 参与签名，
 * 可预测的 nonce 会让重放攻击更容易构造。
 */
export const randomNonce = (): string => randomBytes(16).toString('hex');

/** 用商户私钥做 RSA-SHA256 签名（返回 base64） */
export const signWithMerchantKey = (payload: string, privateKeyPem: string): string => {
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(payload, 'utf8');

    return signer.sign(privateKeyPem, 'base64');
  } catch (error) {
    // 私钥格式错（换行丢失、被转义）是最常见的原因：环境变量里存 PEM 时
    // `\n` 常常是字面量而不是换行。这里给出可操作的提示
    throw new WechatPayCryptoError(
      `商户私钥签名失败（检查 PEM 换行是否正确）：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }
};

/**
 * 构造请求的待签名字符串
 *
 * ⚠ **末尾的换行不能少**，顺序也固定为 `mchid → nonce_str → timestamp → body`。
 * 与回调验签的顺序（`timestamp → nonce → body`）不同 —— 照抄回调那边的格式
 * 会得到 401，而微信不会告诉你待签名字符串拼错了。
 */
export const buildRequestSignaturePayload = (params: {
  mchId: string;
  nonceStr: string;
  timestamp: string;
  body: string;
}): string => `${params.mchId}\n${params.nonceStr}\n${params.timestamp}\n${params.body}\n`;

/** `Authorization` 头的构造入参 */
export interface BuildAuthorizationParams {
  readonly mchId: string;
  /** 商户证书序列号 */
  readonly serialNo: string;
  readonly privateKeyPem: string;
  /** 请求体（JSON 字符串）。GET 请求传空串 */
  readonly body: string;
  /** 注入时间便于测试确定性 */
  readonly now: Date;
}

/**
 * 构造 `Authorization` 请求头
 *
 * 格式：`WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",signature="...",timestamp="...",serial_no="..."`
 *
 * 五个字段的名称与顺序都由微信规定（`nonce_str` 是下划线、`serial_no` 也是），
 * 写错任何一个微信都会返回 401。
 */
export const buildAuthorizationHeader = (params: BuildAuthorizationParams): string => {
  const timestamp = requestTimestamp(params.now);
  const nonceStr = randomNonce();
  const payload = buildRequestSignaturePayload({
    mchId: params.mchId,
    nonceStr,
    timestamp,
    body: params.body,
  });
  const signature = signWithMerchantKey(payload, params.privateKeyPem);

  return (
    `${SIGN_TYPE} ` +
    `mchid="${params.mchId}",` +
    `nonce_str="${nonceStr}",` +
    `signature="${signature}",` +
    `timestamp="${timestamp}",` +
    `serial_no="${params.serialNo}"`
  );
};

/**
 * 构造小程序 `wx.requestPayment` 所需的参数
 *
 * ⚠ 待签名字符串是 `appId\ntimeStamp\nnonceStr\npackage\n` ——
 * 注意这里是**驼峰 `timeStamp`**（`wx.requestPayment` 的字段名），
 * 而请求头那边是**下划线 `timestamp`**。两个方向的命名规则不同，
 * 照抄会签出一个永远验不过的 `paySign`，而开发者工具只会提示"支付验证签名失败"。
 */
export const buildMiniAppPayParams = (params: {
  appId: string;
  prepayId: string;
  privateKeyPem: string;
  now: Date;
}): { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string } => {
  const timeStamp = requestTimestamp(params.now);
  const nonceStr = randomNonce();
  const packageValue = `prepay_id=${params.prepayId}`;

  const payload = `${params.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  const paySign = signWithMerchantKey(payload, params.privateKeyPem);

  return { timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign };
};

/**
 * 商户私钥的环境变量还原
 *
 * `.env` 里存 PEM 时换行通常被写成字面量 `\n`（而非真实换行），
 * `readFileSync` 之外的读取路径都需要这一步还原。缺少它会让
 * `createSign` 抛出一个与"密钥内容"完全无关的错误。
 */
export const normalizePemKey = (raw: string): string => {
  const trimmed = raw.trim();

  // 已经是多行 PEM 就直接用
  if (trimmed.includes('\n')) return trimmed;

  // 单行形态：把字面量 `\n` 还原成真实换行，并补上首尾行
  const withNewlines = trimmed.replace(/\\n/g, '\n');
  if (withNewlines.includes('\n')) return withNewlines;

  throw new WechatPayCryptoError('私钥格式不合法（既不是多行 PEM，也不含可还原的换行）');
};
