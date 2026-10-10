/**
 * 导出 OpenAPI 文档为 openapi.json
 *
 * 用途（架构文档 §3.2 P10）：前后端契约由 OpenAPI 生成，避免手写类型漂移。
 *   backend（NestJS Swagger） → openapi.json → openapi-typescript → 前端类型
 *
 * 运行：
 *   pnpm --filter @soulmap/server openapi:export     # 输出到仓库根 openapi.json
 *
 * 实现说明：不依赖 @nestjs/swagger 的 CLI，而是以「只创建应用上下文、不监听端口」
 * 的方式启动，这样无需数据库/Redis 真实可用即可导出文档（适合 CI）。
 */

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';

async function exportOpenApi(): Promise<void> {
  // 不监听端口，避免与本地已启动的服务冲突，也避免占用 CI 端口
  const app = await NestFactory.create(AppModule, { logger: false });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('SoulMap AI API')
      .setDescription('SoulMap AI — 基于人格测试（MBTI + Big Five）与 AI 的情感成长平台接口文档。')
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'user-token')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'admin-token')
      .build(),
    { operationIdFactory: (_controllerKey, methodKey) => methodKey },
  );

  const target = join(process.cwd(), '..', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const pathCount = Object.keys(document.paths ?? {}).length;
  const schemaCount = Object.keys(document.components?.schemas ?? {}).length;

  // 这里用 console 是刻意的：本脚本是构建期 CLI 工具，不是服务运行时
  console.log(`OpenAPI 文档已导出: ${target}`);
  console.log(`  路径数: ${pathCount}`);
  console.log(`  Schema 数: ${schemaCount}`);

  await app.close();
}

void exportOpenApi().catch((error: unknown) => {
  console.error(`导出 OpenAPI 失败: ${(error as Error).message}`);
  process.exit(1);
});
