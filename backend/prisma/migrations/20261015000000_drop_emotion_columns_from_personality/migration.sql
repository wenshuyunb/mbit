-- ============================================================================
-- 删除「情感结论」在人格域的三处落库（ADR-038 阶段 2 之三）
-- ============================================================================
--
-- ## 为什么删
--
-- 依恋风格 / 爱的语言 / 冲突处理这三项是**情感模块**的结论，但它们此前被落库在
-- **人格模块**的三张表上（共 7 列）：
--
--   · `personality_profiles.attachment_style` / `love_languages` /
--     `conflict_style` / `relationship_style`  —— 画像的直接字段
--   · `test_results.relationship_style`        —— 算分结果快照里的同一份数据
--   · `personality_snapshots.relationship_style` —— 时间序列快照里的同一份数据
--
-- 它们是"由**人格模块**的答题数据经 `relationship_style_rules` 推导"出来的，
-- 等于用 A 模块的数据产 B 模块的结论，还把它印在 A 模块的画像上 ——
-- 正是 ADR-038 要消除的"模块互相干扰"。用户对产品的定位很明确：
-- MBTI 人格测试 / 情感测评 / 心理健康测评是**三个互不干扰**的模块。
--
-- ## 为什么删掉是安全的（不是"删功能"）
--
-- 消费者（情侣匹配、匹配报告详情、关系报告、AI 人设）**已在同一轮的代码改动中
-- 改为读取时用大五五列现算**（`deriveRelationshipStyleFromBigFive`），
-- 且已用探针逐字段验证等价：
--
--   · `.runlogs/probe-derive-parity.cjs`：库中真实画像的 `attachment_style` /
--     `love_languages` / `conflict_style` 与推导结果**逐字段相等**；
--   · 匹配分对照（库列路径 vs 推导路径）：总分与四个子项完全一致（87.4 / 86.6）。
--
-- 因此本迁移**不改变任何对外可见的数值**，只是把"存储"换成"计算"。
-- 情侣匹配（`REPORT_COMPATIBILITY_DEEP`）这个付费产品继续可用。
--
-- ## ⚠ 语义变化（必须记录，见 `docs/CONTRACT_DRIFT_AUDIT.md` §10.2）
--
-- 关系风格从「提交时冻结」变成「读取时计算」：今后修改 `relationship_style_rules`
-- 会**同时改变历史用户**的推导值。这是有意接受的 —— 规则表是产品配置而非用户数据，
-- 而"配置改了却对老用户永远不生效"才是更难解释的状态。
--
-- ## ⚠ 为什么 `test_results` / `personality_snapshots` 也必须删
--
-- 不只是清理。这两列是**同一份数据的第二、第三份副本**，而新语义下关系风格是
-- **读取时**算的 —— 留着的副本会立刻变成"陈旧的第二真相"：
-- 匹配用新规则算，而快照里躺着旧规则的结果，两者会静默分叉。
-- 而且它们是**冗余**的：大五五列（`big_five_scores` / `big_five`）都在，
-- 配合当时的规则表可以完整复算，ADR-005 的可复现性承诺不受影响。
--
-- ## 为什么不保留列而只是停止写入
--
-- 保留可空列等于留一个"随时会被人再写回去"的坑，而且读代码的人看到列名会以为
-- 数据还在。用户对本次整改的要求是"一次性改好，不要怕删功能"。
-- ============================================================================

-- 人格画像：四项情感结论字段
ALTER TABLE "personality_profiles" DROP COLUMN "attachment_style",
DROP COLUMN "conflict_style",
DROP COLUMN "love_languages",
DROP COLUMN "relationship_style";

-- 时间序列快照：冗余副本（成长曲线读的是 big_five，不读此列）
ALTER TABLE "personality_snapshots" DROP COLUMN "relationship_style";

-- 算分结果快照：冗余副本（读的是 big_five_scores）
-- ⚠ 注意：`mbti_confidence` 此前被塞在这个 Json 里一起写入
--    （`{ ...relationshipStyle, mbtiConfidence }`）。删列后重复提交路径改为读
--    `personality_profiles.mbti_confidence`，语义更正确（置信度是人格指标）
ALTER TABLE "test_results" DROP COLUMN "relationship_style";
