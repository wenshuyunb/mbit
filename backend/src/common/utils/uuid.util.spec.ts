/**
 * UUID 形状校验
 *
 * 重点是**不能过严**：本仓库主键是 UUIDv7，`@IsUUID()`（v1–v5）会把正常请求
 * 全判成 400，因此这里专门用真实主键样本守住「v7 必须通过」。
 */

import { UUID_SHAPE_PATTERN, isUuidShape } from './uuid.util';

describe('uuid.util', () => {
  it('UUIDv7（本仓库主键形态）通过', () => {
    expect(isUuidShape('0195f3a2-b24e-7a86-abf1-7dae4b5c6f45')).toBe(true);
    expect(isUuidShape('0195f3a2-07ad-7fdb-9a46-c2fd9a0b1e9a')).toBe(true);
  });

  it('v1–v5 也通过（形状校验不绑定版本）', () => {
    expect(isUuidShape('2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d')).toBe(true);
    expect(isUuidShape('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
  });

  it('大小写都接受', () => {
    expect(isUuidShape('0195F3A2-B24E-7A86-ABF1-7DAE4B5C6F45')).toBe(true);
  });

  it('明显非法值被拒绝（这些进库会让 PostgreSQL 报错，须在入参层拦下）', () => {
    for (const value of [
      'not-a-uuid',
      '',
      '0195f3a2-b24e-7a86-abf1-7dae4b5c6f4', // 少一位
      '0195f3a2-b24e-7a86-abf1-7dae4b5c6f455', // 多一位
      '0195f3a2b24e7a86abf17dae4b5c6f45', // 无连字符
      '0195f3a2-b24e-7a86-abf1-7dae4b5c6f4g', // 非十六进制
      '0195f3a2-b24e-7a86-abf1-7dae4b5c6f45 ', // 尾随空格（不 trim，调用方负责）
      "0195f3a2-b24e-7a86-abf1-7dae4b5c6f45' OR 1=1--",
    ]) {
      expect(isUuidShape(value)).toBe(false);
    }
  });

  it('【关键】连续调用结果稳定（正则带 g 标志会让 .test() 因 lastIndex 间歇性失败）', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(UUID_SHAPE_PATTERN.test('0195f3a2-b24e-7a86-abf1-7dae4b5c6f45')).toBe(true);
      expect(UUID_SHAPE_PATTERN.test('not-a-uuid')).toBe(false);
    }
  });
});
