/**
 * 系统配置的纯函数工具
 *
 * 单独成文件的原因：这些逻辑（值类型解析、区间校验、内容哈希、版本号格式）是
 * 「后台写」与「前台读」共用的口径 —— 两边各写一份迟早会出现「后台能写进去、
 * 前台读出来是另一个值」这类最难排查的不一致，因此集中在这里并被双向复用。
 */

import { ConfigValueType } from '@prisma/client';
import { createHash } from 'node:crypto';

import type { ConfigDefinition } from './system-config.catalog';

/** 值校验结果（契约 §3.14.9.2 响应里的 `validation` 字段） */
export interface ConfigValueValidation {
  isValid: boolean;
  errors: string[];
}

/** 校验通过的统一结果，避免调用方到处判空 */
export const VALID: ConfigValueValidation = { isValid: true, errors: [] };

/**
 * 按 valueType 把数据库里的字符串解析成对外 JSON 值
 *
 * 解析失败时**不抛错**而是回退原始字符串：配置表里出现脏数据（例如 JSON 键被人工改坏）
 * 时，正确行为是「尽量下发」而不是让整个首屏接口 500 —— 客户端展示略旧/略脏的文案，
 * 比首页白屏可接受得多。
 */
export const parseConfigValue = (rawValue: string, valueType: ConfigValueType): unknown => {
  switch (valueType) {
    case ConfigValueType.BOOLEAN:
      return rawValue === 'true' || rawValue === '1';
    case ConfigValueType.NUMBER: {
      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : rawValue;
    }
    case ConfigValueType.JSON:
      try {
        return JSON.parse(rawValue) as unknown;
      } catch {
        return rawValue;
      }
    case ConfigValueType.STRING:
    default:
      return rawValue;
  }
};

/**
 * 校验并归一化待写入的值
 *
 * 返回归一化后的字符串（写库格式）或字段级错误。归一化是必要的：
 * `true` 与 `"true"`、`0.2` 与 `"0.2"` 在库里必须是同一种形态，否则内容哈希
 *（configVersion）会因为「语义相同但字符串不同」而抖动，前端缓存判断随之失效。
 */
export const normalizeConfigValue = (
  definition: ConfigDefinition,
  value: unknown,
): { rawValue: string } | { errors: string[] } => {
  const errors: string[] = [];

  switch (definition.valueType) {
    case ConfigValueType.BOOLEAN: {
      if (typeof value !== 'boolean') {
        errors.push(`${definition.key} 需要布尔值`);
        break;
      }
      return { rawValue: value ? 'true' : 'false' };
    }

    case ConfigValueType.NUMBER: {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${definition.key} 需要数字`);
        break;
      }
      if (definition.min !== undefined && value < definition.min) {
        errors.push(`${definition.key} 不能小于 ${definition.min}`);
      }
      if (definition.max !== undefined && value > definition.max) {
        errors.push(`${definition.key} 不能大于 ${definition.max}`);
      }
      if (errors.length > 0) break;
      return { rawValue: String(value) };
    }

    case ConfigValueType.JSON: {
      // 契约要求 `value` 与该键的 valueType 相符；JSON 类型的键允许传对象/数组
      if (value === null || typeof value !== 'object') {
        errors.push(`${definition.key} 需要 JSON 对象或数组`);
        break;
      }
      try {
        return { rawValue: JSON.stringify(value) };
      } catch {
        errors.push(`${definition.key} 不是可序列化的 JSON`);
        break;
      }
    }

    case ConfigValueType.STRING:
    default: {
      if (typeof value !== 'string') {
        errors.push(`${definition.key} 需要字符串`);
        break;
      }
      return { rawValue: value };
    }
  }

  return { errors };
};

/**
 * 语义化版本比较（仅比较 `x.y.z` 的数字部分）
 *
 * 契约 §3.12.1 规则 8 只要求「低于 `minClientVersion` 即强更」，
 * 预发布标识（`-beta.1`）在客户端版本里不参与比较，因此刻意忽略。
 */
export const compareSemver = (left: string, right: string): number => {
  const parse = (value: string): number[] =>
    value
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return 0;
};

/** 32 位以内的短哈希（只用于版本比对，不需要更强的抗碰撞强度） */
const shortHash = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 8);

/** `yyyyMMdd`（UTC）—— 契约示例的 `sv-20260214-3` 就是这个形态 */
const utcDateStamp = (now: Date): string => {
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${now.getUTCDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
};

/**
 * 计算配置版本号（契约 §3.12.1 规则 3：内容哈希）
 *
 * 内容相同 → 版本相同，因此前端「比对版本决定是否刷新缓存」是可靠的；
 * 而契约里那种自增序号（`-3` → `-4`）需要额外的计数器存储，
 * 在多实例部署下还要处理并发，收益不抵复杂度。
 */
export const buildConfigVersion = (entries: ReadonlyArray<{ key: string; rawValue: string }>, now: Date): string => {
  const content = [...entries]
    .map((entry) => `${entry.key}=${entry.rawValue}`)
    .sort()
    .join('\n');

  return `sv-${utcDateStamp(now)}-${shortHash(content)}`;
};

/** 文案版本号（契约 §3.12.2 的 `dl-...`，语义与配置版本一致：内容哈希） */
export const buildDisclaimerVersion = (entries: ReadonlyArray<{ key: string; rawValue: string }>, now: Date): string =>
  `dl-${utcDateStamp(now)}-${shortHash(
    [...entries]
      .map((entry) => `${entry.key}=${entry.rawValue}`)
      .sort()
      .join('\n'),
  )}`;

/** 金额（分）→ 展示价（`¥39.00`） */
export const formatPrice = (amountInCents: number, symbol: string): string =>
  `${symbol}${(amountInCents / 100).toFixed(2)}`;
