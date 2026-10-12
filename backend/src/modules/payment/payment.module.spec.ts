/**
 * 支付模块装配测试
 *
 * ## 为什么需要"能启动"这一条断言
 *
 * 本模块新增了 4 个控制器，其中管理端退款接口用了
 * `@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)`。**守卫类必须在
 * 模块上下文里可解析** —— 否则 Nest 在**启动时**就报
 * "Nest can't resolve dependencies of the AdminOrderRefundController (?)"，
 * 而这类错误：
 *   · 单元测试（手写 `new`）完全测不到；
 *   · `tsc` 也测不到（类型正确但 DI 图缺 provider）；
 *   · 表现是**整个进程起不来**，不是某个接口 401。
 *
 * 因此这里真的编译一次依赖图，并断言 4 个控制器都能从容器里取出来。
 * 基础设施（Prisma / Redis / OSS）用 `useMocker` 顶掉：它们会真连外部服务，
 * 而本测试要验证的是**装配关系**，不是连接。
 */

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';

import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { WechatPayService } from '../../infra/wechat/wechat-pay.service';
import { AdminOrderRefundController } from './admin-order-refund.controller';
import { OrderLifecycleProcessor } from './order-lifecycle.processor';
import { OrderQueryService } from './order-query.service';
import { OrdersController } from './orders.controller';
import {
  LIFECYCLE_INTERVAL_MS,
  ORDER_TIMEOUT_CLOSE_JOB,
  QUEUE_ORDER_LIFECYCLE,
  REFUND_RECONCILE_JOB,
} from './payment-jobs.constants';
import { OrderLifecycleScheduler, PaymentJobsModule } from './payment-jobs.module';
import { PaymentController } from './payment.controller';
import { PaymentModule } from './payment.module';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { RefundsController } from './refunds.controller';

/**
 * 需要顶掉的依赖
 *
 * `PrismaService` / `RedisService` / `CryptoService` 由 `@Global()` 的
 * 基础设施模块提供（AppModule 里已注册），独立装配本模块时不存在；
 * `WechatPayService` 会在构造时读商户配置，同属外部依赖。
 * 它们在**真实应用**里都能解析 —— 这正是本测试的边界：验证装配关系，
 * 而不是验证基础设施本身。
 *
 * `CryptoService` 的替身必须实现构造函数期就会用到的
 * `getRefreshTokenTtlSeconds`（`AdminTokenService` 在构造时调它把 `'1h'` 解析成秒数），
 * 只给 `{}` 会让整个模块在启动期抛 `not a function`。
 */
const stubs = (token: unknown): object | undefined => {
  if (token === PrismaService || token === RedisService) return {};

  if (token === CryptoService) {
    return {
      getRefreshTokenTtlSeconds: (): number => 3_600,
      randomToken: (): string => 'stub-token',
      generateRefreshToken: (): string => 'stub-refresh-token',
      safeEqual: (): boolean => true,
      tryDecrypt: (): null => null,
    };
  }

  if (token === WechatPayService) return { isApiConfigured: false };

  return undefined;
};

/** 配置替身：AdminModule 的 JwtStrategy 在构造期就要求密钥存在 */
const CONFIG_VALUES: Readonly<Record<string, unknown>> = {
  'jwt.adminSecret': 'admin-secret-for-assembly-test-0123456789',
  'jwt.adminAccessTtl': '1h',
  'jwt.adminRefreshTtl': '7d',
  'wechatPay.env': 'sandbox',
};

const configStub = {
  get: (path: string): unknown => CONFIG_VALUES[path],
} as unknown as ConfigService<AppConfig, true>;

const compile = async (): Promise<TestingModule> =>
  Test.createTestingModule({ imports: [PaymentModule] })
    .overrideProvider(ConfigService)
    .useValue(configStub)
    .useMocker(stubs)
    .compile();

describe('PaymentModule 装配', () => {
  it('【关键】依赖图可完整解析（守卫链 / 审计 / WechatPayService 均可注入）', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(OrdersController)).toBeInstanceOf(OrdersController);
    expect(moduleRef.get(RefundsController)).toBeInstanceOf(RefundsController);
    expect(moduleRef.get(AdminOrderRefundController)).toBeInstanceOf(AdminOrderRefundController);
    expect(moduleRef.get(PaymentController)).toBeInstanceOf(PaymentController);

    await moduleRef.close();
  });

  it('订单 / 退款服务在容器内可由容器解析（HTTP 与队列共用同一份实现）', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(OrderQueryService)).toBeInstanceOf(OrderQueryService);
    expect(moduleRef.get(RefundService)).toBeInstanceOf(RefundService);
    expect(moduleRef.get(PaymentService)).toBeInstanceOf(PaymentService);

    await moduleRef.close();
  });
});

describe('PaymentJobsModule 装配元数据', () => {
  it('【关键】处理器与调度器都被注册（否则定时任务不会被消费）', () => {
    const providers = Reflect.getMetadata('providers', PaymentJobsModule) as unknown[];

    expect(providers).toContain(OrderLifecycleProcessor);
    expect(providers).toContain(OrderLifecycleScheduler);
  });

  it('【关键】不重复 provide 服务（避免 HTTP 与 Worker 各持一份实例）', () => {
    const providers = Reflect.getMetadata('providers', PaymentJobsModule) as unknown[];

    expect(providers).not.toContain(OrderQueryService);
    expect(providers).not.toContain(RefundService);
  });

  it('imports 含 PaymentModule（服务实例来自它的 exports）', () => {
    const imports = Reflect.getMetadata('imports', PaymentJobsModule) as unknown[];

    expect(imports).toContain(PaymentModule);
  });

  it('生命周期队列名与任务名稳定（改名会让已有调度失效）', () => {
    expect(QUEUE_ORDER_LIFECYCLE).toBe('order.lifecycle');
    expect(ORDER_TIMEOUT_CLOSE_JOB).toBe('order.timeout-close');
    expect(REFUND_RECONCILE_JOB).toBe('refund.reconcile');
    expect(LIFECYCLE_INTERVAL_MS).toBe(60_000);
  });
});
