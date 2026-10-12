/**
 * 微信支付服务（仅验签与解密；不涉及订单与权益）
 *
 * 与 `WechatService`（登录侧）分开：两者的密钥、证书与算法都不同，
 * 合在一个类里最典型的事故是拿登录的 `session_key` 去解支付回调。
 *
 * **平台证书读取带缓存**：证书文件在磁盘上，每个回调都读一次既慢又无意义。
 * 缓存的失效策略是"读失败就重读"——证书轮换时文件会先变化，
 * 若一直用进程启动时缓存的那份，轮换后所有回调都会验签失败。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';

import type { AppConfig } from '../../config/config.type';
import { buildMiniAppPayParams, buildV3AuthorizationHeader, normalizePemKey } from './wechat-pay-sign.util';
import {
  WechatPayCryptoError,
  decryptWechatPayResource,
  isWechatPayTimestampFresh,
  safeEquals,
  verifyWechatPaySignature,
} from './wechat-pay-crypto.util';

/** 回调请求头（Nest 会转成小写键） */
export interface WechatPayCallbackHeaders {
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly signature: string | undefined;
  readonly serial: string | undefined;
}

/** JSAPI 下单接口地址 */
const WECHAT_PAY_JSAPI_URL = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';

/**
 * 预下单的**请求路径**（v3 签名用）
 *
 * 从上面的 URL 派生出「path + query」而不是另写一份字符串：v3 的待签字符串
 * 要求 URL 与真实请求**逐字符一致**，两处各写一份迟早漂移，
 * 而漂移的表现只是微信回 `401 SIGN_ERROR` —— 不会告诉你"路径拼错了"。
 */
const WECHAT_PAY_JSAPI_PATH = (() => {
  const parsed = new URL(WECHAT_PAY_JSAPI_URL);
  return `${parsed.pathname}${parsed.search}`;
})();

/** v3 API 基址（查单 / 关单 / 退款都在其下） */
const WECHAT_PAY_API_BASE = 'https://api.mch.weixin.qq.com';

/** 主动查单路径（不含 query，`mchid` 由调用处拼接） */
const V3_TRANSACTION_PATH = (outTradeNo: string): string =>
  `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}`;

/** 关单路径 */
const V3_CLOSE_PATH = (outTradeNo: string): string =>
  `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;

/** 退款申请路径 */
const V3_REFUND_CREATE_PATH = '/v3/refund/domestic/refunds';

/** 退款查询路径 */
const V3_REFUND_QUERY_PATH = (outRefundNo: string): string =>
  `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`;

/**
 * 失败分类
 *
 * 这个分类直接决定**资损口径**，不是日志分类：
 *   · `REJECTED`   —— 微信明确拒绝（参数错、余额不足、订单不存在），重试无用 → 可安全置 FAILED 并释放额度
 *   · `NOT_FOUND`  —— 资源在微信侧不存在（查单/查退款 404）
 *   · `TRANSIENT`  —— 网络超时 / 5xx / 限流：**请求可能已被微信受理**，
 *                    此时置 FAILED 就会造出「钱退了但本地记录失败」→ 调用方必须保持处理中并靠查询对账
 *   · `NOT_CONFIGURED` —— 商户配置缺失
 */
export type WechatPayApiFailureKind = 'NOT_CONFIGURED' | 'TRANSIENT' | 'REJECTED' | 'NOT_FOUND';

/** 微信支付 v3 接口错误（携带可判定重试语义的分类） */
export class WechatPayApiError extends Error {
  public readonly kind: WechatPayApiFailureKind;
  public readonly httpStatus: number | null;
  /** 微信返回的业务错误码（如 `PARAM_ERROR` / `SYSTEM_ERROR`） */
  public readonly wechatCode: string | null;

  constructor(
    kind: WechatPayApiFailureKind,
    message: string,
    options?: { httpStatus?: number | null; wechatCode?: string | null },
  ) {
    super(message);
    this.name = 'WechatPayApiError';
    this.kind = kind;
    this.httpStatus = options?.httpStatus ?? null;
    this.wechatCode = options?.wechatCode ?? null;
  }
}

/** 主动查单结果（只保留订单履约会用到的字段） */
export interface WechatPayTransaction {
  /** `SUCCESS` / `REFUND` / `NOTPAY` / `CLOSED` / `REVOKED` / `USERPAYING` / `PAYERROR` */
  readonly tradeState: string;
  readonly tradeStateDesc: string | null;
  readonly transactionId: string | null;
  readonly successTime: string | null;
  /** 订单总金额（分）—— 与本地 `orders.paidAmount` 比对，**绝不作为记账依据** */
  readonly totalAmount: number | null;
  readonly payerTotal: number | null;
  readonly payerOpenid: string | null;
  readonly bankType: string | null;
  readonly tradeType: string | null;
}

/** 关单结果（关单失败不阻断本地关单，因此用返回值而不是抛错表达） */
export interface WechatPayCloseResult {
  /** 微信侧确认已关闭（含"本来就已经关闭"） */
  readonly closed: boolean;
  /** 该订单在微信侧压根不存在（从未预支付成功），等同于无需关闭 */
  readonly notFound: boolean;
  readonly note: string;
}

/** 退款单状态（微信口径） */
export type WechatPayRefundState = 'SUCCESS' | 'PROCESSING' | 'CLOSED' | 'ABNORMAL' | 'UNKNOWN';

/** 退款结果 */
export interface WechatPayRefundResult {
  readonly wechatRefundId: string | null;
  readonly outRefundNo: string;
  readonly status: WechatPayRefundState;
  readonly successTime: string | null;
  /** 实际退款金额（分） */
  readonly refundAmount: number | null;
  /** 原订单总额（分） */
  readonly totalAmount: number | null;
  /** 用户实际到账金额（分） */
  readonly payerRefund: number | null;
  readonly userReceivedAccount: string | null;
  readonly raw: Record<string, unknown>;
}

/** 请求超时（毫秒）—— 支付接口不宜久等，超时后由用户重试 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 主动查单的超时（契约 §3.9.5：5s） */
const QUERY_TIMEOUT_MS = 5_000;

/** 处理结果 */
export type WechatPayCallbackOutcome =
  { readonly ok: true; readonly resource: Record<string, unknown> } | { readonly ok: false; readonly reason: string };

@Injectable()
export class WechatPayService {
  private readonly logger = new Logger(WechatPayService.name);
  private cachedCertificate: string | null = null;
  private cachedPrivateKey: string | null = null;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  /** 是否已配置（未配置时回调一律拒绝，而不是"跳过校验放行"） */
  get isConfigured(): boolean {
    return this.apiV3Key !== null && this.mchId !== null && this.platformCertPath !== null;
  }

  get mchId(): string | null {
    return this.configService.get('wechatPay.mchId', { infer: true }) ?? null;
  }

  private get apiV3Key(): string | null {
    return this.configService.get('wechatPay.apiV3Key', { infer: true }) ?? null;
  }

  private get platformCertPath(): string | null {
    return this.configService.get('wechatPay.platformCertPath', { infer: true }) ?? null;
  }

  /**
   * 处理回调：验签 → 校时间 → 解密
   *
   * **任何一步失败都不返回细节**：`reason` 只用于日志，回调响应一律是
   * "失败"——把"签名不匹配"还是"时间戳过期"告诉调用方，等于给攻击者提供反馈。
   */
  handleCallback(rawBody: string, headers: WechatPayCallbackHeaders): WechatPayCallbackOutcome {
    const apiV3Key = this.apiV3Key;
    const mchId = this.mchId;

    if (apiV3Key === null || mchId === null) {
      this.logger.error('微信支付未配置（缺少 apiV3Key 或 mchId），回调已拒绝');

      return { ok: false, reason: 'NOT_CONFIGURED' };
    }

    const { timestamp, nonce, signature } = headers;
    if (timestamp === undefined || nonce === undefined || signature === undefined) {
      return { ok: false, reason: 'MISSING_HEADER' };
    }

    // 时间戳先校：过期的通知连验签都不必做（省一次 RSA 运算，
    // 也避免把大量重放请求的算力消耗掉）
    if (!isWechatPayTimestampFresh(timestamp, new Date())) {
      return { ok: false, reason: 'STALE_TIMESTAMP' };
    }

    const certificate = this.loadPlatformCertificate();
    if (certificate === null) {
      return { ok: false, reason: 'CERT_UNAVAILABLE' };
    }

    if (
      !verifyWechatPaySignature({ timestamp, nonce, body: rawBody, signature, platformCertificatePem: certificate })
    ) {
      return { ok: false, reason: 'SIGNATURE_INVALID' };
    }

    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'BODY_NOT_JSON' };
    }

    const resource = envelope['resource'];
    if (typeof resource !== 'object' || resource === null) {
      return { ok: false, reason: 'RESOURCE_MISSING' };
    }

    const resourceObject = resource as Record<string, unknown>;
    const ciphertext = resourceObject['ciphertext'];
    const resourceNonce = resourceObject['nonce'];
    const associatedData = resourceObject['associated_data'];

    if (typeof ciphertext !== 'string' || typeof resourceNonce !== 'string') {
      return { ok: false, reason: 'RESOURCE_MALFORMED' };
    }

    try {
      return {
        ok: true,
        resource: decryptWechatPayResource({
          ciphertext,
          nonce: resourceNonce,
          // `associated_data` 可能缺失或为 null，统一成空串
          associatedData: typeof associatedData === 'string' ? associatedData : '',
          apiV3Key,
        }),
      };
    } catch (error) {
      const message = error instanceof WechatPayCryptoError ? error.message : '未知错误';
      this.logger.warn(`支付回调解密失败：${message}`);

      return { ok: false, reason: 'DECRYPT_FAILED' };
    }
  }

  /**
   * 创建 JSAPI 预支付单（我们 → 微信）
   *
   * 与 `handleCallback` 是**反方向**：这里用**商户私钥签名**，而回调那边用平台证书验签。
   * 两个方向用不同的密钥，混用会得到"格式正确但微信返回 401"这种极难定位的失败。
   *
   * 走原生 `fetch` 而不是引入官方 SDK：v3 的 HTTP 接口很简单（一个 POST + 一个头），
   * 而 SDK 会带来一套独立的配置体系与重试策略，与本项目的 pino 日志、超时约定都不一致。
   * 真正需要谨慎的签名与验签已由纯函数承担。
   */
  async createJsapiPrepay(params: {
    orderNo: string;
    amount: number;
    description: string;
    /** 支付者 openid（JSAPI 必填） */
    openId?: string;
  }): Promise<{ appId: string; prepayId: string }> {
    const appId = this.configService.get('wechat.appId', { infer: true });
    const mchId = this.mchId;
    const serialNo = this.configService.get('wechatPay.serialNo', { infer: true }) ?? null;
    const privateKey = this.loadMerchantPrivateKey();
    const notifyUrl = this.configService.get('wechatPay.notifyUrl', { infer: true }) ?? null;

    if (mchId === null || serialNo === null || privateKey === null) {
      throw new WechatPayCryptoError('微信支付未配置完整（mchId / serialNo / 私钥）');
    }

    const body = JSON.stringify({
      appid: appId,
      mchid: mchId,
      description: params.description,
      out_trade_no: params.orderNo,
      notify_url: notifyUrl ?? '',
      // 金额单位是**分**且必须是整数 —— 前端把"元"传进来会少收 100 倍
      amount: { total: params.amount, currency: 'CNY' },
      ...(params.openId !== undefined ? { payer: { openid: params.openId } } : {}),
    });

    const response = await fetch(WECHAT_PAY_JSAPI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // 签名覆盖的正是上面那个**字符串化后的 body**，因此必须复用同一个变量；
        // 重新 `JSON.stringify` 一次会因键顺序或空白差异导致验签失败。
        //
        // ⚠ 必须用 **v3 官方规范**的签名（`METHOD\nURL\ntimestamp\nnonce\nbody\n`）：
        // 原先这里调用的 `buildAuthorizationHeader` 签的是 `mchid\nnonce\ntimestamp\nbody\n`
        // —— 那是旧版（v2）思路，不含请求方法与 URL。用它的结果是微信返回
        // `401 SIGN_ERROR`，而响应里不会告诉你待签名串拼错了。
        // 也就是说：**这条路径在修好前不可能下单成功**，属发布级阻断缺陷。
        Authorization: buildV3AuthorizationHeader({
          mchId,
          serialNo,
          privateKeyPem: privateKey,
          method: 'POST',
          urlPath: WECHAT_PAY_JSAPI_PATH,
          body,
          now: new Date(),
        }),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // 只取状态码与前 200 字符：微信的错误响应里不含我们的密钥，
      // 但可能含请求片段，全部落日志没必要
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      this.logger.error(`预支付失败 status=${response.status} orderNo=${params.orderNo} detail=${detail}`);

      throw new WechatPayCryptoError(`微信支付预下单失败（HTTP ${response.status}）`);
    }

    const result = (await response.json()) as { prepay_id?: unknown };
    if (typeof result.prepay_id !== 'string' || result.prepay_id.length === 0) {
      throw new WechatPayCryptoError('微信支付未返回 prepay_id');
    }

    return { appId, prepayId: result.prepay_id };
  }

  /**
   * 读取商户私钥（带缓存）
   *
   * 优先用 `WECHAT_PAY_PRIVATE_KEY`（内联 PEM），回落到 `WECHAT_PAY_PRIVATE_KEY_PATH`。
   * 内联形态需要还原被转义的换行 —— 这是把 PEM 放进环境变量时最常见的坑。
   */
  private loadMerchantPrivateKey(): string | null {
    if (this.cachedPrivateKey !== null) return this.cachedPrivateKey;

    const inline = this.configService.get('wechatPay.privateKey', { infer: true }) ?? null;
    const path = this.configService.get('wechatPay.privateKeyPath', { infer: true }) ?? null;

    try {
      const raw = inline !== null && inline.length > 0 ? inline : path === null ? null : readFileSync(path, 'utf8');
      if (raw === null) return null;

      this.cachedPrivateKey = normalizePemKey(raw);

      return this.cachedPrivateKey;
    } catch (error) {
      this.logger.error(`读取商户私钥失败：${(error as Error).message}`);

      return null;
    }
  }

  /**
   * 构造小程序支付参数（`wx.requestPayment` 直接使用）
   *
   * 放在这里而不是 `PaymentService`：签名需要商户私钥，而私钥只在本服务内部。
   * 让调用方拿到私钥再自己签，会把密钥暴露到支付业务代码里。
   */
  buildMiniAppPayParams(prepayId: string): {
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA';
    paySign: string;
  } {
    const privateKey = this.loadMerchantPrivateKey();
    if (privateKey === null) throw new WechatPayCryptoError('商户私钥不可用，无法构造支付参数');

    return buildMiniAppPayParams({
      appId: this.configService.get('wechat.appId', { infer: true }),
      prepayId,
      privateKeyPem: privateKey,
      now: new Date(),
    });
  }
  /** 校验商户号（回调里的 `mchid` 必须是我们自己） */
  isOurMchId(value: string): boolean {
    const mchId = this.mchId;

    // 用常量时间比较：普通 `===` 会因提前返回而泄露前缀匹配长度
    return mchId !== null && safeEquals(value, mchId);
  }

  // ==========================================================================
  // 主动查单 / 关单 / 退款（契约 §3.9.5 ~ §3.9.10、§3.14.6.3）
  //
  // 与 `createJsapiPrepay` 共用同一套「商户私钥签名」能力，但签名字符串用的是
  // **v3 官方规范**（见 `buildV3SignaturePayload`）—— 旧函数签的是 v2 形态的内容。
  // 新增方法一律走正确格式：这些是资金接口，返回 401 就等于功能完全不可用。
  // ==========================================================================

  /** 商户 API 调用所需凭证是否齐备（查单/关单/退款都依赖它） */
  get isApiConfigured(): boolean {
    return this.mchId !== null && this.merchantSerialNo() !== null && this.loadMerchantPrivateKey() !== null;
  }

  /**
   * 主动查询支付状态（契约 §3.9.5）
   *
   * 超时 5s + 重试 2 次（契约明确要求）：查单是**只读**操作，重试没有任何副作用，
   * 而它承担的是「回调丢失导致付了没给货」的兜底，宁可多试两次也不能因为一次
   * 网络抖动就把「已支付」判成「未支付」。
   */
  async queryTransactionByOutTradeNo(outTradeNo: string): Promise<WechatPayTransaction> {
    const mchId = this.requireMchId();
    // ⚠ `mchid` 必须出现在 URL 里且**参与签名**，因此拼接顺序与真实请求完全一致
    const urlPath = `${V3_TRANSACTION_PATH(outTradeNo)}?mchid=${encodeURIComponent(mchId)}`;

    const response = await this.callWechatApi({ method: 'GET', urlPath, retries: 2, timeoutMs: QUERY_TIMEOUT_MS });

    if (response.status === 404) {
      throw new WechatPayApiError('NOT_FOUND', '微信侧不存在该订单', { httpStatus: 404 });
    }

    const payload = this.parseJsonOrThrow(response, `查单 outTradeNo=${outTradeNo}`);

    if (response.status !== 200) {
      throw new WechatPayApiError(classifyFailure(response.status), `微信查单失败（HTTP ${response.status}）`, {
        httpStatus: response.status,
        wechatCode: readString(payload, 'code'),
      });
    }

    const amount = readObject(payload, 'amount');
    const payer = readObject(payload, 'payer');

    return {
      tradeState: readString(payload, 'trade_state') ?? 'UNKNOWN',
      tradeStateDesc: readString(payload, 'trade_state_desc'),
      transactionId: readString(payload, 'transaction_id'),
      successTime: readString(payload, 'success_time'),
      totalAmount: readInteger(amount, 'total'),
      payerTotal: readInteger(amount, 'payer_total'),
      payerOpenid: readString(payer, 'openid'),
      bankType: readString(payload, 'bank_type'),
      tradeType: readString(payload, 'trade_type'),
    };
  }

  /**
   * 关闭订单（契约 §3.9.6 / §3.9.7）
   *
   * **不抛错**：契约规则明确「微信 `close` 失败不阻断本地关单（本地状态优先），
   * 写 outbox_event 重试」。把失败表达为抛错会诱使调用方把它当成致命错误，
   * 于是「微信抖一下」就变成「用户关不掉订单」。
   */
  async closeOrder(outTradeNo: string): Promise<WechatPayCloseResult> {
    try {
      const mchId = this.requireMchId();
      const urlPath = V3_CLOSE_PATH(outTradeNo);
      const response = await this.callWechatApi({
        method: 'POST',
        urlPath,
        // 关单接口要求 body 里带 `mchid`
        body: JSON.stringify({ mchid: mchId }),
      });

      // 204 No Content 是成功标志
      if (response.status === 204 || response.status === 200) {
        return { closed: true, notFound: false, note: '微信侧订单已关闭' };
      }

      const payload = this.tryParseJson(response.text);
      const code = readString(payload, 'code') ?? '';

      // 已经是关闭状态：幂等语义下视为成功
      if (code === 'ORDER_CLOSED') {
        return { closed: true, notFound: false, note: '微信侧订单本就已关闭' };
      }

      // 「订单不存在」= 从未预支付成功，微信侧无单可关，等同于已完成目标
      if (code === 'ORDERNOTEXIST' || response.status === 404) {
        return { closed: false, notFound: true, note: '微信侧无此订单（未产生预支付），无需关闭' };
      }

      // 已支付：不要掩盖 —— 此时本地关单会造成「已关闭但已收款」的脏状态，必须告警
      if (code === 'ORDERPAID') {
        this.logger.error(`微信关单被拒：订单已支付 outTradeNo=${outTradeNo}（本地关单将造成脏状态，需人工介入）`);

        return { closed: false, notFound: false, note: '微信侧已支付，无法关闭' };
      }

      this.logger.warn(`微信关单失败 outTradeNo=${outTradeNo} status=${response.status} code=${code}`);

      return { closed: false, notFound: false, note: `微信关单失败（HTTP ${response.status}）` };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.warn(`微信关单异常 outTradeNo=${outTradeNo}: ${message}`);

      return { closed: false, notFound: false, note: '微信关单调用异常，已交由重试任务处理' };
    }
  }

  /**
   * 发起退款（契约 §3.9.10 规则 6：`out_refund_no = refundNo`）
   *
   * **不做自动重试**：退款不是幂等程度可忽略的操作。网络超时下"请求是否已被受理"
   * 无从判断，盲目重试虽然微信按 `out_refund_no` 幂等（不会重复出款），但会让
   * 我们无法区分"第一次成功了"还是"第二次才成功"。因此这里只调用一次，
   * 失败交由调用方按 `WechatPayApiError.kind` 决定「置 FAILED」还是「保持处理中 + 查询对账」。
   */
  async createRefund(params: {
    outTradeNo: string;
    outRefundNo: string;
    /** 退款金额（分） */
    refundAmount: number;
    /** 原订单总额（分），必须与支付时一致 */
    totalAmount: number;
    currency?: string;
    /** 退款原因（微信侧展示，≤80 字符） */
    reason?: string;
  }): Promise<WechatPayRefundResult> {
    this.requireMchId();

    const body = JSON.stringify({
      out_trade_no: params.outTradeNo,
      out_refund_no: params.outRefundNo,
      // 微信要求 ≤80 字符；超长直接截断而不是报错（原因文本是给人看的，截断无害）
      ...(params.reason !== undefined && params.reason.length > 0 ? { reason: params.reason.slice(0, 80) } : {}),
      amount: {
        refund: params.refundAmount,
        total: params.totalAmount,
        currency: params.currency ?? 'CNY',
      },
    });

    const response = await this.callWechatApi({ method: 'POST', urlPath: V3_REFUND_CREATE_PATH, body });
    const payload = this.parseJsonOrThrow(response, `退款 outRefundNo=${params.outRefundNo}`);

    if (response.status !== 200) {
      throw new WechatPayApiError(classifyFailure(response.status), `微信退款接口失败（HTTP ${response.status}）`, {
        httpStatus: response.status,
        wechatCode: readString(payload, 'code'),
      });
    }

    return toRefundResult(payload, params.outRefundNo);
  }

  /** 查询退款（退款回调缺失或超时后的对账入口） */
  async queryRefundByOutRefundNo(outRefundNo: string): Promise<WechatPayRefundResult> {
    this.requireMchId();

    const response = await this.callWechatApi({
      method: 'GET',
      urlPath: V3_REFUND_QUERY_PATH(outRefundNo),
      retries: 2,
    });

    if (response.status === 404) {
      throw new WechatPayApiError('NOT_FOUND', '微信侧不存在该退款单', { httpStatus: 404 });
    }

    const payload = this.parseJsonOrThrow(response, `查退款 outRefundNo=${outRefundNo}`);

    if (response.status !== 200) {
      throw new WechatPayApiError(classifyFailure(response.status), `微信查退款失败（HTTP ${response.status}）`, {
        httpStatus: response.status,
        wechatCode: readString(payload, 'code'),
      });
    }

    return toRefundResult(payload, outRefundNo);
  }

  // ------------------------------------------------------------------ 内部

  private merchantSerialNo(): string | null {
    return this.configService.get('wechatPay.serialNo', { infer: true }) ?? null;
  }

  private requireMchId(): string {
    const mchId = this.mchId;
    if (mchId === null) throw new WechatPayApiError('NOT_CONFIGURED', '微信支付未配置商户号');

    return mchId;
  }

  /**
   * 调用微信 v3 接口
   *
   * `retries` **只应给幂等的 GET 用**（见 `createRefund` 的说明）。
   */
  private async callWechatApi(params: {
    method: 'GET' | 'POST';
    urlPath: string;
    body?: string;
    retries?: number;
    timeoutMs?: number;
  }): Promise<{ status: number; text: string }> {
    const mchId = this.requireMchId();
    const serialNo = this.merchantSerialNo();
    const privateKey = this.loadMerchantPrivateKey();

    if (serialNo === null || privateKey === null) {
      throw new WechatPayApiError('NOT_CONFIGURED', '微信支付未配置完整（serialNo / 商户私钥）');
    }

    const body = params.body ?? '';
    const timeoutMs = params.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const attempts = (params.retries ?? 0) + 1;
    let lastMessage = '未知错误';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`${WECHAT_PAY_API_BASE}${params.urlPath}`, {
          method: params.method,
          headers: {
            Accept: 'application/json',
            ...(params.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            Authorization: buildV3AuthorizationHeader({
              mchId,
              serialNo,
              privateKeyPem: privateKey,
              method: params.method,
              urlPath: params.urlPath,
              body,
              now: new Date(),
            }),
          },
          ...(params.method === 'POST' ? { body } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });

        const text = await response.text();

        // 5xx / 429 视为可重试；其余（含 4xx 业务错误）原样返回给上层判定
        if ((response.status >= 500 || response.status === 429) && attempt < attempts) {
          lastMessage = `HTTP ${response.status}`;
          this.logger.warn(
            `微信支付接口可重试失败 path=${params.urlPath} status=${response.status} attempt=${attempt}`,
          );
          continue;
        }

        return { status: response.status, text };
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : '未知错误';

        if (attempt < attempts) {
          this.logger.warn(`微信支付接口调用异常，重试 path=${params.urlPath} attempt=${attempt}: ${lastMessage}`);
          continue;
        }
      }
    }

    // 走到这里说明网络层始终失败：调用方**不能**据此断定"没发生"（见 kind 说明）
    throw new WechatPayApiError('TRANSIENT', `微信支付接口调用失败：${lastMessage}`);
  }

  private parseJsonOrThrow(response: { status: number; text: string }, scene: string): Record<string, unknown> {
    const parsed = this.tryParseJson(response.text);

    if (parsed === null && response.text.trim().length > 0) {
      // 响应体不是 JSON：微信在网关层出错时会返回 HTML。带上前 200 字符便于定位
      this.logger.error(
        `微信支付响应体非 JSON scene=${scene} status=${response.status} body=${response.text.slice(0, 200)}`,
      );
    }

    return parsed ?? {};
  }

  private tryParseJson(text: string): Record<string, unknown> | null {
    if (text.trim().length === 0) return null;

    try {
      const parsed = JSON.parse(text) as unknown;

      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * 读取平台证书（带缓存）
   *
   * 缓存的是**内容**而不是"是否读过"：证书轮换时文件内容会变，
   * 而进程内缓存一份旧的会导致轮换后所有回调验签失败且原因难以定位。
   * 因此每次读取都比对内容，变化时更新缓存并记日志。
   */
  private loadPlatformCertificate(): string | null {
    const path = this.platformCertPath;
    if (path === null) {
      this.logger.error('未配置 WECHAT_PAY_PLATFORM_CERT_PATH，无法验签');

      return null;
    }

    try {
      const content = readFileSync(path, 'utf8');
      if (this.cachedCertificate !== content) {
        if (this.cachedCertificate !== null) {
          this.logger.warn('微信支付平台证书已变化（轮换），已刷新缓存');
        }
        this.cachedCertificate = content;
      }

      return content;
    } catch (error) {
      this.logger.error(`读取平台证书失败 path=${path}: ${(error as Error).message}`);

      // 读失败时清空缓存：下次请求重试，而不是一直用旧证书
      this.cachedCertificate = null;

      return null;
    }
  }
}

// ============================================================================
// 响应体读取与失败分类（纯函数，避免 `any` 在服务里扩散）
// ============================================================================

/** 安全取字符串（空串视为缺失） */
const readString = (source: Record<string, unknown> | null, key: string): string | null => {
  if (source === null) return null;
  const value = source[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** 安全取整数（微信金额一律为整数分；小数直接判为脏数据） */
const readInteger = (source: Record<string, unknown> | null, key: string): number | null => {
  if (source === null) return null;
  const value = source[key];

  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
};

/** 安全取嵌套对象 */
const readObject = (source: Record<string, unknown>, key: string): Record<string, unknown> | null => {
  const value = source[key];

  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

/**
 * HTTP 状态 → 失败分类
 *
 * 429/5xx 归为 `TRANSIENT`（请求可能已被受理）；其余 4xx 归为 `REJECTED`
 * （参数错、余额不足、订单状态不允许等，重试无用）。
 */
const classifyFailure = (status: number): WechatPayApiFailureKind =>
  status === 429 || status >= 500 ? 'TRANSIENT' : 'REJECTED';

/** 微信退款状态 → 本地枚举（未知值不猜测，归为 UNKNOWN 由调用方保持处理中） */
const toRefundState = (raw: string | null): WechatPayRefundState => {
  switch (raw) {
    case 'SUCCESS':
    case 'PROCESSING':
    case 'CLOSED':
    case 'ABNORMAL':
      return raw;
    default:
      return 'UNKNOWN';
  }
};

/** 退款响应体 → 结构化结果 */
const toRefundResult = (payload: Record<string, unknown>, outRefundNo: string): WechatPayRefundResult => {
  const amount = readObject(payload, 'amount');

  return {
    wechatRefundId: readString(payload, 'refund_id'),
    outRefundNo: readString(payload, 'out_refund_no') ?? outRefundNo,
    status: toRefundState(readString(payload, 'status')),
    successTime: readString(payload, 'success_time'),
    refundAmount: readInteger(amount, 'refund'),
    totalAmount: readInteger(amount, 'total'),
    payerRefund: readInteger(amount, 'payer_refund'),
    userReceivedAccount: readString(payload, 'user_received_account'),
    raw: payload,
  };
};
