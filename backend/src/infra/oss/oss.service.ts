/**
 * 阿里云 OSS 服务 — STS 直传凭证、签名 URL、对象元数据探测
 *
 * 架构依据：§14.2（私有 Bucket + 签名 URL 默认 15 分钟 + STS 临时凭证）、
 *          §14.3（类型白名单 + 大小限制 + 魔数校验 + 重命名为 UUID + 独立域名）。
 *
 * 安全约束：
 *   · STS 策略**精确到单个对象**且只给 `oss:PutObject` —— 不含 `GetObject`/`DeleteObject`，
 *     凭证即使泄露也无法读取或删除任何文件（契约 §3.10.1 规则 3）
 *   · Bucket 保持私有，读取一律走签名 URL，**绝不签发长期 URL**（上限 1 小时）
 *   · AK/SK 只来自环境变量，`accessKeySecret` 等字段已在 pino redact 名单中
 *
 * 可测性设计：`getClient()` / `createStsClient()` 为 `protected`，
 * 单测通过子类替换它们即可覆盖错误映射分支，无需真实网络。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OSS from 'ali-oss';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';

/** STS 临时凭证（对外只暴露前端上传所需字段） */
export interface StsCredentials {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken: string;
  /** 过期时间（ISO 字符串） */
  readonly expiration: string;
  readonly expiresInSeconds: number;
}

/** 签名 URL 生成选项（对齐契约 §3.10.2 请求体） */
export interface SignUrlOptions {
  /** 有效期（秒），默认取配置值；调用方负责保证 60–3600 */
  readonly expiresInSeconds?: number;
  /** OSS 图片处理参数，如 `image/resize,w_240/format,webp` */
  readonly process?: string;
  /** 下载文件名提示，如 `attachment; filename="report.pdf"` */
  readonly responseContentDisposition?: string;
}

/** 签名结果 */
export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/** 对象元数据探测结果 */
export interface ObjectMetadata {
  readonly exists: boolean;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
  readonly etag: string | null;
}

/** STS AssumeRole 的默认有效期（秒）—— 契约 §3.10.1 规则 3 要求 900 秒 */
const STS_DURATION_SECONDS = 900;

/** 上传凭证重试次数（AssumeRole 失败多为瞬时限流/抖动） */
const STS_MAX_ATTEMPTS = 2;

@Injectable()
export class OssService {
  private readonly logger = new Logger(OssService.name);

  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly accessKeySecret: string;
  private readonly stsRoleArn: string;
  private readonly cdnDomain: string;
  private readonly signedUrlTtl: number;

  /** 复用同一个客户端实例（ali-oss 内部维护连接池） */
  private cachedClient: OSS | null = null;

  constructor(configService: ConfigService<AppConfig, true>) {
    const oss = configService.get('oss', { infer: true });

    this.bucket = oss.bucket;
    this.region = oss.region;
    this.accessKeyId = oss.accessKeyId;
    this.accessKeySecret = oss.accessKeySecret;
    this.stsRoleArn = oss.stsRoleArn;
    this.cdnDomain = oss.cdnDomain;
    this.signedUrlTtl = oss.signedUrlTtl;
  }

  /** 是否已配置（缺任一必填项即视为未配置，相关接口返回 `80003`） */
  get isConfigured(): boolean {
    return isNonEmpty(this.bucket) && isNonEmpty(this.accessKeyId) && isNonEmpty(this.accessKeySecret);
  }

  /** 是否具备签发 STS 凭证的能力（需要额外配置 RAM 角色 ARN） */
  get canAssumeRole(): boolean {
    return this.isConfigured && isNonEmpty(this.stsRoleArn);
  }

  /** 默认签名有效期（秒） */
  get defaultSignedUrlTtl(): number {
    return this.signedUrlTtl;
  }

  /** Bucket 访问域名（无 CDN 时的回退地址） */
  get endpoint(): string {
    return `https://${this.bucket}.${this.region}.aliyuncs.com`;
  }

  /** 对外分发域名（未配置时回退为 Bucket 域名） */
  get publicDomain(): string {
    return this.cdnDomain.length > 0 ? this.cdnDomain : this.endpoint;
  }

  /**
   * 为**单个对象**签发最小权限上传凭证
   *
   * 策略只允许 `PutObject` 到该对象键：即使凭证被中间人截获，
   * 也无法越权写入其他对象、读取任何对象或删除对象。
   */
  async assumeUploadCredentials(objectKey: string): Promise<StsCredentials> {
    if (!this.canAssumeRole) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    const policy = this.buildUploadPolicy(objectKey);
    const sessionName = `soulmap-${Date.now().toString(36)}`;

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= STS_MAX_ATTEMPTS; attempt += 1) {
      try {
        const sts = this.createStsClient();
        const { credentials } = await sts.assumeRole(this.stsRoleArn, policy, STS_DURATION_SECONDS, sessionName);

        const expiration = new Date(credentials.Expiration);
        const expiresInSeconds = Math.max(0, Math.floor((expiration.getTime() - Date.now()) / 1000));

        return {
          accessKeyId: credentials.AccessKeyId,
          accessKeySecret: credentials.AccessKeySecret,
          securityToken: credentials.SecurityToken,
          expiration: credentials.Expiration,
          expiresInSeconds,
        };
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `STS AssumeRole 第 ${attempt}/${STS_MAX_ATTEMPTS} 次失败 objectKey=${objectKey}: ${describeError(error)}`,
        );
      }
    }

    // 不把底层错误透传给客户端（可能含账号信息），详细信息只进日志
    this.logger.error(`STS AssumeRole 最终失败 objectKey=${objectKey}: ${describeError(lastError)}`);
    throw new BusinessException(ErrorCode.STS_ASSUME_ROLE_FAILED);
  }

  /**
   * 生成签名访问 URL
   *
   * `signatureUrl` 是**纯本地计算**（HMAC 拼装），不产生网络请求，
   * 因此该路径可被单测完整覆盖。
   */
  signUrl(objectKey: string, options: SignUrlOptions = {}): SignedUrl {
    if (!this.isConfigured) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    const expiresInSeconds = options.expiresInSeconds ?? this.signedUrlTtl;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    try {
      const rawUrl = this.getClient().signatureUrl(objectKey, {
        expires: expiresInSeconds,
        method: 'GET',
        ...(options.process !== undefined ? { process: options.process } : {}),
        ...(options.responseContentDisposition !== undefined
          ? { response: { 'content-disposition': options.responseContentDisposition } }
          : {}),
      });

      return { url: rawUrl, expiresAt };
    } catch (error) {
      this.logger.error(`签名 URL 生成失败 objectKey=${objectKey}: ${describeError(error)}`);
      throw new BusinessException(ErrorCode.SIGN_URL_FAILED);
    }
  }

  /**
   * 探测对象是否存在及其元数据
   *
   * 不存在时**不抛错**，返回 `exists: false` —— 批量签名场景下
   * 单个对象缺失不应导致整批失败（契约 §3.10.2 规则 4）。
   */
  async headObject(objectKey: string): Promise<ObjectMetadata> {
    if (!this.isConfigured) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    try {
      const result = await this.getClient().head(objectKey);
      const headers = (result.res?.headers ?? {}) as Record<string, string | undefined>;

      const contentLength = headers['content-length'];
      const parsedLength = contentLength === undefined ? Number.NaN : Number.parseInt(contentLength, 10);

      return {
        exists: true,
        sizeBytes: Number.isFinite(parsedLength) ? parsedLength : null,
        mimeType: headers['content-type'] ?? null,
        etag: headers['etag']?.replace(/"/g, '') ?? null,
      };
    } catch (error) {
      const status = readNumericProperty(error, 'status');
      const code = readStringProperty(error, 'code');

      if (status === 404 || code === 'NoSuchKey') {
        return { exists: false, sizeBytes: null, mimeType: null, etag: null };
      }

      this.logger.error(`OSS HEAD 探测失败 objectKey=${objectKey}: ${describeError(error)}`);
      throw new BusinessException(ErrorCode.FILE_UPLOAD_FAILED);
    }
  }

  /**
   * 读取对象头部若干字节（用于魔数校验）
   *
   * 用 **Range 请求**只取前缀：为判定 16 字节而把 20MB 的 PDF 整个拉下来，
   * 在大文件场景下是数量级的流量与内存浪费。
   *
   * 对象不存在返回 `null`（与 `headObject` 的 `exists:false` 一致，不抛错）。
   */
  async readPrefix(objectKey: string, length = 16): Promise<Buffer | null> {
    if (!this.isConfigured) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    try {
      const result = await this.getClient().get(objectKey, null, {
        headers: { Range: `bytes=0-${Math.max(0, length - 1)}` },
      });

      const content: unknown = result.content;
      if (Buffer.isBuffer(content)) return content;
      if (content instanceof Uint8Array) return Buffer.from(content);
      return null;
    } catch (error) {
      const status = readNumericProperty(error, 'status');
      const code = readStringProperty(error, 'code');

      if (status === 404 || code === 'NoSuchKey') return null;

      this.logger.error(`OSS 读取对象前缀失败 objectKey=${objectKey}: ${describeError(error)}`);
      throw new BusinessException(ErrorCode.FILE_UPLOAD_FAILED);
    }
  }

  /**
   * 删除对象
   *
   * 只在**必须让文件消失**的场景调用：魔数校验不符、内容安全违规。
   * 对象本就不存在时返回 `true`（幂等）—— 重复回调可能触发重复删除，
   * 把它当失败会产生无意义的告警。
   */
  async deleteObject(objectKey: string): Promise<boolean> {
    if (!this.isConfigured) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    try {
      await this.getClient().delete(objectKey);
      return true;
    } catch (error) {
      const status = readNumericProperty(error, 'status');
      const code = readStringProperty(error, 'code');

      if (status === 404 || code === 'NoSuchKey') return true;

      this.logger.error(`OSS 删除对象失败 objectKey=${objectKey}: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * 写入对象（**服务端生成**的内容：导出包、报告 PDF 等）
   *
   * 与客户端直传的区别：这类内容由服务端产出，因此不需要 STS 凭证，
   * 也不需要归属校验 —— 对象键完全由服务端决定，不存在用户可控输入。
   *
   * 失败抛错而非返回 false：调用方（队列 Worker）需要据此把任务标记为失败，
   * 静默返回 false 会让任务永远停在「处理中」。
   */
  async putObject(
    objectKey: string,
    body: Buffer | string,
    contentType: string,
  ): Promise<{ etag: string | null; sizeBytes: number }> {
    if (!this.isConfigured) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');

    try {
      const result = await this.getClient().put(objectKey, payload, {
        mime: contentType,
        headers: { 'Content-Type': contentType },
      });

      const headers = (result.res?.headers ?? {}) as Record<string, string | undefined>;

      return {
        etag: headers['etag']?.replace(/"/g, '') ?? null,
        sizeBytes: payload.byteLength,
      };
    } catch (error) {
      this.logger.error(`OSS 写入对象失败 objectKey=${objectKey}: ${describeError(error)}`);
      throw new BusinessException(ErrorCode.FILE_UPLOAD_FAILED);
    }
  }

  /**
   * 设置对象读写权限
   *
   * 用于「业务登记成功后把头像/分享图置为 public-read」——
   * 契约里这类 URL 是不带签名的 CDN 地址，必须公开可读才能被前端直接引用。
   * 报告 PDF 与反馈附图**不得**调用本方法（保持私有 + 签名 URL）。
   *
   * 失败不抛错、只返回 false 并由调用方告警：ACL 设置失败不应让「已通过校验的
   * 合法头像」登记失败，但必须留下可观测的痕迹。
   */
  async putObjectAcl(objectKey: string, acl: 'public-read' | 'private'): Promise<boolean> {
    if (!this.isConfigured) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    try {
      await this.getClient().putACL(objectKey, acl);
      return true;
    } catch (error) {
      this.logger.error(`OSS 设置对象 ACL 失败 objectKey=${objectKey} acl=${acl}: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * 构造精确到单个对象的最小权限策略（纯函数，独立可测）
   *
   * 同时给出 `acs:oss:*:*:{bucket}/{objectKey}` 与 `.../*` 两种资源写法中的
   * **精确对象形式** —— 不使用通配符前缀，避免凭证被用于同目录其他对象。
   */
  buildUploadPolicy(objectKey: string): object {
    return {
      Version: '1',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['oss:PutObject'],
          Resource: [`acs:oss:*:*:${this.bucket}/${objectKey}`],
        },
      ],
    };
  }

  /** 客户端实例（protected 以便单测替换） */
  protected getClient(): OSS {
    if (this.cachedClient === null) {
      this.cachedClient = new OSS({
        region: this.region,
        bucket: this.bucket,
        accessKeyId: this.accessKeyId,
        accessKeySecret: this.accessKeySecret,
        secure: true,
        timeout: 5000,
      });
    }
    return this.cachedClient;
  }

  /** STS 客户端（protected 以便单测替换） */
  protected createStsClient(): OSS.STS {
    return new OSS.STS({
      accessKeyId: this.accessKeyId,
      accessKeySecret: this.accessKeySecret,
    });
  }
}

/**
 * 判断配置项是否为非空字符串
 *
 * 用 `unknown` 入参而非 `string`：`isConfigured` 是「未配置就不要调用 OSS」的
 * 安全闸门，它自己**绝不能抛异常**。运行时配置来自 Joi 校验（有默认空串），
 * 但若有人用不完整的对象构造本服务，这里应返回 false 而不是抛出 TypeError。
 */
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** 从任意异常中读数字属性（ali-oss 的错误对象在不同失败路径下形状不一致） */ const readNumericProperty = (
  value: unknown,
  key: string,
): number | null => {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'number' ? raw : null;
};

/** 从任意异常中读字符串属性 */
const readStringProperty = (value: unknown, key: string): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : null;
};

/**
 * 描述异常（用于日志）
 *
 * 只取 `code` / `status` / `message`，**不序列化整个错误对象** ——
 * ali-oss 的错误对象可能携带请求签名信息。
 */
const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const code = readStringProperty(error, 'code');
    const status = readNumericProperty(error, 'status');
    return [code, status === null ? null : `status=${status}`, error.message]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(' ');
  }
  return String(error);
};
