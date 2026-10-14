-- 引入「测评模块」这一层（ADR-038：三个模块互不干扰）
--
-- ## 背景
--
-- 此前没有「模块」概念，`TestCategory` 既当"大类"又暗含"结果写进哪份画像"，
-- 于是出现了自相矛盾的现状：情感结论（依恋 / 爱的语言 / 冲突处理风格）被写进
-- **人格画像**，并从 `report.mbti` / `report.bigfive` 的提示词里被解读出去 ——
-- 也就是"用人格模块的答题数据产情感模块的结论"。
--
-- ADR-038 确立三个模块（MBTI 人格 / 情感测评 / 心理健康）各自独立画像、互不干扰，
-- 本迁移引入承载它的枚举与列。
--
-- ## 与 `TestCategory` 的分工（两层概念，不要合并）
--
--   · `module`   —— 属于哪个模块：决定**结果写哪份画像、出哪种报告**；
--   · `category` —— 模块内的细分：决定**用哪套算分逻辑**。
--
-- 一个模块下可以有多个 category（人格模块含 MBTI / BIG_FIVE / COMPREHENSIVE）。
-- 不复用 `test_category` 的原因也在这里：两轴语义不同，把一个模块的取值塞进另一个维度，
-- "模块隔离"就无法被类型系统表达了。
--
-- ## 为什么能用默认值
--
-- 存量行只有 `MBTI_LITE` / `BIG_FIVE_50` / `MBTI_FULL`，**全部属人格模块** ——
-- 因此 `DEFAULT 'PERSONALITY'` 让存量数据无需回填即语义正确。
-- 保留默认值也让后台新建定义时不必强制选择，并避免 NULL 语义。
--
-- ## 事务说明
--
-- `CREATE TYPE` 与 `ALTER TABLE ... ADD COLUMN` 都是普通 DDL，可以安全地放在
-- Prisma 的迁移事务里（与 `ALTER TYPE ... ADD VALUE` 不同，后者有"新取值不能在同一
-- 事务内被使用"的限制 —— 见 `20261013000000_prompt_type_report_variants`）。

-- CreateEnum
CREATE TYPE "test_module" AS ENUM ('PERSONALITY', 'EMOTION', 'MENTAL_HEALTH');

-- AlterTable
ALTER TABLE "test_definitions" ADD COLUMN     "module" "test_module" NOT NULL DEFAULT 'PERSONALITY';

-- CreateIndex
CREATE INDEX "test_definitions_module_is_active_idx" ON "test_definitions"("module", "is_active");
