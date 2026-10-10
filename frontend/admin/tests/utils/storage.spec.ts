/**
 * 本地存储封装单元测试
 *
 * 覆盖重点（真实故障场景）：
 *   - 命名空间隔离：多个模块共用 localStorage 时不互相覆盖
 *   - JSON 往返：对象/数组/数字/布尔/null 存取后类型保持
 *   - 损坏数据：非法 JSON 不抛异常，且被清理，避免每次读取都失败
 *   - 过期时间：TTL 在到期边界（expiresAt <= now）立即失效
 *   - 后端异常（隐私模式 / 配额超限）不得向上抛出，避免整个后台白屏
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_NAMESPACE, createStorage, storage, type StorageBackend } from '@/utils/storage';

describe('utils/storage —— 命名空间与 JSON 往返', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('命名空间隔离：不同命名空间的同名键互不影响', () => {
    const authStorage = createStorage('auth');
    const appStorage = createStorage('app');

    authStorage.set('token', 'AAA');
    appStorage.set('token', 'BBB');

    expect(authStorage.get<string>('token')).toBe('AAA');
    expect(appStorage.get<string>('token')).toBe('BBB');

    // 落盘 key 带命名空间前缀；未加前缀的裸键不会被读取到
    expect(window.localStorage.getItem('auth:token')).toContain('AAA');
    expect(window.localStorage.getItem('app:token')).toContain('BBB');
    expect(window.localStorage.getItem('token')).toBeNull();
    expect(window.localStorage.length).toBe(2);
  });

  it('JSON 往返：对象 / 数组 / 数字 / 布尔 / null 保持类型', () => {
    const scoped = createStorage('json');
    const payload = { id: 'u_1', roles: ['OPERATOR'], amount: 1990, active: true, profile: null };

    scoped.set('admin', payload);
    expect(scoped.get<typeof payload>('admin')).toEqual(payload);

    scoped.set('count', 0);
    expect(scoped.get<number>('count')).toBe(0);

    scoped.set('enabled', false);
    expect(scoped.get<boolean>('enabled')).toBe(false);

    scoped.set('list', [1, 2, 3]);
    expect(scoped.get<number[]>('list')).toEqual([1, 2, 3]);
  });

  it('未写入的键返回 null 且 has 为 false（不抛异常）', () => {
    const scoped = createStorage('missing');
    expect(scoped.get('nope')).toBeNull();
    expect(scoped.has('nope')).toBe(false);
  });

  it('损坏数据不抛异常：读取返回 null 并清理该键', () => {
    const scoped = createStorage('broken');
    window.localStorage.setItem('broken:profile', '{ 这不是合法 JSON');

    expect(() => scoped.get('profile')).not.toThrow();
    expect(scoped.get('profile')).toBeNull();
    // 已清理，避免后续每次读取都重复解析失败
    expect(window.localStorage.getItem('broken:profile')).toBeNull();
    expect(scoped.has('profile')).toBe(false);
  });

  it('兼容外部写入的裸 JSON（非本封装的记录结构）', () => {
    const scoped = createStorage('legacy');
    window.localStorage.setItem('legacy:raw', '{"a":1}');
    expect(scoped.get<{ a: number }>('raw')).toEqual({ a: 1 });
  });

  it('clear 只清理自身命名空间的键', () => {
    const first = createStorage('ns-a');
    const second = createStorage('ns-b');
    first.set('x', 1);
    first.set('y', 2);
    second.set('x', 3);

    expect(first.keys().sort()).toEqual(['x', 'y']);
    first.clear();

    expect(first.keys()).toEqual([]);
    expect(first.get<number>('x')).toBeNull();
    expect(second.get<number>('x')).toBe(3);
  });

  it('remove 只删除指定键', () => {
    const scoped = createStorage('rm');
    scoped.set('a', 1);
    scoped.set('b', 2);

    scoped.remove('a');

    expect(scoped.has('a')).toBe(false);
    expect(scoped.get<number>('b')).toBe(2);
    expect(scoped.keys()).toEqual(['b']);
  });
});

describe('utils/storage —— 过期时间（TTL）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-14T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('未到期可读；到期边界（expiresAt <= now）立即失效并清理', () => {
    const scoped = createStorage('ttl');
    scoped.set('code', '123456', 60_000);

    expect(scoped.get<string>('code')).toBe('123456');

    vi.advanceTimersByTime(59_999);
    expect(scoped.get<string>('code')).toBe('123456');

    vi.advanceTimersByTime(1);
    expect(scoped.get<string>('code')).toBeNull();
    expect(window.localStorage.getItem('ttl:code')).toBeNull();
  });

  it('ttlMs 缺省或非正数表示永不过期', () => {
    const scoped = createStorage('ttl-forever');
    scoped.set('a', 'a-value');
    scoped.set('b', 'b-value', 0);
    scoped.set('c', 'c-value', -1);

    vi.advanceTimersByTime(10 * 365 * 24 * 60 * 60 * 1000);

    expect(scoped.get<string>('a')).toBe('a-value');
    expect(scoped.get<string>('b')).toBe('b-value');
    expect(scoped.get<string>('c')).toBe('c-value');
  });
});

describe('utils/storage —— 容错与默认实例', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('后端抛异常时不向上抛出（隐私模式 / 配额超限）', () => {
    const failing: StorageBackend = {
      length: 0,
      getItem: (): string | null => {
        throw new Error('SecurityError: localStorage 不可用');
      },
      setItem: (): void => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (): void => {
        throw new Error('SecurityError: localStorage 不可用');
      },
      clear: (): void => {
        throw new Error('SecurityError: localStorage 不可用');
      },
      key: (): string | null => null,
    };

    const scoped = createStorage('failing', failing);

    expect(() => scoped.set('k', 'v')).not.toThrow();
    expect(scoped.get('k')).toBeNull();
    expect(() => scoped.remove('k')).not.toThrow();
    expect(scoped.keys()).toEqual([]);
    expect(() => scoped.clear()).not.toThrow();
  });

  it('默认实例使用 soulmap:admin 命名空间', () => {
    storage.set('probe', { ok: true });

    expect(window.localStorage.getItem(`${STORAGE_NAMESPACE}:probe`)).not.toBeNull();
    expect(storage.get<{ ok: boolean }>('probe')).toEqual({ ok: true });

    storage.remove('probe');
    expect(storage.has('probe')).toBe(false);
    expect(storage.namespace).toBe(STORAGE_NAMESPACE);
  });
});
