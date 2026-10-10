/** 请求上下文对象 — 由 RequestIdMiddleware 注入，贯穿全链路日志 */

import type { Request } from 'express';

/** 认证后的主体（Phase 1 由 JwtStrategy 填充，此处先定义契约以避免后续改动扩散） */
export interface AuthPrincipal {
  /** 用户 ID（UUIDv7） */
  userId: string;
  /** 认证域：用户端 / 管理端，二者不可混用 */
  realm: 'user' | 'admin';
  /** 管理端角色码列表，用户端为空 */
  roles: string[];
  /** 权限点列表（管理端），格式 <domain>:<resource>:<action> */
  permissions: string[];
  /** 当前 token 的 jti，用于注销与撤销 */
  jti: string;
}

export interface RequestWithContext extends Request {
  /** 请求追踪 ID（响应头 X-Request-Id 同步返回） */
  requestId: string;
  /** 请求开始时间（高精度毫秒），用于计算耗时 */
  startedAt: number;
  /** 认证主体，未登录时为空 */
  principal?: AuthPrincipal;
}
