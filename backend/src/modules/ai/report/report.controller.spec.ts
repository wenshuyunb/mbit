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
import type { EntitlementService } from '../../membership/entitlement.service';
import { ReportController } from './report.controller';
import type { ReportService } from './report.service';

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

/**
 * 创建报告的**参数透传**（契约 §3.5.1）
 *
 * 为什么必须单独测这一层：`relationshipId` 曾经**根本没出现在 DTO 里**，
 * 于是 Swagger 按 `@ApiProperty({ enum: REPORT_TYPES })` 宣称支持
 * `RELATIONSHIP_REPORT`，而服务层 `createRelationshipReport` 一进来就因
 * `relationshipId === undefined` 抛 `400/10001` —— 那条完整的业务路径
 * 成了**永远走不到的死代码**。
 *
 * 这类"参数在中间某一层被悄悄丢掉"的缺陷，编译器、路由元数据测试、
 * 甚至服务层自己的单测（直接传参、绕过控制器）**都发现不了**，
 * 只有断言控制器真实传给 Service 的入参才能守住。
 */
describe('ReportController.createReport 参数透传', () => {
  const RELATIONSHIP_ID = '0195f3a2-b24e-7a86-abf1-7dae4b5c6f45';

  const buildController = (): { controller: ReportController; createReport: jest.Mock } => {
    const createReport = jest.fn().mockResolvedValue({ reportId: 'report-1' });

    return {
      controller: new ReportController(
        { createReport } as unknown as ReportService,
        {} as unknown as EntitlementService,
      ),
      createReport,
    };
  };

  it('【关键】关系报告：relationshipId 必须被透传给 Service', async () => {
    const { controller, createReport } = buildController();

    await controller.createReport('user-1', {
      type: 'RELATIONSHIP_REPORT',
      relationshipId: RELATIONSHIP_ID,
    });

    expect(createReport).toHaveBeenCalledWith({
      userId: 'user-1',
      type: 'RELATIONSHIP_REPORT',
      relationshipId: RELATIONSHIP_ID,
    });
  });

  it('sessionId 与 relationshipId 可同时透传（互不覆盖）', async () => {
    const { controller, createReport } = buildController();

    await controller.createReport('user-1', {
      type: 'RELATIONSHIP_REPORT',
      sessionId: '0195f3a2-91a7-7d53-b8c9-4a7b1e2f3c12',
      relationshipId: RELATIONSHIP_ID,
    });

    expect(createReport).toHaveBeenCalledWith({
      userId: 'user-1',
      type: 'RELATIONSHIP_REPORT',
      sessionId: '0195f3a2-91a7-7d53-b8c9-4a7b1e2f3c12',
      relationshipId: RELATIONSHIP_ID,
    });
  });

  it('未传可选字段时**不产生该键**（Service 用 `=== undefined` 判断"关系报告缺关系 ID"）', async () => {
    const { controller, createReport } = buildController();

    await controller.createReport('user-1', { type: 'MBTI_REPORT' });

    const payload = createReport.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(payload).toEqual({ userId: 'user-1', type: 'MBTI_REPORT' });
    expect('relationshipId' in payload).toBe(false);
    expect('sessionId' in payload).toBe(false);
  });
});
