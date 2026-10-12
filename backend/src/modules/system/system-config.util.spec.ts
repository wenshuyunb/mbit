/**
 * 配置工具函数单测
 *
 * 这些函数是「后台写」与「前台读」的共同口径：值归一化错了，后台写进去的
 * 与前台读出来的就不是同一个值；版本哈希不稳定，前端每次都会认为配置变了。
 * 因此逐个边界都要钉住。
 */

import { ConfigValueType } from '@prisma/client';

import {
  CONFIG_DEFINITION_MAP,
  CONFIG_DEFINITIONS,
  CONFIG_GROUP_NAMES,
  CONFIG_GROUPS,
  type ConfigDefinition,
} from './system-config.catalog';
import {
  buildConfigVersion,
  buildDisclaimerVersion,
  compareSemver,
  formatPrice,
  normalizeConfigValue,
  parseConfigValue,
} from './system-config.util';

const definitionOf = (key: string): ConfigDefinition => {
  const definition = CONFIG_DEFINITION_MAP.get(key);
  if (!definition) throw new Error(`测试用配置键不存在: ${key}`);
  return definition;
};

describe('system-config.util', () => {
  describe('parseConfigValue', () => {
    it('按 valueType 解析布尔/数字/JSON/字符串', () => {
      expect(parseConfigValue('true', ConfigValueType.BOOLEAN)).toBe(true);
      expect(parseConfigValue('false', ConfigValueType.BOOLEAN)).toBe(false);
      expect(parseConfigValue('0.25', ConfigValueType.NUMBER)).toBe(0.25);
      expect(parseConfigValue('{"a":1}', ConfigValueType.JSON)).toEqual({ a: 1 });
      expect(parseConfigValue('纯文本', ConfigValueType.STRING)).toBe('纯文本');
    });

    it('脏数据回退为原始字符串而不是抛错（首屏不能因配置损坏而 500）', () => {
      expect(parseConfigValue('{坏 JSON', ConfigValueType.JSON)).toBe('{坏 JSON');
      expect(parseConfigValue('abc', ConfigValueType.NUMBER)).toBe('abc');
    });
  });

  describe('normalizeConfigValue', () => {
    it('布尔/数字按标准形态归一', () => {
      expect(normalizeConfigValue(definitionOf('FEATURE_VOICE_INPUT'), true)).toEqual({ rawValue: 'true' });
      expect(normalizeConfigValue(definitionOf('freeAiQuotaTotal'), 10)).toEqual({ rawValue: '10' });
    });

    it('类型不符时报错（契约 §3.14.9.2 的 10001）', () => {
      expect(normalizeConfigValue(definitionOf('FEATURE_VOICE_INPUT'), 'true')).toEqual({
        errors: ['FEATURE_VOICE_INPUT 需要布尔值'],
      });
      expect(normalizeConfigValue(definitionOf('freeAiQuotaTotal'), '10')).toEqual({
        errors: ['freeAiQuotaTotal 需要数字'],
      });
      expect(normalizeConfigValue(definitionOf('nicknameMaxLength'), Number.NaN)).toEqual({
        errors: ['nicknameMaxLength 需要数字'],
      });
    });

    it('超出 min/max 时报错（契约 §3.14.9.2 的 10016 语义）', () => {
      expect(normalizeConfigValue(definitionOf('reportFreePreviewRatio'), 1.5)).toEqual({
        errors: ['reportFreePreviewRatio 不能大于 1'],
      });
      expect(normalizeConfigValue(definitionOf('reportFreePreviewRatio'), -0.1)).toEqual({
        errors: ['reportFreePreviewRatio 不能小于 0'],
      });
    });

    it('JSON 型只接受对象/数组，且序列化后可直接入库', () => {
      expect(normalizeConfigValue(definitionOf('uploadMaxBytes'), { AVATAR: 100 })).toEqual({
        rawValue: '{"AVATAR":100}',
      });
      expect(normalizeConfigValue(definitionOf('uploadMaxBytes'), 'x')).toEqual({
        errors: ['uploadMaxBytes 需要 JSON 对象或数组'],
      });
      expect(normalizeConfigValue(definitionOf('uploadMaxBytes'), null)).toEqual({
        errors: ['uploadMaxBytes 需要 JSON 对象或数组'],
      });
    });
  });

  describe('compareSemver', () => {
    it('按段比较，缺失段补 0', () => {
      expect(compareSemver('1.4.2', '1.2.0')).toBe(1);
      expect(compareSemver('1.2.0', '1.2.0')).toBe(0);
      expect(compareSemver('1.1.9', '1.2.0')).toBe(-1);
      expect(compareSemver('1.2', '1.2.0')).toBe(0);
      expect(compareSemver('2.0.0-beta.1', '1.9.9')).toBe(1);
    });
  });

  describe('版本号（内容哈希）', () => {
    const now = new Date('2026-02-14T18:00:00.000Z');

    it('内容相同 → 版本相同；内容变化 → 版本变化', () => {
      const version = buildConfigVersion([{ key: 'a', rawValue: '1' }], now);
      expect(version).toBe(buildConfigVersion([{ key: 'a', rawValue: '1' }], now));
      expect(version).not.toBe(buildConfigVersion([{ key: 'a', rawValue: '2' }], now));
      expect(version.startsWith('sv-20260214-')).toBe(true);
    });

    it('与键的顺序无关（避免因查询顺序抖动而误判缓存过期）', () => {
      expect(
        buildConfigVersion(
          [
            { key: 'a', rawValue: '1' },
            { key: 'b', rawValue: '2' },
          ],
          now,
        ),
      ).toBe(
        buildConfigVersion(
          [
            { key: 'b', rawValue: '2' },
            { key: 'a', rawValue: '1' },
          ],
          now,
        ),
      );
    });

    it('文案版本使用 dl- 前缀（契约 §3.12.2）', () => {
      expect(
        buildDisclaimerVersion([{ key: 'disclaimer.aiContent', rawValue: 'x' }], now).startsWith('dl-20260214-'),
      ).toBe(true);
    });
  });

  it('formatPrice 按「分」折算为展示价', () => {
    expect(formatPrice(3900, '¥')).toBe('¥39.00');
    expect(formatPrice(29900, '¥')).toBe('¥299.00');
  });

  describe('配置目录自身的一致性', () => {
    it('每个分组都有中文名，且分组的取值都在枚举内', () => {
      for (const group of CONFIG_GROUPS) {
        expect(CONFIG_GROUP_NAMES[group]).toBeTruthy();
      }
      for (const definition of CONFIG_DEFINITIONS) {
        expect(CONFIG_GROUPS).toContain(definition.group);
      }
    });

    it('键唯一、都有中文说明与默认值', () => {
      const keys = CONFIG_DEFINITIONS.map((definition) => definition.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const definition of CONFIG_DEFINITIONS) {
        expect(definition.label.length).toBeGreaterThan(0);
        expect(definition.description.length).toBeGreaterThan(0);
        expect(typeof definition.defaultValue).toBe('string');
      }
    });

    it('数值型配置必须声明 min/max（否则后台无法校验区间）', () => {
      for (const definition of CONFIG_DEFINITIONS.filter((item) => item.valueType === ConfigValueType.NUMBER)) {
        expect(definition.min).toBeDefined();
        expect(definition.max).toBeDefined();
      }
    });
  });
});
