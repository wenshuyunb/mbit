/**
 * 情感模块（ADR-038 阶段 3）
 *
 * 与人格模块**平行**、互不依赖：
 *   · `EmotionEngine`   —— 纯函数算分（依恋双轴 / 爱的语言排序 / 冲突风格），无 I/O
 *   · `EmotionService`  —— 情感画像的只读查询（写入仅由 `test` 模块在提交时调用）
 *   · `EmotionController` —— `GET /emotion/me`
 *
 * 依赖方向：`test` → `emotion`（算分）、`emotion` → `infra/prisma`。
 * **`emotion` 不 import `personality`、`personality` 也不 import `emotion`** ——
 * 两者只共用 `common/engine/*` 里的通用契约与算分数学（那是"怎么把卷子算成分数"，
 * 不是"这些分数意味着什么"）。
 *
 * 需要同时用两个引擎的地方只有一处：按模块分派算分的 `test/module-scoring.service.ts`，
 * 它住在测评管道里，因此依赖方向仍然是单向的。
 */

import { Module } from '@nestjs/common';

import { EmotionController } from './emotion.controller';
import { EmotionService } from './emotion.service';
import { EmotionEngine } from './engine/emotion-engine.service';

@Module({
  controllers: [EmotionController],
  providers: [EmotionEngine, EmotionService],
  exports: [EmotionEngine, EmotionService],
})
export class EmotionModule {}
