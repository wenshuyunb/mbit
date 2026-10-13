-- 让 `prompt_type` 覆盖全部报告类型（大五特质报告 / 成长回顾报告）
--
-- 背景：`report.bigfive` 与 `report.growth` 两个模板此前**只能借 `MBTI_REPORT` 登记**，
-- 因为枚举里没有与 `AiReportType` 对应的取值。后果是后台按类型筛选 Prompt 模板时，
-- 这两个模板混在「MBTI 报告」里，运营看不出它们的真实归属。
--
-- 为什么用 `ADD VALUE` 而不是重建枚举：PostgreSQL 不支持删除/重排枚举值，
-- 重建需要新建类型 + 改列 + 迁数据，风险远大于收益。这里只追加两个取值。
--
-- 事务说明：PostgreSQL 12+ 允许在事务块中执行 `ADD VALUE`，但**新取值不能在同一
-- 事务内被使用**。本迁移只追加取值、不读写任何数据，因此可以安全地放在 Prisma
-- 的迁移事务里。`IF NOT EXISTS` 保证重复执行不报错（幂等）。

ALTER TYPE "prompt_type" ADD VALUE IF NOT EXISTS 'BIG_FIVE_REPORT';
ALTER TYPE "prompt_type" ADD VALUE IF NOT EXISTS 'GROWTH_SUMMARY';
