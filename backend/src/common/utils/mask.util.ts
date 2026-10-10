/**
 * 脱敏工具（服务端）
 *
 * 用途：把敏感字段转换为「可用于展示但不可还原」的形式（架构 §14.2 数据安全）。
 *
 * 与前端 `utils/format.ts` 中的同名函数的区别：
 *   · 前端那份用于**用户自己输入**的内容展示（如用户回看自己填的手机号）
 *   · 本文件用于**服务端对外输出**，是防止明文泄露的最后一道闸门，因此更保守
 */

/**
 * 手机号归一化：仅保留数字，并剥离中国区号前缀（`86` / `0086`）
 *
 * 抽成独立函数的理由：**脱敏展示与 `phoneHash` 必须基于同一套归一化规则**。
 * 若两处各写一份，`+86 13800006721` 可能在展示侧被识别为 11 位、
 * 在哈希侧被识别为 13 位，导致「同一号码产生两个哈希」——
 * 唯一约束失效、跨账号查重漏判，且极难排查。
 *
 * 返回 `null` 表示**没有输入**；返回空字符串表示「有输入但不含数字」，
 * 两者语义不同，调用方需分别处理。
 */
export const normalizePhoneDigits = (phone: string | null | undefined): string | null => {
  if (!phone) return null;

  let digits = phone.replace(/\D/g, '');

  if (digits.length === 13 && digits.startsWith('86')) {
    digits = digits.slice(2);
  } else if (digits.length === 15 && digits.startsWith('0086')) {
    digits = digits.slice(4);
  }

  return digits;
};

/**
 * 手机号脱敏：138****6721
 *
 * 归一化处理：先去除非数字字符，再剥离中国区号前缀（`86` / `0086`）——
 * 否则 `+86 138 1234 5678` 会被识别为「13 位非标准号码」而走了更宽松的分支，
 * 虽仍不会泄露明文，但展示效果差且不符合「保留前 3 后 4」的预期。
 *
 * 非 11 位数字的输入（国际号码、异常数据）统一退化为「保留首尾各 2 位」，
 * 避免出现「无法识别却原样返回」导致明文泄露。
 */
export const maskPhone = (phone: string | null | undefined): string | null => {
  const digits = normalizePhoneDigits(phone);
  if (digits === null) return null;

  if (digits.length === 11) {
    return `${digits.slice(0, 3)}****${digits.slice(7)}`;
  }

  if (digits.length <= 4) {
    return '*'.repeat(digits.length);
  }

  return `${digits.slice(0, 2)}${'*'.repeat(Math.min(6, digits.length - 4))}${digits.slice(-2)}`;
};

/**
 * 通用脱敏：保留首尾固定长度，中间全部打码
 *
 * 用于 openid、订单号、交易号等标识在日志与客服界面中的展示。
 */
export const maskMiddle = (value: string | null | undefined, head = 4, tail = 4): string | null => {
  if (!value) return null;
  if (value.length <= head + tail) return '*'.repeat(value.length);
  return `${value.slice(0, head)}${'*'.repeat(value.length - head - tail)}${value.slice(-tail)}`;
};

/**
 * 生日 → 年龄段（隐私最小化，架构 §1.2）
 *
 * 设计选择：**不返回精确年龄**，只返回 5 岁一档的区间（如 `25-29`）。
 * 精确年龄在与人格数据结合后可增强再识别能力，属于不必要的隐私暴露。
 *
 * @param birthday 生日（Date 或 ISO 日期字符串）
 * @param now      当前时间（便于测试注入）
 * @returns 区间字符串；无生日或数据异常返回 null
 */
export const toAgeRange = (birthday: Date | string | null | undefined, now: Date = new Date()): string | null => {
  if (!birthday) return null;

  const date = birthday instanceof Date ? birthday : new Date(birthday);
  if (Number.isNaN(date.getTime())) return null;

  // 未满 5 岁不展示区间（本产品面向成年用户，出现该情况说明数据异常）
  const age = calculateAge(date, now);
  if (age === null || age < 0 || age > 120) return null;

  const lower = Math.floor(age / 5) * 5;
  return `${lower}-${lower + 4}`;
};

/**
 * 计算周岁年龄
 *
 * 必须按「生日是否已过」判断，不能用简单的毫秒差除以 365 天
 * （闰年会导致跨年边界少算一岁）。
 */
export const calculateAge = (birthday: Date, now: Date = new Date()): number | null => {
  if (Number.isNaN(birthday.getTime())) return null;

  let age = now.getUTCFullYear() - birthday.getUTCFullYear();

  const monthDiff = now.getUTCMonth() - birthday.getUTCMonth();
  const dayDiff = now.getUTCDate() - birthday.getUTCDate();

  // 今年生日还没到（或正好今天但时间未到），年龄减 1
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }

  return age;
};
