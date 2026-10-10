/**
 * OSS 上传回调的验签与内容校验（纯函数，无 I/O、可 100% 单测）
 *
 * 契约来源：docs/API_DESIGN.md §3.10.3
 *
 * 为什么这些必须是纯函数：本接口是**公开端点**（OSS 服务器调用，无登录态），
 * 它的唯一安全边界就是「验签 + 魔数校验 + 场景约束」。把这三件事藏在 Service 里，
 * 只能靠构造回调请求间接覆盖，而安全边界的每一条拒绝分支都必须能被直接断言。
 *
 * 两个必须讲清楚的威胁模型：
 *   ① **伪造回调**：不验签等于开放「任意文件登记」接口 —— 攻击者可凭空往
 *      `stored_files` 里塞记录、绕过内容安全流程
 *   ② **SSRF / 密钥替换**：`x-oss-pub-key-url` 是**攻击者可控的请求头**。
 *      若直接 fetch，轻则探测内网（云元数据端点 169.254.169.254），
 *      重则让攻击者用自己的 OSS 账号托管公钥、用**自己的私钥**签名，
 *      从而完全绕过验签。因此公钥 URL 必须限定在可信主机上（见下）。
 */

import { createVerify } from 'node:crypto';

// ============================================================================
// 魔数校验（架构 §14.3 要求「魔数校验」，防止声明 image/png 实传可执行内容）
// ============================================================================

/** PNG 完整 8 字节签名（比契约里写的 4 字节更严格） */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 单条魔数规则 */
interface MagicRule {
  readonly mimeType: string;
  /** 判定所需的最少字节数 */
  readonly minBytes: number;
  readonly matches: (buffer: Buffer) => boolean;
}

/**
 * 魔数规则表
 *
 * 顺序无关（各类文件头前缀互不重叠），但保持「最可能命中者在前」便于阅读。
 * WebP 特殊之处：`RIFF` 与 `WEBP` 之间有 4 字节长度字段，必须同时校验两段，
 * 否则任意 RIFF 容器（如 WAV）都会被判成 WebP。
 */
const MAGIC_RULES: readonly MagicRule[] = [
  {
    mimeType: 'image/jpeg',
    minBytes: 3,
    matches: (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    minBytes: PNG_SIGNATURE.length,
    matches: (buffer) => buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
  },
  {
    mimeType: 'image/webp',
    minBytes: 12,
    matches: (buffer) =>
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mimeType: 'application/pdf',
    minBytes: 4,
    matches: (buffer) => buffer.subarray(0, 4).toString('ascii') === '%PDF',
  },
];

/**
 * 由文件头字节推断真实 MIME 类型
 *
 * 返回 `null` 表示「无法识别」——调用方必须把它当作拒绝理由，
 * 🚫 不得回退为「信任声明值」（那样魔数校验就白做了）。
 */
export const detectMimeTypeFromMagic = (buffer: Buffer): string | null => {
  if (!Buffer.isBuffer(buffer)) return null;

  for (const rule of MAGIC_RULES) {
    if (buffer.length < rule.minBytes) continue;
    if (rule.matches(buffer)) return rule.mimeType;
  }

  return null;
};

/** 读取魔数所需字节数（取规则表最大值，一次 HEAD/Range 读即可判定全部类型） */
export const MAGIC_BYTES_REQUIRED = 16;

// ============================================================================
// 回调验签
// ============================================================================

/** OSS 回调 `Authorization` 头形态：`OSS <accessKeyId>:<base64 签名>` */
const OSS_AUTHORIZATION_PATTERN = /^OSS\s+([A-Za-z0-9_\-/+=]+):([A-Za-z0-9+/=]+)$/;

/** 解析后的 Authorization */
export interface ParsedOssAuthorization {
  readonly accessKeyId: string;
  readonly signature: string;
}

/**
 * 解析 `Authorization` 头
 *
 * 用正则一次解析而非 `split(':')`：accessKeyId 可能含 `:` 之外的符号，
 * 且签名是 base64（可能含 `=` 填充与 `/` `+`），盲目 split 会切错位置。
 */
export const parseOssAuthorization = (header: string | undefined): ParsedOssAuthorization | null => {
  if (typeof header !== 'string') return null;

  const matched = OSS_AUTHORIZATION_PATTERN.exec(header.trim());
  if (matched === null) return null;

  return { accessKeyId: matched[1], signature: matched[2] };
};

/**
 * 构造被签名的原文
 *
 * 阿里云 OSS 回调签名覆盖的是 `回调 URL（含 query）\n 原始请求体`。
 * 两处都必须是**原样字节**：URL 不能用解码后的形式，body 不能重新序列化。
 */
export const buildCallbackSignaturePayload = (url: string, rawBody: string): string => `${url}\n${rawBody}`;

/** 验签入参 */
export interface VerifyCallbackSignatureParams {
  /** OSS 公钥（PEM 格式） */
  readonly publicKeyPem: string;
  /** 请求头 `Authorization` 原值 */
  readonly authorization: string | undefined;
  /** 回调 URL（含 query，与 OSS 侧一致） */
  readonly url: string;
  /** 原始请求体字符串 */
  readonly rawBody: string;
}

/**
 * 验证 OSS 回调签名（RSA-SHA1）
 *
 * 任何异常都归一为 `false`（而非抛出）：验签失败与「公钥不可解析」在安全语义上
 * 等价 —— 都不能证明请求来自 OSS，调用方只需据此拒绝。
 */
export const verifyOssCallbackSignature = (params: VerifyCallbackSignatureParams): boolean => {
  const parsed = parseOssAuthorization(params.authorization);
  if (parsed === null) return false;
  if (typeof params.publicKeyPem !== 'string' || !params.publicKeyPem.includes('PUBLIC KEY')) {
    return false;
  }

  try {
    const verifier = createVerify('RSA-SHA1');
    verifier.update(buildCallbackSignaturePayload(params.url, params.rawBody), 'utf8');
    return verifier.verify(params.publicKeyPem, Buffer.from(parsed.signature, 'base64'));
  } catch {
    return false;
  }
};

// ============================================================================
// 公钥来源可信性（SSRF 与「自带密钥」双重防护）
// ============================================================================

/** 阿里云官方公钥主机（回调公钥的共享分发点） */
const OFFICIAL_PUBLIC_KEY_HOST = 'gosspublic.alicdn.com';

/**
 * 判断公钥 URL 是否可信
 *
 * 只允许两个来源，且**精确匹配主机名**（不用后缀匹配）：
 *   ① 阿里云官方分发点 `gosspublic.alicdn.com`
 *   ② **本桶自己的域名** `{bucket}.{region}.aliyuncs.com`
 *
 * 为什么不能放宽为「任意 *.aliyuncs.com」：任何人注册一个 OSS 账号就得到
 * 一个 `*.aliyuncs.com` 域名，可在其上托管**自己的**公钥并用**自己的**私钥签名 ——
 * 那样验签会通过，攻击者即可伪造上传回调。这是本项目最容易写错的一处。
 *
 * 同时该白名单天然拦住 SSRF：内网地址、云元数据端点、任意第三方域名全部不在列。
 */
export const isTrustedOssPublicKeyUrl = (params: {
  readonly rawUrl: string;
  readonly bucket: string;
  readonly region: string;
}): boolean => {
  if (typeof params.rawUrl !== 'string' || params.rawUrl.length === 0) return false;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.rawUrl);
  } catch {
    return false;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return false;

  const host = parsedUrl.hostname.toLowerCase();
  const ownBucketHost = `${params.bucket}.${params.region}.aliyuncs.com`.toLowerCase();

  return host === OFFICIAL_PUBLIC_KEY_HOST || host === ownBucketHost;
};
