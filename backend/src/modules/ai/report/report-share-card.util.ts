/**
 * 分享卡片（契约 §3.5.9）的纯逻辑
 *
 * 安全相关的两件事都在这里可测：
 *   ① `quoteSectionKey` 只允许指向**免费预览段**（`60020` 语义），且必须在
 *      `buildSectionViews` 的可见性判定下"确实可读"；
 *   ② 缓存指纹覆盖所有影响画面的参数 —— 否则"关了小程序码再生成"会拿回带码的旧图。
 */

import { MBTI_TYPE_PROFILES } from '../../personality/data/mbti-types';

/** 卡片样式（契约 §3.5.9 请求体枚举） */
export const SHARE_CARD_TEMPLATES = ['TYPE_CARD', 'RADAR_CARD', 'QUOTE_CARD'] as const;

export type ShareCardTemplate = (typeof SHARE_CARD_TEMPLATES)[number];

/** 分享场景（契约 §3.5.9 请求体枚举） */
export const SHARE_CARD_SCENES = ['REPORT', 'TEST_RESULT', 'RELATIONSHIP'] as const;

export type ShareCardScene = (typeof SHARE_CARD_SCENES)[number];

/** 每小时的分享卡生成上限（契约 §3.5.9 限流：userId + reportId 10 次/60min） */
export const SHARE_CARD_HOURLY_LIMIT = 10;

/** 配额窗口：滚动 60 分钟（与"每日配额"不同，这里按契约原文的 60min 固定窗口） */
export const SHARE_CARD_QUOTA_WINDOW = { kind: 'seconds', seconds: 3600 } as const;

/** 卡片缓存 TTL（契约规则 2：30 天） */
export const SHARE_CARD_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 卡片有效天数（契约规则 2：缓存 TTL 30 天） */
export const SHARE_CARD_VALID_DAYS = 30;

/** 幂等记录保留时长（秒） */
export const SHARE_CARD_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** 分享卡图片 MIME（契约规则 3：全部导出 WebP） */
export const SHARE_CARD_CONTENT_TYPE = 'image/webp';

/** 对象键前缀（必须与 `storage-policy.ts` 的 `SHARE_CARD` 场景前缀一致，否则归属校验会失败） */
const SHARE_CARD_OBJECT_PREFIX = 'share-card';

/**
 * 卡片对象键
 *
 * 契约示例给的是 `share/report/{reportId}-radar.png`（CDN 路径），但本项目
 * `storage-policy.ts` 为 `SHARE_CARD` 场景声明的对象键前缀是 `share-card/`，
 * 且 `storage.util.assertObjectKeyOwnedBy` 按该前缀做归属校验。
 * **以场景策略为准**（对象键必须落在声明前缀下），CDN 域名本身由 `OSS_CDN_DOMAIN` 决定，
 * 因此对外 URL 的路径段与契约示例不同，已在交付报告中标注。
 */
export const buildShareCardObjectKey = (
  userId: string,
  reportId: string,
  template: ShareCardTemplate,
  unique: string,
): string => `${SHARE_CARD_OBJECT_PREFIX}/${userId}/${reportId}-${template.toLowerCase()}-${unique}.webp`;

/** 缩略图 URL（契约示例用 `x-oss-process` 裁剪；OSS 侧实时处理，不额外占存储） */
export const buildThumbUrl = (publicUrl: string): string =>
  `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}x-oss-process=image/resize,w_240/format,webp`;

/**
 * 小程序码 scene（契约规则 7：`report_{reportId 前 8 位}`）
 *
 * 去掉连字符再截断：与契约示例（`report_0195f3a2`）逐字一致。
 * 微信 `wxacode.getUnlimited` 的 scene 上限 32 字符，8 位长度留足了余量。
 */
export const buildQrCodeScene = (reportId: string): string => `report_${reportId.replace(/-/g, '').slice(0, 8)}`;

/** 卡片缓存指纹：所有影响画面的参数都要在内 */
export const shareCardFingerprint = (input: {
  reportId: string;
  template: ShareCardTemplate;
  quoteSectionKey: string | null;
  showQrCode: boolean;
  showNickname: boolean;
  scene: ShareCardScene;
}): string =>
  [
    input.reportId,
    input.template,
    input.quoteSectionKey ?? '-',
    input.showQrCode ? 'qr' : 'noqr',
    input.showNickname ? 'name' : 'anon',
    input.scene,
  ].join('|');

/**
 * 昵称脱敏（契约：`showNickname = false` 时降级为「一位 INFJ」）
 *
 * 没有 MBTI 时用「一位朋友」而不是空串：分享图上出现空白署名会让用户以为渲染出错。
 */
export const maskDisplayName = (nickname: string | null, mbtiType: string | null): string => {
  if (nickname !== null && nickname.trim().length > 0) return nickname.trim();

  return mbtiType !== null && mbtiType.length > 0 ? `一位 ${mbtiType}` : '一位朋友';
};

/** 分享文案模板（`system_configs.share.templates` 的结构） */
export type ShareTemplates = Readonly<Record<string, { readonly title?: string; readonly text?: string }>>;

/** 模板变量 */
export interface ShareTemplateVariables {
  readonly mbtiType?: string;
  readonly typeName?: string;
  readonly tagline?: string;
  readonly nickname?: string;
}

/** 占位符：`{{key}}`，允许中间有空格（后台手写模板时很常见） */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * 模板插值
 *
 * 未提供的变量替换为空串，并做一次**标点清理**（`（）`、`——。`）：
 * 模板 `我的 MBTI 是 {{mbtiType}}（{{typeName}}）——{{tagline}}。` 在缺少 typeName 时
 * 会留下"（），"这类残渣，而那正是用户会截图的部分。
 *
 * 不做 HTML 转义：这些文案进入的是分享卡片与小程序 `shareTitle`，不是 HTML 上下文，
 * 转义反而会把中文标点变成实体。
 */
export const interpolateShareTemplate = (template: string, variables: ShareTemplateVariables): string => {
  const replaced = template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    const value = (variables as Record<string, string | undefined>)[key];

    return typeof value === 'string' ? value : '';
  });

  return replaced
    .replace(/（\s*）/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/——\s*。/g, '。')
    .trim();
};

/**
 * 取分享文案（契约规则 4：来自 `system_config.shareTemplates`，**不硬编码**）
 *
 * 场景没有对应模板时回落到 `DEFAULT`：`RELATIONSHIP` 场景在配置目录里就没有模板，
 * 回落到默认文案比返回空标题（小程序分享面板会显示成小程序名）更接近预期。
 */
export const resolveShareTemplate = (
  templates: ShareTemplates,
  scene: ShareCardScene,
  variables: ShareTemplateVariables,
): { title: string; text: string } => {
  const template = templates[scene] ?? templates['DEFAULT'] ?? {};

  return {
    title: interpolateShareTemplate(template.title ?? '我的人格深度报告', variables),
    text: interpolateShareTemplate(template.text ?? '我的人格报告出来了，来测测你的？', variables),
  };
};

/**
 * MBTI 类型 → 分享文案变量
 *
 * 从 `MBTI_TYPE_PROFILES` 取中文名与标语（与报告生成用的是同一份数据），
 * 保证"报告里写的标语"和"分享文案里的标语"不会不一致。
 */
export const shareVariablesOf = (mbtiType: string | null, nickname: string | null): ShareTemplateVariables => {
  const profile = mbtiType === null ? undefined : MBTI_TYPE_PROFILES.find((item) => item.type === mbtiType);

  return {
    ...(mbtiType !== null ? { mbtiType } : {}),
    ...(profile !== undefined ? { typeName: profile.typeName, tagline: profile.tagline } : {}),
    ...(nickname !== null ? { nickname } : {}),
  };
};

/** 分享卡状态（Redis JSON；不含签名 URL，公开图直接存 CDN 地址） */
export interface ShareCardState {
  readonly shareCardId: string;
  readonly reportId: string;
  readonly userId: string;
  readonly template: ShareCardTemplate;
  readonly fingerprint: string;
  readonly scene: ShareCardScene;
  readonly showQrCode: boolean;
  readonly showNickname: boolean;
  readonly quoteSectionKey: string | null;
  readonly objectKey: string;
  readonly imageUrl: string;
  readonly thumbUrl: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly qrCodeScene: string;
  readonly shareText: string;
  readonly shareTitle: string;
  readonly renderDurationMs: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** 小程序码生成失败时的告警（契约规则 6 的降级标记） */
  readonly warnings: readonly string[];
}
