import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * 数据库模块（全局）
 *
 * 标记 @Global 的取舍：PrismaService 是几乎所有模块的基础依赖，
 * 若每个模块都 import 会造成大量样板代码。全局注册后仍保持依赖方向单向
 * （common ← infra ← modules），且不会引入循环依赖。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
