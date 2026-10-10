/**
 * 格式化工具
 *
 * 约定：
 *   · 金额在服务端以「分」存储与传输（架构文档 §8.3），前端展示时才转元
 *   · 时间在服务端为 ISO 8601 UTC，展示时按用户本地时区格式化
 */

/** 分 → 元（字符串，保留两位小数，避免浮点误差导致的 0.30000000000000004） */
export const centsToYuan = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return '0.00';
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const yuan = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}${yuan}.${String(remainder).padStart(2, '0')}`;
};

/** 分 → 元（带货币符号，用于价格展示） */
export const formatPrice = (cents: number | null | undefined): string => `¥${centsToYuan(cents)}`;

/** 分 → 元（数字，仅用于图表等需要数值参与计算的场景） */
export const centsToYuanNumber = (cents: number | null | undefined): number => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 0;
  return Math.round(cents) / 100;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 解析时间：兼容 Date / ISO 字符串 / 时间戳 */
const parseDate = (input: string | number | Date | null | undefined): Date | null => {
  if (input === null || input === undefined) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** 格式化为 YYYY-MM-DD */
export const formatDate = (input: string | number | Date | null | undefined): string => {
  const date = parseDate(input);
  if (!date) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

/** 格式化为 YYYY-MM-DD HH:mm */
export const formatDateTime = (input: string | number | Date | null | undefined): string => {
  const date = parseDate(input);
  if (!date) return '';
  return `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/**
 * 相对时间（用于报告/对话列表）
 * 规则：< 1 分钟「刚刚」；< 1 小时「N 分钟前」；< 24 小时「N 小时前」；
 *       < 30 天「N 天前」；更早则显示日期
 */
export const formatRelativeTime = (
  input: string | number | Date | null | undefined,
  now: number = Date.now(),
): string => {
  const date = parseDate(input);
  if (!date) return '';

  const diff = now - date.getTime();

  // 未来时间（服务端时钟偏差）不显示「-N 分钟前」
  if (diff < 0) return formatDate(date);

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(date);
};

/** 秒 → 分:秒（测试用时展示） */
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${pad2(minutes)}:${pad2(remain)}`;
};

/** 手机号脱敏：138****8888 */
export const maskPhone = (phone: string | null | undefined): string => {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 11) return phone;
  return `${digits.slice(0, 3)}****${digits.slice(7)}`;
};

/**
 * 通用脱敏：保留首尾若干字符，中间全部用 * 替代（openid、订单号、交易号等）
 *
 * 设计选择：中间字符全部打码而不是固定 6 个星号 —— 固定长度会泄露原串长度信息，
 * 且不同长度的输入会产生不一致的观感。全部打码的规则更简单、可预测。
 */
export const maskMiddle = (value: string | null | undefined, head = 4, tail = 4): string => {
  if (!value) return '';
  if (value.length <= head + tail) return '*'.repeat(value.length);
  return `${value.slice(0, head)}${'*'.repeat(value.length - head - tail)}${value.slice(-tail)}`;
};

/** 百分比展示（Big Five 分数、匹配度） */
export const formatPercent = (value: number | null | undefined, fractionDigits = 0): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(fractionDigits)}%`;
};

/** 文件大小展示 */
export const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value : value.toFixed(1)} ${units[unitIndex]}`;
};
