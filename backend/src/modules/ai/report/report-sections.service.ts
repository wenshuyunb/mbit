/**
 * 报告分段列表服务（契约 §3.5.4）
 *
 * ## 与 `GET /reports/{id}` 的关系（契约规则 1 / ADR-004）
 *
 * 两个接口的**裁剪判定必须是同一份**，否则迟早出现"详情锁了、分段没锁"的越权读取。
 * 因此本服务：
 *   ① 不自己判断"该不该给正文"，一律走 `buildSectionViews`（与详情接口同一个函数）；
 *   ② 不自己算解锁状态，由调用方注入 `EntitlementService.resolveReportUnlock` 的结果
 *      （与详情接口同一个入口）。
 *
 * 本服务只负责取数与字段映射（映射逻辑在 `report-section.util.ts`，纯函数、已单测）。
 */

import { Injectable } from '@nestjs/common';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { computeFreePreviewRatio } from './report-list.util';
import { buildSectionsView, type ReportSectionsView } from './report-section.util';
import { buildSectionViews } from './report-visibility';

/** 分段查询入参 */
export interface GetReportSectionsInput {
  readonly userId: string;
  readonly reportId: string;
  /** 解锁状态（由 `EntitlementService` 判定后注入，本服务不查权益表） */
  readonly unlock: { allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> };
  /** 默认 `true`；`false` 时只返回目录（不含 content） */
  readonly includeContent: boolean;
  /** 只取单段（懒加载） */
  readonly sectionKey?: string;
}

@Injectable()
export class ReportSectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSections(input: GetReportSectionsInput): Promise<ReportSectionsView> {
    const report = await this.prisma.aiReport.findFirst({
      // 归属过滤与"不存在"同码：区分二者等于向攻击者确认该 reportId 存在（IDOR 防护）
      where: { id: input.reportId, userId: input.userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        contentLength: true,
        freePreviewLength: true,
      },
    });

    if (report === null) {
      throw BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
    }

    // 生成中与失败沿用详情接口的同一对错误码：前端对这两个接口的处理路径应当完全一致
    if (report.status === 'QUEUED' || report.status === 'GENERATING') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATING, '报告正在生成中，请稍候');
    }

    if (report.status !== 'SUCCEEDED') {
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATION_FAILED, '报告生成失败，请尝试重新生成');
    }

    const rows = await this.prisma.reportSection.findMany({
      where: { reportId: input.reportId },
      orderBy: { order: 'asc' },
      select: {
        id: true,
        sectionKey: true,
        title: true,
        content: true,
        order: true,
        isFreePreview: true,
      },
    });

    if (rows.length === 0) {
      // 状态已是 SUCCEEDED 却没有分段：数据异常（或生成事务中途失败）。
      // 契约 §3.5.4 的错误表把"无分段数据"归到 409 生成中，前端会继续轮询 —— 这正是期望行为，
      // 比返回一个空 items 让页面永远空白要好。
      throw new BusinessException(ErrorCode.AI_REPORT_GENERATING, '报告分段尚未就绪，请稍后重试');
    }

    // 唯一的一处可见性判定入口（与详情接口共用）
    const visibility = buildSectionViews(rows, {
      allUnlocked: input.unlock.allUnlocked,
      unlockedSectionKeys: input.unlock.unlockedSectionKeys,
    });

    return buildSectionsView({
      reportId: report.id,
      status: report.status,
      isUnlocked: input.unlock.allUnlocked,
      freePreviewRatio: computeFreePreviewRatio(report.freePreviewLength, report.contentLength),
      totalWordCount: report.contentLength,
      freePreviewWordCount: report.freePreviewLength,
      visibility,
      sectionIdByKey: new Map(rows.map((row) => [row.sectionKey, row.id])),
      includeContent: input.includeContent,
      ...(input.sectionKey !== undefined ? { sectionKey: input.sectionKey } : {}),
    });
  }
}
