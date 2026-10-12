/**
 * 管理员管理接口的公共工具与统计口径常量
 *
 * 为什么单独抽一个文件：密码强度、一次性密码生成、CSV 参数解析、审计口径分类这几条规则
 * 要在「列表 / 创建 / 重置密码」三个接口之间**完全一致** ——
 * 若强度校验在 DTO 与服务层各写一份、统计口径在服务里重复硬编码，
 * 二者迟早漂移，表现为「接口放过但服务拒绝」或「同一份数据两处口径不同」。
 */

import { randomInt } from 'node:crypto';

// ============================================================================
// 密码
// ============================================================================

/** 一次性密码有效期（小时）。契约 §3.14.9.5 / §3.14.9.6 的 `expiresInHours` 恒为该值。 */
export const ONE_TIME_PASSWORD_EXPIRES_HOURS = 24;

/** 新建管理员时的密码提示语（与契约示例一致，前端直接展示） */
export const INITIAL_PASSWORD_NOTE = '⚠️ 该密码仅在此响应中返回一次，请立即通过安全渠道交付本人；首次登录后必须修改。';

/** 重置密码时的提示语（与契约示例一致） */
export const RESET_PASSWORD_NOTE = '⚠️ 该密码仅在此响应中返回一次，请通过安全渠道交付本人。';

/**
 * 初始密码强度：12–64 位，且同时包含大写字母、小写字母、数字与符号。
 *
 * 比「本人改密」的强度要求更严（契约 §3.14.9.5 明确要求四类字符）：
 * 初始密码由管理员转交给他人，中间会经过聊天工具/口头传达等不可控信道，
 * 强度不足时被猜测的成本极低。
 */
export const ADMIN_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,64}$/;

export const isStrongAdminPassword = (password: string): boolean => ADMIN_PASSWORD_PATTERN.test(password);

/** 服务端生成的一次性密码长度（16 位，超出 12 位下限 4 位以留出熵余量） */
const GENERATED_PASSWORD_LENGTH = 16;

/**
 * 生成字符集**刻意排除易混淆字符**（`0`/`O`、`1`/`l`/`I`）
 *
 * 一次性密码要靠人工誊抄并通过电话/IM 传达，混淆字符会直接把用户引向
 * 「密码错误」，而管理端连续 5 次失败即锁定 15 分钟（架构 §14.3）——
 * 一个誊抄歧义就会把新账号锁掉，代价远大于字符集缩小带来的熵损失。
 */
const UPPERCASE_POOL = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE_POOL = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT_POOL = '23456789';
const SYMBOL_POOL = '!@#$%^&*()-_=+';

/**
 * 生成一次性强密码
 *
 * 先各取 1 个四类字符（保证满足强度校验），再随机补足长度，最后打乱 ——
 * 不打乱的话前 4 位固定为「大写、小写、数字、符号」，
 * 攻击者可据此把搜索空间缩小若干数量级。
 */
export const generateOneTimePassword = (): string => {
  const pools = [UPPERCASE_POOL, LOWERCASE_POOL, DIGIT_POOL, SYMBOL_POOL];
  const all = pools.join('');
  const chars: string[] = pools.map((pool) => pool[randomInt(pool.length)]);

  while (chars.length < GENERATED_PASSWORD_LENGTH) {
    chars.push(all[randomInt(all.length)]);
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const swap = chars[i];
    chars[i] = chars[j];
    chars[j] = swap;
  }

  return chars.join('');
};

// ============================================================================
// 参数解析
// ============================================================================

/** 管理员状态枚举值（与 `prisma/schema.prisma` 的 `AdminUserStatus` 逐字一致） */
export const ADMIN_USER_STATUSES = ['ACTIVE', 'DISABLED', 'LOCKED'] as const;

export type AdminUserStatusValue = (typeof ADMIN_USER_STATUSES)[number];

/** 仅用于类型收敛的判定函数（`filter` 需要类型守卫才能得到窄类型） */
export const isAdminUserStatus = (value: string): value is AdminUserStatusValue =>
  (ADMIN_USER_STATUSES as readonly string[]).includes(value);

/**
 * 解析逗号分隔的多值参数（`status=ACTIVE,LOCKED`）
 *
 * 空段直接丢弃而不是报错：`?status=ACTIVE,` 这类多一个逗号的请求是前端拼接的常见产物，
 * 为此返回 400 属于「把噪音当错误」。
 */
export const parseCsvValues = (raw?: string): string[] => {
  if (!raw) return [];

  const values = new Set<string>();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value.length > 0) values.add(value);
  }

  return [...values];
};

/** UUID 形态校验（`uuid(7)` 与任何 RFC 4122 版本同形） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 路径参数是否为合法 UUID
 *
 * 必须在查库**之前**校验：Prisma 会把非法 UUID 字面量拼进 SQL，
 * PostgreSQL 直接抛 `invalid input syntax for type uuid`，
 * 表现为 500（数据库异常）而不是「参数不合法」。
 */
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

/**
 * IP / CIDR 形态校验（创建接口的 `ipWhitelist`）
 *
 * IPv4 严格校验（含 0–32 前缀长度）；IPv6 采用宽松形态（hex + 冒号 + 前缀长度）：
 * 白名单目前只是「记录意图」的配置项（见 Service 内的说明），
 * 为此写一个完备的 IPv6 解析器不划算，但基本形态仍要挡住明显的手误（如误填域名）。
 */
const IPV4_SEGMENT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_CIDR = `(?:${IPV4_SEGMENT}\\.){3}${IPV4_SEGMENT}(?:/(?:3[0-2]|[12]?\\d))?`;
const IPV6_CIDR = '[0-9A-Fa-f:]{2,45}(?:/(?:12[0-8]|1[01]\\d|[1-9]?\\d))?';

export const IP_OR_CIDR_PATTERN = new RegExp(`^(?:${IPV4_CIDR}|${IPV6_CIDR})$`);

// ============================================================================
// 审计统计口径
// ============================================================================

/**
 * 「写类」审计动作（契约给定的统计口径，逐项列出）
 *
 * ⚠ `EXPORT` **刻意不在**本集合内 —— 这是契约给定的口径，本实现保持与之一致：
 * `EXPORT` 只参与 CRITICAL 判定（`ORDER/EXPORT`），不计入 `writeActions`。
 * 代价是导出类操作会落进 `readActions` 的差额（`total − write − login`），
 * 属已登记的口径缺口（见 `readActions` 的注释）。
 */
export const WRITE_AUDIT_ACTIONS: readonly string[] = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'PUBLISH',
  'UNPUBLISH',
  'ROLLBACK',
  'GRANT',
  'REVOKE',
  'REFUND',
  'MANUAL_FULFILL',
  'IMPORT',
  'CONFIG_CHANGE',
];

/**
 * 登录类动作：既不是「读」也不是「写」
 *
 * 必须单独扣除，否则 `readActions` 会把登录/登出次数算成读操作 ——
 * 一个每天登录 50 次的管理员会被误判为「高频读取数据」。
 */
export const LOGIN_AUDIT_ACTIONS: readonly string[] = ['LOGIN', 'LOGOUT', 'LOGIN_FAILED'];

/**
 * CRITICAL 级 `(resourceType, action)` 组合（契约 §3.14「核心契约」的风险分级）
 *
 * ⚠ 已登记的口径缺口：本仓库认证/改密链路写审计时用的 `resourceType` 是 `admin_user`
 *   （见 `admin-auth.service.ts`），而本表按契约使用大写 `ADMIN`。
 *   因此「管理员自助改密」不会计入 `criticalActions`；契约未给出别名规则，
 *   这里不擅自扩大集合（统计口径只应比契约更窄，不应更宽）。
 */
export const CRITICAL_AUDIT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['CONFIG', 'CONFIG_CHANGE'],
  ['ROLE', 'UPDATE'],
  ['ADMIN', 'CREATE'],
  ['ADMIN', 'UPDATE'],
  ['ORDER', 'REFUND'],
  ['ORDER', 'EXPORT'],
];

export const isWriteAuditAction = (action: string): boolean => WRITE_AUDIT_ACTIONS.includes(action);

export const isLoginAuditAction = (action: string): boolean => LOGIN_AUDIT_ACTIONS.includes(action);

export const isCriticalAuditPair = (resourceType: string, action: string): boolean =>
  CRITICAL_AUDIT_PAIRS.some(([type, act]) => type === resourceType && act === action);

/** 单个管理员的近 7 天操作统计（契约 §3.14.9.4 的 `operationStats7d`） */
export interface AdminOperationStats {
  totalActions: number;
  criticalActions: number;
  readActions: number;
  writeActions: number;
}

/** 统计缺失时的全 0 兜底（**不编造数字**，也不让列表接口因统计失败而 500） */
export const emptyOperationStats = (): AdminOperationStats => ({
  totalActions: 0,
  criticalActions: 0,
  readActions: 0,
  writeActions: 0,
});

/**
 * Prisma 唯一约束冲突判定（错误码 `P2002`）
 *
 * 用鸭子类型而不是 `instanceof Prisma.PrismaClientKnownRequestError`：
 * 后者会把它变成对生成客户端类标识的硬依赖，而这里只需要一个稳定的错误码字段。
 */
export const isUniqueConstraintViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
