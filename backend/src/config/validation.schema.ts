/**
 * 环境变量校验 Schema（Joi）
 *
 * 设计原则（见 PROJECT_ARCHITECTURE.md §16.2）：
 *   1. 所有配置必须来自环境变量，代码中禁止硬编码
 *   2. 缺失关键配置时 **进程必须启动失败**，禁止带病启动
 *   3. 生产环境额外强制要求第三方密钥，开发/测试环境允许留空以便本地联调
 */

import * as Joi from 'joi';

/** 生产环境必须提供的变量（开发环境可留空） */
const PRODUCTION_REQUIRED = [
  'WECHAT_APPID',
  'WECHAT_SECRET',
  'CRYPTO_KEY',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'WECHAT_PAY_MCHID',
  'WECHAT_PAY_SERIAL_NO',
  'WECHAT_PAY_APIV3_KEY',
] as const;

/** 生产环境禁止使用的开发默认值（防止把示例密钥带上线） */
const FORBIDDEN_IN_PRODUCTION = ['CHANGE_ME', 'dev_only'] as const;

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

export const validationSchema = Joi.object({
  // ---------------- 应用 ----------------
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').default('development'),
  APP_NAME: Joi.string().default('SoulMap AI'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),
  TZ: Joi.string().default('Asia/Shanghai'),
  SWAGGER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  METRICS_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  // 协议正文基址（隐私政策/用户协议/年龄声明/AI 内容提示/营销授权）
  // 未配置时相关接口的 url 字段返回 null，前端隐藏「查看原文」入口
  LEGAL_BASE_URL: Joi.string().uri().allow('').default(''),
  // 管理后台 IP 白名单（逗号分隔的 IP 列表）
  // 契约 §3.14.1.1「配置 ADMIN_IP_WHITELIST 时生效」：为空即不限制
  ADMIN_IP_WHITELIST: Joi.string()
    .allow('')
    .default('')
    .custom((value: string, helpers) => {
      if (value === '') return value;

      for (const entry of value.split(',').map((item) => item.trim())) {
        // 逐项校验：只接受 IPv4 点分写法或含冒号的 IPv6；不校验 CIDR
        // （网段限制应由反向代理/防火墙承担，应用层只做精确匹配，避免误判放行）
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(entry) && !entry.includes(':')) {
          return helpers.error('any.invalid');
        }
      }

      return value;
    }, 'ADMIN_IP_WHITELIST 格式')
    .messages({ 'any.invalid': 'ADMIN_IP_WHITELIST 必须是逗号分隔的合法 IP 列表' }),

  // ---------------- 数据库 ----------------
  DATABASE_URL: Joi.string()
    .pattern(/^postgres(ql)?:\/\//)
    .required()
    .messages({ 'string.pattern.base': 'DATABASE_URL 必须是合法的 PostgreSQL 连接串' }),
  DATABASE_POOL_SIZE: Joi.number().integer().min(1).max(100).default(10),
  DATABASE_POOL_TIMEOUT: Joi.number().integer().min(1).default(20),

  // ---------------- Redis ----------------
  REDIS_HOST: Joi.string().hostname().default('127.0.0.1'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).max(15).default(0),
  REDIS_KEY_PREFIX: Joi.string().default('sm'),

  // ---------------- 队列 ----------------
  QUEUE_PREFIX: Joi.string().default('soulmap'),
  QUEUE_CONCURRENCY_AI: Joi.number().integer().min(1).max(50).default(5),
  QUEUE_CONCURRENCY_DEFAULT: Joi.number().integer().min(1).max(100).default(10),

  // ---------------- JWT / 加密 ----------------
  JWT_SECRET: Joi.string().min(32).required().messages({
    'string.min': 'JWT_SECRET 长度必须 ≥ 32 字符',
  }),
  JWT_ACCESS_TTL: Joi.string().default('2h'),
  JWT_REFRESH_TTL: Joi.string().default('30d'),
  ADMIN_JWT_SECRET: Joi.string().min(32).required().messages({
    'string.min': 'ADMIN_JWT_SECRET 长度必须 ≥ 32 字符（且必须与 JWT_SECRET 不同）',
  }),
  ADMIN_JWT_ACCESS_TTL: Joi.string().default('1h'),
  ADMIN_JWT_REFRESH_TTL: Joi.string().default('7d'),
  CRYPTO_KEY: Joi.string().allow('').default(''),
  CRYPTO_IV_SALT: Joi.string().allow('').default(''),

  // ---------------- 微信小程序 ----------------
  WECHAT_APPID: Joi.string().allow('').default(''),
  WECHAT_SECRET: Joi.string().allow('').default(''),
  WECHAT_MSG_SEC_CHECK: Joi.boolean().truthy('true').falsy('false').default(false),
  WECHAT_TMPL_REPORT_READY: Joi.string().allow('').default(''),
  WECHAT_TMPL_INVITE_ACCEPTED: Joi.string().allow('').default(''),
  WECHAT_TMPL_MEMBERSHIP_EXPIRING: Joi.string().allow('').default(''),

  // ---------------- 微信支付 ----------------
  WECHAT_PAY_ENV: Joi.string().valid('sandbox', 'production').default('sandbox'),
  WECHAT_PAY_MCHID: Joi.string().allow('').default(''),
  WECHAT_PAY_SERIAL_NO: Joi.string().allow('').default(''),
  WECHAT_PAY_PRIVATE_KEY: Joi.string().allow('').default(''),
  WECHAT_PAY_PRIVATE_KEY_PATH: Joi.string().allow('').default(''),
  WECHAT_PAY_APIV3_KEY: Joi.string().allow('').default(''),
  WECHAT_PAY_NOTIFY_URL: Joi.string().uri().allow('').default(''),
  WECHAT_PAY_REFUND_NOTIFY_URL: Joi.string().uri().allow('').default(''),
  WECHAT_PAY_PLATFORM_CERT_PATH: Joi.string().allow('').default(''),

  // ---------------- LLM ----------------
  AI_DEFAULT_PROVIDER: Joi.string().valid('deepseek', 'openai', 'qwen').default('deepseek'),
  AI_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(2),
  AI_TIMEOUT_MS: Joi.number().integer().min(1000).default(60000),
  AI_STREAM_FIRST_TOKEN_TIMEOUT_MS: Joi.number().integer().min(1000).default(20000),
  AI_STREAM_TOTAL_TIMEOUT_MS: Joi.number().integer().min(1000).default(180000),
  AI_DAILY_COST_BUDGET_CENTS: Joi.number().integer().min(0).default(50000),
  AI_CIRCUIT_BREAKER_THRESHOLD: Joi.number().integer().min(1).default(5),
  AI_CIRCUIT_BREAKER_COOLDOWN_MS: Joi.number().integer().min(1000).default(60000),
  DEEPSEEK_API_KEY: Joi.string().allow('').default(''),
  DEEPSEEK_BASE_URL: Joi.string().uri().default('https://api.deepseek.com'),
  DEEPSEEK_DEFAULT_MODEL: Joi.string().default('deepseek-chat'),
  OPENAI_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  OPENAI_API_KEY: Joi.string().allow('').default(''),
  OPENAI_BASE_URL: Joi.string().uri().default('https://api.openai.com/v1'),
  OPENAI_DEFAULT_MODEL: Joi.string().default('gpt-4o-mini'),
  QWEN_API_KEY: Joi.string().allow('').default(''),
  QWEN_BASE_URL: Joi.string().uri().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  QWEN_DEFAULT_MODEL: Joi.string().default('qwen-plus'),

  // ---------------- OSS ----------------
  OSS_REGION: Joi.string().default('oss-cn-hangzhou'),
  OSS_BUCKET: Joi.string().allow('').default(''),
  OSS_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  OSS_ACCESS_KEY_SECRET: Joi.string().allow('').default(''),
  OSS_STS_ROLE_ARN: Joi.string().allow('').default(''),
  OSS_CDN_DOMAIN: Joi.string().allow('').default(''),
  // 默认 900 秒（15 分钟）；上限 3600 与契约 §3.10.2「绝不签发长期 URL」一致
  OSS_SIGNED_URL_TTL: Joi.number().integer().min(60).max(3600).default(900),
  // 默认 20MB：必须 ≥ 场景上限最大值（REPORT_PDF 20MB），否则全局硬顶会
  // 悄悄把契约承诺的场景上限压小（storage.util 取二者较小值）
  OSS_MAX_UPLOAD_BYTES: Joi.number().integer().min(1024).default(20971520),

  // ---------------- 限流 ----------------
  THROTTLE_GLOBAL_TTL: Joi.number().integer().min(1).default(60),
  THROTTLE_GLOBAL_LIMIT: Joi.number().integer().min(1).default(100),
  THROTTLE_AI_TTL: Joi.number().integer().min(1).default(60),
  THROTTLE_AI_LIMIT: Joi.number().integer().min(1).default(10),
  THROTTLE_LOGIN_TTL: Joi.number().integer().min(1).default(300),
  THROTTLE_LOGIN_LIMIT: Joi.number().integer().min(1).default(10),

  // ---------------- 业务开关与配额 ----------------
  FEATURE_COUPLE_MATCH: Joi.boolean().truthy('true').falsy('false').default(true),
  FEATURE_PAYMENT: Joi.boolean().truthy('true').falsy('false').default(true),
  FEATURE_AI_CHAT: Joi.boolean().truthy('true').falsy('false').default(true),
  QUOTA_FREE_AI_MESSAGES: Joi.number().integer().min(0).default(5),
  QUOTA_MEMBER_DAILY_AI_MESSAGES: Joi.number().integer().min(0).default(100),
  REPORT_FREE_PREVIEW_RATIO: Joi.number().min(0).max(1).default(0.2),
  REPORT_GENERATION_TIMEOUT_MS: Joi.number().integer().min(1000).default(180000),
  ORDER_EXPIRE_MINUTES: Joi.number().integer().min(1).default(30),
  ACCOUNT_DELETION_GRACE_DAYS: Joi.number().integer().min(0).default(7),

  // ---------------- 可观测性 ----------------
  SENTRY_DSN: Joi.string().allow('').default(''),
  PROMETHEUS_PATH: Joi.string().default('/metrics'),
  ALERT_WEBHOOK_URL: Joi.string().allow('').default(''),
})
  // 生产环境：关键第三方配置必须存在且不能是开发占位值
  .custom((value: Record<string, unknown>, helpers) => {
    if (!isProduction()) return value;

    for (const key of PRODUCTION_REQUIRED) {
      const raw = value[key];
      if (typeof raw !== 'string' || raw.trim() === '') {
        return helpers.error('any.custom', {
          message: `生产环境必须配置 ${key}`,
        });
      }
      if (FORBIDDEN_IN_PRODUCTION.some((bad) => raw.includes(bad))) {
        return helpers.error('any.custom', {
          message: `生产环境禁止使用开发占位值配置 ${key}`,
        });
      }
    }

    if (value.JWT_SECRET === value.ADMIN_JWT_SECRET) {
      return helpers.error('any.custom', {
        message: '生产环境 JWT_SECRET 与 ADMIN_JWT_SECRET 必须不同（双 realm 隔离）',
      });
    }

    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  })
  .unknown(true);
