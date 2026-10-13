/**
 * `system_configs` 种子数据契约测试
 *
 * ## 这个测试守什么
 *
 * ① **与配置目录不漂移**：`system_configs` 的行会**覆盖**目录里的默认值
 *    （`SystemConfigService.loadFromSources` 的 `row?.value ?? baseline ?? definition.defaultValue`）。
 *    因此种子里写错一个值，线上就真的按错的值跑 —— 而这类错误既没有类型检查也没有运行时报错，
 *    只表现为"用户额度不对/文案不对"。
 * ② **覆盖 AI 助手链路的读取点**：漏一个键不会报错（读取方一律有兜底），
 *    但那个键就永远只能靠代码兜底，运营改不了 —— 这正是本次要修的问题本身。
 * ③ **公开面判据**：`isPublic` 决定键能否出现在面向未登录/普通用户的公开接口里。
 */

import { ConfigValueType } from '@prisma/client';

import { SYSTEM_CONFIGS } from './system-configs';
import { CONFIG_DEFINITION_MAP } from '../../../src/modules/system/system-config.catalog';
import {
  CONFIG_KEY_AI_GENERATED_NOTICE,
  CONFIG_KEY_AI_MESSAGE_MAX_LENGTH,
  CONFIG_KEY_CRISIS_NOTICE,
  CONFIG_KEY_DISCLAIMER_AI_CONTENT,
  CONFIG_KEY_EMERGENCY_NOTICE,
  CONFIG_KEY_FREE_AI_QUOTA,
  CONFIG_KEY_MAX_CONCURRENT_STREAMS,
  CONFIG_KEY_MEMBER_AI_DAILY_LIMIT,
  CONFIG_KEY_SAFETY_RESOURCES,
  CONFIG_KEY_SYSTEM_NOTICE,
} from '../../../src/modules/ai/chat/chat.types';

/**
 * AI 情感助手链路**真实读取**的全部配置键
 *
 * 常量引用而不是字面量：`chat.types.ts` 是这些键名的唯一权威，
 * 那里改名时这里会编译报错，而不是悄悄少校验一个键。
 *
 * `CONFIG_KEY_AI_MESSAGE_MAX_LENGTH` / `CONFIG_KEY_MAX_CONCURRENT_STREAMS` 对应
 * `chat-quota.service.ts` `loadLimits()` 里**写死的字面量**（`'aiMessageMaxLength'` /
 * `'ai.maxConcurrentStreams'`）—— 值相同，用常量表达是为了让两边不至于各写一份。
 */
const CHAT_CONFIG_KEYS: readonly string[] = [
  CONFIG_KEY_SYSTEM_NOTICE,
  CONFIG_KEY_FREE_AI_QUOTA,
  CONFIG_KEY_MEMBER_AI_DAILY_LIMIT,
  CONFIG_KEY_AI_MESSAGE_MAX_LENGTH,
  CONFIG_KEY_MAX_CONCURRENT_STREAMS,
  CONFIG_KEY_DISCLAIMER_AI_CONTENT,
  CONFIG_KEY_AI_GENERATED_NOTICE,
  CONFIG_KEY_CRISIS_NOTICE,
  CONFIG_KEY_EMERGENCY_NOTICE,
  CONFIG_KEY_SAFETY_RESOURCES,
];

const seededKeys = (): string[] => SYSTEM_CONFIGS.map((config) => config.key);

describe('system_configs 种子数据契约', () => {
  it('至少有一个配置项（否则整张表仍是空的，运营改不动任何文案）', () => {
    expect(SYSTEM_CONFIGS.length).toBeGreaterThan(0);
  });

  it('键唯一、非空且为 `域.用途` 或驼峰业务键形式', () => {
    const keys = seededKeys();

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9._]*$/);
    }
  });

  it('【关键】覆盖 AI 助手链路真实读取的每一个键（漏一个就等于该键永远只能靠代码兜底）', () => {
    const seeded = new Set(seededKeys());
    const missing = CHAT_CONFIG_KEYS.filter((key) => !seeded.has(key));

    expect(missing).toEqual([]);
  });

  it('【关键】已在配置目录中的键，其值/类型/分组/公开性与目录逐字一致（库里的行会覆盖目录默认值）', () => {
    const drifted = SYSTEM_CONFIGS.filter((config) => {
      const definition = CONFIG_DEFINITION_MAP.get(config.key);
      if (definition === undefined) return false;

      return (
        config.value !== definition.defaultValue ||
        config.valueType !== definition.valueType ||
        config.group !== definition.group ||
        config.isPublic !== definition.isPublic
      );
    }).map((config) => config.key);

    expect(drifted).toEqual([]);
  });

  it('【关键】公开的配置键必须都在配置目录内（目录是"公开面"的唯一评审入口）', () => {
    // 目录之外的键无法走配置目录的"公开面"评审；把它们设成 isPublic 等于绕过该入口。
    //
    // 这条断言曾经是 `[CONFIG_KEY_SYSTEM_NOTICE]` —— 即 `ai.systemNotice` 曾被当作
    // 唯一被允许的例外（当时它不在目录里，后台改不了）。该键现已补录进
    // `system-config.catalog.ts` 的 AI 分组，例外随之消失，断言收紧为"一个都不许有"：
    // 今后任何人再往种子里塞目录外的公开键都会直接失败。
    const publicOutsideCatalog = SYSTEM_CONFIGS.filter(
      (config) => config.isPublic && !CONFIG_DEFINITION_MAP.has(config.key),
    ).map((config) => config.key);

    expect(publicOutsideCatalog).toEqual([]);
  });

  it('运营内部配置不得出现在种子里（更不能设成 public）', () => {
    // `security.adminIpWhitelist`（后台来源 IP 白名单）与 `admin.ipWhitelist.{adminId}`
    // 属运营内部信息，既不入种子也不公开 —— 让攻击面清单出现在公开配置里没有收益。
    const internal = SYSTEM_CONFIGS.filter(
      (config) => config.key.startsWith('security.') || config.key.startsWith('admin.'),
    );

    expect(internal).toEqual([]);
  });

  it('NUMBER 值是有限正数（读取方 `readPositiveNumber` 对非正数一律回落兜底值）', () => {
    for (const config of SYSTEM_CONFIGS) {
      if (config.valueType !== ConfigValueType.NUMBER) continue;

      const parsed = Number(config.value);
      expect({ key: config.key, finite: Number.isFinite(parsed), positive: parsed > 0 }).toEqual({
        key: config.key,
        finite: true,
        positive: true,
      });
    }
  });

  it('JSON 值可解析（解析失败会被 `parseConfigValue` 回退成原始字符串，静默降级）', () => {
    for (const config of SYSTEM_CONFIGS) {
      if (config.valueType !== ConfigValueType.JSON) continue;

      expect(() => JSON.parse(config.value) as unknown).not.toThrow();
    }
  });

  it('危机资源清单仍带有读取方需要的三个字段（name/phone/available）', () => {
    const resources = SYSTEM_CONFIGS.find((config) => config.key === CONFIG_KEY_SAFETY_RESOURCES);

    expect(resources).toBeDefined();

    const parsed = JSON.parse(resources?.value ?? '[]') as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);

    for (const item of parsed) {
      expect(typeof item['name']).toBe('string');
      expect(typeof item['phone']).toBe('string');
      expect(typeof item['available']).toBe('string');
    }
  });

  it('STRING 值非空（`readStringConfig` 对空串同样回落兜底值，等于没灌）', () => {
    for (const config of SYSTEM_CONFIGS) {
      if (config.valueType !== ConfigValueType.STRING) continue;

      expect(config.value.trim().length).toBeGreaterThan(0);
    }
  });

  it('描述非空（后台配置列表要能看出这一行是干什么的）', () => {
    for (const config of SYSTEM_CONFIGS) {
      expect(config.description.length).toBeGreaterThan(10);
    }
  });
});
