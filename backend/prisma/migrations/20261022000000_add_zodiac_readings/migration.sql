-- ============================================================================
-- 星盘解读（ADR-041）
-- ----------------------------------------------------------------------------
-- 为什么要一张表：星盘是**静态**的（出生数据不变，解读就不变），
-- 而 AI 解读每调用一次都花钱。因此解读必须落库缓存：
--   · 同一份盘（chart_hash 相同）永远复用同一份解读；
--   · 用户改了出生信息 → chart_hash 变化 → 重新生成一次。
--
-- 为什么不复用 ai_reports：那张表绑定 test_session / 报告类型，
-- 而星盘解读与三个测评模块**完全隔离**（ADR-038），混进去会污染测评口径。
--
-- 解锁方式（会员 / 单次购买 / 邀请解锁）不落在本表，而是走 entitlements：
-- 邀请解锁是"当天有效"的时间窗权益，正好用 expire_at 表达；
-- 这样"当天 24:00 失效"不需要本表再存一份过期时间。
-- ============================================================================

-- 新增权益类型：星盘解读（会员以外的单次解锁 / 邀请解锁都发这个）
ALTER TYPE "entitlement_type" ADD VALUE IF NOT EXISTS 'ZODIAC_READING';

-- 解读生成来源
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'zodiac_reading_source') THEN
    CREATE TYPE "zodiac_reading_source" AS ENUM ('TEMPLATE', 'AI');
  END IF;
END $$;

-- 解读生成状态
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'zodiac_reading_status') THEN
    CREATE TYPE "zodiac_reading_status" AS ENUM ('PENDING', 'READY', 'FAILED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "zodiac_readings" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"       UUID         NOT NULL,
  -- 星盘指纹：出生日期+时间+经纬度+时区的 FNV 哈希，用于"同一份盘复用同一份解读"
  "chart_hash"    VARCHAR(32)  NOT NULL,
  "status"        "zodiac_reading_status" NOT NULL DEFAULT 'READY',
  "source"        "zodiac_reading_source" NOT NULL DEFAULT 'TEMPLATE',
  -- 免费首段：不解锁也能看，必须存在
  "preview"       TEXT         NOT NULL,
  -- 完整章节：[{ key, title, body }]，AI 与模板共用同一结构
  "sections"      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  "model"         VARCHAR(64),
  "error"         VARCHAR(256),
  "generated_at"  TIMESTAMPTZ(3),
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "zodiac_readings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "zodiac_readings_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 一个用户同一份盘只留一份解读
CREATE UNIQUE INDEX IF NOT EXISTS "zodiac_readings_user_id_chart_hash_key"
  ON "zodiac_readings" ("user_id", "chart_hash");

-- 按用户查最近一份解读（页面只关心最新）
CREATE INDEX IF NOT EXISTS "zodiac_readings_user_id_created_at_idx"
  ON "zodiac_readings" ("user_id", "created_at" DESC);

COMMENT ON TABLE  "zodiac_readings"                IS '星盘解读缓存（同一份盘复用同一份解读，避免重复烧 AI 调用）';
COMMENT ON COLUMN "zodiac_readings"."chart_hash"   IS '出生数据指纹（日期+时间+经纬度+时区）；变化即视为新盘';
COMMENT ON COLUMN "zodiac_readings"."preview"      IS '免费首段（不需要解锁即可看）';
COMMENT ON COLUMN "zodiac_readings"."sections"     IS '完整章节 JSON：[{key,title,body}]；AI 与模板共用结构';
COMMENT ON COLUMN "zodiac_readings"."source"       IS 'TEMPLATE=确定性模板（AI 不可用时的兜底）；AI=模型生成';
