/**
 * 塔罗牌模块
 *
 * ## 依赖方向（刻意保持极窄）
 *
 * 只依赖 `SystemConfigService`（读娱乐性质声明）与全局的 `PrismaService`。
 * **不导入**任何测评 / AI / 会员模块 —— 塔罗是纯内容模块，与测评完全隔离（ADR-038）。
 *
 * 这份 import 列表就是 review 时的第一道警报：若哪天有人在这里加了
 * `PersonalityService` 或 `EmotionService`，一眼就能看见。
 *
 * ## 没有表、没有迁移、没有队列
 *
 * 今日牌由 `(用户 + 日期)` 确定性生成，随时可复算。
 */

import { Module } from '@nestjs/common';

import { SystemModule } from '../system/system.module';
import { TarotController } from './tarot.controller';
import { TarotService } from './tarot.service';

@Module({
  imports: [SystemModule],
  controllers: [TarotController],
  providers: [TarotService],
  exports: [TarotService],
})
export class TarotModule {}
