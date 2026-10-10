/**
 * 系统接口
 *
 * 对应后端模块：system（公开接口，无需登录）
 * 契约详见 docs/API_DESIGN.md
 */

import { http } from './request';
import type { SystemConfig } from '@/store/app';

/** 获取小程序启动配置（开关、免责声明、分享文案、免费预览比例） */
export const getSystemConfig = (): Promise<SystemConfig> =>
  http.get<SystemConfig>('/system/config', undefined, { needAuth: false, showError: false });

/** 获取免责声明文案（单独接口，便于合规文案热更） */
export const getDisclaimers = (): Promise<Record<string, string>> =>
  http.get<Record<string, string>>('/system/disclaimers', undefined, { needAuth: false, showError: false });
