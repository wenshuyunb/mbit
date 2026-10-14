/**
 * 心理健康模块（ADR-038 阶段 4）
 *
 * 与人格、情感两个模块**平行**、互不依赖：
 *   · `MentalHealthEngine`   —— 纯函数算分（六维得分 + 确定性文字结论），无 I/O
 *   · `MentalHealthService`  —— 心理健康画像的只读查询（写入仅由 `test` 模块在提交时调用）
 *   · `MentalHealthController` —— `GET /mental-health/me`
 *
 * ## 与前两个模块最大的不同：**没有 AI 报告**
 *
 * 人格与情感各有 `*_REPORT`（AI 逐段解读）。本模块刻意不做，理由见
 * `MentalHealthProfile` 的模型注释：一份"AI 深度解读"几乎不可能只陈述结论
 * 而不给建议，而**给建议是这个模块的红线**（用户原话：
 * 「不涉及专业建议以及心理干预，只做结论」）。
 *
 * 深挖解读的需求由 AI 助手承担（阶段 5：读三个模块的报告后由用户主动追问），
 * 而不是让用户被动收到一份越界的建议清单。
 *
 * 依赖方向：`test` → `mental-health`（算分）；`mental-health` → `infra/prisma`。
 */

import { Module } from '@nestjs/common';

import { MentalHealthController } from './mental-health.controller';
import { MentalHealthService } from './mental-health.service';
import { MentalHealthEngine } from './engine/mental-health-engine.service';

@Module({
  controllers: [MentalHealthController],
  providers: [MentalHealthEngine, MentalHealthService],
  exports: [MentalHealthEngine, MentalHealthService],
})
export class MentalHealthModule {}
