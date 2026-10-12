/**
 * SoulMap AI — HTTP 服务入口
 *
 * 启动顺序（任一环节失败即进程退出，禁止带病启动）：
 *   1. 创建 Nest 应用（ConfigModule 完成环境变量校验）
 *   2. 接入结构化日志 / 安全响应头 / CORS
 *   3. 注册全局校验管道（白名单 + 禁止未知字段 + 隐式类型转换）
 *   4. 挂载 Swagger（按开关，生产默认关闭）
 *   5. 设置全局 API 前缀（健康检查除外）
 *   6. 开启优雅关闭，随后监听端口
 */

import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger as PinoLogger, LoggerErrorInterceptor } from 'nestjs-pino';

import { AppModule } from './app.module';
import { BusinessException } from './common/errors/business.exception';
import { ErrorCode } from './common/errors/error-code';
import { flattenValidationErrors } from './common/errors/validation-details.util';
import type { AppConfig } from './config/config.type';

/** 优雅关闭超时（毫秒）：等待进行中请求结束 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // 生产环境不暴露框架内部错误细节
    abortOnError: true,
    // 保留原始请求体字节：OSS 回调验签覆盖的是**原始 body**，
    // 用 JSON.parse 后再 JSON.stringify 重放会因键序/空白差异导致验签失败
    rawBody: true,
  });

  const configService = app.get(ConfigService<AppConfig, true>);
  const logger = app.get(PinoLogger);
  app.useLogger(logger);
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  const apiPrefix = configService.get('app.apiPrefix', { infer: true });
  const port = configService.get('app.port', { infer: true });
  const isProduction = configService.get('app.isProduction', { infer: true });

  // ------------------------------------------------------------------ 安全头
  app.use(
    helmet({
      // 本服务只提供 JSON API，CSP 交由承载 SPA 的 Nginx 配置
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // 反向代理场景下正确解析客户端 IP（限流与审计依赖真实 IP）
  // Express 实例通过 HTTP 适配器获取；此处只暴露所需的最小类型，避免 any 扩散
  const expressInstance = app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void };
  expressInstance.set('trust proxy', 1);

  // --------------------------------------------------------------------- CORS
  // 小程序请求不受同源策略限制，此处主要为 Web 管理后台放行
  app.enableCors({
    origin: isProduction
      ? (process.env['ADMIN_ORIGIN'] ?? '').split(',').filter(Boolean)
      : [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    credentials: false, // 使用 Bearer Token，不依赖 Cookie
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Idempotency-Key',
      'X-Client-Version',
      'X-Platform',
      'Accept-Language',
      // 敏感操作（退款/封禁/发布 Prompt/改配置）的二次确认密码头（契约 §3.14 核心契约第 3 条）。
      // 漏在这里的表现很隐蔽：管理后台跨域调用会**在预检阶段就被浏览器拦下**，
      // 浏览器控制台只报 CORS 错误，后端日志里连请求都看不到 —— 很容易误判成后端故障。
      'X-Confirm-Password',
    ],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  });

  // --------------------------------------------------------------- 全局校验
  app.useGlobalPipes(
    new ValidationPipe({
      // 剔除 DTO 未声明的字段，防止参数污染
      whitelist: true,
      // 出现未声明字段直接报错（而非静默丢弃），便于前端尽早发现契约不一致
      forbidNonWhitelisted: true,
      // 启用隐式类型转换（query/param 字符串 → 数字等）
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // 校验失败时返回字段级明细
      validationError: { target: false, value: false },
      stopAtFirstError: false,
      exceptionFactory: (errors) =>
        BusinessException.badRequest(ErrorCode.PARAM_INVALID, '请求参数不合法', flattenValidationErrors(errors)),
    }),
  );

  // ------------------------------------------------------------------ 前缀
  // 版本号已包含在 API_PREFIX（api/v1）中，因此不再启用 URI Versioning，避免出现 /v1/api/v1 这类重复。
  app.setGlobalPrefix(apiPrefix, {
    // 健康检查路径固定，供容器/K8s 探针直接访问
    exclude: [
      { path: 'health/live', method: RequestMethod.ALL },
      { path: 'health/ready', method: RequestMethod.ALL },
      { path: 'health/version', method: RequestMethod.ALL },
    ],
  });

  // ------------------------------------------------------------------ Swagger
  if (configService.get('app.swaggerEnabled', { infer: true })) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('SoulMap AI API')
        .setDescription(
          [
            'SoulMap AI — 基于人格测试（MBTI + Big Five）与 AI 的情感成长平台接口文档。',
            '',
            '**统一响应结构**：`{ code, message, data, requestId, timestamp }`，`code = 0` 表示成功。',
            '',
            '**鉴权**：除标注为公开的接口外，均需在请求头携带 `Authorization: Bearer <accessToken>`。',
            '',
            '**幂等**：标记为需幂等的写接口必须携带 `X-Idempotency-Key`。',
          ].join('\n'),
        )
        .setVersion('1.0.0')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '用户端访问令牌' },
          'user-token',
        )
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '管理端访问令牌（realm=admin）' },
          'admin-token',
        )
        .addServer(`http://127.0.0.1:${port}`, '本地开发')
        .addTag('系统-健康检查')
        .build(),
      { operationIdFactory: (_controllerKey, methodKey) => methodKey },
    );

    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      jsonDocumentUrl: `${apiPrefix}/docs-json`,
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none', filter: true },
    });

    logger.log(`接口文档已启用: http://127.0.0.1:${port}/${apiPrefix}/docs`);
  }

  // -------------------------------------------------------------- 优雅关闭
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');

  logger.log(
    `SoulMap AI 服务已启动 → http://127.0.0.1:${port}/${apiPrefix} | env=${configService.get('app.env', {
      infer: true,
    })} | pid=${process.pid}`,
  );

  // 兜底：容器编排发来的终止信号若未被 Nest 捕获，这里保证进程退出
  const shutdown = async (signal: string): Promise<void> => {
    logger.warn(`收到 ${signal}，开始优雅关闭（最长 ${SHUTDOWN_TIMEOUT_MS}ms）`);
    const timer = setTimeout(() => {
      logger.error('优雅关闭超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      await app.close();
      logger.log('服务已安全关闭');
      process.exit(0);
    } catch (error) {
      logger.error(`关闭过程出错: ${(error as Error).message}`);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '未处理的 Promise 拒绝');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, '未捕获异常，进程即将退出');
    process.exit(1);
  });
}

void bootstrap();
