/**
 * 导出包构建（纯函数，无 I/O、可 100% 单测）
 *
 * 契约来源：docs/API_DESIGN.md §3.2.6（数据导出）
 *
 * 为什么把组装逻辑从 Worker 里抽出来：导出包是**用户会转发出去的文件**
 * （给客服、给律师、留档），因此「哪些字段能进包」是合规问题而不是实现细节。
 * 抽成纯函数后，每条脱敏规则都能被直接断言，而不是靠跑一次队列看日志。
 *
 * 硬性规则（契约 §3.2.6 规则 4）：
 *   · 🚫 不含 `openid` 原文、`session_key`、`phoneEnc`、`phoneHash`
 *   · 手机号只出脱敏值
 *   · 导出包本身不得成为泄露源
 */

import { maskPhone } from '../../common/utils/mask.util';

/** 导出包结构版本（下游据此判断兼容性） */
export const EXPORT_SCHEMA_VERSION = '1.0';

/** 导出 JSON 的 MIME 类型 */
export const EXPORT_JSON_MIME = 'application/json';

/**
 * 单个集合的导出条数上限
 *
 * 不设限的话，一个重度用户（数百次测评 + 数千条 AI 对话）会产出几百 MB 的包，
 * 既拖垮 Worker 内存，也让用户下不动。超出部分在包内以 `truncated` 标注，
 * 而不是静默截断 —— 用户有权知道导出是否完整。
 */
export const EXPORT_COLLECTION_LIMIT = 500;

/** 导出对象键前缀（服务端生成，不进入场景策略表：客户端无权申请导出票据） */
const EXPORT_KEY_PREFIX = 'export';

/** 导出范围 */
export type ExportScope = 'ALL' | 'PROFILE' | 'REPORTS' | 'CONVERSATIONS';

/** 组装导出对象键：`export/{userId}/{taskId}.json` */
export const buildExportObjectKey = (userId: string, taskId: string, extension: string): string =>
  `${EXPORT_KEY_PREFIX}/${userId}/${taskId}.${extension}`;

/** 组装下载文件名（日期用 UTC，与对象键日期段保持一致的口径） */
export const buildExportFileName = (taskId: string, extension: string, date: Date): string => {
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');

  return `soulmap-export-${taskId.slice(0, 8)}-${stamp}.${extension}`;
};

/** 判断某集合是否属于当前的导出范围 */
export const scopeIncludes = (scope: ExportScope, section: 'PROFILE' | 'REPORTS' | 'CONVERSATIONS'): boolean => {
  if (scope === 'ALL') return true;
  return scope === section;
};

/** 导出包中的用户资料段（已脱敏） */
export interface ExportUserSection {
  id: string;
  nickname: string | null;
  gender: string;
  /** 出生日期：导出是给**本人**的数据副本，完整性优先（与「他人可见」脱敏口径不同） */
  birthday: string | null;
  ageVerified: boolean;
  /** 只出脱敏手机号；未绑定为 null */
  phoneMasked: string | null;
  status: string;
  registerChannel: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** 导出包中的微信账号段（**不含** openid 原文与 session_key） */
export interface ExportWechatSection {
  platform: string;
  /** openid 掩码（前 4 后 4）：既能让用户核对自己的账号，又不构成可用凭证 */
  openidMasked: string;
  unionidMasked: string | null;
  boundAt: string;
}

/** 导出包中的同意记录段 */
export interface ExportConsentEntry {
  type: string;
  policyVersion: string;
  agreed: boolean;
  agreedAt: string | null;
  revokedAt: string | null;
}

/** 导出包结构 */
export interface ExportPayload {
  schemaVersion: string;
  exportedAt: string;
  scope: ExportScope;
  notice: string;
  /** 各集合是否因超出上限而被截断 */
  truncated: string[];
  profile?: {
    user: ExportUserSection;
    wechat: ExportWechatSection | null;
    consents: ExportConsentEntry[];
  };
  reports?: {
    testSessions: Array<Record<string, unknown>>;
    personalityProfiles: Array<Record<string, unknown>>;
    aiReports: Array<Record<string, unknown>>;
  };
  conversations?: {
    aiConversations: Array<Record<string, unknown>>;
  };
}

/** 导出包顶部说明（随包下发，用户转发后接收方也能看懂这是什么） */
const EXPORT_NOTICE =
  '本文件由 SoulMap AI 导出，包含你在平台上的个人数据副本。手机号已脱敏，' +
  '不包含微信 openid 原文、登录凭证或加密密钥。';

/** openid 掩码：保留前 4 后 4 */
const maskOpenId = (value: string | null): string | null => {
  if (value === null || value.length === 0) return null;
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
};

/** 构建用户资料段 */
export const buildExportUser = (user: {
  id: string;
  nickname: string | null;
  gender: string;
  birthday: Date | null;
  ageVerified: boolean;
  /** 已解密的手机号明文（由调用方解密后传入，本函数立即脱敏，不保留明文） */
  phonePlain: string | null;
  status: string;
  registerChannel: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}): ExportUserSection => ({
  id: user.id,
  nickname: user.nickname,
  gender: user.gender,
  birthday: user.birthday === null ? null : user.birthday.toISOString().slice(0, 10),
  ageVerified: user.ageVerified,
  phoneMasked: maskPhone(user.phonePlain),
  status: user.status,
  registerChannel: user.registerChannel,
  createdAt: user.createdAt.toISOString(),
  lastLoginAt: user.lastLoginAt === null ? null : user.lastLoginAt.toISOString(),
});

/** 构建微信账号段（openid / unionid 一律掩码） */
export const buildExportWechat = (
  account: { platform: string; openid: string; unionid: string | null; createdAt: Date } | null,
): ExportWechatSection | null => {
  if (account === null) return null;

  return {
    platform: account.platform,
    openidMasked: maskOpenId(account.openid) ?? '',
    unionidMasked: maskOpenId(account.unionid),
    boundAt: account.createdAt.toISOString(),
  };
};

/** 组装导出载荷 */
export const buildExportPayload = (input: {
  scope: ExportScope;
  exportedAt: Date;
  user: ExportUserSection;
  wechat: ExportWechatSection | null;
  consents: ExportConsentEntry[];
  testSessions: Array<Record<string, unknown>>;
  personalityProfiles: Array<Record<string, unknown>>;
  aiReports: Array<Record<string, unknown>>;
  aiConversations: Array<Record<string, unknown>>;
  truncated: string[];
}): ExportPayload => {
  const payload: ExportPayload = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: input.exportedAt.toISOString(),
    scope: input.scope,
    notice: EXPORT_NOTICE,
    truncated: input.truncated,
  };

  if (scopeIncludes(input.scope, 'PROFILE')) {
    payload.profile = {
      user: input.user,
      wechat: input.wechat,
      consents: input.consents,
    };
  }

  if (scopeIncludes(input.scope, 'REPORTS')) {
    payload.reports = {
      testSessions: input.testSessions,
      personalityProfiles: input.personalityProfiles,
      aiReports: input.aiReports,
    };
  }

  if (scopeIncludes(input.scope, 'CONVERSATIONS')) {
    payload.conversations = { aiConversations: input.aiConversations };
  }

  return payload;
};

/**
 * 序列化导出包（统一 2 空格缩进）
 *
 * 用缩进而非紧凑格式：这是给**人看**的文件，可读性优先于体积；
 * 且导出包体积上限由集合条数控制，不靠压掉空白。
 */
export const serializeExportPayload = (payload: ExportPayload): string => JSON.stringify(payload, null, 2);
