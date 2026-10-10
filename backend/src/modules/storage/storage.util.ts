/**
 * 存储模块纯函数工具（无 I/O、无依赖注入、可 100% 单测）
 *
 * 抽取动机同 ADR-027：上传路径的安全校验（扩展名伪造、路径穿越、越权登记）
 * 是**安全边界**，把它藏在 Service 的私有方法里只能靠构造业务数据间接覆盖，
 * 往往覆盖不全。抽成纯函数后每条拒绝分支都能被直接锁定。
 *
 * 威胁模型（架构 §14.2 / §14.3）：
 *   ① 用户声明 `image/png` 实际传 `.html` → 在 CDN 上形成可执行内容
 *   ② 对象名含 `../` → 逃逸出自己的目录，读写他人文件
 *   ③ 借用签名接口读取他人对象（IDOR）
 *   ④ 拼接 URL 时对象名注入 `?` / `#` / `%` 篡改签名参数
 */

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { EXTENSION_MIME, getScenePolicy, PUBLIC_PREFIX, SCENE_PREFIXES } from './storage-policy';
import type { ParsedObjectKey, ScenePolicy, StorageScene } from './storage.types';

/**
 * 危险字符：控制字符、反斜杠，以及 URL 定界符（`%` `?` `#`）
 *
 * `%` `?` `#` 必须拒绝：对象键会被原样拼进签名 URL，一旦包含这些字符，
 * URL 解析结果与签名覆盖的键不一致，轻则 403，重则被当作参数注入点。
 * 服务端生成的对象键**从不包含**这些字符，因此拒绝它们不会误伤合法请求。
 */
// eslint-disable-next-line no-control-regex -- 有意匹配控制字符：它们的用途是被拒绝，而非被允许
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\\%?#]/;

/** 路径段白名单：字母、数字、下划线、连字符（不含点，故 `..` 不可能成为段） */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** 文件名白名单：必须以字母或数字开头，之后允许点、下划线、连字符 */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 对象键长度上限（契约 §3.10.1 / §3.10.2：1–200 字符） */
const MAX_OBJECT_KEY_LENGTH = 200;

/** 原始文件名长度上限（契约 §3.10.1：1–128 字符） */
const MAX_FILE_NAME_LENGTH = 128;

/**
 * 从原始文件名中提取扩展名
 *
 * 这是**唯一**从用户输入中取用的信息 —— 对象名其余部分全部由服务端生成。
 * 返回小写扩展名（不含点）；任何可疑输入一律返回 `null`（由调用方转成业务错误）。
 */
export const extractExtension = (fileName: string): string | null => {
  if (fileName.length === 0 || fileName.length > MAX_FILE_NAME_LENGTH) return null;
  if (UNSAFE_CHARS.test(fileName)) return null;
  // 含路径分隔符或 `..` 的文件名一律拒绝：不做「猜测意图」的兼容，
  // 避免 `../../x.jpg` 这类输入在不同层被解释成不同路径
  if (fileName.includes('/') || fileName.includes('..')) return null;

  const lastDot = fileName.lastIndexOf('.');
  // lastDot <= 0 同时覆盖「无扩展名」与「.hidden」两种情形
  if (lastDot <= 0 || lastDot === fileName.length - 1) return null;

  const extension = fileName.slice(lastDot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(extension)) return null;

  return extension;
};

/**
 * 对象键日期段：UTC 的 `yyyyMMdd`
 *
 * 固定用 UTC 而非服务器本地时区 —— 多实例部署在不同时区时，
 * 本地时间会让同一天的产物散落到不同目录，清理任务难以按日归档。
 */
export const formatObjectKeyDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

/** `buildObjectKey` 入参 */
export interface BuildObjectKeyParams {
  /** 场景路径前缀（取自场景策略，非用户输入） */
  readonly prefix: string;
  /** 当前用户 ID（取自 JWT） */
  readonly userId: string;
  /**
   * 对象随机标识：去连字符的 UUID（32 位十六进制）
   *
   * 契约 §3.10.1 规则 1 的表述是「uuid 去连字符」；该节示例中的 16 位标识为
   * 示例简写。此处按规则正文实现为完整 32 位，以获得足够的唯一性余量。
   */
  readonly objectId: string;
  /** 落库扩展名（必须由 MIME 推导，见 `normalizeUploadRequest`） */
  readonly extension: string;
  /** 生成时间（用于日期段） */
  readonly date: Date;
}

/**
 * 生成对象键：`{prefix}/{userId}/{yyyyMMdd}_{objectId}.{extension}`
 *
 * 与契约 §3.10.1 规则 1 完全一致，且逐段做白名单校验：
 * 即使调用方传入了异常值，也不可能拼出带 `..` 或 `/` 逃逸的键。
 */
export const buildObjectKey = (params: BuildObjectKeyParams): string => {
  const { prefix, userId, objectId, extension, date } = params;

  if (!SAFE_SEGMENT.test(prefix)) {
    throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '上传场景前缀非法');
  }
  if (!SAFE_SEGMENT.test(userId)) {
    throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '用户标识非法');
  }
  if (!/^[a-f0-9]{16,64}$/.test(objectId)) {
    throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '对象标识非法');
  }
  if (!/^[a-z0-9]{1,8}$/.test(extension)) {
    throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '文件扩展名非法');
  }

  return `${prefix}/${userId}/${formatObjectKeyDate(date)}_${objectId}.${extension}`;
};

/**
 * 解析对象键（严格三段式 `{prefix}/{userId}/{fileName}`）
 *
 * 三段式的价值：`split('/')` 后若出现空段（`//`）或额外段，直接判定非法，
 * 因此 `..` 想构成穿越就必须占用一个段，而段白名单不允许点号 ——
 * 穿越在结构上不可表达，而不是依赖某条正则去「拦住」它。
 *
 * 非法输入返回 `null`；`public/` 静态资源不适用本函数（见 `isSafePublicObjectKey`）。
 */
export const parseObjectKey = (objectKey: string): ParsedObjectKey | null => {
  if (objectKey.length === 0 || objectKey.length > MAX_OBJECT_KEY_LENGTH) return null;
  if (UNSAFE_CHARS.test(objectKey)) return null;
  if (objectKey.startsWith('/') || objectKey.endsWith('/')) return null;

  const segments = objectKey.split('/');
  if (segments.length !== 3) return null;

  const [prefix, ownerUserId, fileName] = segments;
  if (!SAFE_SEGMENT.test(prefix)) return null;
  if (!SAFE_SEGMENT.test(ownerUserId)) return null;
  if (!SAFE_FILE_NAME.test(fileName)) return null;

  return { prefix, ownerUserId, fileName };
};

/** `public/` 前缀的公开静态资源：无需签名，但同样禁止穿越与危险字符 */
export const isSafePublicObjectKey = (objectKey: string): boolean => {
  if (objectKey.length <= PUBLIC_PREFIX.length + 1 || objectKey.length > MAX_OBJECT_KEY_LENGTH) return false;
  if (UNSAFE_CHARS.test(objectKey)) return false;
  if (!objectKey.startsWith(`${PUBLIC_PREFIX}/`)) return false;
  if (objectKey.endsWith('/')) return false;

  // 公开资源允许更深层级（如 public/static/avatar/default.webp）
  return objectKey.split('/').every((segment) => SAFE_FILE_NAME.test(segment));
};

/**
 * 校验对象键归属当前用户，返回解析结果（不合法即抛错）
 *
 * 两道校验的顺序有意如此：
 *   ① 结构/前缀不合法 → `80008`（400）：这是「请求写错了」，与越权无关
 *   ② 结构合法但属于他人 → `80009`（403）：这是明确的越权尝试，需单独告警
 *
 * 把两者混为一谈会掩盖攻击信号 —— 用 400 回绝「读别人的文件」，
 * 在监控上看起来只是参数错误。
 */
export const assertObjectKeyOwnedBy = (objectKey: string, userId: string): ParsedObjectKey | null => {
  // 公开静态资源无需归属校验（也不参与签名，由调用方直接返回 CDN 地址）
  if (isSafePublicObjectKey(objectKey)) return null;

  const parsed = parseObjectKey(objectKey);
  if (parsed === null) {
    throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '文件标识不合法');
  }
  // 前缀必须在已知场景白名单内，避免任意目录被登记
  if (!SCENE_PREFIXES.has(parsed.prefix)) {
    throw new BusinessException(ErrorCode.OBJECT_KEY_INVALID, '文件标识不合法');
  }
  if (parsed.ownerUserId !== userId) {
    throw BusinessException.forbidden(ErrorCode.OBJECT_NOT_OWNED);
  }

  return parsed;
};

/**
 * 把签名 URL 的域名替换为 CDN 域名（契约 §3.10.2 规则 3）
 *
 * 只替换 origin，**逐字节保留** path 与 query —— 签名是对
 * `path + 规范化 query` 计算出来的，一旦重建 URL（如经 `new URL().toString()`）
 * 触发再编码，签名就会失效。CDN 需配置为回源透传签名参数。
 */
export const applyCdnDomain = (signedUrl: string, cdnDomain: string): string => {
  if (signedUrl.length === 0) return signedUrl;
  if (cdnDomain.trim().length === 0) return signedUrl;

  const normalizedDomain = cdnDomain.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(normalizedDomain)) return signedUrl;

  const matched = /^https?:\/\/[^/]+(\/.*)$/.exec(signedUrl);
  if (matched === null) return signedUrl;

  return `${normalizedDomain}${matched[1]}`;
};

/** `normalizeUploadRequest` 入参 */
export interface NormalizeUploadInput {
  readonly scene: StorageScene;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
}

/** 规范化结果 */
export interface NormalizedUpload {
  /** 命中的场景策略 */
  readonly policy: ScenePolicy;
  /** 由 MIME 推导的落库扩展名（**不是**用户声明的扩展名） */
  readonly extension: string;
}

/**
 * 校验并规范化上传请求
 *
 * 拒绝顺序刻意按「先便宜的枚举校验，再内容校验」排列，
 * 且每类拒绝都给出**可区分**的错误码，便于前端定位与后端监控归因。
 */
export const normalizeUploadRequest = (input: NormalizeUploadInput, globalMaxBytes: number): NormalizedUpload => {
  const policy = getScenePolicy(input.scene);

  // 预留场景不得签发票据
  if (!policy.enabled) {
    throw new BusinessException(ErrorCode.STORAGE_SCENE_NOT_ALLOWED);
  }

  // 场景级 MIME 白名单：命中即**同时**拿到该 MIME 的落库扩展名。
  // 显式标注 `string | undefined` 而非依赖索引签名：白名单未命中的分支
  // 是真实可达的拒绝路径（例如 AVATAR 声明 application/pdf），必须能被覆盖到。
  const canonicalExtension: string | undefined = policy.mimeExtensions[input.mimeType];
  if (canonicalExtension === undefined) {
    throw new BusinessException(ErrorCode.FILE_TYPE_NOT_ALLOWED);
  }

  const declaredExtension = extractExtension(input.fileName);
  if (declaredExtension === null) {
    throw new BusinessException(ErrorCode.FILE_TYPE_NOT_ALLOWED);
  }
  // 扩展名与 MIME 必须同族：`photo.png` 声明 `image/jpeg` 属自相矛盾，
  // 其中一项必假，直接拒绝而不是「以某一边为准」。
  // 该检查同时覆盖未知扩展名（`EXTENSION_MIME[ext]` 为 undefined）
  if (EXTENSION_MIME[declaredExtension] !== input.mimeType) {
    throw new BusinessException(ErrorCode.FILE_TYPE_NOT_ALLOWED, '文件扩展名与类型不匹配');
  }

  // 全局硬顶只能**收紧**场景上限，不能放宽（取较小者）
  const effectiveMaxBytes = globalMaxBytes > 0 ? Math.min(policy.maxBytes, globalMaxBytes) : policy.maxBytes;

  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > effectiveMaxBytes) {
    throw new BusinessException(
      ErrorCode.FILE_TOO_LARGE,
      `文件大小超出限制（上限 ${Math.floor(effectiveMaxBytes / 1024)} KB）`,
    );
  }

  return { policy, extension: canonicalExtension };
};

/**
 * 从完整访问 URL 中还原对象键
 *
 * 用途：`users.avatarUrl` 存的是给前端直接用的完整 URL，但「清理旧头像」需要的是对象键。
 * 因此必须能从 URL 反推回键 —— 且**只在确属本系统对象时才承认**：
 * 校验三段式结构与已知场景前缀，避免把用户手工填的外部图片地址（如 CDN 默认图、
 * 第三方图床）当成待清理对象而误删。
 *
 * 返回 `null` 表示「不是本系统的对象键」，调用方应据此跳过清理而不是猜测。
 */
export const extractObjectKeyFromUrl = (url: string | null | undefined): string | null => {
  if (typeof url !== 'string' || url.length === 0) return null;

  let pathname: string;
  try {
    // 相对地址（如 `/avatar/...`）无法用 URL 解析，先补一个占位 origin
    pathname = new URL(url, 'https://placeholder.invalid').pathname;
  } catch {
    return null;
  }

  const objectKey = decodeURIComponent(pathname.replace(/^\/+/, ''));
  const parsed = parseObjectKey(objectKey);

  if (parsed === null) return null;
  // 必须是本系统的已知场景前缀，否则可能是外部图片地址
  if (!SCENE_PREFIXES.has(parsed.prefix)) return null;

  return objectKey;
};
