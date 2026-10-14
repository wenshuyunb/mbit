-- ============================================================================
-- 情感模块落地（ADR-038 阶段 3）
-- ============================================================================
--
-- ## 这一步在做什么
--
-- ADR-038 把项目拆成三个**互不干扰**的模块。阶段 1–2 已经把情感结论从人格域彻底清出去
-- （删了 7 列 / 3 张表，见迁移 `20261015000000_drop_emotion_columns_from_personality`），
-- 但情感模块本身**还不存在** —— 用户做不了情感测评，界面里也没有这个入口。
--
-- 本迁移补上情感模块的**数据层**，包含四件事：
--
--   ① `ai_report_type` 加 `EMOTION_REPORT`：情感报告此前在 DTO 层就会被拒
--      （`AiReportType` 里没有这个值），"只加一个模板"是无效的，必须成对做；
--   ② `dimension` 加 12 个**计分维度**：情感测评用自己的题目直接测量，
--      计分轴必须细到可解释（见下）；
--   ③ 新建 `emotion_profiles`：情感画像，与 `personality_profiles` **零外键往来**；
--   ④ 补上两张画像表缺失的**部分唯一索引** —— 这是一处真实缺陷修复（见文件末尾）。
--
-- ## 为什么情感维度是细粒度的（而不是复用那三个粗粒度值）
--
-- `ATTACHMENT` / `LOVE_LANGUAGE` / `CONFLICT_STYLE` 是模块早期的占位值：那时情感结论
-- 是"从大五分数经 `relationship_style_rules` 推导"的，**没有题目**，一个桶就够装结果。
--
-- 现在改成**直接测量**，计分维度必须是可解释的单轴：
--   · 依恋用 ECR 双轴模型（焦虑轴 / 回避轴），四种依恋类型是两轴**求交**的象限结果。
--     只留一个 `ATTACHMENT` 就无法回答"为什么是焦虑型" —— 而"专业、简单易懂"正是
--     用户对情感分析提出的要求；
--   · 爱的语言是**五项排序**，需要五项分数才能说清"第一名只比第二名高 2 分"；
--   · 冲突风格（TKI 五种）同理，主导风格只是最高分的那个。
--
-- 那三个粗粒度值**保留不动**：它们是族级分组键，后台仍按族归类题库
-- （`RELATIONSHIP_STYLE_DIMENSIONS`），删枚举值要重建类型且会波及管理端白名单，
-- 收益为零。
--
-- ## 为什么用两个枚举而不是一个"情感结果"枚举
--
-- `attachment_style`（4 值枚举）在阶段 2 已被删表，但**枚举类型本身保留**在库里 ——
-- 它正是依恋类型该用的类型（`relationship_style_rules.result_attachment` 也在用）。
-- 情感画像直接复用该枚举，不再造一个同义的。
-- ============================================================================

-- ① 情感报告类型
ALTER TYPE "ai_report_type" ADD VALUE 'EMOTION_REPORT';

-- ② 情感测评的计分维度（12 个）
--    依恋：ECR 双轴
ALTER TYPE "dimension" ADD VALUE 'ATTACH_ANXIETY';
ALTER TYPE "dimension" ADD VALUE 'ATTACH_AVOIDANCE';
--    爱的语言：五种（Gary Chapman 模型）
ALTER TYPE "dimension" ADD VALUE 'LOVE_WORDS';
ALTER TYPE "dimension" ADD VALUE 'LOVE_TIME';
ALTER TYPE "dimension" ADD VALUE 'LOVE_GIFTS';
ALTER TYPE "dimension" ADD VALUE 'LOVE_SERVICE';
ALTER TYPE "dimension" ADD VALUE 'LOVE_TOUCH';
--    冲突风格：五种（Thomas–Kilmann 模型）
ALTER TYPE "dimension" ADD VALUE 'CONFLICT_COMPETING';
ALTER TYPE "dimension" ADD VALUE 'CONFLICT_COLLABORATING';
ALTER TYPE "dimension" ADD VALUE 'CONFLICT_COMPROMISING';
ALTER TYPE "dimension" ADD VALUE 'CONFLICT_AVOIDING';
ALTER TYPE "dimension" ADD VALUE 'CONFLICT_ACCOMMODATING';

-- ③ 情感画像
--
-- 与 `personality_profiles` 结构同构（版本化 + is_current + 来源 test_result），
-- 但**没有任何外键互相引用**：两张表各自演进，读哪张由 `test_definitions.module` 决定。
-- 这正是"三个模块互不干扰"在数据层的落点 —— 不是靠约定，是靠物理隔离。
CREATE TABLE "emotion_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "test_result_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "engine_version" VARCHAR(16) NOT NULL,

    -- 依恋：类型 + 两个轴。类型是轴的**象限结果**，轴才是测量值
    "attachment_style" "attachment_style" NOT NULL,
    "attachment_anxiety" DOUBLE PRECISION NOT NULL,
    "attachment_avoidance" DOUBLE PRECISION NOT NULL,

    -- 爱的语言：完整分布 + 主导前两名（数组顺序即排名）
    "love_language_scores" JSONB NOT NULL,
    "primary_love_languages" TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- 冲突风格：完整分布 + 主导风格
    "conflict_style" VARCHAR(32) NOT NULL,
    "conflict_scores" JSONB NOT NULL,

    -- 来源测试的质量指标（与人格画像同口径，用于报告里说明"本次结果有多可信"）
    "consistency_score" DOUBLE PRECISION,
    "completion_rate" DOUBLE PRECISION,
    "avg_response_ms" INTEGER,

    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "emotion_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "emotion_profiles_user_id_version_key" ON "emotion_profiles"("user_id", "version");
CREATE INDEX "emotion_profiles_user_id_is_current_idx" ON "emotion_profiles"("user_id", "is_current");

ALTER TABLE "emotion_profiles" ADD CONSTRAINT "emotion_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "emotion_profiles" ADD CONSTRAINT "emotion_profiles_test_result_id_fkey"
    FOREIGN KEY ("test_result_id") REFERENCES "test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ④ 补上「当前画像唯一」的部分唯一索引（**修复一处文档与数据库不一致**）
--
-- `docs/DATABASE_DESIGN.md` §5.2.7 一直写着 `personality_profiles` 有
-- `UNIQUE(userId) WHERE is_current = true`，并注明"Prisma schema 无法声明，
-- 随迁移 SQL 手写"。但 `pg_indexes` 里**从来没有这条索引** —— 也就是说这句话
-- 从写下那天起就没兑现过（全库唯一的部分唯一索引是 `relationships_pair_key_live_key`）。
--
-- 后果是真实存在的：`test.service.ts` 只在事务里做
-- `updateMany(isCurrent=false)` → `create(isCurrent=true)`，而**并发提交**下
-- 两个请求可以各自读到"当前是 v1"、各插一版、各置 true ——
-- 于是同一个用户出现两条 `is_current = true`，而报告链路读的正是 `isCurrent` 那一份：
-- **同一份数据在不同请求里指向不同版本，且不报任何错**。
--
-- 因此本次给两张画像表都补上这条索引。谓词包含 `deleted_at IS NULL`，
-- 与读路径的过滤条件（`{ userId, isCurrent: true, deletedAt: null }`）**逐字一致** ——
-- 索引的作用是保护这条查询的不变量，谓词不一致就保护不到。
--
-- ⚠ 加索引前已核实现存数据无违反（探针 `.runlogs/probe-current-unique.cjs`：
--    `is_current` 重复的用户 0 个）。若在有重复的生产库上直接加，会在这里失败 ——
--    那时应先修数据（保留版本号最大的一条为 current）再重跑本迁移。
CREATE UNIQUE INDEX "personality_profiles_user_id_current_key"
    ON "personality_profiles"("user_id")
    WHERE "is_current" = true AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "emotion_profiles_user_id_current_key"
    ON "emotion_profiles"("user_id")
    WHERE "is_current" = true AND "deleted_at" IS NULL;
