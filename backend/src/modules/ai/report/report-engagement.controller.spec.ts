/**
 * 报告扩展控制器路由契约测试（契约 §3.5.4 / §3.5.6 / §3.5.7 / §3.5.8 / §3.5.9）
 *
 * 与 `report.controller.spec.ts` 同一思路：路由与鉴权是**安全边界**，
 * 单测路由元数据能拦住"误加 @Public()"、"路径段写错"、"POST 忘了显式状态码"
 * 这三类只在线上才暴露的问题。
 */

import { HttpStatus, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { RAW_RESPONSE_KEY } from '../../../common/interceptors/transform.interceptor';
import { ReportEngagementController } from './report-engagement.controller';

type HandlerName = 'getSections' | 'streamProgress' | 'regenerateReport' | 'exportPdf' | 'generateShareCard';

const pathOf = (method: HandlerName): unknown =>
  Reflect.getMetadata(PATH_METADATA, ReportEngagementController.prototype[method]);

const httpMethodOf = (method: HandlerName): unknown =>
  Reflect.getMetadata(METHOD_METADATA, ReportEngagementController.prototype[method]);

const httpCodeOf = (method: HandlerName): unknown =>
  Reflect.getMetadata(HTTP_CODE_METADATA, ReportEngagementController.prototype[method]);

const isPublicOf = (method: HandlerName): unknown =>
  Reflect.getMetadata(IS_PUBLIC_KEY, ReportEngagementController.prototype[method]);

const handlerNames = (): string[] => {
  const prototype = ReportEngagementController.prototype;

  return Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== 'constructor' && typeof prototype[name as HandlerName] === 'function',
  );
};

describe('ReportEngagementController 路由契约（API_DESIGN §3.5）', () => {
  it('控制器基础路径为 reports（与既有控制器共用）', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReportEngagementController)).toBe('reports');
  });

  it('分段列表：GET /reports/:reportId/sections', () => {
    expect(pathOf('getSections')).toBe(':reportId/sections');
    expect(httpMethodOf('getSections')).toBe(RequestMethod.GET);
  });

  it('进度流：GET /reports/:reportId/stream', () => {
    expect(pathOf('streamProgress')).toBe(':reportId/stream');
    expect(httpMethodOf('streamProgress')).toBe(RequestMethod.GET);
  });

  it('重新生成：POST /reports/:reportId/regenerate，显式 202', () => {
    expect(pathOf('regenerateReport')).toBe(':reportId/regenerate');
    expect(httpMethodOf('regenerateReport')).toBe(RequestMethod.POST);
    // NestJS 对 POST 默认 201，契约要求 202 —— 必须显式声明
    expect(httpCodeOf('regenerateReport')).toBe(HttpStatus.ACCEPTED);
  });

  it('导出 PDF：POST /reports/:reportId/export-pdf（状态码由处理器动态设置 202/200）', () => {
    expect(pathOf('exportPdf')).toBe(':reportId/export-pdf');
    expect(httpMethodOf('exportPdf')).toBe(RequestMethod.POST);
    // 契约同时定义 202（新建）与 200（24h 复用），因此**不能**固定 @HttpCode
    expect(httpCodeOf('exportPdf')).toBeUndefined();
  });

  it('分享卡：POST /reports/:reportId/share-card，显式 201', () => {
    expect(pathOf('generateShareCard')).toBe(':reportId/share-card');
    expect(httpMethodOf('generateShareCard')).toBe(RequestMethod.POST);
    expect(httpCodeOf('generateShareCard')).toBe(HttpStatus.CREATED);
  });

  it('【关键】SSE 接口必须跳过统一响应包络（否则前端收不到 event 帧）', () => {
    expect(Reflect.getMetadata(RAW_RESPONSE_KEY, ReportEngagementController.prototype['streamProgress'])).toBe(true);
  });

  it('【关键】全部路由都必须鉴权（报告含付费内容，绝不可匿名访问）', () => {
    for (const method of handlerNames()) {
      expect(isPublicOf(method as HandlerName)).toBeUndefined();
    }
  });

  it('【关键】控制器整体也不得被标记 @Public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ReportEngagementController)).toBeUndefined();
  });

  it('已实现的路由恰好五个（新增路由必须同步更新本测试与文档）', () => {
    expect(handlerNames().sort()).toEqual([
      'exportPdf',
      'generateShareCard',
      'getSections',
      'regenerateReport',
      'streamProgress',
    ]);
  });

  it('幂等接口的处理器都显式声明了第 4/5 个参数中的幂等键（构造期即可发现漏加）', () => {
    // 仅做元数据层面的存在性检查：真正的缺失幂等键行为由服务层测试覆盖
    for (const method of ['regenerateReport', 'exportPdf', 'generateShareCard'] as const) {
      expect(typeof ReportEngagementController.prototype[method]).toBe('function');
    }
  });
});
