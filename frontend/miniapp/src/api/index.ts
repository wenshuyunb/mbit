/**
 * API 模块统一出口
 *
 * 约定：页面/组件不直接拼接 URL，一律通过这里的领域函数调用，
 *       保证路径与请求选项（超时、是否需要登录、幂等键）集中管理。
 */

export * from './types';
export { http, httpPage, request, cancelRequest } from './request';

export * as authApi from './auth';
export * as systemApi from './system';
export * as testApi from './test';
export * as personalityApi from './personality';
export * as reportApi from './report';
export * as relationshipApi from './relationship';
export * as chatApi from './chat';
export * as membershipApi from './membership';
export * as orderApi from './order';
