/**
 * 存储服务 — OSS 直传凭证签发与签名 URL 生成
 *
 * 契约来源：docs/API_DESIGN.md §3.10.1（upload-ticket）、§3.10.2（sign-url）
 *
 * 核心契约（§3.10 开篇）：后端**不中转文件流**。本服务只做三件事：
 *   ① 校验请求并生成规范化对象键
 *   ② 换取精确到该对象的 STS 临时凭证
 *   ③ 为本人目录下的对象签发短期访问 URL
 *
 * 事务边界：本服务**不写数据库**。
 * 「文件已上传」这一事实由 OSS 回调（§3.10.3）落库，业务登记由各业务接口
 * （如 `POST /users/me/avatar`）完成 —— 因此这里不存在半提交状态。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { isUniqueConstraintError } from '../../common/utils/prisma-error.util';
import type { AppConfig } from '../../config/config.type';
import { OssService } from '../../infra/oss/oss.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { type StorageCallbackDto, SIGN_URL_MAX_TTL, type SignUrlDto, type UploadTicketDto } from './dto/storage.dto';
import { detectMimeTypeFromMagic, isTrustedOssPublicKeyUrl, verifyOssCallbackSignature } from './oss-callback.util';
import { findSceneByPrefix, SCENE_POLICIES, sceneAllowedMimeTypes } from './storage-policy';
import {
  applyCdnDomain,
  assertObjectKeyOwnedBy,
  buildObjectKey,
  isSafePublicObjectKey,
  normalizeUploadRequest,
  parseObjectKey,
} from './storage.util';
import type {
  RegisteredObject,
  SignedUrlItem,
  SignedUrlsView,
  StorageCallbackResult,
  StorageScene,
  UploadTicket,
} from './storage.types';

/** OSS 回调公钥在 Redis 中的缓存键 */
const OSS_PUBLIC_KEY_CACHE_KEY = 'oss:callback:pubkey';

/** 公钥缓存时长（秒）：公钥轮换极低频，1 小时足够且避免每个回调都外呼 */
const OSS_PUBLIC_KEY_CACHE_TTL_SECONDS = 3600;

/** 拉取公钥的超时（毫秒）——回调需在 5s 内响应，外部调用必须限时 */
const PUBLIC_KEY_FETCH_TIMEOUT_MS = 3000;

/** 需要内容安全检测的场景（契约 §3.10.3 规则 3：AVATAR / FEEDBACK_IMAGE） */
const MODERATION_SCENES: ReadonlySet<string> = new Set(['AVATAR', 'FEEDBACK_IMAGE']);

/** 内容安全检测的 outbox 事件类型 */
const MODERATION_EVENT_TYPE = 'moderation.image';

/** 延迟清理的 outbox 事件类型（旧头像等被替换对象） */
const CLEANUP_EVENT_TYPE = 'maintenance.cleanup';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(OssService) private readonly oss: OssService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ConfigService) private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  /**
   * 签发上传票据（§3.10.1）
   *
   * 顺序不可调换：**先校验后签发**。若先向 OSS 换取凭证再校验，
   * 非法请求也会消耗 STS 配额（AssumeRole 有 TPS 限制），
   * 被刷时会把正常用户的上传一起拖垮。
   */
  async issueUploadTicket(userId: string, dto: UploadTicketDto): Promise<UploadTicket> {
    const globalMaxBytes = this.configService.get('oss.maxUploadBytes', { infer: true });

    const { policy, extension } = normalizeUploadRequest(
      {
        scene: dto.scene,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        size: dto.size,
      },
      globalMaxBytes,
    );

    const objectKey = buildObjectKey({
      prefix: policy.prefix,
      userId,
      objectId: randomUUID().replace(/-/g, ''),
      extension,
      date: new Date(),
    });

    const credentials = await this.oss.assumeUploadCredentials(objectKey);

    const fields: Record<string, string> = {
      key: objectKey,
      OSSAccessKeyId: credentials.accessKeyId,
      'security-token': credentials.securityToken,
      // 私有 Bucket：对象默认私有，读取一律走签名 URL（§3.10.1 规则 4）
      'x-oss-object-acl': 'private',
      success_action_status: '200',
      'Content-Type': dto.mimeType,
    };
    if (dto.md5 !== undefined) {
      fields['Content-MD5'] = Buffer.from(dto.md5, 'hex').toString('base64');
    }

    this.logger.log(`签发票据 userId=${userId} scene=${dto.scene} size=${dto.size} objectKey=${objectKey}`);

    return {
      provider: 'aliyun-oss',
      region: this.configService.get('oss.region', { infer: true }),
      bucket: this.configService.get('oss.bucket', { infer: true }),
      endpoint: this.oss.endpoint,
      cdnDomain: this.oss.publicDomain,
      objectKey,
      scene: policy.scene,
      maxSize: policy.maxBytes,
      allowedMimeTypes: sceneAllowedMimeTypes(policy),
      credentials,
      uploadForm: {
        method: 'POST',
        url: this.oss.endpoint,
        fields,
      },
      notice: {
        acl: 'private',
        signedUrlTtlSeconds: this.oss.defaultSignedUrlTtl,
        tip: '上传完成后请调用对应业务接口（如 POST /users/me/avatar）登记，否则文件不会生效。',
      },
    };
  }

  /**
   * 批量生成签名访问 URL（§3.10.2）
   *
   * **两阶段实现**，顺序是安全要求而非性能优化：
   *   阶段 1：对**全部**对象键做归属校验，任一不合法即整批拒绝（§3.10.2 错误码 `80009`）
   *   阶段 2：才进行 HEAD 探测与签名
   *
   * 若边校验边签名，攻击者可在同一批次里混入一个他人对象，
   * 从而通过响应内容差异（第 N 项报错 vs 前面已成功）探测他人对象是否存在。
   */
  async createSignedUrls(userId: string, dto: SignUrlDto): Promise<SignedUrlsView> {
    const requestedTtl = dto.expiresInSeconds ?? this.oss.defaultSignedUrlTtl;
    // DTO 已限制区间，此处再做一次防御性钳制：本方法也可能被其他模块直接调用
    const expiresInSeconds = Math.min(Math.max(requestedTtl, 60), SIGN_URL_MAX_TTL);

    // ---------------- 阶段 1：整批归属校验（纯计算，无 I/O） ----------------
    const publicKeys = new Set<string>();
    for (const objectKey of dto.objectKeys) {
      if (isSafePublicObjectKey(objectKey)) {
        publicKeys.add(objectKey);
        continue;
      }
      assertObjectKeyOwnedBy(objectKey, userId);
    }

    // ---------------- 阶段 2：探测 + 签名 ----------------
    const items: SignedUrlItem[] = [];

    for (const objectKey of dto.objectKeys) {
      // 公开静态资源无需签名，直接给 CDN 地址（§3.10.2 规则 1 的白名单例外）
      if (publicKeys.has(objectKey)) {
        const plainUrl = applyCdnDomain(`${this.oss.endpoint}/${objectKey}`, this.oss.publicDomain);
        items.push({
          objectKey,
          signedUrl: plainUrl,
          expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
          sizeBytes: null,
          mimeType: null,
          process: dto.process ?? null,
          exists: true,
        });
        continue;
      }

      const metadata = await this.oss.headObject(objectKey);

      if (!metadata.exists) {
        // 不存在不报错：批量场景下用户可能刚上传、OSS 尚在同步
        items.push({
          objectKey,
          signedUrl: null,
          expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
          sizeBytes: null,
          mimeType: null,
          process: dto.process ?? null,
          exists: false,
        });
        continue;
      }

      const signed = this.oss.signUrl(objectKey, {
        expiresInSeconds,
        ...(dto.process !== undefined ? { process: dto.process } : {}),
        ...(dto.responseContentDisposition !== undefined
          ? { responseContentDisposition: dto.responseContentDisposition }
          : {}),
      });

      items.push({
        objectKey,
        signedUrl: applyCdnDomain(signed.url, this.oss.publicDomain),
        expiresAt: signed.expiresAt.toISOString(),
        sizeBytes: metadata.sizeBytes,
        mimeType: metadata.mimeType,
        process: dto.process ?? null,
        exists: true,
      });
    }

    return {
      items,
      total: items.length,
      expiresInSeconds,
      generatedAt: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // POST /storage/callback（§3.10.3）
  // ==========================================================================

  /**
   * 处理 OSS 上传回调
   *
   * 本接口**公开无鉴权**（OSS 服务器调用），因此每一步都是安全边界，顺序不可调换：
   *   ① 验签 —— 不验签等于开放「任意文件登记」接口
   *   ② 结构校验 —— `objectKey` 三段式 + 已知场景前缀
   *   ③ 声明值校验 —— MIME 白名单与场景大小上限
   *   ④ **魔数校验** —— 读取对象真实文件头，与声明类型比对；不符即删除对象
   *   ⑤ 幂等落库 + 投递内容安全任务
   *
   * 为什么魔数校验必须放在落库之前：一旦先落库再校验，失败路径就需要「回滚」，
   * 而回滚遗漏会让违规文件永久留在 `stored_files` 里（并可能被业务登记使用）。
   * 先校验后写库则不存在中间态。
   *
   * 失败时抛 `BusinessException`（非 2xx），OSS 据此判定上传失败并回滚对象。
   */
  async handleCallback(
    headers: { publicKeyUrl?: string; authorization?: string; requestUrl: string },
    rawBody: string,
    dto: StorageCallbackDto,
  ): Promise<StorageCallbackResult> {
    if (!this.oss.isConfigured) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    // ---- ① 验签 ----
    const publicKeyPem = await this.resolvePublicKey(headers.publicKeyUrl);
    const signatureValid =
      publicKeyPem !== null &&
      verifyOssCallbackSignature({
        publicKeyPem,
        authorization: headers.authorization,
        url: headers.requestUrl,
        rawBody,
      });

    if (!signatureValid) {
      this.logger.warn(`OSS 回调验签失败 objectKey=${dto.objectKey}`);
      throw new BusinessException(ErrorCode.STORAGE_CALLBACK_INVALID);
    }

    // ---- ② 结构校验：场景由 objectKey 前缀反查（回调拿不到 scene 字段） ----
    const parsed = parseObjectKey(dto.objectKey);
    if (parsed === null) {
      throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '回调中的对象标识不合法');
    }

    const policy = findSceneByPrefix(parsed.prefix);
    if (policy === null) {
      throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '回调中的对象前缀不是已知上传场景');
    }

    // ---- ③ 声明值校验（复用与签发票据相同的场景策略，避免两处标准漂移） ----
    if (!(dto.mimeType in policy.mimeExtensions)) {
      throw new BusinessException(ErrorCode.FILE_TYPE_NOT_ALLOWED);
    }
    if (!Number.isInteger(dto.size) || dto.size <= 0 || dto.size > policy.maxBytes) {
      throw new BusinessException(ErrorCode.FILE_TOO_LARGE);
    }

    // ---- ④ 魔数校验：以对象真实内容为准，绝不信任声明值 ----
    // 期望集合只有「声明的那一种」——回调场景下检测结果必须与声明严格一致
    await this.verifyObjectContent(dto.objectKey, [dto.mimeType]);

    // ---- ⑤ 幂等落库 + 投递检测任务 ----
    const existing = await this.prisma.storedFile.findUnique({
      where: { objectKey: dto.objectKey },
      select: { id: true, etag: true },
    });

    // 同键不同 etag 说明对象被重新上传（内容已变），需重新检测
    const contentChanged = existing !== null && existing.etag !== dto.etag;
    const now = new Date();

    const file =
      existing === null
        ? await this.prisma.storedFile.create({
            data: {
              objectKey: dto.objectKey,
              userId: parsed.ownerUserId,
              scene: policy.scene,
              sizeBytes: dto.size,
              mimeType: dto.mimeType,
              etag: dto.etag,
              lastCallbackAt: now,
            },
            select: { id: true },
          })
        : await this.prisma.storedFile.update({
            where: { objectKey: dto.objectKey },
            data: {
              sizeBytes: dto.size,
              mimeType: dto.mimeType,
              etag: dto.etag,
              // 重复回调只累加计数，不重复投递检测任务（契约 §3.10.3 规则 5）
              callbackCount: { increment: 1 },
              lastCallbackAt: now,
              ...(contentChanged ? { safetyStatus: 'PENDING' as const } : {}),
            },
            select: { id: true },
          });

    let safetyCheckQueued = false;
    if (MODERATION_SCENES.has(policy.scene) && (existing === null || contentChanged)) {
      safetyCheckQueued = await this.enqueueModerationCheck(file.id, dto.objectKey, dto.etag);
    }

    this.logger.log(
      `OSS 回调已登记 objectKey=${dto.objectKey} scene=${policy.scene} size=${dto.size} isNew=${existing === null} safetyQueued=${safetyCheckQueued}`,
    );

    return {
      Status: 'OK',
      objectKey: dto.objectKey,
      etag: dto.etag,
      size: dto.size,
      mimeType: dto.mimeType,
      safetyCheckQueued,
      recordedAt: now.toISOString(),
    };
  }

  /**
   * 取得用于验签的 OSS 公钥
   *
   * 三重防护（推理见 `oss-callback.util.ts`）：
   *   ① 公钥 URL 必须来自**可信主机**（官方分发点或本桶域名）——
   *      既挡住 SSRF，也挡住「攻击者自带公钥+私钥」绕过验签
   *   ② 公钥内容缓存 1 小时 —— 公钥轮换极低频，避免每个回调都外呼
   *   ③ 拉取限时 3s —— 回调需在 5s 内完成，外部调用必须限时
   *
   * 任何失败都返回 `null`（调用方统一按验签失败拒绝），不向客户端泄露原因差异。
   */
  private async resolvePublicKey(rawPublicKeyUrl: string | undefined): Promise<string | null> {
    if (typeof rawPublicKeyUrl !== 'string' || rawPublicKeyUrl.length === 0) return null;

    // 该请求头是 Base64 编码后的 URL
    let decodedUrl: string;
    try {
      decodedUrl = Buffer.from(rawPublicKeyUrl, 'base64').toString('utf8');
    } catch {
      return null;
    }

    const bucket = this.configService.get('oss.bucket', { infer: true });
    const region = this.configService.get('oss.region', { infer: true });

    if (!isTrustedOssPublicKeyUrl({ rawUrl: decodedUrl, bucket, region })) {
      // 不可信来源可能是攻击尝试，单独告警以便安全侧发现
      this.logger.warn(`拒绝拉取不可信来源的 OSS 公钥: ${decodedUrl.slice(0, 120)}`);
      return null;
    }

    const cacheKey = this.redis.key(OSS_PUBLIC_KEY_CACHE_KEY, decodedUrl);
    const cached = await this.redis.get(cacheKey);
    if (cached !== null && cached.length > 0) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_KEY_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(decodedUrl, { signal: controller.signal });
      if (!response.ok) {
        this.logger.error(`拉取 OSS 公钥返回 HTTP ${response.status}`);
        return null;
      }

      const pem = await response.text();
      if (!pem.includes('PUBLIC KEY')) {
        this.logger.error('拉取的 OSS 公钥内容不合法（缺少 PUBLIC KEY 段）');
        return null;
      }

      await this.redis.set(cacheKey, pem, OSS_PUBLIC_KEY_CACHE_TTL_SECONDS);
      return pem;
    } catch (error) {
      this.logger.error(`拉取 OSS 公钥失败: ${(error as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 投递内容安全检测任务
   *
   * 走**事务性发件箱**而非直接推队列：`outbox_events.idempotencyKey` 的唯一约束
   * 免费提供了「同一对象同一版本只入队一次」的幂等保证（契约 §3.10.3 规则 5）——
   * 用数据库约束表达幂等，比在应用层判断更可靠（并发下不会双投）。
   *
   * 返回 `true` 表示本次**新投递**；返回 `false` 表示此前已投递过（重复回调）。
   */
  private async enqueueModerationCheck(fileId: string, objectKey: string, etag: string): Promise<boolean> {
    try {
      await this.prisma.outboxEvent.create({
        data: {
          eventType: MODERATION_EVENT_TYPE,
          aggregateType: 'stored_file',
          aggregateId: fileId,
          payload: { objectKey, etag },
          idempotencyKey: `${MODERATION_EVENT_TYPE}:${objectKey}:${etag}`,
        },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  // ==========================================================================
  // 业务登记（供 user / report 等模块调用）
  // ==========================================================================

  /**
   * 校验并登记一个已完成上传的对象
   *
   * 与 OSS 回调的分工：
   *   · 回调 = 「对象已上传」的**机器登记**（异步、可能因网络失败未到达）
   *   · 本方法 = 「该对象已被业务采用」的**用户确认**（同步、用户直接触发）
   *
   * 两者都做魔数校验**不是重复劳动**：回调可能没到达（例如尚未配置 `callbackUrl`），
   * 而业务登记必须能独立保证「被采用的文件确实是合法图片」。
   *
   * 校验顺序：归属 → 内容 → 大小 → 登记 → 公开化。
   * 公开化放在最后：**未通过校验的对象永远不会被公开**。
   */
  async registerUploadedObject(params: {
    readonly objectKey: string;
    readonly userId: string;
    readonly scene: StorageScene;
    /** 前端声明的大小，仅用于提前拒绝；权威值取 OSS HEAD 结果（契约 §3.2.3） */
    readonly declaredSize?: number;
  }): Promise<RegisteredObject> {
    if (!this.oss.isConfigured) {
      throw new BusinessException(ErrorCode.OSS_NOT_CONFIGURED);
    }

    const policy = SCENE_POLICIES[params.scene];

    // ---- 归属校验：必须是本人目录且前缀与该场景匹配 ----
    // 公开静态资源不属于任何用户，此处明确拒绝（返回 null 表示前提不成立）
    const parsed = assertObjectKeyOwnedBy(params.objectKey, params.userId);
    if (parsed === null) {
      throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '公开资源不能登记为个人文件');
    }
    if (parsed.prefix !== policy.prefix) {
      // 例如把 report-pdf 对象登记为头像 —— 归属没问题，但场景不符
      throw new BusinessException(ErrorCode.FILE_TYPE_NOT_ALLOWED, '对象场景与登记接口不匹配');
    }

    // ---- 内容校验（与回调共用同一实现） ----
    const mimeType = await this.verifyObjectContent(params.objectKey, sceneAllowedMimeTypes(policy));

    // ---- 大小以 OSS 为准 ----
    const metadata = await this.oss.headObject(params.objectKey);
    if (!metadata.exists) {
      throw new BusinessException(ErrorCode.OBJECT_NOT_FOUND, '上传的对象不存在，请重新上传');
    }

    const sizeBytes = metadata.sizeBytes ?? 0;
    const declaredTooLarge = typeof params.declaredSize === 'number' && params.declaredSize > policy.maxBytes;

    if (declaredTooLarge || sizeBytes <= 0 || sizeBytes > policy.maxBytes) {
      throw new BusinessException(
        ErrorCode.FILE_TOO_LARGE,
        `文件大小超出限制（上限 ${Math.floor(policy.maxBytes / 1024)} KB）`,
      );
    }

    const now = new Date();

    const file = await this.prisma.storedFile.upsert({
      where: { objectKey: params.objectKey },
      create: {
        objectKey: params.objectKey,
        userId: params.userId,
        scene: params.scene,
        sizeBytes,
        mimeType,
        etag: metadata.etag,
        registeredAt: now,
        lastCallbackAt: now,
      },
      update: {
        sizeBytes,
        mimeType,
        etag: metadata.etag,
        scene: params.scene,
        // 业务登记是「非孤儿」的判定依据（契约 §3.10.3 规则 6 的清理任务依赖它）
        registeredAt: now,
      },
      select: { id: true },
    });

    // 登记即视为业务采用：投递内容安全检测（幂等键与回调一致，不会重复投递）
    if (MODERATION_SCENES.has(params.scene)) {
      await this.enqueueModerationCheck(file.id, params.objectKey, metadata.etag ?? '');
    }

    // 通过全部校验后才公开（契约中 avatarUrl 是不带签名的 CDN 地址）
    if (policy.publicRead) {
      const aclApplied = await this.oss.putObjectAcl(params.objectKey, 'public-read');
      if (!aclApplied) {
        this.logger.warn(`对象公开化失败，该文件将无法通过未签名 URL 访问 objectKey=${params.objectKey}`);
      }
    }

    this.logger.log(
      `对象已登记 objectKey=${params.objectKey} scene=${params.scene} size=${sizeBytes} mime=${mimeType}`,
    );

    return {
      objectKey: params.objectKey,
      sizeBytes,
      mimeType,
      etag: metadata.etag,
      publicUrl: this.publicUrlOf(params.objectKey),
    };
  }

  /**
   * 安排延迟删除某个对象（契约 §3.2.3 规则 3：旧头像 7 天后删除）
   *
   * 为什么不立即删除：CDN 与客户端仍持有旧图缓存，立刻删会造成一段时间内
   * 图片 404 闪烁。延迟量由调用方按场景给出。
   *
   * 未在 `stored_files` 中登记的对象**不伪造审计记录**，交由 24h 孤儿清理兜底 ——
   * 精确清理需要可引用的实体，凭空造一条记录只会污染审计数据。
   */
  async scheduleObjectCleanup(objectKey: string, delayDays: number): Promise<boolean> {
    const file = await this.prisma.storedFile.findUnique({
      where: { objectKey },
      select: { id: true },
    });

    if (file === null) {
      this.logger.warn(`待清理对象未登记，交给孤儿清理兜底 objectKey=${objectKey}`);
      return false;
    }

    try {
      await this.prisma.outboxEvent.create({
        data: {
          eventType: CLEANUP_EVENT_TYPE,
          aggregateType: 'stored_file',
          aggregateId: file.id,
          payload: { objectKey, reason: 'replaced' },
          availableAt: new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000),
          idempotencyKey: `${CLEANUP_EVENT_TYPE}:${objectKey}`,
        },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /** 对象的对外访问地址（走 CDN 域名；未配置 CDN 时回退 Bucket 域名） */
  publicUrlOf(objectKey: string): string {
    const domain = this.oss.publicDomain.replace(/\/+$/, '');
    return `${domain}/${objectKey}`;
  }

  /**
   * 上传**服务端生成**的对象（导出包等）
   *
   * 为什么收在 storage 模块：全项目只有这一处直接使用 OSS 写入能力，
   * 散到各业务模块会导致「有的地方设 ACL、有的地方不设」这类不一致。
   *
   * 这类对象**不经过场景策略表**：它不由客户端申请票据上传，对象键完全由服务端决定，
   * 因此不需要归属校验，也不该出现在 `upload-ticket` 的 scene 枚举里
   * （否则等于给客户端开了申请导出票据的入口）。
   */
  async uploadServerObject(params: {
    readonly objectKey: string;
    readonly body: Buffer | string;
    readonly contentType: string;
  }): Promise<{ etag: string | null; sizeBytes: number }> {
    return this.oss.putObject(params.objectKey, params.body, params.contentType);
  }

  /** 为**服务端生成**的对象签发下载 URL（不做归属校验，仅限内部调用） */
  signServerObjectUrl(
    objectKey: string,
    expiresInSeconds: number,
    responseContentDisposition?: string,
  ): { url: string; expiresAt: Date } {
    const signed = this.oss.signUrl(objectKey, {
      expiresInSeconds,
      ...(responseContentDisposition !== undefined ? { responseContentDisposition } : {}),
    });

    return { url: applyCdnDomain(signed.url, this.oss.publicDomain), expiresAt: signed.expiresAt };
  }

  /**
   * 校验对象真实内容类型（魔数），不符即**删除对象**
   *
   * 抽成共享实现的原因：回调与业务登记都需要这一步，两处各写一份必然漂移
   * （例如一处忘了在失败时删除对象，就会留下无法被任何流程识别的垃圾文件）。
   *
   * 返回检测到的 MIME 类型，供调用方登记使用。
   */
  private async verifyObjectContent(objectKey: string, expectedMimeTypes: readonly string[]): Promise<string> {
    const prefixBuffer = await this.oss.readPrefix(objectKey);

    if (prefixBuffer === null) {
      // 声明上传成功但对象读不到：客户端上传中途失败，或对象已被清理
      throw new BusinessException(ErrorCode.OBJECT_NOT_FOUND, '上传的对象不存在，请重新上传');
    }

    const detectedMimeType = detectMimeTypeFromMagic(prefixBuffer);
    if (detectedMimeType === null || !expectedMimeTypes.includes(detectedMimeType)) {
      // 不符的对象必须立即从存储中消失，不能只拒绝请求
      await this.oss.deleteObject(objectKey);
      this.logger.warn(
        `魔数校验失败并已删除对象 objectKey=${objectKey} expected=${expectedMimeTypes.join('|')} detected=${detectedMimeType ?? 'unknown'}`,
      );
      throw new BusinessException(ErrorCode.FILE_MAGIC_MISMATCH);
    }

    return detectedMimeType;
  }
}
