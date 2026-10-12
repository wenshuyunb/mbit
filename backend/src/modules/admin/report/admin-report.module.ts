/**
 * AdminReportModule — 管理端「关系与报告核查」域
 *
 * 契约：`docs/API_DESIGN.md` §3.14.8（2 个接口）
 *   · `GET /admin/relationships`（`relationship:relationship:read`）
 *   · `GET /admin/reports`（`report:report:read`）
 *
 * ⚠ 目录名 `report` 而模块名 `AdminReportModule`：目录同时承载「关系数据核查」与
 * 「报告数据核查」两个接口（契约把它们归在同一节 §3.14.8），因此不能只叫
 * ReportModule 而不体现关系侧；两个控制器分别挂在 `admin/relationships` 与
 * `admin/reports` 两个前缀下。
 *
 * 依赖 `AdminModule` 的原因：守卫（`AdminAuthGuard` / `RolesGuard` /
 * `ConfirmPasswordGuard`）由它导出，不 import 时 `@UseGuards(...)` 在模块上下文
 * 里解析不到守卫类，Nest 会在启动时直接报错。
 *
 * 本模块无队列处理器（两个接口均为只读聚合）。
 */

import { Module } from '@nestjs/common';

import { AdminModule } from '../admin.module';
import { AdminRelationshipController } from './admin-relationship.controller';
import { AdminRelationshipService } from './admin-relationship.service';
import { AdminReportController } from './admin-report.controller';
import { AdminReportService } from './admin-report.service';

@Module({
  imports: [AdminModule],
  controllers: [AdminRelationshipController, AdminReportController],
  providers: [AdminRelationshipService, AdminReportService],
  exports: [AdminRelationshipService, AdminReportService],
})
export class AdminReportModule {}
