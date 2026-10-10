/**
 * Pinia 实例与自研持久化插件
 *
 * 设计取舍：
 *   - **不引入 pinia-plugin-persistedstate**（架构 §4.2 虽列了该库，但 Phase 0 明确不新增依赖），
 *     这里用 ~40 行实现「读取初始值 + 订阅变更写回」，能力覆盖管理后台的全部需求。
 *   - **持久化策略集中登记在 `PERSIST_CONFIG`**，而不是在每个 store 上写 `persist` 选项：
 *     这样「哪些状态会落到 localStorage」在一处即可审计，且不依赖对 pinia 内部类型做模块增强。
 *   - **安全底线**：令牌（accessToken / refreshToken）永不持久化（架构 §9.2：管理员 Token 仅存内存）。
 *
 * 存储能力（命名空间、JSON 序列化、TTL、异常兜底）见 src/utils/storage.ts。
 */

import { createPinia, type Pinia, type PiniaPluginContext } from 'pinia';
import { storage } from '@/utils/storage';

/** 单个 store 的持久化配置 */
export interface PersistOptions {
  /** 存储键，默认使用 `store.$id` */
  key?: string;
  /** 仅持久化指定字段（浅层字段名）；缺省表示持久化整个 state */
  paths?: readonly string[];
  /** 过期时间（毫秒）；缺省表示永久有效 */
  ttlMs?: number;
}

/**
 * 持久化策略表（键 = `store.$id`）
 *
 * 注意：新增需要持久化的 store 时在此登记，并在 store 定义处写注释互相指向。
 */
export const PERSIST_CONFIG: Readonly<Record<string, PersistOptions>> = {
  // 管理员信息与角色/权限点：用于刷新后仍能渲染菜单；**不包含任何令牌**
  auth: { key: 'auth', paths: ['admin', 'roles', 'permissions'] },
  // 界面偏好
  app: { key: 'app', paths: ['sidebarCollapsed', 'theme'] },
};

/** 按 paths 截取需要持久化的字段 */
const serializeState = (state: object, paths?: readonly string[]): Record<string, unknown> => {
  const record = state as Record<string, unknown>;
  if (!paths || paths.length === 0) return { ...record };

  const picked: Record<string, unknown> = {};
  for (const path of paths) {
    if (path in record) picked[path] = record[path];
  }
  return picked;
};

/** 判定读回的持久化数据是否可以合并进 state */
const isHydratableState = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 持久化插件
 *
 * 行为：
 *   1. store 创建时，从 localStorage 读取上次持久化的字段并合并（合并而非替换，避免新增字段丢失初值）；
 *   2. 订阅 state 变更，按策略写回 localStorage（JSON 序列化 + 命名空间隔离）；
 *   3. 读取失败（损坏数据、存储不可用）时静默跳过，不影响应用启动。
 */
export const persistPlugin = ({ store }: PiniaPluginContext): void => {
  const options: PersistOptions | undefined = PERSIST_CONFIG[store.$id];
  if (!options) return;

  const storageKey = options.key ?? store.$id;

  const saved = storage.get<Record<string, unknown>>(storageKey);
  if (isHydratableState(saved)) {
    store.$patch((state) => {
      Object.assign(state, saved);
    });
  }

  store.$subscribe((_mutation, state) => {
    storage.set(storageKey, serializeState(state, options.paths), options.ttlMs);
  });
};

/** 应用级 Pinia 实例 */
export const pinia: Pinia = createPinia();
pinia.use(persistPlugin);

export default pinia;
