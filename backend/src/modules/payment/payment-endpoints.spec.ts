/**
 * 订单 / 退款路由契约测试（API_DESIGN §3.9.3 ~ §3.9.10、§3.14.6.3）
 *
 * ## 为什么单测路由元数据
 *
 * 这些接口里有两类**服务层测不到**的缺陷，且都会直接导致线上事故：
 *
 * 1. **`@Post` 的默认状态码是 201**。契约要求 `query` / `cancel` / `close` 返回 200，
 *    漏写 `@HttpCode(HttpStatus.OK)` 会让前端把成功响应当成"创建了资源"，
 *    而这类错误在联调时很容易被当成"前端解析问题"。
 * 2. **管理端守卫组合**。漏掉 `@SensitiveOperation()` 就免掉了二次确认密码，
 *    漏掉 `@RequirePermission` 就扩大了退款权限 —— 两者都不会让单测失败，
 *    但线上已经是敞开的。误用 `@AdminPublic()` 更会让接口**完全公开**。
 *
 * 同时，本文件 import 了全部控制器与模块文件，使其进入 TypeScript 的检查范围
 * （纯逻辑 spec 不会 import 控制器，那会让控制器完全逃过类型检查）。
 */

import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { IDEMPOTENCY_KEY_HEADER } from '../../common/decorators/idempotency-key.decorator';
import { AdminAuthGuard } from '../admin/auth/admin-auth.guard';
import { ADMIN_PUBLIC_KEY } from '../admin/decorators/admin-public.decorator';
import { SENSITIVE_OPERATION_KEY, CONFIRM_PASSWORD_HEADER } from '../admin/decorators/sensitive-operation.decorator';
import { PERMISSIONS_KEY } from '../admin/rbac/decorators/require-permission.decorator';
import { ConfirmPasswordGuard } from '../admin/rbac/guards/confirm-password.guard';
import { RolesGuard } from '../admin/rbac/guards/roles.guard';
import { AdminOrderRefundController } from './admin-order-refund.controller';
import { OrdersController } from './orders.controller';
import { PaymentController } from './payment.controller';
import { RefundsController } from './refunds.controller';

/** 控制器类（只取 `prototype`，避免把类本身当成元数据目标而读到 undefined） */
type ControllerClass = { prototype: object };

/** 取原型上的方法描述符目标 */
const handlerOf = (controller: ControllerClass, method: string): object =>
  (controller.prototype as unknown as Record<string, object>)[method];

const pathOf = (controller: ControllerClass, method: string): unknown =>
  Reflect.getMetadata(PATH_METADATA, handlerOf(controller, method));

const methodOf = (controller: ControllerClass, method: string): unknown =>
  Reflect.getMetadata(METHOD_METADATA, handlerOf(controller, method));

const httpCodeOf = (controller: ControllerClass, method: string): unknown =>
  Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(controller, method));

const permissionsOf = (controller: ControllerClass, method: string): unknown =>
  Reflect.getMetadata(PERMISSIONS_KEY, handlerOf(controller, method));

const sensitiveOf = (controller: ControllerClass, method: string): unknown =>
  Reflect.getMetadata(SENSITIVE_OPERATION_KEY, handlerOf(controller, method));

describe('OrdersController 路由契约（§3.9.3 ~ §3.9.7、§3.9.10 用户侧）', () => {
  it('控制器基础路径为 orders（其余接口由他人负责，本文件不涉及）', () => {
    expect(Reflect.getMetadata(PATH_METADATA, OrdersController)).toBe('orders');
  });

  it('【关键】类上**不得**标 @Public()（这 6 个接口在契约里都是 🔑）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, OrdersController)).toBeUndefined();
  });

  it('GET /orders — 订单列表', () => {
    expect(pathOf(OrdersController, 'listOrders')).toBe('/');
    expect(methodOf(OrdersController, 'listOrders')).toBe(RequestMethod.GET);
  });

  it('GET /orders/:id — 订单详情', () => {
    expect(pathOf(OrdersController, 'getOrderDetail')).toBe(':id');
    expect(methodOf(OrdersController, 'getOrderDetail')).toBe(RequestMethod.GET);
  });

  it('POST /orders/:id/query — 主动查单', () => {
    expect(pathOf(OrdersController, 'queryOrder')).toBe(':id/query');
    expect(methodOf(OrdersController, 'queryOrder')).toBe(RequestMethod.POST);
  });

  it('POST /orders/:id/cancel — 用户取消', () => {
    expect(pathOf(OrdersController, 'cancelOrder')).toBe(':id/cancel');
    expect(methodOf(OrdersController, 'cancelOrder')).toBe(RequestMethod.POST);
  });

  it('POST /orders/:id/close — 关单', () => {
    expect(pathOf(OrdersController, 'closeOrder')).toBe(':id/close');
    expect(methodOf(OrdersController, 'closeOrder')).toBe(RequestMethod.POST);
  });

  it('POST /orders/:id/refund — 申请退款', () => {
    expect(pathOf(OrdersController, 'applyRefund')).toBe(':id/refund');
    expect(methodOf(OrdersController, 'applyRefund')).toBe(RequestMethod.POST);
  });

  it('【契约】query / cancel / close 必须显式返回 200（@Post 默认是 201）', () => {
    expect(httpCodeOf(OrdersController, 'queryOrder')).toBe(200);
    expect(httpCodeOf(OrdersController, 'cancelOrder')).toBe(200);
    expect(httpCodeOf(OrdersController, 'closeOrder')).toBe(200);
  });

  it('【契约】退款申请**不**固定状态码（201 审核 / 200 自动退款由运行时决定）', () => {
    // 用 @Res({ passthrough: true }) 动态设置；若有人"顺手"加上 @HttpCode，
    // 规则内自动退款就会以 201 返回，与契约的两个成功码都不符
    expect(httpCodeOf(OrdersController, 'applyRefund')).toBeUndefined();
  });

  it('订单列表与详情不覆盖状态码（保持 GET 默认 200）', () => {
    expect(httpCodeOf(OrdersController, 'listOrders')).toBeUndefined();
    expect(httpCodeOf(OrdersController, 'getOrderDetail')).toBeUndefined();
  });

  it('订单控制器不引入任何守卫（依赖全局 JwtAuthGuard 默认拒绝）', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OrdersController)).toBeUndefined();
  });
});

describe('RefundsController 路由契约（§3.9.9）', () => {
  it('控制器基础路径为 refunds', () => {
    expect(Reflect.getMetadata(PATH_METADATA, RefundsController)).toBe('refunds');
  });

  it('GET /refunds — 退款记录列表', () => {
    expect(pathOf(RefundsController, 'listRefunds')).toBe('/');
    expect(methodOf(RefundsController, 'listRefunds')).toBe(RequestMethod.GET);
  });

  it('【关键】类上不得标 @Public()（契约要求登录）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, RefundsController)).toBeUndefined();
  });
});

describe('AdminOrderRefundController 路由契约（§3.14.6.3）', () => {
  it('控制器基础路径为 admin/orders', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminOrderRefundController)).toBe('admin/orders');
  });

  it('POST /admin/orders/:id/refund', () => {
    expect(pathOf(AdminOrderRefundController, 'refundOrder')).toBe(':id/refund');
    expect(methodOf(AdminOrderRefundController, 'refundOrder')).toBe(RequestMethod.POST);
  });

  it('【契约】成功码显式覆盖为 200', () => {
    expect(httpCodeOf(AdminOrderRefundController, 'refundOrder')).toBe(200);
  });

  it('【关键】类上必须标 @Public()（用于跳过**用户端**全局守卫）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AdminOrderRefundController)).toBe(true);
  });

  it('【关键】绝不能标 @AdminPublic()（那会让接口完全公开、任意人可退款）', () => {
    expect(Reflect.getMetadata(ADMIN_PUBLIC_KEY, AdminOrderRefundController)).toBeUndefined();
  });

  it('【关键】守卫链必须是 AdminAuthGuard + RolesGuard + ConfirmPasswordGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminOrderRefundController)).toEqual([
      AdminAuthGuard,
      RolesGuard,
      ConfirmPasswordGuard,
    ]);
  });

  it('【关键】权限点必须是 payment:order:refund', () => {
    expect(permissionsOf(AdminOrderRefundController, 'refundOrder')).toEqual(['payment:order:refund']);
  });

  it('【关键】必须标 @SensitiveOperation()（要求 X-Confirm-Password 二次确认）', () => {
    expect(sensitiveOf(AdminOrderRefundController, 'refundOrder')).toBe(true);
  });

  it('幂等键与二次确认密码的请求头常量与契约一致', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('x-idempotency-key');
    expect(CONFIRM_PASSWORD_HEADER).toBe('x-confirm-password');
  });
});

/** Nest 存在 `ROUTE_ARGS_METADATA` 里的一条参数记录（键是装饰器生成的随机 id） */
interface RouteArgEntry {
  readonly index: number;
  readonly factory: (data: unknown, context: unknown) => unknown;
}

/**
 * 取控制器某个方法的参数元数据
 *
 * ⚠ 必须用**控制器类本身**作元数据目标，而不是原型方法：
 * `createParamDecorator` 内部写的是 `Reflect.defineMetadata(META, ..., target.constructor, key)`
 * （见 `@nestjs/common/decorators/http/create-route-param-metadata.decorator.js`）——
 * 用 `handlerOf()` 取到的方法函数去读会永远拿到空对象，测试会静默变成"什么都没校验"。
 */
const routeArgsOf = (controller: ControllerClass, method: string): Record<string, RouteArgEntry> =>
  (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as Record<string, RouteArgEntry> | undefined) ?? {};

/**
 * 下单接口的幂等键（契约 §2.9.2）
 *
 * ## 为什么必须在这里测
 *
 * 契约把 `POST /payment/orders` 列为"必须携带 `X-Idempotency-Key`"的接口，
 * 缺失应返回 `10009`；而**服务层完全测不到这件事** —— 服务只知道"有个字符串
 * 传进来了"。装饰器一旦被删掉，所有单测照旧全绿，线上却退化成
 * 「客户端以为服务端会拦重复下单，实际每次都新建订单」。
 *
 * 因此这里不只断言"存在某个参数"，而是**真的把参数装饰器的工厂函数调起来**：
 * 请求头为空时必须抛出 `10009`。断言的是行为，不是元数据的形状。
 */
describe('PaymentController 下单幂等（§2.9.2）', () => {
  it('【关键】POST /payment/orders 的幂等键参数必填：缺头即 10009，而不是被静默忽略', () => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, user: { userId: 'user-1' } }) }),
    };

    const thrownCodes = Object.values(routeArgsOf(PaymentController, 'createOrder'))
      .map((entry) => {
        try {
          entry.factory(undefined, context);

          return null;
        } catch (error) {
          // 非业务异常单独标记，避免把"工厂本身炸了"误当成"幂等校验生效"
          return error instanceof BusinessException ? error.code : -1;
        }
      })
      .filter((code): code is number => code !== null);

    expect(thrownCodes).toContain(ErrorCode.IDEMPOTENCY_KEY_MISSING);
  });
});
