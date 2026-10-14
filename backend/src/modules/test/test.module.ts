import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EmotionModule } from '../emotion/emotion.module';
import { MentalHealthModule } from '../mental-health/mental-health.module';
import { PersonalityModule } from '../personality/personality.module';
import { ModuleScoringService } from './module-scoring.service';
import { TestController } from './test.controller';
import { TestService } from './test.service';

/**
 * 测评模块
 *
 * 依赖方向（架构 §6.1 白名单）：`test` → `personality` / `emotion`（只读引擎接口）、
 * `infra/prisma`。引擎是纯函数，`test` 只调用它算分，不反向依赖任何 I/O 能力；
 * 两个引擎模块也**互不依赖**（ADR-038：三个模块互不干扰）。
 *
 * ⚠ `ModuleScoringService`（按模块分派算分）由**本模块**提供而不是人格模块：
 * 它要同时引用人格与情感引擎，放在任一侧都会造出跨模块依赖。
 * 放在这里，依赖方向就是 `test → personality` + `test → emotion`，两条都单向。
 *
 * 题库数据来自数据库（`test_definitions` / `questions` / `question_options`），
 * 通过 `prisma/seed` 灌入，生产环境可在后台增删改 —— 题目**不写死在代码里**。
 */
@Module({
  imports: [ConfigModule, PersonalityModule, EmotionModule, MentalHealthModule],
  controllers: [TestController],
  providers: [TestService, ModuleScoringService],
  exports: [TestService],
})
export class TestModule {}
