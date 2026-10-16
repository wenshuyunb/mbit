/**
 * 星座运势模块
 *
 * ## 依赖方向（刻意保持极窄）
 *
 *   · `PrismaService` —— **全局模块**（`@Global()` in `infra/prisma/prisma.module.ts`），
 *     直接注入即可，不需要 imports；本模块只用它**读**当前用户的出生信息；
 *   · `SystemConfigService` —— 读娱乐性质声明（合规文案由服务端下发）；
 *   · `EntitlementService` —— 星盘的会员门槛判定（ADR-040）。
 *
 * ⚠ 它**不导入**测评 / AI 等任何业务模块：星座内容与三个测评模块**完全隔离**
 * （ADR-038 + 用户明确要求"完全隔离"）。会员模块是唯一的例外，且只被用于
 * **订阅是否有效**这一个判断 —— 它不读任何画像、不写任何数据，也不参与任何测评结论。
 * 这份 import 列表就是第一道警报：哪天有人在 `ZodiacService` 里 import 了
 * `PersonalityService` 或 `EmotionService`，review 时一眼就能看见。
 *
 * ## 本模块没有表、没有迁移、没有队列
 *
 * 运势由 `(日期 + 星座)` 确定性生成，随时可复算；星盘由 `(出生时刻 + 出生地)`
 * 实时计算，同样不落库。被持久化的只有用户资料里的出生日期/时间/城市，
 * 而它们在**用户模块**的 `users` 表上（ADR-040 加列），本模块只读不写。
 */

import { Module } from '@nestjs/common';

import { SystemModule } from '../system/system.module';
import { MembershipModule } from '../membership/membership.module';
import { ZodiacController } from './zodiac.controller';
import { ZodiacService } from './zodiac.service';

@Module({
  imports: [SystemModule, MembershipModule],
  controllers: [ZodiacController],
  providers: [ZodiacService],
  exports: [ZodiacService],
})
export class ZodiacModule {}
