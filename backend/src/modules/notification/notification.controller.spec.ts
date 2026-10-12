/**
 * 通知控制器路由契约测试（契约 §3.11）
 *
 * 为什么单测路由元数据：通知域是**越权风险最高**的入口之一 —— 三个端点若被误加
 * `@Public()`，任何人都能读到"谁收到了什么消息"。同时 `POST` 若漏了
 * `@HttpCode(200)`，Nest 会返回 **201**，而契约给的是 200，
 * 客户端按 `status === 200` 判断成功时会走进异常分支。
 */

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import {
  ListNotificationsQueryDto,
  MarkNotificationsReadDto,
  SubscribeItemDto,
  SubscribeNotificationsDto,
} from './dto/notification.dto';
import { NotificationController } from './notification.controller';
import type { NotificationService } from './notification.service';

/** 读取方法上的路径元数据 */
const pathOf = (method: keyof NotificationController): unknown =>
  Reflect.getMetadata(PATH_METADATA, NotificationController.prototype[method]);

/** 读取方法上的 HTTP 方法元数据 */
const httpMethodOf = (method: keyof NotificationController): unknown =>
  Reflect.getMetadata(METHOD_METADATA, NotificationController.prototype[method]);

/** 校验一个普通对象是否为合法 DTO，返回错误字段名列表 */
const invalidFieldsOf = async (cls: new () => object, payload: Record<string, unknown>): Promise<string[]> => {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property).sort();
};

const METHODS = ['listNotifications', 'markRead', 'subscribe'] as const;

describe('NotificationController 路由契约（API_DESIGN §3.11）', () => {
  it('控制器基础路径为 notifications', () => {
    expect(Reflect.getMetadata(PATH_METADATA, NotificationController)).toBe('notifications');
  });

  it('列表：GET /notifications', () => {
    expect(pathOf('listNotifications')).toBe('/');
    expect(httpMethodOf('listNotifications')).toBe(RequestMethod.GET);
  });

  it('标记已读：POST /notifications/read', () => {
    expect(pathOf('markRead')).toBe('read');
    expect(httpMethodOf('markRead')).toBe(RequestMethod.POST);
  });

  it('订阅授权：POST /notifications/subscribe', () => {
    expect(pathOf('subscribe')).toBe('subscribe');
    expect(httpMethodOf('subscribe')).toBe(RequestMethod.POST);
  });

  it('【关键】两个 POST 都显式声明 200（Nest 默认是 201）', () => {
    // `@HttpCode` 写入的是 HTTP_CODE_METADATA
    const httpCodeOf = (method: keyof NotificationController): unknown =>
      Reflect.getMetadata('__httpCode__', NotificationController.prototype[method]);

    expect(httpCodeOf('markRead')).toBe(200);
    expect(httpCodeOf('subscribe')).toBe(200);
  });

  it('【关键】全部端点必须鉴权（不得标记 @Public）', () => {
    for (const method of METHODS) {
      // undefined 表示未标记 @Public → 全局 JwtAuthGuard 默认拒绝匿名访问
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, NotificationController.prototype[method])).toBeUndefined();
    }
    // 控制器类本身也不得被标记，否则整个通知域敞开
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, NotificationController)).toBeUndefined();
  });

  it('【关键】每个端点都显式限流（契约 §3.11 逐接口限流表）', () => {
    const expected: Record<(typeof METHODS)[number], number> = {
      listNotifications: 120,
      markRead: 60,
      subscribe: 60,
    };

    for (const method of METHODS) {
      // 唯一限流器名为 `global`（见 ThrottlerModule.forRootAsync）
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}global`, NotificationController.prototype[method])).toBe(
        expected[method],
      );
    }
  });
});

// ============================================================================
// DTO 校验
// ============================================================================

describe('通知 DTO 校验（契约 §3.11）', () => {
  it('列表：合法查询参数全部放行', async () => {
    await expect(
      invalidFieldsOf(ListNotificationsQueryDto, {
        page: 1,
        pageSize: 20,
        status: 'UNREAD',
        type: 'REPORT_READY,MEMBERSHIP',
        sortBy: 'createdAt',
        order: 'desc',
      }),
    ).resolves.toEqual([]);
  });

  it('列表：非法枚举与越界分页被拒绝', async () => {
    expect(await invalidFieldsOf(ListNotificationsQueryDto, { status: 'UNREADISH' })).toEqual(['status']);
    expect(await invalidFieldsOf(ListNotificationsQueryDto, { type: 'NOT_A_TYPE' })).toEqual(['type']);
    expect(await invalidFieldsOf(ListNotificationsQueryDto, { sortBy: 'updatedAt' })).toEqual(['sortBy']);
    expect(await invalidFieldsOf(ListNotificationsQueryDto, { pageSize: 101 })).toEqual(['pageSize']);
    expect(await invalidFieldsOf(ListNotificationsQueryDto, { page: 0 })).toEqual(['page']);
  });

  it('标记已读：数组长度与 UUID 形态受约束', async () => {
    await expect(
      invalidFieldsOf(MarkNotificationsReadDto, {
        notificationIds: ['0195f3a2-c1a8-7e20-9f35-5c6d7e8f9a0b'],
        all: false,
      }),
    ).resolves.toEqual([]);

    expect(await invalidFieldsOf(MarkNotificationsReadDto, { notificationIds: ['not-a-uuid'] })).toEqual([
      'notificationIds',
    ]);
    expect(await invalidFieldsOf(MarkNotificationsReadDto, { notificationIds: [] })).toEqual(['notificationIds']);
    // 超过 100 条
    expect(
      await invalidFieldsOf(MarkNotificationsReadDto, {
        notificationIds: Array.from(
          { length: 101 },
          (_unused, index) => `0195f3a2-c1a8-7e20-9f35-5c6d7e8f9a${String(index).padStart(2, '0')}`,
        ),
      }),
    ).toEqual(['notificationIds']);
  });

  it('标记已读：允许只传 all 或只传 type', async () => {
    await expect(invalidFieldsOf(MarkNotificationsReadDto, { all: true })).resolves.toEqual([]);
    await expect(invalidFieldsOf(MarkNotificationsReadDto, { all: true, type: 'REPORT_READY' })).resolves.toEqual([]);
  });

  it('订阅：嵌套对象校验生效（scene / result / templateId 长度）', async () => {
    await expect(
      invalidFieldsOf(SubscribeNotificationsDto, {
        subscriptions: [{ templateId: 'TMPL_REPORT_READY_9a3f2c', scene: 'REPORT_READY', result: 'ACCEPT' }],
        clientRequestId: 'sub_req_a71f3c9e2b04',
      }),
    ).resolves.toEqual([]);

    expect(
      await invalidFieldsOf(SubscribeNotificationsDto, {
        subscriptions: [{ templateId: 'SHORT', scene: 'REPORT_READY', result: 'ACCEPT' }],
      }),
    ).toEqual(['subscriptions']);
    expect(
      await invalidFieldsOf(SubscribeNotificationsDto, {
        subscriptions: [{ templateId: 'TMPL_REPORT_READY', scene: 'REPORT_READY', result: 'MAYBE' }],
      }),
    ).toEqual(['subscriptions']);
    expect(
      await invalidFieldsOf(SubscribeNotificationsDto, {
        subscriptions: [{ templateId: 'TMPL_REPORT_READY', scene: 'NOT_A_SCENE', result: 'ACCEPT' }],
      }),
    ).toEqual(['subscriptions']);
  });

  it('订阅：空数组与超过 10 条被拒绝', async () => {
    expect(await invalidFieldsOf(SubscribeNotificationsDto, { subscriptions: [] })).toEqual(['subscriptions']);

    const item = { templateId: 'TMPL_REPORT_READY', scene: 'REPORT_READY', result: 'ACCEPT' };
    expect(
      await invalidFieldsOf(SubscribeNotificationsDto, { subscriptions: Array.from({ length: 11 }, () => item) }),
    ).toEqual(['subscriptions']);
  });

  it('订阅项本身：合法值放行，未知字段被 forbidNonWhitelisted 拦下', async () => {
    await expect(
      invalidFieldsOf(SubscribeItemDto, {
        templateId: 'TMPL_REPORT_READY',
        scene: 'REPORT_READY',
        result: 'ACCEPT',
      }),
    ).resolves.toEqual([]);

    expect(
      await invalidFieldsOf(SubscribeItemDto, {
        templateId: 'TMPL_REPORT_READY',
        scene: 'REPORT_READY',
        result: 'ACCEPT',
        extra: 'nope',
      }),
    ).toEqual(['extra']);
  });
});

// ============================================================================
// 控制器 → 服务 传参
// ============================================================================

describe('NotificationController 传参', () => {
  const build = (): { controller: NotificationController; service: Record<string, jest.Mock> } => {
    const service = {
      listNotifications: jest.fn().mockResolvedValue({}),
      markRead: jest.fn().mockResolvedValue({}),
      recordSubscriptions: jest.fn().mockResolvedValue({}),
    };

    return { controller: new NotificationController(service as unknown as NotificationService), service };
  };

  it('列表把 userId 与全部查询参数透传（缺省值由 Service 兜底，不在这里补）', async () => {
    const { controller, service } = build();

    await controller.listNotifications('u-1', { page: 1 });

    expect(service.listNotifications).toHaveBeenCalledWith({ userId: 'u-1', page: 1 });
  });

  it('标记已读把整个 DTO 交给 Service（互斥校验在 Service 里做）', async () => {
    const { controller, service } = build();

    await controller.markRead('u-1', { all: true });

    expect(service.markRead).toHaveBeenCalledWith('u-1', { all: true });
  });

  it('订阅透传 userId 与 DTO', async () => {
    const { controller, service } = build();
    const dto = {
      subscriptions: [{ templateId: 'TMPL_REPORT_READY', scene: 'REPORT_READY' as const, result: 'ACCEPT' as const }],
    };

    await controller.subscribe('u-1', dto);

    expect(service.recordSubscriptions).toHaveBeenCalledWith('u-1', dto);
  });
});
