/**
 * 星座运势模块
 *
 * ## 依赖方向（刻意保持极窄）
 *
 *   · `PrismaService` —— **全局模块**（`@Global()` in `infra/prisma/prisma.module.ts`），
 *     直接注入即可，不需要 imports；本模块只用它**读**当前用户的出生日期；
 *   · `SystemConfigService` —— 读娱乐性质声明（合规文案由服务端下发）。
 *
 * ⚠ 它**不导入**测评 / AI / 会员等任何业务模块：星座内容与三个测评模块
 * **完全隔离**（ADR-038 + 用户明确要求"完全隔离"）。这份 import 列表就是第一道警报 ——
 * 哪天有人在 `ZodiacService` 里 import 了 `PersonalityService` 或 `EmotionService`，
 * review 时一眼就能看见。
 *
 * ## 本模块没有表、没有迁移、没有队列
 *
 * 运势由 `(日期 + 星座)` 确定性生成，随时可复算；唯一被持久化的出生日期
 * 存在已有的 `users.birthday` 列上。因此新模块上线**不需要动 schema**。
 */

import { Module } from '@nestjs/common';

import { SystemModule } from '../system/system.module';
import { ZodiacController } from './zodiac.controller';
import { ZodiacService } from './zodiac.service';

@Module({
  imports: [SystemModule],
  controllers: [ZodiacController],
  providers: [ZodiacService],
  exports: [ZodiacService],
})
export class ZodiacModule {}
