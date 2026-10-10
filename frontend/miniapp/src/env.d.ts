/// <reference types="@dcloudio/types" />
/// <reference types="vite/client" />

/**
 * 类型声明补充
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/** Vite 环境变量类型（小程序端仅使用少量，域名配置见 src/config/env.ts） */
interface ImportMetaEnv {
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** 微信小程序账号信息（uni.getAccountInfoSync 返回结构，尽量收敛为需要的字段） */
interface MiniProgramAccountInfo {
  miniProgram: {
    appId: string;
    envVersion: 'develop' | 'trial' | 'release';
    version: string;
  };
}
