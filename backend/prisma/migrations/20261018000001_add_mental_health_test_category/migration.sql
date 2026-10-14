-- ============================================================================
-- 心理健康测评的算分口径（ADR-038 阶段 4 补）
-- ============================================================================
--
-- `test_category` 枚举补一个 `MENTAL_HEALTH`。
--
-- ## 为什么要补，而不是复用 `COMPREHENSIVE`
--
-- `test_category` 回答的是「**模块内**用哪套算分逻辑」，与 `test_module`
-- 是两层概念（见 `TestModule` 枚举处的说明）：
--   · 人格模块下有 MBTI / BIG_FIVE / COMPREHENSIVE 三个 category；
--   · 情感模块复用已有的 `RELATIONSHIP_STYLE`（它衡量的确实是关系风格）；
--   · 心理健康模块的六维聚合 + 确定性结论文本是一套**全新的算分口径**，
--     塞进 `COMPREHENSIVE` 会让后台按 category 筛选时把两种完全不同的量表混在一起。
--
-- ## 顺带修一处默认值不一致
--
-- 建表迁移里 `highlighted_dimensions` 带了 `DEFAULT ARRAY[]::TEXT[]`，
-- 但设计文档里的 Prisma 声明没写 `@default([])` —— 两处不一致会让下一次
-- `migrate diff` 一直报一条"要 DROP DEFAULT"的噪音。这里按**文档**（Prisma 声明）
-- 对齐：由 Prisma 在写入时给空数组，列上不需要默认值。
-- ============================================================================

ALTER TYPE "test_category" ADD VALUE 'MENTAL_HEALTH';

ALTER TABLE "mental_health_profiles" ALTER COLUMN "highlighted_dimensions" DROP DEFAULT;
