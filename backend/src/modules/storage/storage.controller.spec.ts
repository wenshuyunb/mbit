/**
 * 存储控制器路由契约测试
 *
 * 为什么单测路由元数据而不是只测 Service：
 * 存储接口是**越权风险最高的入口**（签发出的 URL 可直读私有 Bucket 文件）。
 * Service 层测得再全，若某天有人在控制器上误加 `@Public()`，或把路径改错，
 * 上述测试全绿而线上已经敞开。本文件把「路径」与「必须鉴权」钉死为断言。
 */

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { RAW_RESPONSE_KEY } from '../../common/interceptors/transform.interceptor';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/** 读取方法上的路径元数据 */
const pathOf = (method: keyof StorageController): unknown =>
  Reflect.getMetadata(PATH_METADATA, StorageController.prototype[method]);

/** 读取方法上的 HTTP 方法元数据 */
const httpMethodOf = (method: keyof StorageController): unknown =>
  Reflect.getMetadata(METHOD_METADATA, StorageController.prototype[method]);

/** 读取方法上的公开标记 */
const isPublicOf = (method: keyof StorageController): unknown =>
  Reflect.getMetadata(IS_PUBLIC_KEY, StorageController.prototype[method]);

describe('StorageController 路由契约（API_DESIGN §3.10）', () => {
  it('控制器基础路径为 storage', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StorageController)).toBe('storage');
  });

  it('签发上传票据：POST /storage/upload-ticket', () => {
    expect(pathOf('uploadTicket')).toBe('upload-ticket');
    expect(httpMethodOf('uploadTicket')).toBe(RequestMethod.POST);
  });

  it('生成签名 URL：POST /storage/sign-url', () => {
    expect(pathOf('signUrl')).toBe('sign-url');
    expect(httpMethodOf('signUrl')).toBe(RequestMethod.POST);
  });

  it('【关键】需要登录的两个接口都必须鉴权（不得标记 @Public）', () => {
    for (const method of ['uploadTicket', 'signUrl'] as const) {
      // undefined 表示未标记 @Public → 全局 JwtAuthGuard 默认拒绝匿名访问
      expect(isPublicOf(method)).toBeUndefined();
    }
  });

  it('【关键】控制器整体也不得被标记 @Public（逐方法放行，避免整类敞开）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, StorageController)).toBeUndefined();
  });

  it('OSS 回调：POST /storage/callback，且是唯一允许匿名的路由', () => {
    expect(pathOf('ossCallback')).toBe('callback');
    expect(httpMethodOf('ossCallback')).toBe(RequestMethod.POST);
    // OSS 服务器无登录态，必须放行；其安全边界在 Service 内的验签 + 魔数校验
    expect(isPublicOf('ossCallback')).toBe(true);
  });

  it('【关键】OSS 回调跳过限流（OSS 出口 IP 集中，套用 IP 限流会误伤正常上传）', () => {
    // 键必须是 `${THROTTLER_SKIP}${throttler.name}`，而唯一的限流器名为 `global`
    // （见 ThrottlerModule.forRootAsync）。此前用无参 `@SkipThrottle()` 写入的是
    // `default` 键，guard 读 `global` → 匹配不上 → **限流实际没被跳过**；
    // 而本断言当时也写的 `default`，于是在「测一个没人读的键」，等于没测。
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}global`, StorageController.prototype.ossCallback)).toBe(true);
    // 反向断言：不得再写 default 键（它不会被任何限流器读取）
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}default`, StorageController.prototype.ossCallback)).toBeUndefined();
    // 其余接口必须保留限流
    for (const method of ['uploadTicket', 'signUrl'] as const) {
      expect(Reflect.getMetadata(`${THROTTLER_SKIP}global`, StorageController.prototype[method])).toBeUndefined();
    }
  });

  it('【关键】OSS 回调关闭统一响应包络（OSS 要求 { Status: "OK" } 结构）', () => {
    expect(Reflect.getMetadata(RAW_RESPONSE_KEY, StorageController.prototype.ossCallback)).toBe(true);
    // 其余接口必须保留包络
    for (const method of ['uploadTicket', 'signUrl'] as const) {
      expect(Reflect.getMetadata(RAW_RESPONSE_KEY, StorageController.prototype[method])).toBeUndefined();
    }
  });

  it('已实现的路由恰好只有契约中的三个（新增路由必须同步更新本测试与文档）', () => {
    const handlerNames = Object.getOwnPropertyNames(StorageController.prototype).filter(
      (name) =>
        name !== 'constructor' && typeof StorageController.prototype[name as keyof StorageController] === 'function',
    );

    expect(handlerNames.sort()).toEqual(['ossCallback', 'signUrl', 'uploadTicket']);
  });

  it('Service 被正确注入（构造参数类型是 StorageService）', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', StorageController) as unknown[] | undefined;

    expect(paramTypes?.[0]).toBe(StorageService);
  });
});
