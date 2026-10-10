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
import { buildAuthorizationHeader, buildMiniAppPayParams, normalizePemKey } from './wechat-pay-sign.util';
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

/** 请求超时（毫秒）—— 支付接口不宜久等，超时后由用户重试 */
const REQUEST_TIMEOUT_MS = 10_000;

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
        // 重新 `JSON.stringify` 一次会因键顺序或空白差异导致验签失败
        Authorization: buildAuthorizationHeader({
          mchId,
          serialNo,
          privateKeyPem: privateKey,
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
