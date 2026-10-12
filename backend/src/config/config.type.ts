/**
 * 配置命名空间定义 — 供 ConfigService 强类型读取
 *
 * 用法：
 *   const config = app.get(ConfigService<AppConfig, true>);
 *   config.get('database.url', { infer: true })
 */

export interface AppConfig {
  app: {
    name: string;
    env: 'development' | 'test' | 'staging' | 'production';
    port: number;
    apiPrefix: string;
    logLevel: string;
    timezone: string;
    swaggerEnabled: boolean;
    metricsEnabled: boolean;
    isProduction: boolean;
    /** 构建信息：由 CI 注入，用于确认线上实际部署的提交 */
    gitSha: string;
    buildTime: string;
    /** 协议正文基址（隐私政策/用户协议等）；未配置时相关接口的 url 字段返回 null */
    legalBaseUrl: string;
    /** 管理后台 IP 白名单（逗号分隔）；为空表示不启用该限制 */
    adminIpWhitelist: string;
  };
  database: {
    url: string;
    poolSize: number;
    poolTimeout: number;
  };
  redis: {
    host: string;
    port: number;
    password: string;
    db: number;
    keyPrefix: string;
  };
  queue: {
    prefix: string;
    concurrencyAi: number;
    concurrencyDefault: number;
  };
  jwt: {
    userSecret: string;
    userAccessTtl: string;
    userRefreshTtl: string;
    adminSecret: string;
    adminAccessTtl: string;
    adminRefreshTtl: string;
  };
  crypto: {
    key: string;
    ivSalt: string;
  };
  wechat: {
    appId: string;
    appSecret: string;
    msgSecCheck: boolean;
    templates: {
      reportReady: string;
      inviteAccepted: string;
      membershipExpiring: string;
    };
  };
  wechatPay: {
    env: 'sandbox' | 'production';
    mchId: string;
    serialNo: string;
    privateKey: string;
    privateKeyPath: string;
    apiV3Key: string;
    notifyUrl: string;
    refundNotifyUrl: string;
    platformCertPath: string;
  };
  ai: {
    defaultProvider: 'deepseek' | 'openai' | 'qwen';
    maxRetries: number;
    timeoutMs: number;
    streamFirstTokenTimeoutMs: number;
    streamTotalTimeoutMs: number;
    dailyCostBudgetCents: number;
    circuitBreakerThreshold: number;
    circuitBreakerCooldownMs: number;
    deepseek: { apiKey: string; baseUrl: string; defaultModel: string };
    openai: { enabled: boolean; apiKey: string; baseUrl: string; defaultModel: string };
    qwen: { apiKey: string; baseUrl: string; defaultModel: string };
  };
  oss: {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    stsRoleArn: string;
    cdnDomain: string;
    signedUrlTtl: number;
    maxUploadBytes: number;
  };
  throttle: {
    globalTtl: number;
    globalLimit: number;
    aiTtl: number;
    aiLimit: number;
    loginTtl: number;
    loginLimit: number;
  };
  features: {
    coupleMatch: boolean;
    payment: boolean;
    aiChat: boolean;
  };
  quota: {
    freeAiMessages: number;
    memberDailyAiMessages: number;
    reportFreePreviewRatio: number;
    reportGenerationTimeoutMs: number;
    orderExpireMinutes: number;
    accountDeletionGraceDays: number;
  };
  observability: {
    sentryDsn: string;
    prometheusPath: string;
    alertWebhookUrl: string;
  };
}
