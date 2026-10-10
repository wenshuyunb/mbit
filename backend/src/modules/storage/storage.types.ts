/**
 * 存储模块类型定义
 *
 * 契约来源：docs/API_DESIGN.md §3.10（存储 storage）
 *
 * 设计边界（架构 §14.2 / §14.3）：
 *   · 后端**不中转文件流** —— 小程序/Admin 拿 STS 凭证直传 OSS
 *   · 后端只负责三件事：签发凭证、登记校验、接收回调
 *   · 对象名一律由服务端生成，**绝不使用用户提供的文件名**
 */

/** 上传场景（契约 §3.10.1 枚举） */
export const STORAGE_SCENES = ['AVATAR', 'REPORT_PDF', 'SHARE_CARD', 'FEEDBACK_IMAGE', 'CHAT_ATTACHMENT'] as const;

export type StorageScene = (typeof STORAGE_SCENES)[number];

/** 场景策略：决定路径前缀、类型白名单与大小上限 */
export interface ScenePolicy {
  readonly scene: StorageScene;
  /** 对象键路径前缀（不含 userId），同时也是归属校验的白名单依据 */
  readonly prefix: string;
  /**
   * 允许的 MIME → 落库扩展名映射
   *
   * 用一张映射同时表达「白名单」与「规范化扩展名」两件事：
   * 键集合即允许的 MIME，值即该 MIME 的落库扩展名。
   * 拆成两个数组会引入必须手工保持同步的隐式不变量（见 `storage-policy.ts` 说明）。
   */
  readonly mimeExtensions: Readonly<Record<string, string>>;
  /** 场景大小上限（字节） */
  readonly maxBytes: number;
  /**
   * 业务登记后是否将该对象置为 `public-read`
   *
   * 为什么需要这个字段：接口契约中 `avatarUrl` / 分享图是**不带签名的 CDN 地址**
   * （见 §3.2.3 与 §3.2.1 的响应示例），说明这类对象设计上就是公开可读的；
   * 而报告 PDF、反馈附件必须保持私有 + 签名 URL（架构 §14.2）。
   * 把差异写成声明式字段，而不是在业务代码里散落 `if (scene === 'AVATAR')`。
   *
   * 初始上传一律 `private`，只有在**通过魔数与大小校验的业务登记**之后才转为公开 ——
   * 这样未登记成功的对象永远不会被公开。
   */
  readonly publicRead: boolean;
  /**
   * 场景是否已开放。
   *
   * `CHAT_ATTACHMENT` 在契约 §3.10.1 标注为「预留，当前功能未开放」，
   * 因此对它签发票据必须被拒绝（`80007`）—— 否则等于提前开放了未评审的上传入口。
   */
  readonly enabled: boolean;
}

/** 解析后的对象键（`{prefix}/{userId}/{fileName}` 三段式） */
export interface ParsedObjectKey {
  readonly prefix: string;
  readonly ownerUserId: string;
  readonly fileName: string;
}

/** 上传票据 */
export interface UploadTicket {
  readonly provider: 'aliyun-oss';
  readonly region: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly cdnDomain: string;
  readonly objectKey: string;
  readonly scene: StorageScene;
  readonly maxSize: number;
  readonly allowedMimeTypes: readonly string[];
  readonly credentials: {
    readonly accessKeyId: string;
    readonly accessKeySecret: string;
    readonly securityToken: string;
    readonly expiration: string;
    readonly expiresInSeconds: number;
  };
  readonly uploadForm: {
    readonly method: 'POST';
    readonly url: string;
    readonly fields: Record<string, string>;
  };
  readonly notice: {
    readonly acl: 'private';
    readonly signedUrlTtlSeconds: number;
    readonly tip: string;
  };
}

/** 单个对象的签名结果 */
export interface SignedUrlItem {
  readonly objectKey: string;
  /** 对象不存在时为 null（**不报错**，批量场景更友好，契约 §3.10.2 规则 4） */
  readonly signedUrl: string | null;
  readonly expiresAt: string;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
  /** 本次签名使用的图片处理参数（未指定为 null） */
  readonly process: string | null;
  readonly exists: boolean;
}

/** 批量签名结果（契约 §3.10.2 成功响应） */
export interface SignedUrlsView {
  readonly items: readonly SignedUrlItem[];
  readonly total: number;
  readonly expiresInSeconds: number;
  readonly generatedAt: string;
}

/** 业务登记结果（供 user / report 等模块使用） */
export interface RegisteredObject {
  readonly objectKey: string;
  /** 以 OSS HEAD 结果为准的实际字节数 */
  readonly sizeBytes: number;
  /** 由魔数检测出的真实 MIME 类型 */
  readonly mimeType: string;
  readonly etag: string | null;
  /** 对外访问地址（CDN 域名 + 对象键） */
  readonly publicUrl: string;
}

/**
 * OSS 回调响应（契约 §3.10.3）
 *
 * 注意字段名是**大写 `Status`**：该响应体由 OSS 的回调模板约定，
 * **不套用**统一包络 `{code,message,data,...}`。上传客户端读取的正是这个结构，
 * 因此不能为了「一致性」把它改成小写驼峰 —— 那会让客户端解析失败。
 */
export interface StorageCallbackResult {
  readonly Status: 'OK';
  readonly objectKey: string;
  readonly etag: string;
  readonly size: number;
  readonly mimeType: string;
  /** 本次是否**新投递**了内容安全检测任务（重复回调为 false） */
  readonly safetyCheckQueued: boolean;
  readonly recordedAt: string;
}
