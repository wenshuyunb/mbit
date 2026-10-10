import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PersonalityModule } from '../personality/personality.module';
import { TestController } from './test.controller';
import { TestService } from './test.service';

/**
 * 测评模块
 *
 * 依赖方向（架构 §6.1 白名单）：`test` → `personality`（只读引擎接口）、`infra/prisma`
 * 引擎是纯函数，`test` 只调用它算分，不反向依赖任何 I/O 能力。
 *
 * 题库数据来自数据库（`test_definitions` / `questions` / `question_options`），
 * 通过 `prisma/seed` 灌入，生产环境可在后台增删改 —— 题目**不写死在代码里**。
 */
@Module({
  imports: [ConfigModule, PersonalityModule],
  controllers: [TestController],
  providers: [TestService],
  exports: [TestService],
})
export class TestModule {}
