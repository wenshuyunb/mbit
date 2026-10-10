/**
 * 环境配置
 *
 * 小程序不能使用 .env 注入（包体可被反编译），因此环境判断改为运行时读取
 * `uni.getAccountInfoSync().miniProgram.envVersion`：
 *   develop → 开发版（微信开发者工具 / 体验成员）
 *   trial   → 体验版（预发验证）
 *   release → 正式版（生产）
 *
 * ⚠ 安全要求：这里只能放「公开」信息。AppSecret、AI Key、支付密钥等
 *   一律只存在于服务端环境变量，绝不进入小程序包。
 */

export type AppEnv = 'develop' | 'trial' | 'release';

/** 各环境的后端基址（必须为 HTTPS 且已在微信后台配置为 request 合法域名） */
const BASE_URL_MAP: Record<AppEnv, string> = {
  develop: 'http://127.0.0.1:3000/api/v1',
  trial: 'https://staging-api.soulmap.example.com/api/v1',
  release: 'https://api.soulmap.example.com/api/v1',
};

/** 各环境的静态资源（OSS/CDN）基址 */
const CDN_URL_MAP: Record<AppEnv, string> = {
  develop: 'http://127.0.0.1:3000/static',
  trial: 'https://staging-cdn.soulmap.example.com',
  release: 'https://cdn.soulmap.example.com',
};

/** 读取当前小程序环境；H5 预览等非小程序端回退为 develop */
const resolveAppEnv = (): AppEnv => {
  // #ifdef MP-WEIXIN
  try {
    const info = uni.getAccountInfoSync() as MiniProgramAccountInfo;
    return info.miniProgram.envVersion;
  } catch {
    return 'develop';
  }
  // #endif

  // #ifndef MP-WEIXIN
  return 'develop';
  // #endif
};

export const appEnv: AppEnv = resolveAppEnv();

export const isProduction = appEnv === 'release';

/** 是否展示调试信息（仅开发版） */
export const isDebug = appEnv === 'develop';

export const env = {
  /** 小程序环境 */
  appEnv,
  isProduction,
  isDebug,
  /** 后端 API 基址（不含结尾斜杠） */
  baseUrl: BASE_URL_MAP[appEnv],
  /** 静态资源基址 */
  cdnUrl: CDN_URL_MAP[appEnv],
  /** 客户端版本号，随包体发布，用于后端排查接口兼容问题 */
  clientVersion: '1.0.0',
  /** 请求平台标识，后端据此区分端（与架构文档 §API_DESIGN 的 X-Platform 一致） */
  platform: 'miniapp' as const,
} as const;

/** 超时配置（毫秒） */
export const timeout = {
  /** 普通接口 */
  default: 15_000,
  /** AI 相关接口（报告生成、匹配分析） */
  ai: 90_000,
  /** 文件上传 */
  upload: 60_000,
} as const;
