/**
 * 本地存储封装测试
 *
 * 重点覆盖「不因存储异常打断业务流程」这一核心设计目标：
 *   · 序列化往返正确
 *   · 过期自动清理
 *   · 脏数据（非法 JSON / 结构不符）不影响后续读取
 *   · 存储配额满时降级到内存而不是抛异常
 */

import { describe, expect, it, vi } from 'vitest';

import { storage } from '@/utils/storage';
import { testHelpers } from '../setup';

describe('storage', () => {
  it('JSON 往返保持结构与类型', () => {
    storage.set('obj', { id: 'u1', scores: [1, 2, 3], nested: { ok: true } });

    expect(storage.get<{ id: string; scores: number[]; nested: { ok: boolean } }>('obj')).toEqual({
      id: 'u1',
      scores: [1, 2, 3],
      nested: { ok: true },
    });
  });

  it('支持字符串、数字、布尔与数组等原始类型', () => {
    storage.set('str', 'hello');
    storage.set('num', 42);
    storage.set('bool', false);
    storage.set('arr', [1, 2]);

    expect(storage.get<string>('str')).toBe('hello');
    expect(storage.get<number>('num')).toBe(42);
    expect(storage.get<boolean>('bool')).toBe(false);
    expect(storage.get<number[]>('arr')).toEqual([1, 2]);
  });

  it('读取不存在的 key 返回 null 而不是 undefined', () => {
    expect(storage.get('missing')).toBeNull();
  });

  it('remove 后读取为 null', () => {
    storage.set('temp', 'value');
    expect(storage.get('temp')).toBe('value');

    storage.remove('temp');
    expect(storage.get('temp')).toBeNull();
  });

  it('removeAll 批量清理', () => {
    storage.set('a', 1);
    storage.set('b', 2);
    storage.removeAll(['a', 'b']);

    expect(storage.get('a')).toBeNull();
    expect(storage.get('b')).toBeNull();
  });

  describe('过期时间', () => {
    it('未过期时可正常读取', () => {
      storage.set('token', 'abc', 60_000);
      expect(storage.get('token')).toBe('abc');
    });

    it('已过期时返回 null 并清理数据', () => {
      // 直接写入一个「过期时间在过去」的合法包络，避免依赖等待或负 TTL 的歧义语义
      testHelpers.memoryStore.set(
        'expired',
        JSON.stringify({ v: 1, t: Date.now() - 10_000, e: Date.now() - 1_000, d: 'stale-value' }),
      );

      expect(storage.get('expired')).toBeNull();
      // 过期数据应被物理清理，避免占用配额
      expect(testHelpers.memoryStore.has('expired')).toBe(false);
    });

    it('ttl 为 0 或负数表示永不过期（与 admin 端语义保持一致）', () => {
      storage.set('forever-a', 'v', 0);
      storage.set('forever-b', 'v', -1);

      expect(storage.ttl('forever-a')).toBe(-1);
      expect(storage.ttl('forever-b')).toBe(-1);
      expect(storage.get('forever-a')).toBe('v');
      expect(storage.get('forever-b')).toBe('v');
    });

    it('ttl() 返回剩余毫秒数；永不过期返回 -1', () => {
      storage.set('short', 'v', 60_000);
      const ttl = storage.ttl('short');
      expect(ttl).not.toBeNull();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);

      storage.set('forever', 'v');
      expect(storage.ttl('forever')).toBe(-1);

      expect(storage.ttl('missing')).toBeNull();
    });
  });

  describe('脏数据容错', () => {
    it('非法 JSON 不影响读取，且被清理', () => {
      testHelpers.memoryStore.set('broken', '{not-json');

      expect(storage.get('broken')).toBeNull();
      expect(testHelpers.memoryStore.has('broken')).toBe(false);
    });

    it('结构不符的 JSON（缺少数据字段）被识别为脏数据', () => {
      testHelpers.memoryStore.set('wrong-shape', JSON.stringify({ foo: 'bar' }));

      expect(storage.get('wrong-shape')).toBeNull();
      expect(testHelpers.memoryStore.has('wrong-shape')).toBe(false);
    });

    it('数组等非对象 JSON 被识别为脏数据', () => {
      testHelpers.memoryStore.set('array', JSON.stringify([1, 2, 3]));
      expect(storage.get('array')).toBeNull();
    });
  });

  describe('异常降级', () => {
    it('写入超出配额时降级到内存，不抛异常且仍可读回', () => {
      testHelpers.failStorageWrite(true);

      expect(() => storage.set('big', 'value')).not.toThrow();
      // 内存降级后应仍能读回，保证业务不中断
      expect(storage.get<string>('big')).toBe('value');
    });

    it('读取底层异常时不抛异常', () => {
      vi.mocked(uni.getStorageSync).mockImplementationOnce(() => {
        throw new Error('getStorageSync:fail');
      });

      expect(() => storage.get('any')).not.toThrow();
      expect(storage.get('any')).toBeNull();
    });
  });

  it('has() 反映真实存在性', () => {
    expect(storage.has('x')).toBe(false);
    storage.set('x', 1);
    expect(storage.has('x')).toBe(true);
    storage.remove('x');
    expect(storage.has('x')).toBe(false);
  });
});
