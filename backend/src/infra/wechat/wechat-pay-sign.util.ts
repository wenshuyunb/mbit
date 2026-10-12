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
 * ## 两处待签名字符串的格式差异（都只差一个字符，但错了就永远签不对）
 *
 * ```
 * 请求 Authorization 头：  HTTP方法\nURL\ntimestamp\nnonce_str\nbody\n
 * 小程序 paySign：          appId\ntimeStamp\nnonceStr\npackage\n
 * ```
 *
 * ⚠ 请求头这一处曾经被写成 `mchid\nnonce_str\ntimestamp\nbody\n`（**缺少方法、URL，
 * 且把 mchid 混进待签名串**）—— 那不符合微信支付 v3 规范，用它对真实微信请求
 * 只会拿到 `401 SIGN_ERROR`。该错误实现已删除，唯一实现见
 * `buildV3SignaturePayload`；错误信息里不会提示"待签名串拼错了"，
 * 所以这一处的正确性只能靠**照规范实现 + 单测锁死**，不能靠联调发现。
 *
 * 回调验签的格式在 `wechat-pay-crypto.util.ts`（`timestamp\nnonce\nbody\n`），
 * 与请求方向不同 —— 两个方向照抄彼此是历史上的高频事故点。
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

// ============================================================================
// 请求签名（v3 官方规范）
// ============================================================================
//
// ⚠ 这里曾存在两个函数：`buildRequestSignaturePayload` 与 `buildAuthorizationHeader`，
// 它们签的是 `mchid\nnonce_str\ntimestamp\nbody\n` —— 那是**旧版（v2）**的思路，
// 不含请求方法与 URL，不符合微信支付 v3 的签名规范。用它们请求真实微信必然得到
// `401 SIGN_ERROR`，而响应里不会告诉你「待签名串拼错了」。
// 也就是说：**用它们的路径（含 JSAPI 预下单）根本不可能成功**，属发布级阻断缺陷。
//
// 它们已被**删除**而不是标注废弃：对错误实现的「保留但标记 deprecated」在实践中
// 等于给它留了复用入口，而一旦被复用，故障现象只是「签名失败」，排查成本极高。
// 唯一实现见下方 `buildV3SignaturePayload` / `buildV3AuthorizationHeader`。

// ============================================================================
// 微信支付 v3 **官方**请求签名（查单 / 关单 / 退款）
// ============================================================================

/**
 * 构造 v3 官方规范的待签名字符串
 *
 * ```
 * HTTP方法\nURL\ntimestamp\nnonce_str\nbody\n
 * ```
 *
 * ⚠ **与上面 `buildRequestSignaturePayload` 的区别不是风格问题，而是对错问题**：
 * 上面那个函数签的是 `mchid\nnonce\ntimestamp\nbody\n`，那是**旧版（v2）**的思路，
 * 并不符合微信支付 v3 的 [`签名生成`](https://pay.weixin.qq.com/docs/merchant/development/interface-rules/signature-generation.html)
 * 规范 —— v3 要求把**请求方法**与**URL（含 query）**放进待签字符串。
 * 用错格式的表现是微信返回 `401 SIGN_ERROR`，而响应里不会告诉你"拼错了待签名串"。
 *
 * 为什么**新增**函数而不是改掉旧的那个：`createJsapiPrepay` 已在生产路径上，
 * 改动它属于「在没有真实商户号可验证的情况下改动资金链路」；而本轮新增的查单 /
 * 关单 / 退款都是**新代码**，必须一次签对。旧函数的修正另立专项（已列入交付简报名单）。
 *
 * @param urlPath 形如 `/v3/pay/transactions/out-trade-no/SM20260214A7K3M9Q1?mchid=1900000109`
 *                —— **必须带 query string**，且路径与真实请求逐字符一致（含编码形态）
 */
export const buildV3SignaturePayload = (params: {
  method: string;
  urlPath: string;
  timestamp: string;
  nonceStr: string;
  body: string;
}): string =>
  `${params.method.toUpperCase()}\n${params.urlPath}\n${params.timestamp}\n${params.nonceStr}\n${params.body}\n`;

/** `buildV3AuthorizationHeader` 的入参 */
export interface BuildV3AuthorizationParams {
  readonly mchId: string;
  readonly serialNo: string;
  readonly privateKeyPem: string;
  /** HTTP 方法（`GET` / `POST`） */
  readonly method: string;
  /** 请求路径 **含 query string** */
  readonly urlPath: string;
  /** 请求体 JSON 字符串；GET 传空串 */
  readonly body: string;
  readonly now: Date;
}

/**
 * 构造 v3 官方规范的 `Authorization` 头
 *
 * 头本身的五个字段与旧函数相同（微信对头的格式没有变），差别只在**签名内容**。
 */
export const buildV3AuthorizationHeader = (params: BuildV3AuthorizationParams): string => {
  const timestamp = requestTimestamp(params.now);
  const nonceStr = randomNonce();
  const payload = buildV3SignaturePayload({
    method: params.method,
    urlPath: params.urlPath,
    timestamp,
    nonceStr,
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
