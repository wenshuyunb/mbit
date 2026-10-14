-- ============================================================================
-- 情感报告关联列（ADR-038 阶段 3 之四）
-- ============================================================================
--
-- ## 为什么需要新列而不是复用 profileId
--
-- `ai_reports.profile_id` 是**外键指向 `personality_profiles`**，情感报告没法用它：
-- 指向一份人格画像的"情感报告"在语义上是错的，而且 AI 报告列表、重新生成、
-- 分享卡都按这个列反查画像，指错表会让它们读到完全无关的数据。
--
-- 因此加一个平行列 `emotion_profile_id`。两者**互斥**：一份报告要么描述人格画像，
-- 要么描述情感画像（`RELATIONSHIP_REPORT` 两者都不挂，它挂 `relationship_id`）。
-- 不用"一个多态列 + 类型判别"的写法：那会让每个读取点都必须先看 `type`
-- 才知道该去查哪张表，漏看一处就是静默取错数据 —— 而外键是数据库层面挡住的。
--
-- ## 为什么 ON DELETE SET NULL
--
-- 与 `profile_id` 保持一致：画像被清理后报告本身要留着（用户可能已付费），
-- 只是失去溯源能力。级联删除报告会让"清理一份画像"变成"删掉用户的付费内容"。
-- ============================================================================

ALTER TABLE "ai_reports" ADD COLUMN "emotion_profile_id" UUID;

ALTER TABLE "ai_reports" ADD CONSTRAINT "ai_reports_emotion_profile_id_fkey"
    FOREIGN KEY ("emotion_profile_id") REFERENCES "emotion_profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
