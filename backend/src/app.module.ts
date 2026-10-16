/**
 * 应用根模块
 *
 * 装配顺序即启动依赖顺序：
 *   ConfigModule（环境校验，失败即启动失败）
 *     → LoggerModule（结构化日志）
 *     → ThrottlerModule（全局限流）
 *     → PrismaModule / RedisModule（基础设施，fail-fast 连接）
 *     → 业务模块（Phase 1 起逐步接入：auth / user / test / personality / ai / report / ...）
 *     → HealthModule
 *
 * 全局横切（通过 APP_* 令牌注册，保证依赖注入可用）：
 *   APP_FILTER      AllExceptionsFilter  统一错误响应与日志
 *   APP_INTERCEPTOR TransformInterceptor 统一成功响应包络
 *   APP_GUARD       ThrottlerGuard       全局限流（未来叠加 JwtAuthGuard / RolesGuard）
 */

import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { join } from 'node:path';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { configuration } from './config/configuration';
import { validationSchema } from './config/validation.schema';
import type { AppConfig } from './config/config.type';
import { CryptoModule } from './infra/crypto/crypto.module';
import { OssModule } from './infra/oss/oss.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './health/health.module';
import { AiModule } from './modules/ai/ai.module';
import { AdminModule } from './modules/admin/admin.module';
// ------------------------------------------------ 管理端业务域（§3.14）
// 这些域模块统一**注册在这里而不是 AdminModule 内**，原因有两条：
//   ① `AdminConfigModule` 等自身 `imports: [AdminModule]` 以复用守卫链，
//      若 AdminModule 反过来 import 它们会形成**模块循环依赖**；
//   ② 注册点集中在一处，读 app.module 就能看清「管理端有哪些域」。
import { AdminUserModule as AdminAccountModule } from './modules/admin/admin-user/admin-user.module';
import { AdminAiStatsModule } from './modules/admin/ai-stats/admin-ai-stats.module';
import { AdminAuditLogModule } from './modules/admin/audit-log/admin-audit-log.module';
import { AdminConfigModule } from './modules/admin/config/admin-config.module';
import { AdminDashboardModule } from './modules/admin/dashboard/admin-dashboard.module';
import { AdminOrderModule } from './modules/admin/order/admin-order.module';
import { AdminPromptModule } from './modules/admin/prompt/prompt.module';
import { AdminQuestionModule } from './modules/admin/question/admin-question.module';
import { AdminReportModule } from './modules/admin/report/admin-report.module';
import { AdminRoleModule } from './modules/admin/role/admin-role.module';
import { AdminTestDefinitionModule } from './modules/admin/test-definition/test-definition.module';
// ⚠ 命名冲突（待重构）：本模块管的是**终端用户**（`/admin/users`），
// 而 `admin/admin-user/` 管的是**管理员账号**（`/admin/admins`），两者却都叫 `AdminUserModule`。
// 这里先用别名导入把装配跑通；后续应把后者改名为 `AdminAccountModule` 并调整目录名。
import { AdminUserModule } from './modules/admin/user/admin-user.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { MembershipModule } from './modules/membership/membership.module';
// 站内通知（`GET /notifications`、`/notifications/read`、`/notifications/subscribe`）
import { NotificationModule } from './modules/notification/notification.module';
import { PaymentModule } from './modules/payment/payment.module';
import { PersonalityModule } from './modules/personality/personality.module';
import { RelationshipModule } from './modules/relationship/relationship.module';
import { StorageModule } from './modules/storage/storage.module';
// 用户端系统配置（`GET /system/config`、`/system/disclaimers`）：小程序所有页面都依赖它
import { SystemModule } from './modules/system/system.module';
import { TestModule } from './modules/test/test.module';
import { ZodiacModule } from './modules/zodiac/zodiac.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    // ---------------------------------------------------------------- 配置
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      // 优先级：backend/.env（服务专属） → 仓库根 .env（共享基础设施配置）
      envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '..', '.env')],
      validationSchema,
      validationOptions: {
        // 一次性报告全部缺失项，避免逐个试错
        abortEarly: false,
        // 允许未在 schema 中声明的变量存在（如 GIT_SHA 等由 CI 注入）
        allowUnknown: true,
        convert: true,
      },
      expandVariables: true,
    }),

    // ---------------------------------------------------------------- 日志
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => {
        const isProduction = configService.get('app.isProduction', { infer: true });
        const level = configService.get('app.logLevel', { infer: true });

        return {
          pinoHttp: {
            level,
            // 开发环境人类可读，生产环境纯 JSON（便于日志采集）
            transport: isProduction
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    colorize: true,
                    translateTime: 'SYS:yyyy-mm-dd HH:mm:ss.l',
                    ignore: 'pid,hostname,context,req,res',
                  },
                },
            // 复用 RequestIdMiddleware 生成的 requestId，保证全链路一致
            genReqId: (req: { requestId?: string; headers: Record<string, unknown> }) =>
              req.requestId ?? (req.headers['x-request-id'] as string) ?? undefined,
            customProps: () => ({ service: configService.get('app.name', { infer: true }) }),
            // 脱敏：任何情况下不得把凭证写入日志
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-idempotency-key"]',
                'res.headers["set-cookie"]',
                'req.body.password',
                'req.body.sessionKey',
                'req.body.code',
                'req.body.phone',
                'req.body.idCard',
                '*.password',
                '*.sessionKey',
                '*.apiKey',
                '*.accessKeySecret',
                '*.secret',
                '*.privateKey',
              ],
              censor: '[REDACTED]',
            },
            // 忽略健康检查与静态资源的访问日志，避免噪声淹没真实请求
            autoLogging: {
              ignore: (req: { url?: string }) =>
                typeof req.url === 'string' && (req.url.startsWith('/health') || req.url.startsWith('/metrics')),
            },
            customLogLevel: (_req: unknown, res: { statusCode?: number }, err?: Error) => {
              if (err || (res.statusCode ?? 500) >= 500) return 'error';
              if ((res.statusCode ?? 200) >= 400) return 'warn';
              return 'info';
            },
          },
        };
      },
    }),

    // ---------------------------------------------------------------- 限流
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => [
        {
          name: 'global',
          ttl: configService.get('throttle.globalTtl', { infer: true }) * 1000,
          limit: configService.get('throttle.globalLimit', { infer: true }),
        },
      ],
    }),

    // ------------------------------------------------------------ 基础设施
    CryptoModule,
    OssModule,
    PrismaModule,
    QueueModule,
    RedisModule,

    // ------------------------------------------------------------ 业务模块
    AiModule,
    AuthModule,
    UserModule,
    PersonalityModule,
    MembershipModule,
    PaymentModule,
    RelationshipModule,
    StorageModule,
    TestModule,
    /**
     * 星座运势（2026-10-16 新增）
     *
     * ⚠ 它与三个测评模块**完全隔离**：不进测评框架、不写任何画像、
     * 不影响任何测评结论（ADR-038 + 用户明确要求"完全隔离"）。
     * 它只依赖全局的 `PrismaService`（读用户的出生日期）与 `SystemModule`
     *（读娱乐性质声明），因此放在业务模块末尾，不与测评链发生任何关系。
     */
    ZodiacModule,
    // 用户端系统配置（公开接口；小程序每个页面都依赖功能开关与合规免责声明）
    SystemModule,
    // 后台管理基础层（独立 realm：AdminJwtStrategy + AdminAuthGuard + RolesGuard + 审计）
    AdminModule,
    // 后台管理业务域（契约 §3.14；共 38 个接口，覆盖用户/题库/测试定义/Prompt/
    // 订单/AI 统计/报告关系/看板/配置/审计/管理员/角色）
    AdminAccountModule,
    AdminAiStatsModule,
    AdminAuditLogModule,
    AdminConfigModule,
    AdminDashboardModule,
    AdminOrderModule,
    AdminPromptModule,
    AdminQuestionModule,
    AdminReportModule,
    AdminRoleModule,
    AdminTestDefinitionModule,
    AdminUserModule,
    // 站内通知（写入方是管理端的封禁/解封通知，此处提供读取/已读/订阅授权）
    NotificationModule,
    // Phase 5+ 待接入：订阅消息发送（wechat.service 目前无发送方法）

    // ---------------------------------------------------------------- 运维
    HealthModule,
  ],
  providers: [
    // 限流最先执行（在鉴权之前，避免被刷）
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // 安全默认：默认拒绝。仅 @Public() 标记的接口允许匿名访问（架构 §14.1）
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
