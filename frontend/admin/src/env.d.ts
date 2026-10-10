/// <reference types="vite/client" />

/**
 * 全局类型声明
 *
 * 说明：
 *   1. `*.vue` 模块声明是给「非 vue-tsc 环境」（如纯 tsc、编辑器兜底）使用的垫片；
 *      vue-tsc 本身能解析 SFC 的真实类型，因此这里使用宽松签名，不会影响 SFC 内部校验。
 *   2. 环境变量必须在此声明类型，禁止使用未声明的 `import.meta.env.*`（架构 §16.3）。
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/** 静态资源模块声明（Vite 已内置大部分，这里只补充管理后台会直接引用的类型） */
declare module '*.svg' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  /** 后端接口基础地址，如 `/api/v1`（必填，缺省时回退到默认值） */
  readonly VITE_API_BASE_URL: string;
  /** 站点标题 */
  readonly VITE_APP_TITLE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
