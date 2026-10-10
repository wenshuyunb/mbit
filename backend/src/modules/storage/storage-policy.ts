/**
 * 存储场景策略表（纯数据 + 查表，无 I/O）
 *
 * 契约来源：docs/API_DESIGN.md §3.10.1「场景约束」表。
 * 大小上限与契约 §3.14.4 下发的 `system_config.uploadMaxBytes`（AVATAR 2097152 /
 * FEEDBACK_IMAGE 5242880 / REPORT_PDF 20971520）保持一致。
 *
 * 设计取舍（同 ADR-028 的思路）：场景策略**只维护一张 MIME → 落库扩展名映射**，
 * 不再单独维护「允许的 MIME 数组」与「允许的扩展名数组」。
 * 三张表需要保持同步的隐式不变量，一旦漂移就会出现
 * 「MIME 在数组里、却查不到扩展名」的静默错误，并产生永远不可达的兜底分支。
 * 现在「允许的 MIME」就是这张映射的键集合 —— 漂移在结构上不可表达。
 */

import type { ScenePolicy, StorageScene } from './storage.types';

/** 1 MB（便于阅读上限定义） */
const MB = 1024 * 1024;

/** 图片类场景的 MIME → 落库扩展名 */
const IMAGE_MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

/**
 * 全局 MIME → 落库扩展名映射
 *
 * 对象名**只由 MIME 推导扩展名**，不使用用户提供的扩展名 ——
 * 否则用户可声明 `image/png` 却上传 `.html`，在 CDN 上形成可执行内容。
 */
export const MIME_CANONICAL_EXTENSION: Readonly<Record<string, string>> = {
  ...IMAGE_MIME_EXTENSIONS,
  'application/pdf': 'pdf',
};

/**
 * 扩展名 → 其所属 MIME
 *
 * 用于校验「用户声明的扩展名」与「声明的 MIME」是否同族：
 * `photo.jpeg` + `image/jpeg` 合法；`photo.png` + `image/jpeg` 需拒绝
 * （声明自相矛盾，真实类型必然与其中之一不符，属可疑上传）。
 *
 * 注意 `jpeg` 只是**合法的声明写法**，永远不是落库扩展名（落库统一为 `jpg`）。
 */
export const EXTENSION_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** 场景策略表 */
export const SCENE_POLICIES: Readonly<Record<StorageScene, ScenePolicy>> = {
  AVATAR: {
    scene: 'AVATAR',
    prefix: 'avatar',
    mimeExtensions: IMAGE_MIME_EXTENSIONS,
    maxBytes: 2 * MB,
    publicRead: true, // 头像需公开可读（契约 §3.2.3 返回不带签名的 CDN 地址）
    enabled: true,
  },
  REPORT_PDF: {
    scene: 'REPORT_PDF',
    prefix: 'report-pdf',
    mimeExtensions: { 'application/pdf': 'pdf' },
    maxBytes: 20 * MB,
    publicRead: false, // 报告含个人隐私，必须私有 + 签名 URL
    enabled: true,
  },
  SHARE_CARD: {
    scene: 'SHARE_CARD',
    prefix: 'share-card',
    mimeExtensions: IMAGE_MIME_EXTENSIONS,
    maxBytes: 5 * MB,
    publicRead: true, // 分享图需公开可读（用于对外分享）
    enabled: true,
  },
  FEEDBACK_IMAGE: {
    scene: 'FEEDBACK_IMAGE',
    prefix: 'feedback',
    mimeExtensions: IMAGE_MIME_EXTENSIONS,
    maxBytes: 5 * MB,
    publicRead: false, // 客服反馈附图含用户隐私，保持私有 + 签名 URL
    enabled: true,
  },
  CHAT_ATTACHMENT: {
    scene: 'CHAT_ATTACHMENT',
    prefix: 'chat',
    mimeExtensions: IMAGE_MIME_EXTENSIONS,
    maxBytes: 5 * MB,
    publicRead: false, // 对话附件含隐私，保持私有
    // 契约 §3.10.1：预留场景，当前功能未开放
    enabled: false,
  },
};

/** 静态资源前缀：该前缀下的对象无需签名，直接走 CDN 公开访问（契约 §3.10.2 规则 1） */
export const PUBLIC_PREFIX = 'public';

/** 所有已知场景前缀（归属校验的白名单，杜绝任意前缀被登记） */
export const SCENE_PREFIXES: ReadonlySet<string> = new Set(
  Object.values(SCENE_POLICIES).map((policy) => policy.prefix),
);

/**
 * 全局可上传的 MIME 白名单（契约 §3.10.1 请求体约束）
 *
 * 由 `MIME_CANONICAL_EXTENSION` 派生，避免两处各写一份而漂移。
 * 注意这是**请求入口**的粗过滤，真正的场景级白名单在 `SCENE_POLICIES`。
 */
export const ALL_UPLOAD_MIME_TYPES: readonly string[] = Object.keys(MIME_CANONICAL_EXTENSION);

/** 按场景取策略（`SCENE_POLICIES` 对场景类型穷举，故必然有值） */
export const getScenePolicy = (scene: StorageScene): ScenePolicy => SCENE_POLICIES[scene];

/** 场景允许的 MIME 列表（对外响应需下发该字段） */
export const sceneAllowedMimeTypes = (policy: ScenePolicy): readonly string[] => Object.keys(policy.mimeExtensions);

/**
 * 按前缀反查场景策略（`null` 表示该前缀不是已知场景）
 *
 * 用途：OSS 回调只能拿到 `objectKey`，场景需由前缀反推（契约 §3.10.3 规则 3）。
 * 返回 `null` 而非抛错，便于调用方区分「未知前缀」与「配置缺失」两种处理方式。
 */
export const findSceneByPrefix = (prefix: string): ScenePolicy | null =>
  Object.values(SCENE_POLICIES).find((policy) => policy.prefix === prefix) ?? null;
