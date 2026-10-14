-- ============================================================================
-- 心理健康模块落地（ADR-038 阶段 4）
-- ============================================================================
--
-- ## 这个模块的产品形态（用户拍板，逐字照做）
--
--   「多维度得分 + 文字结论，但是要写好提示，本结果仅供参考的字样，
--     不涉及专业建议以及心理干预，只做结论」
--
-- 因此本迁移里有两列是**合规要求**，不是可选字段：
--   · `conclusion`  —— 由**确定性规则**生成的结论文本（不是 AI 写的：
--     交给模型必然滑向"你可以试试……"这类建议，正是用户明确排除的东西）；
--   · `disclaimer`  —— 服务端下发的免责声明，**必须**含「本结果仅供参考」，
--     前端不得硬编码（合规文案要能独立迭代而不发版）。
--
-- ## ⚠ 六个维度的方向必须一致：分数越高 = 越值得留意
--
-- 这一条是**正确性**要求，不是措辞偏好。`overall_level` 与 `overall_score`
-- 由六维聚合得出，只要混进一个"越高越好"的维度（例如直觉上更顺口的「社会支持」），
-- 聚合就会**静默反向**：支持越多、状态越好的人反而被判成越值得留意，
-- 而报告读起来完全通顺 —— 这类错误没有任何报错，只能靠约定防住。
--
-- 所以第六维用「**缺少支持**」（`MH_LONELINESS`）而不是「社会支持」。
--
-- ## 维度命名一律用体验/状态词，不用临床构念
--
-- `MH_STRESS` 压力感受 / `MH_MOOD` 情绪低落 / `MH_ANXIETY` 紧张不安 /
-- `MH_SLEEP` 睡眠困扰 / `MH_ENERGY` 精力不足 / `MH_LONELINESS` 缺少支持。
--
-- 不用「抑郁」「焦虑障碍」「症状」这类词：微信审核对诊断类表述敏感，
-- 而本模块的产品定位本来就只是"根据答题情况给出结论"，不做任何诊断。
-- （题库层面还有一道敏感词测试兜着，见 `prisma/seed/data/seed-data.spec.ts`。）
--
-- ## 为什么没有 AI 报告
--
-- 其它两个模块都有 `*_REPORT`。本模块**刻意不做**：一份"AI 深度解读"
-- 几乎不可能只陈述结论而不给建议，而给建议是这个模块的红线。
-- 深挖解读的需求由 AI 助手承担（阶段 5，读三模块报告后由用户主动追问），
-- 而不是被动收到一份越界的建议清单。
-- ============================================================================

-- 六个计分维度（与情感模块同样的追加方式：`ALTER TYPE ... ADD VALUE` 只能往末尾加）
ALTER TYPE "dimension" ADD VALUE 'MH_STRESS';
ALTER TYPE "dimension" ADD VALUE 'MH_MOOD';
ALTER TYPE "dimension" ADD VALUE 'MH_ANXIETY';
ALTER TYPE "dimension" ADD VALUE 'MH_SLEEP';
ALTER TYPE "dimension" ADD VALUE 'MH_ENERGY';
ALTER TYPE "dimension" ADD VALUE 'MH_LONELINESS';

CREATE TABLE "mental_health_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "test_result_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "engine_version" VARCHAR(16) NOT NULL,

    -- 六维完整分布 + 两个聚合值（聚合值冗余存放，便于排序、统计与后台筛查）
    "dimension_scores" JSONB NOT NULL,
    "overall_level" VARCHAR(16) NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,

    -- 结论文本与合规声明（**必须**由服务端下发，见文件头）
    "conclusion" TEXT NOT NULL,
    "highlighted_dimensions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disclaimer" TEXT NOT NULL,

    -- 来源测评的质量指标（与另两个模块同口径，供结论里说明"本次结果有多可信"）
    "consistency_score" DOUBLE PRECISION,
    "completion_rate" DOUBLE PRECISION,
    "avg_response_ms" INTEGER,

    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "mental_health_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mental_health_profiles_user_id_version_key" ON "mental_health_profiles"("user_id", "version");
CREATE INDEX "mental_health_profiles_user_id_is_current_idx" ON "mental_health_profiles"("user_id", "is_current");

-- 「当前画像唯一」的部分唯一索引：与另两张画像表同一谓词。
-- 谓词包含 `deleted_at IS NULL`，与读路径 `{ userId, isCurrent: true, deletedAt: null }` 逐字一致 ——
-- 索引的作用是保护那条查询的不变量，谓词不一致就保护不到。
CREATE UNIQUE INDEX "mental_health_profiles_user_id_current_key"
    ON "mental_health_profiles"("user_id")
    WHERE "is_current" = true AND "deleted_at" IS NULL;

ALTER TABLE "mental_health_profiles" ADD CONSTRAINT "mental_health_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mental_health_profiles" ADD CONSTRAINT "mental_health_profiles_test_result_id_fkey"
    FOREIGN KEY ("test_result_id") REFERENCES "test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;
