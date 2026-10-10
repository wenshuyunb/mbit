/**
 * 展示层格式化工具
 *
 * 硬性约定（架构 §8.3 / ADR-009）：
 *   - **金额一律以整数「分」存储与传输**，仅在展示时转换为「元」；禁止在业务逻辑里用浮点运算金额。
 *   - 时间统一以 UTC 存储/传输，展示时按浏览器本地时区格式化。
 *   - 手机号、openid 等个人标识在管理后台默认脱敏展示（架构 §14.2 日志脱敏同源思路）。
 */

import dayjs from 'dayjs';

/** 金额单位换算：1 元 = 100 分 */
export const CENTS_PER_YUAN = 100;

/** 非法/缺失值的统一占位符 */
export const EMPTY_PLACEHOLDER = '--';

/** 货币符号 */
export const CURRENCY_SYMBOL = '¥';

/** 可被格式化的日期输入 */
export type DateInput = string | number | Date | null | undefined;

/**
 * 分 → 元（字符串，固定 2 位小数）
 *
 * 使用整数字符串切分而非浮点除法，避免大额金额出现精度误差（如 1990 分 → 19.90 元）。
 *
 * @param cents 整数分；传入小数分、NaN、null/undefined 时返回占位符 `--`
 * @example formatAmount(0) === '0.00'；formatAmount(1990) === '19.90'；formatAmount(-50) === '-0.50'
 */
export const formatAmount = (cents: number | null | undefined): string => {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || !Number.isInteger(cents)) {
    return EMPTY_PLACEHOLDER;
  }

  const sign = cents < 0 ? '-' : '';
  // padStart(3) 保证至少有「1 位元 + 2 位分」，例如 5 分 → '005' → '0.05'
  const digits = String(Math.abs(cents)).padStart(3, '0');
  const yuan = digits.slice(0, -2);
  const fen = digits.slice(-2);
  return `${sign}${yuan}.${fen}`;
};

/**
 * 分 → 带货币符号的元（如 `¥19.90`）
 * 占位符不加符号，避免出现 `¥--` 这类无意义展示。
 */
export const formatAmountWithSymbol = (cents: number | null | undefined): string => {
  const amount = formatAmount(cents);
  return amount === EMPTY_PLACEHOLDER ? amount : `${CURRENCY_SYMBOL}${amount}`;
};

/**
 * 日期格式化（本地时区）
 * @param input 日期输入，支持 Date / ISO 字符串 / 时间戳
 * @param pattern dayjs 格式串，默认 `YYYY-MM-DD HH:mm:ss`
 * @returns 无效输入（空值、非法字符串、NaN）返回空字符串，由调用方决定占位展示
 */
export const formatDate = (input: DateInput, pattern = 'YYYY-MM-DD HH:mm:ss'): string => {
  if (input === null || input === undefined || input === '') return '';
  const parsed = dayjs(input);
  return parsed.isValid() ? parsed.format(pattern) : '';
};

/** 仅日期（YYYY-MM-DD） */
export const formatDateOnly = (input: DateInput): string => formatDate(input, 'YYYY-MM-DD');

/**
 * 手机号脱敏
 *
 * 规则：
 *   - 标准 11 位手机号（可带 +86 / 86 前缀）：保留前 3 位与后 4 位，例如 `138****5678`
 *   - 非标准格式：仅保留末 4 位，其余以 `*` 覆盖（长度 ≤ 4 时全部覆盖），避免误展示完整号码
 *   - 空值返回空字符串
 */
export const maskPhone = (phone: string | null | undefined): string => {
  if (!phone) return '';

  const value = phone.trim();
  if (value === '') return '';

  const matched = /^(\+?86)?(1\d{10})$/.exec(value);
  if (matched) {
    const prefix = matched[1] ?? '';
    const digits = matched[2] ?? '';
    return `${prefix}${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }

  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
};

/**
 * openid / unionid 脱敏
 *
 * 规则：长度 > 10 时保留前 6 位与后 4 位，例如 `oX9aBc****PqRs`；否则整体覆盖。
 * 说明：openid 是微信用户唯一标识，属于个人标识信息，后台列表默认脱敏（架构 §14.2）。
 */
export const maskOpenid = (openid: string | null | undefined): string => {
  if (!openid) return '';
  const value = openid.trim();
  if (value === '') return '';
  if (value.length <= 10) return '*'.repeat(value.length);
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
};
