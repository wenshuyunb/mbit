/**
 * 微信小程序服务 — code2session 与内容安全（后者 Phase 3 接入）
 *
 * 安全约束（架构文档 §9.1）：
 *   · `session_key` **绝不**返回给客户端，**绝不**明文入库 —— 本服务只负责取回，
 *     加密落库由调用方（AuthService）通过 CryptoService 完成
 *   · `appSecret` 只存在于服务端环境变量
 *
 * 可靠性设计（架构文档 §15.5）：
 *   · 超时 5s（微信侧偶发抖动时快速失败，避免拖垮登录接口 P95）
 *   · 可重试错误（网络失败、-1 系统繁忙、45011 频率限制）自动重试 2 次，指数退避 + 抖动
 *   · 不可重试错误（40029 code 无效、40163 code 已使用）立即失败，避免无谓重试
 *
 * 关于 code 的一次性：`wx.login` 的 code 5 分钟有效且**只能用一次**。
 * 因此重试必须复用同一个 code —— 若首次请求已到达微信但响应丢失，重试会收到 40163；
 * 这种情况下按「code 无效」处理是正确的（前端重新 wx.login 即可）。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import { RedisService } from '../redis/redis.service';

/** code2session 成功返回 */
export interface Code2SessionResult {
  openid: string;
  unionid: string | null;
  /** 会话密钥（明文），调用方必须立即加密落库，禁止外传 */
  sessionKey: string;
  /** 会话密钥有效期（秒），微信官方为 30 天 */
  expiresInSeconds: number;
}

/** 内容安全检测结果 */
export interface MsgSecCheckResult {
  /** 是否放行 */
  pass: boolean;
  /** 微信返回的建议：pass / review / risky（未执行检测时为 unknown） */
  suggest: 'pass' | 'review' | 'risky' | 'unknown';
  /** 违规标签（命中时） */
  label: string | null;
  /** 检测是否**真正执行**（false 表示走的是 fail-open 放行） */
  checked: boolean;
}

/** 微信 code2session 原始响应 */
interface Code2SessionResponse {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

/** 微信 access_token 响应 */
interface AccessTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

/** 内容安全检测响应 */
interface MsgSecCheckResponse {
  errcode?: number;
  errmsg?: string;
  result?: { suggest?: string; label?: number };
}

/** 手机号获取响应 */
interface PhoneNumberResponse {
  errcode?: number;
  errmsg?: string;
  phone_info?: {
    phoneNumber?: string;
    purePhoneNumber?: string;
    countryCode?: string;
  };
}

/** 手机号获取结果（明文只在内存中短暂存在，调用方须立即加密落库） */
export interface PhoneNumberResult {
  /** 带区号的完整号码，如 `+86 13800006721` */
  phoneNumber: string;
  /** 纯号码（无区号） */
  purePhoneNumber: string;
  /** 区号，如 `86` */
  countryCode: string;
}

/** 可重试的微信错误码 */
const RETRYABLE_WECHAT_CODES = new Set([
  -1, // 系统繁忙
  45011, // API 调用频率限制
  40226, // 高风险等级用户，请求被拦截（重试无益，但归入统一失败路径）
]);

/** code 相关错误码（code 无效 / 已被使用）—— 不可重试 */
const INVALID_CODE_WECHAT_CODES = new Set([40029, 40163, 40013]);

/** 微信接口地址 */
const CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';
const ACCESS_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const MSG_SEC_CHECK_URL = 'https://api.weixin.qq.com/wxa/msg_sec_check';
const PHONE_NUMBER_URL = 'https://api.weixin.qq.com/wxa/business/getuserphonenumber';
const MINI_APP_CODE_URL = 'https://api.weixin.qq.com/wxa/getwxacodeunlimit';

/**
 * 需要用户**重新授权**才能恢复的错误码
 *
 * 这类错误重试无益：`code` 是一次性令牌（5 分钟有效、用过即废），
 * `access_token` 失效也需重新换取。对用户的正确引导是「重新点击授权按钮」，
 * 而不是「稍后重试」—— 因此与 `WECHAT_API_ERROR` 分开映射。
 */
const WECHAT_AUTHORIZATION_ERROR_CODES = new Set([
  40001, // access_token 无效
  40029, // code 无效
  40163, // code 已被使用
  42001, // access_token 超时
  41001, // 缺少 access_token
]);

/**
 * access_token 缓存的提前刷新窗口（秒）
 * 微信 token 有效期 7200s；提前 300s 刷新，避免在临界点用到刚过期的 token。
 */
const ACCESS_TOKEN_REFRESH_AHEAD_SECONDS = 300;

/** access_token 在 Redis 中的缓存键 */
const ACCESS_TOKEN_CACHE_KEY = 'wx:access_token';

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 5_000;

/** 默认重试次数 */
const DEFAULT_MAX_RETRIES = 2;

/** 会话密钥有效期：微信官方 30 天 */
const SESSION_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

@Injectable()
export class WechatService {
  private readonly logger = new Logger(WechatService.name);
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly msgSecCheckEnabled: boolean;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly redis: RedisService,
  ) {
    this.appId = configService.get('wechat.appId', { infer: true });
    this.appSecret = configService.get('wechat.appSecret', { infer: true });
    this.msgSecCheckEnabled = configService.get('wechat.msgSecCheck', { infer: true });

    // 重试次数固定为 2（与架构 §15.5「超时 5s + 重试 2 次」一致）
    this.maxRetries = DEFAULT_MAX_RETRIES;
    this.timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  /** 是否已配置微信凭证（未配置时登录功能不可用，但服务可正常启动以便本地开发其他模块） */
  isConfigured(): boolean {
    return this.appId.trim() !== '' && this.appSecret.trim() !== '';
  }

  /**
   * 用一次性 code 换取 openid / unionid / session_key
   *
   * @throws BusinessException
   *   · `WECHAT_CODE_INVALID`  code 无效或已被使用（前端应重新 wx.login）
   *   · `WECHAT_API_ERROR`     微信侧不可用（网络/超时/系统繁忙，可提示稍后重试）
   *   · `CONFIG_MISSING`       未配置 appId/appSecret（配置问题，不是用户问题）
   */
  async code2Session(code: string): Promise<Code2SessionResult> {
    if (!this.isConfigured()) {
      throw BusinessException.internal(ErrorCode.CONFIG_MISSING, '微信登录暂不可用，请稍后重试', {
        missing: 'WECHAT_APPID / WECHAT_SECRET',
      });
    }

    const url = this.buildUrl(code);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.requestOnce(url);
        return this.parseResponse(response);
      } catch (error) {
        lastError = error as Error;

        const retryable = this.isRetryable(error);
        const isLastAttempt = attempt >= this.maxRetries;

        if (!retryable || isLastAttempt) {
          throw error;
        }

        // 指数退避 + 抖动：避免微信侧抖动时所有实例同时重试造成二次压力
        const delay = 200 * 2 ** attempt + Math.floor(Math.random() * 150);
        this.logger.warn(`code2session 第 ${attempt + 1} 次失败（${lastError.message}），${delay}ms 后重试`);
        await sleep(delay);
      }
    }

    // 理论上不可达（循环内要么 return 要么 throw），保留兜底以防后续改动破坏该不变量
    throw BusinessException.unavailable(ErrorCode.WECHAT_API_ERROR, '微信服务暂时不可用，请稍后重试');
  }

  // ==========================================================================
  // 内容安全（msgSecCheck）
  // ==========================================================================

  /**
   * 文本内容安全检测（微信 `security.msgSecCheck`）
   *
   * 用于昵称等用户自由输入内容的发布前校验（架构 §10.5）。
   *
   * **fail-open 策略**（契约 §3.2.2 错误码表）：内容安全服务异常时**放行**并记录审计，
   * 而不是阻断用户操作。理由：
   *   · 安全服务不可用不应让整个产品不可用（可用性优先）
   *   · 违规内容有事后处置手段（后台审核 + 举报）
   *   · 若 fail-closed，微信侧抖动会直接导致用户无法修改昵称/发消息
   * 注意：本方法**不抛异常**，调用方据 `checked` 字段决定是否记录审计。
   *
   * @param content 待检测文本
   * @param openid  用户 openid（微信 v2 接口要求，用于风控画像）
   */
  async msgSecCheck(content: string, openid?: string): Promise<MsgSecCheckResult> {
    const skipped: MsgSecCheckResult = { pass: true, suggest: 'unknown', label: null, checked: false };

    // 未开启开关或未配置凭证时直接放行（开发环境常见）
    if (!this.msgSecCheckEnabled || !this.isConfigured()) {
      return skipped;
    }

    // 空内容无需检测（微信会返回参数错误）
    if (content.trim() === '') {
      return skipped;
    }

    try {
      const accessToken = await this.getAccessToken();
      if (!accessToken) {
        this.logger.warn('msgSecCheck 跳过：无法获取 access_token');
        return skipped;
      }

      const response = await this.postJson<MsgSecCheckResponse>(`${MSG_SEC_CHECK_URL}?access_token=${accessToken}`, {
        content,
        version: 2,
        scene: 1, // 1 = 资料（昵称、签名等）
        ...(openid ? { openid } : {}),
      });

      if (response.errcode !== undefined && response.errcode !== 0) {
        this.logger.warn(`msgSecCheck 返回错误 errcode=${response.errcode} errmsg=${response.errmsg ?? ''}`);
        return skipped;
      }

      const suggest = (response.result?.suggest ?? 'pass') as MsgSecCheckResult['suggest'];
      const label = response.result?.label !== undefined ? String(response.result.label) : null;

      return {
        // 只有明确 pass 才放行；review / risky 一并拦截（审核队列缺失时先按拦截处理，避免违规内容入库）
        pass: suggest === 'pass',
        suggest,
        label,
        checked: true,
      };
    } catch (error) {
      // fail-open：网络/超时等异常一律放行并记录
      this.logger.warn(`msgSecCheck 调用失败（fail-open 放行）: ${(error as Error).message}`);
      return skipped;
    }
  }

  /**
   * 获取 access_token（带 Redis 缓存）
   *
   * 微信侧 access_token 为全局唯一且有效期 7200s，**必须缓存**：
   * 频繁获取会触发 45009（接口调用频率超限）并导致 token 互相顶掉。
   *
   * 并发保护：使用 Redis 分布式锁，避免多实例同时刷新产生 token 竞争。
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.isConfigured()) return null;

    const cacheKey = this.redis.key(ACCESS_TOKEN_CACHE_KEY);
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    // 分布式锁：拿不到锁说明其他实例正在刷新，短暂等待后复用其结果
    const lockKey = this.redis.key('wx:access_token:lock');
    const lockToken = await this.redis.acquireLock(lockKey, 10);

    if (!lockToken) {
      await sleep(300);
      return this.redis.get(cacheKey);
    }

    try {
      const url = `${ACCESS_TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(this.appId)}&secret=${encodeURIComponent(this.appSecret)}`;
      const response = await this.getJson<AccessTokenResponse>(url);

      if (!response.access_token) {
        this.logger.error(
          `获取 access_token 失败 errcode=${response.errcode ?? 'n/a'} errmsg=${response.errmsg ?? ''}`,
        );
        return null;
      }

      const ttl = Math.max(60, (response.expires_in ?? 7200) - ACCESS_TOKEN_REFRESH_AHEAD_SECONDS);
      await this.redis.set(cacheKey, response.access_token, ttl);

      return response.access_token;
    } catch (error) {
      this.logger.error(`获取 access_token 异常: ${(error as Error).message}`);
      return null;
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  /**
   * 用 `getPhoneNumber` 返回的动态令牌换取手机号（契约 §3.2.4 的推荐路径）
   *
   * 与旧版 `encryptedData` 路径的区别：新版由微信服务端直接返回号码，
   * 服务端无需持有 `session_key`，因此**不再依赖**会话密钥是否仍然有效 ——
   * 这消除了「用户长时间未登录 → session_key 过期 → 绑定失败」的一大类问题。
   *
   * 明文号码只在本方法的返回值中存在，调用方必须立即加密落库，禁止写日志。
   */
  async getPhoneNumber(code: string): Promise<PhoneNumberResult> {
    if (!this.isConfigured()) {
      throw new BusinessException(ErrorCode.WECHAT_API_ERROR, '微信小程序未配置，无法获取手机号');
    }

    const accessToken = await this.getAccessToken();
    if (accessToken === null) {
      // access_token 拿不到通常是配置错误或微信侧故障，重试无益
      throw new BusinessException(ErrorCode.WECHAT_API_ERROR, '微信服务暂时不可用，请稍后重试');
    }

    const url = `${PHONE_NUMBER_URL}?access_token=${encodeURIComponent(accessToken)}`;

    let response: PhoneNumberResponse;
    try {
      response = await this.postJson<PhoneNumberResponse>(url, { code });
    } catch (error) {
      this.logger.error(`获取手机号请求失败: ${(error as Error).message}`);
      throw new BusinessException(ErrorCode.WECHAT_API_ERROR, '微信服务暂时不可用，请稍后重试');
    }

    const errcode = response.errcode ?? 0;

    if (errcode !== 0) {
      if (WECHAT_AUTHORIZATION_ERROR_CODES.has(errcode)) {
        throw new BusinessException(ErrorCode.WECHAT_SESSION_EXPIRED, '授权已失效，请重新点击获取手机号');
      }
      // 只记录错误码，不记录 code（code 本身是可用于换取号码的凭证）
      this.logger.error(`获取手机号失败 errcode=${errcode} errmsg=${response.errmsg ?? ''}`);
      throw new BusinessException(ErrorCode.WECHAT_API_ERROR, '微信服务暂时不可用，请稍后重试');
    }

    const info = response.phone_info;
    if (info === undefined || typeof info.phoneNumber !== 'string' || info.phoneNumber.length === 0) {
      this.logger.error('获取手机号成功但响应缺少 phoneNumber');
      throw new BusinessException(ErrorCode.WECHAT_API_ERROR, '微信返回的手机号信息不完整');
    }

    return {
      phoneNumber: info.phoneNumber,
      // 老版本接口可能不返回 purePhoneNumber，回退用完整号码（调用方会再做区号归一化）
      purePhoneNumber:
        typeof info.purePhoneNumber === 'string' && info.purePhoneNumber.length > 0
          ? info.purePhoneNumber
          : info.phoneNumber,
      countryCode: typeof info.countryCode === 'string' && info.countryCode.length > 0 ? info.countryCode : '86',
    };
  }

  // ==========================================================================
  // 小程序码（wxacode.getUnlimited）
  // ==========================================================================

  /**
   * 生成小程序码（微信 `wxacode.getUnlimited`）
   *
   * ## 为什么失败返回 `null` 而不是抛错
   *
   * 调用方都是「有更好、没有也能用」的增强能力：邀请靠邀请码与分享文案就能完成，
   * 分享卡靠正文与卡片文案也能分享。码生成失败（未配置凭证、微信侧报错、超时）
   * 不该让**邀请本身**失败 —— 那会把一个可选能力变成整条链路单点。
   * 因此这里记日志并返回 `null`，调用方把 `qrCodeUrl` 留空、前端不渲染二维码位。
   *
   * ## 为什么不能复用 `postJson`
   *
   * 该接口**成功时返回图片二进制**，失败时才返回 JSON（`{"errcode":…,"errmsg":…}`），
   * 且失败响应的 HTTP 状态码仍是 200 —— 直接 `response.json()` 会在成功路径上
   * 抛解析错误，把一次正常生成变成故障。因此必须按 `Content-Type` 分流。
   *
   * @param scene 场景值（**上限 32 字符**，微信侧硬限制；本项目传邀请码/报告短 id）
   * @param page  目标页面路径（含分包前缀，如 `pkgMatch/pages/invite`）；不传则打开首页
   */
  async getMiniAppCode(params: {
    scene: string;
    page?: string;
    /** 二维码边长（px），微信默认 430 */
    width?: number;
    /** `false` 时微信不校验 `page` 是否存在（页面尚未发布时联调用） */
    checkPath?: boolean;
  }): Promise<Buffer | null> {
    if (!this.isConfigured()) {
      this.logger.warn('生成小程序码跳过：未配置微信凭证');
      return null;
    }

    const accessToken = await this.getAccessToken();
    if (accessToken === null) {
      this.logger.warn('生成小程序码跳过：无法获取 access_token');
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${MINI_APP_CODE_URL}?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene: params.scene,
          ...(params.page !== undefined ? { page: params.page } : {}),
          ...(params.width !== undefined ? { width: params.width } : {}),
          ...(params.checkPath !== undefined ? { check_path: params.checkPath } : {}),
        }),
      });

      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('application/json')) {
        const failure = (await response.json()) as { errcode?: number; errmsg?: string };

        this.logger.error(
          `生成小程序码失败 errcode=${failure.errcode ?? 'n/a'} errmsg=${failure.errmsg ?? ''} scene=${params.scene}`,
        );
        return null;
      }

      if (!response.ok) {
        this.logger.error(`生成小程序码失败 HTTP ${response.status} scene=${params.scene}`);
        return null;
      }

      const image = Buffer.from(await response.arrayBuffer());

      // 空响应体不能当成"生成成功"：它会被存成一张坏图，前端渲染成空白二维码，
      // 用户扫不出来却看不出哪里错了 —— 宁可当作失败让调用方降级
      if (image.length === 0) {
        this.logger.error(`生成小程序码返回空内容 scene=${params.scene}`);
        return null;
      }

      return image;
    } catch (error) {
      this.logger.error(
        `生成小程序码异常 scene=${params.scene}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================
  /** 发起 GET 并解析 JSON（带超时） */
  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 发起 JSON POST 并解析响应（带超时） */
  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(code: string): string {
    const params = new URLSearchParams({
      appid: this.appId,
      secret: this.appSecret,
      js_code: code,
      grant_type: 'authorization_code',
    });
    return `${CODE2SESSION_URL}?${params.toString()}`;
  }

  private async requestOnce(url: string): Promise<Code2SessionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });

      if (!response.ok) {
        // HTTP 层失败（5xx / 网关错误）属于可重试
        throw new Error(`HTTP ${response.status}`);
      }

      return (await response.json()) as Code2SessionResponse;
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError') {
        throw new Error(`请求超时（>${this.timeoutMs}ms）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseResponse(response: Code2SessionResponse): Code2SessionResult {
    const errcode = response.errcode ?? 0;

    if (errcode !== 0) {
      const errmsg = response.errmsg ?? 'unknown';

      if (INVALID_CODE_WECHAT_CODES.has(errcode)) {
        this.logger.warn(`code2session 拒绝：errcode=${errcode} errmsg=${errmsg}`);
        throw BusinessException.badRequest(ErrorCode.WECHAT_CODE_INVALID, '微信登录凭证无效，请重试');
      }

      if (RETRYABLE_WECHAT_CODES.has(errcode)) {
        // 包装为可重试错误，交给上层循环处理
        throw new RetryableWechatError(`微信返回错误: errcode=${errcode} errmsg=${errmsg}`);
      }

      this.logger.error(`code2session 未知错误: errcode=${errcode} errmsg=${errmsg}`);
      throw BusinessException.unavailable(ErrorCode.WECHAT_API_ERROR, '微信服务暂时不可用，请稍后重试');
    }

    const { openid, session_key: sessionKey, unionid } = response;

    // 契约校验：微信在 errcode=0 时也可能缺字段（历史行为），缺失即视为异常响应
    if (!openid || !sessionKey) {
      this.logger.error(`code2session 响应缺少必要字段: openid=${Boolean(openid)} sessionKey=${Boolean(sessionKey)}`);
      throw BusinessException.unavailable(ErrorCode.WECHAT_API_ERROR, '微信服务返回异常，请稍后重试');
    }

    return {
      openid,
      unionid: unionid ?? null,
      sessionKey,
      expiresInSeconds: SESSION_KEY_TTL_SECONDS,
    };
  }

  /** 判断异常是否可重试 */
  private isRetryable(error: unknown): boolean {
    if (error instanceof BusinessException) {
      // 业务异常（code 无效、配置缺失）一律不重试
      return false;
    }

    if (error instanceof RetryableWechatError) return true;

    // 网络层错误（fetch 失败、超时、DNS、连接重置）可重试
    const message = (error as Error).message ?? '';
    return (
      message.includes('HTTP 5') ||
      message.includes('超时') ||
      message.includes('fetch failed') ||
      message.includes('ECONNRESET') ||
      message.includes('ENOTFOUND') ||
      message.includes('ETIMEDOUT') ||
      message.includes('socket hang up')
    );
  }
}

/** 标记「微信侧临时性错误」，由 code2session 的重试循环识别 */
class RetryableWechatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableWechatError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
