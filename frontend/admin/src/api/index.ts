/**
 * api 层统一出口
 *
 * 使用建议：
 *   - 业务代码按域引入：`import { http } from '@/api/client'` 或 `import * as authApi from '@/api/auth'`；
 *   - 类型与错误对象：`import { ApiError, type PaginatedData } from '@/api/types'`；
 *   - 禁止在组件中直接使用 axios（必须经过 `@/api/client`，以统一令牌注入与错误处理）。
 */

export * from './client';
export * from './types';
export * as authApi from './auth';
