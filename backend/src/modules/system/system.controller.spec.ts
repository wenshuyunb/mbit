/**
 * 系统控制器路由契约测试
 *
 * 为什么单测路由元数据：这两个接口是**公开**的（`@Public()`），也就是说任何人
 * 无需登录即可访问。若某天有人在类上误加了管理端守卫、或把 `@Public()` 删掉，
 * 服务层测再多也不会发现「启动链路整个 401」或「配置对游客不可见」这类线上事故。
 */

import { RequestMethod } from '@nestjs/common';
import { HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { SystemController } from './system.controller';
import { SystemConfigService } from './system-config.service';

const pathOf = (method: keyof SystemController): unknown =>
  Reflect.getMetadata(PATH_METADATA, SystemController.prototype[method]);

const methodOf = (method: keyof SystemController): unknown =>
  Reflect.getMetadata(METHOD_METADATA, SystemController.prototype[method]);

const headersOf = (method: keyof SystemController): Array<{ name: string; value: string }> =>
  (Reflect.getMetadata(HEADERS_METADATA, SystemController.prototype[method]) ?? []) as Array<{
    name: string;
    value: string;
  }>;

describe('SystemController 路由契约（API_DESIGN §3.12）', () => {
  it('控制器基础路径为 system', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SystemController)).toBe('system');
  });

  it('启动配置：GET /system/config', () => {
    expect(pathOf('getConfig')).toBe('config');
    expect(methodOf('getConfig')).toBe(RequestMethod.GET);
  });

  it('免责声明：GET /system/disclaimers', () => {
    expect(pathOf('getDisclaimers')).toBe('disclaimers');
    expect(methodOf('getDisclaimers')).toBe(RequestMethod.GET);
  });

  it('【关键】两个接口都必须对整个控制器标记 @Public（游客要能启动）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, SystemController)).toBe(true);
  });

  it('响应头带 Cache-Control: private, max-age=300（契约 §3.12.1 规则 2）', () => {
    for (const method of ['getConfig', 'getDisclaimers'] as const) {
      const headers = headersOf(method);
      expect(headers).toContainEqual({ name: 'Cache-Control', value: 'private, max-age=300' });
    }
  });

  it('只暴露两个接口（新增接口必须同步更新本测试与文档）', () => {
    const names = Object.getOwnPropertyNames(SystemController.prototype).filter(
      (name) =>
        name !== 'constructor' && typeof SystemController.prototype[name as keyof SystemController] === 'function',
    );

    expect(names.sort()).toEqual(['getConfig', 'getDisclaimers']);
  });

  it('服务由构造函数注入（避免有人改成 new 出来导致缓存实例不共享）', () => {
    // 参数类型元数据来自 emitDecoratorMetadata：DI 失效会让「写配置后前台读不到新值」
    const paramTypes = Reflect.getMetadata('design:paramtypes', SystemController) as unknown[];
    expect(paramTypes).toContain(SystemConfigService);
  });
});
