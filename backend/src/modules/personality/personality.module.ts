import { Module } from '@nestjs/common';

import { PersonalityController } from './personality.controller';
import { PersonalityService } from './personality.service';
import { PersonalityEngine } from './engine/personality-engine.service';

/**
 * 人格模块
 *
 * 包含两条明确分离的职责：
 *   · `PersonalityEngine`  —— 纯函数算分（MBTI / 大五 / 关系风格 / 质量指标），无 I/O，覆盖率 100%
 *   · `PersonalityService` —— 画像读写与查询接口（只读对外；写入仅由 test 模块在提交时调用）
 *
 * 依赖方向（架构 §6.1）：`test` → `personality`（算法）；`personality` → `infra/prisma`。
 * 两者都不反向依赖彼此的具体实现。
 */
@Module({
  controllers: [PersonalityController],
  providers: [PersonalityEngine, PersonalityService],
  exports: [PersonalityEngine, PersonalityService],
})
export class PersonalityModule {}
