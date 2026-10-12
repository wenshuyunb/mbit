/**
 * 配置工厂 — 把扁平的环境变量映射为按域分组的强类型结构
 *
 * 约定：
 *   - 本文件是「环境变量 → 应用配置」的唯一转换点
 *   - 业务代码一律通过 ConfigService 读取，禁止直接访问 process.env
 */

import type { AppConfig } from './config.type';

const str = (key: string, fallback = ''): string => process.env[key]?.trim() ?? fallback;

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (key: string, fallback = false): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
};

export const configuration = (): AppConfig => {
  const env = (str('NODE_ENV', 'development') || 'development') as AppConfig['app']['env'];

  return {
    app: {
      name: str('APP_NAME', 'SoulMap AI'),
      env,
      port: num('PORT', 3000),
      apiPrefix: str('API_PREFIX', 'api/v1'),
      logLevel: str('LOG_LEVEL', env === 'production' ? 'info' : 'debug'),
      timezone: str('TZ', 'Asia/Shanghai'),
      swaggerEnabled: bool('SWAGGER_ENABLED', env !== 'production'),
      metricsEnabled: bool('METRICS_ENABLED', true),
      isProduction: env === 'production',
      // 由 CI 在构建镜像时注入，用于线上版本核对（未注入时为 unknown）
      gitSha: str('GIT_SHA', 'unknown'),
      buildTime: str('BUILD_TIME', 'unknown'),
      legalBaseUrl: str('LEGAL_BASE_URL'),
      /**
       * 管理后台 IP 白名单（逗号分隔）
       *
       * 契约 §3.14.1.1：「配置 `ADMIN_IP_WHITELIST` 时生效」—— 为空表示不限制，
       * 便于本地开发与内网部署；生产环境建议配置为办公网出口 IP。
       */
      adminIpWhitelist: str('ADMIN_IP_WHITELIST', ''),
    },

    database: {
      url: str('DATABASE_URL'),
      poolSize: num('DATABASE_POOL_SIZE', 10),
      poolTimeout: num('DATABASE_POOL_TIMEOUT', 20),
    },

    redis: {
      host: str('REDIS_HOST', '127.0.0.1'),
      port: num('REDIS_PORT', 6379),
      password: str('REDIS_PASSWORD'),
      db: num('REDIS_DB', 0),
      keyPrefix: str('REDIS_KEY_PREFIX', 'sm'),
    },

    queue: {
      prefix: str('QUEUE_PREFIX', 'soulmap'),
      concurrencyAi: num('QUEUE_CONCURRENCY_AI', 5),
      concurrencyDefault: num('QUEUE_CONCURRENCY_DEFAULT', 10),
    },

    jwt: {
      userSecret: str('JWT_SECRET'),
      userAccessTtl: str('JWT_ACCESS_TTL', '2h'),
      userRefreshTtl: str('JWT_REFRESH_TTL', '30d'),
      adminSecret: str('ADMIN_JWT_SECRET'),
      adminAccessTtl: str('ADMIN_JWT_ACCESS_TTL', '1h'),
      adminRefreshTtl: str('ADMIN_JWT_REFRESH_TTL', '7d'),
    },

    crypto: {
      key: str('CRYPTO_KEY'),
      ivSalt: str('CRYPTO_IV_SALT'),
    },

    wechat: {
      appId: str('WECHAT_APPID'),
      appSecret: str('WECHAT_SECRET'),
      msgSecCheck: bool('WECHAT_MSG_SEC_CHECK', false),
      templates: {
        reportReady: str('WECHAT_TMPL_REPORT_READY'),
        inviteAccepted: str('WECHAT_TMPL_INVITE_ACCEPTED'),
        membershipExpiring: str('WECHAT_TMPL_MEMBERSHIP_EXPIRING'),
      },
    },

    wechatPay: {
      env: (str('WECHAT_PAY_ENV', 'sandbox') as 'sandbox' | 'production') ?? 'sandbox',
      mchId: str('WECHAT_PAY_MCHID'),
      serialNo: str('WECHAT_PAY_SERIAL_NO'),
      privateKey: str('WECHAT_PAY_PRIVATE_KEY'),
      privateKeyPath: str('WECHAT_PAY_PRIVATE_KEY_PATH'),
      apiV3Key: str('WECHAT_PAY_APIV3_KEY'),
      notifyUrl: str('WECHAT_PAY_NOTIFY_URL'),
      refundNotifyUrl: str('WECHAT_PAY_REFUND_NOTIFY_URL'),
      platformCertPath: str('WECHAT_PAY_PLATFORM_CERT_PATH'),
    },

    ai: {
      defaultProvider: (str('AI_DEFAULT_PROVIDER', 'deepseek') as AppConfig['ai']['defaultProvider']) ?? 'deepseek',
      maxRetries: num('AI_MAX_RETRIES', 2),
      timeoutMs: num('AI_TIMEOUT_MS', 60_000),
      streamFirstTokenTimeoutMs: num('AI_STREAM_FIRST_TOKEN_TIMEOUT_MS', 20_000),
      streamTotalTimeoutMs: num('AI_STREAM_TOTAL_TIMEOUT_MS', 180_000),
      dailyCostBudgetCents: num('AI_DAILY_COST_BUDGET_CENTS', 50_000),
      circuitBreakerThreshold: num('AI_CIRCUIT_BREAKER_THRESHOLD', 5),
      circuitBreakerCooldownMs: num('AI_CIRCUIT_BREAKER_COOLDOWN_MS', 60_000),
      deepseek: {
        apiKey: str('DEEPSEEK_API_KEY'),
        baseUrl: str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
        defaultModel: str('DEEPSEEK_DEFAULT_MODEL', 'deepseek-chat'),
      },
      openai: {
        enabled: bool('OPENAI_ENABLED', false),
        apiKey: str('OPENAI_API_KEY'),
        baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        defaultModel: str('OPENAI_DEFAULT_MODEL', 'gpt-4o-mini'),
      },
      qwen: {
        apiKey: str('QWEN_API_KEY'),
        baseUrl: str('QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
        defaultModel: str('QWEN_DEFAULT_MODEL', 'qwen-plus'),
      },
    },

    oss: {
      region: str('OSS_REGION', 'oss-cn-hangzhou'),
      bucket: str('OSS_BUCKET'),
      accessKeyId: str('OSS_ACCESS_KEY_ID'),
      accessKeySecret: str('OSS_ACCESS_KEY_SECRET'),
      stsRoleArn: str('OSS_STS_ROLE_ARN'),
      cdnDomain: str('OSS_CDN_DOMAIN'),
      signedUrlTtl: num('OSS_SIGNED_URL_TTL', 900),
      maxUploadBytes: num('OSS_MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    },

    throttle: {
      globalTtl: num('THROTTLE_GLOBAL_TTL', 60),
      globalLimit: num('THROTTLE_GLOBAL_LIMIT', 100),
      aiTtl: num('THROTTLE_AI_TTL', 60),
      aiLimit: num('THROTTLE_AI_LIMIT', 10),
      loginTtl: num('THROTTLE_LOGIN_TTL', 300),
      loginLimit: num('THROTTLE_LOGIN_LIMIT', 10),
    },

    features: {
      coupleMatch: bool('FEATURE_COUPLE_MATCH', true),
      payment: bool('FEATURE_PAYMENT', true),
      aiChat: bool('FEATURE_AI_CHAT', true),
    },

    quota: {
      freeAiMessages: num('QUOTA_FREE_AI_MESSAGES', 5),
      memberDailyAiMessages: num('QUOTA_MEMBER_DAILY_AI_MESSAGES', 100),
      reportFreePreviewRatio: num('REPORT_FREE_PREVIEW_RATIO', 0.2),
      reportGenerationTimeoutMs: num('REPORT_GENERATION_TIMEOUT_MS', 180_000),
      orderExpireMinutes: num('ORDER_EXPIRE_MINUTES', 30),
      accountDeletionGraceDays: num('ACCOUNT_DELETION_GRACE_DAYS', 7),
    },

    observability: {
      sentryDsn: str('SENTRY_DSN'),
      prometheusPath: str('PROMETHEUS_PATH', '/metrics'),
      alertWebhookUrl: str('ALERT_WEBHOOK_URL'),
    },
  };
};
