/**
 * 关系模块纯函数工具（无 I/O、可 100% 单测）
 *
 * 承载两件**必须在数据库之外就确定**的事：
 *   ① `pairKey` 规范化 —— ADR-020 用它做 `UNIQUE` 约束，从数据库层杜绝重复关系
 *   ② 邀请短码 —— 用户要**口述、手输、扫码**，字符集设计直接决定客服工单量
 */

import { randomInt } from 'node:crypto';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';

// ============================================================================
// pairKey
// ============================================================================

/** pairKey 分隔符 */
const PAIR_KEY_SEPARATOR = ':';

/**
 * 生成 `pairKey`（架构 §12.1：`[min(userIdA, userIdB), max(...)].join(':')`）
 *
 * **排序是全部意义所在**：`A:B` 与 `B:A` 必须得到同一个键，否则同一对用户
 * 能建出两条关系，而 `UNIQUE(pairKey)` 这个防重机制就完全失效了。
 * 用字典序而非"谁先发起"排序，是因为发起方不固定（有时 A 邀请 B，有时反过来）。
 *
 * @throws PARAM_INVALID 当两个 id 相同时（自己不能与自己建立关系）
 */
export const buildPairKey = (userIdA: string, userIdB: string): string => {
  if (typeof userIdA !== 'string' || userIdA.length === 0) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '用户标识不合法');
  }
  if (typeof userIdB !== 'string' || userIdB.length === 0) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '用户标识不合法');
  }

  if (userIdA === userIdB) {
    // 自关系在业务上无意义，且会让「我与我匹配」这类荒谬报告成为可能
    throw BusinessException.badRequest(ErrorCode.RELATIONSHIP_INVITE_SELF);
  }

  return [userIdA, userIdB].sort().join(PAIR_KEY_SEPARATOR);
};

/**
 * **`pairKey` 进入终态后不做任何改写**（ADR-030）
 *
 * 契约 §3.6.7 要求「`pairKey` 保留原值作审计」。因此本模块**没有**、也不应有
 * 「解绑时把键改写成墓碑」的逻辑 —— 那段实现已被 ADR-030 废弃并删除，留此说明
 * 是为了防止有人重新引入：
 *
 *   · 与契约冲突：契约明确要求保留原键供审计回溯（后台关系列表、timeline）
 *   · 曾经的墓碑实现有两个真实缺陷：`min:max#时间戳` 里的 `#` 后缀落在第二个
 *     id 段中，`parsePairKey` 按 `:` 切分仍得两段、解析成功，于是**第一个用户
 *     的访问权没有被收回**（`pairKeyIncludes` 返回 `true`）；且 `36+1+36` 已达
 *     73 字符，加分隔符与时间戳会**超出 `VarChar(80)`**
 *   · 重复关系问题在**数据库层**解决：唯一性由部分唯一索引
 *     `WHERE status IN ('PENDING_A_CONFIRM','ACTIVE')` 承担（迁移
 *     `20260217000000_relationship_pairkey_partial_unique`），终态行不再占用
 *     唯一键，同一对用户即可重新建立关系
 *
 * 已解除的关系不再授予访问权，这一点改由**状态检查**保证（`status` 非 `ACTIVE`
 * 时不返回关系内容），而不再依赖「键恰好不可解析」这种隐式副作用 ——
 * 后者一旦被某次改动破坏，会静默地放行越权访问。
 */

/** 解析 pairKey 回两端用户 id（非法输入返回 null，不抛错） */
export const parsePairKey = (pairKey: string): { userA: string; userB: string } | null => {
  if (typeof pairKey !== 'string') return null;
  const parts = pairKey.split(PAIR_KEY_SEPARATOR);
  if (parts.length !== 2) return null;

  const [userA, userB] = parts;
  if (userA.length === 0 || userB.length === 0) return null;

  return { userA, userB };
};

/** 判断某用户是否属于该 pairKey（用于关系详情页的权限判断） */
export const pairKeyIncludes = (pairKey: string, userId: string): boolean => {
  const parsed = parsePairKey(pairKey);
  if (parsed === null) return false;

  return parsed.userA === userId || parsed.userB === userId;
};

// ============================================================================
// 邀请短码
// ============================================================================

/**
 * Crockford Base32 字符集（32 个字符）
 *
 * 为什么不用标准 Base32（`A-Z2-7`）：邀请码要**被用户念出来、手输、认出来**。
 * Crockford 特意去掉了容易混淆的 `I` `L` `O` `U`，且约定解码时
 * `I`/`L` 视为 `1`、`O` 视为 `0` —— 用户少打一个字母也能进得来。
 *
 * 标准 Base32 虽然也不含数字 0/1，但仍保留 `I`/`O`，
 * 用户看到 `O` 会念成"零"、看到 `I` 会念成"一"，是客服工单的常见来源。
 */
const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 邀请码长度（契约 §3.6.1：8 位） */
export const INVITE_CODE_LENGTH = 8;

/**
 * 生成邀请短码
 *
 * 用 `crypto.randomInt` 而非 `Math.random`：后者是可预测的伪随机，
 * 攻击者能通过若干已发放的码推算后续码，从而**猜中他人的邀请码并抢先接受**。
 * 邀请码本质是 7 天有效的临时凭证，必须用密码学安全的随机源。
 *
 * 32^8 ≈ 1.1×10¹² 种组合；配合 7 天 TTL 与限流，碰撞概率可忽略。
 */
export const generateInviteCode = (): string => {
  let code = '';

  for (let index = 0; index < INVITE_CODE_LENGTH; index += 1) {
    code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }

  return code;
};

/**
 * 归一化用户输入的邀请码
 *
 * 处理三类**真实存在**的输入习惯：
 *   · 小写输入（`k7m2xq9v`）
 *   · 带分隔符（`K7M2-XQ9V`、`K7M2 XQ9V`）
 *   · 混淆字符（把 `O` 写成 `0`、把 `I`/`L` 写成 `1`）
 *
 * 不做归一化的话，这些都会被判为"邀请码无效"，而用户看着屏幕上的码
 * 坚信自己输入正确 —— 这类工单极难自查。
 */
export const normalizeInviteCode = (input: string): string => {
  if (typeof input !== 'string') return '';

  return (
    input
      .toUpperCase()
      // 去掉常见分隔符（用户习惯四位一断）
      .replace(/[\s-]/g, '')
      // Crockford 的容错映射：I/L → 1，O → 0
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0')
  );
};

/** 校验归一化后的邀请码是否合法（长度 + 字符集） */
export const isValidInviteCode = (code: string): boolean => {
  if (typeof code !== 'string' || code.length !== INVITE_CODE_LENGTH) return false;

  const pattern = new RegExp(`^[${INVITE_ALPHABET}]+$`);
  return pattern.test(code);
};

/**
 * 归一化并校验（调用方只需一次调用）
 *
 * @throws PARAM_INVALID 归一化后仍不合法
 */
export const parseInviteCode = (input: string): string => {
  const code = normalizeInviteCode(input);

  if (!isValidInviteCode(code)) {
    throw BusinessException.badRequest(ErrorCode.RELATIONSHIP_INVITE_NOT_FOUND, '邀请码无效，请检查后重试');
  }

  return code;
};
