/**
 * Jest 全局测试环境准备
 *
 * 目的：
 *   · 在测试进程启动前注入测试所需的最小环境变量，使配置校验可以通过
 *   · 禁止测试进程访问真实第三方服务（微信 / LLM / OSS）
 *
 * ⚠ 这里设置的是测试专用占位值，不得与生产配置混用。
 */

process.env['NODE_ENV'] = 'test';

// 配置校验要求，测试环境给固定占位值
process.env['DATABASE_URL'] ??= 'postgresql://soulmap:soulmap_dev_pwd@127.0.0.1:5432/soulmap_test?schema=public';
process.env['JWT_SECRET'] ??= 'test_only_user_access_secret_at_least_32_characters_long';
process.env['ADMIN_JWT_SECRET'] ??= 'test_only_admin_access_secret_at_least_32_characters_long';
process.env['LOG_LEVEL'] ??= 'error';

// 关闭外部依赖副作用
process.env['OPENAI_ENABLED'] ??= 'false';
process.env['WECHAT_MSG_SEC_CHECK'] ??= 'false';
process.env['SWAGGER_ENABLED'] ??= 'false';
process.env['METRICS_ENABLED'] ??= 'false';

jest.setTimeout(30_000);
