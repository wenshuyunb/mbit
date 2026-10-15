-- ADR-039（情感测评改为沉浸式场景题）的第二步：把**场景题**这个题型在数据层打通
--
-- ## 加这三样东西解决什么问题
--
-- 情感测评要从"陈述句 + 同意程度"改成"给你一个处境，问你会怎么做"。这类题目的
-- 计分方式与量表题**根本不同**：量表题的分值就是用户的选项值，而场景题的一个选择
-- 会同时透露依恋、冲突风格与爱的语言 —— 分值必须挂在**选项**上。
--
-- 1. `questions.audience`：场景分男 / 女 / 中性三套独立内容，抽题时按用户性别过滤。
--
--    ⚠ 只有**情感场景题**用它。MBTI、大五与近期状态自评是标准化量表，
--    男女用同一套题、共用常模才有可比性；给它们标 MALE/FEMALE 是"看起来更贴心、
--    实际毁掉效度"。因此默认值为 `ALL`，非场景题保持默认。
--
-- 2. `questions.scenario_prompt`：场景的**提问句**（"这时候你会怎么做？"）。
--    与 `content`（情境叙述）分工：合成一句前端就没法把"处境"与"提问"排版成两段，
--    沉浸感直接消失。量表题的题干本身就是陈述句，故可空。
--
-- 3. `question_options.feedback`：选中某个做法后的**即时反馈**（一句话）。
--    沉浸感主要来自"叙事 + 即时反馈"，而不是分支剧情。
--
-- 配套的 `question_options.score_map`（JSONB）**早就存在**，无需变更 —— 这一列
-- 过去只被后台写、从未被算分读到（`test.service` 组装引擎输入时硬编码 `scoreMap: null`），
-- 接通它属于代码改动，不在本迁移内。
--
-- ## 索引
--
-- 抽题语句会变成"定义 + 适用人群 + 启用"三个条件，因此补一个复合索引；
-- 没有它，每次创建会话都会在 questions 上做一次全表扫描（题库会随场景题翻三倍）。
CREATE TYPE "question_audience" AS ENUM ('ALL', 'MALE', 'FEMALE', 'NEUTRAL');

ALTER TABLE "question_options" ADD COLUMN "feedback" VARCHAR(200);

ALTER TABLE "questions" ADD COLUMN "audience" "question_audience" NOT NULL DEFAULT 'ALL',
ADD COLUMN "scenario_prompt" VARCHAR(128);

CREATE INDEX "questions_test_definition_id_audience_is_active_idx" ON "questions"("test_definition_id", "audience", "is_active");
