/**
 * 报告控制器路由契约测试
 *
 * 为什么单测路由元数据：报告详情是**付费内容的下发点**。
 * 服务层的裁剪逻辑测得再全，若某天有人在控制器上误加 `@Public()`，
 * 或把 `:reportId` 写成别的段名，上述测试全绿而线上已经敞开。
 */

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { ReportController } from './report.controller';

const pathOf = (method: keyof ReportController): unknown =>
  Reflect.getMetadata(PATH_METADATA, ReportController.prototype[method]);

const httpMethodOf = (method: keyof ReportController): unknown =>
  Reflect.getMetadata(METHOD_METADATA, ReportController.prototype[method]);

const isPublicOf = (method: keyof ReportController): unknown =>
  Reflect.getMetadata(IS_PUBLIC_KEY, ReportController.prototype[method]);

describe('ReportController 路由契约（API_DESIGN §3.5）', () => {
  it('控制器基础路径为 reports', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReportController)).toBe('reports');
  });

  it('创建报告：POST /reports', () => {
    expect(pathOf('createReport')).toBe('/');
    expect(httpMethodOf('createReport')).toBe(RequestMethod.POST);
  });

  it('报告列表：GET /reports', () => {
    // 路径为空串（`@Get()`），与 `@Get(':reportId')` 是两个不同的路由段数，
    // 不会互相吃掉；`/reports` 只有一段，匹配不到 `:reportId`
    expect(pathOf('listReports')).toBe('/');
    expect(httpMethodOf('listReports')).toBe(RequestMethod.GET);
  });

  it('报告详情：GET /reports/:reportId', () => {
    expect(pathOf('getReport')).toBe(':reportId');
    expect(httpMethodOf('getReport')).toBe(RequestMethod.GET);
  });

  it('进度轮询：GET /reports/:reportId/progress', () => {
    expect(pathOf('getProgress')).toBe(':reportId/progress');
    expect(httpMethodOf('getProgress')).toBe(RequestMethod.GET);
  });

  it('【关键】全部路由都必须鉴权（报告含付费内容，绝不可匿名访问）', () => {
    for (const method of ['createReport', 'listReports', 'getReport', 'getProgress'] as const) {
      expect(isPublicOf(method)).toBeUndefined();
    }
  });

  it('【关键】控制器整体也不得被标记 @Public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ReportController)).toBeUndefined();
  });

  it('【关键】进度路由必须注册在详情路由之后（否则 `progress` 会被当作 reportId 吃掉）', () => {
    // 框架按声明顺序匹配，`/reports/progress` 这类请求若先命中 `:reportId`
    // 会拿 "progress" 去查报告 —— 表现为「报告不存在」而非路由错误，极难排查
    const prototype = ReportController.prototype;
    const handlerNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && typeof prototype[name as keyof ReportController] === 'function',
    );

    expect(handlerNames.indexOf('getReport')).toBeLessThan(handlerNames.indexOf('getProgress'));
  });

  it('已实现的路由恰好四个（新增路由必须同步更新本测试与文档）', () => {
    const prototype = ReportController.prototype;
    const handlerNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && typeof prototype[name as keyof ReportController] === 'function',
    );

    expect(handlerNames.sort()).toEqual(['createReport', 'getProgress', 'getReport', 'listReports']);
  });
});
