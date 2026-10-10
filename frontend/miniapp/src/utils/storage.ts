/**
 * 本地存储封装
 *
 * 相比直接使用 uni.setStorageSync 的价值：
 *   · 统一 try/catch：小程序存储配额满、序列化失败时不抛异常打断流程
 *   · 统一 JSON 序列化，避免各处手写 JSON.stringify
 *   · 支持过期时间，读到时自动清理
 *   · 提供带命名空间的清理能力（登出时只清业务缓存，不动其他 SDK 数据）
 *
 * ⚠ 安全约束：token 属于凭证，只允许存放在此；严禁存放任何密钥、明文手机号等敏感信息。
 */

interface StoredEnvelope<T> {
  /** 数据版本，便于未来结构升级时做迁移 */
  v: number;
  /** 写入时间戳（毫秒） */
  t: number;
  /** 过期时间戳（毫秒），undefined 表示永不过期 */
  e?: number;
  /** 实际数据 */
  d: T;
}

const ENVELOPE_VERSION = 1;

/** 存储层异常统一处理：小程序存储不可用时降级为内存 Map，保证功能不中断 */
const memoryFallback = new Map<string, string>();

/**
 * 读取底层存储。
 *
 * 注意这里的关键细节：底层读取「成功但返回空」并不代表数据不存在 ——
 * 它也可能是上一次写入因配额超限而被降级到了内存。因此只有拿到非空值才返回，
 * 否则继续查内存降级层，保证「写失败降级 → 读回」这条链路闭环。
 */
const safeGetStorage = (key: string): string | undefined => {
  try {
    const value = uni.getStorageSync(key);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  } catch (error) {
    console.warn(`[storage] 读取失败，尝试内存降级: ${key}`, error);
  }

  return memoryFallback.get(key);
};

const safeSetStorage = (key: string, value: string): boolean => {
  try {
    uni.setStorageSync(key, value);
    return true;
  } catch (error) {
    // 常见原因：超出 10MB 配额。此时降级内存，避免阻断业务流程
    console.warn(`[storage] 写入失败，降级到内存: ${key}`, error);
    memoryFallback.set(key, value);
    return false;
  }
};

const safeRemoveStorage = (key: string): void => {
  try {
    uni.removeStorageSync(key);
  } catch (error) {
    console.warn(`[storage] 删除失败: ${key}`, error);
  }
  memoryFallback.delete(key);
};

export const storage = {
  /**
   * 写入数据
   * @param ttlMs 过期毫秒数；不传表示永不过期
   */
  set<T>(key: string, value: T, ttlMs?: number): void {
    const envelope: StoredEnvelope<T> = {
      v: ENVELOPE_VERSION,
      t: Date.now(),
      d: value,
      ...(ttlMs !== undefined && ttlMs > 0 ? { e: Date.now() + ttlMs } : {}),
    };

    try {
      safeSetStorage(key, JSON.stringify(envelope));
    } catch (error) {
      // 循环引用等序列化失败：记录但不抛出
      console.error(`[storage] 序列化失败: ${key}`, error);
    }
  },

  /** 读取数据；不存在、已过期或结构损坏时返回 null（并清理脏数据） */
  get<T>(key: string): T | null {
    const raw = safeGetStorage(key);
    if (raw === undefined) return null;

    try {
      const envelope = JSON.parse(raw) as StoredEnvelope<T>;

      // 结构校验：缺少必要字段视为脏数据
      if (typeof envelope !== 'object' || envelope === null || !('d' in envelope)) {
        safeRemoveStorage(key);
        return null;
      }

      if (typeof envelope.e === 'number' && Date.now() > envelope.e) {
        safeRemoveStorage(key);
        return null;
      }

      return envelope.d;
    } catch {
      // 损坏数据直接清理，避免每次读取都失败
      safeRemoveStorage(key);
      return null;
    }
  },

  /** 读取并返回剩余有效毫秒数；-1 表示永不过期；null 表示不存在或已过期 */
  ttl(key: string): number | null {
    const raw = safeGetStorage(key);
    if (raw === undefined) return null;

    try {
      const envelope = JSON.parse(raw) as StoredEnvelope<unknown>;
      if (typeof envelope.e !== 'number') return -1;
      const remaining = envelope.e - Date.now();
      return remaining > 0 ? remaining : null;
    } catch {
      return null;
    }
  },

  remove(key: string): void {
    safeRemoveStorage(key);
  },

  /** 批量删除 */
  removeAll(keys: readonly string[]): void {
    keys.forEach((key) => safeRemoveStorage(key));
  },

  has(key: string): boolean {
    return this.get(key) !== null;
  },
};
