/**
 * 带命名空间与 JSON 序列化的本地存储封装
 *
 * 设计目标：
 *   1. **命名空间隔离**：同一个 localStorage 被多个子包/模块共用时互不干扰（key 前缀 `soulmap:admin:`）。
 *   2. **JSON 往返**：直接存取对象/数组/数字/布尔，无需调用方手动序列化。
 *   3. **绝不抛异常**：损坏数据、隐私模式（setItem 抛 QuotaExceededError）、SSR（无 localStorage）全部降级为静默失败，
 *      避免因本地存储异常导致整个管理后台白屏。
 *   4. **支持过期时间**：为后续「记住登录状态」「一次性验证码」等场景提供 TTL 能力。
 *
 * 注意：**禁止**在此存放敏感凭证。管理员 AccessToken / RefreshToken 仅保存在内存（架构 §9.2）。
 */

/** 存储后端抽象：便于注入假实现（测试）或在无 localStorage 环境下降级 */
export interface StorageBackend {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
}

/** 记录包装标记，用于区分「本封装写入的记录」与外部直接写入的裸 JSON */
const RECORD_MARKER = '__soulmap' as const;

/** 记录结构版本，后续如需迁移可据此分支 */
const RECORD_VERSION = 1;

/** 包装后的存储记录 */
interface StorageRecord<T> {
  [RECORD_MARKER]: typeof RECORD_VERSION;
  /** 真实值 */
  v: T;
  /** 过期时间戳（ms），缺省表示永不过期 */
  e?: number;
}

/** 命名空间存储实例 */
export interface NamespacedStorage {
  /** 命名空间名称（key 最终形态为 `${namespace}:${key}`） */
  readonly namespace: string;
  /** 读取；不存在/已过期/数据损坏均返回 null */
  get<T>(key: string): T | null;
  /** 写入；ttlMs 为正数时启用过期时间 */
  set<T>(key: string, value: T, ttlMs?: number): void;
  /** 删除单个键 */
  remove(key: string): void;
  /** 键是否存在且未过期 */
  has(key: string): boolean;
  /** 当前命名空间下的全部业务键（不含前缀） */
  keys(): string[];
  /** 仅清理当前命名空间的键（不影响其他命名空间的数据） */
  clear(): void;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** 判定是否为本封装写入的记录 */
const isStorageRecord = (value: unknown): value is StorageRecord<unknown> =>
  isPlainObject(value) && value[RECORD_MARKER] === RECORD_VERSION && 'v' in value;

/** 探测可用的默认后端；SSR 或浏览器禁用本地存储时返回 null */
const detectDefaultBackend = (): StorageBackend | null => {
  try {
    const candidate: unknown = globalThis.localStorage;
    if (
      isPlainObject(candidate) &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function' &&
      typeof candidate.key === 'function'
    ) {
      return candidate as unknown as StorageBackend;
    }
  } catch {
    // 某些浏览器的隐私模式下访问 localStorage 会直接抛异常
  }
  return null;
};

/**
 * 创建（或获取）一个命名空间存储实例
 * @param namespace 命名空间，建议与业务模块同名，如 `auth`、`app`
 * @param backend 可选的自定义后端（默认使用 window.localStorage）
 */
export const createStorage = (namespace: string, backend?: StorageBackend): NamespacedStorage => {
  const prefix = `${namespace}:`;
  let cachedBackend: StorageBackend | null | undefined;

  const resolveBackend = (): StorageBackend | null => {
    if (backend) return backend;
    if (cachedBackend === undefined) cachedBackend = detectDefaultBackend();
    return cachedBackend;
  };

  const fullKey = (key: string): string => `${prefix}${key}`;

  const set = <T>(key: string, value: T, ttlMs?: number): void => {
    const target = resolveBackend();
    if (!target) return;
    try {
      const record: StorageRecord<T> = { [RECORD_MARKER]: RECORD_VERSION, v: value };
      if (typeof ttlMs === 'number' && ttlMs > 0) record.e = Date.now() + ttlMs;
      target.setItem(fullKey(key), JSON.stringify(record));
    } catch {
      // 序列化失败（如循环引用）或写入失败（配额/隐私模式）：静默降级，不阻断业务流程
    }
  };

  const remove = (key: string): void => {
    const target = resolveBackend();
    if (!target) return;
    try {
      target.removeItem(fullKey(key));
    } catch {
      // 忽略删除失败
    }
  };

  const get = <T>(key: string): T | null => {
    const target = resolveBackend();
    if (!target) return null;

    let raw: string | null = null;
    try {
      raw = target.getItem(fullKey(key));
    } catch {
      return null;
    }
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 数据损坏（被其他代码污染/写入中断）：清理该键并返回 null，绝不抛异常
      remove(key);
      return null;
    }

    // 兼容外部直接写入的裸 JSON（非本封装记录）：原样返回
    if (!isStorageRecord(parsed)) return parsed as T;

    const expiresAt = parsed.e;
    if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
      remove(key);
      return null;
    }
    return parsed.v as T;
  };

  const keys = (): string[] => {
    const target = resolveBackend();
    if (!target) return [];
    const result: string[] = [];
    try {
      for (let index = 0; index < target.length; index += 1) {
        const current = target.key(index);
        if (typeof current === 'string' && current.startsWith(prefix)) {
          result.push(current.slice(prefix.length));
        }
      }
    } catch {
      return result;
    }
    return result;
  };

  return {
    namespace,
    get,
    set,
    remove,
    has: (key: string): boolean => get(key) !== null,
    keys,
    clear: (): void => {
      // 逐个删除而非调用 backend.clear()，避免误删其他命名空间的数据
      for (const key of keys()) remove(key);
    },
  };
};

/** 管理后台统一命名空间前缀 */
export const STORAGE_NAMESPACE = 'soulmap:admin';

/** 默认命名空间存储实例（业务模块可自行 createStorage 独立命名空间） */
export const storage = createStorage(STORAGE_NAMESPACE);

export default storage;
